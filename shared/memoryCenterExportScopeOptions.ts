import type { MemoryCenterScopeSummary } from "./protocol.ts";

export const MEMORY_CENTER_EXPORT_VIRTUAL_SCOPES = ["personal", "work_preference", "personal_settings"] as const;

export function workspaceExportScopeIdsFromOverview(scopes: MemoryCenterScopeSummary[]): string[] {
  return scopes
    .filter((s) => s.kind === "workspace_memory")
    .map((s) => s.id)
    .sort((a, b) => a.localeCompare(b));
}

/** 默认选中：个人 + W0 + 总览里所有工作区 scope（不含 settings，需用户显式勾选）。 */
export function defaultMemoryCenterExportScopes(scopes: MemoryCenterScopeSummary[]): string[] {
  return ["personal", "work_preference", ...workspaceExportScopeIdsFromOverview(scopes)];
}

export function validateExportScopeSelection(selected: string[], overviewScopes: MemoryCenterScopeSummary[]): boolean {
  if (!selected.length) return false;
  const allowed = new Set<string>([
    ...MEMORY_CENTER_EXPORT_VIRTUAL_SCOPES,
    ...workspaceExportScopeIdsFromOverview(overviewScopes),
  ]);
  return selected.every((s) => allowed.has(s));
}
