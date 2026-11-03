import type {
  MemoryCenterKind,
  MemoryCenterSearchMatchReason,
  MemoryCenterState,
  MemoryInjectionReason,
  MemoryInjectionSkipReason,
} from "@shared/protocol";
import {
  formatMemoryCenterSearchReasons,
  MEMORY_CENTER_SEARCH_REASON_LABEL,
} from "@shared/memoryCenterSearchReason";

/** drill-down 焦点目标（静态契约，供 a11y 测试与组件对齐）。 */
export const MEMORY_CENTER_FOCUS = {
  navTitle: "mc-focus-nav-title",
  navCurrent: "mc-focus-nav-current",
  middleTitle: "mc-focus-middle-title",
  middleFromDetail: "mc-focus-middle-from-detail",
  detailBack: "mc-focus-detail-back",
} as const;

export const MEMORY_CENTER_CSS = {
  root: "mc-root",
  layout: "mc-layout",
  layoutThree: "mc-layout-three",
  layoutStack: "mc-layout-stack",
  nav: "mc-nav",
  middle: "mc-middle",
  detail: "mc-detail",
  searchBar: "mc-search-bar",
  rowBtn: "mc-row-btn",
  rowSelected: "mc-row-selected",
  badge: "mc-badge",
  drillBack: "mc-drill-back",
  truncated: "mc-truncated",
  statusError: "mc-status-error",
  statusLoading: "mc-status-loading",
  createEntry: "mc-create-entry",
} as const;

export { MEMORY_CENTER_SEARCH_REASON_LABEL, formatMemoryCenterSearchReasons };
export type { MemoryCenterSearchMatchReason };

export const KIND_LABEL: Record<MemoryCenterKind, string> = {
  personal: "个人",
  work_preference: "工作偏好",
  workspace_memory: "工作区",
  rule: "规则",
  document: "文档",
};

/** P0 搜索 UI 仅展示后端实际检索的种类（rule/document 不在 search 路径中）。 */
export type SearchableMemoryCenterKind = "personal" | "work_preference" | "workspace_memory";

export const SEARCHABLE_KIND_LABEL: Record<SearchableMemoryCenterKind, string> = {
  personal: "我",
  work_preference: "偏好",
  workspace_memory: "文件夹",
};

export const STATE_LABEL: Record<MemoryCenterState, string> = {
  pinned: "始终带上",
  hot: "正在用",
  cold: "很久没用",
  done: "已办完",
  expired: "已过期",
  待核实: "待你确认",
};

export const INJECTION_REASON_LABEL: Record<MemoryInjectionReason, string> = {
  pinned: "始终带上",
  section_anchor: "这一节正好用到",
  relevant: "和你刚说的有关",
  rotation: "轮到它",
};

export const SKIP_REASON_LABEL: Record<MemoryInjectionSkipReason, string> = {
  budget: "这一轮太长，没带上",
  cold_unrelated: "很久没用，也和这次无关",
  terminal: "已经办完或过期",
};

export function effectiveStateLabel(state: string): string {
  if (state in STATE_LABEL) return STATE_LABEL[state as MemoryCenterState];
  return state;
}

export function itemKey(item: { id: string | null; section?: string; text: string }, index: number): string {
  if (item.id) return item.id;
  const head = item.section?.trim() || item.text.slice(0, 24);
  return `idx:${index}:${head}`;
}
