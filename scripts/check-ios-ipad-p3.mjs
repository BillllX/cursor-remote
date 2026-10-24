import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const requireSource = (source, needle, title) => {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
};
const count = (source, pattern) => source.match(pattern)?.length ?? 0;

const shared = read("shared/protocol.ts");
const registry = read("gateway/src/device/registry.ts");
const audit = read("gateway/src/device/audit.ts");
const tools = read("gateway/src/assistant/tools.ts");
const webRead = read("gateway/src/assistant/webRead.ts");
const webTest = read("gateway/test/web-read-security.test.ts");
const headless = read("gateway/src/collab/headless.ts");
const coordinator = read("ios/Jiebo/Jiebo/Device/DeviceBridgeCoordinator.swift");
const mail = read("ios/Jiebo/Jiebo/Device/MailDraftComposer.swift");
const protocol = read("ios/Jiebo/Jiebo/Gateway/Protocol.swift");
const imProtocol = read("ios/Jiebo/Jiebo/Gateway/ImProtocol.swift");
const collabView = read("ios/Jiebo/Jiebo/Views/IM/CollabRunGraphView.swift");
const chatHome = read("ios/Jiebo/Jiebo/Views/IM/ChatHome.swift");
const preview = read("ios/Jiebo/Jiebo/Views/PreviewPanelView.swift");
const app = read("ios/Jiebo/Jiebo/JieboApp.swift");
const scene = read("ios/Jiebo/Jiebo/Session/SceneSessionState.swift");
const policy = read("ios/Jiebo/Jiebo/Session/SceneEditingPolicy.swift");
const thread = read("ios/Jiebo/Jiebo/Views/ThreadView.swift");
const composer = read("ios/Jiebo/Jiebo/Views/ComposerView.swift");
const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");

for (const op of ["calendar_event_delete", "reminder_complete", "reminder_delete", "mail_draft_open"]) {
  requireSource(shared, `"${op}"`, `设备协议 ${op}`);
  requireSource(tools, `op: "${op}"`, `助理工具 ${op}`);
  requireSource(coordinator, `case "${op}"`, `iOS 执行器 ${op}`);
}
for (const needle of [
  "DEVICE_READ_TIMEOUT_MS = 30_000",
  "DEVICE_WRITE_TIMEOUT_MS = 120_000",
  "DEVICE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000",
  "DEVICE_SETTLED_TTL_MS = DEVICE_IDEMPOTENCY_TTL_MS",
  "conn.imForeground !== false",
  'conn.caps.has("device_bridge")',
  '"device_bridge_v2"',
  "conn.tenant?.id === tenantId",
]) {
  requireSource(registry, needle, "设备桥租户/前台/超时/幂等边界");
}
requireSource(coordinator, "requiresConfirmation == true", "设备写入屏幕确认");
requireSource(coordinator, "isConfirmationPresenter(token:", "设备确认唯一场景 owner");
requireSource(audit, 'op === "mail_draft_open"', "邮件审计白名单摘要");
requireSource(audit, "externalIdHash", "设备外部标识哈希审计");
if (/externalId\?\s*:\s*string/.test(audit)) {
  throw new Error("设备审计不得保存原始 externalId");
}
if (/summary\.(body|subject|to)\s*=/.test(audit)) {
  throw new Error("设备审计不得保存邮件正文、主题或收件人");
}
requireSource(mail, "MFMailComposeViewController", "系统邮件草稿");
requireSource(mail, "setMessageBody", "邮件正文只预填系统草稿");
if (mail.includes("URLSession") || mail.includes("SMTP")) {
  throw new Error("邮件能力不得包含后台发送通道");
}

for (const needle of [
  'url.protocol !== "http:" && url.protocol !== "https:"',
  "url.username || url.password",
  "isPublicAddress",
  "lookup:",
  "MAX_REDIRECTS = 3",
  "MAX_BYTES = 1_000_000",
  "TIMEOUT_MS = 10_000",
  "Promise.race",
  "controller.abort()",
  "clearTimeout(timer)",
  '["64:ff9b::", 96]',
  '["2002::", 16]',
  '["2001:20::", 28]',
  "ALLOWED_TYPES",
  "response.headers.location",
]) {
  requireSource(webRead, needle, "受控网页 SSRF/限制");
}
for (const needle of [
  "私网目标在发请求前被拒绝",
  "连接固定到已验证地址",
  "application/octet-stream",
  "共用 wall-clock 总截止",
]) {
  requireSource(webTest, needle, "网页安全定向测试");
}

for (const needle of [
  "sandboxEnabledForTenant(context.tenant)",
  "confinedCwd",
  "sandboxOptions",
  "toolEscapesWorkspace",
  "authorizeHeadlessTool",
  "禁止网络或发布操作",
  "禁止危险系统命令",
  "approvalPolicy",
  'action: "approval"',
]) {
  requireSource(headless, needle, "Collab Headless 安全边界");
}
for (const cap of ['"im_group"', '"im_collab"']) {
  requireSource(protocol, cap, "iOS Collab 复用现有能力声明");
}
requireSource(protocol, '"device_bridge_v2"', "iOS P3 设备能力版本声明");
requireSource(protocol, "case collabSync", "Collab 增量同步");
requireSource(imProtocol, 'case "collab_state"', "Collab 状态解码");
requireSource(imProtocol, 'kind == "group"', "Collab 群会话解码");
requireSource(chatHome, "CollabRunGraphView", "Collab 运行图真实入口");
requireSource(collabView, "P3 只读运行图", "iOS Collab 只读 UI");
if (collabView.includes("collabOp") || collabView.includes("answer_approval")) {
  throw new Error("P3 iOS Collab 不得绕过既有审批边界");
}

for (const needle of [
  "@State private var scene = SceneSessionState()",
  ".environment(\\.sceneSessionState, scene)",
  "SceneActivityRegistry",
]) {
  requireSource(app, needle, "WindowGroup scene-local 根状态");
}
for (const needle of ["chatDestination", "workbenchChatId", "previewKey", "previewKeys", "private var drafts"]) {
  requireSource(scene, needle, "scene-local 导航/预览/草稿");
}
requireSource(preview, "sceneSession?.previewTabs", "预览页签按 scene 隔离");
requireSource(preview, "sceneSession.dismissPreview()", "预览关闭按 scene 隔离");
if (preview.includes("ForEach(store.previewTabs)")) {
  throw new Error("预览页签不得直接展示其它 scene 的共享选择");
}
requireSource(policy, "SceneEditorElection", "纯编辑 owner 策略");
requireSource(thread, "SceneEditingOwnership.shared", "Thread 编辑租约");
requireSource(thread, "这个会话正在另一窗口编辑", "多窗口只读降级");
requireSource(composer, "sceneSession?.draft", "Composer scene-local 草稿");
if (count(thread, /\bComposerView\s*\(/g) !== 1) {
  throw new Error("ThreadView 必须仍只有一个 Composer 来源");
}

for (const [name, fileId, buildId] of [
  ["MailDraftComposer.swift", "P3D000101", "P3D000201"],
  ["SceneSessionState.swift", "P3S000101", "P3S000201"],
  ["SceneEditingPolicy.swift", "P3S000102", "P3S000202"],
  ["CollabRunGraphView.swift", "P3I000101", "P3I000201"],
]) {
  requireSource(project, `${fileId} /* ${name} */ = {isa = PBXFileReference;`, `${name} file reference`);
  requireSource(project, `${buildId} /* ${name} in Sources */ = {isa = PBXBuildFile;`, `${name} build file`);
  if (count(project, new RegExp(`^\\s+${fileId} /\\* ${name.replace(".", "\\.")} \\*/,$`, "gm")) !== 1) {
    throw new Error(`${name} 必须恰好登记一个 group entry`);
  }
  if (count(project, new RegExp(`^\\s+${buildId} /\\* ${name.replace(".", "\\.")} in Sources \\*/,$`, "gm")) !== 1) {
    throw new Error(`${name} 必须恰好进入一次 App Sources`);
  }
}
const sharePhase = project.match(/A1B2C3D4E5F6071829000D11 \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/)?.[0] ?? "";
if (["P3D000201", "P3S000201", "P3S000202", "P3I000201"].some((id) => sharePhase.includes(id))) {
  throw new Error("P3 新文件不得进入 Share target");
}

console.log("iPad P3 静态契约：设备桥、邮件草稿、受控网页、Collab 与多窗口拆分通过");
