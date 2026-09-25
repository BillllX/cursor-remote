#!/usr/bin/env node
// P8 slim_state / load_chat 分页冒烟（本地 dev gateway）。
// 用法: node scripts/slim-smoke.mjs   （默认连 127.0.0.1:8787，token 同 resume-smoke）
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const WS_URL = process.env.JIEBO_WS_URL || "ws://127.0.0.1:8787/bridge";
const TOKEN = process.env.CURSOR_REMOTE_TOKEN || "73dk2DLV9j";
const chatId = `slim-smoke-${randomUUID().slice(0, 8)}`;
const TURNS = 95; // 40/页 → 3 页（55..94, 15..54, 0..14）
const BIG = "巨".repeat(300_000); // ~900KB 单 turn，超 80% 帧预算 → 应被 clip

let failed = 0;
function step(ok, label, extra = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
}

// 一条 WS 连接的迷你客户端：inbox + 游标等待 + rev 跟踪（sync_chat 要求 clientRev >= disk.rev）
function client(name, caps, maxMessageBytes = 64 * 1024 * 1024) {
  const inbox = [];
  let cursor = 0;
  let stateRev = 0;
  const ws = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      inbox.push(m);
      if (typeof m.rev === "number" && m.rev > stateRev) stateRev = m.rev;
    } catch {}
  });
  const send = (msg) => ws.send(JSON.stringify(msg));
  function waitFor(pred, label, timeoutMs = 15_000) {
    const from = cursor;
    const idx0 = inbox.findIndex((m, i) => i >= from && pred(m));
    if (idx0 >= 0) { cursor = idx0 + 1; return Promise.resolve(inbox[idx0]); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`超时: ${label}`)); }, timeoutMs);
      function scan() {
        for (let i = Math.max(from, cursor); i < inbox.length; i += 1) {
          if (pred(inbox[i])) { cursor = i + 1; cleanup(); resolve(inbox[i]); return; }
        }
      }
      function cleanup() { clearTimeout(timer); ws.off("message", onData); }
      function onData() { scan(); }
      ws.on("message", onData);
    });
  }
  const hello = async () => {
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    send({ type: "hello", token: TOKEN, client: { name, maxMessageBytes, caps } });
    await waitFor((m) => m.type === "ready", `${name} ready`);
    // 首帧 stored_state 带当前 rev（sync_chat 的 clientRev 必须 >= disk.rev）
    const ss = await waitFor((m) => m.type === "stored_state" || m.type === "stored_digest", `${name} 首帧状态`);
    return ss;
  };
  // sync_chat + 等 ack；被拒（rev 落后 → 回状态帧）时刷新 rev 重试一次
  const syncChat = async (chat, label) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      stateRev += 1;
      send({ type: "sync_chat", chat, rev: stateRev });
      const got = await waitFor(
        (m) => m.type === "sync_ack" || m.type === "stored_state" || m.type === "stored_digest",
        `${label} ack`,
      );
      if (got.type === "sync_ack") return got;
    }
    throw new Error(`${label} sync_chat 连续被拒`);
  };
  return { ws, send, waitFor, hello, syncChat, inbox };
}

const makeTurns = () => {
  const turns = [];
  for (let i = 0; i < TURNS; i += 1) {
    turns.push({ id: `t${i}`, user: `问题 ${i}`, assistant: `回答 ${i}`, thinking: "", tools: [] });
  }
  turns.push({ id: "big", user: BIG, assistant: "大附件回执", thinking: "", tools: [] });
  return turns;
};

async function main() {
  console.log(`目标 ${WS_URL}，会话 ${chatId}（${TURNS} 普通 turn + 1 巨 turn）`);

  // 0. 播种：全量客户端 sync_chat 写入 96 条 turns
  const seed = client("seed", ["sync_chat", "stored_digest"]);
  await seed.hello();
  await seed.syncChat({ id: chatId, title: "分页冒烟", turns: makeTurns(), draft: "", mode: "agent", policy: "baseline" }, "seed");
  step(true, "播种 96 条 turns");

  // 1. slim 客户端：stored_state 非空会话无 turns 键、有 preview；空会话保留 turns:[]
  //（slim 连接声明 1MB 上限——贴近 iOS 真实值，load_chat 的 80% 帧预算才能逼出巨 turn 的 clip）
  const slim2 = client("slim2", ["sync_chat", "stored_digest", "slim_state"], 1_048_576);
  const ss = await slim2.hello();
  const emptyId = `slim-empty-${randomUUID().slice(0, 8)}`;
  await slim2.syncChat({ id: emptyId, title: "新对话", turns: [], draft: "", mode: "agent", policy: "baseline" }, "empty");
  // 再开一条 slim 连接拿包含空会话的最新 stored_state
  const slim3 = client("slim3", ["sync_chat", "stored_digest", "slim_state"]);
  const ss2 = await slim3.hello();
  const rows = ss2.type === "stored_state" ? ss2.chats : null;
  const row = rows?.find((c) => c && c.id === chatId);
  const emptyRow = rows?.find((c) => c && c.id === emptyId);
  step(!!row && !("turns" in row), "slim stored_state：非空会话剥掉 turns 键");
  step(!!row && typeof row.preview === "string" && row.preview.length > 0 && row.preview.length <= 120,
    "slim stored_state：补 preview 摘要（≤120 字）", `len=${row?.preview?.length}`);
  step(!!emptyRow && Array.isArray(emptyRow.turns) && emptyRow.turns.length === 0, "slim stored_state：真空会话保留 turns:[]");

  // 2. load_chat 分页：末页 → 向前翻到底（共 96 条：40 + 40 + 16；巨 turn 在末页）
  slim2.send({ type: "load_chat", chatId });
  const p1 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId, "page1");
  step(p1.turns.length === 40 && p1.from === TURNS + 1 - 40 && p1.hasMore === true && p1.total === TURNS + 1,
    "load_chat 末页 40 条", `from=${p1.from} hasMore=${p1.hasMore} total=${p1.total}`);
  // 巨 turn 是最后一条（turns[95]）：应被 clip 且体积远小于原文
  const big = p1.turns.find((t) => t && t.id === "big");
  step(!!big && big.clipped === true && String(big.user || "").length < BIG.length / 4,
    "巨 turn 被 clipped 截断", big ? `len=${String(big.user || "").length} clipped=${big.clipped}` : "缺 big");
  slim2.send({ type: "load_chat", chatId, from: p1.from });
  const p2 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from < p1.from, "page2");
  step(p2.turns.length === 40 && p2.from === TURNS + 1 - 80 && p2.hasMore === true, "load_chat 第二页", `from=${p2.from}`);
  slim2.send({ type: "load_chat", chatId, from: p2.from });
  const p3 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from < p2.from, "page3");
  step(p3.from === 0 && p3.hasMore === false, "load_chat 到底 hasMore=false", `from=${p3.from} n=${p3.turns.length}`);

  // 3. sync_chat 不写 turns 键 → 服务端 turns 保留（元数据改名）
  await slim2.syncChat({ id: chatId, title: "分页冒烟·改名", draft: "", mode: "agent", policy: "baseline" }, "rename");
  slim2.send({ type: "load_chat", chatId });
  const after = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId, "load after rename");
  step(after.total === TURNS + 1, "sync_chat 缺 turns 键：服务端正文保留", `total=${after.total}`);

  // 4. sync_chat 带 clipped turn（混在全量 turns 里，对齐 iOS 真实回推）→ 按 id 回退服务端完整版
  const withClipped = makeTurns().map((t) => (t.id === "big" ? { id: "big", clipped: true, user: "截断残片", assistant: "", thinking: "", tools: [] } : t));
  await slim2.syncChat({ id: chatId, title: "分页冒烟·改名", turns: withClipped, draft: "", mode: "agent", policy: "baseline" }, "clipped");

  // 5. 非 slim 客户端全量校验：turns 在、big 是完整原文、标题是改名后
  //（maxMessageBytes 给 64MB：全量含 900KB 巨 turn，1MB 会触发 stored_state_deferred 回落）
  const fs = await (async () => {
    const ws = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
    const inbox = [];
    ws.on("message", (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch {} });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", token: TOKEN, client: { name: "full", maxMessageBytes: 64 * 1024 * 1024, caps: ["sync_chat"] } }));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const hit = inbox.find((m) => m.type === "stored_state");
      if (hit) { ws.close(); return hit; }
      await new Promise((r) => setTimeout(r, 50));
    }
    ws.close();
    throw new Error("full stored_state 超时");
  })();
  const frow = (fs.chats || []).find((c) => c && c.id === chatId);
  const fbig = frow?.turns?.find((t) => t && t.id === "big");
  step(!!frow && Array.isArray(frow.turns) && frow.turns.length === TURNS + 1, "非 slim 客户端仍拿全量 turns", `n=${frow?.turns?.length}`);
  step(frow?.title === "分页冒烟·改名", "元数据改名已落盘");
  step(!!fbig && fbig.user === BIG, "clipped turn 回退保护：服务端仍是完整原文", fbig ? `len=${String(fbig.user).length}` : "缺 big");

  // 6. HTTP /state?slim=1
  const res = await fetch(WS_URL.replace(/^ws/, "http").replace(/\/bridge$/, "/state?slim=1"), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const http = await res.json();
  const hrow = (http.chats || []).find((c) => c && c.id === chatId);
  step(res.ok && !!hrow && !("turns" in hrow) && typeof hrow.preview === "string", "HTTP /state?slim=1 同样剥 turns 补 preview");

  // 清场：删掉冒烟会话
  for (const c of [seed, slim2, slim3]) {
    try { c.send({ type: "delete_session", chatId }); c.send({ type: "delete_session", chatId: emptyId }); } catch {}
    c.ws.close();
  }
  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("冒烟异常:", err.message); process.exit(1); });
