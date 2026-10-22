/** Web 产品导航与状态的唯一语义表；组件只消费稳定 ID，不自行发明同义图标。 */
export const PRIMARY_NAV = [
  { id: "assistant", label: "助理", icon: "assistant" },
  { id: "workspace", label: "工作区", icon: "workspace" },
] as const;

export const WORKSPACE_NAV = [
  { id: "chats", label: "会话", icon: "chats" },
  { id: "files", label: "文件", icon: "files" },
  { id: "search", label: "工作区搜索", icon: "search" },
  { id: "git", label: "源代码管理", icon: "git" },
  { id: "memory", label: "记忆与规则", icon: "memory" },
  { id: "management", label: "管理", icon: "workspace" },
] as const;

export const SESSION_TOOLS = [
  { id: "loop", label: "Loop", icon: "loop" },
  { id: "terminal", label: "终端输出", icon: "terminal" },
] as const;

export const ASSISTANT_NAV = [
  { id: "overview", label: "总览" },
  { id: "inbox", label: "收件箱" },
  { id: "notify", label: "通知" },
] as const;

export const ASSISTANT_SIDEBAR_NAV = [
  { id: "chat", label: "对话", icon: "chats" },
  { id: "overview", label: "今日总览", icon: "overview" },
  { id: "inbox", label: "收件箱", icon: "chats" },
  { id: "notify", label: "通知", icon: "assistant" },
  { id: "memory", label: "个人记忆", icon: "memory" },
] as const;

export const ASSISTANT_SURFACE = {
  mode: "floating",
  memoryMode: "same-shell-wide",
} as const;

export const STATUS_LEGEND = {
  normal: { label: "正常", symbol: "✓" },
  running: { label: "运行中", symbol: "◉" },
  attention: { label: "需要处理", symbol: "△" },
  error: { label: "错误", symbol: "!" },
  disabled: { label: "未启用", symbol: "○" },
  unread: { label: "未读", symbol: "●" },
} as const;

export type PrimaryNavId = (typeof PRIMARY_NAV)[number]["id"];
export type WorkspaceNavId = (typeof WORKSPACE_NAV)[number]["id"];
export type StatusLegendId = keyof typeof STATUS_LEGEND;

export function isAssistantDomainActive(
  assistantActive: boolean,
  assistantOpen: boolean,
  source: "assistant" | "workspace",
) {
  return assistantOpen ? source === "assistant" : assistantActive;
}

export function statusAriaLabel(status: StatusLegendId, count?: number) {
  const label = STATUS_LEGEND[status].label;
  return count != null ? `${label} ${count}` : label;
}
