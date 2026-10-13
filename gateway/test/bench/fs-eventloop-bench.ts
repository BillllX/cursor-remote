/**
 * 事件循环基准（不起服务、不监听端口）：
 * 在同一进程里用 10ms 定时器模拟 WS 流式输出的 tick，同时调用工作区文件 / 原生工具的读路径，
 * 量 tick 间隔的最大值与 p99，反映同步阻塞对“同进程所有连接流式输出”的影响。
 *
 * 用法（在 gateway/ 下）：
 *   npx tsx test/bench/fs-eventloop-bench.ts                # 默认两组都跑：sync（旧同步版）与 async（新异步版）
 *   BENCH_MODE=sync  npx tsx test/bench/fs-eventloop-bench.ts
 *   BENCH_MODE=async npx tsx test/bench/fs-eventloop-bench.ts
 *   BENCH_FILES=20000 BENCH_REPS=3 BENCH_JSON=1 ...         # 文件数、轮数、输出 JSON
 * 本机是生产机：这个脚本只在上海站用 `remote-test.sh run` 跑（会造 2 万个文件的目录）。
 *
 * 说明：
 * - files.* 场景：sync 调旧同步函数，async 调 *Async（旧版代码里没有 *Async 时该组跳过）；
 * - tools.* 场景：调 native/tools/fs.ts 的 ToolSpec.run，它的实现随代码版本变化（改前同步、改后异步），
 *   所以 tools 场景只跑一组，标记为 "current"；
 * - mixed 场景：同一时刻并发发起 list + search + read + git status，贴近多个连接同时操作。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import * as files from "../../src/workspace/files.ts";
import { fsTools } from "../../src/native/tools/fs.ts";

const FILES = Number(process.env.BENCH_FILES) || 20_000;
const REPS = Number(process.env.BENCH_REPS) || 3;
const TICK_MS = 10;
const MODE = process.env.BENCH_MODE || "both";

type Stat = {
  scenario: string;
  impl: string;
  wallMs: number;
  ticks: number;
  maxGapMs: number;
  p99GapMs: number;
  p50GapMs: number;
  /** 最大事件循环延迟 = 最大间隔 - 理想间隔 */
  maxLagMs: number;
  /** 直方图（1ms 精度）的最大值，交叉校验 */
  histMaxMs: number;
};

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function measure(scenario: string, impl: string, work: () => Promise<void>): Promise<Stat> {
  const gaps: number[] = [];
  const hist = monitorEventLoopDelay({ resolution: 1 });
  hist.enable();
  // 先让定时器稳定下来，避免第一次 tick 带上启动开销
  await new Promise((r) => setTimeout(r, 50));
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, TICK_MS);
  const start = performance.now();
  try {
    await work();
  } finally {
    // 收尾前再等一个 tick，把最后一次阻塞也算进去
    await new Promise((r) => setTimeout(r, TICK_MS * 2));
    clearInterval(timer);
    hist.disable();
  }
  const wallMs = performance.now() - start;
  const sorted = [...gaps].sort((a, b) => a - b);
  const maxGap = sorted.length ? sorted[sorted.length - 1] : 0;
  return {
    scenario,
    impl,
    wallMs: Math.round(wallMs),
    ticks: gaps.length,
    maxGapMs: Math.round(maxGap),
    p99GapMs: Math.round(percentile(sorted, 99)),
    p50GapMs: Math.round(percentile(sorted, 50)),
    maxLagMs: Math.max(0, Math.round(maxGap - TICK_MS)),
    histMaxMs: Math.round(hist.max / 1e6),
  };
}

function build(root: string) {
  const sh = (args: string[], cwd = root) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  mkdirSync(root, { recursive: true });
  sh(["init", "-q"]);
  sh(["config", "user.email", "bench@x"]);
  sh(["config", "user.name", "bench"]);
  const perDir = 100;
  const dirs = Math.ceil(FILES / perDir);
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, "src", `g${String(d).padStart(4, "0")}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < perDir && d * perDir + i < FILES; i++) {
      const n = d * perDir + i;
      writeFileSync(join(dir, `m${String(n).padStart(5, "0")}.ts`), `export const v${n} = ${n}; // needle-${n % 97}\n`);
    }
  }
  // 路径刻意取短：ls-files 输出要小于旧版 execFileSync 的 1MiB 默认缓冲，否则会退化成只遍历 200 个文件的兜底路径
  // 单目录 2 万项：用于 list_dir / glob
  const flat = join(root, "flat");
  mkdirSync(flat, { recursive: true });
  for (let i = 0; i < FILES; i++) writeFileSync(join(flat, `f${String(i).padStart(5, "0")}.txt`), "x");
  // 大文件：200KB 文本（files.readFile 上限）、3MB 文本（超限的拒绝路径）、1.5MB 日志（native read_file 只读前 512KB）
  const line = `${"needle-line ".repeat(8)}\n`;
  writeFileSync(join(root, "big.txt"), line.repeat(Math.floor(199_000 / line.length)));
  writeFileSync(join(root, "huge.txt"), line.repeat(Math.floor(3_000_000 / line.length)));
  writeFileSync(join(root, "big.log"), line.repeat(Math.floor(1_500_000 / line.length)));
  sh(["add", "-A"]);
  sh(["commit", "-q", "-m", "bench base"]);
  // 改动 1000 个已提交文件 + 1000 个未跟踪文件，让 git status 有实际工作量
  for (let n = 0; n < 1000; n++) {
    const d = Math.floor(n / perDir);
    writeFileSync(
      join(root, "src", `g${String(d).padStart(4, "0")}`, `m${String(n).padStart(5, "0")}.ts`),
      `export const v${n} = ${n + 1}; // changed needle\n`,
    );
  }
  // 未跟踪的大文本：readDiff 走“新文件整份当 diff”的分支
  writeFileSync(join(root, "new-big.txt"), line.repeat(Math.floor(190_000 / line.length)));
  mkdirSync(join(root, "untracked"), { recursive: true });
  for (let n = 0; n < 1000; n++) writeFileSync(join(root, "untracked", `u-${n}.ts`), `export const u = ${n};\n`);
}

type AnyFn = (...args: never[]) => unknown;
function pick(sync: string, asyncName: string, impl: "sync" | "async"): AnyFn | null {
  const table = files as unknown as Record<string, AnyFn | undefined>;
  return (impl === "sync" ? table[sync] : table[asyncName]) ?? null;
}

async function main() {
  const root = resolve(mkdtempSync(join(tmpdir(), "fs-bench-")), "ws");
  const t0 = performance.now();
  build(root);
  console.error(`造数据完成：${FILES} 个文件，用时 ${Math.round(performance.now() - t0)}ms，目录 ${root}`);
  const results: Stat[] = [];
  const ac = new AbortController();
  const ctx = { cwd: root, signal: ac.signal };
  const tool = (name: string) => fsTools.find((t) => t.name === name)!;
  try {
    // 空转基线：量测量本身的噪声
    results.push(await measure("idle", "-", () => new Promise((r) => setTimeout(r, 800))));

    const impls: ("sync" | "async")[] = MODE === "sync" ? ["sync"] : MODE === "async" ? ["async"] : ["sync", "async"];
    for (const impl of impls) {
      const list = pick("listWorkspaceFilesForClient", "listWorkspaceFilesForClientAsync", impl);
      const search = pick("searchWorkspace", "searchWorkspaceAsync", impl);
      const read = pick("readWorkspaceFile", "readWorkspaceFileAsync", impl);
      const diff = pick("readWorkspaceDiff", "readWorkspaceDiffAsync", impl);
      if (!list || !search || !read || !diff) {
        console.error(`跳过 files.* (${impl})：当前代码没有对应实现`);
        continue;
      }
      const call = async <T>(fn: AnyFn, ...args: unknown[]) =>
        (await (fn as (...a: unknown[]) => unknown)(...args)) as T;
      results.push(
        await measure("files.list(git ls-files + status)", impl, async () => {
          for (let i = 0; i < REPS; i++) {
            const listed = await call<{ paths: string[]; status: Record<string, string>; truncated: boolean }>(
              list,
              root,
              "",
            );
            // 校验走的是真实 git 清单而不是兜底遍历（兜底最多 200 个）
            if (i === 0)
              console.error(
                `  [${impl}] list: ${listed.paths.length} 条路径，${Object.keys(listed.status).length} 条状态`,
              );
          }
        }),
      );
      results.push(
        await measure("files.search(rg)", impl, async () => {
          for (let i = 0; i < REPS; i++) await call(search, root, "needle-7");
        }),
      );
      results.push(
        await measure("files.readFile(200KB x30 + 超限文件)", impl, async () => {
          for (let i = 0; i < 30; i++) await call(read, root, "big.txt");
          await call(read, root, "huge.txt");
        }),
      );
      results.push(
        await measure("files.readDiff(未跟踪大文件 x10)", impl, async () => {
          for (let i = 0; i < 10; i++) await call(diff, root, "new-big.txt");
        }),
      );
      results.push(
        await measure("files.mixed(并发 list+search+read+diff x3 连接)", impl, async () => {
          for (let i = 0; i < REPS; i++) {
            const jobs: Promise<unknown>[] = [];
            for (let c = 0; c < 3; c++) {
              jobs.push(call(list, root, ""));
              jobs.push(call(search, root, "needle-9"));
              jobs.push(call(read, root, "big.txt"));
              jobs.push(call(diff, root, "src/g0000/m00001.ts"));
            }
            await Promise.all(jobs);
          }
        }),
      );
    }

    // 原生工具：实现随代码版本变化，只跑一组
    results.push(
      await measure("tools.read_file(1.5MB 日志 x30)", "current", async () => {
        for (let i = 0; i < 30; i++) await tool("read_file").run({ path: "big.log" }, ctx);
      }),
    );
    results.push(
      await measure("tools.list_dir(2 万项目录)", "current", async () => {
        for (let i = 0; i < REPS; i++) await tool("list_dir").run({ path: "flat" }, ctx);
      }),
    );
    results.push(
      await measure("tools.glob(2 万+文件树)", "current", async () => {
        for (let i = 0; i < REPS; i++) await tool("glob").run({ pattern: "**/m0000*.ts" }, ctx);
      }),
    );
    results.push(
      await measure("tools.grep(rg 路径)", "current", async () => {
        for (let i = 0; i < REPS; i++) await tool("grep").run({ pattern: "needle-1[0-9]" }, ctx);
      }),
    );
    results.push(
      await measure("tools.grep(JS 兜底：无 rg)", "current", async () => {
        const mod = await import("../../src/native/tools/fs.ts");
        mod.setRgPathForTest(null);
        try {
          await tool("grep").run({ pattern: "needle-1[0-9]", path: "src/g0000" }, ctx);
          await tool("grep").run(
            { pattern: "needle-1[0-9]", path: "src" },
            { ...ctx, signal: AbortSignal.timeout(20_000) },
          );
        } finally {
          mod.setRgPathForTest(undefined);
        }
      }),
    );
  } finally {
    rmSync(resolve(root, ".."), { recursive: true, force: true });
  }

  if (process.env.BENCH_JSON) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    `\n${pad("场景", 52)}${pad("实现", 9)}${pad("总耗时ms", 10)}${pad("tick数", 8)}${pad("最大延迟ms", 12)}${pad("p99间隔ms", 11)}${pad("p50间隔ms", 11)}hist.max`,
  );
  for (const r of results) {
    console.log(
      `${pad(r.scenario, 52)}${pad(r.impl, 9)}${pad(r.wallMs, 10)}${pad(r.ticks, 8)}${pad(r.maxLagMs, 12)}${pad(r.p99GapMs, 11)}${pad(r.p50GapMs, 11)}${r.histMaxMs}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
