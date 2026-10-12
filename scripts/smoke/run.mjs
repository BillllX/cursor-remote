#!/usr/bin/env node
// 冒烟汇总：按运行条件挑选已知冒烟，串行跑完后汇总 通过/失败/跳过/耗时，任一失败退出码为 1。
// 用法: npm run smoke -- [--list] [--ci] [--offline] [--only=a,b] [--real-key] [--timeout=秒]
//   --list      只列出各项和当前能否运行，不执行
//   --ci        只跑 ci:smoke 那一组（顺序与 ci:smoke 原先的 && 链一致）
//   --offline   只跑纯离线项
//   --only      只跑指定项（逗号分隔，可与上面组合）
//   --real-key  确认目标网关配了真实模型密钥，放行 real-key 项
//   --timeout   覆盖每项的超时
// 除 --list 外都会监听本地端口或连网关：只在测试机 / CI 上跑，不要在跑着线上服务的机器上跑。
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const NEEDS = {
  offline: "纯离线（只用本机回环上的假服务）",
  "self-gw": "自带网关（临时目录 + 临时测试用户，起在 127.0.0.1）",
  "gw-url": "需要已运行的网关：JIEBO_WS_URL + CURSOR_REMOTE_TOKEN（测试用户）",
  "real-key": "需要目标网关配好真实模型密钥（加 --real-key 确认）",
  "ui-kit": "需要 UI_KIT（playwright 套件目录），web 已按 /cursor-remote 构建",
};

const gw = (name) => ({ cmd: "npm", args: ["run", `smoke:${name}`, "-w", "gateway"] });
const node = (file, ...args) => ({ cmd: process.execPath, args: [`scripts/smoke/${file}`, ...args] });

const SMOKES = [
  { name: "assistant", ci: true, needs: ["offline"], timeout: 300, ...gw("assistant") },
  { name: "memory", ci: true, needs: ["offline"], timeout: 300, ...gw("memory") },
  { name: "turnfiles", ci: true, needs: ["offline"], timeout: 300, ...gw("turnfiles") },
  { name: "seghash", ci: true, needs: ["offline"], timeout: 300, ...gw("seghash") },
  { name: "loops", ci: true, needs: ["offline"], timeout: 300, ...gw("loops") },
  { name: "apns", ci: true, needs: ["offline"], timeout: 300, ...gw("apns") },
  { name: "native", ci: true, needs: ["offline"], timeout: 300, ...gw("native") },
  { name: "publish", ci: true, needs: ["offline"], timeout: 300, ...gw("publish") },
  {
    name: "ci-gateway",
    ci: true,
    needs: ["self-gw"],
    timeout: 600,
    note: "内含 slim / resume / workspace / multidevice",
    cmd: "bash",
    args: ["scripts/smoke/ci-gateway-smoke.sh"],
  },
  {
    name: "ui",
    needs: ["self-gw", "ui-kit"],
    timeout: 300,
    note: "登录态界面冒烟：假模型 + 临时网关 + 网页 + headless 浏览器",
    cmd: "bash",
    args: ["scripts/smoke/ui-smoke.sh"],
  },
  {
    name: "slim",
    needs: ["gw-url"],
    timeout: 300,
    note: "要管理员口令；SMOKE_USER_TOKEN 可选",
    ...node("slim-smoke.mjs"),
  },
  { name: "resume", needs: ["gw-url"], timeout: 300, ...node("resume-smoke.mjs") },
  { name: "workspace", needs: ["gw-url"], timeout: 300, ...node("workspace-smoke.mjs") },
  {
    name: "multidevice",
    needs: ["gw-url"],
    timeout: 300,
    note: "网关 providers.json 要有指向 FAKE_LLM_PORT 的 fake 提供方",
    ...node("multidevice-smoke.mjs"),
  },
  {
    name: "ios-noagent",
    needs: ["gw-url"],
    timeout: 300,
    note: "ios-smoke --skip-agent",
    ...node("ios-smoke.mjs", "--skip-agent"),
  },
  { name: "ios", needs: ["gw-url", "real-key"], timeout: 600, note: "含一轮 Cursor agent", ...node("ios-smoke.mjs") },
  { name: "loop", needs: ["gw-url", "real-key"], timeout: 300, note: "网关要配 MiniMax", ...node("loop-smoke.mjs") },
  {
    name: "native-e2e",
    needs: ["gw-url", "real-key"],
    timeout: 1800,
    note: "NATIVE_E2E_MODEL 指定第三方模型",
    ...node("native-e2e.mjs"),
  },
];

function parseArgs(argv) {
  const opts = { list: false, ci: false, offline: false, realKey: false, only: null, timeout: null };
  for (const arg of argv) {
    const [key, value] = arg.split(/=(.*)/s, 2);
    if (key === "--list") opts.list = true;
    else if (key === "--ci") opts.ci = true;
    else if (key === "--offline") opts.offline = true;
    else if (key === "--real-key") opts.realKey = true;
    else if (key === "--only" && value)
      opts.only = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (key === "--timeout" && Number(value) > 0) opts.timeout = Number(value);
    else {
      console.error(`不认识的参数：${arg}`);
      process.exit(2);
    }
  }
  if (opts.only) {
    const unknown = opts.only.filter((name) => !SMOKES.some((s) => s.name === name));
    if (unknown.length) {
      console.error(`没有这些冒烟：${unknown.join(", ")}。可选：${SMOKES.map((s) => s.name).join(", ")}`);
      process.exit(2);
    }
  }
  return opts;
}

function skipReason(smoke, opts) {
  if (opts.offline && !smoke.needs.includes("offline")) return "--offline 只跑纯离线项";
  const missing = [];
  if (smoke.needs.includes("gw-url")) {
    if (!process.env.JIEBO_WS_URL) missing.push("JIEBO_WS_URL");
    if (!process.env.CURSOR_REMOTE_TOKEN) missing.push("CURSOR_REMOTE_TOKEN");
  }
  if (smoke.needs.includes("real-key") && !opts.realKey) missing.push("--real-key");
  if (smoke.needs.includes("ui-kit") && !process.env.UI_KIT) missing.push("UI_KIT");
  return missing.length ? `缺 ${missing.join("、")}` : null;
}

let current = null;

// 单独成组（detached）后终端的 Ctrl-C 到不了子进程，要手动转发
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    current?.kill("SIGTERM");
    process.exit(130);
  });
}

function run(smoke, timeoutSec) {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(smoke.cmd, smoke.args, { cwd: ROOT, stdio: "inherit", detached: true });
    let timedOut = false;
    let settled = false;
    let killer;
    // 杀整个进程组：ci-gateway-smoke.sh 在后台起的网关也在组里
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    current = { kill };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killer = setTimeout(() => kill("SIGKILL"), 5000);
    }, timeoutSec * 1000);
    const finish = (detail) => {
      if (settled) return;
      settled = true;
      current = null;
      clearTimeout(timer);
      clearTimeout(killer);
      // 主进程退出后组里可能还有残留（比如后台起的服务），一并清掉
      kill("SIGKILL");
      const seconds = (performance.now() - started) / 1000;
      if (timedOut) detail = `超时（${timeoutSec}s）`;
      done({ status: detail ? "失败" : "通过", seconds, detail });
    };
    child.on("error", (error) => finish(error.message));
    child.on("exit", (code, signal) => finish(signal ? `被信号 ${signal} 终止` : code ? `退出码 ${code}` : ""));
  });
}

const opts = parseArgs(process.argv.slice(2));
const selected = SMOKES.filter((s) => (!opts.ci || s.ci) && (!opts.only || opts.only.includes(s.name)));

if (opts.list) {
  for (const [tag, desc] of Object.entries(NEEDS)) console.log(`${tag.padEnd(9)} ${desc}`);
  console.log("");
  for (const s of selected) {
    const reason = skipReason(s, opts);
    const state = reason ? `跳过：${reason}` : "可运行";
    console.log(`${s.name.padEnd(12)} ${s.needs.join("+").padEnd(16)} ${state}${s.note ? `  （${s.note}）` : ""}`);
  }
  process.exit(0);
}

const results = [];
for (const [i, smoke] of selected.entries()) {
  const reason = skipReason(smoke, opts);
  if (reason) {
    results.push({ name: smoke.name, status: "跳过", seconds: 0, detail: reason });
    continue;
  }
  console.log(`\n── [${i + 1}/${selected.length}] ${smoke.name}：${smoke.cmd} ${smoke.args.join(" ")}`);
  results.push({ name: smoke.name, ...(await run(smoke, opts.timeout ?? smoke.timeout)) });
}

console.log("\n== 冒烟汇总");
for (const r of results) {
  const time = r.status === "跳过" ? "" : `${r.seconds.toFixed(1)}s`;
  console.log(`${r.status}  ${r.name.padEnd(12)} ${time.padStart(7)}  ${r.detail}`);
}
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`通过 ${count("通过")}，失败 ${count("失败")}，跳过 ${count("跳过")}`);
process.exit(count("失败") ? 1 : 0);
