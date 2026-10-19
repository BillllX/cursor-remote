import {
  parseMemoryCenterExportData,
  parseMemoryCenterImportApplyData,
  parseMemoryCenterImportPreviewData,
  parseMemoryCenterImportRollbackData,
} from "./memoryCenterImportParse.ts";
import type {
  MemoryCenterActivityData,
  MemoryCenterActivityEntry,
  MemoryCenterActivitySnapshotSummary,
  MemoryCenterRestoreFailureData,
  MemoryCenterSuggestionsData,
  MemoryCenterSuggestionAnswerData,
  MemoryCenterSuggestionEntry,
} from "./protocol.ts";

const ACTIVITY_ACTIONS = new Set(["create", "update", "set_state", "set_pinned", "delete", "restore", "import"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function reqString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === "string" ? v : null;
}

function optString(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : null as unknown as undefined;
}

function reqBool(row: Record<string, unknown>, key: string): boolean | null {
  const v = row[key];
  return typeof v === "boolean" ? v : null;
}

function parseActivitySnapshotSummary(raw: unknown): MemoryCenterActivitySnapshotSummary | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) return null;
  const id = raw.id === null || typeof raw.id === "string" ? raw.id : null;
  const section = reqString(raw, "section");
  const text = reqString(raw, "text");
  const revision = reqString(raw, "revision");
  if (!section || !text || !revision) return null;
  let state: MemoryCenterActivitySnapshotSummary["state"] = undefined;
  if (raw.state === null) state = null;
  else if (raw.state === "hot" || raw.state === "cold" || raw.state === "done") state = raw.state;
  else if (raw.state !== undefined) return null;
  const pinned = typeof raw.pinned === "boolean" ? raw.pinned : undefined;
  return { id, section, text, revision, state, pinned };
}

function parseActivityEntry(raw: unknown): MemoryCenterActivityEntry | null {
  if (!isObject(raw)) return null;
  const auditId = reqString(raw, "auditId");
  const scope = reqString(raw, "scope");
  const itemId = reqString(raw, "itemId");
  const action = reqString(raw, "action");
  const actor = reqString(raw, "actor");
  const at = reqString(raw, "at");
  const canRestore = reqBool(raw, "canRestore");
  if (!auditId || !scope || !itemId || !action || !actor || !at || canRestore === null) return null;
  if (!ACTIVITY_ACTIONS.has(action)) return null;
  if (actor !== "user" && actor !== "maintenance") return null;
  const before = parseActivitySnapshotSummary(raw.before);
  if (raw.before !== undefined && raw.before !== null && !before) return null;
  const after = parseActivitySnapshotSummary(raw.after);
  if (raw.after !== undefined && raw.after !== null && !after) return null;
  const restoreBlockedReason = optString(raw, "restoreBlockedReason");
  if (raw.restoreBlockedReason !== undefined && raw.restoreBlockedReason !== null && !restoreBlockedReason) return null;
  const degraded = typeof raw.degraded === "boolean" ? raw.degraded : undefined;
  return {
    auditId,
    scope,
    itemId,
    action: action as MemoryCenterActivityEntry["action"],
    actor,
    at,
    before: before ?? undefined,
    after: after ?? undefined,
    canRestore,
    restoreBlockedReason,
    degraded,
  };
}

export function parseMemoryCenterActivityData(raw: unknown): MemoryCenterActivityData | null {
  if (!isObject(raw)) return null;
  if (!Array.isArray(raw.entries)) return null;
  const entries: MemoryCenterActivityEntry[] = [];
  for (const row of raw.entries) {
    const parsed = parseActivityEntry(row);
    if (!parsed) return null;
    entries.push(parsed);
  }
  const nextCursor = optString(raw, "nextCursor");
  if (raw.nextCursor !== undefined && raw.nextCursor !== null && !nextCursor) return null;
  const truncated = typeof raw.truncated === "boolean" ? raw.truncated : undefined;
  const degraded = typeof raw.degraded === "boolean" ? raw.degraded : undefined;
  return { entries, nextCursor, truncated, degraded };
}

export function parseMemoryCenterSuggestionsData(raw: unknown): MemoryCenterSuggestionsData | null {
  if (!isObject(raw)) return null;
  const generatedAt = reqString(raw, "generatedAt");
  if (!generatedAt) return null;
  const lastRunAt = optString(raw, "lastRunAt");
  if (raw.lastRunAt !== undefined && raw.lastRunAt !== null && !lastRunAt) return null;
  if (!Array.isArray(raw.entries)) return null;
  const entries: MemoryCenterSuggestionEntry[] = [];
  for (const row of raw.entries) {
    if (!isObject(row)) return null;
    const id = reqString(row, "id");
    const scope = reqString(row, "scope");
    const kind = reqString(row, "kind");
    const summary = reqString(row, "summary");
    const reason = reqString(row, "reason");
    const risk = reqString(row, "risk");
    if (!id || !scope || !kind || !summary || !reason || !risk) return null;
    if (risk !== "low" && risk !== "medium") return null;
    if (!Array.isArray(row.itemIds) || !row.itemIds.every((x) => typeof x === "string")) return null;
    if (!Array.isArray(row.revisions) || !row.revisions.every((x) => typeof x === "string")) return null;
    if (!isObject(row.proposedAction)) return null;
    const pak = reqString(row.proposedAction, "kind");
    if (!pak) return null;
    entries.push(row as unknown as MemoryCenterSuggestionEntry);
  }
  const truncated = typeof raw.truncated === "boolean" ? raw.truncated : undefined;
  return { generatedAt, lastRunAt, entries, truncated };
}

export function parseMemoryCenterSuggestionAnswerData(raw: unknown): MemoryCenterSuggestionAnswerData | null {
  if (!isObject(raw)) return null;
  const id = reqString(raw, "id");
  const status = reqString(raw, "status");
  if (!id || !status) return null;
  if (status !== "accepted" && status !== "dismissed" && status !== "stale") return null;
  const detail = optString(raw, "detail");
  if (raw.detail !== undefined && raw.detail !== null && !detail) return null;
  return { id, status, detail };
}

export function parseMemoryCenterRestoreFailureData(raw: unknown): MemoryCenterRestoreFailureData | null {
  if (!isObject(raw)) return null;
  const code = reqString(raw, "code");
  if (!code) return null;
  const allowed = new Set(["invalid_scope", "not_found", "conflict", "corrupt_audit", "write_failed"]);
  if (!allowed.has(code)) return null;
  return { code: code as MemoryCenterRestoreFailureData["code"] };
}

/** malformed 输入返回 null，不抛错 */
export function tryParseMemoryCenterPayload(op: string, raw: unknown): unknown | null {
  try {
    if (op === "memory_center_activity") return parseMemoryCenterActivityData(raw);
    if (op === "memory_center_suggestions_get") return parseMemoryCenterSuggestionsData(raw);
    if (op === "memory_center_suggestion_answer") return parseMemoryCenterSuggestionAnswerData(raw);
    if (op === "memory_center_restore" && raw && isObject(raw) && raw.code) return parseMemoryCenterRestoreFailureData(raw);
    if (op === "memory_center_export") return parseMemoryCenterExportData(raw);
    if (op === "memory_center_import_preview") return parseMemoryCenterImportPreviewData(raw);
    if (op === "memory_center_import_apply") return parseMemoryCenterImportApplyData(raw);
    if (op === "memory_center_import_rollback") return parseMemoryCenterImportRollbackData(raw);
    return raw ?? null;
  } catch {
    return null;
  }
}
