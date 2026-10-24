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
  const WORKSPACE_SECOND = env("UI_WORKSPACE_SECOND");
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
  let expectedDialogAnswer;
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
    if (expectedDialogAnswer !== undefined) {
      const answer = expectedDialogAnswer;
      expectedDialogAnswer = undefined;
      void dialog.accept(answer);
      return;
    }
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
  const workspaceNav = sidebar.getByRole("navigation", { name: "工作区功能" });
  const workspaceButton = (label) => workspaceNav.getByRole("button", { name: label, exact: true });
  const sessionTools = sidebar.getByRole("toolbar", { name: "当前会话工具" });
  const sessionTool = (label) => sessionTools.getByRole("button", { name: label, exact: true });
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
  await activity.getByRole("button", { name: "工作区", exact: true }).click();

  // b. 各浮层：打开可见，Esc / 关闭后消失
  await step("b1", "命令面板（⌘P 打开文件）", () =>
    overlay(() => page.keyboard.press("Control+p"), openBox('.search-box[role="dialog"][aria-label="打开文件"]'), esc),
  );
  await step("b2", "会话搜索（⌘K）", () =>
    overlay(() => page.keyboard.press("Control+k"), openBox('.search-box[role="dialog"][aria-label="搜索对话"]'), esc),
  );
  await step("b3", "文件浮层", () =>
    overlay(
      () => workspaceButton("文件").click(),
      page.locator('.files-overlay.open .files-browser[role="dialog"]'),
      () => page.locator(".files-overlay.open .files-browser-close").click(),
    ),
  );
  // 1440 宽是停靠模式：弹层收进侧栏列，是对话框但不是模态
  await step("b4", "全文搜索", () =>
    overlay(() => workspaceButton("工作区搜索").click(), openBox('.grep-box[role="dialog"]:not([aria-modal])'), esc),
  );
  await step("b5", "终端", () =>
    overlay(() => sessionTool("终端输出").click(), openBox('.terminal-box[role="dialog"]:not([aria-modal])'), esc),
  );
  await step("b6", "循环", () => overlay(() => sessionTool("Loop").click(), openBox(".loop-box"), esc));
  await step("b7", "工作区选择（新对话）：列表撑满对话框、对话框不出屏", () =>
    overlay(
      () => sidebar.locator(".new-chat.primary").click(),
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
      await sidebar.locator(".new-chat.primary").click();
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
    await workspaceButton("工作区搜索").click();
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
      if (await activity.locator('button[aria-label*="助理"][aria-pressed="true"]').count())
        throw new Error("刷新后落到了助理会话");
      if (!(await reply.isVisible())) throw new Error("刷新后的回复又不见了");
      return landing.join("；");
    },
    { shot: true, critical: true },
  );

  // p. 长会话渲染性能（页面侧测量开关 localStorage cr-perf=1，默认关闭）：
  //    往当前会话合成 240 个旧回合 + 1 个运行中回合，按真实 ws 路径灌流式 text-delta，量旧回合渲染次数、帧间隔和主线程 longtask；
  //    再验证旧回合启用 content-visibility 之后，自动滚到底、“回到最新”、线程内查找定位、图片解码都不受影响。
  //    数字只在这里打印（[perf] 开头的 JSON 行），断言只守“流式期间旧回合不该被重渲染”这条底线。
  const PERF_TURNS = 240;
  const STREAM_DELTAS = 150;
  const perf = { ready: false, chatId: "" };
  const thread = page.locator(".thread");
  const threadBox = () =>
    thread.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  const expectAtBottom = async (what) => {
    const m = await threadBox();
    const dist = m.height - m.top - m.client;
    if (dist > 8) throw new Error(`${what}：离底部还有 ${Math.round(dist)}px`);
  };
  // 往页面里灌 count 条 text-delta（间隔 gapMs），同时按帧记录帧间隔；返回帧统计
  const streamDeltas = (count, gapMs, from = 0) =>
    page.evaluate(
      async ({ chatId, count, gapMs, from }) => {
        const api = globalThis.__crPerf;
        const gaps = [];
        let last = performance.now();
        let running = true;
        const tick = (now) => {
          gaps.push(now - last);
          last = now;
          if (running) globalThis.requestAnimationFrame(tick);
        };
        globalThis.requestAnimationFrame(tick);
        for (let i = from; i < from + count; i += 1) {
          api.arm(); // 网关随后推来的快照可能把合成的运行中回合结算掉，每条前确认它还在跑（已在跑时是空操作）
          api.feed({ type: "text-delta", chatId, text: `片段${i} 流式输出，` });
          await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
        await new Promise((resolve) =>
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
        );
        running = false;
        const sorted = [...gaps].sort((a, b) => a - b);
        return {
          frames: gaps.length,
          avgFrameMs: gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length),
          p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] || 0,
          over50: gaps.filter((g) => g > 50).length,
        };
      },
      { chatId: perf.chatId, count, gapMs, from },
    );

  await step(
    "p1",
    "长会话：开测量开关、合成 240 回合并渲染",
    async () => {
      await page.evaluate(() => globalThis.localStorage.setItem("cr-perf", "1"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectMain();
      await page.waitForFunction(() => Boolean(globalThis.__crPerf), null, { timeout: 15_000 });
      await page
        .locator("article.turn .assistant", { hasText: ECHO_PREFIX })
        .filter({ hasText: nonce })
        .waitFor({ timeout: 15_000 });
      // 刷新后网关还会推 ready（会把本地“还在跑”的回合当孤儿结算）和会话正文（以服务端为准覆盖本地回合），
      // 得等这轮握手落定再造数据，否则合成回合会被冲掉
      await page.waitForTimeout(3_000);
      perf.chatId = await page.evaluate(() => globalThis.localStorage.getItem("cursor-remote-active") || "");
      if (!perf.chatId) throw new Error("读不到当前会话 id");
      perf.seedMs = await page.evaluate((n) => globalThis.__crPerf.seed(n), PERF_TURNS);
      await page.waitForTimeout(1_500);
      const turns = await page.locator("article.turn").count();
      if (turns < PERF_TURNS + 1) throw new Error(`只渲染了 ${turns} 个回合，应不少于 ${PERF_TURNS + 1}`);
      const m = await threadBox();
      perf.heightAfterSeed = m.height;
      await expectAtBottom("合成数据后线程没停在底部");
      perf.ready = true;
      console.log(`[perf] ${JSON.stringify({ seedMs: Math.round(perf.seedMs), turns, scrollHeight: m.height })}`);
      return `${turns} 个回合，首次渲染到两帧后 ${Math.round(perf.seedMs)}ms，scrollHeight ${m.height}`;
    },
    { shot: true },
  );
  await step("p2", "长会话流式输出：旧回合不重渲染、帧间隔与 longtask", async () => {
    if (!perf.ready) throw new Error("p1 没成功");
    await page.waitForTimeout(500);
    await page.evaluate(() => globalThis.__crPerf.reset());
    const frame = await streamDeltas(STREAM_DELTAS, 20);
    await page.waitForTimeout(300); // longtask 回调是异步投递的
    const raw = await page.evaluate(() => {
      const api = globalThis.__crPerf;
      return { rows: api.rows, longtasks: api.longtasks, threadRenders: api.threadRenders };
    });
    const oldIds = Object.keys(raw.rows).filter((id) => id !== "perf-live");
    const oldRenders = oldIds.reduce((sum, id) => sum + raw.rows[id], 0);
    const oldRowCount = PERF_TURNS + 1;
    const stat = {
      deltas: STREAM_DELTAS,
      threadRenders: raw.threadRenders,
      liveRowRenders: raw.rows["perf-live"] || 0,
      oldRowRenders: oldRenders,
      oldRowsRenderedAtLeastOnce: oldIds.length,
      oldRenderPerRow: Number((oldRenders / oldRowCount).toFixed(2)),
      longtasks: raw.longtasks.n,
      longtaskTotalMs: Math.round(raw.longtasks.total),
      longtaskMaxMs: Math.round(raw.longtasks.max),
      frames: frame.frames,
      avgFrameMs: Number(frame.avgFrameMs.toFixed(1)),
      p95FrameMs: Math.round(frame.p95FrameMs),
      framesOver50ms: frame.over50,
    };
    console.log(`[perf] ${JSON.stringify(stat)}`);
    const lastText = await page.locator("article.turn").last().innerText();
    if (!lastText.includes(`片段${STREAM_DELTAS - 1}`)) throw new Error("流式增量没有渲染到最后一个回合");
    await expectAtBottom("流式输出期间没有贴底");
    if (oldRenders > oldRowCount * 0.1) {
      throw new Error(`流式期间旧回合被重渲染 ${oldRenders} 次（约 ${stat.oldRenderPerRow} 次/回合），应接近 0`);
    }
    return `旧回合渲染 ${oldRenders} 次，末轮 ${stat.liveRowRenders} 次，Thread ${raw.threadRenders} 次；longtask ${raw.longtasks.n} 个共 ${stat.longtaskTotalMs}ms；p95 帧 ${stat.p95FrameMs}ms`;
  });
  await step("p3", "旧回合 content-visibility：末几轮不启用、整屏滚一遍后高度偏差、图片仍解码", async () => {
    if (!perf.ready) throw new Error("p1 没成功");
    const info = await page.evaluate(() => {
      const rows = [...globalThis.document.querySelectorAll("article.turn")];
      const cv = (row) => row.classList.contains("turn-cv");
      return {
        total: rows.length,
        cv: rows.filter(cv).length,
        tailCv: rows.slice(-6).filter(cv).length,
        firstStyle: globalThis.getComputedStyle(rows[0]).contentVisibility,
        lastStyle: globalThis.getComputedStyle(rows[rows.length - 1]).contentVisibility,
      };
    });
    console.log(`[perf] ${JSON.stringify({ cvRows: info })}`);
    if (!info.cv) throw new Error("没有任何回合带 turn-cv：旧回合没启用 content-visibility");
    if (info.tailCv) throw new Error(`末 6 个回合里有 ${info.tailCv} 个带了 turn-cv`);
    if (info.firstStyle !== "auto" || info.lastStyle === "auto") {
      throw new Error(`computed content-visibility 不对：首个 ${info.firstStyle}，末个 ${info.lastStyle}`);
    }
    // 先真实滚轮往上一下（让 useThreadScroll 记下“用户翻过”），再从顶到底逐屏滚一遍，让每个旧回合都渲染一次
    const before = (await threadBox()).height;
    await thread.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    await thread.evaluate(async (el) => {
      for (let y = 0; y < el.scrollHeight; y += el.clientHeight * 0.8) {
        el.scrollTop = y;
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      }
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    const after = (await threadBox()).height;
    const drift = Math.abs(after - before) / after;
    console.log(
      `[perf] ${JSON.stringify({ heightEstimated: before, heightMeasured: after, driftPct: Number((drift * 100).toFixed(1)) })}`,
    );
    const img = await page.evaluate(() => {
      const el = globalThis.document.querySelector('[data-turn="perf-0002"] .user-thumbs img');
      return el ? { complete: el.complete, w: el.naturalWidth } : null;
    });
    if (!img || !img.complete || img.w < 1) throw new Error(`旧回合里的图片没有解码成功：${JSON.stringify(img)}`);
    return `${info.cv}/${info.total} 个回合启用；高度估算 ${before}px → 实测 ${after}px（偏差 ${(drift * 100).toFixed(1)}%）；图片 ${img.w}px 已解码`;
  });
  await step("p4", "自动滚到底：向上滚出现“回到最新”，点击后回底，流式输出继续贴底", async () => {
    if (!perf.ready) throw new Error("p1 没成功");
    await thread.hover();
    await page.mouse.wheel(0, -2500);
    const jump = page.locator("button.thread-jump");
    await jump.waitFor({ state: "visible", timeout: 5_000 });
    await jump.click();
    await page.waitForTimeout(600);
    await expectAtBottom("点“回到最新”后没回到底部");
    await streamDeltas(30, 20, STREAM_DELTAS);
    await page.waitForTimeout(300);
    await expectAtBottom("回到底部后继续流式输出没有贴底");
    const lastText = await page.locator("article.turn").last().innerText();
    if (!lastText.includes(`片段${STREAM_DELTAS + 29}`)) throw new Error("继续灌入的增量没渲染出来");
  });
  await step("p5", "线程内查找：命中行定位到视口内，打开期间所有回合不启用 content-visibility", async () => {
    if (!perf.ready) throw new Error("p1 没成功");
    await thread.hover();
    await page.keyboard.press("Control+f");
    const find = page.locator(".thread-find-input");
    await find.waitFor({ state: "visible" });
    const details = [];
    for (const n of [3, 200]) {
      await find.fill(`第 ${n} 个问题`);
      const row = page.locator(`[data-turn="perf-${String(n).padStart(4, "0")}"]`);
      await row.locator(".find-mark").first().waitFor({ state: "attached", timeout: 5_000 });
      await page.waitForTimeout(500);
      const view = await page.evaluate(
        (id) => {
          const { document } = globalThis;
          const t = document.querySelector(".thread").getBoundingClientRect();
          const row = document.querySelector(`[data-turn="${id}"]`);
          const r = row.getBoundingClientRect();
          return {
            inView: r.top >= t.top - 2 && r.bottom <= t.bottom + 2,
            top: Math.round(r.top - t.top),
            bottom: Math.round(t.bottom - r.bottom),
            hit: row.classList.contains("find-hit"),
            cvRows: document.querySelectorAll("article.turn.turn-cv").length,
          };
        },
        `perf-${String(n).padStart(4, "0")}`,
      );
      if (!view.hit) throw new Error(`第 ${n} 轮没有 find-hit 标记`);
      if (!view.inView) throw new Error(`第 ${n} 轮命中后没滚进视口：${JSON.stringify(view)}`);
      if (view.cvRows) throw new Error(`查找打开期间仍有 ${view.cvRows} 个回合带 turn-cv`);
      details.push(`第 ${n} 轮 上${view.top}/下${view.bottom}px`);
    }
    await esc();
    await find.waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    const restored = await page.locator("article.turn.turn-cv").count();
    if (!restored) throw new Error("关闭查找后旧回合没有恢复 content-visibility");
    return `${details.join("；")}；关闭后 ${restored} 个回合恢复`;
  });
  // 无论前面成败都收尾：关掉测量开关、刷新丢掉合成回合，保证后面的步骤面对的是干净状态，并确认默认不挂测量入口
  await step("p6", "关闭测量开关刷新：测量入口与合成回合都消失", async () => {
    await page.evaluate(() => globalThis.localStorage.removeItem("cr-perf"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectMain();
    await page
      .locator("article.turn .assistant", { hasText: ECHO_PREFIX })
      .filter({ hasText: nonce })
      .waitFor({ timeout: 15_000 });
    if (await page.evaluate(() => Boolean(globalThis.__crPerf))) throw new Error("默认状态下页面上仍有 __crPerf");
    const fake = await page.locator('article.turn[data-turn^="perf-"]').count();
    if (fake) throw new Error(`刷新后仍有 ${fake} 个合成回合`);
  });

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

  // h. Agent 协作群：独立覆盖入口、默认群、成员管理、直接派工、多 Agent 波次和深链恢复
  const collabList = page.getByRole("complementary", { name: "协作群列表" });
  const collabDetails = page.getByRole("complementary", { name: "当前协作详情" });
  const collabComposer = page.getByRole("textbox", { name: "协作消息" });
  const projectRoom = `UI项目群 ${nonce}`;
  const projectRoomRenamed = `UI项目群改名 ${nonce}`;
  const roomButton = (title) => collabList.getByRole("button").filter({ hasText: title });
  const expectCollabMain = async () => {
    await loginGate.waitFor({ state: "detached" });
    await collabList.waitFor({ state: "visible", timeout: 20_000 });
  };
  const openMembers = async () => {
    const detailsButton = page.getByRole("button", { name: "协作详情", exact: true });
    if (await detailsButton.isVisible().catch(() => false)) await detailsButton.click();
    await collabDetails.waitFor({ state: "visible" });
    const tab = collabDetails.getByRole("tab", { name: "成员", exact: true });
    await tab.waitFor({ state: "visible" });
    await tab.click();
  };

  await step(
    "h1",
    "协作入口登录后可见且可切换",
    async () => {
      const entry = activity.getByRole("button", { name: "协作", exact: true });
      await entry.waitFor({ state: "visible" });
      await entry.click();
      await collabList.waitFor({ state: "visible", timeout: 15_000 });
      await activity.getByRole("button", { name: "工作区", exact: true }).click();
      await collabList.waitFor({ state: "hidden" });
      await entry.click();
      await collabList.waitFor({ state: "visible" });
    },
    { critical: true, shot: true },
  );
  await step("h2", "默认小驳协作群只创建一份", async () => {
    const defaults = collabList.getByRole("button").filter({ hasText: "小驳协作群" });
    await defaults.first().waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(1_500);
    const count = await defaults.count();
    if (count !== 1) throw new Error(`默认群有 ${count} 份`);
  });
  await step("h3", "群列表、成员与默认 @小驳 Composer", async () => {
    await roomButton("小驳协作群").click();
    await openMembers();
    for (const name of ["小驳", WORKSPACE, WORKSPACE_SECOND]) {
      await collabDetails.getByText(name, { exact: true }).waitFor({ state: "visible" });
    }
    await page.getByRole("button", { name: "移除 @小驳", exact: true }).waitFor({ state: "visible" });
    await collabComposer.waitFor({ state: "visible" });
  });
  await step(
    "h4",
    "创建项目群、改名、增删 workspace actor 并刷新保留",
    async () => {
      const phase = async (name, run) => {
        try {
          return await run();
        } catch (error) {
          throw new Error(`${name}：${error?.message || error}`);
        }
      };
      expectedDialogAnswer = projectRoom;
      await phase("创建群", () => collabList.getByRole("button", { name: "创建项目协作群" }).click());
      await phase("选择新群", async () => {
        await roomButton(projectRoom).waitFor({ state: "visible", timeout: 15_000 });
        await roomButton(projectRoom).click();
      });
      await phase("打开成员", openMembers);
      await phase("添加第一工作区", () =>
        collabDetails.getByRole("button", { name: `＋ 添加 ${WORKSPACE}`, exact: true }).click(),
      );
      await phase("添加第二工作区", () =>
        collabDetails.getByRole("button", { name: `＋ 添加 ${WORKSPACE_SECOND}`, exact: true }).click(),
      );
      await phase("移除第二工作区", async () => {
        const name = collabDetails.getByText(WORKSPACE_SECOND, { exact: true });
        await name.waitFor({ state: "visible" });
        await name.locator("xpath=ancestor::div[button][1]").getByRole("button", { name: "移除", exact: true }).click();
      });
      await phase("重新添加第二工作区", () =>
        collabDetails.getByRole("button", { name: `＋ 添加 ${WORKSPACE_SECOND}`, exact: true }).click(),
      );
      expectedDialogAnswer = projectRoomRenamed;
      await phase("改名", () => collabDetails.getByRole("button", { name: "改名", exact: true }).click());
      await phase("等待新群名", () => roomButton(projectRoomRenamed).waitFor({ state: "visible" }));
      await phase("刷新恢复", async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectCollabMain();
        await roomButton(projectRoomRenamed).waitFor({ state: "visible" });
        await openMembers();
      });
      await phase("核对成员", async () => {
        for (const name of ["小驳", WORKSPACE, WORKSPACE_SECOND]) {
          await collabDetails.getByText(name, { exact: true }).waitFor({ state: "visible" });
        }
      });
    },
    { critical: true, shot: true },
  );
  await step(
    "h5",
    "直接 @workspace Agent 经完整状态到 ResultCard",
    async () => {
      const phase = async (name, run) => {
        try {
          return await run();
        } catch (error) {
          throw new Error(`${name}：${error?.message || error}`);
        }
      };
      await phase("改为直接派工", async () => {
        await page.getByRole("button", { name: "移除 @小驳", exact: true }).click();
        await page.getByRole("button", { name: "+ @Agent", exact: true }).click();
        await page.locator("select").selectOption({ label: `工作区：${WORKSPACE}` });
      });
      await page.evaluate(() => {
        const seen = [];
        const scan = () => {
          for (const node of globalThis.document.querySelectorAll('article[role="button"] span[data-tone]')) {
            const value = node.textContent?.trim();
            if (value && !seen.includes(value)) seen.push(value);
          }
        };
        globalThis.__collabSmokeStatuses = seen;
        new globalThis.MutationObserver(scan).observe(globalThis.document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        scan();
      });
      await phase("发送任务", async () => {
        await collabComposer.fill(`直接派工 ${nonce}`);
        await page.getByRole("button", { name: "发送协作消息" }).click();
      });
      await phase("等待 ResultCard", () =>
        page.getByText("Agent 结果", { exact: true }).waitFor({ state: "visible", timeout: 60_000 }),
      );
      await phase("等待 TaskCard 成功", () =>
        page
          .locator('article[role="button"]')
          .filter({ hasText: "已完成" })
          .last()
          .waitFor({ state: "visible", timeout: 15_000 }),
      );
      const seen = await page.evaluate(() => globalThis.__collabSmokeStatuses || []);
      for (const status of ["排队中", "运行中", "结果发送中", "已完成"]) {
        if (!seen.includes(status)) throw new Error(`TaskCard 未观察到「${status}」；实际 ${seen.join("、")}`);
      }
      return seen.join(" → ");
    },
    { critical: true, shot: true },
  );
  await step(
    "h6",
    "@小驳展示多 Agent 计划、波次与 summary",
    async () => {
      await page.getByRole("button", { name: `移除 @${WORKSPACE}`, exact: true }).click();
      await page.getByRole("button", { name: "+ @Agent", exact: true }).click();
      await page.locator("select").selectOption({ label: "协调：小驳" });
      await collabComposer.fill(`多 Agent 两波协作 ${nonce}`);
      await page.getByRole("button", { name: "发送协作消息" }).click();
      await page.getByText("小驳的执行计划", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
      await page.getByText("Wave 1 · 可并行", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
      await page.getByText("Wave 2 · 可并行", { exact: true }).waitFor({ state: "visible", timeout: 40_000 });
      await page.getByText("小驳汇总", { exact: true }).waitFor({ state: "visible", timeout: 40_000 });
      await page
        .getByText("UI smoke：多 Agent 两波任务均已完成。", { exact: true })
        .first()
        .waitFor({ state: "visible" });
    },
    { critical: true, shot: true },
  );
  await step("h7", "URL 深链刷新恢复 conv/run/task", async () => {
    const phase = async (name, run) => {
      try {
        return await run();
      } catch (error) {
        throw new Error(`${name}：${error?.message || error}`);
      }
    };
    const closeDetails = collabDetails.getByRole("button", { name: "关闭协作详情", exact: true });
    await phase("关闭已有详情栏", async () => {
      if (await closeDetails.isVisible().catch(() => false)) await closeDetails.evaluate((node) => node.click());
    });
    const completed = page.locator('article[role="button"]').filter({ hasText: "已完成" }).last();
    await phase("打开已完成任务", () => completed.click());
    await phase("等待任务详情栏", () => collabDetails.waitFor({ state: "visible" }));
    const before = new URL(page.url());
    for (const key of ["conv", "run", "task"]) {
      if (!before.searchParams.get(key)) throw new Error(`深链缺少 ${key}`);
    }
    await phase("按深链刷新", () => page.reload({ waitUntil: "domcontentloaded" }));
    await phase("等待协作主界面", expectCollabMain);
    await phase("等待恢复详情栏", () => collabDetails.waitFor({ state: "visible", timeout: 20_000 }));
    await phase("等待恢复任务详情", () =>
      collabDetails.getByText("任务详情", { exact: true }).waitFor({ state: "visible" }),
    );
    const after = new URL(page.url());
    for (const key of ["conv", "run", "task"]) {
      if (after.searchParams.get(key) !== before.searchParams.get(key)) throw new Error(`刷新后 ${key} 未恢复`);
    }
    await phase("返回助理域", () =>
      page
        .locator('nav[aria-label="一级导航"] button')
        .filter({ hasText: "助理" })
        .evaluate((node) => node.click()),
    );
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
      const entry = sidebar.getByRole("button", { name: "查看使用统计", exact: true });
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

  current = "h8";
  results.push({
    id: "h8",
    name: "协作场景无 pageerror / console.error",
    status: problems.length ? "失败" : "通过",
    ms: 0,
    detail: problems.length ? `${problems.length} 条` : "",
  });

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
