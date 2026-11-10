import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { assistantPath, readJson, type TenantRef } from "../assistant/store.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { isInside } from "../pathInside.ts";
import { BLOCKED_EXECUTABLE_EXTS, fileExtension, isValidPathSegment } from "./contract.ts";
import { SESSION_MAX_LIFETIME_MS, SESSION_TTL_MS, type DropSessionGrant, type DropTenantHost } from "./tokens.ts";
import { validateKbHtmlContentSafety } from "./tools.ts";

export const QA_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const QA_MAX_SESSION_BYTES = 32 * 1024 * 1024;
export const QA_MAX_SESSION_FILES = 20;
export const QA_MAX_TENANT_BYTES = 256 * 1024 * 1024;
export const QA_MAX_SESSIONS_PER_WORKSPACE = 32;
export const QA_MAX_HISTORY_TURNS = 10;
export const QA_MAX_QUESTION_CHARS = 4000;
export const QA_MAX_ANSWER_CHARS = 8000;
export const QA_RUN_LEASE_TTL_MS = 3 * 60 * 1000;
export const QA_ORPHAN_DIR_TTL_MS = 5 * 60 * 1000;

const QA_SESSION_ID_RE = /^qa_[0-9a-f]{24,64}$/;
const SAFE_ID_SEGMENT_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** 允许上传到问答临时目录 uploads/ 的纯文本/轻量数据文件后缀 */
export const QA_UPLOAD_ALLOWED_EXTS = new Set([".md", ".txt", ".csv", ".json", ".sql"]);

/** 允许 AI 通过 kb_qa_temp_write 生成到 outputs/ 的临时文件后缀（含经过安全静态检查的 .html 统计页） */
export const QA_OUTPUT_ALLOWED_EXTS = new Set([".md", ".txt", ".csv", ".json", ".sql", ".html"]);

export type QaTempFileItem = {
  scope: "uploads" | "outputs";
  name: string;
  size: number;
  sha256: string;
  updatedAt: number;
  ext: string;
};

export type QaHistoryTurn = {
  question: string;
  answer: string;
  citedPaths: string[];
  outputFiles: string[];
  timestamp: number;
};

export type QaSessionMeta = {
  version: 1;
  qaSessionId: string;
  tenantId: string;
  tokenId: string;
  workspaceId: string;
  workspaceKey: string;
  submitterName: string;
  createdAt: number;
  lastActiveAt: number;
  turns: QaHistoryTurn[];
};

export type QaRegistryEntry = {
  qaSessionId: string;
  tenantId: string;
  tokenId: string;
  workspaceId: string;
  tempDir: string;
  createdAt: number;
  lastActiveAt: number;
  totalBytes: number;
  fileCount: number;
};

type QaRegistryFile = {
  version: 1;
  items: QaRegistryEntry[];
};

export type QaRuntimeLease = {
  qaSessionId: string;
  tenantId: string;
  tokenId: string;
  workspaceId: string;
  /** 仅当口令吊销、会话过期淘汰或 LRU 驱逐时置为 true；用户主动点「清空对话」时不置为 true，而是递增 generation */
  closed: boolean;
  /** 每次用户点击「清空对话」（reopenAfterClear）时自增，使在途旧运行立即感知失效且不会误关后续新请求 */
  generation: number;
  activeOps: number;
  runningAsk: boolean;
  runStartedAt?: number;
  abortController?: AbortController;
};

/** 进程内活跃问答会话租约表：qaSessionId -> QaRuntimeLease */
const runtimeLeases = new Map<string, QaRuntimeLease>();

export function isValidQaSessionId(id: string): boolean {
  return QA_SESSION_ID_RE.test(id.trim());
}

export function qaStateLockPath(ref: TenantRef): string {
  return assistantPath(ref, "drop-qa.lockfile");
}

function qaRegistryFilePath(ref: TenantRef): string {
  return assistantPath(ref, "drop-qa-sessions.json");
}

function readQaRegistryUnlocked(ref: TenantRef): QaRegistryFile {
  const raw = readJson<Partial<QaRegistryFile>>(qaRegistryFilePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter((x): x is QaRegistryEntry =>
        Boolean(x && typeof x.qaSessionId === "string" && isValidQaSessionId(x.qaSessionId)),
      )
    : [];
  return { version: 1, items };
}

function writeQaRegistryUnlocked(ref: TenantRef, data: QaRegistryFile) {
  atomicWriteFileSync(qaRegistryFilePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

function ensureDirMode0700Sync(absDir: string) {
  mkdirSync(absDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(absDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`非法的临时目录路径（拒绝符号链接）：${absDir}`);
  }
  try {
    chmodSync(absDir, 0o700);
  } catch {
    // ignore chmod error on non-posix fs
  }
}

/**
 * 解析并校验租户级 QA 临时目录根路径：
 * 1. 默认使用 `<tenant.stateDir>/assistant/drop-qa-tmp`（或环境变量 `CURSOR_REMOTE_QA_TMP_ROOT` 下的 `<tenantId>`）；
 * 2. 强制用 `realpathSync` 双向校验该目录与 `host.workspaceRoot` 绝不相等且互不包含；
 * 3. 若因 `stateDir` 配置在 `workspaceRoot` 内导致重叠，则自动切换到系统级隔离目录 `os.tmpdir()/cursor-remote-drop-qa/<tenantId>` 并再次双向复核；
 * 4. 确保根目录权限为 `0o700`。
 */
export function resolveSafeQaTenantRootSync(
  host: DropTenantHost,
): { ok: true; rootRealPath: string } | { ok: false; error: string } {
  try {
    const wsRootAbs = resolve(host.workspaceRoot);
    mkdirSync(wsRootAbs, { recursive: true });
    const wsRootReal = realpathSync(wsRootAbs);

    const envRoot = (process.env.CURSOR_REMOTE_QA_TMP_ROOT || "").trim();
    const primaryCandidate = envRoot ? resolve(envRoot, host.id) : assistantPath(host, "drop-qa-tmp");

    const tryCandidate = (candidateAbs: string): string | null => {
      try {
        ensureDirMode0700Sync(candidateAbs);
        const candidateReal = realpathSync(candidateAbs);
        if (
          candidateReal === wsRootReal ||
          isInside(candidateReal, wsRootReal) ||
          isInside(wsRootReal, candidateReal)
        ) {
          return null;
        }
        return candidateReal;
      } catch {
        return null;
      }
    };

    const primaryReal = tryCandidate(primaryCandidate);
    if (primaryReal) {
      return { ok: true, rootRealPath: primaryReal };
    }

    const fallbackCandidate = resolve(tmpdir(), "cursor-remote-drop-qa", host.id);
    const fallbackReal = tryCandidate(fallbackCandidate);
    if (fallbackReal) {
      return { ok: true, rootRealPath: fallbackReal };
    }

    return { ok: false, error: "无法创建与工作区物理隔离的问答临时目录" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "校验问答临时根目录失败" };
  }
}

/**
 * 不跟随符号链接的安全递归删除（仅删除普通文件、符号链接本身与真实子目录）
 */
export function safeRemoveTreeNoFollowSync(targetAbsPath: string) {
  let st;
  try {
    st = lstatSync(targetAbsPath);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    try {
      unlinkSync(targetAbsPath);
    } catch {
      // ignore
    }
    return;
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(targetAbsPath);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name || name === "." || name === "..") continue;
    safeRemoveTreeNoFollowSync(resolve(targetAbsPath, name));
  }
  try {
    rmdirSync(targetAbsPath);
  } catch {
    // ignore
  }
}

/**
 * 两阶段墓碑销毁协议（Tombstone Delete）：
 * 1. 先将目标会话目录原子 `renameSync` 为同父目录下的 `.deleting-<base>-<ts>-<rand>` 墓碑目录；
 * 2. 再对墓碑目录执行不跟随符号链接的逐级删除；
 * 彻底消除删除中途并发读取或残留句柄看到半删目录的竞态。
 */
export function tombstoneDeleteSessionDirSync(sessionDirAbs: string, allowedRootReal: string) {
  try {
    if (!existsSync(sessionDirAbs)) return;
    const lst = lstatSync(sessionDirAbs);
    if (lst.isSymbolicLink()) {
      unlinkSync(sessionDirAbs);
      return;
    }
    const realTarget = realpathSync(sessionDirAbs);
    if (!isInside(realTarget, allowedRootReal) || realTarget === allowedRootReal) {
      return;
    }
    const parentDir = dirname(realTarget);
    const baseName = realTarget.split(/[/\\]/).pop() || "session";
    const tombstoneAbs = resolve(parentDir, `.deleting-${baseName}-${Date.now()}-${randomBytes(4).toString("hex")}`);
    try {
      renameSync(realTarget, tombstoneAbs);
      safeRemoveTreeNoFollowSync(tombstoneAbs);
    } catch {
      safeRemoveTreeNoFollowSync(realTarget);
    }
  } catch {
    // ignore
  }
}

export function getOrCreateQaRuntimeLease(
  session: Pick<DropSessionGrant, "qaSessionId" | "tenantId" | "tokenId" | "workspaceId">,
): QaRuntimeLease {
  let lease = runtimeLeases.get(session.qaSessionId);
  if (!lease) {
    lease = {
      qaSessionId: session.qaSessionId,
      tenantId: session.tenantId,
      tokenId: session.tokenId,
      workspaceId: session.workspaceId,
      closed: false,
      generation: 1,
      activeOps: 0,
      runningAsk: false,
    };
    runtimeLeases.set(session.qaSessionId, lease);
  }
  return lease;
}

export function isQaSessionClosed(qaSessionId: string, expectedGeneration?: number): boolean {
  const lease = runtimeLeases.get(qaSessionId);
  if (!lease) return false;
  if (lease.closed) return true;
  if (expectedGeneration !== undefined && lease.generation !== expectedGeneration) return true;
  return false;
}

/**
 * 标记某个 qaSessionId 为永久 closed（口令吊销/过期/LRU驱逐）并触发 abortController 中止在途问答
 */
export function markQaSessionClosedAndAbort(qaSessionId: string) {
  const lease = runtimeLeases.get(qaSessionId);
  if (lease) {
    lease.closed = true;
    lease.generation += 1;
    lease.runningAsk = false;
    if (lease.abortController) {
      try {
        lease.abortController.abort();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 仅递增会话 generation 并中止当前在途运行（用于访客点击「清空对话」后继续使用同一登录会话，不永久锁死 lease.closed）
 */
export function bumpQaSessionGenerationAndAbort(qaSessionId: string) {
  const lease = runtimeLeases.get(qaSessionId);
  if (lease) {
    lease.generation += 1;
    lease.runningAsk = false;
    if (lease.abortController) {
      try {
        lease.abortController.abort();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 实时扫描单个问答会话临时目录下的真实磁盘文件数与总字节数（包含 uploads/、outputs/、session.json 及 .tmp-* 临时文件）
 */
export function measureQaSessionDiskUsageSync(sessionDirAbs: string): {
  fileCount: number;
  totalBytes: number;
  files: QaTempFileItem[];
} {
  let fileCount = 0;
  let totalBytes = 0;
  const files: QaTempFileItem[] = [];

  try {
    const metaPath = resolve(sessionDirAbs, "session.json");
    const mst = lstatSync(metaPath);
    if (mst.isFile() && !mst.isSymbolicLink()) {
      totalBytes += mst.size;
    }
  } catch {
    // ignore
  }

  for (const scope of ["uploads", "outputs"] as const) {
    const subDir = resolve(sessionDirAbs, scope);
    let names: string[] = [];
    try {
      const dst = lstatSync(subDir);
      if (dst.isSymbolicLink() || !dst.isDirectory()) continue;
      names = readdirSync(subDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name || name === "." || name === "..") continue;
      const absFile = resolve(subDir, name);
      try {
        const st = lstatSync(absFile);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        totalBytes += st.size;
        if (!name.startsWith(".tmp-")) {
          fileCount += 1;
          files.push({
            scope,
            name,
            size: st.size,
            sha256: "",
            updatedAt: Math.floor(st.mtimeMs),
            ext: fileExtension(name),
          });
        }
      } catch {
        // ignore
      }
    }
  }

  return { fileCount, totalBytes, files };
}

/**
 * 安全写入 QA 临时目录内的 0o600 普通文件（O_CREAT | O_EXCL | O_NOFOLLOW 临时文件 + 原子 rename）
 */
function safeWriteQaFile0600Sync(
  sessionRealDir: string,
  subPathRel: string,
  data: string | Buffer,
): { ok: true; absPath: string; size: number } | { ok: false; error: string } {
  try {
    const lstRoot = lstatSync(sessionRealDir);
    if (lstRoot.isSymbolicLink() || !lstRoot.isDirectory()) {
      return { ok: false, error: "问答会话临时目录不存在或已被销毁" };
    }
    const rootReal = realpathSync(sessionRealDir);
    if (rootReal !== sessionRealDir) {
      return { ok: false, error: "问答会话临时目录路径不一致" };
    }

    const targetAbs = resolve(rootReal, subPathRel);
    if (!isInside(targetAbs, rootReal) || targetAbs === rootReal) {
      return { ok: false, error: "临时文件目标路径越界" };
    }

    const parentAbs = dirname(targetAbs);
    const parentLst = lstatSync(parentAbs);
    if (parentLst.isSymbolicLink() || !parentLst.isDirectory()) {
      return { ok: false, error: "临时文件父目录非法" };
    }
    const parentReal = realpathSync(parentAbs);
    if (!isInside(parentReal, rootReal)) {
      return { ok: false, error: "临时文件父目录逃逸" };
    }

    try {
      const existingLst = lstatSync(targetAbs);
      if (existingLst.isSymbolicLink() || !existingLst.isFile() || existingLst.nlink > 1) {
        return { ok: false, error: "目标位置存在符号链接、硬链接或非普通文件" };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, error: "检查临时目标文件状态失败" };
      }
    }

    const tmpAbs = resolve(parentReal, `.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

    let fd: number | undefined;
    let renamed = false;
    try {
      fd = openSync(tmpAbs, flags, 0o600);
      const fst = fstatSync(fd);
      if (!fst.isFile() || fst.nlink > 1) {
        return { ok: false, error: "临时写入句柄校验异常" };
      }
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      let offset = 0;
      while (offset < buf.length) {
        offset += writeSync(fd, buf, offset, buf.length - offset);
      }
      const lstTmp = lstatSync(tmpAbs);
      if (lstTmp.isSymbolicLink() || lstTmp.dev !== fst.dev || lstTmp.ino !== fst.ino) {
        return { ok: false, error: "临时文件在 rename 前发生变化" };
      }
      renameSync(tmpAbs, targetAbs);
      renamed = true;
      closeSync(fd);
      fd = undefined;
      try {
        chmodSync(targetAbs, 0o600);
      } catch {
        // ignore
      }
      return { ok: true, absPath: targetAbs, size: buf.length };
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (!renamed) {
        try {
          unlinkSync(tmpAbs);
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "写入问答临时文件失败" };
  }
}

/**
 * 安全读取 QA 临时目录内的 0o600 普通文件（O_RDONLY | O_NOFOLLOW | O_NONBLOCK + inode 复核）
 */
export function safeReadQaFileSync(
  sessionRealDir: string,
  subPathRel: string,
  maxBytes = QA_MAX_FILE_BYTES,
): { ok: true; buffer: Buffer; absPath: string } | { ok: false; error: string } {
  let fd: number | undefined;
  try {
    const lstRoot = lstatSync(sessionRealDir);
    if (lstRoot.isSymbolicLink() || !lstRoot.isDirectory()) {
      return { ok: false, error: "问答会话临时目录不存在" };
    }
    const rootReal = realpathSync(sessionRealDir);
    const targetAbs = resolve(rootReal, subPathRel);
    if (!isInside(targetAbs, rootReal) || targetAbs === rootReal) {
      return { ok: false, error: "读取路径越界" };
    }
    const parentAbs = dirname(targetAbs);
    const parentLst = lstatSync(parentAbs);
    if (parentLst.isSymbolicLink() || !parentLst.isDirectory()) {
      return { ok: false, error: "读取父目录不是安全目录" };
    }
    const parentReal = realpathSync(parentAbs);
    if (!isInside(parentReal, rootReal)) {
      return { ok: false, error: "读取父目录逃逸" };
    }

    const lstBefore = lstatSync(targetAbs);
    if (lstBefore.isSymbolicLink() || !lstBefore.isFile() || lstBefore.nlink > 1) {
      return { ok: false, error: "目标不是安全的普通文件" };
    }

    const flags =
      constants.O_RDONLY |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
      (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
    fd = openSync(targetAbs, flags);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink > 1 || fst.dev !== lstBefore.dev || fst.ino !== lstBefore.ino) {
      return { ok: false, error: "文件句柄复核不一致" };
    }
    if (fst.size > maxBytes) {
      return { ok: false, error: `文件体积超过读取上限（${maxBytes} bytes）` };
    }
    const buf = Buffer.alloc(fst.size);
    let offset = 0;
    while (offset < fst.size) {
      const n = readSync(fd, buf, offset, fst.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return { ok: true, buffer: buf.subarray(0, offset), absPath: targetAbs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: "找不到指定的临时文件" };
    return { ok: false, error: err instanceof Error ? err.message : "读取临时文件失败" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 校验问答临时单段文件名是否合法
 */
export function validateQaTempFileName(
  rawFileName: string,
  scope: "uploads" | "outputs",
): { ok: true; cleanName: string; ext: string } | { ok: false; error: string } {
  const name = rawFileName.trim();
  if (!isValidPathSegment(name) || name.startsWith(".") || name.length > 120) {
    return { ok: false, error: "临时文件名不合法（禁止隐藏文件、路径分隔符或控制字符）" };
  }
  if (name.toLowerCase() === "session.json" || name.toLowerCase() === "meta.json") {
    return { ok: false, error: "禁止使用系统保留元数据文件名" };
  }
  const ext = fileExtension(name);
  if (!ext) {
    return { ok: false, error: "临时文件必须包含合法扩展名" };
  }
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const subExt = `.${parts[i].toLowerCase()}`;
    if (BLOCKED_EXECUTABLE_EXTS.has(subExt) && !(scope === "outputs" && subExt === ".html" && i === parts.length - 1)) {
      return { ok: false, error: `临时文件名包含禁止的脚本或可执行后缀（${subExt}）` };
    }
  }
  const allowedSet = scope === "uploads" ? QA_UPLOAD_ALLOWED_EXTS : QA_OUTPUT_ALLOWED_EXTS;
  if (!allowedSet.has(ext)) {
    return {
      ok: false,
      error: `不支持的临时文件格式（${ext}），允许格式：${[...allowedSet].join(" / ")}`,
    };
  }
  return { ok: true, cleanName: name, ext };
}

function isLeaseBusy(lease: QaRuntimeLease | undefined, now: number): boolean {
  if (!lease || lease.closed) return false;
  if (lease.activeOps > 0) return true;
  if (lease.runningAsk && lease.runStartedAt && now - lease.runStartedAt < QA_RUN_LEASE_TTL_MS) {
    return true;
  }
  return false;
}

/**
 * 在锁内执行容量水位线检查与 LRU 清理（当某工作区会话数 > 32 或租户 QA 临时盘总量 > 256MB 时驱逐最旧的非运行态会话）
 */
function enforceQuotaAndEvictUnlocked(
  host: DropTenantHost,
  rootRealPath: string,
  reg: QaRegistryFile,
  currentWorkspaceId: string,
  currentQaSessionId: string,
  additionalBytesNeeded = 0,
  now = Date.now(),
): { ok: true } | { ok: false; error: string } {
  const surviving: QaRegistryEntry[] = [];
  for (const item of reg.items) {
    const lease = runtimeLeases.get(item.qaSessionId);
    const activeRun = isLeaseBusy(lease, now);
    const idleExpired = now - item.lastActiveAt > SESSION_TTL_MS;
    const lifeExpired = now - item.createdAt > SESSION_MAX_LIFETIME_MS;
    if ((idleExpired || lifeExpired) && !activeRun && item.qaSessionId !== currentQaSessionId) {
      markQaSessionClosedAndAbort(item.qaSessionId);
      tombstoneDeleteSessionDirSync(item.tempDir, rootRealPath);
      runtimeLeases.delete(item.qaSessionId);
      continue;
    }
    if (!existsSync(item.tempDir)) {
      runtimeLeases.delete(item.qaSessionId);
      continue;
    }
    const usage = measureQaSessionDiskUsageSync(item.tempDir);
    item.totalBytes = usage.totalBytes;
    item.fileCount = usage.fileCount;
    surviving.push(item);
  }
  reg.items = surviving;

  const wsSessions = reg.items
    .filter((x) => x.workspaceId === currentWorkspaceId && x.qaSessionId !== currentQaSessionId)
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

  while (wsSessions.length >= QA_MAX_SESSIONS_PER_WORKSPACE) {
    const victimIdx = wsSessions.findIndex((x) => !isLeaseBusy(runtimeLeases.get(x.qaSessionId), now));
    if (victimIdx < 0) break;
    const [victim] = wsSessions.splice(victimIdx, 1);
    markQaSessionClosedAndAbort(victim.qaSessionId);
    tombstoneDeleteSessionDirSync(victim.tempDir, rootRealPath);
    runtimeLeases.delete(victim.qaSessionId);
    reg.items = reg.items.filter((x) => x.qaSessionId !== victim.qaSessionId);
  }

  let tenantTotalBytes = reg.items.reduce((sum, x) => sum + x.totalBytes, 0);
  if (tenantTotalBytes + additionalBytesNeeded > QA_MAX_TENANT_BYTES) {
    const candidates = reg.items
      .filter((x) => x.qaSessionId !== currentQaSessionId && !isLeaseBusy(runtimeLeases.get(x.qaSessionId), now))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    for (const victim of candidates) {
      if (tenantTotalBytes + additionalBytesNeeded <= QA_MAX_TENANT_BYTES) break;
      markQaSessionClosedAndAbort(victim.qaSessionId);
      tombstoneDeleteSessionDirSync(victim.tempDir, rootRealPath);
      runtimeLeases.delete(victim.qaSessionId);
      tenantTotalBytes -= victim.totalBytes;
      reg.items = reg.items.filter((x) => x.qaSessionId !== victim.qaSessionId);
    }
  }

  if (tenantTotalBytes + additionalBytesNeeded > QA_MAX_TENANT_BYTES) {
    return { ok: false, error: "当前知识库问答临时存储空间已达上限，请稍后再试或先清空临时文件" };
  }
  return { ok: true };
}

/**
 * 确保当前问答会话的独立临时目录（`<qaTmpRoot>/<workspaceId>/<qaSessionId>/` 及 `uploads/`、`outputs/`、`session.json`）已安全初始化：
 * - 目录权限强制为 `0o700`，文件权限强制为 `0o600`；
 * - 绝不触碰知识库工作区目录（`<workspacePath>`）。
 */
export function ensureQaSessionStorageSync(
  host: DropTenantHost,
  session: DropSessionGrant,
  now = Date.now(),
):
  | {
      ok: true;
      sessionDir: string;
      uploadsDir: string;
      outputsDir: string;
      meta: QaSessionMeta;
      usage: { fileCount: number; totalBytes: number; files: QaTempFileItem[] };
    }
  | { ok: false; status: 400 | 403 | 429; error: string } {
  if (!isValidQaSessionId(session.qaSessionId) || !SAFE_ID_SEGMENT_RE.test(session.workspaceId)) {
    return { ok: false, status: 400, error: "非法的问答会话标识" };
  }

  const lease = getOrCreateQaRuntimeLease(session);
  if (lease.closed) {
    return { ok: false, status: 403, error: "当前问答会话已关闭，请刷新页面重新登录" };
  }

  const rootRes = resolveSafeQaTenantRootSync(host);
  if (!rootRes.ok) {
    return { ok: false, status: 400, error: rootRes.error };
  }
  const rootRealPath = rootRes.rootRealPath;

  return withFileLockSync(qaStateLockPath(host), () => {
    const reg = readQaRegistryUnlocked(host);
    const quotaCheck = enforceQuotaAndEvictUnlocked(
      host,
      rootRealPath,
      reg,
      session.workspaceId,
      session.qaSessionId,
      0,
      now,
    );
    if (!quotaCheck.ok) {
      writeQaRegistryUnlocked(host, reg);
      return { ok: false as const, status: 429 as const, error: quotaCheck.error };
    }

    const wsDirAbs = resolve(rootRealPath, session.workspaceId);
    const sessDirAbs = resolve(wsDirAbs, session.qaSessionId);
    const uploadsDirAbs = resolve(sessDirAbs, "uploads");
    const outputsDirAbs = resolve(sessDirAbs, "outputs");

    try {
      ensureDirMode0700Sync(wsDirAbs);
      ensureDirMode0700Sync(sessDirAbs);
      ensureDirMode0700Sync(uploadsDirAbs);
      ensureDirMode0700Sync(outputsDirAbs);
    } catch (err) {
      return {
        ok: false as const,
        status: 400 as const,
        error: err instanceof Error ? err.message : "创建问答临时目录失败",
      };
    }

    const sessDirReal = realpathSync(sessDirAbs);
    if (!isInside(sessDirReal, rootRealPath)) {
      return { ok: false as const, status: 400 as const, error: "问答临时目录路径校验未通过" };
    }

    let meta: QaSessionMeta = {
      version: 1,
      qaSessionId: session.qaSessionId,
      tenantId: host.id,
      tokenId: session.tokenId,
      workspaceId: session.workspaceId,
      workspaceKey: session.workspaceKey,
      submitterName: session.submitterName,
      createdAt: session.createdAt || now,
      lastActiveAt: now,
      turns: [],
    };

    const existingMetaRead = safeReadQaFileSync(sessDirReal, "session.json", 512 * 1024);
    if (existingMetaRead.ok) {
      try {
        const parsed = JSON.parse(existingMetaRead.buffer.toString("utf8")) as QaSessionMeta;
        if (
          parsed &&
          parsed.version === 1 &&
          parsed.qaSessionId === session.qaSessionId &&
          parsed.tokenId === session.tokenId &&
          parsed.workspaceId === session.workspaceId
        ) {
          meta = {
            ...parsed,
            workspaceKey: session.workspaceKey,
            lastActiveAt: now,
            turns: Array.isArray(parsed.turns) ? parsed.turns.slice(-QA_MAX_HISTORY_TURNS) : [],
          };
        }
      } catch {
        // overwrite corrupted meta
      }
    }

    const writeMetaRes = safeWriteQaFile0600Sync(sessDirReal, "session.json", `${JSON.stringify(meta, null, 2)}\n`);
    if (!writeMetaRes.ok) {
      return { ok: false as const, status: 400 as const, error: writeMetaRes.error };
    }

    const usage = measureQaSessionDiskUsageSync(sessDirReal);
    const existingEntry = reg.items.find((x) => x.qaSessionId === session.qaSessionId);
    if (existingEntry) {
      existingEntry.lastActiveAt = now;
      existingEntry.tempDir = sessDirReal;
      existingEntry.totalBytes = usage.totalBytes;
      existingEntry.fileCount = usage.fileCount;
    } else {
      reg.items.push({
        qaSessionId: session.qaSessionId,
        tenantId: host.id,
        tokenId: session.tokenId,
        workspaceId: session.workspaceId,
        tempDir: sessDirReal,
        createdAt: meta.createdAt,
        lastActiveAt: now,
        totalBytes: usage.totalBytes,
        fileCount: usage.fileCount,
      });
    }
    writeQaRegistryUnlocked(host, reg);

    return {
      ok: true as const,
      sessionDir: sessDirReal,
      uploadsDir: resolve(sessDirReal, "uploads"),
      outputsDir: resolve(sessDirReal, "outputs"),
      meta,
      usage,
    };
  });
}

/**
 * 向问答临时目录 `outputs/<fileName>` 写入 AI 生成的统计文件（支持 `.csv` 自动加 UTF-8 BOM 以兼容 Excel 直接打开中文，以及经过静态安全校验的 `.html` 统计看板）：
 * 1. 检查会话未关闭（`!isQaSessionClosed`）；
 * 2. 校验文件名与后缀在 `QA_OUTPUT_ALLOWED_EXTS` 内；
 * 3. 若后缀为 `.html`，强制调用 `validateKbHtmlContentSafety` 拦截任何 `<script>`、`<iframe>`、`on*` 事件或外链；
 * 4. 若后缀为 `.csv` 且尚未以 `\uFEFF` 开头，自动前置 UTF-8 BOM（`\uFEFF`），确保用户双击用 Excel 打开中文不乱码；
 * 5. 在 `qaStateLockPath` 锁内实时统计磁盘占用，强制校验单文件 ≤ 4MB、单会话 ≤ 32MB / 20 个文件、租户总盘 ≤ 256MB。
 */
export function writeQaTempOutputFileSync(
  host: DropTenantHost,
  session: DropSessionGrant,
  rawFileName: string,
  rawContent: string,
  now = Date.now(),
):
  | {
      ok: true;
      file: QaTempFileItem;
      totalBytes: number;
      fileCount: number;
    }
  | { ok: false; error: string } {
  if (isQaSessionClosed(session.qaSessionId)) {
    return { ok: false, error: "当前问答会话已关闭或已被吊销，禁止写入临时文件" };
  }

  const nameCheck = validateQaTempFileName(rawFileName, "outputs");
  if (!nameCheck.ok) return nameCheck;

  let finalContent = rawContent;
  if (nameCheck.ext === ".html") {
    const htmlSafety = validateKbHtmlContentSafety(rawContent);
    if (!htmlSafety.ok) {
      return { ok: false, error: `临时统计 HTML 未通过安全校验：${htmlSafety.error}` };
    }
  } else if (nameCheck.ext === ".csv") {
    if (!rawContent.startsWith("\uFEFF")) {
      finalContent = `\uFEFF${rawContent}`;
    }
  }

  const buf = Buffer.from(finalContent, "utf8");
  if (buf.length === 0) {
    return { ok: false, error: "不能写入空的临时文件" };
  }
  if (buf.length > QA_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `临时文件体积（${buf.length} bytes）超过单文件 4MB 上限`,
    };
  }

  const ensured = ensureQaSessionStorageSync(host, session, now);
  if (!ensured.ok) {
    return { ok: false, error: ensured.error };
  }

  const rootRes = resolveSafeQaTenantRootSync(host);
  if (!rootRes.ok) return rootRes;

  return withFileLockSync(qaStateLockPath(host), () => {
    if (isQaSessionClosed(session.qaSessionId)) {
      return { ok: false as const, error: "当前问答会话已关闭，中止写入" };
    }

    const currentUsage = measureQaSessionDiskUsageSync(ensured.sessionDir);
    const existingSameName = currentUsage.files.find((f) => f.scope === "outputs" && f.name === nameCheck.cleanName);
    const nextFileCount = existingSameName ? currentUsage.fileCount : currentUsage.fileCount + 1;
    const netAddedBytes = buf.length - (existingSameName?.size ?? 0);

    const reg = readQaRegistryUnlocked(host);
    const quotaCheck = enforceQuotaAndEvictUnlocked(
      host,
      rootRes.rootRealPath,
      reg,
      session.workspaceId,
      session.qaSessionId,
      Math.max(0, netAddedBytes),
      now,
    );
    if (!quotaCheck.ok) {
      writeQaRegistryUnlocked(host, reg);
      return { ok: false as const, error: quotaCheck.error };
    }

    if (nextFileCount > QA_MAX_SESSION_FILES) {
      return {
        ok: false as const,
        error: `当前问答会话临时文件数量已达上限（最多 ${QA_MAX_SESSION_FILES} 个文件）`,
      };
    }
    if (currentUsage.totalBytes + netAddedBytes > QA_MAX_SESSION_BYTES) {
      return {
        ok: false as const,
        error: `当前问答会话临时存储空间已达 32MB 上限`,
      };
    }

    const written = safeWriteQaFile0600Sync(ensured.sessionDir, `outputs/${nameCheck.cleanName}`, buf);
    if (!written.ok) return written;

    const sha256 = createHash("sha256").update(buf).digest("hex");
    const afterUsage = measureQaSessionDiskUsageSync(ensured.sessionDir);
    const regEntry = reg.items.find((x) => x.qaSessionId === session.qaSessionId);
    if (regEntry) {
      regEntry.lastActiveAt = now;
      regEntry.totalBytes = afterUsage.totalBytes;
      regEntry.fileCount = afterUsage.fileCount;
      writeQaRegistryUnlocked(host, reg);
    }

    return {
      ok: true as const,
      file: {
        scope: "outputs" as const,
        name: nameCheck.cleanName,
        size: buf.length,
        sha256,
        updatedAt: now,
        ext: nameCheck.ext,
      },
      totalBytes: afterUsage.totalBytes,
      fileCount: afterUsage.fileCount,
    };
  });
}

/**
 * 流式接收访客在问答框上传的临时比对文件（写入 `<qaSessionTempDir>/uploads/<fileName>`，绝不写入知识库工作区）
 */
export async function streamUploadQaTempFile(
  host: DropTenantHost,
  initialSession: DropSessionGrant,
  input: {
    fileName: string;
    req: IncomingMessage;
    reverifySession: () => { ok: true; session: DropSessionGrant } | { ok: false; status: 401 | 403; error: string };
  },
  now = Date.now(),
): Promise<
  | {
      ok: true;
      file: QaTempFileItem;
      totalBytes: number;
      fileCount: number;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 413 | 429;
      error: string;
    }
> {
  const nameCheck = validateQaTempFileName(input.fileName, "uploads");
  if (!nameCheck.ok) {
    input.req.resume();
    return { ok: false, status: 400, error: nameCheck.error };
  }

  const ensured = ensureQaSessionStorageSync(host, initialSession, now);
  if (!ensured.ok) {
    input.req.resume();
    return ensured;
  }

  if (ensured.usage.fileCount >= QA_MAX_SESSION_FILES) {
    input.req.resume();
    return { ok: false, status: 400, error: `单问答会话最多允许暂存 ${QA_MAX_SESSION_FILES} 个临时文件` };
  }

  const lease = getOrCreateQaRuntimeLease(initialSession);
  lease.activeOps += 1;

  const tmpName = `.tmp-stream-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const tmpAbs = resolve(ensured.uploadsDir, tmpName);
  const openFlags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

  let fd: number | undefined;
  let renamed = false;

  try {
    fd = openSync(tmpAbs, openFlags, 0o600);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink > 1) {
      input.req.resume();
      return { ok: false, status: 400, error: "创建问答上传临时文件失败" };
    }

    const hash = createHash("sha256");
    let totalBytes = 0;
    let tooLarge = false;

    await new Promise<void>((resolveStream, rejectStream) => {
      input.req.on("data", (chunk: Buffer) => {
        if (tooLarge || lease.closed) return;
        totalBytes += chunk.length;
        if (totalBytes > QA_MAX_FILE_BYTES) {
          tooLarge = true;
          input.req.resume();
          resolveStream();
          return;
        }
        try {
          let off = 0;
          while (off < chunk.length) {
            off += writeSync(fd!, chunk, off, chunk.length - off);
          }
          hash.update(chunk);
        } catch (err) {
          rejectStream(err);
        }
      });
      input.req.on("end", () => resolveStream());
      input.req.on("error", (err) => rejectStream(err));
    });

    if (lease.closed) {
      return { ok: false, status: 403, error: "问答会话已关闭或口令已吊销" };
    }
    if (tooLarge) {
      return { ok: false, status: 413, error: `问答临时附件不能超过 4MB 上限` };
    }
    if (totalBytes === 0) {
      return { ok: false, status: 400, error: "不能上传空文件" };
    }

    const rechecked = input.reverifySession();
    if (!rechecked.ok) {
      return rechecked;
    }

    const sha256 = hash.digest("hex");
    const rootRes = resolveSafeQaTenantRootSync(host);
    if (!rootRes.ok) {
      return { ok: false, status: 400, error: rootRes.error };
    }

    return withFileLockSync(qaStateLockPath(host), () => {
      if (lease.closed || !existsSync(ensured.uploadsDir)) {
        return { ok: false as const, status: 403 as const, error: "问答会话已关闭" };
      }

      const reg = readQaRegistryUnlocked(host);
      // .tmp-stream-* 临时文件已写入磁盘，enforceQuotaAndEvictUnlocked 内部的 measureQaSessionDiskUsageSync 已将其计入 totalBytes，故 additionalBytesNeeded 传 0 防双倍计费
      const quotaCheck = enforceQuotaAndEvictUnlocked(
        host,
        rootRes.rootRealPath,
        reg,
        initialSession.workspaceId,
        initialSession.qaSessionId,
        0,
        now,
      );
      if (!quotaCheck.ok) {
        writeQaRegistryUnlocked(host, reg);
        return { ok: false as const, status: 429 as const, error: quotaCheck.error };
      }

      const usageBefore = measureQaSessionDiskUsageSync(ensured.sessionDir);
      const baseBytes = Math.max(0, usageBefore.totalBytes - totalBytes);
      if (usageBefore.fileCount >= QA_MAX_SESSION_FILES) {
        return {
          ok: false as const,
          status: 400 as const,
          error: `单问答会话最多允许 ${QA_MAX_SESSION_FILES} 个临时文件`,
        };
      }
      if (baseBytes + totalBytes > QA_MAX_SESSION_BYTES) {
        return { ok: false as const, status: 413 as const, error: "当前问答会话临时空间已达 32MB 上限" };
      }

      const ext = nameCheck.ext;
      const maxStemLen = Math.max(1, 110 - ext.length);
      const rawStem = nameCheck.cleanName.slice(0, nameCheck.cleanName.length - ext.length) || "attachment";
      const stem = rawStem.slice(0, maxStemLen);
      let finalName = nameCheck.cleanName;
      let seq = 2;
      while (existsSync(resolve(ensured.uploadsDir, finalName))) {
        finalName = `${stem}-${seq}${ext}`;
        seq += 1;
      }

      const uploadsLst = lstatSync(ensured.uploadsDir);
      if (uploadsLst.isSymbolicLink() || !uploadsLst.isDirectory()) {
        return { ok: false as const, status: 400 as const, error: "上传临时目录状态异常" };
      }
      const uploadsReal = realpathSync(ensured.uploadsDir);
      if (!isInside(uploadsReal, rootRes.rootRealPath)) {
        return { ok: false as const, status: 400 as const, error: "上传临时目录路径复核未通过" };
      }
      const targetAbs = resolve(uploadsReal, finalName);
      const lstTmp = lstatSync(tmpAbs);
      if (lstTmp.isSymbolicLink() || lstTmp.dev !== fst.dev || lstTmp.ino !== fst.ino) {
        return { ok: false as const, status: 400 as const, error: "临时文件校验不一致" };
      }

      renameSync(tmpAbs, targetAbs);
      renamed = true;
      closeSync(fd!);
      fd = undefined;
      try {
        chmodSync(targetAbs, 0o600);
      } catch {
        // ignore
      }

      const usageAfter = measureQaSessionDiskUsageSync(ensured.sessionDir);
      const regEntry = reg.items.find((x) => x.qaSessionId === initialSession.qaSessionId);
      if (regEntry) {
        regEntry.lastActiveAt = now;
        regEntry.totalBytes = usageAfter.totalBytes;
        regEntry.fileCount = usageAfter.fileCount;
        writeQaRegistryUnlocked(host, reg);
      }

      return {
        ok: true as const,
        file: {
          scope: "uploads" as const,
          name: finalName,
          size: totalBytes,
          sha256,
          updatedAt: now,
          ext,
        },
        totalBytes: usageAfter.totalBytes,
        fileCount: usageAfter.fileCount,
      };
    });
  } catch {
    return { ok: false, status: 400, error: "保存问答临时附件失败" };
  } finally {
    lease.activeOps = Math.max(0, lease.activeOps - 1);
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmpAbs);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 追加一轮问答记录到 `<qaSessionTempDir>/session.json`（若会话已被标记为 closed 则静默跳过，绝不复活已被删除的目录）
 */
export function appendQaHistoryTurnSync(
  host: DropTenantHost,
  session: DropSessionGrant,
  turn: QaHistoryTurn,
  now = Date.now(),
): { ok: true; meta: QaSessionMeta } | { ok: false; error: string } {
  if (isQaSessionClosed(session.qaSessionId)) {
    return { ok: false, error: "问答会话已关闭，跳过历史保存" };
  }
  const rootRes = resolveSafeQaTenantRootSync(host);
  if (!rootRes.ok) return rootRes;

  return withFileLockSync(qaStateLockPath(host), () => {
    if (isQaSessionClosed(session.qaSessionId)) {
      return { ok: false as const, error: "问答会话已关闭，跳过历史保存" };
    }
    const sessDirAbs = resolve(rootRes.rootRealPath, session.workspaceId, session.qaSessionId);
    if (!existsSync(sessDirAbs)) {
      return { ok: false as const, error: "问答会话临时目录已不存在" };
    }
    const sessDirReal = realpathSync(sessDirAbs);
    const readRes = safeReadQaFileSync(sessDirReal, "session.json", 512 * 1024);
    if (!readRes.ok) return readRes;

    let meta: QaSessionMeta;
    try {
      meta = JSON.parse(readRes.buffer.toString("utf8")) as QaSessionMeta;
    } catch {
      return { ok: false as const, error: "解析问答会话元数据失败" };
    }

    const sanitizedTurn: QaHistoryTurn = {
      question: turn.question.slice(0, QA_MAX_QUESTION_CHARS),
      answer: turn.answer.slice(0, QA_MAX_ANSWER_CHARS),
      citedPaths: turn.citedPaths.slice(0, 20),
      outputFiles: turn.outputFiles.slice(0, 20),
      timestamp: now,
    };

    const nextTurns = [...(Array.isArray(meta.turns) ? meta.turns : []), sanitizedTurn].slice(-QA_MAX_HISTORY_TURNS);
    meta.turns = nextTurns;
    meta.lastActiveAt = now;

    const writeRes = safeWriteQaFile0600Sync(sessDirReal, "session.json", `${JSON.stringify(meta, null, 2)}\n`);
    if (!writeRes.ok) return writeRes;

    const usage = measureQaSessionDiskUsageSync(sessDirReal);
    const reg = readQaRegistryUnlocked(host);
    const regEntry = reg.items.find((x) => x.qaSessionId === session.qaSessionId);
    if (regEntry) {
      regEntry.lastActiveAt = now;
      regEntry.totalBytes = usage.totalBytes;
      regEntry.fileCount = usage.fileCount;
      writeQaRegistryUnlocked(host, reg);
    }

    return { ok: true as const, meta };
  });
}

/**
 * 主动清空并销毁某个问答会话的临时目录（用于访客点击「清空对话与临时文件」或会话被驱逐）
 */
export function clearQaSessionStorageSync(
  host: DropTenantHost,
  qaSessionId: string,
  workspaceId?: string,
  opts: { reopenAfterClear?: boolean } = {},
): { ok: true; removed: boolean } {
  if (!isValidQaSessionId(qaSessionId)) {
    return { ok: true, removed: false };
  }
  if (opts.reopenAfterClear) {
    bumpQaSessionGenerationAndAbort(qaSessionId);
  } else {
    markQaSessionClosedAndAbort(qaSessionId);
  }
  const rootRes = resolveSafeQaTenantRootSync(host);
  if (!rootRes.ok) {
    if (!opts.reopenAfterClear) runtimeLeases.delete(qaSessionId);
    return { ok: true, removed: false };
  }

  return withFileLockSync(qaStateLockPath(host), () => {
    const reg = readQaRegistryUnlocked(host);
    const found = reg.items.find((x) => x.qaSessionId === qaSessionId);
    let removed = false;
    if (found) {
      tombstoneDeleteSessionDirSync(found.tempDir, rootRes.rootRealPath);
      reg.items = reg.items.filter((x) => x.qaSessionId !== qaSessionId);
      writeQaRegistryUnlocked(host, reg);
      removed = true;
    } else if (workspaceId && SAFE_ID_SEGMENT_RE.test(workspaceId)) {
      const candidate = resolve(rootRes.rootRealPath, workspaceId, qaSessionId);
      if (existsSync(candidate)) {
        tombstoneDeleteSessionDirSync(candidate, rootRes.rootRealPath);
        removed = true;
      }
    }
    if (!opts.reopenAfterClear) {
      runtimeLeases.delete(qaSessionId);
    }
    return { ok: true as const, removed };
  });
}

/**
 * 当管理员吊销一个或多个投递口令（`revokedTokenIds`）时，立即中止关联的所有在途 QA 运行并物理销毁其临时目录
 */
export function purgeQaSessionsByTokenIdsSync(
  ref: TenantRef,
  workspaceRoot: string,
  revokedTokenIds: ReadonlySet<string>,
): number {
  if (revokedTokenIds.size === 0) return 0;
  const dummyHost: DropTenantHost = {
    id: ref.id,
    stateDir: ref.stateDir,
    workspaceRoot,
    resolveWorkspace: () => null,
  };

  for (const [qaId, lease] of runtimeLeases.entries()) {
    if (lease.tenantId === ref.id && revokedTokenIds.has(lease.tokenId)) {
      markQaSessionClosedAndAbort(qaId);
    }
  }

  const rootRes = resolveSafeQaTenantRootSync(dummyHost);
  if (!rootRes.ok) return 0;

  return withFileLockSync(qaStateLockPath(ref), () => {
    const reg = readQaRegistryUnlocked(ref);
    const kept: QaRegistryEntry[] = [];
    let purgedCount = 0;

    for (const item of reg.items) {
      if (item.tenantId === ref.id && revokedTokenIds.has(item.tokenId)) {
        markQaSessionClosedAndAbort(item.qaSessionId);
        tombstoneDeleteSessionDirSync(item.tempDir, rootRes.rootRealPath);
        runtimeLeases.delete(item.qaSessionId);
        purgedCount += 1;
      } else {
        kept.push(item);
      }
    }

    if (purgedCount > 0) {
      reg.items = kept;
      writeQaRegistryUnlocked(ref, reg);
    }
    return purgedCount;
  });
}

/**
 * 扫描并清理单个租户下过期的 QA 临时目录、残留的 `.deleting-*` 墓碑目录及无主孤儿目录：
 * 1. 空闲超时：`now - lastActiveAt > 30 分钟`（`SESSION_TTL_MS`）；
 * 2. 绝对寿命超时：`now - createdAt > 2 小时`（`SESSION_MAX_LIFETIME_MS`）；
 * 3. 运行租约超时：若内存 `runningAsk === true` 且 `now - runStartedAt < 3 分钟`，且未超过 2 小时绝对寿命，则暂缓删除；一旦运行超过 3 分钟或超过 2 小时绝对寿命，立即强制 `abort` 并清理；
 * 4. 物理磁盘孤儿扫描：遍历 `<qaTmpRoot>/<workspaceId>/`，清理所有 `.deleting-*` 残留目录，以及不在 `drop-qa-sessions.json` 中且 `mtime` 超过 5 分钟（或 `isStartup`）的孤儿目录。
 */
export function sweepTenantQaTempStorageSync(
  host: DropTenantHost,
  opts: { now?: number; isStartup?: boolean } = {},
): { removedSessions: number; removedOrphans: number } {
  const now = opts.now ?? Date.now();
  const rootRes = resolveSafeQaTenantRootSync(host);
  if (!rootRes.ok) return { removedSessions: 0, removedOrphans: 0 };
  const rootRealPath = rootRes.rootRealPath;

  return withFileLockSync(qaStateLockPath(host), () => {
    const reg = readQaRegistryUnlocked(host);
    const kept: QaRegistryEntry[] = [];
    let removedSessions = 0;
    let removedOrphans = 0;

    for (const item of reg.items) {
      const lease = runtimeLeases.get(item.qaSessionId);
      const isActivelyRunning = !opts.isStartup && isLeaseBusy(lease, now);

      const idleExpired = now - item.lastActiveAt > SESSION_TTL_MS;
      const lifeExpired = now - item.createdAt > SESSION_MAX_LIFETIME_MS;
      const runTimedOut = Boolean(
        lease?.runningAsk && lease.runStartedAt && now - lease.runStartedAt >= QA_RUN_LEASE_TTL_MS,
      );

      if (lifeExpired || ((idleExpired || runTimedOut) && !isActivelyRunning)) {
        // 清理磁盘临时目录并中止运行，但仅重置 generation 而不置 closed=true，以便持久化记住登录会话在超过 30m/2h 后继续发起新提问
        bumpQaSessionGenerationAndAbort(item.qaSessionId);
        tombstoneDeleteSessionDirSync(item.tempDir, rootRealPath);
        runtimeLeases.delete(item.qaSessionId);
        removedSessions += 1;
        continue;
      }

      if (!existsSync(item.tempDir)) {
        runtimeLeases.delete(item.qaSessionId);
        removedSessions += 1;
        continue;
      }

      kept.push(item);
    }

    reg.items = kept;
    writeQaRegistryUnlocked(host, reg);

    const activeQaIds = new Set(kept.map((x) => x.qaSessionId));

    let wsDirs: string[] = [];
    try {
      wsDirs = readdirSync(rootRealPath);
    } catch {
      wsDirs = [];
    }

    for (const wsName of wsDirs) {
      if (!wsName || wsName === "." || wsName === "..") continue;
      const wsAbs = resolve(rootRealPath, wsName);
      try {
        const wst = lstatSync(wsAbs);
        if (wst.isSymbolicLink()) {
          unlinkSync(wsAbs);
          removedOrphans += 1;
          continue;
        }
        if (!wst.isDirectory()) continue;
        if (wsName.startsWith(".deleting-")) {
          safeRemoveTreeNoFollowSync(wsAbs);
          removedOrphans += 1;
          continue;
        }

        const subEntries = readdirSync(wsAbs);
        for (const subName of subEntries) {
          if (!subName || subName === "." || subName === "..") continue;
          const subAbs = resolve(wsAbs, subName);
          try {
            const sst = lstatSync(subAbs);
            if (sst.isSymbolicLink()) {
              unlinkSync(subAbs);
              removedOrphans += 1;
              continue;
            }
            if (subName.startsWith(".deleting-")) {
              safeRemoveTreeNoFollowSync(subAbs);
              removedOrphans += 1;
              continue;
            }
            if (!activeQaIds.has(subName)) {
              const ageMs = now - sst.mtimeMs;
              if (opts.isStartup || ageMs > QA_ORPHAN_DIR_TTL_MS) {
                tombstoneDeleteSessionDirSync(subAbs, rootRealPath);
                removedOrphans += 1;
              }
            }
          } catch {
            // ignore single subentry error
          }
        }

        try {
          if (readdirSync(wsAbs).length === 0) {
            rmdirSync(wsAbs);
          }
        } catch {
          // ignore
        }
      } catch {
        // ignore single wsDir error
      }
    }

    return { removedSessions, removedOrphans };
  });
}

/** 测试辅助：清空内存中的 QA 运行租约表 */
export function resetQaStorageMemoryForTest() {
  for (const [id] of runtimeLeases) {
    markQaSessionClosedAndAbort(id);
  }
  runtimeLeases.clear();
}
