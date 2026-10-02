#!/usr/bin/env node
// 自研 Agent 端到端：连真实网关 + 真实第三方模型，在临时子工作区里跑，跑完删掉。
// 用法（在网关所在机器上）：
//   set -a; . /etc/cursor-remote/gateway.env; set +a
//   NATIVE_E2E_MODEL=minimax:MiniMax-M2 node scripts/native-e2e.mjs [场景...]
// 场景：create undo restore approve ask cancel shell memory usage（缺省全跑）
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const WS_URL = process.env.JIEBO_WS_URL || "ws://127.0.0.1:8787/bridge";
const TOKEN = process.env.CURSOR_REMOTE_TOKEN || "";
const MODEL = process.env.NATIVE_E2E_MODEL || "minimax:MiniMax-M2";
const RUN_TIMEOUT = Number(process.env.NATIVE_E2E_TIMEOUT_MS || 240_000);
const wanted = new Set(process.argv.slice(2));
const want = (name) => !wanted.size || wanted.has(name);

let failed = 0;
let passed = 0;
function check(ok, label, extra = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && extra ? `  — ${extra}` : ""}`);
}

const inbox = [];
const ws = new WebSocket(WS_URL, { maxPayload: 256 * 1024 * 1024 });
ws.on("message", (raw) => {
  try {
    inbox.push(JSON.parse(raw.toString()));
  } catch {}
});
const send = (msg) => ws.send(JSON.stringify(msg));

function waitFor(pred, label, timeoutMs = 20_000, from = 0) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      for (let i = from; i < inbox.length; i++) {
        if (pred(inbox[i])) return resolve({ msg: inbox[i], index: i });
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`超时：${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const since = (from, chatId) => inbox.slice(from).filter((m) => m.chatId === chatId);

async function openChat(tag) {
  const chatId = `native-e2e-${tag}-${randomUUID().slice(0, 6)}`;
  const from = inbox.length;
  send({ type: "set_workspace", cwd: `native-e2e-${RUN_ID}/${tag}`, chatId, create: true });
  const { msg } = await waitFor((m) => m.type === "session" && m.chatId === chatId, `${tag} session`, 20_000, from);
  return { chatId, cwd: msg.cwd };
}

async function prompt(chatId, text, extra = {}) {
  const from = inbox.length;
  send({ type: "prompt", chatId, text, model: MODEL, mode: "agent", dialect: false, ...extra });
  return from;
}

async function waitDone(chatId, from, label) {
  const { msg } = await waitFor((m) => m.type === "done" && m.chatId === chatId, `${label} done`, RUN_TIMEOUT, from);
  return msg;
}

function summary(events) {
  const tools = events.filter((m) => m.type === "tool-started").map((m) => m.name);
  const text = events.filter((m) => m.type === "text-delta").map((m) => m.text).join("");
  const errors = events.filter((m) => m.type === "error").map((m) => m.message);
  return { tools, text, errors };
}

const RUN_ID = randomUUID().slice(0, 6);
const chats = [];
let root = "";

try {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  send({ type: "hello", token: TOKEN, client: { name: "native-e2e", version: "1", caps: ["slim_state"] } });
  const { msg: ready } = await waitFor((m) => m.type === "ready" || (m.type === "auth" && !m.ok), "ready");
  if (ready.type !== "ready") throw new Error(`登录失败：${ready.message}`);
  check(Array.isArray(ready.models) && ready.models.includes(MODEL), `模型目录里有 ${MODEL}`, JSON.stringify(ready.models?.filter((m) => m.includes(":"))));

  if (want("create") || want("undo")) {
    const { chatId, cwd } = await openChat("create");
    chats.push(chatId);
    root = join(cwd, "..");
    const from = await prompt(
      chatId,
      "在当前目录新建 hello.py，内容是一个打印 hello world 的 Python 程序。然后用编辑工具把打印内容改成「你好，接驳」。最后读一遍 hello.py 确认结果。",
    );
    const done = await waitDone(chatId, from, "create");
    const events = since(from, chatId);
    const s = summary(events);
    const file = join(cwd, "hello.py");
    const content = existsSync(file) ? readFileSync(file, "utf8") : "";
    check(done.status === "completed", "create：本轮完成", `${done.status} ${s.errors.join(" | ")}`);
    check(events.some((m) => m.type === "run_meta" && m.mode === "agent" && m.model === MODEL), "create：run_meta 标为 agent 模式");
    check(events.some((m) => m.type === "checkpoints" && m.items?.length), "create：开跑前打了检查点");
    check(s.tools.includes("write_file"), "create：调用了 write_file", s.tools.join(","));
    check(s.tools.includes("edit_file") || content.includes("你好，接驳"), "create：调用了 edit_file", s.tools.join(","));
    check(content.includes("你好，接驳") && /print/.test(content), "create：磁盘上的文件内容正确", JSON.stringify(content));
    const completed = events.filter((m) => m.type === "tool-completed");
    check(completed.length >= s.tools.length, "create：每个 tool-started 都有 tool-completed");
    check(events.some((m) => m.type === "files"), "create：改完推送了文件树");
    console.log(`      工具：${s.tools.join(" → ")}；回复：${s.text.trim().slice(0, 120).replace(/\n/g, " ")}`);

    if (want("undo")) {
      const before = inbox.length;
      send({ type: "undo", chatId });
      const { msg: undone } = await waitFor((m) => (m.type === "restored" || m.type === "undone") && m.chatId === chatId, "undo 回执", 20_000, before);
      await new Promise((r) => setTimeout(r, 300));
      check(!undone.error, "undo：回执没有报错", undone.error);
      check(!existsSync(file), "undo：新建的 hello.py 被撤销掉", existsSync(file) ? readFileSync(file, "utf8") : "");
    }
  }

  if (want("restore")) {
    const { chatId, cwd } = await openChat("restore");
    chats.push(chatId);
    root = join(cwd, "..");
    const original = "def add(a, b):\n    return a + b\n";
    const before = inbox.length;
    send({ type: "write_file", chatId, path: "calc.py", content: original });
    await waitFor((m) => m.type === "file_written" && m.chatId === chatId, "写入 calc.py", 20_000, before);
    const from = await prompt(chatId, "给 calc.py 加一个 sub(a, b) 函数，返回 a - b。");
    const done = await waitDone(chatId, from, "restore");
    const edited = readFileSync(join(cwd, "calc.py"), "utf8");
    check(done.status === "completed" && edited.includes("def sub"), "restore：Agent 改了已有文件", edited);
    const mark = inbox.length;
    send({ type: "undo", chatId });
    const { msg } = await waitFor((m) => (m.type === "restored" || m.type === "undone") && m.chatId === chatId, "restore 回执", 20_000, mark);
    await new Promise((r) => setTimeout(r, 300));
    check(!msg.error && readFileSync(join(cwd, "calc.py"), "utf8") === original, "restore：撤销后内容回到原样", msg.error || readFileSync(join(cwd, "calc.py"), "utf8"));
  }

  if (want("approve")) {
    const { chatId, cwd } = await openChat("approve");
    chats.push(chatId);
    root = join(cwd, "..");
    let from = await prompt(chatId, "新建文件 note.txt，内容写一行：审批测试。", { confirmWrites: true });
    const { msg: ask } = await waitFor((m) => m.type === "approval" && m.chatId === chatId, "approval 请求", RUN_TIMEOUT, from);
    check(/write|edit/.test(ask.name), "approve：写操作前发出 approval", ask.name);
    check(!existsSync(join(cwd, "note.txt")), "approve：批准前没有写盘");
    send({ type: "approval_reply", chatId, callId: ask.callId, allow: false });
    let done = await waitDone(chatId, from, "deny");
    let s = summary(since(from, chatId));
    check(done.status === "cancelled" && s.text.includes("已拒绝写入"), "approve：拒绝后本轮取消并提示", `${done.status} ${s.text.slice(-60)}`);
    check(!existsSync(join(cwd, "note.txt")), "approve：拒绝后文件不存在");

    from = await prompt(chatId, "新建文件 note.txt，内容写一行：审批测试。", { confirmWrites: true });
    const { msg: ask2 } = await waitFor((m) => m.type === "approval" && m.chatId === chatId, "第二次 approval", RUN_TIMEOUT, from);
    send({ type: "approval_reply", chatId, callId: ask2.callId, allow: true });
    done = await waitDone(chatId, from, "allow");
    s = summary(since(from, chatId));
    const approvals = since(from, chatId).filter((m) => m.type === "approval").length;
    check(done.status === "completed" && existsSync(join(cwd, "note.txt")), "approve：同意后写入并完成", `${done.status} ${s.errors.join(" | ")}`);
    check(approvals === 1, "approve：同一轮只问一次", String(approvals));
  }

  if (want("ask")) {
    const { chatId, cwd } = await openChat("ask");
    chats.push(chatId);
    root = join(cwd, "..");
    const before = inbox.length;
    send({ type: "write_file", chatId, path: "README.md", content: "# 示例\n\n这是 ask 模式测试用的说明文件，项目代号 ZEPHYR-42。\n" });
    await waitFor((m) => m.type === "file_written" && m.chatId === chatId, "写入示例文件", 20_000, before);
    const from = await prompt(chatId, "README.md 里提到的项目代号是什么？顺便把它改成 ZEPHYR-43。", { mode: "ask" });
    const done = await waitDone(chatId, from, "ask");
    const events = since(from, chatId);
    const s = summary(events);
    const content = readFileSync(join(cwd, "README.md"), "utf8");
    check(done.status === "completed", "ask：本轮完成", `${done.status} ${s.errors.join(" | ")}`);
    check(events.some((m) => m.type === "run_meta" && m.mode === "ask"), "ask：run_meta 标为 ask 模式");
    check(!s.tools.some((name) => /write|edit|delete|shell/.test(name)), "ask：没有调用写工具", s.tools.join(","));
    check(content.includes("ZEPHYR-42") && !content.includes("ZEPHYR-43"), "ask：文件没被修改");
    check(s.text.includes("ZEPHYR-42"), "ask：回答里给出代号", s.text.slice(0, 200));
  }

  if (want("cancel")) {
    const { chatId, cwd } = await openChat("cancel");
    chats.push(chatId);
    root = join(cwd, "..");
    const from = await prompt(chatId, "依次新建 a1.txt 到 a9.txt 九个文件，每个文件写 30 行不同的中文诗句。每个文件单独调用一次写工具。");
    await waitFor((m) => (m.type === "tool-started" || m.type === "text-delta" || m.type === "thinking-delta") && m.chatId === chatId, "cancel：开始输出", RUN_TIMEOUT, from);
    const t0 = Date.now();
    send({ type: "cancel", chatId });
    const done = await waitDone(chatId, from, "cancel");
    check(done.status === "cancelled" && Date.now() - t0 < 5000, "cancel：及时停下", `${done.status} ${Date.now() - t0}ms`);
    await new Promise((r) => setTimeout(r, 3000));
    const after = inbox.slice(inbox.indexOf(done) + 1).filter((m) => m.chatId === chatId && (m.type === "text-delta" || m.type === "tool-started"));
    check(after.length === 0, "cancel：取消后不再有输出", String(after.length));
    const written = Array.from({ length: 9 }, (_, i) => existsSync(join(cwd, `a${i + 1}.txt`))).filter(Boolean).length;
    check(written < 9, "cancel：没有把九个文件写完", String(written));
  }

  if (want("shell")) {
    const { chatId, cwd } = await openChat("shell");
    chats.push(chatId);
    root = join(cwd, "..");
    const from = await prompt(chatId, "用 run_shell 执行命令 `echo $((6*7)) > answer.txt && cat answer.txt`，然后告诉我输出是多少。");
    const done = await waitDone(chatId, from, "shell");
    const events = since(from, chatId);
    const s = summary(events);
    const shellDone = events.find((m) => m.type === "tool-completed" && m.name === "run_shell");
    check(done.status === "completed", "shell：本轮完成", `${done.status} ${s.errors.join(" | ")}`);
    check(s.tools.includes("run_shell"), "shell：调用了 run_shell", s.tools.join(","));
    check(events.some((m) => m.type === "tool-output" && m.chatId === chatId && /42/.test(m.chunk || "")), "shell：流式推送了命令输出");
    check(shellDone && /退出码 0/.test(shellDone.result || ""), "shell：结果带退出码", shellDone?.result?.slice(0, 120));
    check(existsSync(join(cwd, "answer.txt")) && readFileSync(join(cwd, "answer.txt"), "utf8").trim() === "42", "shell：命令在工作区里执行");
    check(s.text.includes("42"), "shell：回答里给出 42", s.text.slice(0, 160));

    const from2 = await prompt(chatId, "用 run_shell 执行 `cat /etc/hostname > /tmp/jiebo-e2e-escape.txt`。如果被拦截，就直接告诉我被拦截了，不要换别的办法。");
    const done2 = await waitDone(chatId, from2, "shell-escape");
    const blocked = since(from2, chatId).find((m) => m.type === "tool-completed" && m.name === "run_shell");
    check(done2.status === "completed" && (!blocked || /超出了当前工作区/.test(blocked.result || "")), "shell：重定向到工作区外被拦截", blocked?.result);
    check(!existsSync("/tmp/jiebo-e2e-escape.txt"), "shell：工作区外没有落盘");

    const from3 = await prompt(chatId, "先用 run_shell 执行 `ls`，再用 run_shell 执行 `echo ok > s.txt`。两条命令分两次调用。", { confirmWrites: true });
    const { msg: ask } = await waitFor((m) => m.type === "approval" && m.chatId === chatId, "shell approval", RUN_TIMEOUT, from3);
    check(ask.name === "run_shell" && /s\.txt/.test(JSON.stringify(ask.args || "")), "shell：写文件的命令要审批", JSON.stringify(ask.args));
    const lsRan = since(from3, chatId).some((m) => m.type === "tool-completed" && m.name === "run_shell");
    check(lsRan, "shell：只读命令不审批直接执行");
    send({ type: "approval_reply", chatId, callId: ask.callId, allow: true });
    const done3 = await waitDone(chatId, from3, "shell-approve");
    check(done3.status === "completed" && existsSync(join(cwd, "s.txt")), "shell：批准后执行", done3.status);
  }

  if (want("memory")) {
    const { chatId, cwd } = await openChat("memory");
    chats.push(chatId);
    root = join(cwd, "..");
    let from = await prompt(chatId, "先用 list_dir 看一下当前目录，然后记住：本次测试的暗号是「蓝鲸-7731」。只回复「记住了」。");
    let done = await waitDone(chatId, from, "memory-1");
    check(done.status === "completed", "memory：第一轮完成");
    // 网页端不带 history：网关必须从存档接上
    from = await prompt(chatId, "暗号是什么？上一轮你调用了哪个工具？");
    done = await waitDone(chatId, from, "memory-2");
    const s = summary(since(from, chatId));
    check(done.status === "completed" && s.text.includes("7731"), "memory：不带 history 也记得上一轮", s.text.slice(0, 160));
    check(/list_dir/.test(s.text), "memory：记得上一轮的工具调用", s.text.slice(0, 160));
  }

  if (want("usage")) {
    const from = inbox.length;
    send({ type: "admin_stats" });
    const { msg } = await waitFor((m) => m.type === "admin_stats", "admin_stats", 20_000, from);
    const total = (msg.tenants || []).reduce((sum, row) => sum + (row.modelInTokens || 0) + (row.modelOutTokens || 0), 0);
    check(total > 0, "usage：记录了第三方模型的真实 token", JSON.stringify((msg.tenants || []).map((r) => [r.name, r.modelInTokens, r.modelOutTokens])));
  }
} catch (err) {
  failed += 1;
  console.log(`FAIL  ${err instanceof Error ? err.message : err}`);
} finally {
  for (const chatId of chats) send({ type: "delete_session", chatId });
  await new Promise((r) => setTimeout(r, 500));
  ws.close();
  if (root && root.includes(`native-e2e-${RUN_ID}`)) rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
