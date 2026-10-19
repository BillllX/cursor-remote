import type {
  MemoryCenterExportData,
  MemoryCenterImportApplyData,
  MemoryCenterImportPreviewData,
  MemoryCenterImportRollbackData,
} from "./memoryCenterImportTypes.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseMemoryCenterExportData(raw: unknown): MemoryCenterExportData | null {
  if (!isObject(raw)) return null;
  const relativePath = raw.relativePath;
  const sha256 = raw.sha256;
  const bytes = raw.bytes;
  const summary = raw.summary;
  if (typeof relativePath !== "string" || typeof sha256 !== "string" || typeof bytes !== "number" || !isObject(summary)) {
    return null;
  }
  if (
    !Array.isArray(summary.scopes) ||
    typeof summary.personalEntries !== "number" ||
    typeof summary.workspaceScopes !== "number" ||
    typeof summary.rulesInventory !== "number"
  ) {
    return null;
  }
  if (!summary.scopes.every((s) => typeof s === "string")) return null;
  return raw as MemoryCenterExportData;
}

export function parseMemoryCenterImportPreviewData(raw: unknown): MemoryCenterImportPreviewData | null {
  if (!isObject(raw)) return null;
  if (typeof raw.planId !== "string" || typeof raw.expiresAt !== "string" || !isObject(raw.snapshotSummary)) return null;
  if (!Array.isArray(raw.changes) || !Array.isArray(raw.warnings)) return null;
  const sum = raw.snapshotSummary;
  if (
    typeof sum.exportedAt !== "string" ||
    typeof sum.schemaVersion !== "number" ||
    typeof sum.scopeCount !== "number" ||
    typeof sum.personalEntryCount !== "number" ||
    typeof sum.rulesCount !== "number" ||
    typeof sum.bytes !== "number" ||
    typeof sum.checksum !== "string"
  ) {
    return null;
  }
  for (const ch of raw.changes) {
    if (!isObject(ch)) return null;
    if (typeof ch.changeId !== "string" || typeof ch.layer !== "string" || typeof ch.action !== "string") return null;
    if (!Array.isArray(ch.allowedResolutions) || !ch.allowedResolutions.every((r) => typeof r === "string")) return null;
  }
  for (const w of raw.warnings) {
    if (!isObject(w)) return null;
    if (typeof w.code !== "string" || typeof w.message !== "string") return null;
  }
  return raw as MemoryCenterImportPreviewData;
}

export function parseMemoryCenterImportApplyData(raw: unknown): MemoryCenterImportApplyData | null {
  if (!isObject(raw)) return null;
  if (typeof raw.importId !== "string" || raw.canRollback !== true || !isObject(raw.summary)) return null;
  const summary = raw.summary;
  if (
    typeof summary.applied !== "number" ||
    typeof summary.skipped !== "number" ||
    typeof summary.conflictsResolved !== "number"
  ) {
    return null;
  }
  return raw as MemoryCenterImportApplyData;
}

export function parseMemoryCenterImportRollbackData(raw: unknown): MemoryCenterImportRollbackData | null {
  if (!isObject(raw)) return null;
  if (typeof raw.importId !== "string") return null;
  if (raw.status !== "rolled_back" && raw.status !== "already_rolled_back") return null;
  return raw as MemoryCenterImportRollbackData;
}
