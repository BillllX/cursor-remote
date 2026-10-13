import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir as mkdirAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

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

/** atomicWriteFileSync 的异步版：不阻塞事件循环，语义相同（同目录临时文件 + rename） */
export async function atomicWriteFile(
  file: string,
  data: string | NodeJS.ArrayBufferView,
  opts: Pick<AtomicWriteOptions, "mkdir" | "encoding"> = {},
): Promise<void> {
  if (opts.mkdir) await mkdirAsync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFileAsync(tmp, data, { encoding: opts.encoding });
    await renameAsync(tmp, file);
  } catch (err) {
    await unlinkAsync(tmp).catch(() => undefined);
    throw err;
  }
}

/** atomicWriteFileSync 的临时文件名：`<file>.<pid>.<8 位 hex>.tmp` */
export const ATOMIC_TMP_RE = /\.\d+\.[0-9a-f]{8}\.tmp$/;
/** 状态目录顶层：原子写临时文件，以及旧版网关的固定名临时文件 */
export const STATE_TMP_PATTERNS: readonly RegExp[] = [
  ATOMIC_TMP_RE,
  /^(state|usage)\.json\.tmp$/,
  /^loops\.json.*\.tmp$/,
];

export type SweepOptions = {
  /** 文件名任一匹配才删，默认 STATE_TMP_PATTERNS */
  patterns?: readonly RegExp[];
  /** mtime 早于 now - maxAgeMs 才删，默认 1 小时；别的进程可能正在写新的临时文件 */
  maxAgeMs?: number;
  now?: number;
};

/**
 * 删掉 dir 下（不递归）崩溃残留的临时文件：只碰普通文件，不跟符号链接。
 * 目录不存在返回空；单个文件删不掉就跳过。返回删掉的文件名。
 */
export function sweepStaleTmp(dir: string, opts: SweepOptions = {}): string[] {
  const patterns = opts.patterns ?? STATE_TMP_PATTERNS;
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? 60 * 60_000);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!patterns.some((re) => re.test(name))) continue;
    const file = join(dir, name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      unlinkSync(file);
      removed.push(name);
    } catch {
      // 并发删除、权限：留到下次启动
    }
  }
  return removed;
}
