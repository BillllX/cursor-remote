import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 记忆分层冒烟：W0 工作偏好、分层规则、推断晋升、工作区记忆提议与确认卡、线程摘要、v1→v2 迁移。
 * 不调用模型、不起网关：直接调 assistant/ 下的模块。
 */

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(resolve(gatewayDir, ".memory-layers-smoke-"));
process.env.CURSOR_REMOTE_STATE_DIR = dir;

let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

try {
  const memory = await import("./assistant/memory.ts");
  const wm = await import("./assistant/workspaceMemory.ts");
  const migrate = await import("./assistant/migrate.ts");
  const approvals = await import("./assistant/approvals.ts");
  const tools = await import("./assistant/tools.ts");
  const inbox = await import("./assistant/inbox.ts");
  const { writeJson, assistantPath, assistantDir } = await import("./assistant/store.ts");

  /* ── 租户布局：USER 根 / 子工作区 / 仓库 ── */
  const root = resolve(dir, "ws");
  const tenant = { id: "t1", stateDir: resolve(dir, "t1"), workspaceRoot: root };
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  mkdirSync(assistantDir(ref), { recursive: true });
  write(resolve(root, "AGENTS.md"), "---\nname: 可乐\n---\n\n个人助理：语气可爱活泼，做事细致。回答默认用中文。\n");
  write(resolve(root, "proj", "AGENTS.md"), "子工作区：proj 用 pnpm。");
  write(resolve(root, "proj", "app", "AGENTS.md"), "仓库：app 改完跑 npm test。");
  mkdirSync(resolve(root, "proj", "app", ".git"), { recursive: true });
  write(resolve(root, "proj", "app", "src", "main.ts"), "export {};\n");
  mkdirSync(resolve(root, "other"), { recursive: true });

  /* ── 分层规则 ── */
  const deep = wm.layeredRules(root, resolve(root, "proj", "app"));
  check(deep.includes("proj 用 pnpm") && deep.includes("app 改完跑 npm test"), "分层：仓库会话读到子工作区和仓库两层");
  check(deep.indexOf("proj 用 pnpm") < deep.indexOf("app 改完跑 npm test"), "分层：近层排在后面");
  check(!deep.includes("可爱活泼"), "分层：子工作区会话不读 USER 根目录的人设");
  const atRoot = wm.layeredRules(root, root);
  check(atRoot.includes("可爱活泼") && !atRoot.includes("pnpm"), "分层：根目录会话只读根目录这一层");
  check(wm.layeredRules(root, resolve(dir, "elsewhere")) === "", "分层：工作区外的 cwd 什么都不读");
  const capped = wm.layeredRules(root, resolve(root, "proj", "app"), 40);
  check(capped.includes("app 改完跑") && !capped.includes("pnpm"), "分层：超上限先砍远层");

  /* ── W0 工作偏好 ── */
  check(wm.workspaceContext(tenant, resolve(root, "proj")).includes("<work_preferences>") === false, "W0：没有工作偏好时不出块");
  const added = memory.addWorkPreference(ref, "回复用中文", "chat");
  check(added.ok, "W0：前台会话能加工作偏好");
  const ctx = wm.workspaceContext(tenant, resolve(root, "proj"));
  check(ctx.includes("<work_preferences>") && ctx.includes("回复用中文") && ctx.includes("proj 用 pnpm"), "W0：子工作区会话拿到工作偏好 + 规则");
  memory.saveMemory(ref, { topic: "家", text: "用户家住北京朝阳区望京", basis: "user_said" }, "chat");
  check(!ctx.includes("望京") && !wm.workspaceContext(tenant, resolve(root, "proj")).includes("望京"), "W0：其余个人记忆不出 USER 会话");
  const block = memory.renderMemoryBlock(ref);
  check(block.includes("望京") && !block.includes("回复用中文"), "W0：助理记忆块不重复带工作偏好");
  check(!memory.setCore(ref, { 工作偏好: "- 偷偷加" }, "integrator").ok, "W0：整理者不能改工作偏好");
  check(!memory.addWorkPreference(ref, "token: abcdefgh1234", "chat").ok, "W0：像密钥的不收");
  const long = Array.from({ length: 40 }, (_, i) => `第${i}条很长很长的工作习惯描述`).join("\n");
  check(!memory.setCore(ref, { 工作偏好: long }, "page").ok, "W0：超 200 token 拒绝");
  memory.writeSettings(ref, { paused: true });
  check(memory.renderWorkPreferences(ref) === "", "W0：暂停记忆时不注入");
  memory.writeSettings(ref, { paused: false });
  check(memory.removeWorkPreference(ref, "回复用中文", "chat").ok && memory.workPreferenceLines(ref).length === 0, "W0：能删");
  memory.addWorkPreference(ref, "回复用中文", "page");
  const toForget = memory.saveMemory(ref, { topic: "工作", text: "提交信息用英文", basis: "user_said" }, "chat");
  memory.addWorkPreference(ref, "提交信息用英文", "page");
  if (toForget.ok) memory.forgetMemory(ref, toForget.value.id, "page");
  check(!memory.workPreferenceLines(ref).includes("提交信息用英文"), "W0：遗忘条目时级联删掉工作偏好里的同一句");

  /* ── 推断晋升 ── */
  memory.saveMemory(ref, { topic: "饮食", text: "用户偏爱川菜", basis: "inferred" }, "chat");
  check(!memory.renderMemoryBlock(ref).includes("川菜"), "推断：只出现一次不进常驻索引");
  check(memory.searchMemory(ref, "川菜").length === 1, "推断：照样能检索到");
  memory.saveMemory(ref, { topic: "饮食", text: "用户偏爱川菜", basis: "inferred" }, "integrator");
  check(memory.renderMemoryBlock(ref).includes("川菜"), "推断：独立出现两次后常驻");
  memory.saveMemory(ref, { topic: "运动", text: "用户周末跑步", basis: "inferred" }, "chat");
  memory.saveMemory(ref, { topic: "运动", text: "用户周末跑步", basis: "user_said" }, "chat");
  check(memory.renderMemoryBlock(ref).includes("周末跑步"), "推断：用户确认后常驻");

  /* ── 工作区记忆提议 → 确认卡 ── */
  const chatId = "c-proj";
  const cwd = resolve(root, "proj");
  const propose = (args: Partial<Parameters<typeof wm.proposeWorkspaceMemory>[1]>) =>
    wm.proposeWorkspaceMemory(tenant, { chatId, cwd, section: "约定", text: "", ...args }) as { ok: boolean; error?: string; duplicate?: boolean };
  check(propose({ text: "依赖统一用 pnpm 装" }).ok, "提议：当前工作区能提");
  check(propose({ text: "app 的入口在 src/main.ts", path: "app", section: "约定", refs: "src/main.ts" }).ok, "提议：能指定到下面的仓库");
  check(!propose({ text: "越界", path: ".." }).ok, "提议：不能写到 USER 根目录");
  check(!propose({ text: "越界", path: "../other" }).ok, "提议：不能写到别的工作区");
  check(!propose({ text: "部署 key: sk-abcdefghijklmnopqrstuv" }).ok, "提议：像密钥的拒掉");
  check(!propose({ text: "注意用户家住北京朝阳区望京那边" }).ok, "提议：个人记忆里的句子拒掉");
  check(propose({ text: "依赖统一用 pnpm 装" }).duplicate === true, "提议：重复的不再排队");
  check(approvals.listApprovals(ref).length === 0, "提议：攒着，不马上出卡");

  // 同一会话的运行审批不会挤掉确认卡，运行收尾也不摘
  const card = wm.flushChat(ref, chatId);
  check(Boolean(card) && approvals.listApprovals(ref).some((item) => item.tool === "workspace_memory"), "出卡：线程收尾合成一张确认卡");
  approvals.addApproval(ref, { chatId, callId: "run-1", tool: "write", summary: "a.ts" });
  approvals.settleApproval(ref, chatId);
  check(approvals.listApprovals(ref).some((item) => item.callId === card!.callId), "出卡：运行审批来去不影响确认卡");
  check(inbox.listInbox(ref).some((item) => item.kind === "approval" && item.body.includes("pnpm")), "出卡：收件箱有完整清单");

  const answered = wm.answerCard(tenant, chatId, card!.callId, true);
  const projFile = readFileSync(resolve(root, "proj", ".jiebo/memory.md"), "utf8");
  const appFile = readFileSync(resolve(root, "proj", "app", ".jiebo/memory.md"), "utf8");
  check(answered?.ok === true && answered.written === 2, "批准：两条都写下");
  check(projFile.includes("## 约定") && projFile.includes("依赖统一用 pnpm 装"), "批准：子工作区 .jiebo/memory.md 有这条");
  check(appFile.includes("refs=src/main.ts"), "批准：仓库那条带引用");
  check(readFileSync(resolve(root, "proj", "app", ".jiebo/.gitignore"), "utf8").includes("memory.md"), "批准：新建的 memory.md 默认不进版本库");
  write(resolve(root, "other", ".jiebo", ".gitignore"), "# 我自己的\n");
  wm.appendMemoryLines(resolve(root, "other"), [{ section: "约定", text: "手动写入", refs: [] }]);
  check(readFileSync(resolve(root, "other", ".jiebo/.gitignore"), "utf8") === "# 我自己的\n", "批准：已有的 .jiebo/.gitignore 不动");
  check(!approvals.listApprovals(ref).some((item) => item.callId === card!.callId), "批准：卡摘掉了");
  check(wm.answerCard(tenant, chatId, "nope", true) === null, "批准：不认识的卡交回给别的审批");
  const ctxAfter = wm.workspaceContext(tenant, resolve(root, "proj", "app"));
  check(ctxAfter.includes("依赖统一用 pnpm 装") && ctxAfter.includes("app 的入口在 src/main.ts"), "注入：之后的会话读到工作区记忆");
  rmSync(resolve(root, "proj", "app", "src", "main.ts"));
  check(wm.workspaceContext(tenant, resolve(root, "proj", "app")).includes("待核实"), "注入：引用的文件没了标待核实");

  // 人手加的行和顺序保留
  write(resolve(root, "proj", ".jiebo/memory.md"), `${projFile.trim()}\n- 人手加的一条\n`);
  propose({ text: "测试用 vitest", section: "命令" });
  const card2 = wm.flushChat(ref, chatId)!;
  wm.answerCard(tenant, chatId, card2.callId, true);
  const proj2 = readFileSync(resolve(root, "proj", ".jiebo/memory.md"), "utf8");
  check(proj2.includes("人手加的一条") && proj2.includes("## 命令") && proj2.includes("测试用 vitest"), "写回：保留人手内容，新小节追加");

  // 拒绝、过期、重启
  propose({ text: "被拒的一条" });
  const card3 = wm.flushChat(ref, chatId)!;
  wm.answerCard(tenant, chatId, card3.callId, false);
  check(!readFileSync(resolve(root, "proj", ".jiebo/memory.md"), "utf8").includes("被拒的一条"), "拒绝：不写");
  propose({ text: "会过期的一条" });
  const card4 = wm.flushChat(ref, chatId)!;
  check(wm.expireCards(ref, card4.expiresAt + 1) === 1 && wm.listProposals(ref).proposals.length === 0, "过期：卡和提议一起作废");
  propose({ text: "重启前攒的一条" });
  const card5 = wm.flushChat(ref, chatId)!;
  propose({ text: "重启前还没出卡的一条" });
  approvals.recoverApprovals(ref);
  wm.restoreCards(ref);
  const after = approvals.listApprovals(ref).filter((item) => item.tool === "workspace_memory");
  check(after.some((item) => item.callId === card5.callId) && after.length === 2, "重启：卡挂回去，没出卡的直接出卡");

  // 空闲出卡
  propose({ text: "空闲出卡的一条", path: "app" });
  const chat2 = "c-idle";
  wm.proposeWorkspaceMemory(tenant, { chatId: chat2, cwd, section: "坑", text: "别在 proj 根目录跑 npm i" });
  let flushed = false;
  wm.scheduleFlush(ref, chat2, () => (flushed = true), 20);
  wm.cancelFlush(ref, chat2);
  await new Promise((ok) => setTimeout(ok, 40));
  check(!flushed, "空闲：新回合开始会取消出卡");
  wm.scheduleFlush(ref, chat2, () => (flushed = true), 20);
  await new Promise((ok) => setTimeout(ok, 60));
  check(flushed, "空闲：线程空闲后出卡");

  /* ── 线程摘要 + 助理只读 ── */
  wm.noteWorkspaceThread(tenant, { chatId: "c-t1", cwd: resolve(root, "proj", "app"), title: "修登录", user: "登录页白屏，帮我看看", assistant: "已修好：路由守卫漏了 await。\n\n其余细节……" });
  wm.noteWorkspaceThread(tenant, { chatId: "c-t1", cwd: resolve(root, "proj", "app"), title: "修登录", user: "再加个测试", assistant: "加了 login.test.ts。" });
  wm.noteWorkspaceThread(tenant, { chatId: "c-root", cwd: root, title: "x", user: "根目录的", assistant: "y" });
  const read = wm.readWorkspaceMemory(tenant, "proj", "登录") as { ok: boolean; layers: { dir: string; text: string }[]; threads: { ask: string; lastAsk: string; outcome: string; turns: number }[] };
  check(read.ok && read.layers.some((layer) => layer.dir === "proj/app" && layer.text.includes("npm test")), "只读：带上下一层仓库的规则");
  check(read.threads.length === 1 && read.threads[0].ask.includes("白屏") && read.threads[0].lastAsk.includes("测试") && read.threads[0].turns === 2, "只读：每个线程一行摘要");
  check(!(wm.readWorkspaceMemory(tenant, "..") as { ok: boolean }).ok, "只读：不能越界");
  check(wm.scrubWorkspaceIndex(ref, ["白屏"]) > 0, "彻底删除：摘要里的片段能抹掉");
  wm.dropWorkspaceThread(ref, "c-t1");
  check((wm.readWorkspaceMemory(tenant, "proj") as { threads: unknown[] }).threads.length === 0, "删会话：摘要一起删");

  /* ── 工具分权 ── */
  const host = (role: "chat" | "integrator" | "schedule" | "loop") => ({ ref, role, workspaceMemory: () => ({ ok: true }) });
  const chatTools = Object.keys(tools.assistantTools(host("chat")));
  const integratorTools = Object.keys(tools.assistantTools(host("integrator")));
  check(chatTools.includes("work_preference_add") && chatTools.includes("workspace_memory_read"), "工具：前台助理有工作偏好和只读工作区");
  check(!integratorTools.includes("work_preference_add") && !integratorTools.includes("workspace_memory_read"), "工具：整理者既不能写工作偏好，也不读工作区");
  const sessionTools = Object.keys(tools.workspaceSessionTools({ propose: () => ({ ok: true }) }));
  check(sessionTools.length === 1 && sessionTools[0] === "workspace_memory_propose", "工具：工作区会话只有提议这一个");
  check(memory.CORE_TOKEN_BUDGET === 1200 && memory.INDEX_TOKEN_BUDGET === 300 && memory.WORK_PREF_TOKEN_BUDGET === 200, "预算：核心 1200 / 索引 300 / 工作偏好 200");

  // 后台委派：只读工具 + 提议，没有个人记忆工具；提示词带工作区上下文
  const bg = await import("./assistant/background.ts");
  const service = await import("./assistant/service.ts");
  let seen: { prompt: string; tools: string[] } | null = null;
  bg.bindBackground({
    apiKey: () => "key",
    listModels: async () => [bg.BACKGROUND_MODEL],
    sandbox: () => true,
    prompt: async (message, options) => {
      seen = { prompt: message, tools: Object.keys(options.local?.customTools ?? {}) };
      return { id: "r", status: "finished", result: "方案" } as never;
    },
  });
  await service.runDelegateInBackground({ ...tenant, name: "t" }, { chatId: "c-bg", cwd: resolve(root, "proj"), task: "看看", label: "后台" });
  const bgSeen = seen as { prompt: string; tools: string[] } | null;
  check(Boolean(bgSeen?.tools.includes("workspace_memory_propose")) && !bgSeen?.tools.some((name) => name.startsWith("memory_") || name.startsWith("work_preference")), "后台委派：能提议，没有个人记忆工具");
  check(Boolean(bgSeen?.prompt.includes("proj 用 pnpm")) && Boolean(bgSeen?.prompt.includes("回复用中文")), "后台委派：提示词带工作偏好和分层规则");

  /* ── v1 → v2 迁移 ── */
  const old = { id: "t2", stateDir: resolve(dir, "t2"), workspaceRoot: resolve(dir, "ws2") };
  const oldRef = { id: old.id, stateDir: old.stateDir };
  write(resolve(old.workspaceRoot, "AGENTS.md"), "---\nname: 可乐\n---\n\n个人助理：语气可爱活泼，做事细致。回答默认用中文。\n");
  mkdirSync(resolve(old.workspaceRoot, "cursorremote", "cursor-remote", ".git"), { recursive: true });
  mkdirSync(resolve(old.workspaceRoot, "keda"), { recursive: true });
  const at = "2026-10-01T00:00:00.000Z";
  const entry = (id: string, basis: string, topic: string, text: string) => ({ id, rev: 1, topic, kind: "事实", text, basis, confidence: basis === "user_said" ? 1 : 0.6, createdAt: at, updatedAt: at, invalidAt: null });
  writeJson(assistantPath(oldRef, "memory", "entries.json"), {
    rev: 3,
    entries: [
      entry("m1", "user_said", "工作", "用户要求记下 cursor-remote 推送 GitHub 的流程：仓库在 cursorremote/cursor-remote"),
      entry("m2", "inferred", "工作", "用户在做 cursor-remote 的 iOS 客户端，重视设计准则"),
      entry("m3", "user_said", "工作", "用户希望推送、部署这类重复流程一次配好、记下来，下次直接照做"),
      entry("m4", "user_said", "新房", "用户的新房约 144 平方米"),
      entry("m5", "inferred", "饮食", "用户可能喜欢咖啡"),
    ],
  });
  writeJson(assistantPath(oldRef, "memory", "core.json"), { rev: 6, fields: { 关于我: "你叫可乐", 偏好: "可爱活泼，但是非常细致", 近况: "新房在北京", 人物: "有一个孩子" } });
  writeJson(assistantPath(oldRef, "approvals.json"), { items: [] });
  check(migrate.memorySchemaVersion(oldRef) === 1, "迁移：老账户是 v1");
  const report = migrate.migrateMemory(old)!;
  check(Boolean(report) && migrate.memorySchemaVersion(oldRef) === 2, "迁移：升到 v2");
  check(existsSync(assistantPath(oldRef, "memory", "backup-v1", "entries.json")) && existsSync(assistantPath(oldRef, "memory", "backup-v1", "core.json")), "迁移：先备份");
  const migrated = memory.listMemory(oldRef).entries;
  check(migrated.length === 5 && migrated.filter((item) => item.basis === "inferred").every((item) => item.seen === 1), "迁移：条目一条不少，老推断记作出现一次");
  check(typeof memory.readCore(oldRef).fields.工作偏好 === "string" && memory.readCore(oldRef).fields.近况 === "新房在北京", "迁移：核心档案补栏，原字段不动");
  const cards = wm.listProposals(oldRef);
  const prefCard = cards.cards.find((item) => item.tool === "work_preferences");
  const wsCard = cards.cards.find((item) => item.tool === "workspace_memory");
  const prefTexts = cards.proposals.filter((item) => item.kind === "work_pref").map((item) => item.text);
  check(Boolean(prefCard) && prefTexts.some((text) => text.includes("回答默认用中文")), "迁移：根目录 AGENTS.md 的通用习惯成了工作偏好候选");
  check(!prefTexts.some((text) => text.includes("可爱")), "迁移：人设不当工作偏好");
  check(prefTexts.some((text) => text.includes("一次配好")), "迁移：你说过的跨项目工作习惯成了候选");
  const wsItems = cards.proposals.filter((item) => item.kind === "workspace");
  check(Boolean(wsCard) && wsItems.length === 2 && wsItems.every((item) => item.dir === "cursorremote/cursor-remote"), "迁移：提到仓库的项目知识归到那个仓库");
  check(!cards.proposals.some((item) => item.text.includes("144") || item.text.includes("咖啡")), "迁移：个人生活的不动");
  check(approvals.listApprovals(oldRef).length === 2, "迁移：两张确认卡都挂上了");
  check(inbox.listInbox(oldRef).some((item) => item.title === "记忆升级到分层版"), "迁移：收件箱说明一次");
  check(readFileSync(resolve(old.workspaceRoot, "AGENTS.md"), "utf8").includes("回答默认用中文"), "迁移：不改用户的 AGENTS.md");
  check(memory.workPreferenceLines(oldRef).length === 0 && !existsSync(resolve(old.workspaceRoot, "cursorremote", "cursor-remote", ".jiebo")), "迁移：没批准前什么都不搬");
  check(migrate.migrateMemory(old) === null && wm.listProposals(oldRef).cards.length === 2, "迁移：只跑一次");

  wm.answerCard(old, `assistant-${old.id}`, prefCard!.callId, true);
  check(memory.workPreferenceLines(oldRef).some((line) => line.includes("回答默认用中文")), "迁移批准：工作偏好写进去了");
  check(wm.workspaceContext(old, resolve(old.workspaceRoot, "keda")).includes("回答默认用中文"), "迁移批准：子工作区会话从此看得到默认中文");
  check(Boolean(memory.listMemory(oldRef).entries.find((item) => item.id === "m3")?.invalidAt), "迁移批准：搬走的那条个人记忆标失效");
  wm.answerCard(old, `assistant-${old.id}`, wsCard!.callId, true);
  const repoMem = readFileSync(resolve(old.workspaceRoot, "cursorremote", "cursor-remote", ".jiebo/memory.md"), "utf8");
  check(repoMem.includes("推送 GitHub") && repoMem.includes("## 命令"), "迁移批准：项目流程写进仓库的工作区记忆");
  const m1 = memory.listMemory(oldRef).entries.find((item) => item.id === "m1")!;
  check(Boolean(m1.invalidAt) && (m1.invalidReason || "").includes("工作区记忆"), "迁移批准：原条目标失效、写明去向");
  check(memory.restoreMemory(oldRef, "m1").ok, "迁移批准：失效的能在记忆页恢复");

  // 迁移中途退出后再跑：不重复出卡
  const crash = { id: "t3", stateDir: resolve(dir, "t3"), workspaceRoot: old.workspaceRoot };
  const crashRef = { id: crash.id, stateDir: crash.stateDir };
  writeJson(assistantPath(crashRef, "memory", "entries.json"), { rev: 1, entries: [entry("m1", "user_said", "工作", "cursor-remote 发版先打 tag")] });
  migrate.migrateMemory(crash);
  writeJson(assistantPath(crashRef, "memory", "schema.json"), { version: 1 });
  migrate.migrateMemory(crash);
  check(wm.listProposals(crashRef).proposals.filter((item) => item.text.includes("打 tag")).length === 1, "迁移：重入不重复出卡");

  // 没用过助理的租户不建目录
  const fresh = { id: "t4", stateDir: resolve(dir, "t4"), workspaceRoot: old.workspaceRoot };
  check(migrate.migrateMemory(fresh) === null && !existsSync(assistantDir({ id: fresh.id, stateDir: fresh.stateDir })), "迁移：没用过助理的账户不动");
} catch (err) {
  failed += 1;
  console.error(err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
