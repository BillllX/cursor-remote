import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { isInside } from "../pathInside.ts";
import { MEMORY_CENTER_SNAPSHOT_MAX_BYTES } from "../../../shared/memoryCenterSnapshot.ts";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ALLOWED_PREFIXES = [".jiebo/memory-export/", ".jiebo/memory-import/"] as const;

export type SafeJieboReadOk = { ok: true; bytes: Buffer; relativePath: string; sha256: string };
export type SafeJieboReadFail = { ok: false; code: string; message: string };

function normalizeRelativePath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\0")) return null;
  if (!trimmed.endsWith(".json")) return null;
  if (!ALLOWED_PREFIXES.some((prefix) => trimmed === prefix.slice(0, -1) || trimmed.startsWith(prefix))) return null;
  return trimmed;
}

export function readSnapshotJsonFromUserRoot(userRoot: string, pathInput: string): SafeJieboReadOk | SafeJieboReadFail {
  const rel = normalizeRelativePath(pathInput);
  if (!rel) return { ok: false, code: "invalid_path", message: "路径不在允许目录或格式不对。" };
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(userRoot));
  } catch {
    return { ok: false, code: "invalid_path", message: "无法解析 USER 根目录。" };
  }
  const abs = resolve(rootReal, rel);
  if (!isInside(abs, rootReal)) return { ok: false, code: "invalid_path", message: "路径越界。" };
  let walk = rootReal;
  for (const part of rel.split("/").slice(0, -1)) {
    walk = resolve(walk, part);
    try {
      const st = lstatSync(walk);
      if (st.isSymbolicLink()) {
        return { ok: false, code: "symlink", message: "路径含符号链接。" };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      return { ok: false, code: "read_failed", message: "无法检查路径。" };
    }
  }
  try {
    const parent = resolve(abs, "..");
    const pst = lstatSync(parent);
    if (pst.isSymbolicLink()) {
      return { ok: false, code: "symlink", message: "父目录是符号链接。" };
    }
  } catch {
    return { ok: false, code: "read_failed", message: "无法检查父目录。" };
  }
  if (O_NOFOLLOW === 0) return { ok: false, code: "unsupported", message: "当前平台不支持安全读取。" };
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, code: "not_found", message: "文件不存在。" };
    if (code === "ELOOP") return { ok: false, code: "symlink", message: "不允许符号链接。" };
    return { ok: false, code: "read_failed", message: "无法打开文件。" };
  }
  try {
    let fdPath: string;
    try {
      fdPath = realpathSync(abs);
    } catch {
      return { ok: false, code: "read_failed", message: "无法解析文件路径。" };
    }
    if (!isInside(fdPath, rootReal)) return { ok: false, code: "invalid_path", message: "realpath 越界。" };
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: "invalid_path", message: "不是普通文件。" };
    if (st.size > MEMORY_CENTER_SNAPSHOT_MAX_BYTES) {
      return { ok: false, code: "size_limit", message: "文件超过 20MB。" };
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, null);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== st.size) return { ok: false, code: "read_failed", message: "读取不完整。" };
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return { ok: true, bytes: buf, relativePath: rel, sha256 };
  } finally {
    closeSync(fd);
  }
}
