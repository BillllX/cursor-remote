import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const router = read("ios/Jiebo/Jiebo/Session/PadRouter.swift");
const home = read("ios/Jiebo/Jiebo/Views/HomeShell.swift");
const assistant = read("ios/Jiebo/Jiebo/Views/PadAssistantShell.swift");
const assistantExperience = read("ios/Jiebo/Jiebo/Views/PadAssistantExperience.swift");
const assistantSource = assistant + assistantExperience;
const phone = read("ios/Jiebo/Jiebo/Views/Phone/PhoneTabShell.swift");
const push = read("ios/Jiebo/Jiebo/Session/PushRegistrar.swift");
const captureDrain = read("ios/Jiebo/Jiebo/AppIntents/AssistantCaptureDrain.swift");
const composer = read("ios/Jiebo/Jiebo/Views/ComposerView.swift");
const chatStore = read("ios/Jiebo/Jiebo/Session/ChatStore.swift");
const handle = read("ios/Jiebo/Jiebo/Session/ChatStore+Handle.swift");
const presenter = read("ios/Jiebo/Jiebo/Session/AssistantScenePresenter.swift");
const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");

function requireSource(source, needle, title) {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
}

function count(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

// PadRouter 状态与旧 homeMode 迁移。
for (const needle of [
  "@Observable",
  "@MainActor",
  "case assistant",
  "case workbench",
  "case messages",
  "case today",
  "case inbox",
  "case tasks",
  "case artifacts",
  "case memory",
  "var selection: PadSelection?",
  "var inspectorPresented",
  "var delegationDetail",
]) {
  requireSource(router, needle, "PadRouter 状态契约");
}
requireSource(router, "case HomeMode.workbench.rawValue: return .workbench", "旧工作台迁移");
requireSource(router, "case HomeMode.chat.rawValue: return .messages", "旧聊天迁移");
requireSource(router, "default: return .assistant", "新安装默认域");

// 推送必须覆盖三类域与五种助理通知。
for (const kind of ["approval", "delegation", "inbox", "reminder", "brief"]) {
  requireSource(router, `case "${kind}"`, `推送 ${kind} 映射`);
}
requireSource(router, "if target.isIm", "IM 推送映射");
requireSource(router, "if target.isWorkspace", "工作区推送映射");
requireSource(home, "这条通知对应的内容已失效", "失效对象中文降级");
requireSource(home, "let baselineRevision = store.assistantStateRevision", "推送刷新基线");
requireSource(home, "for _ in 0..<maximumAttempts", "推送有界重试");
requireSource(home, "store.assistantStateRevision > baselineRevision", "推送明确新响应");
requireSource(chatStore, "var assistantStateRevision: UInt64", "助理状态响应版本");
requireSource(handle, "assistantStateRevision &+= 1", "助理状态响应推进");

// iPhone 分支保持原入口；iPad 不得设置 assistantOnly=true 或复用 PhoneRouter。
requireSource(
  home,
  "if UIDevice.current.userInterfaceIdiom == .phone {\n                PhoneTabShell()",
  "iPhone 三 Tab 路径",
);
if (!phone.includes('Tab("小驳"') || !phone.includes('Tab("待处理"') || !phone.includes('Tab("消息"')) {
  throw new Error("iPhone 三 Tab 源码契约被改变");
}
if (router.includes("PhoneRouter") || home.includes("store.assistantOnly = true")) {
  throw new Error("iPad 路由不得复用 PhoneRouter 或启用 assistantOnly");
}

// 当前域条件挂载，固定 chatId 的小驳域只能有一个 ThreadView/Composer 来源。
if (count(assistantSource, /\bThreadView\s*\(/g) !== 1) {
  throw new Error("PadAssistantShell 必须且只能有一个 ThreadView");
}
requireSource(assistantExperience, "chatId: chatId", "固定助理 chatId");
if (home.includes(".homeLayer(")) throw new Error("iPad 三域不得继续透明常驻旧主页");
requireSource(home, "switch router.domain", "按当前域挂载");
requireSource(home, ".assistantCaptureOpenRequested", "捕获入口");
requireSource(home, ".assistantVoiceRequested", "语音入口");
requireSource(assistant, ".assistantVoiceComposerRequested", "唯一 Composer 语音转交");
requireSource(home, ".environment(\\.openDelegation", "iPad 委派环境入口");
if (captureDrain.includes("store.openAssistantChat()")) {
  throw new Error("外部捕获不得绕过 PadRouter 改写工作台 activeId");
}

// HomeMode 仅作迁移/默认值；活动窗口使用直接环境动作，不观察或广播存储变化。
if (
  home.includes("@AppStorage(PadDomain.storageKey)") ||
  home.includes(".onChange(of: mode)") ||
  home.includes("legacyHomeModePicked")
) {
  throw new Error("PadRouter 不得被全局 AppStorage/onChange/广播实时驱动");
}
requireSource(home, ".environment(\\.openPadDomain", "当前场景兼容入口");
requireSource(home, "UserDefaults.standard.set(next.rawValue, forKey: PadDomain.storageKey)", "新场景默认偏好");

// 全局语音只由唯一前台 scene 接收，Composer 只消费带 scene token 的内部投递。
requireSource(presenter, "let active = candidates.filter(\\.active)", "前台 scene 选举");
requireSource(presenter, ".max { lhs, rhs in lhs.order < rhs.order }", "最近 scene 选举");
requireSource(home, "AssistantScenePresenter.shared.isPresenter(token: sceneToken)", "iPad scene 唯一领取");
requireSource(phone, "AssistantScenePresenter.shared.isPresenter(token: sceneToken)", "iPhone scene 唯一领取");
if (composer.includes("publisher(for: .assistantVoiceRequested)")) {
  throw new Error("Composer 不得直接消费全局语音广播");
}
requireSource(composer, "delivery.sceneToken == assistantSceneToken", "语音 scene token");
requireSource(composer, "assistantVoicePresenterActive", "唯一可见 Composer");

// compact iPad 必须从 section 侧栏显式进入 detail；brief inspector 必须有真实内容。
requireSource(assistant, "preferredCompactColumn: $preferredCompactColumn", "compact 首选列");
requireSource(assistant, "preferredCompactColumn = .detail", "compact 进入详情");
requireSource(assistant, ".onChange(of: sizeClass)", "尺寸等级变化");
requireSource(assistant, "columnVisibility = .all", "regular 恢复侧栏");
if (assistant.includes("columnVisibility = .detailOnly")) {
  throw new Error("compact 不得锁死 detailOnly，必须保留系统侧栏可达性");
}
requireSource(assistantExperience, "case .brief:", "brief inspector 路由");
requireSource(assistantExperience, 'PadDetailTitle("今日简报"', "brief inspector 内容");

// 可选投影必须集中归一化，调用视图只读统一结果。
for (const field of ["dayThread", "draftCards", "personalTasks", "artifacts"]) {
  requireSource(router, `state?.${field} ??`, `${field} 集中回退`);
  requireSource(router, `${field}Available = state?.${field} != nil`, `${field} 可用性空态`);
}

// iPad 助理通知默认开，并允许显式设置覆盖。
requireSource(push, "storedValue ?? true", "助理通知默认值");
requireSource(push, "UserDefaults.standard.object(forKey: assistantNotificationsKey) as? Bool", "助理通知设置");
requireSource(push, '"assistant": .bool(assistant)', "订阅上报");

// 两个新文件都必须在主 App target 四重登记，且不能进入 Share target。
for (const [name, fileId, buildId] of [
  ["PadRouter.swift", "PADP00101", "PADP00201"],
  ["PadAssistantShell.swift", "PADP00102", "PADP00202"],
  ["AssistantScenePresenter.swift", "PADP00103", "PADP00203"],
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
    throw new Error(`${name} 必须恰好进入一次主 App Sources`);
  }
}
const sharePhase = project.match(/A1B2C3D4E5F6071829000D11 \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/)?.[0] ?? "";
if (sharePhase.includes("PADP001") || sharePhase.includes("PADP002")) {
  throw new Error("PadRouter / PadAssistantShell 不得进入 Share target");
}

console.log("iPad P0 静态契约：路由、迁移、推送、pbx、单 Composer 与 iPhone 路径通过");
