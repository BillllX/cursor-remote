import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DeviceOp, DeviceStatus, JSONValue } from "../../../shared/protocol.ts";
import { atomicWriteFileSync } from "../fsAtomic.ts";
import { assistantPath, type TenantRef } from "../assistant/store.ts";

export const DEVICE_AUDIT_FILE = "device-audit.jsonl";
export const DEVICE_AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const DEVICE_AUDIT_MAX_RECORDS = 2_000;

export type DeviceAuditRecord = {
  op: DeviceOp;
  actor: string;
  at: string;
  deviceHash: string;
  summary: Record<string, JSONValue>;
  status: DeviceStatus;
  /// 外部对象标识也可能含账号或设备侧信息，审计只留不可逆摘要。
  externalIdHash?: string;
};

export function hashDeviceId(deviceId: string) {
  return createHash("sha256").update(deviceId).digest("hex").slice(0, 20);
}

export function hashExternalId(externalId: string) {
  return createHash("sha256").update(externalId).digest("hex").slice(0, 20);
}

const stringField = (row: Record<string, JSONValue>, key: string) =>
  typeof row[key] === "string" ? (row[key] as string).slice(0, 128) : undefined;
const numberField = (row: Record<string, JSONValue>, key: string) =>
  typeof row[key] === "number" ? row[key] : undefined;

/** 只摘录允许落盘的结构字段，绝不复制标题、notes、查询词或联系人正文。 */
export function summarizeDeviceParams(op: DeviceOp, params: JSONValue): Record<string, JSONValue> {
  if (!params || Array.isArray(params) || typeof params !== "object") return {};
  const row = params as Record<string, JSONValue>;
  const summary: Record<string, JSONValue> = {};
  if (op === "calendar_events_list") {
    const start = stringField(row, "start");
    const end = stringField(row, "end");
    const limit = numberField(row, "limit");
    if (start) summary.start = start;
    if (end) summary.end = end;
    if (limit !== undefined) summary.limit = limit;
  } else if (op === "reminders_list") {
    if (typeof row.completed === "boolean") summary.completed = row.completed;
    const limit = numberField(row, "limit");
    if (limit !== undefined) summary.limit = limit;
  } else if (op === "contacts_search") {
    summary.queryLength = typeof row.query === "string" ? row.query.length : 0;
    const limit = numberField(row, "limit");
    if (limit !== undefined) summary.limit = limit;
  } else if (op === "mail_draft_open") {
    const count = (key: string) => (Array.isArray(row[key]) ? (row[key] as JSONValue[]).length : 0);
    summary.toCount = count("to");
    summary.ccCount = count("cc");
    summary.bccCount = count("bcc");
    summary.hasSubject = typeof row.subject === "string" && row.subject.length > 0;
    summary.hasBody = typeof row.body === "string" && row.body.length > 0;
  } else {
    const externalId = stringField(row, "id") ?? stringField(row, "externalId");
    summary.hasExternalId = Boolean(externalId);
    summary.hasTitle = typeof row.title === "string";
    summary.hasNotes = typeof row.notes === "string";
  }
  return summary;
}

export type DeviceAuditWriter = (ref: TenantRef, record: DeviceAuditRecord) => void;

/** 与记忆审计相同口径做计数/字节裁剪，单次原子重写避免半行。 */
export const writeDeviceAudit: DeviceAuditWriter = (ref, record) => {
  const file = assistantPath(ref, DEVICE_AUDIT_FILE);
  const existing = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-(DEVICE_AUDIT_MAX_RECORDS - 1))
    : [];
  const lines = [...existing, JSON.stringify(record)];
  while (lines.length > 1 && Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") > DEVICE_AUDIT_MAX_BYTES) {
    lines.shift();
  }
  atomicWriteFileSync(file, `${lines.join("\n")}\n`, { mkdir: true });
};
