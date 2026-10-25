import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
const avatar = read("ios/Jiebo/Jiebo/Views/AssistantAvatarView.swift");
const phone = read("ios/Jiebo/Jiebo/Views/Phone/AssistantHome.swift");
const emptyState = read("ios/Jiebo/Jiebo/Views/ThreadView+EmptyState.swift");
const pad = read("ios/Jiebo/Jiebo/Views/PadAssistantExperience.swift");

function requireSource(source, needle, title) {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
}

for (const phase of ["Idle", "Listening", "Thinking", "Executing", "Approval", "Success", "Failure", "Offline"]) {
  const directory = `ios/Jiebo/Jiebo/Assets.xcassets/AssistantPose${phase}.imageset`;
  const contents = JSON.parse(read(`${directory}/Contents.json`));
  const filename = contents.images.find((image) => image.filename)?.filename;
  if (!filename || !existsSync(`${directory}/${filename}`)) {
    throw new Error(`助理姿态资源不完整：${phase}`);
  }
  requireSource(avatar, `case .${phase.toLowerCase()}`, `助理状态 ${phase}`);
  requireSource(avatar, `"AssistantPose${phase}"`, `助理资源映射 ${phase}`);
}

for (const needle of [
  "runningChatIds.contains(chatId)",
  "queuedChatIds.contains(chatId)",
  '$0.tools.contains { $0.status == "running" }',
  "assistantState?.approvals",
  "assistantState?.draftCards",
  "@Environment(\\.accessibilityReduceMotion)",
  "@Environment(\\.scenePhase)",
]) {
  requireSource(avatar, needle, "助理状态与动画契约");
}

requireSource(phone, "AssistantAvatarView(phase: store.assistantAvatarPhase, size: 56)", "iPhone 导航栏形象");
requireSource(phone, "LinkStatusDot(state: store.linkState, syncing: store.threadSyncBusy)", "iPhone 状态点在形象下方");
requireSource(emptyState, "AssistantAvatarView(", "助理空状态形象");
requireSource(pad, "AssistantAvatarView(phase: store.assistantAvatarPhase, size: 59.5)", "iPad 今日标题形象");
requireSource(avatar, "private let motionGain: CGFloat = 1.75", "助理动作幅度");

const fileRef = "AVA000101 /* AssistantAvatarView.swift */";
const buildRef = "AVA000201 /* AssistantAvatarView.swift in Sources */";
if (project.split(fileRef).length - 1 !== 3)
  throw new Error("AssistantAvatarView.swift PBXFileReference / Group 引用不完整");
if (project.split(buildRef).length - 1 !== 2) throw new Error("AssistantAvatarView.swift App Sources 引用不完整");

console.log("iOS 助理形象契约：8 姿态、状态源、双端挂载、无障碍与工程引用通过");
