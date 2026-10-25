import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const app = read("ios/Jiebo/Jiebo/JieboApp.swift");
const commands = read("ios/Jiebo/Jiebo/Session/PadCommands.swift");
const router = read("ios/Jiebo/Jiebo/Session/PadRouter.swift");
const home = read("ios/Jiebo/Jiebo/Views/HomeShell.swift");
const shell = read("ios/Jiebo/Jiebo/Views/PadAssistantShell.swift");
const experience = read("ios/Jiebo/Jiebo/Views/PadAssistantExperience.swift");
const transfer = read("ios/Jiebo/Jiebo/Session/PadSemanticTransfer.swift");
const transferRules = read("ios/Jiebo/Jiebo/Session/PadSemanticRules.swift");
const assistantStore = read("ios/Jiebo/Jiebo/Session/ChatStore+Assistant.swift");
const sidebar = read("ios/Jiebo/Jiebo/Views/SidebarView.swift");
const compactWorkbench = read("ios/Jiebo/Jiebo/Views/PhoneWorkbench.swift");
const root = read("ios/Jiebo/Jiebo/Views/RootView.swift");
const memory = read("ios/Jiebo/Jiebo/Views/MemoryCenter/MemoryCenterViews.swift");
const imStore = read("ios/Jiebo/Jiebo/Session/IM/ImStore.swift");
const imModels = read("ios/Jiebo/Jiebo/Session/IM/ImModels.swift");
const outbox = read("ios/Jiebo/Jiebo/Session/IM/ImDurableOutbox.swift");
const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
const infoPlist = read("ios/Jiebo/Jiebo/Info.plist");
const shareInfoPlist = read("ios/Jiebo/JieboShare/Info.plist");

function requireSource(source, needle, title) {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
}

function count(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

requireSource(app, "PadAppCommands()", "App Commands 挂载");
requireSource(app, "UIDevice.current.userInterfaceIdiom == .pad", "Commands 仅 iPad 挂载");
requireSource(home, ".focusedSceneValue(\\.padCommandActions", "scene-local Commands");
for (const key of ['key: "1"', 'key: "2"', 'key: "3"']) {
  requireSource(commands, key, `三域快捷键 ${key}`);
}
for (const section of [".today", ".inbox", ".tasks", ".artifacts", ".memory"]) {
  requireSource(commands, `sectionButton(${section}`, `五栏目快捷键 ${section}`);
}
for (const title of ["搜索", "新建", "打开文件", "刷新", "关闭检查器或预览", "上一处", "下一处"]) {
  requireSource(commands, `Button("${title}`, `键盘菜单 ${title}`);
}
if (count(home, /\.keyboardShortcut\(/g) !== 0) {
  throw new Error("域快捷键必须只登记在 App Commands，页面按钮不得重复登记");
}
if (
  [sidebar, compactWorkbench, root].some(
    (source) => source.includes('.keyboardShortcut("n"') || source.includes('.keyboardShortcut("o"'),
  )
) {
  throw new Error("工作台旧 ⌘N/⌘O 不得和集中 Commands 重复登记");
}
requireSource(router, "sectionHistory", "栏目历史状态");
requireSource(memory, 'navId = "search"', "记忆栏目搜索快捷键");
if (commands.includes('.keyboardShortcut("s", modifiers: [.command, .control])')) {
  throw new Error("不得与 NavigationSplitView 系统 ⌃⌘S 重复登记");
}
requireSource(commands, '.keyboardShortcut("s", modifiers: [.command, .option])', "无冲突侧栏快捷键");

for (const needle of [
  "struct PadSemanticTransfer",
  "Codable, Hashable, Identifiable, Transferable",
  'UTType(exportedAs: "ai.jiebo.ipad.semantic")',
  "let stableID: String",
  "func accepts(_ kind:",
]) {
  requireSource(transfer + transferRules, needle, "typed 语义拖放");
}
for (const kind of [".task", ".inbox", ".draft", ".artifact"]) {
  requireSource(experience + transfer, kind, `拖放类型 ${kind}`);
}
requireSource(shell, "isTargeted: { targeted = $0 }", "侧栏落点反馈");
requireSource(experience, "isTargeted: { dropTargeted = $0 }", "今日落点反馈");
requireSource(shell, "projection.contains(transfer)", "失效对象保护");
requireSource(shell, "if legalHover", "只高亮合法拖放目标");
requireSource(shell, "记忆栏目不接受拖放", "记忆拒绝拖放反馈");
requireSource(shell, "store.continuePadTransfer(transfer)", "侧栏今日执行与正文今日一致");
requireSource(experience, "PadSemanticDragPreview", "拖动期间记录 typed payload 种类");
requireSource(assistantStore, "此操作不会离线排队，请连接后重试", "无幂等 Prompt 不伪造 outbox");
for (const needle of ["UTExportedTypeDeclarations", "ai.jiebo.ipad.semantic", "public.data"]) {
  requireSource(infoPlist, needle, "语义拖放 UTI 导出");
}
if (shareInfoPlist.includes("ai.jiebo.ipad.semantic")) {
  throw new Error("语义拖放 UTI 不得导出到 Share target");
}

for (const needle of [
  "PadLayoutMode.resolve",
  ".onChange(of: proxy.size.width)",
  "preferredCompactColumn",
  "columnVisibility",
  "inspectorWidth",
]) {
  requireSource(shell + router, needle, "Stage Manager 尺寸适配");
}
requireSource(experience, "ThreadView(", "唯一助理 Composer");
if (count(shell + experience, /\bThreadView\s*\(/g) !== 1) {
  throw new Error("P2 小驳域仍必须只有一个 ThreadView/Composer 来源");
}

for (const needle of [
  "let stableID: String",
  "case pending",
  "case retrying",
  "case inFlight",
  "case succeeded",
  "case permanentFailure",
  "maximumAttempts",
  "replayBatchLimit",
  "nextDelay",
  "func restored(",
  "func scheduledDelay(",
  "func afterRateLimited(",
  '"not_visible"',
]) {
  requireSource(outbox, needle, "持久 outbox 状态机");
}
requireSource(imModels, '"durableOutbox"', "outbox 进程重启持久化");
requireSource(imStore, "replayDurableOutbox()", "重连重放");
requireSource(imStore, "prefix(ImDurableOutboxPolicy.replayBatchLimit)", "重放批次上限");
requireSource(imModels, "stableID == clientId", "稳定 clientId 元数据");
requireSource(imStore, "ImDurableOutboxPolicy.isPermanent", "永久错误分类");
requireSource(imStore, "ImCache.loadState(tenant: next)", "outbox 状态缓存租户隔离");
requireSource(imStore, "ImCache.loadTimelines(tenant: next)", "outbox 时间线缓存租户隔离");
requireSource(imStore, "self.tenant == tenantAtSchedule", "重放任务租户隔离");
requireSource(imStore, "uploadTasks: [String: Task<Void, Never>]", "上传任务按 clientId 管理");
requireSource(imStore, "uploadGenerations: [String: Int]", "上传 generation");
requireSource(imStore, "cancelAllUploadTasks()", "断线与换租户取消上传");
requireSource(imStore, "uploadIsCurrent(", "上传完成校验 generation/tenant");
if (imStore.includes("metadata.nextAttemptAt = .greatestFiniteMagnitude")) {
  throw new Error("在途状态不得再写 Double.greatestFiniteMagnitude");
}
requireSource(outbox, "服务端 clientId 去重与 im_ack 回执", "只重放已有幂等协议");

for (const [name, fileId, buildId] of [
  ["PadCommands.swift", "PADP20101", "PADP20201"],
  ["PadSemanticTransfer.swift", "PADP20102", "PADP20202"],
  ["PadLayoutMetrics.swift", "PADP20103", "PADP20203"],
  ["ImDurableOutbox.swift", "PADP20104", "PADP20204"],
  ["PadSemanticRules.swift", "PADP20105", "PADP20205"],
]) {
  requireSource(
    project,
    `${buildId} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileId}`,
    `${name} build file`,
  );
  requireSource(project, `${fileId} /* ${name} */ = {isa = PBXFileReference;`, `${name} file reference`);
  if (count(project, new RegExp(`^\\s+${fileId} /\\* ${name.replace(".", "\\.")} \\*/,$`, "gm")) !== 1) {
    throw new Error(`${name} 必须恰好登记一个 group entry`);
  }
  if (count(project, new RegExp(`^\\s+${buildId} /\\* ${name.replace(".", "\\.")} in Sources \\*/,$`, "gm")) !== 1) {
    throw new Error(`${name} 必须恰好进入一次 App Sources`);
  }
}
const sharePhase = project.match(/A1B2C3D4E5F6071829000D11 \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/)?.[0] ?? "";
if (["PADP20101", "PADP20102", "PADP20103", "PADP20104", "PADP20105"].some((id) => sharePhase.includes(id))) {
  throw new Error("P2 新文件不得进入 Share target");
}

console.log("iPad P2 静态契约：Commands、typed 拖放、尺寸适配、持久 outbox 与单 Composer 通过");
