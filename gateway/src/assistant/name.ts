import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ASSISTANT_NAME } from "../../../shared/protocol.ts";

const cache = new Map<string, { mtime: number; name: string }>();

/** 去掉控制字符和换行，最长 16 个字符；空或不合法回退默认名 */
export function sanitizeAssistantName(raw: string | undefined | null): string {
  const value = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, "")
    .trim();
  if (!value || [...value].length > 16 || /[<>`{}]/.test(value)) return DEFAULT_ASSISTANT_NAME;
  return value;
}

/** 从 USER 根目录 AGENTS.md 读助理名字：front matter 的 name:，或正文里“名字：…”一行 */
export function parseAssistantName(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) {
    const line = /^name\s*:\s*(.+)$/im.exec(front[1]);
    if (line) return sanitizeAssistantName(line[1]);
  }
  const body = /^\s*(?:[-*]\s*)?名字\s*[:：]\s*(.+)$/m.exec(text);
  if (body) return sanitizeAssistantName(body[1]);
  return DEFAULT_ASSISTANT_NAME;
}

export function assistantNameFor(workspaceRoot: string): string {
  const file = resolve(workspaceRoot, "AGENTS.md");
  try {
    const mtime = statSync(file).mtimeMs;
    const known = cache.get(file);
    if (known && known.mtime === mtime) return known.name;
    const name = parseAssistantName(readFileSync(file, "utf8").slice(0, 20_000));
    cache.set(file, { mtime, name });
    return name;
  } catch {
    return DEFAULT_ASSISTANT_NAME;
  }
}
