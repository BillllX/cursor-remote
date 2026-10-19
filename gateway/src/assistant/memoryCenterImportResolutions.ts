import type {
  MemoryCenterImportApplyResolution,
  MemoryCenterImportChange,
  MemoryCenterImportResolution,
} from "../../../shared/memoryCenterImportTypes.ts";

export type ResolutionValidateResult =
  | { ok: true; map: Map<string, MemoryCenterImportResolution> }
  | { ok: false; code: string; error: string };

const ENTRY_LAYERS = new Set(["personal_entries", "workspace_entries"]);

export function validateApplyResolutions(
  changes: MemoryCenterImportChange[],
  resolutions: MemoryCenterImportApplyResolution[],
): ResolutionValidateResult {
  const planIds = new Set(changes.map((c) => c.changeId));
  const map = new Map<string, MemoryCenterImportResolution>();
  for (const row of resolutions) {
    if (!row.changeId || !planIds.has(row.changeId)) {
      return { ok: false, code: "invalid_resolution", error: `未知 changeId：${row.changeId}` };
    }
    if (map.has(row.changeId)) {
      return { ok: false, code: "duplicate_resolution", error: "resolution 重复。" };
    }
    map.set(row.changeId, row.resolution);
  }
  for (const change of changes) {
    if (change.action === "conflict" && !map.has(change.changeId)) {
      return { ok: false, code: "unresolved_conflict", error: `冲突 ${change.changeId} 未选择 resolution。` };
    }
  }
  for (const [changeId, resolution] of map) {
    const change = changes.find((c) => c.changeId === changeId)!;
    if (!change.allowedResolutions.includes(resolution)) {
      return { ok: false, code: "invalid_resolution", error: `resolution 不允许：${changeId}` };
    }
    if (resolution === "duplicate" && !ENTRY_LAYERS.has(change.layer)) {
      return { ok: false, code: "invalid_resolution", error: `duplicate 仅适用于条目：${changeId}` };
    }
  }
  return { ok: true, map };
}

export function validatePlanChangeIds(changes: MemoryCenterImportChange[]): boolean {
  const seen = new Set<string>();
  for (const c of changes) {
    if (!c.changeId || seen.has(c.changeId)) return false;
    seen.add(c.changeId);
  }
  return true;
}
