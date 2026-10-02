import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolveInside } from "../confine.ts";
import type { ToolResult, ToolSpec } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 16_000;

/** 子进程只拿这些环境变量：网关进程里的 API key、媒体签名密钥等一律不传 */
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "NODE_OPTIONS", "GOPATH", "GOROOT", "JAVA_HOME", "PYTHONPATH", "VIRTUAL_ENV", "NVM_DIR", "PNPM_HOME"];

export function shellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}

let bwrapPath: string | null | undefined;
export function findBwrap(): string | null {
  if (bwrapPath !== undefined) return bwrapPath;
  const probe = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" });
  const found = probe.status === 0 ? probe.stdout.trim() : "";
  bwrapPath = found && existsSync(found) ? found : null;
  return bwrapPath;
}

/** 沙箱里要遮住的目录：网关配置、状态目录（含其他租户）、各家 home、运行时 socket */
export function sandboxMasks(extra: string[] = []): string[] {
  const env = process.env;
  const list = [
    "/etc/cursor-remote",
    "/root",
    "/home",
    "/run/user",
    "/var/lib/cursor-remote",
    "/opt/cursor-remote-gateway",
    env.HOME || "",
    env.CURSOR_REMOTE_STATE_DIR || "",
    ...extra,
  ];
  return [...new Set(list.filter((dir) => dir && dir !== "/" && existsSync(dir)))];
}

/** bwrap：系统目录只读，敏感目录换成空 tmpfs，只有工作区可写，HOME 和 /tmp 是私有 tmpfs */
export function sandboxArgv(bwrap: string, cwd: string, workdir: string, command: string, masks = sandboxMasks()): [string, string[]] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const dir of masks) args.push("--tmpfs", dir);
  // /run 整个遮掉会弄坏 DNS（resolv.conf 常链到 /run 下），只把容器守护进程的 socket 换成空文件
  for (const sock of ["/run/docker.sock", "/var/run/docker.sock", "/run/containerd/containerd.sock"]) {
    if (existsSync(sock)) args.push("--ro-bind", "/dev/null", sock);
  }
  // 工作区可能就在被遮住的目录下面，最后再挂回来
  args.push("--bind", cwd, cwd, "--setenv", "HOME", "/tmp", "--unshare-pid", "--unshare-ipc", "--new-session", "--die-with-parent", "--chdir", workdir, "/bin/bash", "-c", command);
  return [bwrap, args];
}

const READONLY_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "egrep", "fgrep", "file", "stat", "du", "df", "tree",
  "which", "type", "echo", "printf", "date", "whoami", "uname", "env", "printenv", "true", "false", "test", "[",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "md5sum", "sha256sum", "basename", "dirname", "realpath", "readlink", "jq",
]);
const READONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "describe", "remote", "tag"]);

/** 确认写入时免审批的命令：每一段都在只读白名单里，且没有重定向、命令替换、find -exec 之类的写入口 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (!text || /[`]|\$\(|<\(|>\(/.test(text)) return false;
  const stripped = text.replace(/\d*>&\d|\d*>\s*\/dev\/null/g, "");
  if (/>/.test(stripped)) return false;
  for (const segment of stripped.split(/&&|\|\||[;|&\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const [head, sub] = words;
    if (head === "git") {
      if (!sub || !READONLY_GIT.has(sub)) return false;
      if (sub === "branch" && words.some((w) => /^-[dDmM]|--delete|--move/.test(w))) return false;
      if ((sub === "remote" || sub === "tag") && words.length > 2 && !words.slice(2).every((w) => w.startsWith("-v") || w === "-l" || w === "--list")) return false;
      continue;
    }
    if (head === "find") {
      if (words.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint\w*)$/.test(w))) return false;
      continue;
    }
    if (!READONLY_COMMANDS.has(head)) return false;
  }
  return true;
}

/** 单次调用流式推送的上限；超出后只在最终结果里保留头尾 */
const STREAM_LIMIT = 256 * 1024;

class Clip {
  head = "";
  tail = "";
  dropped = 0;
  push(text: string) {
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail += text;
    if (this.tail.length > TAIL_CHARS * 2) {
      const cut = this.tail.length - TAIL_CHARS;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }
  toString() {
    let tail = this.tail;
    let dropped = this.dropped;
    if (tail.length > TAIL_CHARS) {
      dropped += tail.length - TAIL_CHARS;
      tail = tail.slice(-TAIL_CHARS);
    }
    return dropped ? `${this.head}\n…（中间省略 ${dropped} 字符）…\n${tail}` : this.head + tail;
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export type ShellOptions = {
  /** 租户要求沙箱：有 bwrap 就包一层；没有时不应注册这个工具 */
  sandbox: boolean;
  /** 沙箱里额外遮住的目录（网关状态目录等） */
  masks?: string[];
};

export function shellTool(options: ShellOptions): ToolSpec {
  return {
    name: "run_shell",
    category: "shell",
    description:
      "在工作区里用 bash 执行一条命令，返回退出码和输出（stdout/stderr 合并，过长时保留头尾）。用于运行测试、构建、git 查询、安装依赖等。" +
      "不要用它读写文件（用 read_file / edit_file / write_file），不要跑需要交互输入或常驻不退出的命令（dev server、watch）。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 bash 命令" },
        working_directory: { type: "string", description: "相对工作区的目录，默认工作区根" },
        timeout_ms: { type: "number", description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}` },
      },
      required: ["command"],
    },
    run: async (args, ctx) => {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) return { ok: false, content: "缺少 command" };
      const workdir = resolveInside(ctx.cwd, typeof args.working_directory === "string" && args.working_directory ? args.working_directory : ".").abs;
      if (!existsSync(workdir) || !statSync(workdir).isDirectory()) return { ok: false, content: "working_directory 不是目录" };
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

      let file = "/bin/bash";
      let argv = ["-c", command];
      if (options.sandbox) {
        const bwrap = findBwrap();
        if (!bwrap) return { ok: false, content: "这个账号要求沙箱，但服务器没有 bwrap，不能执行命令。" };
        [file, argv] = sandboxArgv(bwrap, ctx.cwd, workdir, command, sandboxMasks(options.masks));
      }

      if (ctx.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return await new Promise<ToolResult>((resolveResult, reject) => {
        const t0 = Date.now();
        const env = shellEnv();
        if (options.sandbox) env.HOME = "/tmp";
        const child = spawn(file, argv, {
          cwd: workdir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        const clip = new Clip();
        let timedOut = false;
        let aborted = false;
        let streamed = 0;
        let killTimer: ReturnType<typeof setTimeout> | null = null;
        const onData = (stream: "stdout" | "stderr") => (buf: Buffer) => {
          const text = buf.toString("utf8");
          clip.push(text);
          if (!ctx.onOutput || streamed >= STREAM_LIMIT) return;
          streamed += text.length;
          ctx.onOutput({ [stream]: streamed >= STREAM_LIMIT ? `${text}\n…（输出过多，后续不再实时显示）\n` : text });
        };
        child.stdout.on("data", onData("stdout"));
        child.stderr.on("data", onData("stderr"));
        const stop = () => {
          if (killTimer) return;
          killGroup(child.pid, "SIGTERM");
          killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), 2000);
          killTimer.unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const onAbort = () => {
          aborted = true;
          stop();
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) onAbort();
        const cleanup = () => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          ctx.signal.removeEventListener("abort", onAbort);
        };
        child.on("error", (err) => {
          cleanup();
          resolveResult({ ok: false, content: `启动命令失败：${err.message}` });
        });
        child.on("close", (code, signal) => {
          cleanup();
          // 主进程退出后清掉它留下的后台子进程
          killGroup(child.pid, "SIGKILL");
          if (aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          const out = clip.toString().trimEnd();
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const status = timedOut
            ? `超时（${timeoutMs / 1000}s）已终止`
            : code === null
              ? `被信号 ${signal} 终止`
              : `退出码 ${code}`;
          resolveResult({
            ok: !timedOut && code === 0,
            content: `${status}，用时 ${secs}s\n${out || "（无输出）"}`,
            changed: [],
          });
        });
      });
    },
  };
}
