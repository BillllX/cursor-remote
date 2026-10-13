// 压缩落盘路径基准：量运行中每 3 秒 flushTranscript 里最重的两步
//   upsertTranscriptTurn + mergeAndCompactChat（纯函数调用，不起服务、不监听端口、不碰状态目录）。
// 用法（仓库根目录）：
//   node --import tsx scripts/bench/compact-bench.mts            # 默认 50/200/800/2000 回合
//   COMPACT_BENCH_SIZES=50,200 COMPACT_BENCH_DUP=1 node --import tsx scripts/bench/compact-bench.mts
// 输出里：
//   full  = 旧全量实现（mergeAndCompactChatFull；改前版本里没有这个导出时，就是当时的 mergeAndCompactChat）
//   incr  = 当前 mergeAndCompactChat（增量实现；改前版本里与 full 相同）
import * as storedState from "../../gateway/src/sync/storedState.ts";
import { upsertTranscriptTurn, type RunTranscript } from "../../gateway/src/runlog.ts";

type Merge = (prev: unknown, next: unknown, hit?: { n: number }) => unknown;
const mod = storedState as Record<string, unknown>;
const incr = mod.mergeAndCompactChat as Merge;
const full = (mod.mergeAndCompactChatFull ?? mod.mergeAndCompactChat) as Merge;

const SIZES = (process.env.COMPACT_BENCH_SIZES ?? "50,200,800,2000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);
const TOOLS_PER_TURN = 6;
// COMPACT_BENCH_DUP=1：所有回合共用同一批 callId（最坏情形：增量索引里全是重复 key）
const DUP = process.env.COMPACT_BENCH_DUP === "1";

function lorem(n: number, seed: number): string {
  const unit = `seed${seed} 这是一段用来占体积的正文 lorem ipsum dolor sit amet. `;
  return unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
}

function makeTool(i: number, j: number) {
  const callId = DUP ? `call-${j}` : `call-${i}-${j}`;
  return {
    callId,
    name: j % 3 === 0 ? "Shell" : j % 3 === 1 ? "Read" : "Write",
    at: 1_700_000_000_000 + i * 1000 + j,
    args: { path: `/work/file-${i}-${j}.ts`, command: `echo ${j}`, content: lorem(1800, i + j) },
    result: {
      stdout: lorem(3000, i * 7 + j),
      stderr: "",
      exitCode: 0,
      matches: Array.from({ length: 12 }, (_, k) => ({ line: k, text: lorem(80, k) })),
    },
    ...(j === 1 ? { review: "accepted" } : {}),
  };
}

function makeTurn(i: number) {
  return {
    id: `turn-${i}`,
    user: `第 ${i} 个问题：${lorem(120, i)}`,
    assistant: lorem(900, i),
    thinking: lorem(300, i + 1),
    tools: Array.from({ length: TOOLS_PER_TURN }, (_, j) => makeTool(i, j)),
    running: false,
    startedAt: 1_700_000_000_000 + i * 1000,
    // 只有近 20 轮之外也带图，才能让「图片淘汰」有活干
    images: [{ data: lorem(4000, i), mimeType: "image/png" }],
    files: i % 4 === 0 ? [{ path: `/work/file-${i}-0.ts`, status: "modified" }] : undefined,
  };
}

function makeChat(n: number) {
  const turns = Array.from({ length: n }, (_, i) => {
    const t = makeTurn(i) as Record<string, unknown>;
    if (t.files === undefined) delete t.files;
    return t;
  });
  return { id: "bench-chat", title: "基准", cwd: "/work", turns };
}

function transcriptFor(turnId: string, step: number): RunTranscript {
  return {
    turnId,
    userText: `运行中的问题 ${turnId}`,
    assistant: lorem(400 + step * 40, step),
    thinking: lorem(200, step),
    tools: Array.from({ length: 2 + (step % 4) }, (_, j) => ({
      callId: DUP ? `call-${j}` : `live-${turnId}-${j}`,
      name: "Shell",
      at: 1_800_000_000_000 + j,
      args: { command: `echo ${j}`, content: lorem(1500, j) },
      result: { stdout: lorem(2500 + step * 30, j), stderr: "" },
    })) as RunTranscript["tools"],
    phase: "running",
    epoch: 1,
    startedAt: 1_800_000_000_000,
  };
}

function stats(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}

/** 模拟 flushTranscript 的一次调用：upsert → stamped → merge；返回新会话 */
function flushOnce(
  merge: Merge,
  chat: Record<string, unknown>,
  transcript: RunTranscript,
  timing: { merge: number; upsert: number },
) {
  const turns = chat.turns as unknown[];
  const t0 = performance.now();
  const upserted = upsertTranscriptTurn(turns, transcript);
  const t1 = performance.now();
  const stamped = { ...chat, turns: upserted, runMark: { turnId: transcript.turnId } };
  const next = merge(chat, stamped) as Record<string, unknown>;
  const t2 = performance.now();
  timing.upsert += t1 - t0;
  timing.merge += t2 - t1;
  return next;
}

function runScenario(merge: Merge, n: number, scenario: "last" | "mid", iterations: number) {
  // 先把起始会话压缩一遍，模拟「磁盘上已压缩」的状态
  let chat = merge(undefined, makeChat(n)) as Record<string, unknown>;
  const turnId = scenario === "last" ? "live-turn" : `turn-${Math.max(0, n - 5)}`;
  const total: number[] = [];
  const mergeOnly: number[] = [];
  const upsertOnly: number[] = [];
  const warm = 3;
  for (let step = 0; step < iterations + warm; step += 1) {
    const timing = { merge: 0, upsert: 0 };
    chat = flushOnce(merge, chat, transcriptFor(turnId, step), timing);
    if (step < warm) continue;
    total.push(timing.merge + timing.upsert);
    mergeOnly.push(timing.merge);
    upsertOnly.push(timing.upsert);
  }
  return { total: stats(total), merge: stats(mergeOnly), upsert: stats(upsertOnly) };
}

const fmt = (v: number) => v.toFixed(v < 1 ? 3 : 2).padStart(9);
console.log(`工具/回合=${TOOLS_PER_TURN}，每回合带 1 张图；时间单位 ms/次 flush（中位数 / p95）`);
console.log(`实现          场景    回合数    总计(中位)  总计(p95)  merge(中位)  upsert(中位)`);
for (const scenario of ["last", "mid"] as const) {
  for (const n of SIZES) {
    const iterations = n >= 2000 ? 15 : n >= 800 ? 25 : 40;
    const impls: Array<[string, Merge]> = [["full(旧全量)", full]];
    if (incr !== full) impls.push(["incr(增量)", incr]);
    for (const [name, fn] of impls) {
      const r = runScenario(fn, n, scenario, iterations);
      console.log(
        `${name.padEnd(12)}  ${scenario.padEnd(6)}  ${String(n).padStart(6)}  ${fmt(r.total.median)}  ${fmt(r.total.p95)}  ${fmt(r.merge.median)}  ${fmt(r.upsert.median)}`,
      );
    }
  }
}
