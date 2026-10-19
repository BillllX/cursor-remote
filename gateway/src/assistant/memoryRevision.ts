import { createHash } from "node:crypto";
import type { MemoryLine } from "./workspaceMemory.ts";

/** 基于可编辑内容与元数据的稳定 revision（不含 mtime / used / uses）。 */
export function memoryLineRevision(line: MemoryLine): string {
  const meta =
    line.meta && Object.keys(line.meta).length
      ? Object.fromEntries(Object.keys(line.meta).sort().map((key) => [key, line.meta![key]]))
      : {};
  const payload = JSON.stringify({
    section: line.section,
    text: line.text,
    refs: [...line.refs].sort(),
    pinned: Boolean(line.pinned),
    state: line.state ?? null,
    expires: line.expires ?? null,
    meta,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function personalMemoryRevision(input: { id: string; rev: number; topic: string; text: string }): string {
  const payload = JSON.stringify({ id: input.id, rev: input.rev, topic: input.topic, text: input.text });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function workPreferenceRevision(text: string, index: number): string {
  const payload = JSON.stringify({ index, text });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
