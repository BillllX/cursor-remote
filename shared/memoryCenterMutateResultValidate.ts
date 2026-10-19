import type {
  MemoryCenterKind,
  MemoryCenterLayer,
  MemoryCenterMutateData,
  MemoryCenterMutateErrorCode,
  MemoryCenterMutateFailureData,
  MemoryCenterScopeDetail,
  MemoryCenterScopeSummary,
  MemoryInjectionReason,
  MemoryInjectionSkipReason,
  WorkspaceMemoryItem,
} from "./protocol.ts";

const MUTATE_CODES: MemoryCenterMutateErrorCode[] = [
  "invalid_scope",
  "not_found",
  "conflict",
  "invalid_input",
  "unsafe_ref",
  "sensitive",
  "write_failed",
];

const KINDS = new Set<MemoryCenterKind>(["personal", "work_preference", "workspace_memory", "rule", "document"]);
const LAYERS = new Set<MemoryCenterLayer>(["L0", "L1", "L2", "L3", "L4"]);
const EFFECTIVE = new Set(["hot", "cold", "done", "expired"]);
const ITEM_STATES = new Set(["hot", "cold", "done"]);
const INJECTION_REASONS = new Set<MemoryInjectionReason>(["pinned", "section_anchor", "relevant", "rotation"]);
const INJECTION_SKIP_REASONS = new Set<MemoryInjectionSkipReason>(["budget", "cold_unrelated", "terminal"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!set.has(key)) return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((row) => typeof row === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBool(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validateScopeSummary(raw: unknown): raw is MemoryCenterScopeSummary {
  if (!isRecord(raw)) return false;
  if (
    !hasExactKeys(raw, [
      "id",
      "label",
      "kind",
      "layer",
      "parentId",
      "memoryCount",
      "hot",
      "cold",
      "done",
      "expired",
      "pinned",
      "missingRefs",
      "ruleFileCount",
      "tokenBudget",
      "injectionSelected",
      "injectionSkipped",
      "pendingCount",
      "health",
      "error",
    ])
  ) {
    return false;
  }
  if (typeof raw.id !== "string" || typeof raw.label !== "string") return false;
  if (!KINDS.has(raw.kind as MemoryCenterKind) || !LAYERS.has(raw.layer as MemoryCenterLayer)) return false;
  if (raw.parentId !== undefined && raw.parentId !== null && typeof raw.parentId !== "string") return false;
  for (const key of [
    "memoryCount",
    "hot",
    "cold",
    "done",
    "expired",
    "pinned",
    "missingRefs",
    "ruleFileCount",
    "tokenBudget",
    "injectionSelected",
    "injectionSkipped",
    "pendingCount",
  ] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) return false;
  }
  if (raw.health !== undefined && raw.health !== null && typeof raw.health !== "string") return false;
  if (raw.error !== undefined && raw.error !== null && typeof raw.error !== "string") return false;
  return true;
}

function validateWorkspaceItem(raw: unknown): raw is WorkspaceMemoryItem {
  if (!isRecord(raw)) return false;
  if (
    !hasExactKeys(raw, [
      "id",
      "kind",
      "layer",
      "scopeId",
      "section",
      "text",
      "refs",
      "missingRefs",
      "at",
      "from",
      "state",
      "effectiveState",
      "pinned",
      "used",
      "uses",
      "expires",
      "truncated",
      "revision",
    ])
  ) {
    return false;
  }
  if (raw.id !== null && typeof raw.id !== "string") return false;
  if (!KINDS.has(raw.kind as MemoryCenterKind) || !LAYERS.has(raw.layer as MemoryCenterLayer)) return false;
  if (typeof raw.scopeId !== "string" || typeof raw.text !== "string" || typeof raw.revision !== "string") {
    return false;
  }
  if (!isStringArray(raw.refs) || !isStringArray(raw.missingRefs)) return false;
  if (!EFFECTIVE.has(String(raw.effectiveState))) return false;
  if (raw.section !== undefined && typeof raw.section !== "string") return false;
  if (raw.at !== undefined && raw.at !== null && typeof raw.at !== "string") return false;
  if (raw.from !== undefined && raw.from !== null && typeof raw.from !== "string") return false;
  if (raw.state !== undefined && raw.state !== null && !ITEM_STATES.has(String(raw.state))) return false;
  if (raw.used !== undefined && raw.used !== null && typeof raw.used !== "string") return false;
  if (raw.expires !== undefined && raw.expires !== null && typeof raw.expires !== "string") return false;
  if (raw.uses !== undefined && (typeof raw.uses !== "number" || !Number.isFinite(raw.uses))) return false;
  if (!isOptionalBool(raw.pinned) || !isOptionalBool(raw.truncated)) return false;
  return true;
}

function validateRuleFile(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (!hasExactKeys(raw, ["relPath", "appliesDir", "chars", "body", "truncated"])) return false;
  if (typeof raw.relPath !== "string" || typeof raw.appliesDir !== "string") return false;
  if (!isFiniteNumber(raw.chars) || typeof raw.body !== "string") return false;
  return isOptionalBool(raw.truncated);
}

function validateInjectionSelectedEntry(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (!hasExactKeys(raw, ["id", "reason"])) return false;
  if (raw.id !== null && typeof raw.id !== "string") return false;
  if (typeof raw.reason !== "string" || !INJECTION_REASONS.has(raw.reason as MemoryInjectionReason)) return false;
  return true;
}

function validateInjectionSkippedEntry(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (!hasExactKeys(raw, ["id", "reason"])) return false;
  if (raw.id !== null && typeof raw.id !== "string") return false;
  if (typeof raw.reason !== "string" || !INJECTION_SKIP_REASONS.has(raw.reason as MemoryInjectionSkipReason)) {
    return false;
  }
  return true;
}

function validateInjectionIdArray(raw: unknown, validateEntry: (row: unknown) => boolean): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.every((row) => validateEntry(row));
}

function validateDiagnostics(raw: unknown): boolean {
  if (raw === null) return true;
  if (!isRecord(raw)) return false;
  if (
    !hasExactKeys(raw, [
      "total",
      "selected",
      "skippedBudget",
      "hotSelected",
      "coldRecalled",
      "terminalSkipped",
      "coldUnrelatedSkipped",
      "pinnedSelected",
      "relevantSelected",
      "strategy",
      "selectedIds",
      "skippedReasons",
      "selectedIdsTruncated",
      "skippedReasonsTruncated",
      "truncated",
    ])
  ) {
    return false;
  }
  for (const key of ["total", "selected", "skippedBudget", "hotSelected", "coldRecalled", "terminalSkipped"] as const) {
    if (!isFiniteNumber(raw[key])) return false;
  }
  if (!isOptionalNumber(raw.coldUnrelatedSkipped)) return false;
  if (!isFiniteNumber(raw.pinnedSelected) || !isFiniteNumber(raw.relevantSelected)) return false;
  if (typeof raw.strategy !== "string") return false;
  if (!validateInjectionIdArray(raw.selectedIds, validateInjectionSelectedEntry)) return false;
  if (raw.skippedReasons !== undefined && !validateInjectionIdArray(raw.skippedReasons, validateInjectionSkippedEntry)) {
    return false;
  }
  if (
    !isOptionalBool(raw.selectedIdsTruncated) ||
    !isOptionalBool(raw.skippedReasonsTruncated) ||
    !isOptionalBool(raw.truncated)
  ) {
    return false;
  }
  return true;
}

/** 运行时校验 memory_center_mutate 成功 payload 的 detail 嵌套结构。 */
export function validateMemoryCenterScopeDetail(raw: unknown): raw is MemoryCenterScopeDetail {
  if (!isRecord(raw)) return false;
  if (!hasExactKeys(raw, ["scope", "items", "rules", "diagnostics", "itemsTruncated", "rulesTruncated", "rulesPayloadTruncated"])) {
    return false;
  }
  if (!validateScopeSummary(raw.scope)) return false;
  if (!Array.isArray(raw.items) || !raw.items.every((row) => validateWorkspaceItem(row))) return false;
  if (!Array.isArray(raw.rules) || !raw.rules.every((row) => validateRuleFile(row))) return false;
  if (!validateDiagnostics(raw.diagnostics)) return false;
  if (!isOptionalBool(raw.itemsTruncated) || !isOptionalBool(raw.rulesTruncated) || !isOptionalBool(raw.rulesPayloadTruncated)) {
    return false;
  }
  return true;
}

export function validateMemoryCenterMutateSuccessData(raw: unknown): raw is MemoryCenterMutateData {
  if (!isRecord(raw)) return false;
  if (!hasExactKeys(raw, ["scope", "action", "item", "deletedId", "detail"])) return false;
  if (typeof raw.scope !== "string" || typeof raw.action !== "string") return false;
  if (!validateMemoryCenterScopeDetail(raw.detail)) return false;
  if (raw.item !== undefined && !validateWorkspaceItem(raw.item)) return false;
  if (raw.deletedId !== undefined && typeof raw.deletedId !== "string") return false;
  return true;
}

export function validateMemoryCenterMutateFailureData(raw: unknown): raw is MemoryCenterMutateFailureData {
  if (!isRecord(raw)) return false;
  if (!hasExactKeys(raw, ["code", "detail"])) return false;
  const code = raw.code;
  if (typeof code !== "string" || !MUTATE_CODES.includes(code as MemoryCenterMutateErrorCode)) return false;
  if (raw.detail !== undefined && !validateMemoryCenterScopeDetail(raw.detail)) return false;
  return true;
}
