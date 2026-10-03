#!/usr/bin/env node
// resume_session 宽容化冒烟（P7 后）：agentId 不匹配应回 session 自愈，不再报「不能恢复别人的会话」。
// 用法: CURSOR_REMOTE_TOKEN=<测试用户口令> node scripts/resume-smoke.mjs   （默认连本地 dev gateway 127.0.0.1:8787）
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const WS_URL = process.env.JIEBO_WS_URL || "ws://127.0.0.1:8787/bridge";
const TOKEN = (process.env.CURSOR_REMOTE_TOKEN || "").trim();
if (!TOKEN) {
  console.error("缺少 CURSOR_REMOTE_TOKEN：请用测试用户的口令，不要用真实用户的。");
  process.exit(2);
}
const chatId = `resume-smoke-${randomUUID().slice(0, 8)}`;
const inbox = [];
let cursor = 0;
let failed = 0;
let ws;

function send(msg) { ws.send(JSON.stringify(msg)); }

function waitFor(pred, label, timeoutMs = 10_000) {
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
    function cleanup() { clearTimeout(timer); ws?.off("message", onData); }
    function onData() { scan(); }
    ws.on("message", onData);
  });
}

function step(ok, label, extra = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  console.log(`目标 ${WS_URL}，会话 ${chatId}`);
  ws = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
  ws.on("message", (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch {} });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  send({ type: "hello", token: TOKEN, client: { name: "resume-smoke", maxMessageBytes: 1048576 } });
  await waitFor((m) => m.type === "ready", "ready");

  // 1. 全新会话 + 不存在的 agentId → 旧行为报 error；新行为回 session(agentId:"")
  send({ type: "resume_session", chatId, agentId: "bogus-agent-id" });
  const s1 = await waitFor((m) => (m.type === "session" || m.type === "error") && m.chatId === chatId, "resume(bogus)");
  step(s1.type === "session", "agentId 不匹配回 session 而非 error", s1.type === "error" ? s1.message : `agentId=${JSON.stringify(s1.agentId)}`);
  step(s1.type === "session" && s1.agentId === "", "陈旧 agentId 被纠正为空（客户端据此自愈）");

  // 2. 纠错后再用空 agentId resume → 匹配（stored 也是空）→ 正常 session
  send({ type: "resume_session", chatId, agentId: "" });
  const s2 = await waitFor((m) => m.type === "session" && m.chatId === chatId, "resume(empty)");
  step(s2.type === "session", "纠错后 resume 正常", `cwd=${JSON.stringify(s2.cwd)}`);

  // 3. 全程不应再出现「不能恢复别人的会话」
  const stale = inbox.filter((m) => m.type === "error" && String(m.message || "").includes("不能恢复"));
  step(stale.length === 0, "全程无「不能恢复别人的会话」");

  ws.close();
  console.log(failed ? `\n${failed} 项失败` : "\n全绿");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error("冒烟中断:", err.message); process.exit(1); });
