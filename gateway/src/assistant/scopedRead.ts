import * as fs from "node:fs";
import { constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isInside } from "../pathInside.ts";

export type ScopedReadResult =
  | { ok: true; text: string; bytes: number; truncated: boolean; invalidUtf8?: boolean }
  | { ok: false; code: string; message: string };

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** 记忆中心安全读取仅 Linux 启用；其它平台 fail closed。 */
export function scopedReadPlatformAllowed(platform: NodeJS.Platform = process.platform) {
  return platform === "linux";
}

/** Linux 且内核支持 O_NOFOLLOW。 */
export function scopedReadSupported(platform: NodeJS.Platform = process.platform) {
  return scopedReadPlatformAllowed(platform) && O_NOFOLLOW !== 0;
}

export function isSymlinkPath(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

function normalizeRel(rel: string) {
  const normalized = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.split("/").some((part) => !part || part === ".")) {
    return null;
  }
  return normalized;
}

function decodeUtf8(buf: Buffer) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), invalidUtf8: false };
  } catch {
    return { text: buf.toString("utf8"), invalidUtf8: true };
  }
}

function fdRealPath(fd: number) {
  try {
    return realpathSync(readlinkSync(`/proc/self/fd/${fd}`));
  } catch {
    return null;
  }
}

export function openErrCode(err: unknown) {
  return (err as NodeJS.ErrnoException).code ?? "open";
}

/** 将 open(2) errno 映射为 ScopedReadResult 错误（单测用 mock 不可控时的契约断言）。 */
export function scopedReadErrnoResult(code: string): Extract<ScopedReadResult, { ok: false }> {
  if (code === "ENOENT") return { ok: false, code: "enoent", message: "文件不存在。" };
  if (code === "ELOOP") return { ok: false, code: "symlink", message: "不允许读取符号链接文件。" };
  if (code === "EACCES" || code === "EPERM") return { ok: false, code: "eacces", message: "没有读取权限。" };
  if (code === "EIO") return { ok: false, code: "eio", message: "读取 I/O 错误。" };
  return { ok: false, code: "open", message: "无法打开文件。" };
}

/** scope 到相对路径的每一级（含中间目录与最终文件）不得为 symlink。 */
export function relPathHasSymlink(scopeDir: string, rel: string) {
  const normalized = normalizeRel(rel);
  if (!normalized) return true;
  let scopeReal: string;
  try {
    scopeReal = realpathSync(scopeDir);
  } catch {
    return true;
  }
  const parts = normalized.split("/");
  let cur = scopeReal;
  for (let i = 0; i < parts.length; i += 1) {
    cur = resolve(cur, parts[i]!);
    if (isSymlinkPath(cur)) return true;
    if (i < parts.length - 1) {
      try {
        if (!lstatSync(cur).isDirectory()) return true;
      } catch {
        return true;
      }
    }
  }
  return !isInside(cur, scopeReal);
}

/**
 * 在 scope 内相对路径打开 regular 文件：O_NOFOLLOW + fstat + /proc/self/fd 复核 + 分块硬上限。
 */
export function readFileAtScope(scopeDir: string, rel: string, maxBytes: number): ScopedReadResult {
  if (!scopedReadSupported()) {
    return { ok: false, code: "unsupported", message: "记忆中心安全读取仅支持 Linux。" };
  }
  const normalized = normalizeRel(rel);
  if (!normalized) return { ok: false, code: "bad_rel", message: "相对路径不合法。" };
  let scopeReal: string;
  try {
    scopeReal = realpathSync(scopeDir);
  } catch {
    return { ok: false, code: "scope", message: "无法解析作用域目录。" };
  }
  if (relPathHasSymlink(scopeDir, normalized)) {
    return { ok: false, code: "symlink", message: "路径上存在符号链接。" };
  }
  const abs = resolve(scopeReal, normalized);
  if (!isInside(abs, scopeReal)) return { ok: false, code: "escape", message: "路径越界。" };
  let fd: number;
  try {
    fd = fs.openSync(abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    return scopedReadErrnoResult(openErrCode(err));
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: "not_file", message: "不是普通文件。" };
    const fdPath = fdRealPath(fd);
    if (fdPath && !isInside(fdPath, scopeReal)) {
      return { ok: false, code: "escape", message: "打开后路径越界。" };
    }
    const size = Number(st.size);
    if (!Number.isFinite(size) || size < 0) return { ok: false, code: "stat", message: "无法读取文件大小。" };
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    const { text, invalidUtf8 } = decodeUtf8(buf.subarray(0, offset));
    return {
      ok: true,
      text: text.trim(),
      bytes: size,
      truncated: size > maxBytes,
      invalidUtf8,
    };
  } finally {
    fs.closeSync(fd);
  }
}
