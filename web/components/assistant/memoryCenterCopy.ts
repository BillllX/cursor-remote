import type { InjectionDiagnostics, MemoryCenterSuggestionEntry, WorkspaceMemoryItem } from "@shared/protocol";

export const MEMORY_DESTINATIONS = [
  { id: "me", label: "记得的我" },
  { id: "folder", label: "这个文件夹" },
  { id: "review", label: "要你看一眼" },
  { id: "more", label: "更多" },
] as const;

export type MemoryDestination = (typeof MEMORY_DESTINATIONS)[number]["id"];

export const FOLDER_MENUS = [
  { id: "useful", label: "会用到的" },
  { id: "pinned", label: "始终带上" },
  { id: "confirm", label: "待你确认" },
  { id: "done", label: "已办完" },
  { id: "all", label: "全部" },
] as const;

export type FolderMenu = (typeof FOLDER_MENUS)[number]["id"];

export const MORE_PAGES = [
  { id: "skills", label: "技能工厂" },
  { id: "activity", label: "最近改动" },
  { id: "transfer", label: "导出与导入" },
  { id: "diagnostics", label: "上一轮怎么选的" },
  { id: "rules", label: "文件夹规则" },
] as const;

export type MorePage = (typeof MORE_PAGES)[number]["id"];

export const CORE_FIELD_ORDER = ["关于我", "偏好", "近况", "人物", "工作偏好"] as const;

type StatusItem = {
  effectiveState: string;
  pinned?: boolean;
  missingRefs?: string[];
};

/** 列表上只在需要留意时写一个词。正在用的条目不写状态。 */
export function listStatusWord(item: StatusItem): string | null {
  if (item.missingRefs && item.missingRefs.length > 0) return "待你确认";
  if (item.pinned) return "始终带上";
  if (item.effectiveState === "cold") return "很久没用";
  if (item.effectiveState === "done") return "已办完";
  if (item.effectiveState === "expired") return "已过期";
  return null;
}

export function filterFolderItems<T extends StatusItem & { missingRefs: string[] }>(items: T[], menu: FolderMenu): T[] {
  switch (menu) {
    case "useful":
      return items.filter((item) => item.effectiveState !== "done" && item.effectiveState !== "expired");
    case "pinned":
      return items.filter((item) => item.pinned === true);
    case "confirm":
      return items.filter((item) => item.missingRefs.length > 0);
    case "done":
      return items.filter((item) => item.effectiveState === "done");
    case "all":
      return items;
  }
}

export function suggestionOutcomeLabel(kind: string): string {
  switch (kind) {
    case "missing_ref":
      return "引用已经处理";
    case "duplicate":
      return "合成一条";
    case "stale_hot":
      return "标成很久没用";
    case "stale_ongoing":
      return "标成已办完";
    case "budget_pressure":
      return "先放到一边";
    default:
      return "按建议处理";
  }
}

export function lowRiskBulk(entries: MemoryCenterSuggestionEntry[]): MemoryCenterSuggestionEntry[] {
  return entries.filter((entry) => entry.risk === "low" && entry.kind !== "missing_ref");
}

export function searchSourceLabel(kind: string, scopeLabel: string): string {
  if (kind === "personal") return "我";
  if (kind === "work_preference") return "偏好";
  return scopeLabel || "文件夹";
}

export function searchGroupLabel(kind: string, scopeLabel: string): string {
  if (kind === "personal") return "关于我";
  if (kind === "work_preference") return "工作偏好";
  return scopeLabel || "文件夹";
}

export function basisLabel(basis: string): string {
  if (basis === "user_said") return "你说的";
  if (basis === "inferred") return "推断";
  return "";
}

export function folderMenuLabel(menu: FolderMenu): string {
  return FOLDER_MENUS.find((row) => row.id === menu)?.label ?? "会用到的";
}

/** 打开记忆时：从工作区进来停在这个文件夹，其余停在记得的我。 */
export function openingDestination(initialScopeId?: string): {
  destination: MemoryDestination;
  folderId: string | null;
} {
  if (
    initialScopeId &&
    initialScopeId !== "personal" &&
    initialScopeId !== "overview" &&
    initialScopeId !== "work_preference"
  ) {
    return { destination: "folder", folderId: initialScopeId };
  }
  return { destination: "me", folderId: null };
}

export function preferredFolderId(
  scopes: Array<{ id: string; kind?: string }>,
  preferred: string | null,
): string | null {
  const folders = scopes.filter((scope) => scope.id !== "personal" && scope.id !== "work_preference");
  if (preferred && folders.some((scope) => scope.id === preferred)) return preferred;
  return folders[0]?.id ?? preferred;
}

export function wasUsedLastRound(id: string | null, diagnostics: InjectionDiagnostics | null): boolean {
  if (!id || !diagnostics) return false;
  return diagnostics.selectedIds.some((row) => row.id === id);
}

export function diagnosticsSummary(diagnostics: InjectionDiagnostics | null): string[] {
  if (!diagnostics) return ["上一轮没有选出记忆。"];
  return [
    `带上了 ${diagnostics.selected} 条，一共 ${diagnostics.total} 条。`,
    `始终带上 ${diagnostics.pinnedSelected} · 和你说的有关 ${diagnostics.relevantSelected} · 很久没用但仍带上 ${diagnostics.coldRecalled}`,
    `这一轮太长没带上 ${diagnostics.skippedBudget} · 已经办完或过期 ${diagnostics.terminalSkipped}`,
  ];
}

export function firstConfirmKey(
  items: WorkspaceMemoryItem[],
  keyOf: (item: WorkspaceMemoryItem, index: number) => string,
): string | null {
  const index = items.findIndex((item) => item.missingRefs.length > 0);
  if (index < 0) return null;
  return keyOf(items[index], index);
}
