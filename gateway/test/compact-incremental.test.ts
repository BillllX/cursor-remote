// mergeAndCompactChat 增量实现 vs 旧全量实现（mergeAndCompactChatFull）的逐字段等价性测试。
// 每一步都对比 deepStrictEqual（含 hit 计数），并把输入深冻结，顺带证明没有原地改输入。
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { mergeUploadedTurns, upsertTranscriptTurn, type RunTool, type RunTranscript } from "../src/runlog.ts";
import { mergeAndCompactChat, mergeAndCompactChatFull } from "../src/sync/storedState.ts";

type Rec = Record<string, unknown>;
type Chat = { id: string; title: string; turns: unknown[]; [key: string]: unknown };

// ---------- 工具函数 ----------

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as object)) deepFreeze(item, seen);
  return Object.freeze(value);
}

/** 同一输入各跑一次全量与增量，输出与 hit 必须完全一致；返回增量输出 */
function both(prev: unknown, next: unknown, note: string): Chat {
  deepFreeze(prev);
  deepFreeze(next);
  const hitF = { n: 0 };
  const hitI = { n: 0 };
  const full = mergeAndCompactChatFull(prev, next, hitF);
  const incr = mergeAndCompactChat(prev, next, hitI);
  assert.deepStrictEqual(incr, full, `输出不等价：${note}`);
  assert.equal(hitI.n, hitF.n, `hit 计数不一致：${note}`);
  return incr as Chat;
}

/** 冷缓存对照：深拷贝后引用关系全断，增量实现只能走逐回合重算 */
function cold(prev: unknown, next: unknown, note: string) {
  const hitF = { n: 0 };
  const hitI = { n: 0 };
  const full = mergeAndCompactChatFull(prev, next, hitF);
  const incr = mergeAndCompactChat(structuredClone(prev), structuredClone(next), hitI);
  assert.deepStrictEqual(incr, full, `冷缓存输出不等价：${note}`);
  assert.equal(hitI.n, hitF.n, `冷缓存 hit 不一致：${note}`);
}

function big(n: number, tag = "x") {
  return tag.repeat(n);
}

function tool(callId: string, extra: Rec = {}): Rec {
  return { callId, name: "Shell", args: { command: "echo" }, result: { stdout: "ok" }, ...extra };
}

function turn(id: string, extra: Rec = {}): Rec {
  return { id, user: `问 ${id}`, assistant: `答 ${id}`, tools: [], ...extra };
}

function chatOf(turns: unknown[], extra: Rec = {}): Chat {
  return { id: "c1", title: "t", turns, ...extra };
}

function transcriptOf(turnId: string, tools: RunTool[] = [], extra: Partial<RunTranscript> = {}): RunTranscript {
  return {
    turnId,
    userText: `问 ${turnId}`,
    assistant: "进行中",
    thinking: "",
    tools,
    phase: "running",
    epoch: 1,
    startedAt: 1,
    ...extra,
  };
}

/** 模拟 flushTranscript：upsert 后套一层 runMark，再交给 merge */
function flushNext(chat: Chat, transcript: RunTranscript): Chat {
  return { ...chat, turns: upsertTranscriptTurn(chat.turns, transcript), runMark: { turnId: transcript.turnId } };
}

// ---------- 构造用例 ----------

test("transcript 的新 turnId 不覆盖同文案旧回合，只迁移旧客户端的运行中占位", () => {
  const finished = turn("old", {
    user: "部署到上海站",
    assistant: "上一次部署结果",
    running: false,
    status: "finished",
  });
  const transcript = transcriptOf("new", [], {
    userText: "部署到上海站",
    assistant: "本次部署结果",
  });
  const appended = upsertTranscriptTurn([finished], transcript) as Rec[];
  assert.equal(appended.length, 2);
  assert.equal(appended[0], finished);
  assert.equal(appended[1].id, "new");
  assert.equal(appended[1].assistant, "本次部署结果");

  const optimistic = turn("local-temp", {
    user: "部署到上海站",
    assistant: "",
    running: true,
    queued: true,
  });
  const migrated = upsertTranscriptTurn([finished, optimistic], transcript) as Rec[];
  assert.equal(migrated.length, 2);
  assert.equal(migrated[0], finished);
  assert.equal(migrated[1].id, "new");
  assert.equal(migrated[1].assistant, "本次部署结果");
  assert.equal(migrated[1].queued, false);
});

test("旧设备上传同文案旧回合时，不能覆盖或清除新 turnId 的运行水位", () => {
  const old = turn("old", {
    user: "部署到上海站",
    assistant: "旧部署完成",
    status: "finished",
  });
  const current = turn("new", {
    user: "部署到上海站",
    assistant: "新部署完成",
    status: "finished",
  });
  const mark = {
    turnId: "new",
    assistantChars: "新部署完成".length,
    thinkingChars: 0,
    phase: "done" as const,
    status: "finished",
    userText: "部署到上海站",
  };
  const result = mergeUploadedTurns([old, current], [structuredClone(old)], mark);
  assert.deepEqual(
    (result.turns as Rec[]).map((item) => item.id),
    ["old", "new"],
  );
  assert.equal(result.clearMark, false);

  const staleUnknownId = { ...structuredClone(old), id: "old-device-copy" };
  const againstRunning = mergeUploadedTurns(
    [old, { ...current, running: true, status: undefined }],
    [staleUnknownId],
    { ...mark, phase: "running" },
  );
  assert.deepEqual(
    (againstRunning.turns as Rec[]).map((item) => item.id),
    ["old-device-copy", "new"],
  );
});

test("首次无缓存：prev 为空/无 turns/非对象", () => {
  const next = chatOf([turn("a", { tools: [tool("k1", { keepBody: true, args: undefined })] })]);
  both(undefined, next, "prev undefined");
  both(null, next, "prev null");
  both({ id: "c1" }, next, "prev 无 turns");
  both({ id: "c1", turns: "oops" }, next, "prev turns 非数组");
  both(chatOf([]), next, "prev 空数组");
  both(chatOf([]), chatOf([]), "next 空");
  assert.equal(mergeAndCompactChat(undefined, "str"), "str");
  assert.equal(mergeAndCompactChat(undefined, null), null);
  const noTurns = { id: "x" };
  assert.equal(mergeAndCompactChat(undefined, noTurns), noTurns);
});

test("工具正文截断：字符串 / 超 400 的数组 / 深层嵌套，且二次压缩幂等", () => {
  const t = turn("a", {
    tools: [
      tool("k1", { args: { content: big(30_000) }, result: { stdout: big(25_000, "y") } }),
      tool("k2", { result: Array.from({ length: 500 }, (_, i) => ({ i, text: big(26_000) })) }),
      tool("k3", { args: { a: { b: { c: { d: { e: { f: { g: { h: big(30_000) } } } } } } } } }),
    ],
  });
  const out = both(undefined, chatOf([t]), "首次截断");
  // 再压一遍（prev 是上次产出）：增量路径应沿用，结果仍与全量等价，且没有新增截断
  const again = { ...out, turns: out.turns.slice() };
  const hitI = { n: 0 };
  const res = mergeAndCompactChat(out, again, hitI) as Chat;
  assert.equal(hitI.n, 0, "已截断的回合不应再次命中截断");
  assert.deepStrictEqual(res, mergeAndCompactChatFull(out, again));
  assert.equal(res.turns[0], out.turns[0], "同位置同引用的已压缩回合应原样沿用");
});

test("旧客户端工具字段补回：keepBody 的 args/result、review、at", () => {
  const disk = chatOf([
    turn("a", {
      tools: [
        tool("k1", { at: 11, review: "accepted", args: { p: 1 }, result: { r: 1 } }),
        tool("k2", { at: 22, review: "rejected" }),
      ],
    }),
    turn("b", { tools: [tool("k3", { at: 33 })] }),
  ]);
  const prev = both(undefined, disk, "先落盘一份");
  // 旧客户端上传：没有 at、没有 review、keepBody 且不带正文
  const upload = chatOf([
    turn("a", {
      tools: [
        { callId: "k1", name: "Edit", keepBody: true },
        { callId: "k2", name: "Edit", keepBody: true, review: "" },
      ],
    }),
    turn("b", { tools: [{ callId: "k3", name: "Shell", review: null }] }),
    turn("c", { tools: [{ callId: "k9", name: "Shell", keepBody: true }] }),
  ]);
  const out = both(prev, upload, "旧客户端上传");
  const a = out.turns[0] as { tools: Rec[] };
  assert.equal(a.tools[0].review, "accepted");
  assert.equal(a.tools[0].at, 11);
  assert.deepEqual(a.tools[0].args, { p: 1 });
  assert.equal((out.turns[1] as { tools: Rec[] }).tools[0].at, 33);
  cold(prev, upload, "旧客户端上传（冷）");
});

test("review 保留：跨回合重复 callId 时，旧表里最后一个同 callId 决定", () => {
  const prevRaw = chatOf([
    turn("a", { tools: [tool("dup", { review: "accepted" })] }),
    turn("b", { tools: [tool("dup", { review: "rejected" }), tool("solo")] }),
    turn("c", { tools: [tool("dup")] }),
  ]);
  const prev = both(undefined, prevRaw, "含重复 callId 的首次");
  // 当前回合 d 复用 dup：旧表里最后一个 dup（回合 c）没有 review，不应补
  const next1 = flushNext(prev, transcriptOf("d", [{ callId: "dup", name: "Shell" } as RunTool]));
  const o1 = both(prev, next1, "重复 callId，最后一个没 review");
  assert.equal(((o1.turns[3] as { tools: Rec[] }).tools[0] as Rec).review, undefined);
  // 把 c 里的 dup 标成 accepted 后，新的同 callId 且 review 为空的工具要被补上
  const prev2 = both(
    prev,
    {
      ...prev,
      turns: [
        prev.turns[0],
        prev.turns[1],
        { ...(prev.turns[2] as Rec), tools: [tool("dup", { review: "accepted" })] },
      ],
    },
    "c 标记 accepted",
  );
  const o2 = both(
    prev2,
    flushNext(prev2, transcriptOf("d", [{ callId: "dup", name: "Shell" } as RunTool])),
    "重复 callId，最后一个有 review",
  );
  assert.equal(((o2.turns[3] as { tools: Rec[] }).tools[0] as Rec).review, "accepted");
  // 旧回合里 review 为空但 callId 与「别的回合已 accepted 的」重复：增量沿用判断必须核对
  const prev3 = both(
    undefined,
    chatOf([turn("a", { tools: [tool("z")] }), turn("b", { tools: [tool("z", { review: "accepted" })] })]),
    "z 重复",
  );
  both(prev3, { ...prev3, turns: prev3.turns.slice() }, "重复 callId 下旧回合再次压缩");
});

test("files 补回：缺键补回、带键以上传为准、同 id 才补", () => {
  const files = [{ path: "a.ts", status: "modified" }];
  const prev = both(undefined, chatOf([turn("a", { files }), turn("b", { files: [] }), turn("c")]), "带 files 落盘");
  const upload = chatOf([
    turn("a"), // 缺键 → 补回
    turn("b"), // 磁盘 files 为空 → 不补
    turn("c", { files: [{ path: "n.ts" }] }), // 带键 → 以上传为准
    turn("d"),
  ]);
  const out = both(prev, upload, "files 补回");
  assert.deepEqual((out.turns[0] as Rec).files, files);
  assert.equal("files" in (out.turns[1] as Rec), false);
  // 同位置同引用沿用时，files 表变化也要被感知：把一个没压缩过的引用换成缺 files 的新对象
  const withNew = { ...prev, turns: [{ id: "a", user: "x", tools: [] }, ...prev.turns.slice(1)] };
  const out2 = both(prev, withNew, "非末轮缺 files 被替换");
  assert.deepEqual((out2.turns[0] as Rec).files, files);
  cold(prev, upload, "files 补回（冷）");
});

test("图片淘汰：KEEP_TURN_IMAGES 边界随回合数右移，逐轮追加都与全量一致", () => {
  const img = [{ data: "d", mimeType: "image/png" }];
  let chat = both(
    undefined,
    chatOf(Array.from({ length: 24 }, (_, i) => turn(`t${i}`, { images: img, tools: [tool(`k${i}`)] }))),
    "起始 24 轮",
  );
  for (let i = 24; i < 60; i += 1) {
    const next = flushNext(
      chat,
      transcriptOf(`t${i}`, [{ callId: `k${i}`, name: "Shell" } as RunTool], { images: img }),
    );
    const before = chat.turns.slice();
    chat = both(chat, next, `追加第 ${i} 轮`);
    // 边界之前的全部没图；之后的保留
    const boundary = chat.turns.length - 20;
    chat.turns.forEach((t, at) => assert.equal("images" in (t as Rec), at >= boundary, `第 ${at} 轮图片`));
    // 没跨边界的旧回合应沿用同一对象
    for (let at = 0; at < boundary - 1; at += 1) assert.equal(chat.turns[at], before[at], `第 ${at} 轮应沿用`);
  }
});

test("更新非末轮（按 turnId）、更新后再追加", () => {
  const img = [{ data: "d", mimeType: "image/png" }];
  let chat = both(
    undefined,
    chatOf(
      Array.from({ length: 30 }, (_, i) =>
        turn(`t${i}`, { images: img, tools: [tool(`k${i}`, { at: i, review: i % 2 ? "accepted" : undefined })] }),
      ),
    ),
    "起始",
  );
  // 更新第 3 轮（已淘汰图片区）：带一个新工具，且复用旧回合 k3
  const upd = flushNext(
    chat,
    transcriptOf("t3", [{ callId: "k3", name: "Shell" } as RunTool, { callId: "nk", name: "Read" } as RunTool], {
      images: img,
    }),
  );
  chat = both(chat, upd, "更新第 3 轮");
  assert.equal(
    ((chat.turns[3] as Rec).images as unknown[] | undefined)?.length ?? 0,
    0,
    "第 3 轮在边界之前，图片应被淘汰",
  );
  assert.equal(chat.turns.length, 30);
  // 更新第 25 轮（边界之内）
  const upd2 = flushNext(chat, transcriptOf("t25", [], { images: img, assistant: "新的回答" }));
  chat = both(chat, upd2, "更新第 25 轮");
  assert.ok("images" in (chat.turns[25] as Rec));
  // 没有 id 命中时按用户原文配对
  const upd3 = flushNext(chat, { ...transcriptOf("zzz"), userText: "问 t7" });
  both(chat, upd3, "按用户原文配对更新");
  // 再追加
  both(chat, flushNext(chat, transcriptOf("t30", [{ callId: "k30", name: "Shell" } as RunTool])), "更新后追加");
});

test("会话回合数减少（truncate_turns）、删除中间回合、重排", () => {
  const img = [{ data: "d", mimeType: "image/png" }];
  const chat = both(
    undefined,
    chatOf(
      Array.from({ length: 40 }, (_, i) =>
        turn(`t${i}`, {
          images: img,
          tools: [tool(`k${i}`, { at: i })],
          files: i % 3 ? undefined : [{ path: `${i}` }],
        }),
      ),
    ),
    "起始 40 轮",
  );
  const cut = both(chat, { ...chat, turns: chat.turns.slice(0, 10) }, "截到 10 轮");
  assert.equal(cut.turns.length, 10);
  // 在截断后的会话上继续追加
  const grown = both(
    cut,
    flushNext(cut, transcriptOf("t10", [{ callId: "k10", name: "Shell" } as RunTool])),
    "截断后追加",
  );
  assert.equal(grown.turns.length, 11);
  both(chat, { ...chat, turns: chat.turns.slice(0, 35) }, "截到 35 轮（边界左移）");
  const dropMid = chat.turns.filter((_, i) => i !== 5 && i !== 20);
  both(chat, { ...chat, turns: dropMid }, "删除中间两轮（位置整体错位）");
  both(chat, { ...chat, turns: chat.turns.slice().reverse() }, "整体反转");
  both(chat, { ...chat, turns: [] }, "清空");
  // 同一个数组先 A→B 后又从 A 出发 A→C：索引转走后重建，仍然等价
  both(chat, { ...chat, turns: chat.turns.slice(0, 20) }, "分叉 B");
  both(chat, { ...chat, turns: chat.turns.slice(0, 30) }, "分叉 C");
});

test("prev === next（启动时 compactTenantChats 的调用方式）", () => {
  const raw = chatOf(
    Array.from({ length: 8 }, (_, i) => turn(`t${i}`, { tools: [tool(`k${i}`, { args: { c: big(30_000) } })] })),
  );
  const first = both(raw, raw, "自己压自己");
  both(first, first, "再压一次");
});

test("产出被丢弃（如 review 无变化时 compacted 不采用）后，用旧会话继续仍然等价", () => {
  const base = both(
    undefined,
    chatOf(Array.from({ length: 12 }, (_, i) => turn(`t${i}`, { tools: [tool(`k${i}`)] }))),
    "起始",
  );
  // 算出但不采用
  mergeAndCompactChat(base, flushNext(base, transcriptOf("t2", [{ callId: "x", name: "S" } as RunTool])));
  mergeAndCompactChat(base, flushNext(base, transcriptOf("t4", [{ callId: "y", name: "S" } as RunTool])));
  const out = both(base, flushNext(base, transcriptOf("t6", [{ callId: "z", name: "S" } as RunTool])), "丢弃后继续");
  both(out, flushNext(out, transcriptOf("t11", [])), "再继续");
});

test("同一旧会话派生出两份产出：先用 A1、再用 A2 作 prev，A2 的索引不能被 A1 污染", () => {
  const base = both(
    undefined,
    chatOf(Array.from({ length: 10 }, (_, i) => turn(`t${i}`, { tools: [tool(`k${i}`)] }))),
    "起始",
  );
  const mark = (id: string, callId: string) =>
    ({
      ...base,
      turns: base.turns.map((t) =>
        (t as Rec).id === id ? { ...(t as Rec), tools: [tool(callId, { review: "accepted" })] } : t,
      ),
    }) as Chat;
  const a1 = both(base, mark("t2", "x"), "A1");
  const a2 = both(base, mark("t4", "y"), "A2");
  // 先把 A1 当 prev（惰性增量在这里应用，索引从 base 转到 A1）
  both(a1, flushNext(a1, transcriptOf("t9", [{ callId: "x", name: "S" } as RunTool])), "用 A1");
  // 再用 A2：y 的 review 必须从 A2 自己的索引补回，x 不应出现
  const out = both(
    a2,
    flushNext(a2, transcriptOf("t9", [{ callId: "y", name: "S" } as RunTool, { callId: "x", name: "S" } as RunTool])),
    "用 A2",
  );
  const tools = (out.turns[9] as { tools: Rec[] }).tools;
  assert.equal(tools[0].review, "accepted");
  assert.equal(tools[1].review, undefined);
});

test("非常规回合：null / 字符串 / 无 id / 重复 id / 非数组 tools / 非对象工具", () => {
  const raw = chatOf([
    null,
    "oops",
    { user: "无 id", tools: [tool("k1", { at: 1 })] },
    turn("dup", { tools: [tool("k2", { at: 2 }), null, "x", [], { name: "无 callId" }] }),
    turn("dup", { tools: [tool("k2"), tool("k3", { keepBody: true, args: undefined })], files: [{ path: "a" }] }),
    turn("w", { tools: "not-array" }),
    turn("v", { tools: [tool("k2", { review: "accepted" }), tool("", { at: 5 })] }),
  ]);
  const prev = both(undefined, raw, "非常规首次");
  const next = { ...prev, turns: prev.turns.map((t, i) => (i === 4 ? { ...(t as Rec), id: "dup" } : t)) };
  both(prev, next, "非常规再压");
  both(prev, flushNext(prev, transcriptOf("dup", [{ callId: "k2", name: "S" } as RunTool])), "非常规 upsert");
});

// ---------- 随机对拍 ----------

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const chance = (p: number) => next() < p;
  const pick = <T>(items: T[]) => items[int(items.length)];
  return { next, int, chance, pick };
}

type R = ReturnType<typeof rng>;

function randomTool(r: R, callPool: number): unknown {
  const roll = r.next();
  if (roll < 0.03) return null;
  if (roll < 0.05) return "stray";
  const t: Rec = { name: r.pick(["Shell", "Read", "Write", "Edit"]) };
  const c = r.next();
  if (c < 0.88) t.callId = `c${r.int(callPool)}`;
  else if (c < 0.94) t.callId = "";
  if (r.chance(0.6)) t.at = r.int(1000);
  if (r.chance(0.85)) t.args = { command: "echo", content: r.chance(0.05) ? big(25_000, "a") : "short" };
  if (r.chance(0.85)) {
    t.result = r.chance(0.04)
      ? Array.from({ length: 450 }, (_, i) => ({ i }))
      : { stdout: r.chance(0.05) ? big(26_000, "b") : "ok", stderr: "" };
  }
  if (r.chance(0.3)) t.review = r.pick([undefined, null, "", "accepted", "rejected", "weird"]);
  if (r.chance(0.12)) {
    t.keepBody = true;
    if (r.chance(0.7)) {
      delete t.args;
      delete t.result;
    }
  }
  if (r.chance(0.03)) t.keepBody = "yes";
  return t;
}

function randomTurn(r: R, idx: number, callPool: number): unknown {
  const roll = r.next();
  if (roll < 0.015) return null;
  if (roll < 0.03) return "junk";
  const t: Rec = { user: `问 ${r.int(40)}`, assistant: r.chance(0.2) ? "" : "答".repeat(1 + r.int(5)) };
  const id = r.next();
  if (id < 0.8) t.id = `t${idx}`;
  else if (id < 0.9) t.id = `t${r.int(idx + 1)}`; // 重复 id
  if (r.chance(0.75)) {
    t.tools = Array.from({ length: r.int(5) }, () => randomTool(r, callPool));
  } else if (r.chance(0.1)) {
    t.tools = "bad";
  }
  if (r.chance(0.4)) t.images = [{ data: "d", mimeType: "image/png" }];
  if (r.chance(0.3)) t.files = r.chance(0.2) ? [] : [{ path: `f${r.int(9)}` }];
  if (r.chance(0.2)) t.startedAt = r.int(100);
  return t;
}

function randomChat(r: R, n: number, callPool: number): Chat {
  return chatOf(Array.from({ length: n }, (_, i) => randomTurn(r, i, callPool)));
}

/** 模拟旧客户端整段上传：在 prev 回合基础上做各种「掉字段」的改写 */
function legacyUpload(r: R, prev: Chat): Chat {
  const turns = prev.turns.map((t) => {
    if (!t || typeof t !== "object" || r.chance(0.5)) return t;
    const row = { ...(t as Rec) };
    if (r.chance(0.4)) delete row.files;
    if (r.chance(0.2)) delete row.images;
    if (Array.isArray(row.tools)) {
      row.tools = row.tools.map((x) => {
        if (!x || typeof x !== "object" || r.chance(0.5)) return x;
        const rec = { ...(x as Rec) };
        if (r.chance(0.5)) delete rec.at;
        if (r.chance(0.3)) delete rec.review;
        if (r.chance(0.3)) {
          rec.keepBody = true;
          delete rec.args;
          delete rec.result;
        }
        return rec;
      });
    }
    return row;
  });
  if (r.chance(0.5)) turns.push(randomTurn(r, turns.length, 12));
  return { ...prev, turns };
}

function randomStep(r: R, chat: Chat, callPool: number): { prev: Chat; next: Chat; note: string } {
  const n = chat.turns.length;
  const op = r.int(11);
  const randomTools = (): RunTool[] =>
    Array.from({ length: r.int(4) }, () => {
      const t = randomTool(r, callPool) as Rec | null | string;
      return (
        t && typeof t === "object"
          ? { name: "S", ...t, keepBody: undefined }
          : { callId: `c${r.int(callPool)}`, name: "S" }
      ) as RunTool;
    });
  switch (op) {
    case 0:
    case 1: // 追加新回合
      return {
        prev: chat,
        next: flushNext(
          chat,
          transcriptOf(
            `n${r.int(1e6)}`,
            randomTools(),
            r.chance(0.3) ? { images: [{ data: "d", mimeType: "image/png" }] } : {},
          ),
        ),
        note: "追加",
      };
    case 2: // 更新末轮
      if (!n) return { prev: chat, next: chat, note: "空会话" };
      return {
        prev: chat,
        next: flushNext(chat, transcriptOf(String((chat.turns[n - 1] as Rec | null)?.id ?? "x"), randomTools())),
        note: "更新末轮",
      };
    case 3: {
      // 按 id 更新非末轮
      if (!n) return { prev: chat, next: chat, note: "空会话" };
      const target = chat.turns[r.int(n)] as Rec | null;
      const id = target && typeof target === "object" && typeof target.id === "string" ? target.id : "none";
      return {
        prev: chat,
        next: flushNext(
          chat,
          transcriptOf(id, randomTools(), r.chance(0.3) ? { images: [{ data: "d", mimeType: "image/png" }] } : {}),
        ),
        note: "更新非末轮",
      };
    }
    case 4: // 旧客户端整段上传
      return { prev: chat, next: legacyUpload(r, chat), note: "旧客户端上传" };
    case 5: // truncate_turns
      return { prev: chat, next: { ...chat, turns: chat.turns.slice(0, r.int(n + 1)) }, note: "截断" };
    case 6: {
      // 删除/重排一个回合
      const turns = chat.turns.slice();
      if (turns.length) turns.splice(r.int(turns.length), 1);
      if (turns.length > 1 && r.chance(0.5)) turns.reverse();
      return { prev: chat, next: { ...chat, turns }, note: "删除/重排" };
    }
    case 7: {
      // review 应用：替换某回合的工具并设 review
      const at = n ? r.int(n) : -1;
      const turns = chat.turns.map((t, i) => {
        if (i !== at || !t || typeof t !== "object" || !Array.isArray((t as Rec).tools)) return t;
        return {
          ...(t as Rec),
          tools: ((t as Rec).tools as unknown[]).map((x) =>
            x && typeof x === "object" ? { ...(x as Rec), review: r.pick(["accepted", "rejected", undefined, ""]) } : x,
          ),
        };
      });
      return { prev: chat, next: { ...chat, turns }, note: "review 应用" };
    }
    case 8: {
      // 未压缩的原始会话：prev 与 next 是同一份随机数据
      const raw = randomChat(r, r.int(30), callPool);
      return {
        prev: raw,
        next: r.chance(0.5) ? raw : { ...raw, turns: raw.turns.slice(0, -1) },
        note: "原始数据 prev",
      };
    }
    case 9: // 全新的无关 prev
      return {
        prev: randomChat(r, r.int(25), callPool),
        next: randomChat(r, r.int(25), callPool),
        note: "两份无关会话",
      };
    default: // 原样再压
      return { prev: chat, next: { ...chat, turns: chat.turns.slice() }, note: "原样" };
  }
}

test("随机对拍：多种操作混合，连续多步，增量缓存跟着产出滚动", () => {
  const seeds = 400;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const r = rng(seed * 7919);
    const callPool = r.pick([4, 12, 80, 5000]); // 小池=大量重复 callId，大池≈唯一
    let chat = both(undefined, randomChat(r, r.int(60), callPool), `seed ${seed} 起始`);
    for (let step = 0; step < 14; step += 1) {
      const { prev, next, note } = randomStep(r, chat, callPool);
      const label = `seed ${seed} step ${step} ${note}`;
      const out = both(prev, next, label);
      if (step % 3 === 0) cold(prev, next, label);
      // 大多数步骤沿用产出继续滚动（模拟真实的 flush 链），偶尔分叉回旧会话
      chat = r.chance(0.12) ? chat : out;
    }
  }
});

test("长链路：小池重复 callId + 200 轮 + 逐步追加更新，每步等价", () => {
  const r = rng(424242);
  let chat = both(undefined, randomChat(r, 200, 30), "起始 200 轮");
  for (let step = 0; step < 120; step += 1) {
    const n = chat.turns.length;
    const target = chat.turns[r.int(n)] as Rec | null;
    const id = r.chance(0.5) || !target || typeof target.id !== "string" ? `live${step % 7}` : target.id;
    const tools: RunTool[] = Array.from(
      { length: 1 + r.int(3) },
      () => ({ callId: `c${r.int(30)}`, name: "S", at: r.int(9) }) as RunTool,
    );
    chat = both(chat, flushNext(chat, transcriptOf(id, tools)), `长链路 step ${step}`);
  }
});

// ---------- 缓存不泄漏 ----------

test("缓存不泄漏：会话被丢弃后，回合对象与索引可被 GC", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  let refs: WeakRef<object>[] = [];
  (() => {
    let chat = mergeAndCompactChat(
      undefined,
      chatOf(Array.from({ length: 50 }, (_, i) => turn(`t${i}`, { tools: [tool(`k${i}`, { at: i })] }))),
    ) as Chat;
    for (let i = 0; i < 20; i += 1) {
      chat = mergeAndCompactChat(
        chat,
        flushNext(chat, transcriptOf(`t${i}`, [{ callId: `k${i}`, name: "S" } as RunTool])),
      ) as Chat;
    }
    refs = [
      new WeakRef(chat),
      new WeakRef(chat.turns),
      new WeakRef(chat.turns[3] as object),
      new WeakRef(chat.turns[49] as object),
    ];
  })();
  for (let i = 0; i < 6 && refs.some((ref) => ref.deref()); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    gc();
  }
  assert.deepEqual(
    refs.map((ref) => ref.deref() === undefined),
    [true, true, true, true],
    "丢弃会话后缓存仍持有回合/数组",
  );
});
