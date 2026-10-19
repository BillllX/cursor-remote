import { discoverScopesForTest } from "./memoryCenter.ts";
import type { WorkspaceRoot } from "./workspaceMemory.ts";

export type ExportScopeResolve =
  | { ok: true; scopes: string[] }
  | { ok: false; code: "invalid_input" | "invalid_scope"; error: string };

const VIRTUAL_SCOPES = ["personal", "work_preference", "personal_settings"] as const;

/** scopes 未传 = 全部；空数组 = invalid_input；未知 id = invalid_scope。 */
export function resolveExportScopes(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  requested?: string[],
): ExportScopeResolve {
  const discovered = discoverScopesForTest(tenant, workspaceNames);
  const wsIds = [...discovered.scopes.keys()].filter((id) => !VIRTUAL_SCOPES.includes(id as (typeof VIRTUAL_SCOPES)[number]));
  const allScopes = [...new Set([...VIRTUAL_SCOPES, ...wsIds])].sort();
  const allowed = new Set(allScopes);
  if (requested === undefined) return { ok: true, scopes: allScopes };
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, code: "invalid_input", error: "scopes 不能为空数组。" };
  }
  const set = new Set(requested.map((s) => s.trim()).filter(Boolean));
  const unknown = [...set].filter((id) => !allowed.has(id));
  if (unknown.length) {
    return { ok: false, code: "invalid_scope", error: `未知 scope：${unknown.join(", ")}` };
  }
  return { ok: true, scopes: allScopes.filter((id) => set.has(id)) };
}

export function exportIncludesPersonal(scopes: string[]) {
  return scopes.includes("personal");
}

export function exportIncludesPersonalSettings(scopes: string[]) {
  return scopes.includes("personal_settings");
}

export function exportIncludesWorkPreference(scopes: string[]) {
  return scopes.includes("work_preference");
}
