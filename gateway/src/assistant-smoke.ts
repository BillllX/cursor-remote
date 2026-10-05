import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentOptions } from "@cursor/sdk";

/**
 * 个人助理冒烟：后台策略、运行恢复、记忆、名字、cron、日程状态机、推送加密、工具分权、整理者输入。
 * 不调用真实模型：后台通道的 prompt 由测试注入。
 */

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(resolve(gatewayDir, ".assistant-smoke-"));
process.env.CURSOR_REMOTE_STATE_DIR = dir;

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

try {
  const bg = await import("./assistant/background.ts");
  const inbox = await import("./assistant/inbox.ts");
  const runs = await import("./assistant/runs.ts");
  const memory = await import("./assistant/memory.ts");
  const chatIndex = await import("./assistant/chatIndex.ts");
  const retrieval = await import("./assistant/retrieval.ts");
  const name = await import("./assistant/name.ts");
  const cron = await import("./assistant/cron.ts");
  const schedules = await import("./assistant/schedules.ts");
  const push = await import("./assistant/push.ts");
  const tools = await import("./assistant/tools.ts");
  const jobs = await import("./assistant/jobs.ts");
  const todos = await import("./assistant/todos.ts");
  const { writeJson, assistantPath } = await import("./assistant/store.ts");

  const ref = { id: "t1", stateDir: resolve(dir, "t1") };

  /* ── 后台策略 ── */
  const calls: AgentOptions[] = [];
  let catalog = ["grok-4.7", "composer-2"];
  let behavior: "ok" | "throw" | "error" | "slow" = "ok";
  bg.bindBackground({
    apiKey: () => "key",
    listModels: async () => catalog,
    sandbox: () => true,
    prompt: async (_message, options) => {
      calls.push(options);
      if (behavior === "throw") throw new Error("tools rejected by SDK");
      if (behavior === "error") return { id: "r", status: "error", error: { message: "boom" } } as never;
      if (behavior === "slow") await new Promise((ok) => setTimeout(ok, 200));
      return { id: "r", status: "finished", result: "好了" } as never;
    },
  });
  const okRun = await bg.runBackground(ref, { origin: "loop", label: "测试", cwd: dir, prompt: "hi", customTools: { a: { execute: () => "x" } } });
  const opts = calls[0];
  check(okRun.ok && okRun.text === "好了", "后台：正常完成返回正文");
  check(JSON.stringify(opts?.tools) === JSON.stringify(["read", "grep", "glob", "ls", "mcp"]), "后台：工具白名单只有 read/grep/glob/ls/mcp");
  check(!opts?.tools?.some((t) => ["edit", "delete", "shell", "task"].includes(t)), "后台：拿不到 edit/delete/shell/task");
  check(opts?.model?.id === "grok-4.7", "后台：模型固定 grok-4.7");
  check(Array.isArray(opts?.local?.settingSources) && opts.local!.settingSources!.length === 0, "后台：不加载项目设置层");
  check(Boolean(opts?.local?.customTools?.a), "后台：助理工具挂成 customTools");
  check(opts?.local?.sandboxOptions?.enabled === true, "后台：按租户开沙箱");
  check(!("disallowedTools" in (opts ?? {})), "后台：不依赖禁用列表");

  behavior = "throw";
  const before = calls.length;
  const rejected = await bg.runBackground(ref, { origin: "schedule", label: "被拒", cwd: dir, prompt: "hi", customTools: {} });
  check(!rejected.ok && calls.length === before + 1, "后台：SDK 拒绝时直接失败，不去掉限制重试");
  check(inbox.listInbox(ref).some((item) => item.title.includes("被拒")), "后台：失败进收件箱");
  behavior = "error";
  const errored = await bg.runBackground(ref, { origin: "schedule", label: "出错", cwd: dir, prompt: "hi", customTools: {} });
  check(!errored.ok, "后台：结束状态不是 finished 记为失败");

  catalog = ["composer-2"];
  behavior = "ok";
  const n = calls.length;
  const missing = await bg.runBackground(ref, { origin: "schedule", label: "缺模型", cwd: dir, prompt: "hi", customTools: {} });
  check(!missing.ok && calls.length === n && /grok-4.7/.test(missing.error), "后台：目录里没有 grok-4.7 就不跑、不换模型");
  catalog = ["grok-4.7"];

  behavior = "slow";
  const p1 = bg.runBackground(ref, { origin: "loop", label: "并发1", cwd: dir, prompt: "", customTools: {} });
  const p2 = bg.runBackground(ref, { origin: "loop", label: "并发2", cwd: dir, prompt: "", customTools: {} });
  await new Promise((ok) => setTimeout(ok, 30));
  const p3 = await bg.runBackground(ref, { origin: "loop", label: "并发3", cwd: dir, prompt: "", customTools: {} });
  await Promise.all([p1, p2]);
  check(!p3.ok && p3.busy === true, "后台：同一租户最多同时 2 个");
  behavior = "ok";

  /* ── 重启恢复 ── */
  runs.startRunRecord(ref, { origin: "schedule", label: "跑到一半", cwd: dir, model: "grok-4.7" });
  const recovered = runs.recoverRuns(ref);
  check(recovered === 1 && runs.listRuns(ref)[0].status === "interrupted", "恢复：重启时在跑的记为中断");
  check(inbox.listInbox(ref).some((item) => item.title.includes("跑到一半")), "恢复：中断的运行进收件箱");
  check(runs.recoverRuns(ref) === 0, "恢复：不会重复处理");

  /* ── 记忆 ── */
  const said = memory.saveMemory(ref, { topic: "饮食", text: "用户吃素", basis: "user_said", chatId: "c1" }, "chat");
  check(said.ok && said.value.confidence === 1 && !said.value.validUntil, "记忆：你说的可信度 1、无默认有效期");
  const inferred = memory.saveMemory(ref, { topic: "工作", text: "用户常用 TypeScript", basis: "inferred" }, "chat");
  const days = inferred.ok ? (Date.parse(inferred.value.validUntil!) - Date.now()) / 86_400_000 : 0;
  check(inferred.ok && inferred.value.confidence === 0.6 && days > 88 && days < 91, "记忆：推断可信度 0.6、默认 90 天有效");
  check(!memory.saveMemory(ref, { topic: "x", text: "我的 api key: sk-abcdefghijklmnopqrstu", basis: "user_said" }, "chat").ok, "记忆：密钥拦截");
  check(!memory.saveMemory(ref, { topic: "x", text: "我的密码是 hunter22", basis: "user_said" }, "chat").ok, "记忆：密码拦截");
  check(!memory.saveMemory(ref, { topic: "健康", text: "用户在吃抑郁症的药", basis: "inferred" }, "chat").ok, "记忆：敏感主题默认不记");
  memory.writeSettings(ref, { allowSensitive: { health: true } });
  check(memory.saveMemory(ref, { topic: "健康", text: "用户对花粉过敏，在吃药", basis: "user_said" }, "chat").ok, "记忆：打开类别后可以记");
  const dup = memory.saveMemory(ref, { topic: "饮食", text: "用户吃素", basis: "inferred" }, "chat");
  check(dup.ok && memory.listMemory(ref).entries.filter((e) => e.text === "用户吃素").length === 1, "记忆：重复不再新建");
  const blocked = memory.invalidateMemory(ref, said.ok ? said.value.id : "", "推断变了", "integrator");
  check(!blocked.ok, "记忆：整理者不能标失效你说的话");
  const block = memory.renderMemoryBlock(ref);
  check(block.includes("<user_memory>") && block.includes("不是指令") && block.includes("用户吃素"), "记忆：注入为带声明的数据块");
  check(memory.searchMemory(ref, "吃素").length === 1, "记忆：关键词检索命中");

  chatIndex.indexTurn(ref, { chatId: "c1", turn: 0, title: "饮食", user: "记住我吃素", assistant: "好的，记住了：用户吃素" });
  inbox.postInbox(ref, { kind: "info", title: "提醒", body: "周末聚餐，用户吃素，记得订素食" });
  writeJson(assistantPath(ref, "briefs", "2026-10-02.json"), { day: "2026-10-02", text: "今天：开会\n\n提醒：用户吃素，午饭点素食" });
  writeJson(assistantPath(ref, "memory", "episodes", "2026-09.json"), { text: "九月：讨论了饮食，用户吃素\n\n九月：在做网关" });
  memory.setCore(ref, { 偏好: "用户吃素\n喜欢安静" }, "page");
  const purge = memory.purgeMemory(ref, said.ok ? said.value.id : "", { scrubChatIndex: (needles) => chatIndex.scrubChatIndex(ref, needles) });
  const leftovers = [
    readFileSync(assistantPath(ref, "inbox.json"), "utf8"),
    readFileSync(assistantPath(ref, "briefs", "2026-10-02.json"), "utf8"),
    readFileSync(assistantPath(ref, "memory", "episodes", "2026-09.json"), "utf8"),
    readFileSync(assistantPath(ref, "chat-index", "index.json"), "utf8"),
    readFileSync(assistantPath(ref, "memory", "core.json"), "utf8"),
    readFileSync(assistantPath(ref, "memory", "entries.json"), "utf8"),
  ].join("\n");
  check(purge.ok && !leftovers.includes("用户吃素"), "记忆：彻底删除后摘要、简报、收件箱、索引、核心档案里都搜不到");
  check(readFileSync(assistantPath(ref, "memory-audit.jsonl"), "utf8").split("\n").every((line) => !line.includes("吃素")), "记忆：审计不存正文");
  check(chatIndex.searchChats(ref, "吃素").length === 0, "记忆：彻底删除后会话搜索也搜不到");
  const forget = memory.forgetMemory(ref, inferred.ok ? inferred.value.id : "", "page");
  check(forget.ok && memory.listMemory(ref).entries.every((e) => e.id !== (inferred.ok ? inferred.value.id : "")), "记忆：遗忘删除条目");
  const old = memory.saveMemory(ref, { topic: "x", text: "用户住在旧公寓", basis: "inferred", validUntil: "2020-01-01" }, "chat");
  check(memory.expireMemory(ref) >= 1 && memory.listMemory(ref).entries.find((e) => e.id === (old.ok ? old.value.id : ""))?.invalidAt != null, "记忆：过期标失效而不删除");
  const ev = memory.saveMemory(ref, { topic: "出行", text: "十月去新加坡出差", kind: "事件", basis: "user_said", validUntil: "2020-10-18" }, "chat");
  check(ev.ok && memory.isValid(ev.value), "记忆：过去的事件仍是有效经历");
  memory.markChatDeleted(ref, "c1");
  memory.writeSettings(ref, { paused: true });
  check(!memory.saveMemory(ref, { topic: "x", text: "暂停时写", basis: "user_said" }, "chat").ok && memory.renderMemoryBlock(ref) === "", "记忆：暂停时不写也不注入");
  memory.writeSettings(ref, { paused: false });
  const edited = memory.editMemory(ref, ev.ok ? ev.value.id : "", 0, { text: "x" });
  check(!edited.ok, "记忆：记忆页编辑带 rev，版本不对不覆盖");

  /* ── 检索增强 ── */
  let seed = 7;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pick = <T,>(list: T[]) => list[rand(list.length)];
  const cities = ["北京", "上海", "深圳", "杭州", "成都", "广州", "南京", "西安"];
  const people = ["小王", "老李", "张姐", "Alice", "Bob", "陈总"];
  const templates: Array<[string, () => string]> = [
    ["工作", () => `用户负责${pick(["支付", "搜索", "推荐", "网关", "报表"])}项目，周${pick(["一", "三", "五"])}开例会`],
    ["工作", () => `用户的同事${pick(people)}擅长${pick(["Go", "Rust", "前端", "运维", "设计"])}`],
    ["工作", () => `用户下周去${pick(cities)}开会`],
    ["出行", () => `2026-${String(1 + rand(9)).padStart(2, "0")}-${String(1 + rand(28)).padStart(2, "0")} 去${pick(cities)}出差`],
    ["出行", () => `用户喜欢坐${pick(["高铁", "飞机", "夜车"])}去${pick(cities)}`],
    ["饮食", () => `用户喜欢吃${pick(["火锅", "烧烤", "寿司", "面条", "饺子"])}`],
    ["饮食", () => `用户早上爱喝${pick(["咖啡", "豆浆", "绿茶"])}`],
    ["购物", () => `用户买了一条${pick(["牛仔裤", "围巾", "运动鞋"])}`],
    ["爱好", () => `用户周末${pick(["爬山", "打羽毛球", "看展", "弹吉他"])}`],
    ["家庭", () => `用户的${pick(["妈妈", "哥哥", "女儿"])}住在${pick(cities)}`],
    ["阅读", () => `用户在读《${pick(["三体", "百年孤独", "人类简史"])}》`],
    ["宠物", () => `用户养了一只${pick(["猫", "狗", "兔"])}，叫${pick(["豆豆", "团团", "可乐"])}`],
  ];
  const synthEntries = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const [topic, make] = templates[rand(templates.length)];
      const at = new Date(Date.now() - rand(400) * 86_400_000).toISOString();
      return {
        id: `m_s${i}`,
        rev: 1,
        topic,
        kind: "事实",
        text: `${make()}（${i}）`,
        basis: rand(2) ? "user_said" : "inferred",
        confidence: 1,
        createdAt: at,
        updatedAt: at,
        invalidAt: null,
      };
    });
  const realEntries = [
    { id: "m_diet", topic: "饮食", text: "用户吃素，不吃牛肉" },
    { id: "m_k8s", topic: "工作", text: "Kubernetes 集群在上海" },
    { id: "m_trip", topic: "出行", text: "2026-10-15 去杭州出差" },
  ].map((row) => ({ ...row, rev: 1, kind: "事实", basis: "user_said", confidence: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), invalidAt: null }));
  const rref = { id: "t5", stateDir: resolve(dir, "t5") };
  writeJson(assistantPath(rref, "memory", "entries.json"), { rev: 1, entries: [...synthEntries(1000), ...realEntries, ...synthEntries(1000)] });
  const top = (query: string, n = 3) => memory.searchMemory(rref, query).slice(0, n).map((entry) => entry.id);
  check(top("我能吃牛排吗").includes("m_diet"), "检索：2000 条里“我能吃牛排吗”命中饮食条目（前 3）");
  check(top("素食").includes("m_diet"), "检索：2000 条里“素食”命中饮食条目（前 3）");
  check(top("kubernets 上海").includes("m_k8s"), "检索：拼错的 kubernets 也能找到 Kubernetes 条目（前 3）");
  check(top("10-15 出差")[0] === "m_trip", "检索：日期实体 10-15 在一堆出差里排第一");
  check(top("10月15号去哪")[0] === "m_trip", "检索：中文日期写法归一后命中");
  check(memory.searchMemory(rref, "量子力学").length === 0, "检索：无关查询返回空");
  check(memory.searchMemory(rref, "火锅", { limit: 5 }).length === 5, "检索：limit 生效");

  const tref = { id: "t6", stateDir: resolve(dir, "t6") };
  writeJson(assistantPath(tref, "memory", "entries.json"), { rev: 1, entries: [...synthEntries(2500), ...realEntries, ...synthEntries(2497)] });
  let t = performance.now();
  const coldHits = memory.searchMemory(tref, "我能吃牛排吗");
  const memCold = performance.now() - t;
  const warm: number[] = [];
  for (const query of ["kubernets 上海", "10-15 出差", "素食", "量子力学"]) {
    t = performance.now();
    memory.searchMemory(tref, query);
    warm.push(performance.now() - t);
  }
  const retrievalIndex = retrieval.buildIndex(memory.listMemory(tref).entries.map((entry) => ({ topic: entry.topic, text: entry.text })));
  const pure: number[] = [];
  for (const query of ["kubernets 上海", "10-15 出差", "素食", "我能吃牛排吗"]) {
    t = performance.now();
    retrieval.retrieve(retrievalIndex, query);
    pure.push(performance.now() - t);
  }
  const ms = (list: number[]) => list.map((value) => value.toFixed(1)).join("/");
  console.log(`      5000 条记忆：首次（含读写文件、建索引）${memCold.toFixed(1)}ms；之后 searchMemory ${ms(warm)}ms；纯检索 ${ms(pure)}ms`);
  check(coldHits.slice(0, 3).some((entry) => entry.id === "m_diet") && memCold < 500, "检索：5000 条记忆首次检索（含建索引）< 500ms");
  check(Math.max(...warm) < 200 && Math.max(...pure) < 200, "检索：5000 条记忆检索 < 200ms");
  const lastUsed = memory.listMemory(tref).entries.find((entry) => entry.id === "m_k8s")?.lastUsedAt;
  check(Boolean(lastUsed), "检索：命中条目仍更新 lastUsedAt");

  const cref = { id: "t7", stateDir: resolve(dir, "t7") };
  for (let i = 0; i < 3; i += 1) chatIndex.indexTurn(cref, { chatId: `c${i}`, turn: 0, title: "聊天", user: `随便聊聊 ${i}`, assistant: "好的" });
  const turns = readFileSync(assistantPath(cref, "chat-index", "index.json"), "utf8");
  const base5000 = JSON.parse(turns) as { turns: Array<Record<string, unknown>> };
  for (let i = 0; i < 5000; i += 1) {
    const [title, make] = templates[rand(templates.length)];
    base5000.turns.push({ chatId: `cx${i % 300}`, turn: i, title, user: `${make()}，你帮我记一下。${make()}`, assistant: `好的，记下了：${make()}。还有别的吗？`.repeat(4), at: Date.now() - i * 60_000 });
  }
  base5000.turns.push({ chatId: "cz", turn: 0, title: "集群", user: "我们的 Kubernetes 集群在上海机房", assistant: "收到", at: Date.now() });
  writeJson(assistantPath(cref, "chat-index", "index.json"), base5000);
  t = performance.now();
  const chatHits = chatIndex.searchChats(cref, "kubernets 上海");
  const chatCold = performance.now() - t;
  t = performance.now();
  chatIndex.searchChats(cref, "10-15 出差");
  const chatWarm = performance.now() - t;
  console.log(`      5000 轮会话：首次（含建索引）${chatCold.toFixed(1)}ms，缓存后 ${chatWarm.toFixed(1)}ms`);
  check(chatHits[0]?.chatId === "cz" && chatHits[0].snippet.includes("上海"), "检索：会话搜索拼错也能命中，片段带关键词");
  check(chatIndex.searchChats(cref, "量子力学").length === 0, "检索：会话搜索无关查询返回空");

  /* ── 名字 ── */
  check(name.parseAssistantName("---\nname: 阿福\n---\n正文") === "阿福", "名字：front matter 的 name");
  check(name.parseAssistantName("# 规则\n名字：小橙\n") === "小橙", "名字：正文“名字：”一行");
  check(name.parseAssistantName("没有名字") === "小驳", "名字：没设就叫小驳");
  check(name.parseAssistantName("名字：这是一个超过十六个字符长度的非常长的名字啊啊") === "小驳", "名字：太长回退小驳");
  check(name.parseAssistantName("name: <script>") === "小驳" && name.sanitizeAssistantName("  ") === "小驳", "名字：不合法回退小驳");

  /* ── cron ── */
  const base = Date.parse("2026-10-02T00:30:00Z");
  check(cron.nextRun("0 9 * * *", "Asia/Shanghai", base) === Date.parse("2026-10-02T01:00:00Z"), "cron：上海 9 点 = UTC 1 点");
  check(cron.nextRun("0 9 * * *", "Asia/Shanghai", Date.parse("2026-10-02T01:00:00Z")) === Date.parse("2026-10-03T01:00:00Z"), "cron：严格晚于给定时刻");
  check(cron.nextRun("*/15 * * * *", "UTC", Date.parse("2026-10-02T00:07:00Z")) === Date.parse("2026-10-02T00:15:00Z"), "cron：步长");
  check(cron.nextRun("0 9 * * 1-5", "Asia/Shanghai", Date.parse("2026-10-03T02:00:00Z")) === Date.parse("2026-10-05T01:00:00Z"), "cron：工作日跳过周末");
  const spring = cron.nextRun("30 2 * * *", "America/New_York", Date.parse("2026-03-08T05:00:00Z"));
  check(spring !== null && cron.localParts(spring, "America/New_York").hour === 3, "cron：夏令时不存在的 2:30 顺延到有效时刻");
  const fall = cron.nextRun("30 1 * * *", "America/New_York", Date.parse("2026-11-01T04:00:00Z"));
  check(fall === Date.parse("2026-11-01T05:30:00Z"), "cron：重复的 1:30 只取第一次");
  let threw = false;
  try {
    cron.parseCron("61 * * * *");
  } catch {
    threw = true;
  }
  check(threw, "cron：超范围报错");

  /* ── 日程状态机 ── */
  const sref = { id: "t2", stateDir: resolve(dir, "t2") };
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  schedules.seedDefaults(sref, t0);
  check(schedules.listSchedules(sref).some((s) => s.kind === "brief" && s.cron === "0 9 * * *"), "日程：首次放一条每日简报");
  const remind = schedules.setSchedule(sref, { kind: "remind", cron: "0 9 * * *", tz: "Asia/Shanghai", prompt: "喝水", title: "喝水" }, t0);
  schedules.setSchedule(sref, { id: "s_brief", enabled: false }, t0);
  let execCount = 0;
  const exec = async (r: typeof sref, s: Parameters<typeof jobs.executeSchedule>[1], o: Parameters<typeof jobs.executeSchedule>[2]) => {
    execCount += 1;
    return jobs.executeSchedule(r, s, o, async () => ({ ok: true, runId: "x", text: "简报" }));
  };
  // 停机三天后启动：只补跑一次
  const later = Date.parse("2026-10-04T03:00:00Z");
  await Promise.all(schedules.tickSchedules(sref, exec, later));
  check(execCount === 1, "日程：停机错过多次后只补跑一次");
  await Promise.all(schedules.tickSchedules(sref, exec, later + 60_000));
  check(execCount === 1, "日程：补跑后不会再跑");
  const row = schedules.listSchedules(sref).find((s) => s.id === (remind.ok ? remind.value.id : ""));
  check(row?.nextAt === Date.parse("2026-10-05T01:00:00Z"), "日程：下一次排到明天 9 点");
  check(inbox.listInbox(sref).filter((i) => i.kind === "reminder" && i.title === "喝水").length === 1, "日程：提醒进收件箱一次");
  schedules.setSchedule(sref, { id: remind.ok ? remind.value.id : "", misfire: "skip" }, later);
  await Promise.all(schedules.tickSchedules(sref, exec, Date.parse("2026-10-06T03:00:00Z")));
  check(execCount === 1 && schedules.listOccurrences(sref)[0].state === "skipped", "日程：misfire=skip 错过就跳过");
  const flaky = schedules.setSchedule(sref, { kind: "prompt", cron: "* * * * *", tz: "UTC", prompt: "x", title: "会失败" }, t0);
  let fails = 0;
  const failing = async () => {
    fails += 1;
    return { ok: false, error: "坏了" };
  };
  for (let i = 1; i <= 4; i += 1) await Promise.all(schedules.tickSchedules(sref, failing, t0 + i * 60_000));
  const flakyRow = schedules.listSchedules(sref).find((s) => s.id === (flaky.ok ? flaky.value.id : ""));
  check(fails === 3 && flakyRow?.enabled === false, "日程：连续 3 次失败暂停");
  check(inbox.listInbox(sref).some((i) => i.title.includes("已暂停")), "日程：暂停时提醒");
  const slow = schedules.setSchedule(sref, { kind: "prompt", cron: "* * * * *", tz: "UTC", prompt: "x", title: "慢" }, t0);
  let release: () => void = () => {};
  const hanging = () => new Promise<{ ok: boolean }>((ok) => (release = () => ok({ ok: true })));
  const first = schedules.tickSchedules(sref, hanging, t0 + 60_000);
  schedules.tickSchedules(sref, hanging, t0 + 120_000);
  const overlap = schedules.listOccurrences(sref).find((o) => o.scheduleId === (slow.ok ? slow.value.id : "") && o.state === "skipped");
  check(Boolean(overlap), "日程：上一次还在跑时本次记 skipped");
  release();
  await Promise.all(first);
  schedules.setSchedule(sref, { kind: "remind", cron: "* * * * *", tz: "UTC", prompt: "y", title: "崩" }, t0);
  const occFile = assistantPath(sref, "occurrences.jsonl");
  const { appendJsonl } = await import("./assistant/store.ts");
  appendJsonl(occFile, { occurrenceId: "x@1", scheduleId: "s_x", plannedAt: t0, state: "running" });
  check(schedules.recoverSchedules(sref) === 1 && inbox.listInbox(sref).some((i) => i.title.includes("日程被中断")), "日程：崩溃时在跑的记中断并进收件箱");

  /* ── 待办提醒 ── */
  const todo = todos.addTodo(sref, { text: "交报告", due: "2026-10-02T09:00:00+08:00" });
  check(todo.ok && todo.value.remindAt === Date.parse("2026-10-02T01:00:00Z"), "待办：带时间的 due 会到点提醒");
  check(todos.takeDueReminders(sref, Date.parse("2026-10-02T01:00:01Z")).length === 1 && todos.takeDueReminders(sref, Date.parse("2026-10-02T02:00:00Z")).length === 0, "待办：每条只提醒一次");
  check(!todos.addTodo(sref, { text: "x", due: "明天" }).ok, "待办：due 格式不对就拒绝");
  check(!todos.addTodo(sref, { text: "x", due: "2026-10-03T09:00:00" }).ok, "待办：带时间却不带时区就拒绝");
  check(!todos.addTodo(sref, { text: "x", due: "2026-02-31" }).ok && todos.addTodo(sref, { text: "闰日", due: "2028-02-29" }).ok, "待办：不存在的日子拒绝，闰日照收");

  /* ── 聊天里当场记 + 苹果日历订阅 ── */
  const kref = { id: "cal", stateDir: resolve(dir, "cal") };
  const meet = todos.addTodo(kref, { text: "和老王开会", due: "2026-10-07T15:00:00+08:00", source: "chat", quote: "周三下午三点和老王开会".repeat(20) });
  const again = todos.addTodo(kref, { text: "和老王 开会。", due: "2026-10-07" });
  check(meet.ok && !meet.duplicate && again.ok && again.duplicate && again.value.id === meet.value.id, "待办：同一天同一件事不重复记");
  check(meet.ok && meet.value.source === "chat" && meet.value.quote?.length === 121 && meet.value.quote.endsWith("…"), "待办：记下来源，原话截到 120 字");
  check(todos.addTodo(kref, { text: "和老王开会", due: "2026-10-08" }).ok && todos.listTodos(kref).length === 2, "待办：换一天算新的一件");
  const moved = meet.ok ? todos.updateTodo(kref, meet.value.id, { due: "2026-10-09T10:00:00+08:00" }) : null;
  check(Boolean(moved?.ok && moved.value.remindAt === Date.parse("2026-10-09T02:00:00Z") && !moved.value.reminded), "待办：改时间后重新等提醒");
  check(Boolean(meet.ok && !todos.updateTodo(kref, meet.value.id, { due: "下周" }).ok && todos.updateTodo(kref, meet.value.id, { text: "  " }).ok === false), "待办：改成非法日期或空内容都拒绝");
  check(todos.addTodo(kref, { text: "付 ¥100", due: "2026-10-12" }).ok && !todos.addTodo(kref, { text: "付 $100", due: "2026-10-12" }).duplicate, "待办：去重不吞货币符号");
  todos.addTodo(kref, { text: "交报告, 带 PPT; 别忘\r抄送", due: "2026-10-10" });
  todos.addTodo(kref, { text: "没日期的事" });

  /* ── 客户端时钟 ── */
  const svc = await import("./assistant/service.ts");
  const at = Date.parse("2026-10-05T19:22:00Z");
  const ny = svc.parseClientClock({ now: at + 90_000, tz: "America/New_York" }, at);
  check(ny?.tz === "America/New_York" && ny.skew === 90_000, "时钟：收下客户端时区和时差");
  check(svc.parseClientClock({ now: at, tz: "Mars/Base" }, at) === undefined && svc.parseClientClock({ now: at + 3 * 86_400_000, tz: "Asia/Tokyo" }, at)?.skew === 0, "时钟：认不出的时区不要，钟差太大只用时区");
  const nyLine = svc.clockLine(ny, at);
  check(nyLine.includes("2026-10-05") && nyLine.includes("15:23") && nyLine.includes("UTC-04:00") && nyLine.includes("-04:00 结尾"), "时钟：按客户端时区和时间写，偏移跟着时区走");
  check(svc.clockLine(undefined, at).includes("2026-10-06") && svc.clockLine(undefined, at).includes("UTC+08:00"), "时钟：没收到客户端时钟按默认时区");
  check(svc.clockLine({ tz: "UTC", skew: 0 }, at).includes("Z 结尾"), "时钟：UTC 用 Z");

  const calendar = await import("./assistant/calendar.ts");
  const info = calendar.calendarInfo(kref);
  check(info.enabled && info.token.length >= 40 && calendar.calendarInfo(kref).token === info.token, "日历：默认开，口令生成一次后复用");
  check(calendar.matchesToken(kref, info.token) && !calendar.matchesToken(kref, `${info.token.slice(0, -1)}x`), "日历：口令要完全对上");
  const ics = calendar.buildIcs(kref, "小助", Date.parse("2026-10-05T00:00:00Z"));
  check(ics.includes("DTSTART:20261009T020000Z") && ics.includes("DTEND:20261009T023000Z") && ics.includes("TRIGGER:PT0M"), "日历：带时间的写成 30 分钟事件并到点提醒");
  check(ics.includes("DTSTART;VALUE=DATE:20261008") && ics.includes("DTEND;VALUE=DATE:20261009"), "日历：只有日期的写成全天事件");
  check(ics.includes("SUMMARY:交报告\\, 带 PPT\\; 别忘\\n抄送") && !ics.includes("没日期的事") && !ics.includes("周三下午三点"), "日历：标题转义，没日期的不放，原话不放");
  check(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75), "日历：每行不超过 75 字节");
  check(calendar.noteFetch(kref, 1_000_000) === true && calendar.noteFetch(kref, 1_030_000) === false && calendar.calendarInfo(kref).lastFetchAt === 1_000_000, "日历：记下首次拉取，一分钟内不重复写");
  check(calendar.noteFetch(kref, 1_000_000 + 3_600_000) === false && calendar.noteFetch(kref, 1_000_000 + 13 * 3_600_000) === true, "日历：之后每隔半天推一次拉取时间，App 不会误报取消订阅");
  check(calendar.buildIcs(kref, "小助", 1).match(/DTSTAMP:\S+/g)?.join() === calendar.buildIcs(kref, "小助", 2).match(/DTSTAMP:\S+/g)?.join(), "日历：DTSTAMP 不随拉取时间变化");
  check(calendar.findByToken([ref, kref], info.token) === kref && calendar.findByToken([ref, kref], "y".repeat(43)) === undefined, "日历：按口令找到租户，错口令查不到");
  const rotated = calendar.setCalendar(kref, { rotate: true });
  check(rotated.token !== info.token && rotated.lastFetchAt === undefined && !calendar.matchesToken(kref, info.token), "日历：换口令后旧链接失效、订阅状态清零");
  calendar.setCalendar(kref, { enabled: false });
  check(calendar.matchesToken(kref, rotated.token) && !calendar.buildIcs(kref, "小助").includes("BEGIN:VEVENT"), "日历：关掉后给空日历，让订阅里的旧事件清掉");

  /* ── 推送 ── */
  const vapid = push.vapidKeys(dir);
  check(push.vapidKeys(dir).publicKey === vapid.publicKey, "推送：VAPID 密钥落盘复用");
  const jwt = push.vapidJwt(vapid, "https://fcm.googleapis.com/fcm/send/abc", "mailto:a@b.c");
  const [h, p, s] = jwt.split(".");
  const raw = Buffer.from(vapid.publicKey, "base64url");
  const pubKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  check(verify("sha256", Buffer.from(`${h}.${p}`), { key: pubKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), "推送：VAPID JWT 签名可验证");
  check(JSON.parse(Buffer.from(p, "base64url").toString()).aud === "https://fcm.googleapis.com", "推送：aud 是推送服务的 origin");
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const authSecret = Buffer.from("0123456789abcdef");
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") } };
  const body = push.encryptPayload(sub, Buffer.from('{"title":"你好"}'));
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const hk = (saltB: Buffer, ikm: Buffer, info: Buffer, len: number) => {
    const prk = createHmac("sha256", saltB).update(ikm).digest();
    return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
  };
  const shared = ua.computeSecret(asPub);
  const ikm = hk(authSecret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32);
  const cek = hk(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hk(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
  check(plain.subarray(0, -1).toString() === '{"title":"你好"}' && plain[plain.length - 1] === 2, "推送：aes128gcm 按接收方流程能解开");
  const pref = { id: "t3", stateDir: resolve(dir, "t3") };
  push.addSubscription(pref, sub);
  push.addSubscription(pref, { ...sub, endpoint: "https://push.example/gone" });
  push.addSubscription(pref, sub);
  check(push.listSubscriptions(pref).length === 2, "推送：同一 endpoint 去重");
  const seen: Array<{ endpoint: string; headers: Record<string, string> }> = [];
  const sender = async (endpoint: string, init: { headers: Record<string, string> }) => {
    seen.push({ endpoint, headers: init.headers });
    return { status: endpoint.endsWith("gone") ? 410 : 201 };
  };
  const res = await push.sendPush(pref, vapid, { itemId: "i_1", kind: "brief", title: "今日简报：10-02", url: "./?inbox=i_1" }, { sender });
  check(res.sent === 1 && push.listSubscriptions(pref).length === 1, "推送：410 的订阅被删掉");
  check(seen.every((row) => row.headers["Content-Encoding"] === "aes128gcm" && row.headers.Authorization.startsWith("vapid t=")), "推送：带 aes128gcm 和 VAPID 头");
  const failSender = async () => ({ status: 500 });
  await push.sendPush(pref, vapid, { itemId: "i_2", kind: "reminder", title: "x", url: "./" }, { sender: failSender });
  let retried = 0;
  await push.retryFailedPushes(pref, vapid, async () => {
    retried += 1;
    return { status: 201 };
  });
  check(retried === 1, "推送：失败的在重启后补发");

  /* ── 工具分权 ── */
  const names = (role: "chat" | "schedule" | "integrator" | "loop") =>
    Object.keys(tools.assistantTools({ ref, role, delegate: async () => "", workspaces: () => ["a"] }));
  check(names("chat").includes("memory_save") && names("chat").includes("delegate") && !names("chat").includes("memory_invalidate"), "工具：对话里能写记忆、能委派，不能标失效");
  check(names("integrator").includes("memory_invalidate") && names("integrator").includes("core_update") && !names("integrator").includes("delegate"), "工具：整理者能标失效、改核心档案，不能委派");
  check(!names("schedule").includes("memory_save") && names("schedule").includes("memory_search"), "工具：定时任务只读记忆");
  check(JSON.stringify(names("loop")) === JSON.stringify(["inbox_post"]), "工具：Loop 和子工作区后台运行只有 inbox_post，没有记忆");
  const forgetTool = tools.assistantTools({ ref, role: "chat" }).memory_forget;
  const refused = await forgetTool.execute({ id: "m_x", confirmed: false }, {});
  check(typeof refused === "string" && refused.includes("确认"), "工具：对话里遗忘要先确认");

  /* ── 整理者输入 ── */
  const iref = { id: "t4", stateDir: resolve(dir, "t4") };
  chatIndex.indexTurn(iref, { chatId: "c9", turn: 0, title: "聊天", user: "我下周三去杭州", assistant: "好的" });
  chatIndex.indexTurn(iref, { chatId: "c9", turn: 1, title: "聊天", user: "```js\nconst a = 1\n```", assistant: "代码" });
  check(jobs.pendingChats(iref, Date.now()).length === 0, "整理者：会话没空闲 30 分钟不处理");
  const idle = jobs.pendingChats(iref, Date.now() + 31 * 60_000);
  check(idle.length === 1, "整理者：空闲后处理");
  const prompt = jobs.integratorPrompt(iref, idle);
  check(prompt.includes("我下周三去杭州") && !prompt.includes("const a = 1") && !prompt.includes("好的"), "整理者：只看用户亲手输入，代码块当外部材料，不看助理回答");
  const hz = chatIndex.searchChats(iref, "杭州");
  check(hz.length === 1 && hz[0].chatId === "c9" && hz[0].turn === 0 && hz[0].snippet.includes("杭州"), "会话搜索：命中轮次，返回片段");
  let ran = 0;
  await jobs.runIntegrator(iref, async () => {
    ran += 1;
    return { ok: true, runId: "r", text: "写了 1 条" };
  }, Date.now() + 31 * 60_000);
  check(ran === 1 && jobs.pendingChats(iref, Date.now() + 31 * 60_000).length === 0, "整理者：处理过的轮次不再处理");
  check(existsSync(assistantPath(iref, "integrator.json")), "整理者：进度落盘");

  /* ── 委派挂起审批 ── */
  const approvals = await import("./assistant/approvals.ts");
  const delegations = await import("./assistant/delegations.ts");
  const aref = { id: "t5", stateDir: resolve(dir, "t5") };
  const d = delegations.createDelegation(aref, { parentChatId: "p1", childChatId: "c1", workspace: "ws", title: "改 README", task: "改", mode: "foreground" });
  const a1 = approvals.addApproval(aref, { chatId: "c1", callId: "k1", tool: "edit", summary: approvals.summarizeArgs({ path: "README.md", content: "x".repeat(5000) }), delegationId: d.id, parentChatId: "p1" }, 1000);
  check(a1.summary === "README.md" && a1.expiresAt === 1000 + 24 * 3_600_000, "委派审批：落盘摘要只有路径，24 小时到期");
  const leak = approvals.summarizeArgs({ target: "notes/a.md", content: "机密正文", patch: "+ 机密补丁" });
  check(leak === "notes/a.md" && approvals.summarizeArgs({ content: "机密正文" }) === "", "委派审批：摘要只取路径类字段，不带文件内容");
  const octIndex = retrieval.buildIndex([
    { topic: "出差", text: "2026-10-15 去杭州出差" },
    { topic: "杂事", text: "十月交房租" },
  ]);
  const octHits = retrieval.retrieve(octIndex, "10月15日").map((hit) => hit.index);
  check(octHits[0] === 0 && !octHits.includes(1), "检索：查具体日期时，只同月份的条目不放进结果");
  check(retrieval.retrieve(octIndex, "十月").some((hit) => hit.index === 1), "检索：只查月份时，同月份的条目照常命中");
  check(retrieval.retrieve(octIndex, "量子力学").length === 0, "检索：无关查询返回空");
  const a2 = approvals.addApproval(aref, { chatId: "c1", callId: "k2", tool: "shell", summary: "npm test", delegationId: d.id }, 2000);
  check(approvals.listApprovals(aref).length === 1 && approvals.listApprovals(aref)[0].id === a2.id, "委派审批：同一子会话只留最新一项");
  check(approvals.findApproval(aref, "c1", "k2")?.tool === "shell" && !approvals.findApproval(aref, "c1", "k1"), "委派审批：按会话和调用查找");
  check(approvals.settleApproval(aref, "c1", "zz").length === 0 && approvals.listApprovals(aref).length === 1, "委派审批：callId 不符不摘");
  check(approvals.settleApproval(aref, "c1").length === 1 && approvals.listApprovals(aref).length === 0, "委派审批：作答后摘掉");
  approvals.addApproval(aref, { chatId: "c2", callId: "k3", tool: "edit", summary: "", delegationId: d.id });
  check(approvals.recoverApprovals(aref).length === 1 && approvals.listApprovals(aref).length === 0, "委派审批：重启时残留全部作废");
  delegations.updateDelegation(aref, d.id, { status: "awaiting" });
  const stale = delegations.recoverDelegations(aref);
  check(stale.length === 1 && delegations.getDelegation(aref, d.id)?.status === "failed", "委派：重启时待批的委派记为失败");

  /* ── 助理新建工作区：先问用户 ── */
  const wsa = await import("./assistant/workspaceAsk.ts");
  const wref = { id: "t6", stateDir: resolve(dir, "t6") };
  let changes = 0;
  const pending = wsa.askWorkspace(wref, { chatId: "asst", name: "acrabat", reason: "讲稿要单独成项目" }, () => (changes += 1));
  const ask = approvals.listApprovals(wref)[0];
  check(ask?.tool === "create_workspace" && ask.chatId === "asst" && ask.summary.includes("acrabat") && changes === 1, "建工作区：挂起一项确认，并通知客户端刷新");
  check(inbox.listInbox(wref).some((row) => row.kind === "approval" && row.title.includes("acrabat")), "建工作区：收件箱同步一条待批准消息");
  check(!wsa.answerWorkspaceAsk(wref, "other", ask.callId, true), "建工作区：会话对不上不能作答");
  check(!wsa.answerWorkspaceAsk({ id: "t7", stateDir: wref.stateDir }, "asst", ask.callId, true), "建工作区：租户对不上不能作答");
  check(wsa.answerWorkspaceAsk(wref, "asst", ask.callId, true) && (await pending) === "allowed", "建工作区：同意后工具调用继续");
  check(approvals.listApprovals(wref).length === 0 && changes === 2, "建工作区：作答后摘掉确认并再次通知");
  check(!wsa.answerWorkspaceAsk(wref, "asst", ask.callId, true), "建工作区：同一项不能答两次");
  const no = wsa.askWorkspace(wref, { chatId: "asst", name: "x", reason: "" }, () => {});
  wsa.answerWorkspaceAsk(wref, "asst", approvals.listApprovals(wref)[0].callId, false);
  check((await no) === "denied", "建工作区：拒绝");
  const late = await wsa.askWorkspace(wref, { chatId: "asst", name: "y", reason: "", ttlMs: 30 }, () => {});
  check(late === "expired" && approvals.listApprovals(wref).length === 0, "建工作区：超时按取消处理并摘掉确认");
  const wnames = (role: "chat" | "schedule" | "loop") =>
    Object.keys(tools.assistantTools({ ref, role, delegate: async () => "", createWorkspace: async () => "", workspaces: () => [] }));
  check(wnames("chat").includes("create_workspace") && !wnames("schedule").includes("create_workspace") && !wnames("loop").includes("create_workspace"), "工具：只有前台对话能请求建工作区，定时和后台不能");
} catch (err) {
  failed += 1;
  console.log(`FAIL  冒烟异常：${err instanceof Error ? err.stack : String(err)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
