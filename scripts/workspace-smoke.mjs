#!/usr/bin/env node
// 工作区重命名 / 删除 / 隐藏冒烟（临时网关 + 测试用户）。
// 用法: CURSOR_REMOTE_TOKEN=<测试用户口令> node scripts/workspace-smoke.mjs   （默认连 127.0.0.1:8787）
import WebSocket from "ws";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const WS_URL = process.env.JIEBO_WS_URL || "ws://127.0.0.1:8787/bridge";
const TOKEN = (process.env.CURSOR_REMOTE_TOKEN || "").trim();
if (!TOKEN) {
  console.error("缺少 CURSOR_REMOTE_TOKEN：请用测试用户的口令，不要用真实用户的。");
  process.exit(2);
}
const tag = randomUUID().slice(0, 6);
const inbox = [];
let cursor = 0;
let failed = 0;
const ws = new WebSocket(WS_URL, { maxPayload: 128 * 1024 * 1024 });
ws.on("message", (raw) => {
  try {
    inbox.push(JSON.parse(raw.toString()));
  } catch {}
});
const send = (msg) => ws.send(JSON.stringify(msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (let i = cursor; i < inbox.length; i += 1) {
      if (pred(inbox[i])) {
        cursor = i + 1;
        return inbox[i];
      }
    }
    await sleep(40);
  }
  throw new Error(`超时: ${label}`);
}
function step(ok, label, extra = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
}
/** 发一条指令，等 workspaces 回包或 error，返回 {items, error, events} */
async function call(msg, label) {
  const from = inbox.length;
  cursor = from;
  send(msg);
  const hit = await waitFor((m) => m.type === "workspaces" || m.type === "error", label);
  await sleep(150);
  const events = inbox.slice(from);
  return { hit, events, error: hit.type === "error" ? hit.message : "", items: [...events].reverse().find((m) => m.type === "workspaces")?.items };
}
const names = (items) => (items || []).filter((i) => !i.user).map((i) => i.name);

await new Promise((resolveOpen, reject) => {
  ws.once("open", resolveOpen);
  ws.once("error", reject);
});
send({ type: "hello", token: TOKEN, client: { name: "workspace-smoke", maxMessageBytes: 1048576 } });
await waitFor((m) => m.type === "ready", "ready");
send({ type: "list_workspaces" });
const first = await waitFor((m) => m.type === "workspaces", "workspaces");
const root = first.root;
console.log(`工作区根目录 ${root}`);

const A = `wsa-${tag}`;
const B = `wsb-${tag}`;
const C = `wsc-${tag}`;
const D = `wsd-${tag}`;
const E = `wse-${tag}`;
for (const name of [A, B, C, E]) {
  send({ type: "create_workspace", name });
  await waitFor((m) => m.type === "workspace_created" && m.name === name, `建 ${name}`);
}

// 1. 空目录：真删
let r = await call({ type: "delete_workspace", path: resolve(root, A) }, "删空目录");
step(r.events.some((m) => m.type === "workspace_removed" && m.mode === "deleted"), "空目录被真正删除");
step(!existsSync(resolve(root, A)) && !names(r.items).includes(A), "目录没了、列表里也没了");

// 2. 有文件：只隐藏
writeFileSync(resolve(root, B, "note.txt"), "keep me");
r = await call({ type: "delete_workspace", path: resolve(root, B) }, "删有文件的目录");
step(r.events.some((m) => m.type === "workspace_removed" && m.mode === "hidden"), "有文件的目录只隐藏");
step(existsSync(resolve(root, B, "note.txt")) && !names(r.items).includes(B), "文件还在、列表里藏起来了");
// 同名重建 = 取消隐藏
send({ type: "create_workspace", name: B });
await waitFor((m) => m.type === "workspace_created" && m.name === B, "重建 B");
send({ type: "list_workspaces" });
const again = await waitFor((m) => m.type === "workspaces", "workspaces");
step(names(again.items).includes(B), "同名重新建就取消隐藏");

// 3. 重命名
r = await call({ type: "rename_workspace", path: resolve(root, C), name: D }, "改名");
step(r.events.some((m) => m.type === "workspace_renamed" && m.name === D), "改名成功");
step(existsSync(resolve(root, D)) && !existsSync(resolve(root, C)) && names(r.items).includes(D) && !names(r.items).includes(C), "目录和列表都换了名");
r = await call({ type: "rename_workspace", path: resolve(root, D), name: B }, "改成已有名字");
step(/已经有/.test(r.error), "改成已有名字被拒", r.error);
r = await call({ type: "rename_workspace", path: resolve(root, D), name: "a/b" }, "带斜杠");
step(/不合法/.test(r.error), "带斜杠的新名字被拒", r.error);
r = await call({ type: "rename_workspace", path: resolve(root, "..", "x"), name: "zzz" }, "越界路径");
step(Boolean(r.error), "根目录外的路径被拒", r.error);
r = await call({ type: "delete_workspace", path: root }, "删根目录");
step(Boolean(r.error), "不能删根目录", r.error);

// 4. 带会话：改名要把会话的 cwd 一起改；有会话时不许删
const chatId = `wssmoke-${tag}`;
send({ type: "load_state" });
const st = await waitFor((m) => m.type === "stored_state", "stored_state");
send({
  type: "sync_chat",
  rev: (st.rev || 0) + 1,
  chat: { id: chatId, title: "冒烟会话", cwd: resolve(root, E), turns: [{ id: "t1", user: "hi", assistant: "yo", thinking: "", tools: [], running: false }] },
});
await waitFor((m) => m.type === "sync_ack", "sync_ack");
r = await call({ type: "delete_workspace", path: resolve(root, E) }, "删有会话的目录");
step(/还有 1 个对话/.test(r.error), "有对话时拒绝删除", r.error);
r = await call({ type: "rename_workspace", path: resolve(root, E), name: `${E}-new` }, "改名带会话");
step(r.events.some((m) => m.type === "workspace_renamed"), "有对话的工作区也能改名");
send({ type: "load_state" });
const st2 = await waitFor((m) => m.type === "stored_state", "stored_state2");
const row = (st2.chats || []).find((c) => c.id === chatId);
step(row && row.cwd === resolve(root, `${E}-new`), "会话的 cwd 跟着改到新路径", row?.cwd);

// 清理
send({ type: "delete_session", chatId });
await sleep(200);
ws.close();
console.log(failed ? `${failed} 项失败` : "全部通过");
process.exit(failed ? 1 : 0);
