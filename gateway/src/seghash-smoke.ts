import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ServerMessage } from "../../shared/protocol.ts";
import {
  createBodyStore,
  hydrateChat,
  isBodyLoaded,
  persistBodies,
  SEGMENT_TURNS,
  segmentHashes,
  slimChat,
} from "./chatBodies.ts";
import { applyStreamEvent, clipSnapshot, keepToolsAt, mergeUploadedTurns, snapshotMessage, turnFromTranscript, type RunTranscript } from "./runlog.ts";

/**
 * 分段哈希与工具位置冒烟：segHashes 装回前后一致、只变改动的分段、不触发装回；
 * 工具 at 按开始时的正文长度记、完成后保留、旧客户端上传缺 at 时从磁盘补回。
 */

const root = mkdtempSync(resolve(tmpdir(), "seghash-smoke-"));
let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const makeTurns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, user: `问题 ${i}`, assistant: `回答 ${i} 😀`, tools: [] }));
const diffAt = (a: string[], b: string[]) => a.flatMap((hash, i) => (hash === b[i] ? [] : [i]));

try {
  // ---------- 分段哈希 ----------
  const identity = (turns: unknown[]) => turns;
  const stateDir = resolve(root, "state");
  const store = createBodyStore(stateDir, identity);
  const turns = makeTurns(250);
  const chat: Record<string, unknown> = { id: "c1", title: "分段", turns };
  const expected = [0, 1, 2].map((i) => sha1(JSON.stringify(turns.slice(i * SEGMENT_TURNS, (i + 1) * SEGMENT_TURNS))));

  const computed = segmentHashes(store, chat);
  check(same(computed, expected), "没写过盘：现算 sha1(JSON.stringify(分段))，250 条 3 段");
  const rows = persistBodies(store, [chat]);
  const body = (rows[0] as { body?: { segs: string[] } }).body;
  check(same(body?.segs, expected), "和写盘时的分段文件名一致");
  check(same(segmentHashes(store, chat), expected), "写盘后（按引用复用记录）不变");

  // 另一个进程读同一份 state：会话是没装回的壳
  const store2 = createBodyStore(stateDir, identity);
  const stub = hydrateChat(store2, structuredClone(rows[0])) as Record<string, unknown>;
  check(!isBodyLoaded(stub), "读盘后是没装回的壳");
  check(same(segmentHashes(store2, stub), expected), "没装回：用落盘描述，和装回时同一份哈希");
  const slimStub = slimChat(store2, stub) as Record<string, unknown>;
  check(!isBodyLoaded(stub), "segmentHashes / slimChat 不触发装回");
  check(
    same(slimStub.segHashes, expected) && !("turns" in slimStub) && typeof slimStub.preview === "string",
    "slimChat（壳）：带 segHashes、preview，没有 turns",
  );
  check((stub.turns as unknown[]).length === 250 && isBodyLoaded(stub), "读 turns 装回");
  check(same(segmentHashes(store2, stub), expected), "装回后哈希不变");
  check(same((slimChat(store2, stub) as { segHashes?: unknown }).segHashes, expected), "slimChat（已装回）：带 segHashes");

  // 改第 2 段里的一个 turn（换新对象）
  const changed = (stub.turns as Array<Record<string, unknown>>).slice();
  changed[210] = { ...changed[210], assistant: "改过了" };
  const c2 = { ...stub, turns: changed };
  const h2 = segmentHashes(store2, c2)!;
  check(same(diffAt(expected, h2), [2]), `改第 2 段一个 turn：只有 segHashes[2] 变 → ${JSON.stringify(diffAt(expected, h2))}`);
  check(h2[2] === sha1(JSON.stringify(changed.slice(200, 300))), "变了的那段按新内容现算");
  check(same(segmentHashes(store2, c2), h2), "重复调用结果一致（走缓存）");

  // 改第 1 段中间一个 turn：缓存键是段尾 turn，必须靠整段引用比对识破
  const mid = changed.slice();
  mid[150] = { ...mid[150], user: "中间改" };
  const h3 = segmentHashes(store2, { ...stub, turns: mid })!;
  check(same(diffAt(h2, h3), [1]), "改第 1 段中间一个 turn：只有 segHashes[1] 变");

  // 追加一条：只有最后一段变
  const appended = [...changed, { id: "t250", user: "追加", assistant: "", tools: [] }];
  const h4 = segmentHashes(store2, { ...stub, turns: appended })!;
  check(h4.length === 3 && same(diffAt(h2, h4), [2]), "追加一条：只有最后一段变");
  const full = makeTurns(300);
  const h300 = segmentHashes(store2, { id: "c9", turns: full })!;
  const h301 = segmentHashes(store2, { id: "c9", turns: [...full, { id: "x" }] })!;
  check(h301.length === 4 && same(h301.slice(0, 3), h300), "整段满了再追加：多出一段，前面不变");

  // 0 条 / 没有 turns 键
  check(segmentHashes(store, { id: "e", turns: [] }) === null, "0 条 → null");
  check(segmentHashes(store, { id: "e" }) === null, "没有 turns 键 → null");
  const slimEmpty = slimChat(store, { id: "e", title: "空", turns: [], draft: "x" }) as Record<string, unknown>;
  check(same(slimEmpty.turns, []) && !("segHashes" in slimEmpty) && !("draft" in slimEmpty), "slimChat 真空会话：turns:[]，没有 segHashes");
  check(Array.isArray(segmentHashes(store, { turns: makeTurns(3) })), "没有 id 的内联会话也能现算，不抛");
  check(segmentHashes(store, { id: "c1", turns: "坏数据" }) === null, "turns 不是数组 → null");

  // ---------- 工具位置 at ----------
  const transcript: RunTranscript = { turnId: "r1", userText: "跑一下", assistant: "", thinking: "", tools: [], phase: "running", epoch: 1 };
  const ev = (message: ServerMessage) => applyStreamEvent(transcript, message);
  ev({ type: "text-delta", chatId: "c", text: "先看😀" });
  ev({ type: "tool-started", chatId: "c", callId: "k1", name: "Read", args: { path: "a" } });
  check(transcript.tools[0].at === "先看😀".length && transcript.tools[0].at === 4, "tool-started 记 at = assistant 长度（UTF-16）");
  ev({ type: "text-delta", chatId: "c", text: "继续" });
  ev({ type: "tool-started", chatId: "c", callId: "k1", name: "Read", args: { path: "a", more: 1 } });
  check(transcript.tools[0].at === 4, "同一 callId 再次开始：保留第一次的 at");
  ev({ type: "tool-completed", chatId: "c", callId: "k1", name: "Read", status: "completed", result: "ok" });
  check(transcript.tools[0].at === 4 && transcript.tools[0].status === "completed", "tool-completed 后 at 还在");
  ev({ type: "tool-output", chatId: "c", callId: "k2", chunk: "x" });
  ev({ type: "tool-started", chatId: "c", callId: "k2", name: "Shell" });
  check(transcript.tools[1].at === "先看😀继续".length, "先有输出后开始：第一次开始时记 at");
  ev({ type: "tool-completed", chatId: "c", callId: "k3", name: "Write", status: "completed" });
  check(transcript.tools[2].at === undefined, "没开始过就完成的工具不编造 at");
  const written = turnFromTranscript(transcript) as { tools: Array<{ at?: number }> };
  check(written.tools[0].at === 4 && written.tools[1].at === 6, "落盘回合 tools[].at");
  const bigTools = transcript.tools.map((item) => ({ ...item, result: "长".repeat(5000) }));
  const snap = clipSnapshot(snapshotMessage("c", { ...transcript, tools: bigTools }, []), 2000);
  check(
    snap.type === "run_snapshot" && !snap.clipped && snap.tools?.[0]?.result === undefined && snap.tools?.[0]?.at === 4,
    "run_snapshot 裁掉工具正文时保留 at",
  );

  // 旧客户端上传缺 at
  const disk = [
    { id: "a", user: "第一问", assistant: "答", tools: [{ callId: "k0", name: "Read", status: "completed", at: 1 }] },
    { id: "b", user: "第二问", assistant: "答复", tools: [{ callId: "k1", name: "Read", status: "completed", at: 4 }] },
  ];
  const upload = [
    disk[0],
    { id: "b", user: "第二问", assistant: "更长的答复", tools: [{ callId: "k1", name: "Read", status: "completed", result: "r" }] },
  ];
  const merged = mergeUploadedTurns(disk, upload, null).turns as typeof disk;
  check(merged[1].assistant === "更长的答复" && merged[1].tools[0].at === 4, "mergeUploadedTurns：上传更长且缺 at，从磁盘补回");
  check(merged[0] === disk[0], "没缺 at 的回合原样保留引用");
  const shorter = mergeUploadedTurns(disk, [{ id: "b", user: "第二问", assistant: "", tools: [] }], null).turns as typeof disk;
  check(shorter[0].tools[0].at === 4, "mergeUploadedTurns：上传更短留用磁盘工具，at 在");
  const own = mergeUploadedTurns(disk, [{ ...upload[1], tools: [{ callId: "k1", name: "Read", status: "completed", at: 9 }] }], null)
    .turns as typeof disk;
  check(own[0].tools[0].at === 9, "上传自带 at 时以上传为准");
  // mergeAndCompactChat 用的就是 keepToolsAt（只认同 id 回合）
  type AtTurn = { tools: Array<{ at?: number }> };
  const kept = keepToolsAt(disk, [{ id: "a", user: "第一问", tools: [{ callId: "k0", name: "Read" }, { callId: "new", name: "Write" }] }]) as AtTurn[];
  check(kept[0].tools[0].at === 1 && !("at" in kept[0].tools[1]), "keepToolsAt：同 id 回合按 callId 补回，磁盘没有的不补");
  const untouched = [{ id: "b", tools: [{ callId: "k1", at: 2 }] }];
  check(keepToolsAt(disk, untouched)[0] === untouched[0], "keepToolsAt：已有 at 不覆盖、不换对象");
  const reused = [
    { id: "r1", user: "一", tools: [{ callId: "dup", name: "Read", status: "completed", at: 3 }] },
    { id: "r2", user: "二", tools: [{ callId: "dup", name: "Read", status: "completed", at: 17 }] },
  ];
  const reusedUp = keepToolsAt(reused, [
    { id: "r2", user: "二", tools: [{ callId: "dup", name: "Read" }] },
    { id: "r1", user: "一", tools: [{ callId: "dup", name: "Read" }] },
  ]) as AtTurn[];
  check(reusedUp[0].tools[0].at === 17 && reusedUp[1].tools[0].at === 3, "callId 跨回合复用：各回合补回自己的 at");
  const reusedMerged = mergeUploadedTurns(reused, [{ id: "r1", user: "一", assistant: "更长", tools: [{ callId: "dup", name: "Read" }] }], null)
    .turns as AtTurn[];
  check(reusedMerged[0].tools[0].at === 3, "mergeUploadedTurns：callId 复用时按回合 id 补回");
  const noIdTurn = { user: "一", tools: [{ callId: "dup", name: "Read" }] };
  const noId = keepToolsAt(reused, [noIdTurn]);
  check(noId[0] === noIdTurn && !("at" in (noId[0] as AtTurn).tools[0]), "没有 id 的回合不补 at、不换对象");
  const otherId = keepToolsAt(reused, [{ id: "r9", tools: [{ callId: "dup", name: "Read" }] }]) as AtTurn[];
  check(!("at" in otherId[0].tools[0]), "磁盘上没有同 id 回合：不从别的回合借 at");
} catch (err) {
  failed += 1;
  console.error("FAIL  冒烟脚本异常", err);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nseghash smoke: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
