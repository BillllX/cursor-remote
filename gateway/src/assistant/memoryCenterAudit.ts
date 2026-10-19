import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MemoryCenterActivityAction,
  MemoryCenterActivityEntry,
  MemoryCenterAuditSnapshot,
} from "../../../shared/protocol.ts";
import { atomicWriteFileSync } from "../fsAtomic.ts";
import { insertLineInSectionLines } from "./memoryFileEdit.ts";
import { indexMemoryRowsFromLines } from "./memoryCenterMutateShared.ts";
import { memoryLineRevision } from "./memoryRevision.ts";
import { newId } from "./store.ts";
import { parseMemoryFile, type MemoryLine, type SafeMemoryPaths } from "./workspaceMemory.ts";

export const MEMORY_AUDIT_FILE = "memory-audit.jsonl";
export const AUDIT_RETENTION_COUNT = 2000;
export const AUDIT_RETENTION_BYTES = 5 * 1024 * 1024;
export const AUDIT_MAX_LINE_BYTES = 64_000;
export const AUDIT_MAX_READ_BYTES = 512_000;
export const ACTIVITY_DEFAULT_LIMIT = 40;
export const ACTIVITY_MAX_LIMIT = 100;

export type AuditRetentionLimits = { count: number; bytes: number };
let retentionLimits: AuditRetentionLimits = { count: AUDIT_RETENTION_COUNT, bytes: AUDIT_RETENTION_BYTES };

export function setAuditRetentionLimitsForTest(limits: AuditRetentionLimits | null) {
  retentionLimits = limits ?? { count: AUDIT_RETENTION_COUNT, bytes: AUDIT_RETENTION_BYTES };
}

export type AuditWriterTestHooks = { failAppend?: boolean; failRotate?: boolean };
let auditWriterHooks: AuditWriterTestHooks = {};

export function setMemoryCenterAuditWriterHooksForTest(hooks: AuditWriterTestHooks | null) {
  auditWriterHooks = hooks ?? {};
}

export type StoredAuditRecord = {
  auditId: string;
  scope: string;
  itemId: string;
  action: MemoryCenterActivityAction;
  actor: "user" | "maintenance";
  at: string;
  before?: MemoryCenterAuditSnapshot;
  after?: MemoryCenterAuditSnapshot;
  rowHint?: number;
};

export function auditFilePath(paths: SafeMemoryPaths) {
  return resolve(paths.jiebo, MEMORY_AUDIT_FILE);
}

export function lineToAuditSnapshot(line: MemoryLine, rawLine: string, rowHint?: number): MemoryCenterAuditSnapshot {
  return {
    line: {
      id: line.id ?? null,
      section: line.section,
      text: line.text,
      refs: [...line.refs],
      from: line.from ?? null,
      at: line.at ?? null,
      pinned: line.pinned,
      state: line.state ?? null,
      used: line.used ?? null,
      uses: line.uses ?? null,
      expires: line.expires ?? null,
      meta: line.meta ? { ...line.meta } : undefined,
      metaOrder: line.metaOrder ? [...line.metaOrder] : undefined,
    },
    rawLine,
    rowHint,
    revision: memoryLineRevision(line),
  };
}

export function snapshotToMemoryLine(snap: MemoryCenterAuditSnapshot): MemoryLine {
  const l = snap.line;
  return {
    section: l.section,
    text: l.text,
    id: l.id ?? undefined,
    refs: [...l.refs],
    from: l.from ?? undefined,
    at: l.at ?? undefined,
    pinned: l.pinned,
    state: l.state ?? undefined,
    used: l.used ?? undefined,
    uses: l.uses ?? undefined,
    expires: l.expires ?? undefined,
    meta: l.meta ? { ...l.meta } : undefined,
    metaOrder: l.metaOrder ? [...l.metaOrder] : undefined,
  };
}

type ReadAuditResult = {
  records: StoredAuditRecord[];
  corruptLines: number;
  truncated: boolean;
  bytesRead: number;
};

function readFileTailUtf8(file: string, maxBytes: number): { text: string; truncated: boolean; bytesRead: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { text: "", truncated: false, bytesRead: 0 };
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, start);
    let text = buf.toString("utf8");
    const truncated = size > maxBytes;
    if (truncated) {
      const cut = text.indexOf("\n");
      text = cut >= 0 ? text.slice(cut + 1) : "";
    }
    return { text, truncated, bytesRead: readLen };
  } finally {
    closeSync(fd);
  }
}

const AUDIT_ACTIONS = new Set<MemoryCenterActivityAction>([
  "create",
  "update",
  "set_state",
  "set_pinned",
  "delete",
  "restore",
  "import",
]);

function normalizeSnapshot(raw: unknown): MemoryCenterAuditSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as MemoryCenterAuditSnapshot;
  if (!row.revision || typeof row.rawLine !== "string" || !row.line || typeof row.line !== "object") return undefined;
  if (typeof row.line.section !== "string" || typeof row.line.text !== "string") return undefined;
  if (!Array.isArray(row.line.refs)) return undefined;
  return row;
}

function snapshotSidePresent(raw: unknown, normalized: MemoryCenterAuditSnapshot | undefined): "absent" | "ok" | "malformed" {
  if (raw === undefined || raw === null) return "absent";
  return normalized ? "ok" : "malformed";
}

function parseLineFromSnapshotRaw(snap: MemoryCenterAuditSnapshot): MemoryLine | null {
  const parsed = parseMemoryFile(`# 工作区记忆\n## ${snap.line.section}\n${snap.rawLine}\n`);
  if (parsed.length !== 1) return null;
  return parsed[0]!;
}

function snapshotIdentityMatches(snap: MemoryCenterAuditSnapshot, itemId: string): boolean {
  const lineId = snap.line.id;
  if (lineId != null && lineId !== itemId) return false;
  const fromRaw = parseLineFromSnapshotRaw(snap);
  if (!fromRaw) return false;
  if (fromRaw.id && fromRaw.id !== itemId) return false;
  if (!fromRaw.id && lineId != null && lineId !== itemId) return false;
  if (memoryLineRevision(fromRaw) !== snap.revision) return false;
  if (fromRaw.section !== snap.line.section) return false;
  if (fromRaw.text !== snap.line.text) return false;
  return true;
}

/** 集中校验审计记录快照形状与 rawLine 一致性；读取 / activity / restore 共用。 */
export function validateAuditSnapshotShape(
  record: StoredAuditRecord,
): { ok: true } | { ok: false; reason: string } {
  if (!AUDIT_ACTIONS.has(record.action)) {
    return { ok: false, reason: "未知审计 action。" };
  }
  if (!record.itemId || !record.auditId || !record.scope) {
    return { ok: false, reason: "审计缺少必要字段。" };
  }

  const beforeSide = snapshotSidePresent(record.before, record.before);
  const afterSide = snapshotSidePresent(record.after, record.after);
  if (beforeSide === "malformed" || afterSide === "malformed") {
    return { ok: false, reason: "快照 JSON 结构损坏。" };
  }
  const hasBefore = beforeSide === "ok";
  const hasAfter = afterSide === "ok";

  switch (record.action) {
    case "create":
      if (hasBefore) return { ok: false, reason: "create 审计不应含 before。" };
      if (!hasAfter) return { ok: false, reason: "create 审计缺少 after。" };
      break;
    case "delete":
      if (!hasBefore) return { ok: false, reason: "delete 审计缺少 before。" };
      if (hasAfter) return { ok: false, reason: "delete 审计不应含 after。" };
      break;
    case "update":
    case "set_state":
    case "set_pinned":
      if (!hasBefore || !hasAfter) {
        return { ok: false, reason: `${record.action} 审计须同时含 before 与 after。` };
      }
      break;
    case "restore":
      if (!hasBefore && !hasAfter) {
        return { ok: false, reason: "restore 审计至少须含 before 或 after 一侧。" };
      }
      break;
    case "import":
      if (!hasAfter) return { ok: false, reason: "import 审计缺少 after。" };
      break;
    default:
      return { ok: false, reason: "未知审计 action。" };
  }

  if (hasBefore && record.before && !snapshotIdentityMatches(record.before, record.itemId)) {
    return { ok: false, reason: "before 快照与 itemId/rawLine 不一致。" };
  }
  if (hasAfter && record.after && !snapshotIdentityMatches(record.after, record.itemId)) {
    return { ok: false, reason: "after 快照与 itemId/rawLine 不一致。" };
  }

  return { ok: true };
}

export function isAuditRecordShapeValid(record: StoredAuditRecord): boolean {
  return validateAuditSnapshotShape(record).ok;
}

/** 从文件尾向前读，抗损坏行；有字节/行数上限。 */
export function readAuditRecords(file: string, opts: { maxBytes?: number; maxRecords?: number } = {}): ReadAuditResult {
  const maxBytes = opts.maxBytes ?? AUDIT_MAX_READ_BYTES;
  const maxRecords = opts.maxRecords ?? retentionLimits.count;
  if (!existsSync(file)) return { records: [], corruptLines: 0, truncated: false, bytesRead: 0 };
  let raw = "";
  let truncated = false;
  let bytesRead = 0;
  try {
    const tail = readFileTailUtf8(file, maxBytes);
    raw = tail.text;
    truncated = tail.truncated;
    bytesRead = tail.bytesRead;
  } catch {
    return { records: [], corruptLines: 0, truncated: false, bytesRead: 0 };
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const records: StoredAuditRecord[] = [];
  let corruptLines = 0;
  for (let i = lines.length - 1; i >= 0 && records.length < maxRecords; i -= 1) {
    const line = lines[i];
    if (Buffer.byteLength(line, "utf8") > AUDIT_MAX_LINE_BYTES) {
      corruptLines += 1;
      continue;
    }
    try {
      const parsed = JSON.parse(line) as StoredAuditRecord & { before?: unknown; after?: unknown };
      if (!parsed.auditId || !parsed.scope || !parsed.itemId || !parsed.action || !parsed.at) {
        corruptLines += 1;
        continue;
      }
      if (!AUDIT_ACTIONS.has(parsed.action as MemoryCenterActivityAction)) {
        corruptLines += 1;
        continue;
      }
      if (parsed.actor !== "user" && parsed.actor !== "maintenance") {
        corruptLines += 1;
        continue;
      }
      const rawBefore = parsed.before;
      const rawAfter = parsed.after;
      const row: StoredAuditRecord = {
        auditId: parsed.auditId,
        scope: parsed.scope,
        itemId: parsed.itemId,
        action: parsed.action as MemoryCenterActivityAction,
        actor: parsed.actor,
        at: parsed.at,
        rowHint: parsed.rowHint,
        before: normalizeSnapshot(rawBefore),
        after: normalizeSnapshot(rawAfter),
      };
      if (rawBefore !== undefined && rawBefore !== null && !row.before) {
        corruptLines += 1;
        continue;
      }
      if (rawAfter !== undefined && rawAfter !== null && !row.after) {
        corruptLines += 1;
        continue;
      }
      if (!validateAuditSnapshotShape(row).ok) {
        corruptLines += 1;
        records.push(row);
        continue;
      }
      records.push(row);
    } catch {
      corruptLines += 1;
    }
  }
  records.reverse();
  return { records, corruptLines, truncated, bytesRead };
}

function writeAuditRecordsAtomic(
  file: string,
  records: StoredAuditRecord[],
  writeFile?: (path: string, data: string | Buffer, mode?: number) => void,
) {
  if (auditWriterHooks.failRotate) throw new Error("audit rotate injected failure");
  let kept = records;
  let body = kept.map((row) => JSON.stringify(row)).join("\n");
  if (kept.length > retentionLimits.count) {
    kept = kept.slice(-retentionLimits.count);
    body = kept.map((row) => JSON.stringify(row)).join("\n");
  }
  while (Buffer.byteLength(body, "utf8") > retentionLimits.bytes && kept.length > 1) {
    kept = kept.slice(1);
    body = kept.map((row) => JSON.stringify(row)).join("\n");
  }
  const payload = body.length ? `${body}\n` : "";
  if (writeFile) writeFile(file, payload);
  else atomicWriteFileSync(file, payload, { mkdir: true });
  return { dropped: records.length - kept.length, finalCount: kept.length };
}

/** 在 memory 文件锁内追加审计；失败抛错供调用方补偿 memory。 */
export function appendAuditRecord(
  paths: SafeMemoryPaths,
  record: Omit<StoredAuditRecord, "auditId"> & { auditId?: string },
  writeFile?: (path: string, data: string | Buffer, mode?: number) => void,
) {
  if (auditWriterHooks.failAppend) throw new Error("audit append injected failure");
  const file = auditFilePath(paths);
  const auditId = record.auditId ?? newId("aud");
  const row: StoredAuditRecord = { ...record, auditId };
  const shape = validateAuditSnapshotShape(row);
  if (!shape.ok) throw new Error(`audit shape invalid: ${shape.reason}`);
  const line = JSON.stringify(row);
  if (Buffer.byteLength(line, "utf8") > AUDIT_MAX_LINE_BYTES) {
    throw new Error("audit line too large");
  }
  const existing = readAuditRecords(file, { maxBytes: retentionLimits.bytes, maxRecords: retentionLimits.count + 50 });
  writeAuditRecordsAtomic(file, [...existing.records, row], writeFile);
  return auditId;
}

export function findAuditRecord(paths: SafeMemoryPaths, scopeId: string, auditId: string): StoredAuditRecord | null {
  const { records } = readAuditRecords(auditFilePath(paths), {
    maxBytes: retentionLimits.bytes,
    maxRecords: retentionLimits.count,
  });
  const hit = records.find((row) => row.auditId === auditId && row.scope === scopeId);
  return hit ?? null;
}

export function latestAuditForItem(records: StoredAuditRecord[], itemId: string): StoredAuditRecord | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].itemId === itemId) return records[i];
  }
  return null;
}

export function memoryMatchesSnapshot(memoryLines: MemoryLine[], itemId: string, snap?: MemoryCenterAuditSnapshot): boolean {
  const hit = memoryLines.find((line) => line.id === itemId);
  if (!snap) return !hit;
  if (!hit) return false;
  return memoryLineRevision(hit) === snap.revision;
}

export function canRestoreAudit(
  record: StoredAuditRecord,
  allRecords: StoredAuditRecord[],
  memoryLines: MemoryLine[],
): { ok: true } | { ok: false; reason: string } {
  const shape = validateAuditSnapshotShape(record);
  if (!shape.ok) return shape;
  const latest = latestAuditForItem(allRecords, record.itemId);
  if (!latest || latest.auditId !== record.auditId) {
    return { ok: false, reason: "已有更新的变更覆盖此记录。" };
  }
  if (record.after) {
    if (!memoryMatchesSnapshot(memoryLines, record.itemId, record.after)) {
      return { ok: false, reason: "当前记忆状态与审计 after 不一致。" };
    }
    return { ok: true };
  }
  if (memoryLines.some((line) => line.id === record.itemId)) {
    return { ok: false, reason: "条目仍存在，无法回滚。" };
  }
  if (!record.before) {
    return { ok: false, reason: "审计缺少 before 快照。" };
  }
  return { ok: true };
}

export function applyRollbackToLines(
  lines: string[],
  record: StoredAuditRecord,
  memoryLines?: MemoryLine[],
): { itemId: string; deletedId?: string } {
  const indexed = indexMemoryRowsFromLines(lines);
  const itemId = record.itemId;
  const mem = memoryLines ?? parseMemoryFile(lines.join("\n"));
  if (record.after && memoryMatchesSnapshot(mem, itemId, record.after)) {
    const before = record.before;
    if (!before) {
      const target = indexed.find((row) => row.line.id === itemId);
      if (!target) throw new Error("rollback target missing");
      lines.splice(target.row, 1);
      return { itemId, deletedId: itemId };
    }
    const raw = before.rawLine;
    const hint = before.rowHint ?? record.rowHint;
    const existing = indexed.find((row) => row.line.id === itemId);
    if (existing) {
      lines[existing.row] = raw;
    } else if (typeof hint === "number" && hint >= 0 && hint <= lines.length) {
      lines.splice(hint, 0, raw);
    } else {
      insertLineInSectionLines(lines, before.line.section, raw);
    }
    return { itemId };
  }
  if (!record.after && !mem.some((line) => line.id === itemId) && record.before) {
    const before = record.before;
    const raw = before.rawLine;
    const hint = before.rowHint ?? record.rowHint;
    const existing = indexed.find((row) => row.line.id === itemId);
    if (existing) {
      lines[existing.row] = raw;
    } else if (typeof hint === "number" && hint >= 0 && hint <= lines.length) {
      lines.splice(hint, 0, raw);
    } else {
      insertLineInSectionLines(lines, before.line.section, raw);
    }
    return { itemId };
  }
  const before = record.before;
  if (!before) {
    const target = indexed.find((row) => row.line.id === itemId);
    if (!target) throw new Error("rollback target missing");
    lines.splice(target.row, 1);
    return { itemId, deletedId: itemId };
  }
  const raw = before.rawLine;
  const hint = before.rowHint ?? record.rowHint;
  const existing = indexed.find((row) => row.line.id === itemId);
  if (existing) {
    lines[existing.row] = raw;
  } else if (typeof hint === "number" && hint >= 0 && hint <= lines.length) {
    lines.splice(hint, 0, raw);
  } else {
    insertLineInSectionLines(lines, before.line.section, raw);
  }
  return { itemId };
}

const CURSOR_SEP = "\x1e";

export function encodeActivityCursor(scope: string, auditId: string, at: string) {
  return Buffer.from(`${scope}${CURSOR_SEP}${at}${CURSOR_SEP}${auditId}`, "utf8").toString("base64url");
}

export function decodeActivityCursor(cursor: string): { scope: string; at: string; auditId: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parts = raw.split(CURSOR_SEP);
    if (parts.length !== 3) return null;
    const [scope, at, auditId] = parts;
    if (!scope || !at || !auditId) return null;
    return { scope, at, auditId };
  } catch {
    return null;
  }
}

export type ActivitySortRow = { at: string; scope: string; auditId: string };

export function compareActivityDesc(a: ActivitySortRow, b: ActivitySortRow): number {
  if (a.at !== b.at) return b.at.localeCompare(a.at);
  if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
  return b.auditId.localeCompare(a.auditId);
}

export function startIndexAfterActivityCursor<T extends { at: string; scope: string; entry: { auditId: string } }>(
  merged: T[],
  cursor: string | undefined,
): number {
  if (!cursor) return 0;
  const decoded = decodeActivityCursor(cursor);
  if (!decoded) return 0;
  const exact = merged.findIndex(
    (row) => row.at === decoded.at && row.scope === decoded.scope && row.entry.auditId === decoded.auditId,
  );
  if (exact >= 0) return exact + 1;
  const c: ActivitySortRow = { at: decoded.at, scope: decoded.scope, auditId: decoded.auditId };
  for (let i = 0; i < merged.length; i += 1) {
    const r: ActivitySortRow = { at: merged[i].at, scope: merged[i].scope, auditId: merged[i].entry.auditId };
    if (compareActivityDesc(r, c) > 0) return i;
  }
  return merged.length;
}

function summarizeSnapshot(snap?: MemoryCenterAuditSnapshot) {
  if (!snap) return undefined;
  return {
    id: snap.line.id ?? null,
    section: snap.line.section,
    text: snap.line.text.length > 120 ? `${snap.line.text.slice(0, 120)}…` : snap.line.text,
    revision: snap.revision,
    state: snap.line.state ?? null,
    pinned: snap.line.pinned,
  };
}

export function toActivityEntry(
  record: StoredAuditRecord,
  memoryLines: MemoryLine[],
  allRecords: StoredAuditRecord[],
  degraded?: boolean,
): MemoryCenterActivityEntry {
  const shape = validateAuditSnapshotShape(record);
  const gate = shape.ok ? canRestoreAudit(record, allRecords, memoryLines) : shape;
  return {
    auditId: record.auditId,
    scope: record.scope,
    itemId: record.itemId,
    action: record.action,
    actor: record.actor,
    at: record.at,
    before: record.before ? summarizeSnapshot(record.before) : undefined,
    after: record.after ? summarizeSnapshot(record.after) : undefined,
    canRestore: shape.ok && gate.ok,
    restoreBlockedReason: gate.ok ? undefined : gate.reason,
    degraded: degraded || !shape.ok ? true : undefined,
  };
}

export function stableSuggestionId(parts: Record<string, unknown>) {
  const payload = JSON.stringify(parts);
  return createHash("sha256").update(payload).digest("hex").slice(0, 20);
}

export function findIndexedRow(lines: string[], itemId: string) {
  return indexMemoryRowsFromLines(lines).find((row) => row.line.id === itemId);
}
