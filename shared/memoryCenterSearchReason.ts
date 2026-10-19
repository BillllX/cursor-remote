import type { MemoryCenterSearchMatchReason } from "./protocol.ts";

/** 搜索匹配原因：后端只发 code，客户端映射中文。 */
export const MEMORY_CENTER_SEARCH_REASON_LABEL: Record<MemoryCenterSearchMatchReason, string> = {
  text: "正文匹配",
  section: "分节匹配",
  ref: "引用匹配",
  scope: "作用域匹配",
  state: "状态匹配",
  pinned: "置顶匹配",
  related: "相关",
};

export function formatMemoryCenterSearchReasons(reasons: MemoryCenterSearchMatchReason[]): string {
  return reasons.map((code) => MEMORY_CENTER_SEARCH_REASON_LABEL[code] ?? code).join(" · ");
}

export function isMemoryCenterSearchMatchReason(value: string): value is MemoryCenterSearchMatchReason {
  return value in MEMORY_CENTER_SEARCH_REASON_LABEL;
}
