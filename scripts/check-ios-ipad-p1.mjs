import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const router = read("ios/Jiebo/Jiebo/Session/PadRouter.swift");
const inspectorState = read("ios/Jiebo/Jiebo/Session/PadInspectorState.swift");
const shell = read("ios/Jiebo/Jiebo/Views/PadAssistantShell.swift");
const experience = read("ios/Jiebo/Jiebo/Views/PadAssistantExperience.swift");
const assistantStore = read("ios/Jiebo/Jiebo/Session/ChatStore+Assistant.swift");
const phoneDock = read("ios/Jiebo/Jiebo/Views/Phone/ActionDock.swift");
const phoneShell = read("ios/Jiebo/Jiebo/Views/Phone/PhoneTabShell.swift");
const home = read("ios/Jiebo/Jiebo/Views/HomeShell.swift");
const thread = read("ios/Jiebo/Jiebo/Views/ThreadView.swift");
const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");

function requireSource(source, needle, title) {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
}

function count(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

// 五页必须接真实投影或既有 Memory Center，不能用第二份事实源。
for (const component of [
  "PadTodayExperience",
  "PadInboxExperience",
  "PadTaskExperience",
  "PadArtifactExperience",
  "MemoryCenterPanelView",
]) {
  requireSource(shell + experience, component, `P1 五类体验 ${component}`);
}
for (const field of ["dayThread", "draftCards", "personalTasks", "artifacts"]) {
  requireSource(router, `state?.${field}`, `P1 真实投影 ${field}`);
}
requireSource(router, "fallbackDayThread", "老网关今日集中回退");
requireSource(router, "fallbackTasks", "老网关任务集中回退");

// selection / Inspector 覆盖全部实体，预览往返由可执行的纯状态类型负责。
for (const selection of [
  "dayEvent(String)",
  "draft(String)",
  "approval(String)",
  "inboxItem(String)",
  "task(String)",
  "artifact(String)",
  "delegation(String)",
]) {
  requireSource(inspectorState, selection, `Inspector selection ${selection}`);
}
requireSource(inspectorState, "case preview(returnTo: PadSelection?)", "Preview 返回目标");
requireSource(inspectorState, "mutating func restoreAfterPreview()", "Preview 恢复纯逻辑");
requireSource(inspectorState, "var hasInspectorDetail: Bool", "主会话不打开 Inspector");
for (const route of [
  "case let .dayEvent",
  "case let .draft",
  "case let .approval",
  "case let .inboxItem",
  "case let .task",
  "case let .artifact",
  "case let .delegation",
]) {
  requireSource(experience, route, `统一 Inspector ${route}`);
}
requireSource(shell, ".onChange(of: sceneSession?.previewKey)", "ThreadView Preview scene-local 正向同步");
requireSource(shell, "if newKey != nil {\n                syncPreviewPresentation()", "ThreadView Preview 正向同步");
requireSource(shell, ".onChange(of: router.inspectorPresented)", "Inspector 手势关闭清理");
requireSource(shell, "sceneSession?.dismissPreview()", "Preview scene-local 状态清理");
requireSource(home, "padRouter.restoreAfterPreview()", "跨域 Preview 清理");
requireSource(experience, "PreviewPanelView(tab: tab, modal: false)", "Inspector 内嵌 Preview");
requireSource(experience, "case .assistantChat, nil:", "assistantChat 非失效详情");

// compact / regular 列可达，embedded ThreadView 保留系统 sidebar toggle。
requireSource(shell, ".onChange(of: sizeClass)", "iPad 尺寸变化");
requireSource(shell, "columnVisibility = .all", "regular 恢复全部列");
if (shell.includes("columnVisibility = .detailOnly")) {
  throw new Error("compact 不得锁死 detailOnly");
}
requireSource(thread, "ThreadSidebarToggleRemoval(enabled: chrome != .embedded)", "embedded 保留侧栏开关");

// 今日只有一个固定会话 Composer；ActionDock 使用 PadRouter，不污染 iPhone。
if (count(shell + experience, /\bThreadView\s*\(/g) !== 1) {
  throw new Error("P1 小驳域必须且只能有一个 ThreadView/Composer 来源");
}
requireSource(experience, "dock: AnyView(PadActionDock())", "iPad ActionDock 挂载");
const padDock = experience.match(/struct PadActionDock[\s\S]*?\/\/ MARK: - 统一 Inspector/)?.[0] ?? "";
if (!padDock.includes("@Environment(PadRouter.self)") || padDock.includes("PhoneRouter")) {
  throw new Error("PadActionDock 必须只通过 PadRouter 导航");
}
requireSource(phoneDock, "@Environment(PhoneRouter.self)", "iPhone ActionDock 路径保持");
for (const tab of ['Tab("小驳"', 'Tab("待处理"', 'Tab("消息"']) {
  requireSource(phoneShell, tab, "iPhone 三 Tab 保持");
}

// 委派 → 产物 → Preview，以及产物续作固定助理 chatId 且不 select 工作台。
requireSource(experience, "linkedArtifacts", "委派关联产物");
requireSource(experience, "store.openTurnFile(file, chatId: chatId)", "产物固定版本预览");
requireSource(experience, "router.openPreview(returningTo: .delegation", "委派预览返回");
requireSource(experience, "store.continueArtifactOnPad(artifact)", "iPad 产物续作");
requireSource(assistantStore, "func continueArtifactOnPad(_ artifact: Artifact)", "iPad 续作专用入口");
requireSource(assistantStore, "if selectAssistant { openAssistantChat() }", "iPhone 续作默认兼容");
requireSource(assistantStore, "submit(chatId: assistantChatId, text: prompt)", "续作固定助理会话");
const delegationDetail =
  experience.match(/private struct PadDelegationDetail[\s\S]*?private struct PadSourceLinks/)?.[0] ?? "";
if (delegationDetail.includes("store.select(") || delegationDetail.includes("openAssistantChat(")) {
  throw new Error("委派详情不得隐式选择 childChat 或工作台会话");
}
for (const needle of [
  "private var processLoadKey",
  "store.cachedOnlyIds.contains(childId)",
  "store.cacheCheckedIds.contains(childId)",
  "childChat?.turnsComplete == false",
  'let running = tool.status == "running"',
  'Image(systemName: running ? "ellipsis"',
]) {
  requireSource(delegationDetail, needle, "委派延迟加载/运行态");
}

// 待处理去重、筛选空态与投影排序。
requireSource(router, "private static func uniqueDraftCards", "draftCards 集中去重");
requireSource(router, ".sorted { $0.createdAt > $1.createdAt }", "draftCards 倒序");
requireSource(experience, "item.delegationId == approval.delegationId", "审批 inbox 委派去重");
requireSource(experience, "item.chatId == approval.chatId", "审批 inbox 会话去重");
requireSource(experience, "private var visibleContentIsEmpty", "按筛选计算空态");
requireSource(experience, "if hasPending {", "不渲染空待确认 Section");

// 非 today 页面和 Inspector 都必须承载 notice / banner。
requireSource(shell, "PadNoticeHost(enabled: router.assistantSection != .today", "非 today notice");
requireSource(experience, ".phoneNotice()", "Inspector notice");

// 推送冷启动先进入列表，旧网关投影可解析，跨域委派强制回到小驳。
requireSource(home, "padRouter.route(target, presentSelection: !needsResolution)", "推送延迟 Inspector");
requireSource(router, "let tasks = PadAssistantProjection(state: state).personalTasks", "旧网关任务解析");
const openDelegation = router.match(/func openDelegation\(_ id: String\) \{([\s\S]*?)\n {4}\}/)?.[1] ?? "";
requireSource(openDelegation, "domain = .assistant", "委派强制切小驳域");

// 简报、来源、身份、未知阶段和 schedule 兼容回退。
requireSource(experience, 'events.filter { $0.kind != "brief" }', "今日简报去重");
for (const source of [
  'case "brief": return .brief',
  'case "approval": return .approval',
  'case "schedule": return .task',
]) {
  requireSource(experience, source, `来源跳转 ${source}`);
}
requireSource(experience, ".task(id: item.id)", "InboxDetail 身份");
requireSource(experience, "let unknown = Set(tasks.map(\\.phase)).subtracting(phases)", "未知任务阶段");
requireSource(router, "let schedules = state.schedules.map", "老网关 schedule 回退");

// 新文件必须四重登记且仅进入 App target。
for (const [name, fileId, buildId] of [
  ["PadAssistantExperience.swift", "PADP00104", "PADP00204"],
  ["PadInspectorState.swift", "PADP00105", "PADP00205"],
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
if (
  sharePhase.includes("PADP00104") ||
  sharePhase.includes("PADP00204") ||
  sharePhase.includes("PADP00105") ||
  sharePhase.includes("PADP00205")
) {
  throw new Error("P1 新文件不得进入 Share target");
}

// Glass 只用于筛选/控制，正文仍使用实体卡片表面。
requireSource(experience, ".jieboGlass(in: Capsule(), interactive: true)", "P1 筛选控制 Glass");
requireSource(experience, ".background(JieboColor.white)", "P1 正文实体表面");

console.log("iPad P1 静态契约：五类数据、统一 Inspector、ActionDock、Preview 闭环与单 Composer 通过");
