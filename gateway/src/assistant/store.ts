import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * 个人助理数据：全部在租户状态目录 assistant/ 下，网关是唯一写者。
 * 读改写都是同步调用，Node 单线程下天然串行；写入先落临时文件再 rename。
 */

export type TenantRef = { id: string; stateDir: string };

export function assistantDir(ref: TenantRef) {
  return resolve(ref.stateDir, "assistant");
}

export function assistantPath(ref: TenantRef, ...parts: string[]) {
  return resolve(assistantDir(ref), ...parts);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, file);
}

export function appendJsonl(file: string, row: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function readJsonl<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((row): row is T => row !== null);
  } catch {
    return [];
  }
}

export function writeJsonl(file: string, rows: unknown[]) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  renameSync(tmp, file);
}

export function removePath(file: string) {
  rmSync(file, { recursive: true, force: true });
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 粗估 token：中日韩字符约 0.7 个，其余按 4 个字符 1 个。只用于预算排序。 */
export function estimateTokens(text: string) {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk += 1;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 0.7 + rest / 4);
}

export function clip(text: string, max: number) {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
