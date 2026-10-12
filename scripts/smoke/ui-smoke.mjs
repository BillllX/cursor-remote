#!/usr/bin/env node
// 登录态界面冒烟：真网页 + 真网关 + 假模型，用 headless 浏览器走一遍登录、各浮层、发消息、刷新恢复、改名删除、管理员统计。
// 一般由 scripts/smoke/ui-smoke.sh 调用（它负责起假模型、临时网关和网页）。
// playwright 不进仓库依赖：从 UI_KIT 目录（含 node_modules/playwright、browsers、libs）加载。
// 用法:
//   node scripts/smoke/ui-smoke.mjs --fake-llm <端口>      # 只起假模型（OpenAI 兼容，流式回声）
//   UI_KIT=… UI_URL=… UI_USER_TOKEN=… UI_ADMIN_TOKEN=… UI_SHOTS=… UI_WORKSPACE=… node scripts/smoke/ui-smoke.mjs
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const ECHO_PREFIX = "回声：";
// 网关没有 Cursor 密钥、只配了第三方假模型：有可用模型，不该出现这条提示
const NO_KEY_HINT = "还没配模型密钥";

if (process.argv[2] === "--fake-llm") {
  startFakeLlm(Number(process.argv[3]));
} else {
  await main();
}

// 假模型：/v1/chat/completions 把最后一条用户消息原样回声，流式时每 60ms 吐一小段
function startFakeLlm(port) {
  const lastUserText = (body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = [...messages].reverse().find((m) => m?.role === "user");
    const content = last?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
    return "";
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "m1", object: "model" }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
      const text = `${ECHO_PREFIX}${lastUserText(body).trim().slice(0, 400)}`;
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fake",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (let i = 0; i < text.length; i += 4) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(i, i + 4) } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 60));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(port, "127.0.0.1", () => console.log(`假模型 http://127.0.0.1:${port}/v1`));
}

async function main() {
  const env = (name) => {
    const value = (process.env[name] || "").trim();
    if (!value) {
      console.error(`缺少 ${name}`);
      process.exit(2);
    }
    return value;
  };
  const UI_KIT = env("UI_KIT");
  const URL_ROOT = env("UI_URL");
  const USER_TOKEN = env("UI_USER_TOKEN");
  const ADMIN_TOKEN = env("UI_ADMIN_TOKEN");
  const SHOTS = env("UI_SHOTS");
  const WORKSPACE = env("UI_WORKSPACE");
  const FAKE_MODEL = process.env.UI_FAKE_MODEL || "fake:m1";
  mkdirSync(SHOTS, { recursive: true });

  const require = createRequire(resolve(UI_KIT, "node_modules", "index.js"));
  const { chromium } = require("playwright");

  const nonce = randomBytes(4).toString("hex");
  const question = `UI冒烟 ${nonce} 你好`;
  const renamed = `UI冒烟改名 ${nonce}`;

  const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);

  const results = [];
  const problems = [];
  let current = "启动";
  // 允许名单：只放确认与产品无关、且无法在页面侧避免的噪音
  const ALLOWED_CONSOLE = [];
  page.on("pageerror", (error) => problems.push({ step: current, kind: "pageerror", text: error.message }));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (ALLOWED_CONSOLE.some((rule) => current.startsWith(rule.step) && rule.re.test(text))) return;
    problems.push({ step: current, kind: "console.error", text });
  });
  page.on("dialog", (dialog) => {
    problems.push({ step: current, kind: "dialog", text: `${dialog.type()}: ${dialog.message()}` });
    void dialog.accept();
  });

  let aborted = false;
  async function step(id, name, fn, { shot = false, critical = false } = {}) {
    current = id;
    if (aborted) {
      results.push({ id, name, status: "跳过", ms: 0, detail: "前置步骤失败" });
      return;
    }
    const started = performance.now();
    try {
      const detail = await fn();
      const ms = performance.now() - started;
      results.push({ id, name, status: "通过", ms, detail: detail || "" });
      if (shot) await snap(`${id}-ok`);
    } catch (error) {
      const ms = performance.now() - started;
      const shown = await page
        .locator(".error-line:visible, .notice-line:visible")
        .allInnerTexts()
        .catch(() => []);
      const detail = [
        String(error?.message || error).split("\n")[0],
        ...shown.map((t) => `页面提示「${t.trim()}」`),
      ].join("；");
      results.push({ id, name, status: "失败", ms, detail });
      await snap(`${id}-FAIL`);
      if (critical) aborted = true;
      // 尽量回到干净状态，别让一个浮层没关拖垮后面所有步骤
      for (let i = 0; i < 3; i++) await page.keyboard.press("Escape").catch(() => {});
    }
  }
  async function snap(name) {
    await page
      .screenshot({ path: join(SHOTS, `${name}.jpg`), type: "jpeg", quality: 60 })
      .catch((error) => console.error(`截图失败 ${name}: ${error.message}`));
  }

  const loginGate = page.locator(".login-gate .login-card");
  const passwordInput = loginGate.locator('input[type="password"]');
  const sidebar = page.locator("aside.sidebar");
  const activity = page.getByRole("navigation", { name: "活动栏" });
  const railButton = (label) => activity.getByRole("button", { name: label, exact: true });
  const settingsToggle = page.locator(".side-foot .side-foot-btn:has(.side-foot-cwd)");
  const composer = page.locator("textarea.composer-input");
  const stopButton = page.locator("button.send.stop");
  const sendButton = page.locator('button.send[type="submit"]');
  const projGroup = sidebar
    .locator(".chat-group")
    .filter({ has: page.locator(".chat-group-name", { hasText: WORKSPACE }) });

  async function login(token) {
    await passwordInput.fill(token);
    await loginGate.locator('button[type="submit"]').click();
  }
  async function expectMain() {
    await sidebar.waitFor({ state: "visible", timeout: 20_000 });
    await loginGate.waitFor({ state: "detached" });
    await page.locator(".side-foot .dot.on, .side-foot .dot.busy").waitFor({ state: "visible", timeout: 20_000 });
  }
  // 打开后可见、关闭后消失（浮层收起有 280ms 动画，之后才卸载）
  async function overlay(open, box, close) {
    await open();
    await box.waitFor({ state: "visible" });
    await page.waitForTimeout(150);
    await close();
    await box.waitFor({ state: "hidden" });
    await sidebar.waitFor({ state: "visible" });
  }
  const esc = () => page.keyboard.press("Escape");
  const openBox = (selector) => page.locator(`.search-overlay.open ${selector}`);
  async function expectNoKeyHint() {
    const n = await page.getByText(NO_KEY_HINT).count();
    if (n) throw new Error(`有可用的第三方模型却出现 ${n} 处“${NO_KEY_HINT}”提示`);
  }

  const started = performance.now();
  // a. 登录
  await step(
    "a1",
    "打开首页出现登录页",
    async () => {
      await page.goto(URL_ROOT, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await passwordInput.waitFor({ state: "visible", timeout: 20_000 });
    },
    { shot: true, critical: true },
  );
  await step("a2", "错误口令显示错误", async () => {
    await login(`wrong-${nonce}`);
    await loginGate.locator(".error-line").waitFor({ state: "visible", timeout: 20_000 });
    if (await sidebar.count()) throw new Error("错误口令却进了主界面");
    return (await loginGate.locator(".error-line").innerText()).trim();
  });
  await step(
    "a3",
    "普通租户登录进入主界面",
    async () => {
      await login(USER_TOKEN);
      await expectMain();
    },
    { shot: true, critical: true },
  );
  await step("a4", "假模型环境下不提示没配模型密钥", async () => {
    await page.waitForTimeout(1000);
    await expectNoKeyHint();
  });

  // b. 各浮层：打开可见，Esc / 关闭后消失
  await step("b1", "命令面板（⌘P 打开文件）", () =>
    overlay(() => page.keyboard.press("Control+p"), openBox('.search-box[role="dialog"][aria-label="打开文件"]'), esc),
  );
  await step("b2", "会话搜索（⌘K）", () =>
    overlay(() => page.keyboard.press("Control+k"), openBox('.search-box[role="dialog"][aria-label="搜索对话"]'), esc),
  );
  await step("b3", "文件浮层", () =>
    overlay(
      () => railButton("文件").click(),
      page.locator('.files-overlay.open .files-browser[role="dialog"]'),
      () => page.locator(".files-overlay.open .files-browser-close").click(),
    ),
  );
  // 1440 宽是停靠模式：弹层收进侧栏列，是对话框但不是模态
  await step("b4", "全文搜索", () =>
    overlay(() => railButton("搜索").click(), openBox('.grep-box[role="dialog"]:not([aria-modal])'), esc),
  );
  await step("b5", "终端", () =>
    overlay(() => railButton("终端").click(), openBox('.terminal-box[role="dialog"]:not([aria-modal])'), esc),
  );
  await step("b6", "循环", () => overlay(() => railButton("Loop").click(), openBox(".loop-box"), esc));
  await step("b7", "工作区选择（新对话）：列表撑满对话框、对话框不出屏", () =>
    overlay(
      () => sidebar.locator(".side-actions .new-chat.primary").click(),
      openBox(".workspace-dialog"),
      async () => {
        const box = await openBox(".workspace-dialog").evaluate((dialog) => {
          const { getComputedStyle, innerHeight } = globalThis;
          const list = dialog.querySelector(".workspace-choices");
          return {
            maxHeight: list ? getComputedStyle(list).maxHeight : "",
            bottom: dialog.getBoundingClientRect().bottom,
            listBottom: list ? list.getBoundingClientRect().bottom : 0,
            vh: innerHeight,
          };
        });
        if (box.maxHeight !== "none") throw new Error(`工作区列表 max-height 是 ${box.maxHeight}，应撑满对话框`);
        if (box.bottom > box.vh || box.listBottom > box.bottom + 1)
          throw new Error(`对话框超出屏幕：${JSON.stringify(box)}`);
        await esc();
      },
    ),
  );
  await step("b8", "设置面板", () =>
    overlay(
      () => settingsToggle.click(),
      sidebar.locator(".side-settings"),
      () => settingsToggle.click(),
    ),
  );

  // 构建产物里的通用按下态：CDP 强制 :active，普通按钮取 --hover-strong，自己画按下色的（StallHint 停止）不被它盖掉
  await step("b9", "按下态不盖掉自带按下色的按钮", async () => {
    const stopClass = await page.evaluate(() => {
      for (const sheet of globalThis.document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules) {
          const m = rule.selectorText?.match(/^\.([\w-]*StallHint[\w-]*stop[\w-]*):active$/);
          if (m) return m[1];
        }
      }
      return "";
    });
    if (!stopClass) throw new Error("产物里找不到 StallHint 停止按钮的 :active 规则");
    await page.evaluate((cls) => {
      const { document } = globalThis;
      const host = document.createElement("div");
      host.id = "press-probe";
      host.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none";
      host.innerHTML =
        `<button id="pp-plain" type="button">a</button>` +
        `<button id="pp-stop" type="button" class="${cls}" data-own-press>b</button>` +
        `<span id="pp-gray" style="background: var(--hover-strong)"></span>` +
        `<span id="pp-red" style="background: color-mix(in srgb, var(--danger-fg) 14%, var(--danger-bg))"></span>`;
      document.body.appendChild(host);
    }, stopClass);
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      for (const id of ["pp-plain", "pp-stop"]) {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
      }
      const bg = await page.evaluate(() => {
        const { document, getComputedStyle } = globalThis;
        return Object.fromEntries(
          ["pp-plain", "pp-stop", "pp-gray", "pp-red"].map((id) => [
            id,
            getComputedStyle(document.getElementById(id)).backgroundColor,
          ]),
        );
      });
      if (bg["pp-plain"] !== bg["pp-gray"]) throw new Error(`普通按钮按下是 ${bg["pp-plain"]}，应为 ${bg["pp-gray"]}`);
      if (bg["pp-stop"] !== bg["pp-red"]) throw new Error(`停止按钮按下是 ${bg["pp-stop"]}，应为 ${bg["pp-red"]}`);
      return `普通 ${bg["pp-plain"]}；停止 ${bg["pp-stop"]}`;
    } finally {
      await page.evaluate(() => globalThis.document.getElementById("press-probe")?.remove());
      await cdp.detach().catch(() => {});
    }
  });

  // c. 新对话 → 假模型 → 发消息 → 回复、回合结束、侧栏出现
  await step(
    "c1",
    "新对话选工作区",
    async () => {
      await sidebar.locator(".side-actions .new-chat.primary").click();
      const dialog = openBox(".workspace-dialog");
      await dialog.waitFor({ state: "visible" });
      await dialog.locator('[role="option"]').filter({ hasText: WORKSPACE }).first().click();
      await dialog.waitFor({ state: "hidden" });
      await composer.waitFor({ state: "visible" });
    },
    { critical: true },
  );
  await step(
    "c2",
    "选假模型",
    async () => {
      await page.getByRole("button", { name: "选择模型" }).click();
      await page.locator(`.model-menu [role="option"][title="${FAKE_MODEL}"]`).click();
      await page.locator(".model-menu").waitFor({ state: "detached" });
      return await page.locator(".model-picker-btn").getAttribute("title");
    },
    { critical: true },
  );
  await step(
    "c3",
    "发消息、收到回声、回合结束",
    async () => {
      await composer.fill(question);
      await sendButton.click();
      const turn = page.locator("article.turn").filter({ has: page.locator(".user-bubble", { hasText: nonce }) });
      await turn.waitFor({ state: "visible" });
      await turn
        .locator(".assistant", { hasText: `${ECHO_PREFIX}` })
        .filter({ hasText: nonce })
        .waitFor({ timeout: 30_000 });
      await stopButton.waitFor({ state: "detached", timeout: 30_000 });
      await turn.locator(".turn-actions").waitFor({ state: "visible", timeout: 15_000 });
      if ((await composer.inputValue()) !== "") throw new Error("发送后输入框没清空");
    },
    { shot: true, critical: true },
  );
  await step("c4", "侧栏出现该会话", async () => {
    await projGroup.locator(".chat-item.active").waitFor({ state: "visible" });
    return `标题「${(await projGroup.locator(".chat-item.active .chat-item-title").innerText()).trim()}」`;
  });
  await step("c5", "停靠搜索上面还有一层时，Esc 只关上层", async () => {
    await railButton("搜索").click();
    const grep = openBox(".grep-box");
    await grep.waitFor({ state: "visible" });
    await page.keyboard.press("Control+f");
    const find = page.locator(".thread-find-input");
    await find.waitFor({ state: "visible" });
    await grep.locator(".search-input").click();
    await esc();
    await find.waitFor({ state: "detached" });
    await page.waitForTimeout(400);
    if (!(await grep.isVisible())) throw new Error("Esc 连停靠的搜索也关了");
    await esc();
    await grep.waitFor({ state: "hidden" });
    await sidebar.waitFor({ state: "visible" });
  });

  // d. 刷新：免登录恢复，直接回到刚才的会话（分组展开），回复都在
  await step(
    "d1",
    "刷新后免登录、回到刚才的会话与回复",
    async () => {
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectMain();
      if (await passwordInput.count()) throw new Error("刷新后又要求登录");
      await page.waitForTimeout(1000);
      const landing = (await page.locator(".error-line:visible").allInnerTexts()).map((t) => `落点红字「${t.trim()}」`);
      await expectNoKeyHint();
      const reply = page.locator("article.turn .assistant", { hasText: ECHO_PREFIX }).filter({ hasText: nonce });
      await reply.waitFor({ timeout: 15_000 });
      // 等一会儿再查一次，防止落点被随后到的同步改回助理会话
      await page.waitForTimeout(1500);
      await projGroup.locator(".chat-item.active").waitFor({ state: "visible", timeout: 5_000 });
      if ((await projGroup.locator(".chat-group-label").getAttribute("aria-expanded")) !== "true") {
        throw new Error("刷新后该会话所在的分组没展开");
      }
      if (await sidebar.locator(".assistant-pin.active").count()) throw new Error("刷新后落到了助理会话");
      if (!(await reply.isVisible())) throw new Error("刷新后的回复又不见了");
      return landing.join("；");
    },
    { shot: true, critical: true },
  );

  // e. 改名、删除
  await step("e1", "双击改名", async () => {
    await projGroup.locator(".chat-item .chat-item-main").first().dblclick();
    const input = projGroup.locator("input.chat-rename");
    await input.waitFor({ state: "visible" });
    await input.fill(renamed);
    await input.press("Enter");
    await projGroup.locator(".chat-item-title", { hasText: renamed }).waitFor({ state: "visible" });
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectMain();
    await projGroup.locator(".chat-item-title", { hasText: renamed }).waitFor({ state: "visible", timeout: 15_000 });
    return "刷新后新名字仍在";
  });
  await step("e2", "删除会话", async () => {
    const item = sidebar.locator(".chat-item").filter({ has: page.locator(".chat-item-title", { hasText: nonce }) });
    await item.first().hover();
    await item.first().getByRole("button", { name: "删除会话" }).click();
    await item.first().waitFor({ state: "detached" });
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectMain();
    await page.waitForTimeout(1500);
    if (await item.count()) throw new Error("刷新后被删的会话又回来了");
    return "刷新后仍已删除";
  });

  // f. 退出登录 → 管理员登录 → 使用统计
  await step(
    "f1",
    "退出登录（不留上次选中的会话）",
    async () => {
      await settingsToggle.click();
      await sidebar.locator(".side-settings .logout-btn").click();
      await passwordInput.waitFor({ state: "visible", timeout: 15_000 });
      const left = await page.evaluate(() => globalThis.localStorage.getItem("cursor-remote-active"));
      if (left) throw new Error(`退出后还记着上次选中的会话 ${left}`);
    },
    { critical: true },
  );
  await step(
    "f2",
    "管理员登录",
    async () => {
      await login(ADMIN_TOKEN);
      await expectMain();
    },
    { critical: true },
  );
  await step(
    "f3",
    "管理统计入口可见并打开",
    async () => {
      const entry = railButton("查看使用统计");
      await entry.waitFor({ state: "visible" });
      await entry.click();
      const box = page.locator('.search-overlay.open .admin-box[role="dialog"]');
      await box.waitFor({ state: "visible" });
      await box.locator(".admin-body").waitFor({ state: "visible", timeout: 15_000 });
      await snap("f3-ok");
      await esc();
      await box.waitFor({ state: "detached" });
    },
    {},
  );

  // g. 全程页面异常
  current = "g";
  results.push({
    id: "g",
    name: "无 pageerror / console.error / 意外弹窗",
    status: problems.length ? "失败" : "通过",
    ms: 0,
    detail: problems.length ? `${problems.length} 条` : "",
  });

  await browser.close();

  const total = (performance.now() - started) / 1000;
  console.log("\n== 界面冒烟汇总");
  for (const r of results) {
    const time = r.status === "跳过" ? "" : `${(r.ms / 1000).toFixed(1)}s`;
    console.log(`${r.status}  ${r.id.padEnd(3)} ${r.name.padEnd(22)} ${time.padStart(6)}  ${r.detail}`);
  }
  for (const p of problems) console.log(`  [${p.step}] ${p.kind}: ${p.text.slice(0, 300)}`);
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(
    `通过 ${count("通过")}，失败 ${count("失败")}，跳过 ${count("跳过")}，总耗时 ${total.toFixed(1)}s，截图 ${SHOTS}`,
  );
  process.exit(count("失败") || count("跳过") ? 1 : 0);
}
