import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export type AtomicWriteOptions = {
  /** 新文件权限；临时文件总是新建，所以每次都生效（仍受 umask 影响） */
  mode?: number;
  /** data 是字符串时的编码，默认 utf8 */
  encoding?: BufferEncoding;
  /** 先 mkdir -p 父目录 */
  mkdir?: boolean;
  /** rename 前 fsync 临时文件；不 fsync 时断电可能留下空文件 */
  fsync?: boolean;
};

/**
 * 同目录临时文件 + rename 整体替换：读者要么看到旧内容要么看到新内容。
 * 临时文件名带 pid 和随机串，同进程并发或多进程同写一个文件时互不覆盖。
 * 失败时尽力删掉临时文件，再抛出原错误。
 */
export function atomicWriteFileSync(
  file: string,
  data: string | NodeJS.ArrayBufferView,
  opts: AtomicWriteOptions = {},
): void {
  if (opts.mkdir) mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    if (opts.fsync) {
      const fd = openSync(tmp, "w", opts.mode);
      try {
        writeFileSync(fd, data, { encoding: opts.encoding });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      writeFileSync(tmp, data, { mode: opts.mode, encoding: opts.encoding });
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没建出来（目录不存在、权限），原错误更有用
    }
    throw err;
  }
}
