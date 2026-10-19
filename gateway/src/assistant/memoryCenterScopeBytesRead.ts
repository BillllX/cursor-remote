import * as fs from "node:fs";
import { constants, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { isInside } from "../pathInside.ts";
import { relPathHasSymlink, scopedReadSupported, scopedReadErrnoResult, openErrCode } from "./scopedRead.ts";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type ScopeBytesReadOk = { ok: true; buf: Buffer; bytes: number; sha256: string };
export type ScopeBytesReadFail = { ok: false; code: string; message: string };

function fdStatMatchesPath(fd: number, abs: string) {
  try {
    const lst = lstatSync(abs);
    const fst = fs.fstatSync(fd);
    return lst.isFile() && fst.isFile() && lst.dev === fst.dev && lst.ino === fst.ino;
  } catch {
    return false;
  }
}

/** 完整读取 scope 内文件字节，不 trim/clip；超过 maxBytes 返回 too_large。 */
export function readScopeFileBytes(scopeDir: string, rel: string, maxBytes: number): ScopeBytesReadOk | ScopeBytesReadFail {
  if (!scopedReadSupported()) {
    return { ok: false, code: "unsupported", message: "当前平台不支持安全读取。" };
  }
  if (relPathHasSymlink(scopeDir, rel)) {
    return { ok: false, code: "symlink", message: "路径上存在符号链接。" };
  }
  let scopeReal: string;
  try {
    scopeReal = realpathSync(scopeDir);
  } catch {
    return { ok: false, code: "scope", message: "无法解析作用域目录。" };
  }
  const abs = resolve(scopeReal, rel);
  if (!isInside(abs, scopeReal)) return { ok: false, code: "escape", message: "路径越界。" };
  let fd: number;
  try {
    fd = fs.openSync(abs, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const mapped = scopedReadErrnoResult(openErrCode(err));
    return { ok: false, code: mapped.code, message: mapped.message };
  }
  try {
    if (!fdStatMatchesPath(fd, abs)) {
      return { ok: false, code: "inode_mismatch", message: "打开后 inode 与路径不一致。" };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: "not_file", message: "不是普通文件。" };
    const size = Number(st.size);
    if (size > maxBytes) return { ok: false, code: "too_large", message: "文件超过剩余预算。" };
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buf, offset, size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== size) return { ok: false, code: "read_failed", message: "读取不完整。" };
    return { ok: true, buf, bytes: size, sha256: createHash("sha256").update(buf).digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

export function bufferToMemoryRawUtf8(buf: Buffer): { ok: true; text: string } | { ok: false; message: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { ok: true, text };
  } catch {
    return { ok: false, message: "memory 不是合法 UTF-8。" };
  }
}
