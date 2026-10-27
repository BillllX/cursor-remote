// 工作区文件：读写、上传落盘、文件操作、diff、文件清单与搜索、撤销单个 hunk
import { execFileSync } from "node:child_process";
import {
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access, open as fsOpen, readdir as fsReaddir, stat as fsStat, type FileHandle } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { WebSocket } from "ws";
import { isPolicyProtectedPath } from "../../../shared/policy.ts";
import { formatBytes, isByteKind, kindFromPath, mimeOf, sizeLimit } from "../../../shared/preview.ts";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { log } from "../log.ts";
import { relEscapes } from "../pathInside.ts";
import { filePayload } from "../media.ts";
import { cwdOf } from "../runtime/slots.ts";
import type { Conn, Slot, WorkspaceFile, WorkspaceFiles } from "../runtime/types.ts";
import { getTenant, mediaSecret, type Tenant } from "../tenants.ts";
import { fitWorkspaceFiles } from "../ws/frame.ts";
import { send } from "../ws/send.ts";
import { git, gitRoot, isTracked, shadowGitEnv, tenantForCwd } from "./git.ts";
import { gitAsync, gitRootAsync, isTrackedAsync, shadowGitEnvAsync } from "./gitAsync.ts";
import { beginRequest, execText, HeavyAbortError, HeavyBusyError, heavyLimiter, isAbortError } from "./heavy.ts";

export function payload(
  tenant: Tenant,
  chatId: string | undefined,
  path: string,
  file: Parameters<typeof filePayload>[4],
  diff: boolean,
  echo?: Parameters<typeof filePayload>[6],
) {
  return filePayload(mediaSecret(), tenant.id, chatId, path, file, diff, echo);
}

export function workspacePath(cwd: string, raw: string): string | null {
  const abs = raw.startsWith("/") ? raw : resolve(cwd, raw);
  const rel = relative(cwd, abs);
  if (!rel || relEscapes(rel)) return null;
  return rel;
}

/** 每个连接上待执行 / 执行中的推送链：保证同一连接的推送按调用顺序一条条发 */
type PendingPush = { chatId: string; paths: string[]; started: boolean; done: Promise<void> };
const pushState = new WeakMap<WebSocket, { tail: Promise<void>; queued: PendingPush[] }>();

/**
 * 把文件清单与指定文件的内容 / diff 推给客户端。mobile_compact_v1 只收清单，正文按需读取。
 * 读盘和 git 都是异步的（不再卡事件循环），
 * 返回的 Promise 永不 reject。
 * 顺序：同一连接的推送严格按调用顺序执行；单次推送内仍是 files → (file → diff) × N，与同步版一致。
 * 合并：同一会话还有一条没开始执行的推送排着队时，把新的路径并进去而不是再排一条，
 * 免得 Agent 连续改文件时在慢仓库上堆出一长串重复的全量清单。
 * 需要“先推文件再发 done”的调用方 await 返回值或 settleWorkspacePushes(ws)。
 */
export function pushWorkspace(ws: WebSocket, slot: Slot, conn: Conn, paths: string[] = []): Promise<void> {
  let state = pushState.get(ws);
  if (!state) {
    state = { tail: Promise.resolve(), queued: [] };
    pushState.set(ws, state);
  }
  const waiting = state.queued.find((item) => !item.started && item.chatId === slot.chatId);
  if (waiting) {
    for (const path of paths) if (!waiting.paths.includes(path)) waiting.paths.push(path);
    return waiting.done;
  }
  const cwd = cwdOf(conn, slot);
  const tenant = conn.tenant || getTenant(slot.tenantId)!;
  const entry: PendingPush = { chatId: slot.chatId, paths: [...paths], started: false, done: Promise.resolve() };
  const current = state;
  entry.done = current.tail.then(async () => {
    entry.started = true;
    try {
      await runPush(ws, slot, conn, cwd, tenant, entry.paths);
    } catch (err) {
      if (!isAbortError(err)) {
        const busy = err instanceof HeavyBusyError;
        (busy ? log.warn : log.debug)("推送工作区文件失败", slot.chatId, err instanceof Error ? err.message : err);
      }
    } finally {
      const at = current.queued.indexOf(entry);
      if (at >= 0) current.queued.splice(at, 1);
    }
  });
  current.queued.push(entry);
  current.tail = entry.done;
  return entry.done;
}

/** 等这个连接已排队的推送都发完（最多 maxMs），给“推完文件再发 done”的收尾用 */
export async function settleWorkspacePushes(ws: WebSocket, maxMs = 5000): Promise<void> {
  const tail = pushState.get(ws)?.tail;
  if (!tail) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    tail,
    new Promise<void>((resolveTimer) => {
      timer = setTimeout(resolveTimer, maxMs);
    }),
  ]);
  clearTimeout(timer);
}

async function runPush(ws: WebSocket, slot: Slot, conn: Conn, cwd: string, tenant: Tenant, paths: string[]) {
  const { signal, end } = beginRequest(ws, "push", { supersede: false });
  try {
    const listed = await listWorkspaceFilesForClientAsync(cwd, "", { signal });
    send(ws, filesMessage(conn, { chatId: slot.chatId, query: "" }, listed));
    // 移动端 compact 仍靠 files 刷新树和 git 状态；文件正文、diff 只在用户打开时 read_file。
    if (conn.caps.has("mobile_compact_v1")) return;
    const unique = [...new Set(paths.filter(Boolean))];
    for (const path of unique) {
      const file = await readWorkspaceFileAsync(cwd, path, { signal });
      send(ws, payload(tenant, slot.chatId, path, file, false));
      const diff = await readWorkspaceDiffAsync(cwd, path, { signal });
      send(ws, payload(tenant, slot.chatId, path, diff, true));
    }
  } finally {
    end();
  }
}

/**
 * 旧的同步版：留给回合收尾、检查点、附件展开等不在 WS 请求热路径上的同步调用方，
 * 也是单测里“异步版行为一致”的对照基准。WS 请求处理一律用 *Async 版本。
 */
export function readWorkspaceFile(cwd: string, raw: string): WorkspaceFile {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const abs = resolve(cwd, path);
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { path, error: "这不是文件" };
    const kind = kindFromPath(path);
    const mime = mimeOf(path, kind);
    const limit = sizeLimit(kind);
    if (st.size > limit) {
      return {
        path,
        error: `文件太大（${formatBytes(st.size)}），不在这里打开`,
        kind,
        mime,
        size: st.size,
      };
    }
    if (isByteKind(kind)) {
      return { path, kind, mime, size: st.size };
    }
    if ((kind === "html" || kind === "markdown") && st.size > 400_000) {
      return { path, kind, mime, size: st.size };
    }
    const buf = readFileSync(abs);
    if (kind === "text" && buf.includes(0)) {
      return {
        path,
        error: "二进制文件，没法预览",
        kind: "binary",
        mime: "application/octet-stream",
        size: st.size,
      };
    }
    return { path, content: buf.toString("utf8"), kind, mime, size: st.size };
  } catch {
    return { path, error: "读不了这个文件" };
  }
}

export function writeWorkspaceFile(cwd: string, raw: string, content: string): { path: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path)) return { path, error: "不能改策略文件" };
  if (content.length > 500_000) return { path, error: "内容超过 500KB，不在这里保存" };
  const abs = resolve(cwd, path);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { path };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "写不了这个文件" };
  }
}

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const UPLOAD_DIR = ".cursor-remote/uploads";

function safeUploadName(raw: string): string {
  const base = basename(raw || "file").replace(/[\\/]/g, "");
  const cleaned =
    base
      .replace(/[\x00-\x1f:*?"<>|]/g, "_")
      .replace(/^\.+/g, "")
      .trim() || "file";
  return cleaned.slice(0, 120);
}

export function uniqueUploadPath(cwd: string, name: string): string | null {
  const safe = safeUploadName(name);
  for (let n = 0; n < 200; n++) {
    const stem =
      n === 0
        ? safe
        : (() => {
            const dot = safe.lastIndexOf(".");
            const head = dot > 0 ? safe.slice(0, dot) : safe;
            const ext = dot > 0 ? safe.slice(dot) : "";
            return `${head}-${n}${ext}`;
          })();
    const rel = `${UPLOAD_DIR}/${stem}`;
    if (!workspacePath(cwd, rel)) return null;
    if (!existsSync(resolve(cwd, rel))) return rel;
  }
  return null;
}

export function writeWorkspaceBytes(
  cwd: string,
  raw: string,
  buf: Buffer,
): { path: string; error?: string; size?: number } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path)) return { path, error: "不能改策略文件" };
  if (buf.length > MAX_UPLOAD_BYTES) return { path, error: "文件超过 32MB" };
  try {
    mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
    writeFileSync(resolve(cwd, path), buf);
    return { path, size: buf.length };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "写不了这个文件" };
  }
}

export function runFsOp(
  cwd: string,
  op: "create" | "mkdir" | "rename" | "delete",
  raw: string,
  to?: string,
): { path: string; to?: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path) || (to && isPolicyProtectedPath(to))) {
    return { path, to, error: "不能改策略文件" };
  }
  const abs = resolve(cwd, path);
  try {
    if (op === "mkdir") {
      mkdirSync(abs, { recursive: true });
      return { path };
    }
    if (op === "create") {
      mkdirSync(dirname(abs), { recursive: true });
      if (existsSync(abs)) return { path, error: "已经有这个文件" };
      writeFileSync(abs, "");
      return { path };
    }
    if (op === "rename") {
      if (!to?.trim()) return { path, error: "缺少新名字" };
      const dest = workspacePath(cwd, to);
      if (!dest) return { path, to, error: "新路径不在工作区里" };
      const destAbs = resolve(cwd, dest);
      if (existsSync(destAbs)) return { path, to: dest, error: "目标已存在" };
      mkdirSync(dirname(destAbs), { recursive: true });
      renameSync(abs, destAbs);
      return { path, to: dest };
    }
    if (op === "delete") {
      if (!existsSync(abs)) return { path, error: "不存在" };
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (readdirSync(abs).length) return { path, error: "目录不是空的" };
        rmdirSync(abs);
      } else {
        unlinkSync(abs);
      }
      return { path };
    }
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "操作失败" };
  }
  return { path, error: "未知操作" };
}

export function readWorkspaceDiff(cwd: string, raw: string): WorkspaceFile {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  try {
    if (kind === "image" || kind === "svg") {
      const abs = resolve(cwd, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return { path, error: "这不是文件", kind, mime };
      }
      const size = statSync(abs).size;
      if (!isTracked(cwd, path)) {
        return { path, kind, mime, size, hasHead: false };
      }
      const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
      const out = git(cwd, ["diff", "HEAD", "--", path], env);
      if (!out) return { path, error: "没有未提交的改动", kind, mime, size };
      return { path, kind, mime, size, hasHead: true };
    }
    if (isByteKind(kind)) {
      return { path, error: "这类文件没有文本 diff", kind, mime };
    }
    if (isTracked(cwd, path)) {
      const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
      const out = git(cwd, ["diff", "HEAD", "--", path], env);
      if (out) return { path, content: out, kind: "text", mime: "text/x-diff" };
      return { path, error: "没有未提交的改动", kind };
    }
    const file = readWorkspaceFile(cwd, path);
    if (file.error || file.content == null) {
      return { path, error: file.error || "读不了这个文件", kind: file.kind, mime: file.mime, size: file.size };
    }
    const lines = file.content.split("\n");
    const body = [
      `diff --git a/${path} b/${path}`,
      "new file",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return { path, content: body, kind: "text", mime: "text/x-diff", size: file.size };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "没有 diff", kind, mime };
  }
}

export function walkFiles(root: string, dir: string, acc: string[], depth: number) {
  if (depth > 3 || acc.length > 200) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === ".next" ||
      name === "dist" ||
      name === ".loop" ||
      name === ".cursor" ||
      name === ".venv" ||
      name === "venv" ||
      name === "coverage"
    ) {
      continue;
    }
    const full = resolve(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        if (full !== root && existsSync(resolve(full, ".git"))) continue;
        walkFiles(root, full, acc, depth + 1);
      } else acc.push(relative(root, full));
    } catch (err) {
      // skip unreadable
      log.debug("遍历文件：读不了", full, err instanceof Error ? err.message : err);
    }
  }
}

function gitLetter(xy: string): string {
  if (xy === "??" || xy.includes("?")) return "U";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  if (xy.includes("R") || xy.includes("C")) return "R";
  return "M";
}

function unescapeGitPath(file: string): string {
  if (!(file.startsWith('"') && file.endsWith('"'))) return file;
  const inner = file.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === "\\") {
        bytes.push(next.charCodeAt(0));
        i += 1;
        continue;
      }
      const oct = /^\\([0-7]{3})/.exec(inner.slice(i));
      if (oct) {
        bytes.push(Number.parseInt(oct[1], 8));
        i += oct[0].length - 1;
        continue;
      }
    }
    bytes.push(inner.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

function parsePorcelain(out: string, root: string, cwd: string): Record<string, string> {
  const map: Record<string, string> = {};
  const nul = out.includes("\0");
  const chunks = nul ? out.split("\0") : out.split("\n");
  for (let i = 0; i < chunks.length; i++) {
    const raw = chunks[i];
    if (raw.length < 3) continue;
    const xy = raw.slice(0, 2);
    let file = unescapeGitPath(raw.slice(3));
    if ((xy.includes("R") || xy.includes("C")) && nul && i + 1 < chunks.length) {
      file = unescapeGitPath(chunks[++i]);
    } else {
      const arrow = file.lastIndexOf(" -> ");
      if (arrow >= 0) file = file.slice(arrow + 4);
    }
    if (!file) continue;
    const rel = relative(cwd, resolve(root, file));
    if (!rel || relEscapes(rel)) continue;
    map[rel] = gitLetter(xy);
  }
  return map;
}

function headNames(cwd: string, extra?: Record<string, string>): Set<string> {
  try {
    const out = extra
      ? git(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], extra)
      : execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
          cwd,
          encoding: "utf8",
          timeout: 4000,
          stdio: ["ignore", "pipe", "ignore"],
        });
    return new Set(
      out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function dropGhostStatus(
  cwd: string,
  map: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const head = headNames(cwd, extra);
  const next: Record<string, string> = {};
  for (const [path, letter] of Object.entries(map)) {
    if (existsSync(resolve(cwd, path)) || head.has(path)) next[path] = letter;
  }
  return next;
}

function gitStatusMap(cwd: string): Record<string, string> {
  const run = (root: string, extra?: Record<string, string>) => {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain", "-uall", "-z"], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      env: extra ? { ...process.env, ...extra } : process.env,
    });
    return dropGhostStatus(cwd, parsePorcelain(out, root, cwd), extra);
  };
  const root = gitRoot(cwd);
  if (root) {
    try {
      return run(root);
    } catch {
      return {};
    }
  }
  const extra = shadowGitEnv(cwd);
  if (!extra) return {};
  try {
    return run(cwd, extra);
  } catch {
    return {};
  }
}

export function listWorkspaceFiles(cwd: string, query: string): WorkspaceFiles {
  const { paths, status } = collectWorkspaceFiles(cwd);
  return rankWorkspaceFiles(paths, status, query);
}

/**
 * 给文件树和 @ 补全用：嵌套仓库在外层 git 里只占一项 `dir/`，要进去再列一次。
 * 检查点不能用这个——还原时会删掉清单里有、快照里没有的文件，而快照只记了嵌套仓库的 gitlink。
 */
export function listWorkspaceFilesForClient(cwd: string, query: string): WorkspaceFiles {
  const { paths, status } = collectWithNested(cwd, 0);
  return rankWorkspaceFiles(paths, status, query);
}

function collectWithNested(cwd: string, depth: number): { paths: string[]; status: Record<string, string> } {
  const own = collectWorkspaceFiles(cwd);
  if (depth >= 3) return own;
  const nested = own.paths.filter((path) => {
    try {
      const abs = resolve(cwd, path);
      return statSync(abs).isDirectory() && existsSync(resolve(abs, ".git"));
    } catch {
      return false;
    }
  });
  if (!nested.length) return own;
  const skip = new Set(nested);
  const paths = own.paths.filter((path) => !skip.has(path));
  const status: Record<string, string> = {};
  for (const [path, letter] of Object.entries(own.status)) if (!skip.has(path)) status[path] = letter;
  for (const dir of nested) {
    const inner = collectWithNested(resolve(cwd, dir), depth + 1);
    for (const path of inner.paths) paths.push(`${dir}/${path}`);
    for (const [path, letter] of Object.entries(inner.status)) status[`${dir}/${path}`] = letter;
  }
  return { paths, status };
}

function collectWorkspaceFiles(cwd: string): { paths: string[]; status: Record<string, string> } {
  let paths: string[] = [];
  const root = gitRoot(cwd);
  const shadow = root ? null : shadowGitEnv(cwd);
  try {
    if (root) {
      // quotepath 默认会把中文路径收成 "\345\256..."，后面的 existsSync 对不上磁盘，整批被丢掉。
      const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
        cwd,
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      paths = out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else if (shadow) {
      paths = git(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], shadow)
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      walkFiles(cwd, cwd, paths, 0);
    }
  } catch {
    walkFiles(cwd, cwd, paths, 0);
  }
  const status = gitStatusMap(cwd);
  paths = paths.filter((path) => existsSync(resolve(cwd, path)));
  for (const path of Object.keys(status)) {
    if (status[path] === "D") continue;
    if (!paths.includes(path) && existsSync(resolve(cwd, path))) paths.push(path);
  }
  return { paths, status };
}

function rankWorkspaceFiles(paths: string[], status: Record<string, string>, query: string): WorkspaceFiles {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? paths.filter((path) => {
        const base = path.split("/").pop() || path;
        return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
      })
    : paths;
  const dirty = Object.keys(status);
  const rest = filtered.filter((path) => !status[path]);
  // 用 Set 判断是否在 filtered 里：数组 includes 是 O(n·m)，2 万文件 × 2 千改动会同步占住事件循环上百毫秒；结果相同
  const inFiltered = new Set(filtered);
  const ranked = q ? filtered : [...dirty.filter((path) => inFiltered.has(path)), ...rest];
  const sliced = ranked.slice(0, 8000);
  return { paths: sliced, status, truncated: ranked.length > sliced.length };
}

export function filesMessage(
  conn: Conn | undefined,
  base: { chatId?: string; query: string; mention?: boolean; reqId?: string },
  listed: WorkspaceFiles,
  error?: string,
): ServerMessage {
  if (error) {
    return { type: "files", ...base, paths: [], status: {}, truncated: false, error };
  }
  const overhead = Buffer.byteLength(JSON.stringify({ type: "files", ...base, truncated: true }));
  const fitted = fitWorkspaceFiles(listed, conn?.maxMessageBytes ?? 0, overhead);
  return { type: "files", ...base, paths: fitted.paths, status: fitted.status, truncated: fitted.truncated };
}

function parseSearchHits(raw: string): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = [];
  for (const row of raw.split("\n")) {
    if (!row) continue;
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!match) continue;
    hits.push({
      path: match[1].replace(/^\.\//, ""),
      line: Number(match[2]),
      text: match[3].replace(/\s+/g, " ").trim().slice(0, 140),
    });
    if (hits.length >= 100) break;
  }
  return hits;
}

export function searchWorkspace(cwd: string, query: string): { path: string; line: number; text: string }[] {
  const needle = query.trim();
  if (!needle || needle.length > 200) return [];
  const globs = [
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!**/.next/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/.venv/**",
  ];
  try {
    const out = execFileSync(
      "rg",
      [
        "-n",
        "--fixed-strings",
        "--hidden",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        "24",
        "--max-filesize",
        "200K",
        ...globs,
        "--",
        needle,
        ".",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return parseSearchHits(out);
  } catch (err) {
    const failed = err as { status?: number; stdout?: string };
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  try {
    const extra = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
    const out = execFileSync("git", ["-c", "core.quotepath=false", "grep", "-n", "-I", "-F", "-e", needle, "--", "."], {
      cwd,
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: extra ? { ...process.env, ...extra } : process.env,
    });
    return parseSearchHits(out);
  } catch (err) {
    const failed = err as { status?: number; stdout?: string };
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  const paths: string[] = [];
  walkFiles(cwd, cwd, paths, 0);
  const hits: { path: string; line: number; text: string }[] = [];
  const lower = needle.toLowerCase();
  for (const path of paths) {
    const abs = resolve(cwd, path);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 200_000) continue;
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(lower)) continue;
        hits.push({
          path,
          line: i + 1,
          text: lines[i].replace(/\s+/g, " ").trim().slice(0, 140),
        });
        n += 1;
        if (n >= 8 || hits.length >= 100) break;
      }
    } catch (err) {
      // skip unreadable
      log.debug("搜索：文件读不了", abs, err instanceof Error ? err.message : err);
    }
    if (hits.length >= 100) break;
  }
  return hits;
}

export function revertHunk(cwd: string, raw: string, hunk: string): { path: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const headerRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const hunkLines = hunk.split("\n");
  const atIdx = hunkLines.findIndex((line) => headerRe.test(line));
  if (atIdx < 0) return { path, error: "看不懂这段 diff" };
  const header = headerRe.exec(hunkLines[atIdx]);
  if (!header) return { path, error: "看不懂这段 diff" };
  const file = readWorkspaceFile(cwd, path);
  if (file.error || file.content == null) {
    return { path, error: file.error || "读不了这个文件" };
  }
  let i = Number(header[1]) - 1;
  const lines = file.content.split("\n");
  const body = hunkLines.slice(atIdx + 1);
  for (let k = 0; k < body.length; k++) {
    const row = body[k];
    if (k === body.length - 1 && row === "") continue;
    if (row.startsWith("+")) {
      if (i < 0 || i >= lines.length) return { path, error: "这段 diff 对不上文件" };
      lines.splice(i, 1);
    } else if (row.startsWith("-")) {
      lines.splice(Math.max(i, 0), 0, row.slice(1));
      i += 1;
    } else if (row.startsWith("\\")) {
      continue;
    } else {
      i += 1;
    }
  }
  const abs = resolve(cwd, path);
  const next = lines.join("\n");
  try {
    if (!next.trim() && !isTracked(cwd, path)) {
      if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
    } else {
      writeFileSync(abs, next);
    }
  } catch {
    return { path, error: "写回失败" };
  }
  return { path };
}

// ======================================================================
// 异步版（请求热路径）：读盘与子进程都不阻塞事件循环，起子进程的任务受租户并发上限约束，
// 可取消（连接断开 / 新请求覆盖）、有超时。对外返回值与上面的同步版逐字段一致。
// ======================================================================

export type AsyncOpt = { signal?: AbortSignal };

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new HeavyAbortError();
}

/** 重任务按租户分道：同一租户同时最多 N 个，超出排队，队列满抛 HeavyBusyError */
function heavy<T>(cwd: string, opt: AsyncOpt, task: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  return heavyLimiter.run(tenantForCwd(cwd)?.id ?? "_", task, opt.signal);
}

async function existsAsync(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 分批并发：既不一次性挂出两万个 fs 请求，也让出事件循环给别的连接 */
async function mapBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  signal: AbortSignal | undefined,
  size = 256,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    throwIfAborted(signal);
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** 与旧 execFileSync 的默认输出上限（1MiB）保持一致，行为不变 */
const LIST_MAX_BUFFER = 1024 * 1024;
const WALK_SKIP = new Set(["node_modules", ".git", ".next", "dist", ".loop", ".cursor", ".venv", "venv", "coverage"]);

type GitWhere = { root: string | null; shadow: Record<string, string> | null };

async function locateGit(cwd: string, signal: AbortSignal | undefined): Promise<GitWhere> {
  const root = await gitRootAsync(cwd, { signal });
  const shadow = root ? null : await shadowGitEnvAsync(cwd, { signal });
  return { root, shadow };
}

/** walkFiles 的异步版：同样的深度 / 条数 / 跳过规则，跟随符号链接（与同步版一致） */
export async function walkFilesAsync(
  root: string,
  dir: string,
  acc: string[],
  depth: number,
  signal?: AbortSignal,
): Promise<void> {
  if (depth > 3 || acc.length > 200) return;
  throwIfAborted(signal);
  let entries: string[] = [];
  try {
    entries = await fsReaddir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (WALK_SKIP.has(name)) continue;
    throwIfAborted(signal);
    const full = resolve(dir, name);
    try {
      const st = await fsStat(full);
      if (st.isDirectory()) {
        if (full !== root && (await existsAsync(resolve(full, ".git")))) continue;
        await walkFilesAsync(root, full, acc, depth + 1, signal);
      } else acc.push(relative(root, full));
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug("遍历文件：读不了", full, err instanceof Error ? err.message : err);
    }
  }
}

async function headNamesAsync(cwd: string, where: GitWhere, signal: AbortSignal | undefined): Promise<Set<string>> {
  try {
    const out = where.shadow
      ? await gitAsync(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], where.shadow, { signal })
      : await execText("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
          cwd,
          timeoutMs: 4000,
          maxBuffer: LIST_MAX_BUFFER,
          signal,
        });
    return new Set(
      out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    return new Set();
  }
}

async function dropGhostStatusAsync(
  cwd: string,
  map: Record<string, string>,
  where: GitWhere,
  signal: AbortSignal | undefined,
): Promise<Record<string, string>> {
  const entries = Object.entries(map);
  if (!entries.length) return {};
  const exists = await mapBatches(entries, ([path]) => existsAsync(resolve(cwd, path)), signal);
  // 只有磁盘上找不到的条目才需要 HEAD 清单；全都在磁盘上时省掉一次 git 调用，结果相同
  const head = exists.every(Boolean) ? new Set<string>() : await headNamesAsync(cwd, where, signal);
  const next: Record<string, string> = {};
  entries.forEach(([path, letter], i) => {
    if (exists[i] || head.has(path)) next[path] = letter;
  });
  return next;
}

async function gitStatusMapAsync(
  cwd: string,
  where: GitWhere,
  signal: AbortSignal | undefined,
): Promise<Record<string, string>> {
  const run = async (root: string, extra?: Record<string, string>) => {
    const out = await execText("git", ["-c", "core.quotepath=false", "status", "--porcelain", "-uall", "-z"], {
      cwd,
      env: extra ? { ...process.env, ...extra } : process.env,
      timeoutMs: 4000,
      maxBuffer: LIST_MAX_BUFFER,
      signal,
    });
    return dropGhostStatusAsync(cwd, parsePorcelain(out, root, cwd), where, signal);
  };
  try {
    if (where.root) return await run(where.root);
    if (!where.shadow) return {};
    return await run(cwd, where.shadow);
  } catch (err) {
    if (signal?.aborted) throw err;
    return {};
  }
}

/** 一次 stat 同时回答“在不在”和“是不是目录”：null 表示不存在（与 existsSync 一致，坏链接也算不存在） */
async function statKind(path: string): Promise<"file" | "dir" | null> {
  try {
    return (await fsStat(path)).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

async function collectWorkspaceFilesAsync(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ paths: string[]; status: Record<string, string>; dirs: Set<string> }> {
  const where = await locateGit(cwd, signal);
  let paths: string[] = [];
  try {
    if (where.root) {
      // quotepath 默认会把中文路径收成 "\345\256..."，后面的存在性检查对不上磁盘，整批被丢掉。
      const out = await execText("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
        cwd,
        timeoutMs: 4000,
        maxBuffer: LIST_MAX_BUFFER,
        signal,
      });
      paths = out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else if (where.shadow) {
      paths = (await gitAsync(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], where.shadow, { signal }))
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      await walkFilesAsync(cwd, cwd, paths, 0, signal);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    await walkFilesAsync(cwd, cwd, paths, 0, signal);
  }
  const status = await gitStatusMapAsync(cwd, where, signal);
  // 存在性检查顺带记下哪些是目录，嵌套仓库探测直接用，省掉对每个文件再 stat 一遍
  const kinds = await mapBatches(paths, (path) => statKind(resolve(cwd, path)), signal);
  const dirs = new Set<string>();
  paths = paths.filter((path, i) => {
    if (kinds[i] === "dir") dirs.add(path);
    return kinds[i] !== null;
  });
  const have = new Set(paths);
  for (const path of Object.keys(status)) {
    if (status[path] === "D") continue;
    if (have.has(path)) continue;
    const kind = await statKind(resolve(cwd, path));
    if (kind) {
      paths.push(path);
      have.add(path);
      if (kind === "dir") dirs.add(path);
    }
  }
  return { paths, status, dirs };
}

async function collectWithNestedAsync(
  cwd: string,
  depth: number,
  signal: AbortSignal | undefined,
): Promise<{ paths: string[]; status: Record<string, string> }> {
  const own = await collectWorkspaceFilesAsync(cwd, signal);
  if (depth >= 3) return { paths: own.paths, status: own.status };
  // 只有目录才可能是嵌套仓库（ls-files 里的 gitlink、符号链接指向的目录、状态里的 `dir/`）
  const candidates = own.paths.filter((path) => own.dirs.has(path));
  const isNested = await mapBatches(candidates, (path) => existsAsync(resolve(cwd, path, ".git")), signal);
  const nestedSet = new Set(candidates.filter((_, i) => isNested[i]));
  // 保持与 own.paths 相同的相对顺序
  const nested = own.paths.filter((path) => nestedSet.has(path));
  if (!nested.length) return { paths: own.paths, status: own.status };
  const skip = new Set(nested);
  const paths = own.paths.filter((path) => !skip.has(path));
  const status: Record<string, string> = {};
  for (const [path, letter] of Object.entries(own.status)) if (!skip.has(path)) status[path] = letter;
  for (const dir of nested) {
    const inner = await collectWithNestedAsync(resolve(cwd, dir), depth + 1, signal);
    for (const path of inner.paths) paths.push(`${dir}/${path}`);
    for (const [path, letter] of Object.entries(inner.status)) status[`${dir}/${path}`] = letter;
  }
  return { paths, status };
}

/** listWorkspaceFilesForClient 的异步版（文件树、@ 补全、推送用） */
export function listWorkspaceFilesForClientAsync(
  cwd: string,
  query: string,
  opt: AsyncOpt = {},
): Promise<WorkspaceFiles> {
  return heavy(cwd, opt, async (signal) => {
    const { paths, status } = await collectWithNestedAsync(cwd, 0, signal);
    return rankWorkspaceFiles(paths, status, query);
  });
}

type FileMeta = { path: string; kind: NonNullable<WorkspaceFile["kind"]>; mime: string; size: number; limit: number };

/** 按 stat 结果决定：直接给结论，或者需要读内容。分支顺序与同步版 readWorkspaceFile 一致 */
function planFileRead(
  path: string,
  st: { isFile(): boolean; size: number },
): { done: WorkspaceFile } | { read: FileMeta } {
  if (!st.isFile()) return { done: { path, error: "这不是文件" } };
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  const limit = sizeLimit(kind);
  if (st.size > limit) {
    return {
      done: { path, error: `文件太大（${formatBytes(st.size)}），不在这里打开`, kind, mime, size: st.size },
    };
  }
  if (isByteKind(kind)) return { done: { path, kind, mime, size: st.size } };
  if ((kind === "html" || kind === "markdown") && st.size > 400_000)
    return { done: { path, kind, mime, size: st.size } };
  return { read: { path, kind, mime, size: st.size, limit } };
}

/** 从 fd 读到 EOF 或 cap 字节：文件在 stat 之后被追加，也不会读出超过上限的内容 */
async function readUpTo(fh: FileHandle, cap: number, signal: AbortSignal | undefined): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(cap);
  let total = 0;
  while (total < cap) {
    throwIfAborted(signal);
    const { bytesRead } = await fh.read(buf, total, cap - total, null);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

/**
 * readWorkspaceFile 的异步版。校验语义与同步版一致（只做工作区内的字面路径检查，跟随符号链接）。
 * 先 stat 排除目录 / 超限 / 二进制类，再 open（O_NONBLOCK，防 FIFO 把线程池卡死）后用 fstat 复核，
 * 并按 fstat 的大小有界读取，stat 与读取之间文件被替换或追加也不会读出超限内容。
 */
export async function readWorkspaceFileAsync(cwd: string, raw: string, opt: AsyncOpt = {}): Promise<WorkspaceFile> {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const abs = resolve(cwd, path);
  let fh: FileHandle | undefined;
  try {
    throwIfAborted(opt.signal);
    const early = planFileRead(path, await fsStat(abs));
    if ("done" in early) return early.done;
    fh = await fsOpen(abs, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = await fh.stat();
    const plan = planFileRead(path, st);
    if ("done" in plan) return plan.done;
    const { kind, mime, limit } = plan.read;
    const buf = await readUpTo(fh, Math.min(st.size, limit), opt.signal);
    if (kind === "text" && buf.includes(0)) {
      return { path, error: "二进制文件，没法预览", kind: "binary", mime: "application/octet-stream", size: st.size };
    }
    return { path, content: buf.toString("utf8"), kind, mime, size: st.size };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { path, error: "读不了这个文件" };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** readWorkspaceDiff 的异步版（会起 git 子进程，受租户并发上限约束） */
export function readWorkspaceDiffAsync(cwd: string, raw: string, opt: AsyncOpt = {}): Promise<WorkspaceFile> {
  const path = workspacePath(cwd, raw);
  if (!path) return Promise.resolve({ path: raw, error: "路径不在工作区里" });
  return heavy(cwd, opt, (signal) => diffOf(cwd, path, signal));
}

async function diffOf(cwd: string, path: string, signal: AbortSignal | undefined): Promise<WorkspaceFile> {
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  try {
    if (kind === "image" || kind === "svg") {
      const abs = resolve(cwd, path);
      const st = await fsStat(abs).catch(() => null);
      if (!st || !st.isFile()) return { path, error: "这不是文件", kind, mime };
      const size = st.size;
      const where = await locateGit(cwd, signal);
      if (!(await isTrackedAsync(cwd, path, where, { signal }))) return { path, kind, mime, size, hasHead: false };
      const out = await gitAsync(
        cwd,
        ["diff", "HEAD", "--", path],
        where.root ? undefined : where.shadow || undefined,
        {
          signal,
        },
      );
      if (!out) return { path, error: "没有未提交的改动", kind, mime, size };
      return { path, kind, mime, size, hasHead: true };
    }
    if (isByteKind(kind)) return { path, error: "这类文件没有文本 diff", kind, mime };
    const where = await locateGit(cwd, signal);
    if (await isTrackedAsync(cwd, path, where, { signal })) {
      const out = await gitAsync(
        cwd,
        ["diff", "HEAD", "--", path],
        where.root ? undefined : where.shadow || undefined,
        {
          signal,
        },
      );
      if (out) return { path, content: out, kind: "text", mime: "text/x-diff" };
      return { path, error: "没有未提交的改动", kind };
    }
    const file = await readWorkspaceFileAsync(cwd, path, { signal });
    if (file.error || file.content == null) {
      return { path, error: file.error || "读不了这个文件", kind: file.kind, mime: file.mime, size: file.size };
    }
    const lines = file.content.split("\n");
    const body = [
      `diff --git a/${path} b/${path}`,
      "new file",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return { path, content: body, kind: "text", mime: "text/x-diff", size: file.size };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { path, error: err instanceof Error ? err.message : "没有 diff", kind, mime };
  }
}

/** 单次搜索总耗时上限；各子进程另有各自的 8s 超时，JS 兜底扫描靠它截止 */
const SEARCH_DEADLINE_MS = 8000;

/** searchWorkspace 的异步版。条数上限 100、rg 每文件 24 条、200K 文件上限、8s 超时均与同步版一致 */
export function searchWorkspaceAsync(
  cwd: string,
  query: string,
  opt: AsyncOpt = {},
): Promise<{ path: string; line: number; text: string }[]> {
  const needle = query.trim();
  if (!needle || needle.length > 200) return Promise.resolve([]);
  return heavy(cwd, opt, (signal) => searchOf(cwd, needle, signal));
}

async function searchOf(cwd: string, needle: string, signal: AbortSignal | undefined) {
  const globs = [
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!**/.next/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/.venv/**",
  ];
  const failedStatus = (err: unknown) => err as { status?: number | null; stdout?: string };
  try {
    const out = await execText(
      "rg",
      [
        "-n",
        "--fixed-strings",
        "--hidden",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        "24",
        "--max-filesize",
        "200K",
        ...globs,
        "--",
        needle,
        ".",
      ],
      { cwd, timeoutMs: 8000, maxBuffer: 2_000_000, signal },
    );
    return parseSearchHits(out);
  } catch (err) {
    if (signal?.aborted) throw err;
    const failed = failedStatus(err);
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  try {
    const where = await locateGit(cwd, signal);
    const extra = where.root ? undefined : where.shadow || undefined;
    const out = await execText(
      "git",
      ["-c", "core.quotepath=false", "grep", "-n", "-I", "-F", "-e", needle, "--", "."],
      {
        cwd,
        env: extra ? { ...process.env, ...extra } : process.env,
        timeoutMs: 8000,
        maxBuffer: 2_000_000,
        signal,
      },
    );
    return parseSearchHits(out);
  } catch (err) {
    if (signal?.aborted) throw err;
    const failed = failedStatus(err);
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  const paths: string[] = [];
  await walkFilesAsync(cwd, cwd, paths, 0, signal);
  const hits: { path: string; line: number; text: string }[] = [];
  const lower = needle.toLowerCase();
  for (const path of paths) {
    throwIfAborted(signal);
    if (Date.now() > deadline) break;
    const abs = resolve(cwd, path);
    try {
      const st = await fsStat(abs);
      if (!st.isFile() || st.size > 200_000) continue;
      const buf = await readFileAsync(abs, signal);
      if (buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(lower)) continue;
        hits.push({ path, line: i + 1, text: lines[i].replace(/\s+/g, " ").trim().slice(0, 140) });
        n += 1;
        if (n >= 8 || hits.length >= 100) break;
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      log.debug("搜索：文件读不了", abs, err instanceof Error ? err.message : err);
    }
    if (hits.length >= 100) break;
  }
  return hits;
}

async function readFileAsync(abs: string, signal: AbortSignal | undefined): Promise<Buffer> {
  const fh = await fsOpen(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a file");
    return await readUpTo(fh, Math.min(st.size, 200_000), signal);
  } finally {
    await fh.close().catch(() => undefined);
  }
}
