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
  // sync_chat + 等 ack；被拒（rev 落后 → 回状态帧）时刷新 rev 重试（dev 租户上可能有别的客户端争用 rev）
  const syncChat = async (chat, label) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
  const ackSeed = await seed.syncChat({ id: chatId, title: "分页冒烟", turns: makeTurns(), draft: "", mode: "agent", policy: "baseline" }, "seed");
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
  step(!!row && typeof row.preview === "string" && row.preview.length > 0 && row.preview.length <= 100,
    "slim stored_state：补 preview 摘要（≤100 字）", `len=${row?.preview?.length}`);
  step(!!emptyRow && Array.isArray(emptyRow.turns) && emptyRow.turns.length === 0, "slim stored_state：真空会话保留 turns:[]");

  // 1b. slim 客户端 load_chats 仍回全量（digest 对账是跨设备 turns 更新唯一通道；Grok 评审 MINOR1 注释固化）
  //（用 slim3：slim2 的 1MB 上限装不下含巨 turn 的全量，会回落 deferred）
  slim3.send({ type: "load_chats", ids: [chatId] });
  const sc = await slim3.waitFor((m) => m.type === "stored_chat" && m.chat?.id === chatId, "slim load_chats");
  step(Array.isArray(sc.chat?.turns) && sc.chat.turns.length === TURNS + 1,
    "slim 客户端 load_chats 回全量 turns", `n=${sc.chat?.turns?.length}`);

  // 2. load_chat 分页：末页 → 向前翻到底（共 96 条：40 + 40 + 16；巨 turn 在末页）
  slim2.send({ type: "load_chat", chatId, nonce: 7 }); // nonce：分页代际标记，应原样回显（Kimi R2 M1）
  const p1 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId, "page1");
  step(p1.turns.length === 40 && p1.from === TURNS + 1 - 40 && p1.hasMore === true && p1.total === TURNS + 1,
    "load_chat 末页 40 条", `from=${p1.from} hasMore=${p1.hasMore} total=${p1.total}`);
  step(p1.nonce === 7, "chat_turns 回显 nonce（分页代际校验）", `nonce=${p1.nonce}`);
  // 巨 turn 是最后一条（turns[95]）：应被 clip 且体积远小于原文
  const big = p1.turns.find((t) => t && t.id === "big");
  step(!!big && big.clipped === true && String(big.user || "").length < BIG.length / 4,
    "巨 turn 被 clipped 截断", big ? `len=${String(big.user || "").length} clipped=${big.clipped}` : "缺 big");
  // 组页的核心保证：整页字节 ≤ 80% 接收上限（slim2 声明 1MB）
  const p1Bytes = Buffer.byteLength(JSON.stringify(p1));
  step(p1Bytes <= Math.floor(1_048_576 * 0.8), "页字节 ≤ 80% 帧预算", `${p1Bytes}B`);
  slim2.send({ type: "load_chat", chatId, from: p1.from });
  const p2 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from < p1.from, "page2");
  step(p2.turns.length === 40 && p2.from === TURNS + 1 - 80 && p2.hasMore === true, "load_chat 第二页", `from=${p2.from}`);
  slim2.send({ type: "load_chat", chatId, from: p2.from });
  const p3 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from < p2.from, "page3");
  step(p3.from === 0 && p3.hasMore === false, "load_chat 到底 hasMore=false", `from=${p3.from} n=${p3.turns.length}`);

  // 2b. from 边界（Grok 评审 MINOR4 盲区）：0/负数 → 空页 hasMore=false；超 total → 夹到末页
  slim2.send({ type: "load_chat", chatId, from: 0 });
  const b0 = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from === 0, "from=0");
  step(b0.turns.length === 0 && b0.hasMore === false, "from=0 → 空页终止", `n=${b0.turns.length} hasMore=${b0.hasMore}`);
  slim2.send({ type: "load_chat", chatId, from: -5 });
  const bn = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from === 0, "from=-5");
  step(bn.turns.length === 0 && bn.hasMore === false, "from 负数 → 夹到 0 空页", `n=${bn.turns.length}`);
  slim2.send({ type: "load_chat", chatId, from: 99999 });
  const bb = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId && m.from === TURNS + 1 - 40, "from=99999");
  step(bb.turns.length === 40 && bb.hasMore === true, "from 超 total → 夹到末页", `from=${bb.from} n=${bb.turns.length}`);

  // 3. sync_chat 不写 turns 键 → 服务端 turns 保留（元数据改名）
  const ackRename = await slim2.syncChat({ id: chatId, title: "分页冒烟·改名", draft: "", mode: "agent", policy: "baseline" }, "rename");
  slim2.send({ type: "load_chat", chatId });
  const after = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId, "load after rename");
  step(after.total === TURNS + 1, "sync_chat 缺 turns 键：服务端正文保留", `total=${after.total}`);
  step(typeof ackRename.chatRevs?.[chatId] === "number" && ackRename.chatRevs[chatId] > (ackSeed.chatRevs?.[chatId] ?? 0),
    "真变更 sync 前进 chatRevs", `seed=${ackSeed.chatRevs?.[chatId]} rename=${ackRename.chatRevs?.[chatId]}`);

  // 4. sync_chat 带 clipped turn（混在全量 turns 里，对齐 iOS 真实回推）→ 按 id 回退服务端完整版；
  //    服务端没有的 clipped id（幽灵残片）直接丢弃，不把截断占位落盘（GLM 评审 M1）。
  //    回退/丢弃后内容与磁盘一致 → changed=false → chatRevs 不前进（无变化 sync 不 bump，
  //    否则其他端重连会把纯元数据脏误判成正文变更而整会话作废重载）
  const withClipped = [
    ...makeTurns().map((t) => (t.id === "big" ? { id: "big", clipped: true, user: "截断残片", assistant: "", thinking: "", tools: [] } : t)),
    { id: "ghost", clipped: true, user: "幽灵残片", assistant: "", thinking: "", tools: [] },
  ];
  const ackClipped = await slim2.syncChat({ id: chatId, title: "分页冒烟·改名", turns: withClipped, draft: "", mode: "agent", policy: "baseline" }, "clipped");
  step(ackClipped.chatRevs?.[chatId] === ackRename.chatRevs?.[chatId],
    "无变化 sync 不前进 chatRevs", `rename=${ackRename.chatRevs?.[chatId]} clipped=${ackClipped.chatRevs?.[chatId]}`);

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
  step(!frow?.turns?.some((t) => t && t.id === "ghost"), "幽灵 clipped turn 被丢弃，未落盘（GLM M1）");
  step(frow?.title === "分页冒烟·改名", "元数据改名已落盘");
  step(!!fbig && fbig.user === BIG, "clipped turn 回退保护：服务端仍是完整原文", fbig ? `len=${String(fbig.user).length}` : "缺 big");

  // 5b. 单会话全量超接收上限 → load_chats 回 stored_state_deferred（Kimi M2 触发面；
  //     iOS 侧收到后把待拉会话降级为壳走 load_chat 分页——Swift 逻辑脚本测不到，这里钉死网关行为）
  const tiny = client("tiny", ["sync_chat", "stored_digest", "slim_state"], 200_000);
  await tiny.hello();
  tiny.send({ type: "load_chats", ids: [chatId] });
  const def = await tiny.waitFor((m) => m.type === "stored_state_deferred", "tiny deferred");
  step(def.type === "stored_state_deferred", "超大会话 load_chats → deferred 回落");
  tiny.ws.close();

  // 6. HTTP /state?slim=1
  const res = await fetch(WS_URL.replace(/^ws/, "http").replace(/\/bridge$/, "/state?slim=1"), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const http = await res.json();
  const hrow = (http.chats || []).find((c) => c && c.id === chatId);
  step(res.ok && !!hrow && !("turns" in hrow) && typeof hrow.preview === "string", "HTTP /state?slim=1 同样剥 turns 补 preview");

  // 7. Kimi 设计评审修补回归：
  //    a) load_chat 页过 settle——磁盘 running 残留（非 live 会话）不能下发成永远转圈
  //    b) preview 对齐 iOS「user 优先」语义（assistant 收尾时仍显示最后的提问）
  //    c) 新会话 sync_chat 缺 turns 键 → 服务端补 turns:[]（web chat.turns.map 不踩空）
  const k2 = `slim-kimi-${randomUUID().slice(0, 8)}`;
  await seed.syncChat({
    id: k2, title: "残留", draft: "", mode: "agent", policy: "baseline",
    turns: [
      { id: "a", user: "早些时候的问题", assistant: "答", thinking: "", tools: [] },
      { id: "b", user: "", assistant: "半截输出", thinking: "", tools: [], running: true },
    ],
  }, "k2-seed");
  slim2.send({ type: "load_chat", chatId: k2 });
  const kp = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === k2, "k2 page");
  const rt = kp.turns.find((t) => t && t.id === "b");
  step(!!rt && !rt.running, "load_chat 页过 settle：非 live 会话 running 残留被收尾", rt ? `running=${rt.running}` : "缺 turn b");
  const res2 = await fetch(WS_URL.replace(/^ws/, "http").replace(/\/bridge$/, "/state?slim=1"), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const http2 = await res2.json();
  const k2row = (http2.chats || []).find((c) => c && c.id === k2);
  step(k2row?.preview === "早些时候的问题", "preview 对齐 iOS user 优先语义", JSON.stringify(k2row?.preview));
  const k3 = `slim-kimi-${randomUUID().slice(0, 8)}`;
  await slim2.syncChat({ id: k3, title: "无turns新会话", draft: "", mode: "agent", policy: "baseline" }, "k3");
  const res3 = await fetch(WS_URL.replace(/^ws/, "http").replace(/\/bridge$/, "/state"), {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const http3 = await res3.json();
  const k3row = (http3.chats || []).find((c) => c && c.id === k3);
  step(!!k3row && Array.isArray(k3row.turns) && k3row.turns.length === 0, "新会话缺 turns 键 → 服务端补 turns:[]");

  // 8. 核心不变量的另一半（Kimi 评审 MINOR6）：键缺失=保留，空数组才是清空
  await slim2.syncChat({ id: chatId, title: "分页冒烟·清空", turns: [], draft: "", mode: "agent", policy: "baseline" }, "clear");
  slim2.send({ type: "load_chat", chatId });
  const cleared = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === chatId, "load after clear");
  step(cleared.total === 0 && cleared.turns.length === 0 && cleared.hasMore === false,
    "sync_chat turns:[] → 服务端清空", `total=${cleared.total}`);

  // 8b. load_chat 未知/不存在 chatId → 空页终止信号（不回包会卡死客户端加载循环）
  slim2.send({ type: "load_chat", chatId: "no-such-chat" });
  const none = await slim2.waitFor((m) => m.type === "chat_turns" && m.chatId === "no-such-chat", "load unknown");
  step(none.total === 0 && none.turns.length === 0 && none.hasMore === false, "load_chat 未知会话 → 空页终止");

  // 9. P9 admin_stats：ready 带 admin 标志；管理员查询返回全租户统计行（env 单租户默认管理员）
  const adminCli = client("admin", ["sync_chat"]);
  await adminCli.hello();
  const readyMsg = adminCli.inbox.find((m) => m.type === "ready");
  step(readyMsg?.admin === true, "ready 带 admin: true（env 单租户默认管理员）", `admin=${readyMsg?.admin}`);
  adminCli.send({ type: "admin_stats" });
  const stats = await adminCli.waitFor((m) => m.type === "admin_stats", "admin_stats");
  const statRow = (stats.tenants || []).find((t) => t && t.id);
  step(Array.isArray(stats.tenants) && stats.tenants.length >= 1, "admin_stats 返回租户行", `n=${stats.tenants?.length}`);
  step(!!statRow && typeof statRow.turns === "number" && typeof statRow.runs === "number"
    && typeof statRow.toolCalls === "number" && typeof statRow.estTokens === "number"
    && typeof statRow.lastActiveAt === "number" && typeof statRow.online === "number"
    && typeof statRow.chats === "number" && typeof statRow.name === "string",
    "统计行字段齐全（turns/runs/toolCalls/estTokens/online/chats/lastActiveAt）");
  step(!!statRow && statRow.online >= 1, "在线连接数 ≥ 1（本连接）", `online=${statRow?.online}`);
  step(!!statRow && statRow.lastActiveAt > 0, "lastActiveAt 已记录（hello 即活动）");
  adminCli.ws.close();

  // 9b. 非管理员被拒（仅当提供 SMOKE_USER_TOKEN——生产多租户冒烟用）
  if (process.env.SMOKE_USER_TOKEN) {
    const plain = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
    const plainInbox = [];
    plain.on("message", (raw) => { try { plainInbox.push(JSON.parse(raw.toString())); } catch {} });
    await new Promise((resolve, reject) => { plain.once("open", resolve); plain.once("error", reject); });
    plain.send(JSON.stringify({ type: "hello", token: process.env.SMOKE_USER_TOKEN, client: { name: "plain" } }));
    const plainReady = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("plain ready 超时")), 15_000);
      const scan = () => {
        const hit = plainInbox.find((m) => m.type === "ready");
        if (hit) { clearTimeout(timer); resolve(hit); }
      };
      plain.on("message", scan); scan();
    });
    step(plainReady.admin !== true, "非管理员 ready 不带 admin 标志", `admin=${plainReady.admin}`);
    plain.send(JSON.stringify({ type: "admin_stats" }));
    const denied = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("admin_stats 拒绝超时")), 15_000);
      const scan = () => {
        const hit = plainInbox.find((m) => m.type === "error" || m.type === "admin_stats");
        if (hit) { clearTimeout(timer); resolve(hit); }
      };
      plain.on("message", scan); scan();
    });
    step(denied.type === "error" && /管理员/.test(denied.message || ""), "非管理员 admin_stats 被拒", denied.message || denied.type);
    plain.close();
  }

  // 清场：删掉冒烟会话
  for (const c of [seed, slim2, slim3]) {
    try {
      for (const id of [chatId, emptyId, k2, k3]) c.send({ type: "delete_session", chatId: id });
    } catch {}
    c.ws.close();
  }
  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("冒烟异常:", err.message); process.exit(1); });
