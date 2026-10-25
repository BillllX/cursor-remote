import { readFileSync } from "node:fs";

const swiftPath = "ios/Jiebo/Jiebo/Theme/ProductNavigation.swift";
const productPath = "web/lib/productNavigation.ts";
const iconsPath = "web/components/chromeIcons.tsx";
const projectPath = "ios/Jiebo/Jiebo.xcodeproj/project.pbxproj";
const chatStorePath = "ios/Jiebo/Jiebo/Session/ChatStore.swift";
const rootViewPath = "ios/Jiebo/Jiebo/Views/RootView.swift";
const assistantEntryPath = "ios/Jiebo/Jiebo/Views/AssistantEntryRow.swift";
const menuDrawerPath = "ios/Jiebo/Jiebo/Views/Phone/MenuDrawer.swift";
const menuScreensPath = "ios/Jiebo/Jiebo/Views/Phone/MenuScreens.swift";
const chatHomePath = "ios/Jiebo/Jiebo/Views/IM/ChatHome.swift";
const memoryViewsPath = "ios/Jiebo/Jiebo/Views/MemoryCenter/MemoryCenterViews.swift";
const adminStatsPath = "ios/Jiebo/Jiebo/Views/AdminStatsView.swift";
const homePath = "ios/Jiebo/Jiebo/Views/HomeShell.swift";
const sidebarPath = "ios/Jiebo/Jiebo/Views/SidebarView.swift";
const phoneWorkbenchPath = "ios/Jiebo/Jiebo/Views/PhoneWorkbench.swift";
const swift = readFileSync(swiftPath, "utf8");
const product = readFileSync(productPath, "utf8");
const icons = readFileSync(iconsPath, "utf8");
const project = readFileSync(projectPath, "utf8");
const chatStore = readFileSync(chatStorePath, "utf8");
const rootView = readFileSync(rootViewPath, "utf8");
const assistantEntry = readFileSync(assistantEntryPath, "utf8");
const menuDrawer = readFileSync(menuDrawerPath, "utf8");
const menuScreens = readFileSync(menuScreensPath, "utf8");
const chatHome = readFileSync(chatHomePath, "utf8");
const memoryViews = readFileSync(memoryViewsPath, "utf8");
const adminStats = readFileSync(adminStatsPath, "utf8");
const home = readFileSync(homePath, "utf8");
const sidebar = readFileSync(sidebarPath, "utf8");
const phoneWorkbench = readFileSync(phoneWorkbenchPath, "utf8");

function enumBody(name) {
  const match = swift.match(new RegExp(`enum ${name}: String, CaseIterable \\{([\\s\\S]*?)(?=\\n\\})\\n\\}`, "m"));
  if (!match) throw new Error(`${swiftPath} 缺少 ${name}`);
  return match[1];
}

function caseKeys(body) {
  return [...body.matchAll(/^\s*case\s+([a-z][a-zA-Z]*(?:\s*,\s*[a-z][a-zA-Z]*)*)\s*$/gm)]
    .flatMap((match) => match[1].split(","))
    .map((key) => key.trim());
}

function propertyBody(body, property) {
  const match = body.match(new RegExp(`var ${property}: String \\{([\\s\\S]*?)\\n    \\}`, "m"));
  if (!match) throw new Error(`${swiftPath} 缺少 ${property}`);
  return match[1];
}

function returnMap(body) {
  return new Map([...body.matchAll(/case \.([a-z][a-zA-Z]*): return "([^"]+)"/g)].map((match) => [match[1], match[2]]));
}

function sameKeys(actual, expected, title) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(`${title} 不一致\niOS: ${a.join(", ")}\nWeb: ${e.join(", ")}`);
  }
}

function requireSource(source, needle, title) {
  if (!source.includes(needle)) throw new Error(`${title}：缺少 ${needle}`);
}

const navigationBody = enumBody("NavigationIconId");
const statusBody = enumBody("StatusLegendId");
const navigationKeys = caseKeys(navigationBody);
const statusKeys = caseKeys(statusBody);
const navigationLabels = returnMap(propertyBody(navigationBody, "label"));
const statusLabels = returnMap(propertyBody(statusBody, "label"));

const iconUnion = icons.match(/export type NavigationIconId\s*=([\s\S]*?);/)?.[1] ?? "";
const webIconKeys = [...iconUnion.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
sameKeys(navigationKeys, webIconKeys, "NavigationIconId");

const statusObject = product.match(/export const STATUS_LEGEND = \{([\s\S]*?)\n\} as const;/)?.[1] ?? "";
const webStatuses = new Map(
  [...statusObject.matchAll(/^\s*([a-z]+): \{ label: "([^"]+)", symbol:/gm)].map((match) => [match[1], match[2]]),
);
sameKeys(statusKeys, webStatuses.keys(), "StatusLegendId");
for (const [key, label] of webStatuses) {
  if (statusLabels.get(key) !== label) {
    throw new Error(`状态文案 ${key} 不一致：iOS=${navigationLabels.get(key) ?? statusLabels.get(key)} Web=${label}`);
  }
}

// 导航项只有在 id 与 icon 相同时才定义该图标的通用名称；management 等场景文案不覆盖图标语义。
const productNavigationLabels = new Map(
  [...product.matchAll(/\{ id: "([^"]+)", label: "([^"]+)", icon: "([^"]+)" \}/g)]
    .filter((match) => match[1] === match[3])
    .map((match) => [match[1], match[2]]),
);
for (const [key, label] of productNavigationLabels) {
  if (navigationLabels.get(key) !== label) {
    throw new Error(`导航文案 ${key} 不一致：iOS=${navigationLabels.get(key)} Web=${label}`);
  }
}

if (!statusBody.includes('return "\\(label) \\(count)"')) {
  throw new Error("StatusLegendId.accessibilityLabel(count:) 必须与 Web statusAriaLabel 的计数格式一致");
}

const toolContracts = [
  ["files", "文件", "files"],
  ["search", "工作区搜索", "search"],
  ["git", "源代码管理", "git"],
  ["terminal", "终端输出", "terminal"],
  ["loop", "Loop", "loop"],
  ["assistant", "助理", "assistant"],
];
for (const [id, title, icon] of toolContracts) {
  requireSource(chatStore, `case .${id}: return "${title}"`, `ToolLayer.${id} 标题`);
  requireSource(chatStore, `case .${id}: return .${icon}`, `ToolLayer.${id} 图标`);
}

for (const [source, needle, title] of [
  [rootView, "NavigationIconId.account.symbol", "RootView 账户入口"],
  [menuDrawer, "NavigationIconId.account.symbol", "手机菜单设置入口"],
  [chatHome, "NavigationIconId.account.symbol", "聊天主页设置入口"],
  [chatHome, "NavigationIconId.assistant.symbol", "聊天主页助理入口"],
  [menuScreens, "NavigationIconId.memory.symbol", "设置页记忆入口"],
  [menuScreens, "NavigationIconId.stats.symbol", "设置页统计入口"],
  [memoryViews, "NavigationIconId.overview.symbol", "记忆中心总览入口"],
  [memoryViews, "NavigationIconId.account.symbol", "记忆中心个人/设置入口"],
  [adminStats, "NavigationIconId.stats.symbol", "统计空态"],
  [rootView, "StatusLegendId.running", "RootView 运行状态"],
  [home, "StatusLegendId.attention", "iPad 域切换待处理状态"],
  [assistantEntry, "StatusLegendId.unread", "助理会话独立未读状态"],
  [sidebar, 'row.status == "armed" || row.status == "running"', "iPad Loop 活动状态"],
  [phoneWorkbench, 'row.status == "armed" || row.status == "running"', "窄屏 Loop 活动状态"],
  [sidebar, "PhoneSettingsScreen()", "iPad 账户入口"],
  [phoneWorkbench, "PhoneSettingsScreen()", "窄屏账户入口"],
]) {
  requireSource(source, needle, title);
}

const buildFileDefinitions = project.match(/PN100201 \/\* ProductNavigation\.swift in Sources \*\/ = \{isa = PBXBuildFile;/g) ?? [];
const fileReferences = project.match(/PN100101 \/\* ProductNavigation\.swift \*\/ = \{isa = PBXFileReference;/g) ?? [];
const sourceEntries = project.match(/^\s+PN100201 \/\* ProductNavigation\.swift in Sources \*\/,$/gm) ?? [];
const groupEntries = project.match(/^\s+PN100101 \/\* ProductNavigation\.swift \*\/,$/gm) ?? [];
if (
  buildFileDefinitions.length !== 1 ||
  fileReferences.length !== 1 ||
  sourceEntries.length !== 1 ||
  groupEntries.length !== 1
) {
  throw new Error(
    `${swiftPath} 的 pbx 引用不准确：build=${buildFileDefinitions.length}, file=${fileReferences.length}, sources=${sourceEntries.length}, group=${groupEntries.length}`,
  );
}

console.log(`iOS 导航/状态契约：${navigationKeys.length} 个图标键，${statusKeys.length} 个状态键，跨端文案一致`);
