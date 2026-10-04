#!/usr/bin/env node
// 多设备同步冒烟：同一账号三条连接（A 发消息、B 旁观、C 中途连上）。
// 校验：旁观设备收到运行快照、中途连上不抢流式输出、digest 带 reason、无变化推送不推高 rev、
// 有回合的会话目录不被 set_workspace / sync_chat 改掉。
// 需要网关的 providers.json 里配一个指向本脚本假模型服务的 "fake" 提供方（tools: false），
// 见 scripts/ci-gateway-smoke.sh。用法: CURSOR_REMOTE_TOKEN=<测试用户口令> FAKE_LLM_PORT=18798 node scripts/multidevice-smoke.mjs
import WebSocket from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const WS_URL = process.env.JIEBO_WS_URL || "ws://127.0.0.1:8787/bridge";
const TOKEN = (process.env.CURSOR_REMOTE_TOKEN || "").trim();
const FAKE_PORT = Number(process.env.FAKE_LLM_PORT || 18798);
if (!TOKEN) {
  console.error("缺少 CURSOR_REMOTE_TOKEN：请用测试用户的口令，不要用真实用户的。");
  process.exit(2);
}

const CHUNKS = ["你", "好，", "这是", "一段", "慢慢", "流出", "来的", "回复", "。", "完"];
const CHUNK_MS = 250;

// 假的 OpenAI 兼容流式接口：每 250ms 吐一个字块
const fake = createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const piece of CHUNKS) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, CHUNK_MS));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

let failed = 0;
function step(ok, label, extra = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
}

const CAPS = ["sync_chat", "stored_digest", "slim_state"];

function client(name) {
  const inbox = [];
  let rev = 0;
  const ws = new WebSocket(WS_URL, { maxPayload: 64 * 1024 * 1024 });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      inbox.push(m);
      if (typeof m.rev === "number" && m.rev > rev) rev = m.rev;
    } catch {}
  });
  const send = (msg) => ws.send(JSON.stringify(msg));
  // 从 since 起找第一条满足 pred 的消息
  function waitFor(pred, label, since = 0, timeoutMs = 15_000) {
    const hit = () => inbox.findIndex((m, i) => i >= since && pred(m));
    const now = hit();
    if (now >= 0) return Promise.resolve(inbox[now]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onData);
        reject(new Error(`${name} 超时: ${label}`));
      }, timeoutMs);
      function onData() {
        const i = hit();
        if (i < 0) return;
        clearTimeout(timer);
        ws.off("message", onData);
        resolve(inbox[i]);
      }
      ws.on("message", onData);
    });
  }
  async function hello() {
    await opened;
    send({ type: "hello", token: TOKEN, client: { name, maxMessageBytes: 8 * 1024 * 1024, caps: CAPS } });
    const ready = await waitFor((m) => m.type === "ready", "ready");
    await waitFor((m) => m.type === "stored_state", "stored_state");
    return ready;
  }
  return { name, ws, send, waitFor, hello, inbox, nextRev: () => (rev += 1), mark: () => inbox.length };
}

async function main() {
  await new Promise((resolve) => fake.listen(FAKE_PORT, "127.0.0.1", resolve));
  console.log(`目标 ${WS_URL}，假模型 127.0.0.1:${FAKE_PORT}`);

  const a = client("smoke-A");
  const b = client("smoke-B");
  const readyA = await a.hello();
  await b.hello();
  const model = (readyA.models || []).find((id) => typeof id === "string" && id.startsWith("fake:"));
  if (!model) throw new Error(`ready.models 里没有 fake: 模型：${JSON.stringify(readyA.models)}`);
  const root = readyA.workspaceRoot || readyA.cwd;
  const proj = `${root}/smoke-proj-${randomUUID().slice(0, 6)}`;
  const other = `${root}/smoke-other-${randomUUID().slice(0, 6)}`;
  const chatId = `md-smoke-${randomUUID().slice(0, 8)}`;
  const meta = { id: chatId, title: "多设备冒烟", cwd: proj, mode: "ask", confirmWrites: false, policy: "baseline" };

  // 1. A 建会话：B 收到 reason=changed 的广播 digest
  a.send({ type: "new_session", chatId, cwd: proj });
  await a.waitFor((m) => m.type === "session" && m.chatId === chatId, "new_session");
  let bMark = b.mark();
  a.send({ type: "sync_chat", chat: meta, rev: a.nextRev() });
  const created = await a.waitFor((m) => m.type === "sync_ack" && m.chatRevs && chatId in m.chatRevs, "建会话 ack");
  const digest = await b.waitFor((m) => m.type === "stored_digest", "B 收广播 digest", bMark);
  step(digest.reason === "changed", "别处写入的广播 digest 带 reason=changed", `reason=${digest.reason}`);

  // 2. 无变化重推：全局 rev 不前进
  const bump = a.nextRev() + 50;
  a.send({ type: "sync_chat", chat: meta, rev: bump });
  const noop = await a.waitFor((m) => m.type === "sync_ack", "无变化 ack", a.inbox.indexOf(created) + 1);
  step(noop.rev < bump, "无变化的 sync_chat 不推高全局 rev", `ack.rev=${noop.rev} 推送 rev=${bump}`);

  // 3. 被拒：rev 落后的推送收到 reason=rejected
  bMark = b.mark();
  b.send({ type: "sync_chat", chat: { ...meta, title: "旧版本" }, rev: 0 });
  const rejected = await b.waitFor((m) => m.type === "stored_digest", "B 被拒 digest", bMark);
  step(rejected.reason === "rejected", "rev 落后被拒时 digest 带 reason=rejected", `reason=${rejected.reason}`);

  // 4. A 发消息，B 旁观；中途 C 连上
  const turnId = randomUUID();
  const aMark = a.mark();
  bMark = b.mark();
  a.send({ type: "prompt", chatId, text: "你好", model, mode: "ask", turnId });
  const firstSnap = await b.waitFor(
    (m) => m.type === "run_snapshot" && m.chatId === chatId && m.phase === "running",
    "B 收到运行中快照",
    bMark,
  );
  step(firstSnap.turnId === turnId && firstSnap.userText === "你好", "旁观设备在运行中收到带 turnId 的快照");
  await a.waitFor((m) => m.type === "text-delta" && m.chatId === chatId, "A 收到第一段增量", aMark);

  const c = client("smoke-C");
  await c.hello();
  const cMark = c.mark();
  const deltasBefore = a.inbox.filter((m, i) => i >= aMark && m.type === "text-delta").length;
  const doneA = await a.waitFor((m) => m.type === "done" && m.chatId === chatId, "A 收到 done", aMark, 20_000);
  const deltasAfter = a.inbox.filter((m, i) => i >= aMark && m.type === "text-delta").length;
  step(Boolean(doneA) && deltasAfter > deltasBefore, "C 中途连上后 A 仍收到增量和 done", `C 连上前 ${deltasBefore} 段，结束时 ${deltasAfter} 段`);
  const cDelta = c.inbox.some((m, i) => i >= cMark && m.type === "text-delta" && m.chatId === chatId);
  step(!cDelta, "中途连上的 C 没有抢走逐字增量");
  const finalB = await b.waitFor(
    (m) => m.type === "run_snapshot" && m.chatId === chatId && m.phase === "done",
    "B 收到收尾快照",
    bMark,
  );
  step(finalB.assistant === CHUNKS.join(""), "旁观设备的收尾快照是完整回复", JSON.stringify(finalB.assistant));
  const midB = b.inbox.filter((m, i) => i >= bMark && m.type === "run_snapshot" && m.chatId === chatId).length;
  step(midB >= 3, "旁观设备在运行中多次收到快照", `${midB} 份`);
  const cSnap = await c.waitFor((m) => m.type === "run_snapshot" && m.chatId === chatId, "C 收到快照", 0);
  step(Boolean(cSnap), "中途连上的设备也能收到快照");

  // 5. 有回合后目录固定：B 的 set_workspace 和 sync_chat 都改不动
  await b.waitFor((m) => m.type === "stored_digest" && m.chatRevs?.[chatId] > created.chatRevs[chatId], "回合结束 digest", bMark);
  bMark = b.mark();
  b.send({ type: "set_workspace", chatId, cwd: other });
  const sess = await b.waitFor((m) => (m.type === "session" || m.type === "error") && m.chatId === chatId, "set_workspace 回复", bMark);
  step(sess.type === "session" && sess.cwd === proj, "有回合的会话 set_workspace 不换目录", `cwd=${sess.cwd}`);
  b.send({ type: "sync_chat", chat: { ...meta, cwd: other, title: "改个标题" }, rev: b.nextRev() + 100 });
  await b.waitFor((m) => m.type === "sync_ack" || m.type === "stored_digest", "B 改目录推送", bMark);
  bMark = b.mark();
  b.send({ type: "load_state" });
  const state = await b.waitFor((m) => m.type === "stored_state", "load_state", bMark);
  const row = (state.chats || []).find((item) => item && item.id === chatId);
  step(row?.cwd === proj, "sync_chat 改不动有回合的会话目录", `cwd=${row?.cwd}`);
  step(row?.title === "改个标题", "同一次推送里的其他元数据照常生效", `title=${row?.title}`);

  for (const conn of [a, b, c]) conn.ws.close();
  fake.close();
  console.log(failed ? `\n${failed} 项失败` : "\n全绿");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  fake.close();
  process.exit(1);
});
