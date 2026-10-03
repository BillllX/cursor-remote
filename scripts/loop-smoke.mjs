#!/usr/bin/env node
// L2：本地网关 Loop 两拍后按 maxTicks 停止。模型走 MiniMax，避免拉起 Cursor agent。
import { createRequire } from "node:module";
const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const WebSocket = require("ws");

const url = process.env.JIEBO_WS_URL || "ws://127.0.0.1:8787/bridge";
const token = (process.env.CURSOR_REMOTE_TOKEN || "").trim();
if (!token) {
  console.error("缺少 CURSOR_REMOTE_TOKEN：请用测试用户的口令，不要用真实用户的。");
  process.exit(2);
}
const chatId = `loop-smoke-${Date.now()}`;
const ws = new WebSocket(url);
let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};
const ticks = [];
let started = false;
const timer = setTimeout(() => {
  console.log("TIMEOUT", ticks);
  process.exit(1);
}, 120000);

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "hello",
    token,
    client: { name: "loop-smoke", maxMessageBytes: 4 * 1024 * 1024, caps: ["sync_chat"] },
  }));
});
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "ready") {
    if (started) return;
    started = true;
    ok("ready.loops 是数组", Array.isArray(msg.loops));
    ws.send(JSON.stringify({
      type: "loop_start",
      chatId,
      goal: "只用四个字回答：收到了吗",
      intervalSec: 30,
      maxTicks: 2,
      model: "minimax:MiniMax-M3",
      mode: "ask",
    }));
    return;
  }
  if (msg.chatId !== chatId) return;
  if (msg.type === "loop_state" && msg.status === "armed" && msg.tick === 0) {
    ok("loop_start 回 armed 且带 nextAt", typeof msg.nextAt === "number");
  }
  if (msg.type === "loop_tick") {
    ticks.push(msg);
    console.log(`tick ${msg.tick} ${msg.status} ${msg.summary}`);
  }
  if (msg.type === "loop_state" && msg.status === "stopped") {
    ok("两拍后 stopped", ticks.filter((item) => item.status === "ran" || item.status === "stopped").length >= 2);
    ok("停止摘要提到拍数", /2 拍/.test(msg.lastSummary || ""));
    clearTimeout(timer);
    ws.close();
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  }
  if (msg.type === "error") {
    console.log("error", msg.message);
    clearTimeout(timer);
    process.exit(1);
  }
});
ws.on("error", (err) => {
  console.log("WS", err.message);
  process.exit(1);
});
