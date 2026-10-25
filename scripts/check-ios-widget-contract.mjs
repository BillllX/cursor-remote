import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
const snapshot = read("ios/Jiebo/WidgetShared/WidgetSnapshot.swift");
const widget = read("ios/Jiebo/JieboWidget/JieboWidget.swift");
const bridge = read("ios/Jiebo/Jiebo/Session/WidgetSnapshotBridge.swift");
const deepLink = read("ios/Jiebo/Jiebo/Session/WidgetDeepLinkRouting.swift");
const app = read("ios/Jiebo/Jiebo/JieboApp.swift");
const plist = read("ios/Jiebo/Jiebo/Info.plist");
const appEntitlements = read("ios/Jiebo/Jiebo/Jiebo.entitlements");
const widgetEntitlements = read("ios/Jiebo/JieboWidget/JieboWidget.entitlements");

function requireText(source, needle, title) {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
}

for (const [needle, title] of [
  ["WIDG0D01 /* JieboWidget */ = {", "Widget 原生 target"],
  ["JieboWidget.appex in Embed App Extensions", "Embed App Extensions"],
  ["PRODUCT_BUNDLE_IDENTIFIER = ai.jiebo.ipad.widget", "Widget bundle id"],
  ["CODE_SIGN_ENTITLEMENTS = JieboWidget/JieboWidget.entitlements", "Widget entitlement 配置"],
  ["WIDG0202 /* WidgetSnapshot.swift in Sources */", "Widget 共享快照源码"],
  ["WIDG0203 /* WidgetSnapshot.swift in Sources */", "主 App 共享快照源码"],
]) {
  requireText(project, needle, title);
}

for (const source of [appEntitlements, widgetEntitlements]) {
  requireText(source, "group.ai.jiebo.ipad", "App Group");
}

for (const field of [
  "schema",
  "loginState",
  "assistantStatus",
  "statusText",
  "unreadCount",
  "todoCount",
  "highlight",
  "updatedAt",
  "staleAfter",
  "privacyMode",
]) {
  requireText(snapshot, `var ${field}:`, `快照最小字段 ${field}`);
}
for (const forbidden of ["tokenDraft", "tenantId", "memory:", "messages:", "chatId:"]) {
  if (snapshot.includes(forbidden)) throw new Error(`WidgetSnapshot 禁止保存 ${forbidden}`);
}
for (const needle of ["rename(", ".tmp", "decodeIfPresent", "return nil"]) {
  requireText(snapshot, needle, "原子写与兼容解码");
}

const extensionSources = `${widget}\n${snapshot}`;
for (const forbidden of [
  "URLSession",
  "WebSocket",
  "GatewayClient",
  "Keychain",
  "Network",
  "Starscream",
  "assistant_get",
]) {
  if (extensionSources.includes(forbidden)) throw new Error(`Widget extension 禁止网络/敏感依赖：${forbidden}`);
}

for (const needle of [
  ".supportedFamilies([.systemSmall, .systemMedium])",
  '.widgetURL(URL(string: "jiebo://assistant/today"))',
  "Link(destination: highlightURL)",
  "let refreshAt = max(",
  "dynamicTypeSize.isAccessibilitySize",
  ".privacySensitive()",
  ".redacted(reason:",
]) {
  requireText(widget, needle, "Widget 展示契约");
}

for (const link of ["jiebo://assistant/today", "jiebo://assistant/inbox", "jiebo://assistant/todo"]) {
  requireText(widget + deepLink, link, `深链 ${link}`);
}
requireText(plist, "<string>jiebo</string>", "主 App URL scheme");
requireText(app, ".onOpenURL", "主 App 深链入口");
requireText(deepLink, "WidgetDeepLinkRouting", "统一深链待消费路由");
requireText(deepLink, "sceneToken: String", "Widget 深链绑定接收 scene");
requireText(deepLink, "consume(for sceneToken:", "Widget 深链按 scene 消费");
requireText(bridge, "WidgetCenter.shared.reloadTimelines(ofKind:", "Widget 定向刷新");
requireText(bridge, "contentFingerprint", "快照内容去重");

console.log("iOS Widget 静态契约：target、快照、隐私、深链与禁用依赖均通过");
