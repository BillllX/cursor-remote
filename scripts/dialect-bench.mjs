#!/usr/bin/env node
// 中文系方言 overlay 对照：同一任务、同一模型、policy=baseline，只翻转 dialect。
//
// 用法:
//   CURSOR_REMOTE_TOKEN=xxx npm run bench:dialect -- --models kimi-k3-max,glm-5.2
//   node scripts/dialect-bench.mjs --plan
//   node scripts/dialect-bench.mjs --from scripts/dialect-bench/results/<stamp>.json
//
// 默认连本机 ws://127.0.0.1:8787。不要把 composer 放进默认模型：它吃不到方言 overlay。
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "scripts/dialect-bench/fixtures");
const TASKS_FILE = join(ROOT, "scripts/dialect-bench/tasks.json");
const OUT_DIR = join(ROOT, "scripts/dialect-bench/results");
const CHINESE_VENDORS = /glm|zhipu|kimi|moonshot|deepseek|qwen/;
const KNOWN_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "grep",
  "glob",
  "glob_file_search",
  "ls",
  "list_dir",
  "listdir",
  "edit",
  "strreplace",
  "applypatch",
  "apply_patch",
  "write",
  "writefile",
  "createfile",
  "editnotebook",
  "delete",
  "unlink",
  "shell",
  "bash",
  "terminal",
  "command",
  "task",
  "todo",
  "createplan",
  "create_plan",
  "semsearch",
  "codebase_search",
  "web_search",
  "web_fetch",
  "fetch",
  "mcp",
]);
const SHELL_EDIT =
  /\b(sed|awk|perl|ruby\s+-e|python(?:3)?\s+-c|tee\b|truncate\b)|(?:^|[;&|]\s*)(?:cat|echo|printf)\b[\s\S]{0,80}(?:>|>>)|<<-?\s*['"]?EOF|dd\s+of=/i;
const EDIT_TOOLS = /^(edit|strreplace|applypatch|apply_patch|write|writefile|createfile|editnotebook)$/i;
const SHELL_TOOLS = /^(shell|bash|terminal|command)$/i;

const WS_URL = process.env.JIEBO_WS_URL || process.env.DIALECT_BENCH_WS || "ws://127.0.0.1:8787";
const TOKEN = (process.env.CURSOR_REMOTE_TOKEN || "").trim();
const POLICY = "baseline";

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || !process.argv[idx + 1]) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const PLAN_ONLY = hasFlag("--plan");
const FROM = argValue("--from", "");
const MODELS = argValue("--models", process.env.DIALECT_BENCH_MODELS || "kimi-k3")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const DIALECTS = argValue("--dialects", "off,on")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item === "on" || item === "off");
const TASK_FILTER = new Set(
  argValue("--tasks", "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const REPEATS = Math.max(1, Number(argValue("--repeats", "1")) || 1);

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

function loadTasks() {
  return JSON.parse(readFileSync(TASKS_FILE, "utf8")).filter(
    (task) => !TASK_FILTER.size || TASK_FILTER.has(task.id),
  );
}

function fixtureDir(task) {
  const name = String(task?.fixture || "mini-lib").replace(/[^a-z0-9_-]+/gi, "");
  return join(FIXTURES, name || "mini-lib");
}

function copyFixture(dest, src) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function readRel(root, rel) {
  const path = join(root, rel);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return readFileSync(path, "utf8");
}

function walkFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === ".cursor" || ent.name === "node_modules") continue;
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(path, base));
    else out.push(relative(base, path));
  }
  return out;
}

function changedRels(cwd, src) {
  const now = walkFiles(cwd);
  const orig = walkFiles(src);
  const changed = [];
  for (const rel of new Set([...now, ...orig])) {
    if (readRel(cwd, rel) !== readRel(src, rel)) changed.push(rel);
  }
  return changed.sort();
}

function cjkRatio(text) {
  const chars = [...String(text || "")].filter((ch) => !/\s/.test(ch));
  if (!chars.length) return 0;
  const cjk = chars.filter((ch) => /[\u3400-\u9fff]/.test(ch)).length;
  return cjk / chars.length;
}

function toolArgsText(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function attemptedInventedText(text) {
  const body = String(text || "");
  return /apply_patch|\bWrite\b|\bStrReplace\b|\bEditNotebook\b/.test(body);
}

function scoreExpect(cwd, src, expect = {}, assistantText = "") {
  const reasons = [];
  let ok = true;
  if (expect.unchanged) {
    const changed = changedRels(cwd, src);
    if (changed.length) {
      ok = false;
      reasons.push(`Ask 不该改文件: ${changed.join(", ")}`);
    }
  }
  for (const [rel, needle] of Object.entries(expect.filesContain || {})) {
    const body = readRel(cwd, rel) || "";
    if (!body.toLowerCase().includes(String(needle).toLowerCase())) {
      ok = false;
      reasons.push(`${rel} 缺少 ${needle}`);
    }
  }
  for (const rel of expect.unchangedFiles || []) {
    const now = readRel(cwd, rel);
    const orig = readRel(src, rel);
    if (now !== orig) {
      ok = false;
      reasons.push(`${rel} 不该被改`);
    }
  }
  if (expect.noAbsPath && existsSync(expect.noAbsPath)) {
    ok = false;
    reasons.push(`写到了工作区外 ${expect.noAbsPath}`);
  }
  if (typeof expect.minCjk === "number") {
    const ratio = cjkRatio(assistantText);
    if (ratio < expect.minCjk) {
      ok = false;
      reasons.push(`中文占比 ${ratio.toFixed(2)} < ${expect.minCjk}`);
    }
  }
  let pastedDump = false;
  if (expect.noPasteNeedle && String(assistantText || "").includes(expect.noPasteNeedle)) {
    pastedDump = true;
    if (expect.strictMethod) {
      ok = false;
      reasons.push("把 dump 金丝贴进了回复");
    }
  }
  return { ok, reasons, pastedDump };
}

function metricsFromTools(tools) {
  let editUses = 0;
  let shellUses = 0;
  let shellEdits = 0;
  const invented = [];
  for (const tool of tools) {
    const name = String(tool.name || "");
    const key = name.trim().toLowerCase();
    if (!KNOWN_TOOLS.has(key)) invented.push(name);
    if (EDIT_TOOLS.test(key)) editUses += 1;
    if (SHELL_TOOLS.test(key)) {
      shellUses += 1;
      if (SHELL_EDIT.test(toolArgsText(tool.args))) shellEdits += 1;
    }
  }
  return { editUses, shellUses, shellEdits, inventedTools: invented };
}

async function runCase({ task, model, dialectOn, workspaceRoot, repeat }) {
  const arm = dialectOn ? "on" : "off";
  const src = fixtureDir(task);
  if (!existsSync(src)) throw new Error(`没有夹具 ${src}`);
  const runId = `${task.id}-${arm}-${model.replace(/[^\w.-]+/g, "_")}-r${repeat}-${randomUUID().slice(0, 6)}`;
  const cwd = join(workspaceRoot, ".dialect-bench", runId);
  copyFixture(cwd, src);
  if (task.expect?.noAbsPath) rmSync(task.expect.noAbsPath, { force: true });
  const chatId = `dialect-${randomUUID().slice(0, 8)}`;
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
    client: { name: "dialect-bench", version: "0.1.0", caps: ["sync_chat"] },
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
  send(ws, { type: "set_policy", policy: POLICY, chatId });
  const started = Date.now();
  send(ws, {
    type: "prompt",
    text: task.prompt,
    model,
    mode: task.mode,
    chatId,
    confirmWrites: Boolean(task.confirmWrites),
    policy: POLICY,
    dialect: dialectOn,
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
  const assistantText = inbox
    .filter((m) => m.type === "text-delta" && m.chatId === chatId)
    .map((m) => m.text || "")
    .join("");
  const thinkingText = inbox
    .filter((m) => m.type === "thinking-delta" && m.chatId === chatId)
    .map((m) => m.text || "")
    .join("");
  const toolMetrics = metricsFromTools(tools);
  const allowed = new Set(
    task.expect?.allowedFiles || Object.keys(task.expect?.filesContain || {}),
  );
  const changed = changedRels(cwd, src);
  const collateral = changed.filter((rel) => (allowed.size ? !allowed.has(rel) : !Object.keys(task.expect?.filesContain || {}).includes(rel)));
  const expect = scoreExpect(cwd, src, task.expect, assistantText);
  const inventedAttempt = toolMetrics.inventedTools.length > 0;
  const mentionedInvented = attemptedInventedText(`${assistantText}\n${thinkingText}`);
  const method = {
    noShellEdit: toolMetrics.shellEdits === 0,
    noInvented: !inventedAttempt,
    noPaste: !expect.pastedDump,
    noTmp: !(task.expect?.noAbsPath && existsSync(task.expect.noAbsPath)),
    noCollateral: collateral.length === 0,
  };
  const methodHits = Object.values(method).filter(Boolean).length;
  const outcomeOk = Object.entries(task.expect?.filesContain || {}).every(([rel, needle]) => {
    const body = readRel(cwd, rel) || "";
    return body.toLowerCase().includes(String(needle).toLowerCase());
  });
  let pass = expect.ok && done.type === "done" && done.status !== "error";
  if (task.expect?.strictMethod) {
    const methodOk =
      method.noShellEdit && method.noInvented && method.noPaste && method.noTmp && method.noCollateral;
    pass = outcomeOk && methodOk && done.type === "done" && done.status !== "error";
    if (!methodOk) {
      if (toolMetrics.shellEdits) expect.reasons.push(`shell 改文件 ${toolMetrics.shellEdits} 次`);
      if (inventedAttempt) expect.reasons.push("调用了非 Cursor 工具名");
      if (expect.pastedDump) expect.reasons.push("把 dump 金丝贴进了回复");
      if (collateral.length) expect.reasons.push(`误伤 ${collateral.join(", ")}`);
    }
  }
  return {
    id: runId,
    task: task.id,
    model,
    policy: POLICY,
    dialect: arm,
    repeat,
    status: done.type === "done" ? done.status : "error",
    error: done.type === "error" ? done.message : undefined,
    durationMs: Date.now() - started,
    toolStarts: done.toolStarts ?? tools.length,
    toolNames: tools.map((tool) => tool.name),
    editUses: toolMetrics.editUses,
    shellUses: toolMetrics.shellUses,
    shellEdits: toolMetrics.shellEdits,
    inventedTools: toolMetrics.inventedTools.length,
    inventedNames: toolMetrics.inventedTools,
    inventedAttempt,
    mentionedInvented,
    pastedDump: expect.pastedDump,
    cjkRatio: Number(cjkRatio(assistantText).toFixed(3)),
    changedFiles: changed,
    collateralFiles: collateral.length,
    collateralNames: collateral,
    escapedTmp: Boolean(task.expect?.noAbsPath && existsSync(task.expect.noAbsPath)),
    methodHits,
    method,
    outcomeOk,
    pass,
    reasons: expect.reasons,
  };
}

function mean(nums) {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function rate(rows, pred) {
  if (!rows.length) return null;
  return rows.filter(pred).length / rows.length;
}

function fmtPct(n) {
  if (n == null) return "—";
  return `${Math.round(n * 100)}%`;
}

function fmtNum(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function fmtDelta(on, off, { invert = false, digits = 2, kind = "num" } = {}) {
  if (on == null || off == null) return "—";
  const d = on - off;
  const better = invert ? d < 0 : d > 0;
  const worse = invert ? d > 0 : d < 0;
  const body = kind === "pct" ? `${d >= 0 ? "+" : ""}${Math.round(d * 100)}pt` : `${d >= 0 ? "+" : ""}${d.toFixed(digits)}`;
  if (Math.abs(d) < 1e-9) return `${body} 平`;
  return `${body} ${better ? "↑好" : worse ? "↓差" : ""}`.trim();
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function compare(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.task}|${row.model}`;
    if (!groups.has(key)) groups.set(key, { task: row.task, model: row.model, on: [], off: [] });
    const g = groups.get(key);
    if (row.dialect === "on") g.on.push(row);
    else g.off.push(row);
  }
  const pairs = [];
  for (const g of groups.values()) {
    const offPass = rate(g.off, (r) => r.pass);
    const onPass = rate(g.on, (r) => r.pass);
    const offShell = mean(g.off.map((r) => r.shellEdits));
    const onShell = mean(g.on.map((r) => r.shellEdits));
    const offInv = mean(g.off.map((r) => r.inventedTools));
    const onInv = mean(g.on.map((r) => r.inventedTools));
    const offCjk = mean(g.off.map((r) => r.cjkRatio));
    const onCjk = mean(g.on.map((r) => r.cjkRatio));
    const offCol = mean(g.off.map((r) => r.collateralFiles));
    const onCol = mean(g.on.map((r) => r.collateralFiles));
    const offDur = mean(g.off.map((r) => r.durationMs));
    const onDur = mean(g.on.map((r) => r.durationMs));
    const offEdit = mean(g.off.map((r) => r.editUses));
    const onEdit = mean(g.on.map((r) => r.editUses));
    const offMethod = mean(g.off.map((r) => r.methodHits));
    const onMethod = mean(g.on.map((r) => r.methodHits));
    const offPaste = rate(g.off, (r) => r.pastedDump);
    const onPaste = rate(g.on, (r) => r.pastedDump);
    const offOut = rate(g.off, (r) => r.outcomeOk);
    const onOut = rate(g.on, (r) => r.outcomeOk);
    const offEsc = rate(g.off, (r) => r.escapedTmp);
    const onEsc = rate(g.on, (r) => r.escapedTmp);
    const passUp = (onPass ?? 0) - (offPass ?? 0);
    const shellDown = (offShell ?? 0) - (onShell ?? 0);
    const invDown = (offInv ?? 0) - (onInv ?? 0);
    const colDown = (offCol ?? 0) - (onCol ?? 0);
    const cjkUp = (onCjk ?? 0) - (offCjk ?? 0);
    let verdict = "平";
    if (passUp < -0.01) verdict = "回退";
    else if (passUp > 0.01 || shellDown > 0.01 || invDown > 0.01 || colDown > 0.01 || cjkUp > 0.03 || (onMethod ?? 0) - (offMethod ?? 0) > 0.2) {
      verdict = passUp < 0 ? "混杂" : "更好";
    } else if (passUp < 0) verdict = "回退";
    pairs.push({
      task: g.task,
      model: g.model,
      offPass,
      onPass,
      offShell,
      onShell,
      offInv,
      onInv,
      offCjk,
      onCjk,
      offCol,
      onCol,
      offDur,
      onDur,
      offEdit,
      onEdit,
      offEsc,
      onEsc,
      offMethod,
      onMethod,
      offPaste,
      onPaste,
      offOut,
      onOut,
      verdict,
    });
  }
  const overall = {
    offPass: rate(rows.filter((r) => r.dialect === "off"), (r) => r.pass),
    onPass: rate(rows.filter((r) => r.dialect === "on"), (r) => r.pass),
    offShell: mean(rows.filter((r) => r.dialect === "off").map((r) => r.shellEdits)),
    onShell: mean(rows.filter((r) => r.dialect === "on").map((r) => r.shellEdits)),
    offInv: mean(rows.filter((r) => r.dialect === "off").map((r) => r.inventedTools)),
    onInv: mean(rows.filter((r) => r.dialect === "on").map((r) => r.inventedTools)),
    offCjk: mean(rows.filter((r) => r.dialect === "off").map((r) => r.cjkRatio)),
    onCjk: mean(rows.filter((r) => r.dialect === "on").map((r) => r.cjkRatio)),
    offCol: mean(rows.filter((r) => r.dialect === "off").map((r) => r.collateralFiles)),
    onCol: mean(rows.filter((r) => r.dialect === "on").map((r) => r.collateralFiles)),
    offDur: mean(rows.filter((r) => r.dialect === "off").map((r) => r.durationMs)),
    onDur: mean(rows.filter((r) => r.dialect === "on").map((r) => r.durationMs)),
  };
  return { pairs, overall };
}

function printComparison(rows) {
  const { pairs, overall } = compare(rows);
  console.log("");
  console.log("对照  dialect off → on   policy=baseline");
  console.log(
    [
      pad("任务", 16),
      pad("模型", 16),
      pad("通过", 18),
      pad("shell改文件", 16),
      pad("编造工具", 16),
      pad("中文比", 16),
      pad("误伤文件", 16),
      pad("判定", 6),
    ].join(" "),
  );
  for (const p of pairs) {
    console.log(
      [
        pad(p.task, 16),
        pad(p.model, 16),
        pad(`${fmtPct(p.offPass)}→${fmtPct(p.onPass)} ${fmtDelta(p.onPass, p.offPass, { kind: "pct" })}`, 18),
        pad(`${fmtNum(p.offShell, 1)}→${fmtNum(p.onShell, 1)} ${fmtDelta(p.onShell, p.offShell, { invert: true, digits: 1 })}`, 16),
        pad(`${fmtNum(p.offInv, 1)}→${fmtNum(p.onInv, 1)} ${fmtDelta(p.onInv, p.offInv, { invert: true, digits: 1 })}`, 16),
        pad(`${fmtPct(p.offCjk)}→${fmtPct(p.onCjk)}`, 16),
        pad(`${fmtNum(p.offCol, 1)}→${fmtNum(p.onCol, 1)} ${fmtDelta(p.onCol, p.offCol, { invert: true, digits: 1 })}`, 16),
        pad(p.verdict, 6),
      ].join(" "),
    );
  }
  console.log("");
  console.log("合计");
  console.log(`  通过率     ${fmtPct(overall.offPass)} → ${fmtPct(overall.onPass)}   ${fmtDelta(overall.onPass, overall.offPass, { kind: "pct" })}`);
  console.log(`  shell改文件 ${fmtNum(overall.offShell, 2)} → ${fmtNum(overall.onShell, 2)}   ${fmtDelta(overall.onShell, overall.offShell, { invert: true })}`);
  console.log(`  编造工具   ${fmtNum(overall.offInv, 2)} → ${fmtNum(overall.onInv, 2)}   ${fmtDelta(overall.onInv, overall.offInv, { invert: true })}`);
  console.log(`  中文占比   ${fmtPct(overall.offCjk)} → ${fmtPct(overall.onCjk)}`);
  console.log(`  误伤文件   ${fmtNum(overall.offCol, 2)} → ${fmtNum(overall.onCol, 2)}   ${fmtDelta(overall.onCol, overall.offCol, { invert: true })}`);
  console.log(`  耗时 ms    ${fmtNum(overall.offDur, 0)} → ${fmtNum(overall.onDur, 0)}   （参考，不作为成败）`);
  const methodPairs = pairs.filter((p) => p.offMethod != null || p.onMethod != null);
  if (methodPairs.length) {
    console.log("");
    console.log("组合题方法分（5 项：不 shell 改文件 / 不编工具 / 不贴 dump / 不写 /tmp / 不误伤）");
    for (const p of methodPairs) {
      console.log(
        `  ${pad(p.task, 16)} 落地 ${fmtPct(p.offOut)}→${fmtPct(p.onOut)}  方法 ${fmtNum(p.offMethod, 1)}→${fmtNum(p.onMethod, 1)}  贴全文 ${fmtPct(p.offPaste)}→${fmtPct(p.onPaste)}`,
      );
    }
  }
  const wins = pairs.filter((p) => p.verdict === "更好").length;
  const losses = pairs.filter((p) => p.verdict === "回退").length;
  console.log(`  格子       更好 ${wins} / 回退 ${losses} / 共 ${pairs.length}`);
  return { pairs, overall };
}

function printPlan(tasks) {
  console.log("方言对照实验");
  console.log("  冻结: policy=baseline（不跟策略层骨架混在一起）");
  console.log("  因子: 模型 × dialect(off/on) × 任务");
  console.log(`  模型: ${MODELS.join(", ")}`);
  console.log(`  臂:   ${DIALECTS.join(", ")}`);
  console.log(`  重复: ${REPEATS}`);
  console.log(`  格子: ${tasks.length} 任务 × ${MODELS.length} 模型 × ${DIALECTS.length} 臂 × ${REPEATS} = ${tasks.length * MODELS.length * DIALECTS.length * REPEATS} 次`);
  console.log("");
  console.log("任务");
  for (const task of tasks) {
    console.log(`  ${pad(task.id, 16)} mode=${task.mode}  ${task.prompt.slice(0, 48)}`);
  }
  console.log("");
  console.log("主指标（方言应该动这些，不该拿耗时当胜负）");
  console.log("  pass            任务断言过");
  console.log("  shellEdits      shell 里 sed/awk/tee/python -c/重定向 改文件  → 应下降");
  console.log("  inventedTools   不在 Cursor 工具表里的名字                       → 应下降");
  console.log("  cjkRatio        回复汉字占比（zh-ask）                           → 应上升");
  console.log("  collateralFiles 预期之外被改的文件                               → 应下降");
  console.log("  combo-bait      六件事叠在一轮：落地分 + 方法分 5 项。strictMethod 两边都落地仍可能一过一不过");
  for (const model of MODELS) {
    if (!CHINESE_VENDORS.test(model.toLowerCase())) {
      console.log(`警告: ${model} 不是中文系，overlay 是空的，on/off 会几乎一样`);
    }
  }
}

async function probeWorkspaceRoot() {
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
    client: { name: "dialect-bench", version: "0.1.0" },
  });
  const ready = await waitFor(probe, (m) => m.type === "ready", "ready", 20_000);
  ws.close();
  return ready.workspaceRoot || ready.cwd;
}

async function main() {
  const tasks = loadTasks();
  if (!tasks.length) {
    console.error("没有匹配的任务");
    process.exit(2);
  }

  if (FROM) {
    const payload = JSON.parse(readFileSync(resolve(FROM), "utf8"));
    printComparison(payload.rows || []);
    return;
  }

  printPlan(tasks);
  if (PLAN_ONLY) return;

  if (!TOKEN) {
    console.error("缺少 CURSOR_REMOTE_TOKEN");
    process.exit(2);
  }

  const workspaceRoot = await probeWorkspaceRoot();
  const rows = [];
  for (const task of tasks) {
    for (const model of MODELS) {
      for (const arm of DIALECTS) {
        for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
          process.stdout.write(`RUN  ${task.id}  ${model}  dialect=${arm}  r${repeat}  `);
          try {
            const row = await runCase({
              task,
              model,
              dialectOn: arm === "on",
              workspaceRoot,
              repeat,
            });
            rows.push(row);
            console.log(
              row.pass ? "PASS" : "FAIL",
              `${row.durationMs}ms`,
              `edit=${row.editUses}`,
              `shellEdit=${row.shellEdits}`,
              `invented=${row.inventedTools}`,
              `cjk=${row.cjkRatio}`,
              `collateral=${row.collateralFiles}`,
              row.methodHits != null ? `method=${row.methodHits}/5` : "",
              row.pastedDump ? "PASTE" : "",
            );
            if (row.reasons?.length) console.log("     ", row.reasons.join("; "));
          } catch (err) {
            const row = {
              task: task.id,
              model,
              dialect: arm,
              repeat,
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
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const summary = compare(rows);
  const out = join(OUT_DIR, `${stamp}.json`);
  writeFileSync(
    out,
    JSON.stringify(
      {
        at: stamp,
        ws: WS_URL,
        policy: POLICY,
        models: MODELS,
        dialects: DIALECTS,
        repeats: REPEATS,
        summary,
        rows,
      },
      null,
      2,
    ),
  );
  printComparison(rows);
  console.log(`写了 ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
