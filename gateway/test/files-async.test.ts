// 工作区文件读路径的异步化：并发上限、超时、取消杀子进程、与旧同步版行为一致、符号链接与越界仍被拦
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.ts";
import { ConfineError } from "../src/native/confine.ts";
import { fsTools, setRgPathForTest, walk, walkAsync } from "../src/native/tools/fs.ts";
import type { ToolContext } from "../src/native/types.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";
import { getTenant } from "../src/tenants.ts";
import { handlers } from "../src/ws/dispatch.ts";
import {
  listWorkspaceFilesForClient,
  listWorkspaceFilesForClientAsync,
  pushWorkspace,
  readWorkspaceDiff,
  readWorkspaceDiffAsync,
  readWorkspaceFile,
  readWorkspaceFileAsync,
  searchWorkspace,
  searchWorkspaceAsync,
  settleWorkspacePushes,
  walkFiles,
  walkFilesAsync,
} from "../src/workspace/files.ts";
import {
  beginRequest,
  execText,
  ExecError,
  HEAVY_MAX_QUEUE,
  HEAVY_MAX_RUNNING,
  HeavyBusyError,
  HeavyLimiter,
  heavyLimiter,
  isAbortError,
} from "../src/workspace/heavy.ts";

// 单租户模式指到临时目录，不读本机真实的 tenants.json 和状态目录
const base = mkdtempSync(join(tmpdir(), "cr-files-async-"));
const wsRoot = join(base, "ws");
mkdirSync(wsRoot, { recursive: true });
process.env.CURSOR_REMOTE_TENANTS_FILE = join(base, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = "files-async-test-token";
process.env.CURSOR_REMOTE_CWD = wsRoot;
process.env.CURSOR_REMOTE_STATE_DIR = join(base, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "test";
const ORIGINAL_PATH = process.env.PATH;
after(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(base, { recursive: true, force: true });
});

let seq = 0;
function tempDir(tag: string) {
  const dir = join(wsRoot, `${tag}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitRepo(tag: string) {
  const dir = tempDir(tag);
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@x");
  sh(dir, "config", "user.name", "t");
  return dir;
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到条件成立，最多 ms */
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  assert.ok(cond(), "等待条件超时");
}

/** 在 PATH 最前面放一个假的 rg：先记一行 "start <pid>"，再按脚本体行事（可往 log 追加 end）；返回日志读取器 */
function fakeRg(tag: string, body: string | ((paths: { log: string; bin: string }) => string)) {
  const bin = tempDir(`bin-${tag}`);
  const log = join(bin, "log.txt");
  const script = typeof body === "string" ? body : body({ log, bin });
  writeFileSync(join(bin, "rg"), `#!/bin/sh\necho "start $$" >> "${log}"\n${script}\n`);
  chmodSync(join(bin, "rg"), 0o755);
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
  return {
    log,
    lines: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    restore: () => {
      process.env.PATH = ORIGINAL_PATH;
    },
  };
}

describe("HeavyLimiter：租户并发上限与排队", () => {
  test("同一 key 同时运行数不超过 max，其余按先后排队", async () => {
    const limiter = new HeavyLimiter(2, 10);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      order.push(id);
      await sleep(20);
      running--;
      return id;
    };
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => limiter.run("t", task(id))));
    assert.deepEqual(results, [1, 2, 3, 4, 5, 6]);
    assert.equal(peak, 2);
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(limiter.stats("t"), { running: 0, waiting: 0 });
  });

  test("不同 key 互不占用名额", async () => {
    const limiter = new HeavyLimiter(1, 0);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const a = limiter.run("a", () => hold);
    // b 不受 a 占满的影响；a 的队列容量为 0，再来一个直接拒绝
    assert.equal(await limiter.run("b", async () => "ok"), "ok");
    await assert.rejects(() => limiter.run("a", async () => 1), HeavyBusyError);
    release();
    await a;
  });

  test("排队满：拒绝并给明确错误；名额释放后恢复", async () => {
    const limiter = new HeavyLimiter(1, 1);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const first = limiter.run("t", () => hold);
    const second = limiter.run("t", async () => "second");
    await assert.rejects(
      () => limiter.run("t", async () => "third"),
      (err: Error) =>
        err instanceof HeavyBusyError && /服务器正忙/.test(err.message) && /最多处理 1 个/.test(err.message),
    );
    release();
    await first;
    assert.equal(await second, "second");
    assert.equal(await limiter.run("t", async () => "again"), "again");
  });

  test("任务抛错也会释放名额，排队的接着跑", async () => {
    const limiter = new HeavyLimiter(1, 5);
    const failing = limiter.run("t", async () => {
      await sleep(10);
      throw new Error("boom");
    });
    const next = limiter.run("t", async () => "next");
    await assert.rejects(() => failing, /boom/);
    assert.equal(await next, "next");
    assert.deepEqual(limiter.stats("t"), { running: 0, waiting: 0 });
  });

  test("排队中被取消：退出队列、不占名额；已取消的信号直接拒绝", async () => {
    const limiter = new HeavyLimiter(1, 5);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const first = limiter.run("t", () => hold);
    const ctl = new AbortController();
    let started = false;
    const waiting = limiter.run(
      "t",
      async () => {
        started = true;
      },
      ctl.signal,
    );
    assert.equal(limiter.stats("t").waiting, 1);
    ctl.abort();
    await assert.rejects(
      () => waiting,
      (err: unknown) => isAbortError(err),
    );
    assert.equal(limiter.stats("t").waiting, 0);
    release();
    await first;
    assert.equal(started, false);
    await assert.rejects(
      () => limiter.run("t", async () => 1, AbortSignal.abort()),
      (err: unknown) => isAbortError(err),
    );
    assert.deepEqual(limiter.stats("t"), { running: 0, waiting: 0 });
  });

  test("默认上限：同租户 3 个并发、16 个排队", () => {
    assert.equal(HEAVY_MAX_RUNNING, 3);
    assert.equal(HEAVY_MAX_QUEUE, 16);
  });
});

describe("execText：超时、取消、输出上限与子进程回收", () => {
  const pidScript = "console.log(process.pid); setInterval(() => {}, 1000)";

  test("正常退出返回 stdout；非零退出带 status 与 stdout", async () => {
    assert.equal(
      await execText(process.execPath, ["-e", "console.log('hi')"], { timeoutMs: 5000, maxBuffer: 1000 }),
      "hi\n",
    );
    await assert.rejects(
      () =>
        execText(process.execPath, ["-e", "console.log('partial'); process.exit(1)"], {
          timeoutMs: 5000,
          maxBuffer: 1000,
        }),
      (err: unknown) => err instanceof ExecError && err.status === 1 && err.stdout === "partial\n",
    );
  });

  test("起不来（命令不存在）：ExecError，status 为 null", async () => {
    await assert.rejects(
      () => execText("cr-no-such-command", [], { timeoutMs: 1000, maxBuffer: 1000 }),
      (err: unknown) => err instanceof ExecError && err.status === null && err.code === "ENOENT",
    );
  });

  test("超时：杀掉子进程，返回时进程已经不在", async () => {
    let pid = 0;
    await assert.rejects(
      () => execText(process.execPath, ["-e", pidScript], { timeoutMs: 400, maxBuffer: 1000 }),
      (err: unknown) => {
        assert.ok(err instanceof ExecError);
        assert.equal(err.timedOut, true);
        pid = Number(err.stdout.trim());
        return true;
      },
    );
    assert.ok(pid > 0);
    assert.equal(pidAlive(pid), false);
  });

  test("取消后子进程确实被杀（用 pid 文件确认）", async () => {
    const dir = tempDir("pid");
    const pidFile = join(dir, "pid");
    const ctl = new AbortController();
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const run = execText(process.execPath, ["-e", script], { timeoutMs: 30_000, maxBuffer: 1000, signal: ctl.signal });
    await until(() => {
      try {
        return readFileSync(pidFile, "utf8").length > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(pidAlive(pid), true);
    ctl.abort();
    await assert.rejects(
      () => run,
      (err: unknown) => isAbortError(err),
    );
    assert.equal(pidAlive(pid), false);
  });

  test("已取消的信号不起子进程", async () => {
    await assert.rejects(
      () => execText("cr-no-such-command", [], { timeoutMs: 1000, maxBuffer: 10, signal: AbortSignal.abort() }),
      (err: unknown) => isAbortError(err),
    );
  });

  test("忽略 SIGTERM 的子进程：宽限期后 SIGKILL", async () => {
    let pid = 0;
    const script = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)";
    const started = Date.now();
    await assert.rejects(
      () => execText(process.execPath, ["-e", script], { timeoutMs: 400, maxBuffer: 1000, killGraceMs: 200 }),
      (err: unknown) => {
        assert.ok(err instanceof ExecError && err.timedOut);
        pid = Number(err.stdout.trim());
        return true;
      },
    );
    assert.ok(Date.now() - started < 3000);
    assert.equal(pidAlive(pid), false);
  });

  test("输出超过 maxBuffer：杀进程，报 ENOBUFS（与 execFileSync 一致，调用方据此降级）", async () => {
    await assert.rejects(
      () =>
        execText(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"], {
          timeoutMs: 10_000,
          maxBuffer: 1000,
        }),
      (err: unknown) =>
        err instanceof ExecError && err.code === "ENOBUFS" && err.status === null && err.stdout.length <= 1000,
    );
  });
});

describe("beginRequest：新请求覆盖旧请求，连接断开取消全部", () => {
  const conn = () => Object.assign(new EventEmitter(), { readyState: 1 });

  test("同 key 的新请求中止旧请求，不同 key 互不影响", () => {
    const c = conn();
    const a1 = beginRequest(c, "search");
    const b = beginRequest(c, "list");
    assert.equal(a1.signal.aborted, false);
    const a2 = beginRequest(c, "search");
    assert.equal(a1.signal.aborted, true);
    assert.equal(a2.signal.aborted, false);
    assert.equal(b.signal.aborted, false);
    a1.end(); // 旧请求的收尾不能把新请求的登记删掉
    const a3 = beginRequest(c, "search");
    assert.equal(a2.signal.aborted, true);
    assert.equal(a3.signal.aborted, false);
  });

  test("supersede=false：互不覆盖，只跟连接断开", () => {
    const c = conn();
    const one = beginRequest(c, "read", { supersede: false });
    const two = beginRequest(c, "read", { supersede: false });
    assert.equal(one.signal.aborted, false);
    assert.equal(two.signal.aborted, false);
    c.emit("close");
    assert.equal(one.signal.aborted, true);
    assert.equal(two.signal.aborted, true);
  });

  test("连接断开：所有未完成请求一并取消；已断开的连接直接得到已取消的信号", () => {
    const c = conn();
    const a = beginRequest(c, "x");
    const b = beginRequest(c, "y");
    c.emit("close");
    assert.equal(a.signal.aborted && b.signal.aborted, true);
    const dead = Object.assign(new EventEmitter(), { readyState: 3 });
    assert.equal(beginRequest(dead, "x").signal.aborted, true);
  });
});

describe("异步版与旧同步版行为一致", () => {
  test("readWorkspaceFile：文本 / 二进制 / 目录 / 不存在 / 越界 / 超限 / 大 markdown / 图片", async () => {
    const dir = tempDir("read");
    writeFileSync(join(dir, "a.txt"), "你好\nworld\n");
    writeFileSync(join(dir, "bin.dat.txt"), Buffer.from([65, 0, 66]));
    writeFileSync(join(dir, "big.txt"), "x".repeat(200_001));
    writeFileSync(join(dir, "mid.md"), "m".repeat(500_000));
    writeFileSync(join(dir, "small.md"), "# hi\n");
    writeFileSync(join(dir, "p.png"), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(dir, "empty.txt"), "");
    mkdirSync(join(dir, "sub"));
    for (const path of [
      "a.txt",
      "bin.dat.txt",
      "big.txt",
      "mid.md",
      "small.md",
      "p.png",
      "empty.txt",
      "sub",
      "missing.txt",
      "../outside.txt",
      "/etc/passwd",
      join(dir, "a.txt"),
    ]) {
      assert.deepEqual(await readWorkspaceFileAsync(dir, path), readWorkspaceFile(dir, path), path);
    }
  });

  test("readWorkspaceFileAsync：取消时抛 AbortError，而不是当成“读不了”", async () => {
    const dir = tempDir("read-abort");
    writeFileSync(join(dir, "a.txt"), "x");
    await assert.rejects(
      () => readWorkspaceFileAsync(dir, "a.txt", { signal: AbortSignal.abort() }),
      (err: unknown) => isAbortError(err),
    );
  });

  test("readWorkspaceFileAsync：FIFO 不会把读取卡死（先 stat 就拒绝）", async () => {
    const dir = tempDir("fifo");
    try {
      execFileSync("mkfifo", [join(dir, "pipe.txt")]);
    } catch {
      return; // 没有 mkfifo 的环境跳过
    }
    assert.deepEqual(await readWorkspaceFileAsync(dir, "pipe.txt"), { path: "pipe.txt", error: "这不是文件" });
  });

  test("readWorkspaceDiff：已跟踪有改动 / 无改动 / 未跟踪 / 图片 / svg / 不存在", async () => {
    const dir = gitRepo("diff");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
    writeFileSync(join(dir, "same.ts"), "same\n");
    writeFileSync(join(dir, "pic.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, "v.svg"), "<svg/>");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "a.ts"), "one\nTWO\n");
    writeFileSync(join(dir, "pic.png"), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(dir, "new.ts"), "fresh\nfile\n");
    writeFileSync(join(dir, "newpic.png"), Buffer.from([9]));
    for (const path of [
      "a.ts",
      "same.ts",
      "pic.png",
      "v.svg",
      "new.ts",
      "newpic.png",
      "gone.ts",
      "../x",
      "sub/none.png",
    ]) {
      assert.deepEqual(await readWorkspaceDiffAsync(dir, path), readWorkspaceDiff(dir, path), path);
    }
  });

  test("listWorkspaceFilesForClient：git 仓库（含中文名、已删除、已改、未跟踪、嵌套仓库、忽略目录）", async () => {
    const dir = gitRepo("list");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "src", "a.ts"), "a");
    writeFileSync(join(dir, "src", "b.ts"), "b");
    writeFileSync(join(dir, "中文文件.md"), "c");
    writeFileSync(join(dir, "gone.ts"), "g");
    writeFileSync(join(dir, "node_modules", "n.js"), "n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "base");
    unlinkSync(join(dir, "gone.ts"));
    writeFileSync(join(dir, "src", "a.ts"), "changed");
    writeFileSync(join(dir, "src", "c.ts"), "untracked");
    const inner = join(dir, "inner");
    mkdirSync(inner);
    sh(inner, "init", "-q");
    sh(inner, "config", "user.email", "t@x");
    sh(inner, "config", "user.name", "t");
    writeFileSync(join(inner, "i.ts"), "i");
    sh(inner, "add", "-A");
    sh(inner, "commit", "-q", "-m", "inner");
    writeFileSync(join(inner, "dirty.ts"), "d");
    for (const query of ["", "a.ts", "中文", "nomatch"]) {
      assert.deepEqual(
        await listWorkspaceFilesForClientAsync(dir, query),
        listWorkspaceFilesForClient(dir, query),
        `query=${JSON.stringify(query)}`,
      );
    }
    const listed = await listWorkspaceFilesForClientAsync(dir, "");
    assert.ok(listed.paths.includes("inner/i.ts"), "进入嵌套仓库");
    assert.equal(listed.status["gone.ts"], "D");
    assert.equal(listed.status["inner/dirty.ts"], "U");
  });

  test("listWorkspaceFilesForClient：不是 git 仓库时走遍历兜底，结果一致", async () => {
    const dir = tempDir("list-nogit");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "subrepo", ".git"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "c.txt"), "c");
    writeFileSync(join(dir, "top.txt"), "t");
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    writeFileSync(join(dir, "subrepo", "s.txt"), "s");
    symlinkSync(join(dir, "a"), join(dir, "sub", "link-to-a"));
    const expected = listWorkspaceFilesForClient(dir, "");
    assert.deepEqual(await listWorkspaceFilesForClientAsync(dir, ""), expected);
    assert.ok(expected.paths.includes("top.txt") && !expected.paths.some((p) => p.startsWith("node_modules")));
  });

  test("walkFilesAsync 与 walkFiles：深度、条数上限、跳过规则一致", async () => {
    const dir = tempDir("walk");
    let d = dir;
    for (let i = 0; i < 6; i++) {
      d = join(d, `d${i}`);
      mkdirSync(d);
      writeFileSync(join(d, "f.txt"), "x");
    }
    const bulk = join(dir, "bulk");
    mkdirSync(bulk);
    for (let i = 0; i < 260; i++) writeFileSync(join(bulk, `f${String(i).padStart(3, "0")}.txt`), "x");
    const sync: string[] = [];
    walkFiles(dir, dir, sync, 0);
    const async_: string[] = [];
    await walkFilesAsync(dir, dir, async_, 0);
    assert.deepEqual(async_.sort(), sync.sort());
    assert.ok(sync.length > 0);
  });

  describe("searchWorkspace", () => {
    test("git 仓库内：结果集合一致（rg / git grep 取决于本机，顺序不作要求）", async () => {
      const dir = gitRepo("search");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "alpha NEEDLE one\nbeta\nneedle two\n");
      writeFileSync(join(dir, "src", "b.ts"), "nothing here\n");
      writeFileSync(join(dir, "c.md"), "a needle in markdown\n");
      sh(dir, "add", "-A");
      sh(dir, "commit", "-q", "-m", "base");
      const key = (hits: { path: string; line: number; text: string }[]) =>
        hits.map((h) => `${h.path}:${h.line}:${h.text}`).sort();
      for (const query of ["needle", "NEEDLE", "nothing", "no-such-text-anywhere", "  needle  ", "", "x".repeat(201)]) {
        assert.deepEqual(key(await searchWorkspaceAsync(dir, query)), key(searchWorkspace(dir, query)), query);
      }
    });

    test("既没有 rg 也不是 git 仓库：JS 兜底扫描，结果一致", async () => {
      const dir = tempDir("search-js");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "a.txt"), "Hello Needle\nsecond\n");
      writeFileSync(join(dir, "sub", "b.txt"), "needle again\n");
      writeFileSync(join(dir, "bin.txt"), Buffer.from([110, 101, 101, 100, 108, 101, 0]));
      writeFileSync(join(dir, "big.txt"), `needle\n${"x".repeat(250_000)}`);
      const empty = tempDir("nobin");
      process.env.PATH = empty; // rg 与 git 都找不到，execFile 都会 ENOENT
      try {
        const sync = searchWorkspace(dir, "needle");
        const async_ = await searchWorkspaceAsync(dir, "needle");
        assert.deepEqual(async_, sync);
        assert.ok(sync.length >= 2);
      } finally {
        process.env.PATH = ORIGINAL_PATH;
      }
    });
  });
});

describe("搜索：并发上限、取消杀子进程、排队满的明确错误", () => {
  test("同租户并发搜索不超过上限，全部完成", async () => {
    const dir = tempDir("conc");
    const rg = fakeRg("conc", ({ log }) => `sleep 0.25\necho "end $$" >> "${log}"\nexit 1`);
    const saved = { max: heavyLimiter.max, maxQueue: heavyLimiter.maxQueue };
    heavyLimiter.max = 2;
    heavyLimiter.maxQueue = 10;
    try {
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => searchWorkspaceAsync(dir, `q${i}`)));
      assert.equal(results.length, 6);
      // 从日志里重建同时在跑的 rg 数量：start +1，end -1，峰值不能超过 2
      let live = 0;
      let peak = 0;
      let starts = 0;
      for (const line of rg.lines()) {
        if (line.startsWith("start")) {
          live++;
          starts++;
        } else live--;
        peak = Math.max(peak, live);
      }
      assert.equal(starts, 6);
      assert.equal(live, 0);
      assert.ok(peak <= 2, `同时运行的 rg 峰值 ${peak}`);
      assert.ok(peak >= 2, "上限内应当真的并发了");
    } finally {
      Object.assign(heavyLimiter, saved);
      rg.restore();
    }
  });

  test("取消：连接断开时杀掉正在跑的 rg，且不再回包", async () => {
    const dir = tempDir("cancel");
    const rg = fakeRg("cancel", "exec sleep 30");
    const ctl = new AbortController();
    try {
      const run = searchWorkspaceAsync(dir, "needle", { signal: ctl.signal });
      await until(() => rg.lines().length === 1);
      const pid = Number(rg.lines()[0].split(" ")[1]);
      assert.equal(pidAlive(pid), true);
      ctl.abort();
      await assert.rejects(
        () => run,
        (err: unknown) => isAbortError(err),
      );
      assert.equal(pidAlive(pid), false);
      assert.deepEqual(heavyLimiter.stats("default"), { running: 0, waiting: 0 });
    } finally {
      rg.restore();
    }
  });

  test("取消不会让搜索退回 git grep / JS 兜底继续跑", async () => {
    const dir = tempDir("cancel-nofallback");
    writeFileSync(join(dir, "a.txt"), "needle");
    const rg = fakeRg("nofb", "exec sleep 30");
    const ctl = new AbortController();
    try {
      const run = searchWorkspaceAsync(dir, "needle", { signal: ctl.signal });
      await until(() => rg.lines().length === 1);
      ctl.abort();
      await assert.rejects(
        () => run,
        (err: unknown) => isAbortError(err),
      );
    } finally {
      rg.restore();
    }
  });

  test("排队满时：新请求被拒绝，错误信息可直接给用户看", async () => {
    const dir = tempDir("busy");
    const rg = fakeRg("busy", "exec sleep 30");
    const saved = { max: heavyLimiter.max, maxQueue: heavyLimiter.maxQueue };
    heavyLimiter.max = 1;
    heavyLimiter.maxQueue = 1;
    const ctl = new AbortController();
    try {
      const running = searchWorkspaceAsync(dir, "a", { signal: ctl.signal });
      await until(() => rg.lines().length === 1);
      const queued = searchWorkspaceAsync(dir, "b", { signal: ctl.signal });
      const settled = Promise.allSettled([running, queued]);
      await assert.rejects(
        () => searchWorkspaceAsync(dir, "c"),
        (err: Error) => err instanceof HeavyBusyError && /服务器正忙/.test(err.message),
      );
      // 读文件不起子进程，不受重任务占满的影响
      writeFileSync(join(dir, "ok.txt"), "fine");
      assert.equal((await readWorkspaceFileAsync(dir, "ok.txt")).content, "fine");
      ctl.abort();
      const outcome = await settled;
      assert.deepEqual(
        outcome.map((item) => item.status),
        ["rejected", "rejected"],
      );
    } finally {
      Object.assign(heavyLimiter, saved);
      rg.restore();
    }
  });
});

describe("WS 处理函数：覆盖、断线取消、排队满回错误", () => {
  const tenant = () => getTenant("default")!;

  function fakeConn(cwd: string) {
    const sent: ServerMessage[] = [];
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: (frame: string) => sent.push(JSON.parse(frame) as ServerMessage),
    }) as unknown as WebSocket;
    const conn = {
      authed: true,
      tenant: tenant(),
      cwd,
      slots: new Map(),
      caps: new Set(),
      maxMessageBytes: 0,
    } as unknown as Conn;
    return { ws, conn, sent, state: undefined as never, tenant: tenant() };
  }

  test("search_text：新搜索覆盖旧搜索，只有最新一次回 search_hits", async () => {
    const dir = tempDir("ws-search");
    // 第一次调用的 rg 睡下去，留一个标记；之后的调用直接“没命中”退出
    const mark = join(dir, "mark");
    const rg = fakeRg("wssearch", `if [ ! -e "${mark}" ]; then touch "${mark}"; exec sleep 30; fi\nexit 1`);
    const ctx = fakeConn(dir);
    try {
      const first = handlers.search_text!(ctx, { type: "search_text", query: "old" });
      await until(() => rg.lines().length === 1 && existsSync(mark));
      const pid = Number(rg.lines()[0].split(" ")[1]);
      const second = handlers.search_text!(ctx, { type: "search_text", query: "new" });
      await Promise.all([first, second]);
      assert.equal(pidAlive(pid), false, "旧搜索的 rg 被杀");
      const hits = ctx.sent.filter((m) => m.type === "search_hits");
      assert.equal(hits.length, 1);
      assert.equal((hits[0] as { query: string }).query, "new");
    } finally {
      rg.restore();
    }
  });

  test("search_text：连接断开后取消进行中的搜索，杀进程，不回包", async () => {
    const dir = tempDir("ws-close");
    const rg = fakeRg("wsclose", "exec sleep 30");
    const ctx = fakeConn(dir);
    try {
      const run = handlers.search_text!(ctx, { type: "search_text", query: "x" });
      await until(() => rg.lines().length === 1);
      const pid = Number(rg.lines()[0].split(" ")[1]);
      (ctx.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
      (ctx.ws as unknown as EventEmitter).emit("close");
      await run;
      assert.equal(pidAlive(pid), false);
      assert.deepEqual(ctx.sent, []);
    } finally {
      rg.restore();
    }
  });

  test("search_text：排队满时回一条不带 chatId 的 error，不静默丢", async () => {
    const dir = tempDir("ws-busy");
    const rg = fakeRg("wsbusy", "exec sleep 30");
    const saved = { max: heavyLimiter.max, maxQueue: heavyLimiter.maxQueue };
    heavyLimiter.max = 1;
    heavyLimiter.maxQueue = 0;
    const holder = fakeConn(dir);
    const other = fakeConn(dir);
    try {
      const busy = handlers.search_text!(holder, { type: "search_text", query: "hold" });
      await until(() => rg.lines().length === 1);
      await handlers.search_text!(other, { type: "search_text", query: "x", chatId: "c1" });
      assert.equal(other.sent.length, 1);
      const err = other.sent[0] as { type: string; message: string; chatId?: string };
      assert.equal(err.type, "error");
      assert.match(err.message, /服务器正忙/);
      assert.equal(err.chatId, undefined);
      // list_files 排队满：走 files.error，不占用 Agent 回合 error
      await handlers.list_files!(other, {
        type: "list_files",
        query: "",
        chatId: "c1",
        reqId: "rq-files-busy",
      });
      const filesBusy = other.sent[1] as { type: string; error?: string; reqId?: string; chatId?: string };
      assert.equal(filesBusy.type, "files");
      assert.match(filesBusy.error || "", /服务器正忙/);
      assert.equal(filesBusy.reqId, "rq-files-busy");
      assert.equal(filesBusy.chatId, "c1");
      // read_file（diff）：错误放进文件自带的 error 字段，按 reqId 回给预览
      await handlers.read_file!(other, { type: "read_file", path: "a.ts", diff: true, reqId: "r1" });
      const reply = other.sent[2] as { type: string; error?: string; reqId?: string };
      assert.equal(reply.type, "file_content");
      assert.match(reply.error || "", /服务器正忙/);
      assert.equal(reply.reqId, "r1");
      (holder.ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
      (holder.ws as unknown as EventEmitter).emit("close");
      await busy;
    } finally {
      Object.assign(heavyLimiter, saved);
      rg.restore();
    }
  });

  test("read_file：不起子进程的读取并发回包，各自带 reqId", async () => {
    const dir = tempDir("ws-read");
    writeFileSync(join(dir, "a.txt"), "AAA");
    writeFileSync(join(dir, "b.txt"), "BBB");
    const ctx = fakeConn(dir);
    await Promise.all([
      handlers.read_file!(ctx, { type: "read_file", path: "a.txt", reqId: "1" }),
      handlers.read_file!(ctx, { type: "read_file", path: "b.txt", reqId: "2" }),
    ]);
    const byReq = Object.fromEntries(
      ctx.sent.map((m) => [(m as { reqId: string }).reqId, (m as { content: string }).content]),
    );
    assert.deepEqual(byReq, { "1": "AAA", "2": "BBB" });
  });
});

describe("pushWorkspace：顺序、合并、断线", () => {
  function pushCtx(dir: string) {
    const sent: ServerMessage[] = [];
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send: (frame: string) => sent.push(JSON.parse(frame) as ServerMessage),
    }) as unknown as WebSocket;
    const conn = {
      authed: true,
      tenant: getTenant("default")!,
      cwd: dir,
      slots: new Map(),
      maxMessageBytes: 0,
    } as unknown as Conn;
    const slot = { chatId: "c1", tenantId: "default", cwd: dir } as unknown as Slot;
    return { ws, conn, slot, sent };
  }
  const shape = (sent: ServerMessage[]) =>
    sent.map((m) => (m.type === "file_content" ? `${m.diff ? "diff" : "file"}:${m.path}` : m.type));

  test("单次推送顺序：files → (file → diff) × N，与同步版一致", async () => {
    const dir = gitRepo("push");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    const { ws, conn, slot, sent } = pushCtx(dir);
    await pushWorkspace(ws, slot, conn, ["a.txt", "b.txt", "a.txt", ""]);
    assert.deepEqual(shape(sent), ["files", "file:a.txt", "diff:a.txt", "file:b.txt", "diff:b.txt"]);
  });

  test("连续调用：排队中的合并成一次，路径取并集；执行后再来的另起一次", async () => {
    const dir = gitRepo("push-merge");
    for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.txt`), n);
    const { ws, conn, slot, sent } = pushCtx(dir);
    const first = pushWorkspace(ws, slot, conn, ["a.txt"]);
    const second = pushWorkspace(ws, slot, conn, ["b.txt"]);
    await Promise.all([first, second]);
    assert.deepEqual(shape(sent), ["files", "file:a.txt", "diff:a.txt", "file:b.txt", "diff:b.txt"]);
    sent.length = 0;
    await pushWorkspace(ws, slot, conn, ["c.txt"]);
    assert.deepEqual(shape(sent), ["files", "file:c.txt", "diff:c.txt"]);
  });

  test("settleWorkspacePushes：等已排队的推送发完；没有推送时立即返回", async () => {
    const dir = gitRepo("push-settle");
    writeFileSync(join(dir, "a.txt"), "a");
    const { ws, conn, slot, sent } = pushCtx(dir);
    await settleWorkspacePushes(ws);
    pushWorkspace(ws, slot, conn, ["a.txt"]);
    await settleWorkspacePushes(ws);
    assert.deepEqual(shape(sent), ["files", "file:a.txt", "diff:a.txt"]);
  });

  test("连接已断开：推送被取消，什么都不发", async () => {
    const dir = gitRepo("push-closed");
    writeFileSync(join(dir, "a.txt"), "a");
    const { ws, conn, slot, sent } = pushCtx(dir);
    const run = pushWorkspace(ws, slot, conn, ["a.txt"]);
    (ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
    (ws as unknown as EventEmitter).emit("close");
    await run;
    assert.deepEqual(sent, []);
  });
});

describe("原生读工具：功能不变，符号链接与越界仍被拦", () => {
  const ctx = (cwd: string, signal: AbortSignal = new AbortController().signal): ToolContext => ({ cwd, signal });
  const tool = (name: string) => fsTools.find((t) => t.name === name)!;

  function workspaceWithOutside(tag: string) {
    const root = tempDir(tag);
    const outside = tempDir(`${tag}-outside`);
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET needle");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nneedle here\n");
    writeFileSync(join(root, "hello.txt"), "line1\nline2\nline3\n");
    return { root, outside };
  }

  test("read_file：行号格式、offset/limit、空文件、目录、不存在、二进制、超长文件提示", async () => {
    const { root } = workspaceWithOutside("tool-read");
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "bin.bin"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "big.log"), "0123456789\n".repeat(60_000));
    assert.deepEqual(await tool("read_file").run({ path: "hello.txt" }, ctx(root)), {
      ok: true,
      content: "1|line1\n2|line2\n3|line3\n4|",
    });
    assert.equal(
      (await tool("read_file").run({ path: "hello.txt", offset: 2, limit: 1 }, ctx(root))).content,
      "2|line2\n…（共 4 行，用 offset 继续读）",
    );
    assert.equal((await tool("read_file").run({ path: "empty.txt" }, ctx(root))).content, "1|");
    assert.deepEqual(await tool("read_file").run({ path: "src" }, ctx(root)), {
      ok: false,
      content: "src 是目录，用 list_dir",
    });
    assert.deepEqual(await tool("read_file").run({ path: "nope.txt" }, ctx(root)), {
      ok: false,
      content: "文件不存在：nope.txt",
    });
    assert.deepEqual(await tool("read_file").run({ path: "bin.bin" }, ctx(root)), {
      ok: false,
      content: "bin.bin 是二进制文件（3 字节）",
    });
    const big = await tool("read_file").run({ path: "big.log" }, ctx(root));
    assert.match(big.content, /只读了前 524288 字节/);
  });

  test("read_file / list_dir / glob / grep：越界路径、绝对路径、.. 与符号链接逃逸仍被拒绝", async () => {
    const { root, outside } = workspaceWithOutside("tool-escape");
    symlinkSync(join(outside, "secret.txt"), join(root, "link-file"));
    symlinkSync(outside, join(root, "link-dir"));
    const cases: [string, Record<string, unknown>][] = [
      ["read_file", { path: "../outside" }],
      ["read_file", { path: join(outside, "secret.txt") }],
      ["read_file", { path: "link-file" }],
      ["read_file", { path: "link-dir/secret.txt" }],
      ["read_file", { path: ".git/config" }],
      ["list_dir", { path: "link-dir" }],
      ["list_dir", { path: ".." }],
      ["glob", { pattern: "*", path: "link-dir" }],
      ["grep", { pattern: "SECRET", path: "link-dir" }],
      ["grep", { pattern: "SECRET", path: "link-file" }],
    ];
    for (const [name, args] of cases) {
      await assert.rejects(() => tool(name).run(args, ctx(root)), ConfineError, `${name} ${JSON.stringify(args)}`);
    }
  });

  test("遍历不跟随符号链接：glob / grep 结果里没有链接指向的外部文件", async () => {
    const { root, outside } = workspaceWithOutside("tool-nolink");
    symlinkSync(outside, join(root, "link-dir"));
    symlinkSync(join(outside, "secret.txt"), join(root, "link-file"));
    const globbed = await tool("glob").run({ pattern: "**/*" }, ctx(root));
    assert.ok(!/secret|link-/.test(globbed.content), globbed.content);
    for (const rgOff of [false, true]) {
      if (rgOff) setRgPathForTest(null);
      try {
        const grepped = await tool("grep").run({ pattern: "SECRET" }, ctx(root));
        assert.ok(!/SECRET/.test(grepped.content), grepped.content);
        assert.match((await tool("grep").run({ pattern: "needle" }, ctx(root))).content, /src\/a\.ts:2:needle here/);
      } finally {
        setRgPathForTest(undefined);
      }
    }
  });

  test("walkAsync 与旧 walk：顺序、跳过目录、符号链接、条数上限完全一致", async () => {
    const { root, outside } = workspaceWithOutside("tool-walk");
    for (const dir of ["node_modules", ".git", "deep/er/est", "zz", "Aa", "aa"])
      mkdirSync(join(root, dir), { recursive: true });
    for (const file of [
      "node_modules/x.js",
      ".git/HEAD",
      "deep/er/est/f.txt",
      "deep/top.txt",
      "zz/1.txt",
      "Aa/1.txt",
      "aa/1.txt",
      "b.txt",
      "B.txt",
    ]) {
      writeFileSync(join(root, file), file);
    }
    symlinkSync(outside, join(root, "linkdir"));
    symlinkSync(join(root, "b.txt"), join(root, "linkfile"));
    assert.deepEqual(await walkAsync(root), walk(root));
    assert.deepEqual(await walkAsync(root, 4), walk(root, 4));
    assert.deepEqual(await walkAsync(root, 1), walk(root, 1));
  });

  test("list_dir：目录加 /、文件带大小、跳过 .git、500 项截断、损坏的链接跳过", async () => {
    const { root } = workspaceWithOutside("tool-list");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "many"));
    for (let i = 0; i < 520; i++) writeFileSync(join(root, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
    symlinkSync(join(root, "no-such-target"), join(root, "many", "f0000-broken"));
    const top = await tool("list_dir").run({}, ctx(root));
    assert.equal(top.content, ["hello.txt  (18 B)", "many/", "src/"].join("\n"));
    const many = await tool("list_dir").run({ path: "many" }, ctx(root));
    const rows = many.content.split("\n");
    assert.equal(rows.length, 501);
    assert.equal(rows[0], "f0000.txt  (1 B)");
    assert.equal(rows[500], "…（超过 500 项，已截断）");
    assert.ok(!many.content.includes("broken"));
    assert.deepEqual(await tool("list_dir").run({ path: "hello.txt" }, ctx(root)), {
      ok: false,
      content: "不是目录：hello.txt",
    });
  });

  test("glob / grep：功能不变", async () => {
    const { root } = workspaceWithOutside("tool-glob");
    assert.equal((await tool("glob").run({ pattern: "**/*.ts" }, ctx(root))).content, "src/a.ts");
    assert.equal((await tool("glob").run({ pattern: "*.nope" }, ctx(root))).content, "没有匹配的文件");
    setRgPathForTest(null);
    try {
      assert.equal(
        (await tool("grep").run({ pattern: "needle", glob: "*.ts" }, ctx(root))).content,
        "src/a.ts:2:needle here",
      );
      assert.equal(
        (await tool("grep").run({ pattern: "NEEDLE", ignore_case: true, path: "src/a.ts" }, ctx(root))).content,
        "src/a.ts:2:needle here",
      );
      assert.equal((await tool("grep").run({ pattern: "zzzz" }, ctx(root))).content, "没有匹配");
      assert.match((await tool("grep").run({ pattern: "(" }, ctx(root))).content, /正则不合法/);
      assert.deepEqual(await tool("grep").run({ pattern: "x", path: "missing" }, ctx(root)), {
        ok: false,
        content: "路径不存在：missing",
      });
    } finally {
      setRgPathForTest(undefined);
    }
  });

  test("取消：已取消的信号让 glob / grep / read_file 立即抛 AbortError", async () => {
    const { root } = workspaceWithOutside("tool-abort");
    const aborted = ctx(root, AbortSignal.abort());
    setRgPathForTest(null);
    try {
      for (const [name, args] of [
        ["glob", { pattern: "**/*" }],
        ["grep", { pattern: "needle" }],
        ["read_file", { path: "hello.txt" }],
      ] as const) {
        await assert.rejects(
          () => tool(name).run(args, aborted),
          (err: unknown) => isAbortError(err),
          name,
        );
      }
    } finally {
      setRgPathForTest(undefined);
    }
  });

  test("读取过程中路径被换成符号链接：open 带 O_NOFOLLOW 直接失败，不读出内容", async () => {
    const { root, outside } = workspaceWithOutside("tool-swap");
    const mod = await import("../src/native/tools/fs.ts");
    // 模拟“校验之后、打开之前”路径被替换：真实路径位置现在是指向外部文件的符号链接
    const abs = join(root, "swapme.txt");
    writeFileSync(abs, "inside");
    unlinkSync(abs);
    symlinkSync(join(outside, "secret.txt"), abs);
    await assert.rejects(
      () => mod.openForRead(root, "swapme.txt", abs),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ELOOP" || err instanceof ConfineError,
    );
  });

  test("读取时目录被整个换掉（inode 变了）：复核失败，结果被丢弃", async () => {
    const { root } = workspaceWithOutside("tool-swapdir");
    const mod = await import("../src/native/tools/fs.ts");
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "a.txt"), "a");
    const { resolveInside } = await import("../src/native/confine.ts");
    const resolved = resolveInside(root, "d");
    const { lstatSync } = await import("node:fs");
    const st = lstatSync(resolved.abs);
    mod.recheckDir(root, "d", { abs: resolved.abs, dev: st.dev, ino: st.ino }); // 没变：通过
    renameSync(join(root, "d"), join(root, "d-old"));
    mkdirSync(join(root, "d"));
    assert.throws(() => mod.recheckDir(root, "d", { abs: resolved.abs, dev: st.dev, ino: st.ino }), ConfineError);
  });

  test("写路径保持同步安全打开：edit_file / write_file 仍拒绝符号链接与越界", async () => {
    const { root, outside } = workspaceWithOutside("tool-write");
    symlinkSync(join(outside, "secret.txt"), join(root, "linkw"));
    await assert.rejects(() => tool("write_file").run({ path: "linkw", content: "x" }, ctx(root)), ConfineError);
    await assert.rejects(() => tool("write_file").run({ path: "../esc.txt", content: "x" }, ctx(root)), ConfineError);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP SECRET needle");
    const done = await tool("write_file").run({ path: "new/dir/f.txt", content: "ok" }, ctx(root));
    assert.equal(done.ok, true);
    assert.equal(readFileSync(join(root, "new/dir/f.txt"), "utf8"), "ok");
  });
});
