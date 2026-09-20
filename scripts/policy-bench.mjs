#!/usr/bin/env node
// 对照 baseline / plane 两条 harness 路径。
// 用法:
//   CURSOR_REMOTE_TOKEN=xxx node scripts/policy-bench.mjs
//   --models composer-2.5,kimi-k3-max --policies baseline,plane --tasks ask-readonly
// 默认连本机 ws://127.0.0.1:8787
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts/policy-bench/fixtures/mini-lib");
const TASKS_FILE = join(ROOT, "scripts/policy-bench/tasks.json");
const OUT_DIR = join(ROOT, "scripts/policy-bench/results");

const WS_URL = process.env.JIEBO_WS_URL || process.env.POLICY_BENCH_WS || "ws://127.0.0.1:8787";
const TOKEN = (process.env.CURSOR_REMOTE_TOKEN || "").trim();

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

const MODELS = argValue("--models", process.env.CURSOR_REMOTE_MODEL || "composer-2.5")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const POLICIES = argValue("--policies", "baseline,plane")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item === "baseline" || item === "plane");
const TASK_FILTER = new Set(
  argValue("--tasks", "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

if (!TOKEN) {
  console.error("缺少 CURSOR_REMOTE_TOKEN");
  process.exit(2);
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function waitFor(inbox, pred, label, timeoutMs) {
  const hit = inbox.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      clearInterval(timerId);
      reject(new Error(`超时: ${label}`));
    }, timeoutMs);
    const timerId = setInterval(() => {
      const found = inbox.find(pred);
      if (!found) return;
      clearTimeout(timer);
      clearInterval(timerId);
      resolvePromise(found);
    }, 40);
  });
}

function copyFixture(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(FIXTURE, dest, { recursive: true });
}

function readRel(root, rel) {
  const path = join(root, rel);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function scoreExpect(root, expect = {}) {
  const reasons = [];
  let ok = true;
  if (expect.unchanged) {
    const lib = readRel(root, "lib.js") || "";
    const app = readRel(root, "app.js") || "";
    const srcLib = readRel(FIXTURE, "lib.js") || "";
    const srcApp = readRel(FIXTURE, "app.js") || "";
    if (lib !== srcLib || app !== srcApp) {
      ok = false;
      reasons.push("Ask 不该改文件");
    }
  }
  for (const [rel, needle] of Object.entries(expect.filesContain || {})) {
    const body = readRel(root, rel) || "";
    if (!body.toLowerCase().includes(String(needle).toLowerCase())) {
      ok = false;
      reasons.push(`${rel} 缺少 ${needle}`);
    }
  }
  for (const rel of expect.unchangedFiles || []) {
    const now = readRel(root, rel);
    const src = readRel(FIXTURE, rel);
    if (now !== src) {
      ok = false;
      reasons.push(`${rel} 不该被改`);
    }
  }
  return { ok, reasons };
}

async function runCase({ task, model, policy, workspaceRoot }) {
  const runId = `${task.id}-${policy}-${model.replace(/[^\w.-]+/g, "_")}-${randomUUID().slice(0, 6)}`;
  const cwd = join(workspaceRoot, ".policy-bench", runId);
  copyFixture(cwd);
  const chatId = `bench-${randomUUID().slice(0, 8)}`;
  const inbox = [];
  const ws = new WebSocket(WS_URL, { maxPayload: 32 * 1024 * 1024 });
  ws.on("message", (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
  });
  send(ws, {
    type: "hello",
    token: TOKEN,
    client: { name: "policy-bench", version: "0.1.0", caps: ["sync_chat"] },
  });
  const ready = await waitFor(inbox, (m) => m.type === "ready", "ready", 20_000);
  const root = ready.workspaceRoot || ready.cwd;
  if (!root) throw new Error("ready 没有 workspaceRoot");
  send(ws, { type: "set_workspace", cwd, chatId, create: true });
  await waitFor(
    inbox,
    (m) => m.type === "session" && m.chatId === chatId,
    "set_workspace",
    15_000,
  );
  send(ws, { type: "set_policy", policy, chatId });
  const started = Date.now();
  send(ws, {
    type: "prompt",
    text: task.prompt,
    model,
    mode: task.mode,
    chatId,
    confirmWrites: Boolean(task.confirmWrites),
    policy,
    nameChat: false,
  });
  const timeoutMs = task.timeoutMs || 180_000;
  let done;
  while (!done) {
    const msg = await waitFor(
      inbox,
      (m) =>
        (m.type === "done" || m.type === "error" || m.type === "approval") &&
        (!m.chatId || m.chatId === chatId) &&
        !m._seen,
      "turn",
      timeoutMs,
    );
    msg._seen = true;
    if (msg.type === "approval") {
      send(ws, { type: "approval_reply", chatId, callId: msg.callId, allow: true });
      continue;
    }
    done = msg;
  }
  ws.close();
  const tools = inbox.filter((m) => m.type === "tool-started" && m.chatId === chatId);
  const intercepts = inbox.filter(
    (m) =>
      m.type === "tool-completed" &&
      m.chatId === chatId &&
      m.status === "error" &&
      /拦截|Ask 模式|Plan 模式|只读/.test(String(m.result || "")),
  );
  const approvals = inbox.filter((m) => m.type === "approval" && m.chatId === chatId);
  const expect = scoreExpect(cwd, task.expect);
  const row = {
    id: runId,
    task: task.id,
    model,
    policy,
    status: done.type === "done" ? done.status : "error",
    error: done.type === "error" ? done.message : undefined,
    durationMs: Date.now() - started,
    toolStarts: done.toolStarts ?? tools.length,
    intercepts: done.intercepts ?? intercepts.length,
    approvals: done.approvals ?? approvals.length,
    replays: done.replays ?? 0,
    pass: expect.ok && done.type === "done" && done.status !== "error",
    reasons: expect.reasons,
  };
  return row;
}

async function main() {
  const tasks = JSON.parse(readFileSync(TASKS_FILE, "utf8")).filter(
    (task) => !TASK_FILTER.size || TASK_FILTER.has(task.id),
  );
  if (!tasks.length) {
    console.error("没有匹配的任务");
    process.exit(2);
  }
  const probe = [];
  const ws = new WebSocket(WS_URL, { maxPayload: 8 * 1024 * 1024 });
  ws.on("message", (raw) => {
    try {
      probe.push(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolvePromise, reject) => {
    ws.once("open", resolvePromise);
    ws.once("error", reject);
  });
  send(ws, {
    type: "hello",
    token: TOKEN,
    client: { name: "policy-bench", version: "0.1.0" },
  });
  const ready = await waitFor(probe, (m) => m.type === "ready", "ready", 20_000);
  ws.close();
  const workspaceRoot = ready.workspaceRoot || ready.cwd;
  const rows = [];
  for (const task of tasks) {
    for (const model of MODELS) {
      for (const policy of POLICIES) {
        process.stdout.write(`RUN  ${task.id}  ${model}  ${policy}  `);
        try {
          const row = await runCase({ task, model, policy, workspaceRoot });
          rows.push(row);
          console.log(row.pass ? "PASS" : "FAIL", `${row.durationMs}ms`, `tools=${row.toolStarts}`, `appr=${row.approvals}`, `int=${row.intercepts}`);
          if (row.reasons?.length) console.log("     ", row.reasons.join("; "));
        } catch (err) {
          const row = {
            task: task.id,
            model,
            policy,
            pass: false,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          };
          rows.push(row);
          console.log("FAIL", row.error);
        }
      }
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(OUT_DIR, `${stamp}.json`);
  writeFileSync(out, JSON.stringify({ at: stamp, ws: WS_URL, models: MODELS, policies: POLICIES, rows }, null, 2));
  console.log(`写了 ${out}`);
  const failed = rows.filter((row) => !row.pass).length;
  console.log(`合计 ${rows.length}，未过 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
