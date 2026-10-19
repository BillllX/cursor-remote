import { createHash } from "node:crypto";
import type { AssistantMemoryEntry } from "./protocol.ts";

export const MEMORY_CENTER_SNAPSHOT_SCHEMA = 1 as const;
export const MEMORY_CENTER_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;
export const MEMORY_CENTER_SNAPSHOT_MAX_SCOPES = 80;
export const MEMORY_CENTER_SNAPSHOT_MAX_ENTRIES = 500;
export const MEMORY_CENTER_SNAPSHOT_MAX_RULES = 200;
export const MEMORY_CENTER_SNAPSHOT_MAX_DEPTH = 8;
export const MEMORY_CENTER_SNAPSHOT_MAX_TEXT = 500_000;

export type MemoryCenterSnapshotPersonalCore = {
  rev: number;
  fields: Record<string, string>;
  updatedAt?: string;
};

export type MemoryCenterSnapshotPersonalSettings = {
  paused: boolean;
  allowSensitive: Record<string, boolean>;
};

export type MemoryCenterSnapshotWorkspaceScope = {
  scopeId: string;
  memoryRaw: string;
  memoryChecksum: string;
  summary: {
    lineCount: number;
    hot: number;
    cold: number;
    done: number;
    pinned: number;
    missingRefs: number;
  };
};

export type MemoryCenterSnapshotRuleInventoryItem = {
  scope: string;
  path: string;
  chars: number;
  checksum: string;
};

export type MemoryCenterSnapshotIncludedScopes = {
  personal: boolean;
  workPreference: boolean;
  personalSettings: boolean;
  workspaceIds: string[];
};

export type MemoryCenterSnapshotV1 = {
  schemaVersion: typeof MEMORY_CENTER_SNAPSHOT_SCHEMA;
  exportedAt: string;
  appVersion?: string;
  manifest: { checksum: string; includedScopes: MemoryCenterSnapshotIncludedScopes };
  personal: {
    core: MemoryCenterSnapshotPersonalCore;
    settings: MemoryCenterSnapshotPersonalSettings;
    entries: AssistantMemoryEntry[];
  };
  workPreferences: { text: string; checksum: string };
  workspaces: MemoryCenterSnapshotWorkspaceScope[];
  rulesInventory: MemoryCenterSnapshotRuleInventoryItem[];
};

const CORE_FIELD_KEYS = ["关于我", "偏好", "近况", "人物"] as const;
const CORE_FIELD_KEYS_LEGACY = ["关于我", "偏好", "近况", "人物", "工作偏好"] as const;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ABS_PATH_RE = /^\/|^[A-Za-z]:[\\/]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const SECRET_RES: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bcursor_[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(密码|口令|password|passwd|token|api[_ -]?key|secret)\s*[:：=是为]\s*\S{4,}/i,
  /\b\d{17}[\dXx]\b/,
];

export function detectSnapshotSecret(text: string) {
  return SECRET_RES.some((re) => re.test(text));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(obj: Record<string, unknown>, allowed: string[], path: string, errors: string[]) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`${path} 含非法键。`);
    if (!allowed.includes(key)) errors.push(`${path} 未知键：${key}`);
  }
}

function reqString(obj: Record<string, unknown>, key: string, max: number, errors: string[], path: string): string | null {
  const v = obj[key];
  if (typeof v !== "string") {
    errors.push(`${path}.${key} 必须是字符串。`);
    return null;
  }
  if (v.length > max) errors.push(`${path}.${key} 过长。`);
  return v;
}

function reqNumber(obj: Record<string, unknown>, key: string, errors: string[], path: string): number | null {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${path}.${key} 必须是数字。`);
    return null;
  }
  return v;
}

function validateScopeId(id: string, errors: string[]) {
  if (!id || id === "." || id.includes("..") || id.startsWith("/") || ABS_PATH_RE.test(id)) {
    errors.push(`scopeId 不合法：${id}`);
    return false;
  }
  if (id.split("/").some((part) => !part || part.startsWith("."))) {
    errors.push(`scopeId 含非法段：${id}`);
    return false;
  }
  return true;
}

function walkPlainObject(value: unknown, path: string, depth: number, errors: string[]) {
  if (depth > MEMORY_CENTER_SNAPSHOT_MAX_DEPTH) {
    errors.push(`${path} 超过最大深度 ${MEMORY_CENTER_SNAPSHOT_MAX_DEPTH}。`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkPlainObject(value[i], `${path}[${i}]`, depth + 1, errors);
    return;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path} 必须是 plain object。`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`${path} 含非法键 ${key}。`);
    walkPlainObject((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, errors);
  }
}

function validateEntrySource(source: unknown, path: string, errors: string[]) {
  if (source === undefined || source === null) return;
  if (!isPlainObject(source)) {
    errors.push(`${path}.source 必须是对象或 null。`);
    return;
  }
  exactKeys(source, ["chatId", "turn", "chatDeleted"], path + ".source", errors);
  if (source.chatId !== undefined && typeof source.chatId !== "string") {
    errors.push(`${path}.source.chatId 必须是字符串。`);
  }
  if (source.chatId !== undefined && typeof source.chatId === "object") {
    errors.push(`${path}.source.chatId 不得为嵌套对象。`);
  }
  if (source.turn !== undefined && (typeof source.turn !== "number" || !Number.isFinite(source.turn))) {
    errors.push(`${path}.source.turn 必须是数字。`);
  }
  if (source.chatDeleted !== undefined && typeof source.chatDeleted !== "boolean") {
    errors.push(`${path}.source.chatDeleted 必须是布尔。`);
  }
  for (const key of Object.keys(source)) {
    walkPlainObject(source[key], `${path}.source.${key}`, MEMORY_CENTER_SNAPSHOT_MAX_DEPTH, errors);
  }
}

function validateMemoryLineLegal(raw: string, scopeId: string, errors: string[]) {
  if (detectSnapshotSecret(raw)) errors.push(`${scopeId} memory 含疑似密钥。`);
  if (ABS_PATH_RE.test(raw) || raw.includes("/etc/") || raw.includes("tenant")) {
    errors.push(`${scopeId} memory 含绝对路径或租户标识。`);
  }
}

function validatePersonalEntry(entry: unknown, errors: string[], index: number): AssistantMemoryEntry | null {
  if (!isPlainObject(entry)) {
    errors.push(`personal.entries[${index}] 必须是对象。`);
    return null;
  }
  exactKeys(
    entry,
    [
      "id",
      "rev",
      "topic",
      "kind",
      "text",
      "basis",
      "confidence",
      "source",
      "validFrom",
      "validUntil",
      "createdAt",
      "updatedAt",
      "lastUsedAt",
      "invalidAt",
      "invalidReason",
      "supplements",
      "seen",
    ],
    `personal.entries[${index}]`,
    errors,
  );
  const id = reqString(entry, "id", 80, errors, `personal.entries[${index}]`);
  const topic = reqString(entry, "topic", 40, errors, `personal.entries[${index}]`);
  const kind = reqString(entry, "kind", 40, errors, `personal.entries[${index}]`);
  const text = reqString(entry, "text", 800, errors, `personal.entries[${index}]`);
  const basis = entry.basis;
  const rev = reqNumber(entry, "rev", errors, `personal.entries[${index}]`);
  const confidence = reqNumber(entry, "confidence", errors, `personal.entries[${index}]`);
  const createdAt = reqString(entry, "createdAt", 40, errors, `personal.entries[${index}]`);
  const updatedAt = reqString(entry, "updatedAt", 40, errors, `personal.entries[${index}]`);
  if (basis !== "user_said" && basis !== "inferred") errors.push(`personal.entries[${index}].basis 无效。`);
  if (confidence !== null && (confidence < 0 || confidence > 1)) errors.push(`personal.entries[${index}].confidence 须在 0..1。`);
  if (createdAt && !ISO_RE.test(createdAt)) errors.push(`personal.entries[${index}].createdAt 须 ISO。`);
  if (updatedAt && !ISO_RE.test(updatedAt)) errors.push(`personal.entries[${index}].updatedAt 须 ISO。`);
  if (entry.validFrom !== undefined && entry.validFrom !== null && typeof entry.validFrom !== "string") {
    errors.push(`personal.entries[${index}].validFrom 类型无效。`);
  }
  if (entry.supplements !== undefined) {
    if (!Array.isArray(entry.supplements)) errors.push(`personal.entries[${index}].supplements 必须是字符串数组。`);
    else if (entry.supplements.length > 20) errors.push(`personal.entries[${index}].supplements 过多。`);
    else {
      for (const s of entry.supplements) {
        if (typeof s !== "string" || s.length > 400) errors.push(`personal.entries[${index}].supplements 项无效。`);
      }
    }
  }
  validateEntrySource(entry.source, `personal.entries[${index}]`, errors);
  const seen = entry.seen;
  if (seen !== undefined && (typeof seen !== "number" || !Number.isFinite(seen) || seen < 0)) {
    errors.push(`personal.entries[${index}].seen 必须是非负数字。`);
  }
  if (text && detectSnapshotSecret(text)) errors.push(`personal.entries[${index}] 含疑似密钥。`);
  if (!id || !topic || !kind || !text || rev === null || confidence === null || !createdAt || !updatedAt) return null;
  if (basis !== "user_said" && basis !== "inferred") return null;
  return entry as unknown as AssistantMemoryEntry;
}

export type SnapshotValidateResult =
  | { ok: true; snapshot: MemoryCenterSnapshotV1; warnings: string[] }
  | { ok: false; errors: string[] };

export function stableSnapshotStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSnapshotStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSnapshotStringify(record[key])}`).join(",")}}`;
}

export function snapshotPayloadForChecksum(
  snapshot: Omit<MemoryCenterSnapshotV1, "manifest"> & {
    manifest: { checksum: ""; includedScopes: MemoryCenterSnapshotIncludedScopes };
  },
) {
  return stableSnapshotStringify(snapshot);
}

export function validateMemoryCenterSnapshotV1(raw: unknown, opts: { maxBytes?: number } = {}): SnapshotValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxBytes = opts.maxBytes ?? MEMORY_CENTER_SNAPSHOT_MAX_BYTES;
  if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, errors: ["快照超过大小上限。"] };
  }
  if (!isPlainObject(raw)) return { ok: false, errors: ["快照必须是 JSON 对象。"] };
  walkPlainObject(raw, "root", 0, errors);
  exactKeys(
    raw,
    ["schemaVersion", "exportedAt", "appVersion", "manifest", "personal", "workPreferences", "workspaces", "rulesInventory"],
    "root",
    errors,
  );
  if (raw.schemaVersion !== MEMORY_CENTER_SNAPSHOT_SCHEMA) {
    return { ok: false, errors: ["不支持的 schemaVersion。"] };
  }
  const exportedAt = reqString(raw, "exportedAt", 40, errors, "root");
  if (exportedAt && !ISO_RE.test(exportedAt)) errors.push("exportedAt 必须是 ISO 时间。");
  if (raw.appVersion !== undefined && typeof raw.appVersion !== "string") errors.push("appVersion 必须是字符串。");
  if (!isPlainObject(raw.manifest)) errors.push("manifest 必须是对象。");
  else {
    exactKeys(raw.manifest, ["checksum", "includedScopes"], "manifest", errors);
    const checksum = reqString(raw.manifest, "checksum", 80, errors, "manifest");
    if (checksum && !SHA256_RE.test(checksum)) errors.push("manifest.checksum 必须是 sha256 hex。");
    if (isPlainObject(raw.manifest.includedScopes)) {
      exactKeys(raw.manifest.includedScopes, ["personal", "workPreference", "personalSettings", "workspaceIds"], "manifest.includedScopes", errors);
      if (typeof raw.manifest.includedScopes.personal !== "boolean") errors.push("includedScopes.personal 必须是布尔。");
      if (typeof raw.manifest.includedScopes.workPreference !== "boolean") errors.push("includedScopes.workPreference 必须是布尔。");
      if (typeof raw.manifest.includedScopes.personalSettings !== "boolean") errors.push("includedScopes.personalSettings 必须是布尔。");
      if (!Array.isArray(raw.manifest.includedScopes.workspaceIds)) errors.push("includedScopes.workspaceIds 必须是数组。");
      else if (raw.manifest.includedScopes.workspaceIds.length > MEMORY_CENTER_SNAPSHOT_MAX_SCOPES) {
        errors.push("includedScopes.workspaceIds 过多。");
      } else {
        for (const id of raw.manifest.includedScopes.workspaceIds) {
          if (typeof id !== "string") errors.push("includedScopes.workspaceIds 项必须是字符串。");
          else validateScopeId(id, errors);
        }
      }
    } else errors.push("manifest.includedScopes 必须是对象。");
  }
  if (!isPlainObject(raw.personal)) errors.push("personal 必须是对象。");
  else {
    exactKeys(raw.personal, ["core", "settings", "entries"], "personal", errors);
    if (isPlainObject(raw.personal.core)) {
      exactKeys(raw.personal.core, ["rev", "fields", "updatedAt"], "personal.core", errors);
      reqNumber(raw.personal.core, "rev", errors, "personal.core");
      if (isPlainObject(raw.personal.core.fields)) {
        for (const key of Object.keys(raw.personal.core.fields)) {
          if (key === "工作偏好") errors.push("personal.core.fields 不得含工作偏好（请用 workPreferences）。");
          if (!CORE_FIELD_KEYS.includes(key as (typeof CORE_FIELD_KEYS)[number])) {
            if (!CORE_FIELD_KEYS_LEGACY.includes(key as (typeof CORE_FIELD_KEYS_LEGACY)[number])) {
              errors.push(`personal.core.fields 未知键：${key}`);
            }
          }
          const val = raw.personal.core.fields[key];
          if (typeof val !== "string") errors.push(`personal.core.fields.${key} 必须是字符串。`);
          else if (detectSnapshotSecret(val)) errors.push(`personal.core.fields.${key} 含疑似密钥。`);
        }
      } else errors.push("personal.core.fields 必须是对象。");
    }
    if (isPlainObject(raw.personal.settings)) {
      exactKeys(raw.personal.settings, ["paused", "allowSensitive"], "personal.settings", errors);
      if (typeof raw.personal.settings.paused !== "boolean") errors.push("personal.settings.paused 必须是布尔。");
      if (!isPlainObject(raw.personal.settings.allowSensitive)) errors.push("personal.settings.allowSensitive 必须是对象。");
      else {
        for (const [k, v] of Object.entries(raw.personal.settings.allowSensitive)) {
          if (FORBIDDEN_KEYS.has(k)) errors.push("allowSensitive 含非法键。");
          if (typeof v !== "boolean") errors.push(`allowSensitive.${k} 必须是布尔。`);
        }
      }
    }
    if (!Array.isArray(raw.personal.entries)) errors.push("personal.entries 必须是数组。");
    else if (raw.personal.entries.length > MEMORY_CENTER_SNAPSHOT_MAX_ENTRIES) errors.push("personal.entries 过多。");
  }
  if (!isPlainObject(raw.workPreferences)) errors.push("workPreferences 必须是对象。");
  else {
    exactKeys(raw.workPreferences, ["text", "checksum"], "workPreferences", errors);
    const wpText = reqString(raw.workPreferences, "text", MEMORY_CENTER_SNAPSHOT_MAX_TEXT, errors, "workPreferences");
    const wpChecksum = reqString(raw.workPreferences, "checksum", 80, errors, "workPreferences");
    if (wpText && detectSnapshotSecret(wpText)) errors.push("workPreferences.text 含疑似密钥。");
    if (wpChecksum && !SHA256_RE.test(wpChecksum)) errors.push("workPreferences.checksum 无效。");
  }
  if (!Array.isArray(raw.workspaces)) errors.push("workspaces 必须是数组。");
  else if (raw.workspaces.length > MEMORY_CENTER_SNAPSHOT_MAX_SCOPES) errors.push("workspaces 过多。");
  if (!Array.isArray(raw.rulesInventory)) errors.push("rulesInventory 必须是数组。");
  else if (raw.rulesInventory.length > MEMORY_CENTER_SNAPSHOT_MAX_RULES) errors.push("rulesInventory 过多。");

  const entries: AssistantMemoryEntry[] = [];
  const entryIds = new Set<string>();
  const personalObj = isPlainObject(raw.personal) ? raw.personal : null;
  if (personalObj && Array.isArray(personalObj.entries)) {
    for (let i = 0; i < personalObj.entries.length; i += 1) {
      const parsed = validatePersonalEntry(personalObj.entries[i], errors, i);
      if (parsed) {
        if (entryIds.has(parsed.id)) errors.push(`personal.entries id 重复：${parsed.id}`);
        entryIds.add(parsed.id);
        entries.push(parsed);
      }
    }
  }

  const workspaceScopes: MemoryCenterSnapshotWorkspaceScope[] = [];
  const scopeIds = new Set<string>();
  if (Array.isArray(raw.workspaces)) {
    for (let i = 0; i < raw.workspaces.length; i += 1) {
      const row = raw.workspaces[i];
      const path = `workspaces[${i}]`;
      if (!isPlainObject(row)) {
        errors.push(`${path} 必须是对象。`);
        continue;
      }
      exactKeys(row, ["scopeId", "memoryRaw", "memoryChecksum", "summary"], path, errors);
      const scopeId = reqString(row, "scopeId", 200, errors, path);
      const memoryRaw = reqString(row, "memoryRaw", MEMORY_CENTER_SNAPSHOT_MAX_TEXT, errors, path);
      const memoryChecksum = reqString(row, "memoryChecksum", 80, errors, path);
      if (scopeId && !validateScopeId(scopeId, errors)) continue;
      if (scopeId === "personal" || scopeId === "work_preference") errors.push(`${path} scopeId 保留。`);
      if (scopeId && scopeIds.has(scopeId)) errors.push(`workspaces scopeId 重复：${scopeId}`);
      if (scopeId) scopeIds.add(scopeId);
      if (memoryChecksum && !SHA256_RE.test(memoryChecksum)) errors.push(`${path}.memoryChecksum 无效。`);
      if (memoryRaw) validateMemoryLineLegal(memoryRaw, scopeId ?? path, errors);
      if (!isPlainObject(row.summary)) errors.push(`${path}.summary 必须是对象。`);
      else {
        exactKeys(row.summary, ["lineCount", "hot", "cold", "done", "pinned", "missingRefs"], `${path}.summary`, errors);
        for (const key of ["lineCount", "hot", "cold", "done", "pinned", "missingRefs"]) reqNumber(row.summary, key, errors, `${path}.summary`);
      }
      if (scopeId && memoryRaw && memoryChecksum) {
        workspaceScopes.push(row as unknown as MemoryCenterSnapshotWorkspaceScope);
      }
    }
  }

  const rules: MemoryCenterSnapshotRuleInventoryItem[] = [];
  if (Array.isArray(raw.rulesInventory)) {
    for (let i = 0; i < raw.rulesInventory.length; i += 1) {
      const row = raw.rulesInventory[i];
      const path = `rulesInventory[${i}]`;
      if (!isPlainObject(row)) {
        errors.push(`${path} 必须是对象。`);
        continue;
      }
      exactKeys(row, ["scope", "path", "chars", "checksum"], path, errors);
      const scope = reqString(row, "scope", 200, errors, path);
      const relPath = reqString(row, "path", 400, errors, path);
      reqNumber(row, "chars", errors, path);
      const checksum = reqString(row, "checksum", 80, errors, path);
      if (relPath && (ABS_PATH_RE.test(relPath) || relPath.includes(".."))) errors.push(`${path}.path 必须是相对路径。`);
      if (checksum && !SHA256_RE.test(checksum)) errors.push(`${path}.checksum 无效。`);
      if (scope && relPath && checksum) rules.push(row as unknown as MemoryCenterSnapshotRuleInventoryItem);
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > maxBytes) errors.push("快照超过大小上限。");

  if (errors.length) return { ok: false, errors };

  const snapshot = raw as unknown as MemoryCenterSnapshotV1;
  snapshot.personal.entries = entries;
  snapshot.workspaces = workspaceScopes;
  snapshot.rulesInventory = rules;

  const bodyForHash = {
    ...snapshot,
    manifest: { checksum: "" as const, includedScopes: snapshot.manifest.includedScopes },
  };
  const expected = snapshot.manifest.checksum;
  const actual = createHash("sha256").update(snapshotPayloadForChecksum(bodyForHash)).digest("hex");
  if (expected !== actual) errors.push("manifest.checksum 不匹配。");
  if (errors.length) return { ok: false, errors };

  for (const ws of workspaceScopes) {
    const lineChecksum = createHash("sha256").update(ws.memoryRaw, "utf8").digest("hex");
    if (lineChecksum !== ws.memoryChecksum) errors.push(`${ws.scopeId} memoryChecksum 不匹配。`);
  }
  const wpActual = createHash("sha256").update(snapshot.workPreferences.text, "utf8").digest("hex");
  if (wpActual !== snapshot.workPreferences.checksum) errors.push("workPreferences.checksum 不匹配。");

  if (errors.length) return { ok: false, errors };
  return { ok: true, snapshot, warnings };
}
