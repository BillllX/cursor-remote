import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
import { hostname } from "node:os";

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

export type FileLockOptions = {
  /** 最长等待时间；同步 API 必须有界，避免卡死网关事件循环。 */
  timeoutMs?: number;
  /** 超过该时间且 owner 进程已不存在的锁可恢复。 */
  staleMs?: number;
  /** 测试及低延迟调用可调整短退避。 */
  retryMs?: number;
};

const heldLocks = new Set<string>();
const lockWait = new Int32Array(new SharedArrayBuffer(4));

type LockOwner = { pid?: number; host?: string; token?: string };

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function ownerState(owner: LockOwner | null): "alive" | "dead" | "incomplete" | "foreign" {
  if (owner?.host && owner.host !== hostname()) return "foreign";
  if (!owner || owner.host !== hostname() || !Number.isInteger(owner.pid) || !owner.token) return "incomplete";
  // 同主机且 owner 完整时才能用 PID 判断；foreign 已在上面保守返回。
  try {
    process.kill(owner.pid!, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
  }
}

function sameOwnerSnapshot(left: LockOwner | null, right: LockOwner | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOwner(left: LockOwner | null, right: LockOwner | null) {
  return Boolean(
    left && right && left.token && left.token === right.token && left.pid === right.pid && left.host === right.host,
  );
}

function restoreMovedLock(moved: string, lockDir: string) {
  try {
    renameSync(moved, lockDir);
  } catch {
    // 已有后来者占据 lockDir 时保留 moved，绝不删除无法确认归属的 owner。
  }
}

/**
 * 跨进程同步互斥锁：原子 mkdir 获锁，owner.json 便于诊断；崩溃锁在过期且
 * 本机 owner 已消失后通过 rename 抢占恢复。等待采用 10–40ms 有界退避。
 * 同进程对同一路径重入会明确抛错，调用方应拆出 unlocked helper。
 */
export function withFileLockSync<T>(file: string, fn: () => T, opts: FileLockOptions = {}): T {
  const lockDir = `${file}.lock`;
  if (heldLocks.has(lockDir)) throw new Error(`同一进程不能重入文件锁：${lockDir}`);
  mkdirSync(dirname(lockDir), { recursive: true });
  try {
    if (lstatSync(lockDir).isSymbolicLink()) throw new Error(`文件锁路径不能是符号链接：${lockDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const staleMs = opts.staleMs ?? 30_000;
  const retryMs = Math.max(1, opts.retryMs ?? 10);
  const started = Date.now();
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  let attempt = 0;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      try {
        // 即使进程崩溃留下锁目录，Git 也看不到锁元数据；目录本身不会被 Git 跟踪。
        writeFileSync(join(lockDir, ".gitignore"), "*\n", { mode: 0o600 });
        writeFileSync(
          join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, host: hostname(), token, createdAt: Date.now() }),
          { mode: 0o600 },
        );
      } catch (ownerError) {
        rmSync(lockDir, { recursive: true, force: true });
        throw ownerError;
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        if (lstatSync(lockDir).isSymbolicLink()) throw new Error(`文件锁路径不能是符号链接：${lockDir}`);
        const beforeStat = statSync(lockDir);
        const age = Date.now() - beforeStat.mtimeMs;
        const before = readLockOwner(lockDir);
        const state = ownerState(before);
        if (state === "dead" || (state === "incomplete" && age >= staleMs)) {
          const stale = `${lockDir}.stale-${token}`;
          renameSync(lockDir, stale);
          const afterStat = statSync(stale);
          if (
            beforeStat.dev === afterStat.dev &&
            beforeStat.ino === afterStat.ino &&
            (sameOwner(before, readLockOwner(stale)) || sameOwnerSnapshot(before, readLockOwner(stale)))
          ) {
            rmSync(stale, { recursive: true, force: true });
            continue;
          }
          restoreMovedLock(stale, lockDir);
        }
      } catch (recoverErr) {
        const recoverCode = (recoverErr as NodeJS.ErrnoException).code;
        if (recoverCode !== "ENOENT" && recoverCode !== "EEXIST") throw recoverErr;
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`等待文件锁超时（${timeoutMs}ms）：${file}`);
      }
      Atomics.wait(lockWait, 0, 0, Math.min(40, retryMs * 2 ** Math.min(attempt++, 2)));
    }
  }
  heldLocks.add(lockDir);
  try {
    return fn();
  } finally {
    heldLocks.delete(lockDir);
    const release = `${lockDir}.release-${token}`;
    try {
      // 先原子移到 token 专属路径再核验；若目录已换主，只恢复，绝不删除新 owner。
      renameSync(lockDir, release);
      const owner = readLockOwner(release);
      if (owner?.token === token) rmSync(release, { recursive: true, force: true });
      else restoreMovedLock(release, lockDir);
    } catch {
      // 锁目录被外部移走时不能误删后来者。
    }
  }
}

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
