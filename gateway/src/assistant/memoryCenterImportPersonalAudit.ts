import { existsSync, readFileSync } from "node:fs";
import { hashText, assistantPath, type TenantRef } from "./store.ts";
import type { MemoryActor } from "./memory.ts";
import { importAuthorityWriter, type ImportDurableWriter } from "./memoryCenterImportFileWriter.ts";

export function personalMemoryAuditPath(ref: TenantRef) {
  return assistantPath(ref, "memory-audit.jsonl");
}

export function appendPersonalMemoryAuditDurable(
  ref: TenantRef,
  row: { id: string; op: string; actor: MemoryActor; chatId?: string; text?: string },
  write: ImportDurableWriter = importAuthorityWriter(),
) {
  const path = personalMemoryAuditPath(ref);
  const payload = {
    at: new Date().toISOString(),
    id: row.id,
    op: row.op,
    actor: row.actor,
    chatId: row.chatId,
    hash: row.text ? hashText(row.text) : undefined,
  };
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${JSON.stringify(payload)}\n`;
  const next = existing.length ? (existing.endsWith("\n") ? existing : `${existing}\n`) + line : line;
  write(path, next);
}
