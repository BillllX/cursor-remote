import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { assistantPath, readJson, type TenantRef } from "../assistant/store.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { isInside } from "../pathInside.ts";
import {
  ensureSafePathInWorkspace,
  hasControlChars,
  isAllowedUploadFileName,
  KB_INBOX_REL_DIR,
  loadKbWorkspaceConfig,
  safeMkdirInWorkspaceSync,
  safeReadWorkspaceTextFileSync,
  safeWriteWorkspaceFileSync,
} from "./contract.ts";
import {
  bindBatchIdToDropSession,
  type DropSessionGrant,
  type DropTenantHost,
} from "./tokens.ts";

export const MAX_FILES_PER_BATCH = 20;
export const MAX_NOTE_LENGTH = 500;
const BATCH_ID_RE = /^b_[0-9a-z]{6,32}$/;

export type DropBatchStatus = "staging" | "queued" | "processing" | "completed" | "partial" | "failed";

export type DropStagedFileItem = {
  /** 批次目录内的安全文件名（如 202611_report.xlsx） */
  storedName: string;
  /** 用户上传时的原始文件名 */
  originalName: string;
  /** 工作区内相对路径（.cursor-remote/uploads/inbox/<batchId>/<storedName>） */
  relPath: string;
  size: number;
  sha256: string;
  uploadedAt: number;
};

export type DropBatchMeta = {
  version: 1;
  batchId: string;
  tenantId: string;
  tokenId: string;
  workspaceId: string;
  workspaceKey: string;
  submitterName: string;
  note: string;
  receiptHash: string;
  status: DropBatchStatus;
  statusMessage: string;
  files: DropStagedFileItem[];
  archivedPaths?: string[];
  updatedHtmlPaths?: string[];
  errorReason?: string;
  createdAt: number;
  updatedAt: number;
  committedAt?: number;
  finishedAt?: number;
};

type BatchRegistryRecord = {
  batchId: string;
  tenantId: string;
  tokenId: string;
  workspaceId: string;
  receiptHash: string;
  createdAt: number;
};

type BatchRegistryFile = {
  version: 1;
  items: BatchRegistryRecord[];
};

const MAX_REGISTRY_ITEMS = 1000;

export function ingestStateLockPath(ref: TenantRef): string {
  return assistantPath(ref, "ingest-state.lockfile");
}

function registryFilePath(ref: TenantRef): string {
  return assistantPath(ref, "drop-batches.json");
}

function readRegistryUnlocked(ref: TenantRef): BatchRegistryFile {
  const raw = readJson<Partial<BatchRegistryFile>>(registryFilePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter((x): x is BatchRegistryRecord => Boolean(x && typeof x.batchId === "string"))
    : [];
  return { version: 1, items };
}

function writeRegistryUnlocked(ref: TenantRef, data: BatchRegistryFile) {
  atomicWriteFileSync(registryFilePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

function hashReceipt(receiptToken: string): string {
  return createHash("sha256").update(receiptToken).digest("hex");
}

export function isValidBatchId(batchId: string): boolean {
  return BATCH_ID_RE.test(batchId.trim());
}

export function batchDirRelPath(batchId: string): string {
  return `${KB_INBOX_REL_DIR}/${batchId}`;
}

export function batchMetaRelPath(batchId: string): string {
  return `${KB_INBOX_REL_DIR}/${batchId}/meta.json`;
}

/** 根据批次状态生成固定的公开脱敏提示文案，绝不透出内部路径或模型报错细节 */
export function fixedPublicStatusMessage(status: DropBatchStatus, fileCount: number): string {
  switch (status) {
    case "staging":
      return fileCount > 0 ? `已接收 ${fileCount} 个文件，等待提交归档` : "等待上传文件";
    case "queued":
      return `已进入归档队列（共 ${fileCount} 个文件），等待 AI 处理`;
    case "processing":
      return `AI 正在分类归档并同步更新知识库（共 ${fileCount} 个文件）…`;
    case "completed":
      return `已成功归档并更新知识库（共 ${fileCount} 个文件）`;
    case "partial":
      return `已完成部分文件归档（共 ${fileCount} 个文件），请管理员在收件箱查看详情`;
    case "failed":
      return "自动归档未能完成，原始文件已安全保留在工作区收件箱中，等待管理员处理";
  }
}

/** 读取指定工作区内某批次的 meta.json */
export function readBatchMetaSync(
  workspaceDir: string,
  batchId: string,
): { ok: true; meta: DropBatchMeta } | { ok: false; error: string } {
  if (!isValidBatchId(batchId)) {
    return { ok: false, error: "非法的批次号格式" };
  }
  const readRes = safeReadWorkspaceTextFileSync(workspaceDir, batchMetaRelPath(batchId), 512 * 1024);
  if (!readRes.ok) return readRes;
  try {
    const parsed = JSON.parse(readRes.text) as DropBatchMeta;
    if (!parsed || parsed.version !== 1 || parsed.batchId !== batchId || !Array.isArray(parsed.files)) {
      return { ok: false, error: "批次元数据格式损坏" };
    }
    return { ok: true, meta: parsed };
  } catch {
    return { ok: false, error: "解析批次元数据失败" };
  }
}

/** 原子写回批次的 meta.json */
export function writeBatchMetaSync(
  workspaceDir: string,
  meta: DropBatchMeta,
): { ok: true } | { ok: false; error: string } {
  if (!isValidBatchId(meta.batchId)) {
    return { ok: false, error: "非法的批次号格式" };
  }
  const writeRes = safeWriteWorkspaceFileSync(
    workspaceDir,
    batchMetaRelPath(meta.batchId),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  if (!writeRes.ok) return writeRes;
  return { ok: true };
}

/** 分配一个新的 batchId 与 receiptToken（不触碰工作区文件系统，仅在内存或真正调用 stageFileIntoBatch 时按需落盘） */
export function allocateDropBatchCredentials(now = Date.now()): {
  batchId: string;
  receiptToken: string;
  receiptHash: string;
} {
  const batchId = `b_${now.toString(36)}${randomBytes(5).toString("hex")}`;
  const receiptToken = `rcpt_${randomBytes(24).toString("hex")}`;
  const receiptHash = hashReceipt(receiptToken);
  return { batchId, receiptToken, receiptHash };
}

/**
 * 创建一个新的投递批次（在同事通过口令鉴权或首次上传文件时调用）：
 * 1. 在目标工作区创建 `.cursor-remote/uploads/inbox/<batchId>/`；
 * 2. 生成不可枚举的 `receiptToken`（仅将 SHA-256 哈希存入 `meta.json` 和租户级 `drop-batches.json`）；
 * 3. 写入初始 `meta.json`（状态为 `staging`）。
 */
export function createDropBatch(
  host: DropTenantHost,
  session: DropSessionGrant,
  now = Date.now(),
  preallocated?: { batchId: string; receiptToken?: string; receiptHash: string },
):
  | {
      ok: true;
      batchId: string;
      receiptToken: string;
      meta: DropBatchMeta;
    }
  | { ok: false; error: string } {
  const wsRef = host.resolveWorkspace(session.workspaceId);
  if (!wsRef) {
    return { ok: false, error: "目标工作区不存在" };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    return { ok: false, error: kbCheck.error };
  }

  const creds = preallocated
    ? {
        batchId: preallocated.batchId,
        receiptToken: preallocated.receiptToken || "",
        receiptHash: preallocated.receiptHash,
      }
    : allocateDropBatchCredentials(now);
  const { batchId, receiptToken, receiptHash } = creds;
  bindBatchIdToDropSession(session.sessionToken, batchId, receiptHash);
  session.batchId = batchId;
  session.receiptHash = receiptHash;

  const dirRes = safeMkdirInWorkspaceSync(kbCheck.workspaceRealPath, batchDirRelPath(batchId));
  if (!dirRes.ok) return dirRes;

  const meta: DropBatchMeta = {
    version: 1,
    batchId,
    tenantId: host.id,
    tokenId: session.tokenId,
    workspaceId: wsRef.workspaceId,
    workspaceKey: wsRef.key,
    submitterName: session.submitterName,
    note: "",
    receiptHash,
    status: "staging",
    statusMessage: fixedPublicStatusMessage("staging", 0),
    files: [],
    createdAt: now,
    updatedAt: now,
  };

  const lockFile = ingestStateLockPath(host);
  return withFileLockSync(lockFile, () => {
    const existingMeta = readBatchMetaSync(kbCheck.workspaceRealPath, batchId);
    if (existingMeta.ok) {
      return { ok: true as const, batchId, receiptToken, meta: existingMeta.meta };
    }
    const metaRes = writeBatchMetaSync(kbCheck.workspaceRealPath, meta);
    if (!metaRes.ok) return metaRes;

    const reg = readRegistryUnlocked(host);
    if (!reg.items.some((x) => x.batchId === batchId)) {
      reg.items.push({
        batchId,
        tenantId: host.id,
        tokenId: session.tokenId,
        workspaceId: wsRef.workspaceId,
        receiptHash,
        createdAt: now,
      });
      if (reg.items.length > MAX_REGISTRY_ITEMS) {
        reg.items = reg.items.slice(-MAX_REGISTRY_ITEMS);
      }
      writeRegistryUnlocked(host, reg);
    }

    return { ok: true as const, batchId, receiptToken, meta };
  });
}

/**
 * 将单个上传文件安全写入指定批次的 `inbox/<batchId>/` 目录：
 * 1. 校验批次存在、归属当前 session（tokenId + workspaceId 匹配）且处于 `staging` 状态；
 * 2. 校验单批次文件数不超过 20 个、文件名与后缀符合工作区 `kb.json` 白名单、文件体积非空且不超过 `maxFileBytes`；
 * 3. 若同批次内已有同名文件（同时检查 meta.files 与磁盘实际存在文件），自动追加 `-2` 等序号防覆盖；
 * 4. 通过 `safeWriteWorkspaceFileSync`（临时文件 O_EXCL|O_NOFOLLOW + 原子 rename）写入并更新 `meta.json`。
 */
export function stageFileIntoBatch(
  host: DropTenantHost,
  session: DropSessionGrant,
  input: {
    batchId: string;
    fileName: string;
    data: Buffer;
  },
  now = Date.now(),
):
  | {
      ok: true;
      file: DropStagedFileItem;
      meta: DropBatchMeta;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 413;
      error: string;
    } {
  if (!isValidBatchId(input.batchId)) {
    return { ok: false, status: 400, error: "非法的批次号" };
  }
  const wsRef = host.resolveWorkspace(session.workspaceId);
  if (!wsRef) {
    return { ok: false, status: 403, error: "目标工作区已不存在" };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    return { ok: false, status: 403, error: kbCheck.error };
  }

  const nameCheck = isAllowedUploadFileName(input.fileName, kbCheck.config);
  if (!nameCheck.ok) {
    return { ok: false, status: 400, error: nameCheck.error };
  }

  if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
    return { ok: false, status: 400, error: "不能上传空文件" };
  }
  if (input.data.length > kbCheck.config.maxFileBytes) {
    return {
      ok: false,
      status: 413,
      error: `文件体积（${input.data.length} bytes）超过单文件上限（${kbCheck.config.maxFileBytes} bytes）`,
    };
  }

  const lockFile = ingestStateLockPath(host);
  return withFileLockSync(lockFile, () => {
    const metaLoaded = readBatchMetaSync(kbCheck.workspaceRealPath, input.batchId);
    if (!metaLoaded.ok) {
      return { ok: false as const, status: 404 as const, error: "找不到该投递批次" };
    }
    const meta = metaLoaded.meta;
    if (
      meta.workspaceId !== session.workspaceId ||
      meta.tokenId !== session.tokenId ||
      !session.batchId ||
      session.batchId !== input.batchId
    ) {
      return { ok: false as const, status: 403 as const, error: "无权操作该投递批次" };
    }
    if (meta.status !== "staging") {
      return { ok: false as const, status: 409 as const, error: `该批次已提交（当前状态：${meta.status}），不能再追加文件` };
    }
    const batchAbsDir = resolve(kbCheck.workspaceRealPath, batchDirRelPath(input.batchId));
    let diskFileCount = 0;
    try {
      diskFileCount = readdirSync(batchAbsDir).filter(
        (name) => name.toLowerCase() !== "meta.json" && !name.startsWith(".tmp-"),
      ).length;
    } catch {
      diskFileCount = meta.files.length;
    }
    if (Math.max(meta.files.length, diskFileCount) >= MAX_FILES_PER_BATCH) {
      return { ok: false as const, status: 400 as const, error: `单批次最多允许上传 ${MAX_FILES_PER_BATCH} 个文件` };
    }

    // 避免同批次同名文件互相覆盖（同时检查 meta.files 与磁盘文件），且绝不允许文件名为 meta.json
    const ext = nameCheck.ext;
    const stem = nameCheck.normalizedName.slice(0, nameCheck.normalizedName.length - ext.length) || "file";
    let storedName = nameCheck.normalizedName;
    if (storedName.toLowerCase() === "meta.json") {
      storedName = `uploaded_meta${ext}`;
    }
    const existingNames = new Set(meta.files.map((f) => f.storedName.toLowerCase()));
    let seq = 2;
    while (
      existingNames.has(storedName.toLowerCase()) ||
      existsSync(resolve(batchAbsDir, storedName))
    ) {
      storedName = `${stem}-${seq}${ext}`;
      seq += 1;
    }

    const fileRelPath = `${batchDirRelPath(input.batchId)}/${storedName}`;
    const written = safeWriteWorkspaceFileSync(kbCheck.workspaceRealPath, fileRelPath, input.data);
    if (!written.ok) {
      return { ok: false as const, status: 400 as const, error: written.error };
    }

    const sha256 = createHash("sha256").update(input.data).digest("hex");
    const item: DropStagedFileItem = {
      storedName,
      originalName: nameCheck.normalizedName,
      relPath: written.normalizedRel,
      size: input.data.length,
      sha256,
      uploadedAt: now,
    };

    meta.files.push(item);
    meta.updatedAt = now;
    meta.statusMessage = fixedPublicStatusMessage("staging", meta.files.length);

    const savedMeta = writeBatchMetaSync(kbCheck.workspaceRealPath, meta);
    if (!savedMeta.ok) {
      return { ok: false as const, status: 400 as const, error: savedMeta.error };
    }

    return { ok: true as const, file: item, meta };
  });
}

/**
 * 清理指定批次备注文本
 */
export function sanitizeBatchNote(rawNote: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (rawNote === undefined || rawNote === null) return { ok: true, note: "" };
  if (typeof rawNote !== "string") return { ok: false, error: "备注格式非法" };
  const clean = rawNote.replace(/\r\n/g, "\n").trim();
  if (clean.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `备注说明不能超过 ${MAX_NOTE_LENGTH} 字符` };
  }
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if ((code <= 0x1f && code !== 0x0a && code !== 0x09) || code === 0x7f) {
      return { ok: false, error: "备注包含非法控制字符" };
    }
  }
  return { ok: true, note: clean };
}

/**
 * 凭 batchId + receiptToken 查询该批次自身的脱敏处理状态：
 * 1. 常量时间比对 receiptHash，若批次不存在或 receiptToken 不匹配，统一返回 404 和相同文案，防止探测某 batchId 是否存在；
 * 2. 仅返回状态、文件数量、时间戳与固定脱敏状态文案（fixedPublicStatusMessage），绝不返回内部路径或模型正文。
 */
export function getDropBatchPublicStatus(
  host: DropTenantHost,
  input: {
    batchId: string;
    receiptToken: string;
  },
):
  | {
      ok: true;
      status: {
        batchId: string;
        status: DropBatchStatus;
        statusMessage: string;
        fileCount: number;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
      };
    }
  | {
      ok: false;
      status: 400 | 404;
      error: string;
    } {
  const batchId = input.batchId.trim();
  const receiptToken = input.receiptToken.trim();
  if (!isValidBatchId(batchId) || !receiptToken.startsWith("rcpt_")) {
    return { ok: false, status: 400, error: "无效的批次号或回执凭证" };
  }

  const reg = readRegistryUnlocked(host);
  const record = reg.items.find((r) => r.batchId === batchId && r.tenantId === host.id);
  const candidateHash = Buffer.from(hashReceipt(receiptToken), "hex");
  const expectedHash = record ? Buffer.from(record.receiptHash, "hex") : candidateHash;
  const hashMatched =
    Boolean(record) &&
    candidateHash.length === expectedHash.length &&
    timingSafeEqual(candidateHash, expectedHash);

  if (!record || !hashMatched) {
    return { ok: false, status: 404, error: "找不到该投递批次或回执凭证无效" };
  }

  const wsRef = host.resolveWorkspace(record.workspaceId);
  if (!wsRef) {
    return { ok: false, status: 404, error: "找不到该投递批次或回执凭证无效" };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    return { ok: false, status: 404, error: "找不到该投递批次或回执凭证无效" };
  }

  const metaRes = readBatchMetaSync(kbCheck.workspaceRealPath, batchId);
  if (!metaRes.ok) {
    return { ok: false, status: 404, error: "找不到该投递批次或回执凭证无效" };
  }

  const m = metaRes.meta;
  return {
    ok: true,
    status: {
      batchId: m.batchId,
      status: m.status,
      statusMessage: fixedPublicStatusMessage(m.status, m.files.length),
      fileCount: m.files.length,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      ...(m.finishedAt !== undefined ? { finishedAt: m.finishedAt } : {}),
    },
  };
}

/**
 * 校验某个待移动的 inbox 源路径是否确实属于指定 batchId 且文件存在
 */
export function validateBatchSourceFile(
  workspaceDir: string,
  batchId: string,
  sourceRelPath: string,
): { ok: true; absPath: string; normalizedRel: string; storedName: string } | { ok: false; error: string } {
  if (!isValidBatchId(batchId)) {
    return { ok: false, error: "非法 batchId" };
  }
  const safe = ensureSafePathInWorkspace(workspaceDir, sourceRelPath, { expectLeaf: "file" });
  if (!safe.ok) return safe;
  const expectedPrefix = `${batchDirRelPath(batchId)}/`;
  if (!safe.normalizedRel.startsWith(expectedPrefix)) {
    return { ok: false, error: `源文件路径必须位于当前批次目录 ${expectedPrefix} 内` };
  }
  const storedName = safe.normalizedRel.slice(expectedPrefix.length);
  if (!storedName || storedName.includes("/") || storedName.toLowerCase() === "meta.json") {
    return { ok: false, error: "禁止移动批次目录外的子目录或 meta.json 元数据文件" };
  }
  return {
    ok: true,
    absPath: safe.absPath,
    normalizedRel: safe.normalizedRel,
    storedName,
  };
}

/**
 * 真正流式地将 HTTP 请求体按 chunk 写入批次目录下的 `.part` 临时文件，并在流结束后再次校验会话未被吊销，然后原子 rename 入库：
 * 1. 流式读取前先校验文件名后缀、批次存在性、会话绑定的 batchId 与 20 文件上限（不合法立即拒绝，不把非法文件读入内存）；
 * 2. 每个 chunk 直接写入 O_CREAT|O_EXCL|O_NOFOLLOW 打开的临时文件，并增量计算 SHA-256，内存占用恒定；
 * 3. 若流累计字节超过 maxFileBytes，立即停止写盘、删除临时文件并排空请求流，返回 413（不调用 req.destroy() 破坏响应）；
 * 4. 流结束后通过 reverifySession 再次校验口令未被吊销，最后在 ingestStateLockPath 锁内复核、rename 转正并更新 meta.json。
 */
export async function streamStageFileIntoBatch(
  host: DropTenantHost,
  initialSession: DropSessionGrant,
  input: {
    batchId: string;
    fileName: string;
    req: IncomingMessage;
    reverifySession: () => { ok: true; session: DropSessionGrant } | { ok: false; status: 401 | 403; error: string };
  },
  now = Date.now(),
): Promise<
  | {
      ok: true;
      file: DropStagedFileItem;
      meta: DropBatchMeta;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 413;
      error: string;
    }
> {
  if (!isValidBatchId(input.batchId)) {
    input.req.resume();
    return { ok: false, status: 400, error: "非法的批次号" };
  }
  if (!initialSession.batchId || initialSession.batchId !== input.batchId) {
    input.req.resume();
    return { ok: false, status: 403, error: "无权操作其他投递批次" };
  }

  const wsRef = host.resolveWorkspace(initialSession.workspaceId);
  if (!wsRef) {
    input.req.resume();
    return { ok: false, status: 403, error: "目标工作区已不存在" };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    input.req.resume();
    return { ok: false, status: 403, error: "目标工作区知识库配置不可用" };
  }

  const nameCheck = isAllowedUploadFileName(input.fileName, kbCheck.config);
  if (!nameCheck.ok) {
    input.req.resume();
    return { ok: false, status: 400, error: nameCheck.error };
  }

  // 流式接收前先检查批次状态与文件数量上限（若该会话采用惰性批次尚未在工作区落盘，则在此处首次按需创建 inbox/<batchId>）
  if (!existsSync(resolve(kbCheck.workspaceRealPath, batchMetaRelPath(input.batchId)))) {
    const lazyCreated = createDropBatch(
      host,
      initialSession,
      now,
      initialSession.receiptHash
        ? { batchId: input.batchId, receiptHash: initialSession.receiptHash }
        : undefined,
    );
    if (!lazyCreated.ok) {
      input.req.resume();
      return { ok: false, status: 400, error: lazyCreated.error };
    }
  }

  const preCheck = withFileLockSync(ingestStateLockPath(host), () => {
    const metaLoaded = readBatchMetaSync(kbCheck.workspaceRealPath, input.batchId);
    if (!metaLoaded.ok) {
      return { ok: false as const, status: 404 as const, error: "找不到该投递批次" };
    }
    const meta = metaLoaded.meta;
    if (meta.workspaceId !== initialSession.workspaceId || meta.tokenId !== initialSession.tokenId) {
      return { ok: false as const, status: 403 as const, error: "无权操作该投递批次" };
    }
    if (meta.status !== "staging") {
      return { ok: false as const, status: 409 as const, error: "该批次已提交，不能再追加文件" };
    }
    const batchAbsDir = resolve(kbCheck.workspaceRealPath, batchDirRelPath(input.batchId));
    let diskFileCount = 0;
    try {
      diskFileCount = readdirSync(batchAbsDir).filter(
        (name) => name.toLowerCase() !== "meta.json" && !name.startsWith(".tmp-"),
      ).length;
    } catch {
      diskFileCount = meta.files.length;
    }
    if (Math.max(meta.files.length, diskFileCount) >= MAX_FILES_PER_BATCH) {
      return { ok: false as const, status: 400 as const, error: `单批次最多允许上传 ${MAX_FILES_PER_BATCH} 个文件` };
    }
    return { ok: true as const, batchAbsDir };
  });

  if (!preCheck.ok) {
    input.req.resume();
    return preCheck;
  }

  const batchRelDir = batchDirRelPath(input.batchId);
  const dirSafety = ensureSafePathInWorkspace(kbCheck.workspaceRealPath, batchRelDir, { expectLeaf: "dir" });
  if (!dirSafety.ok) {
    input.req.resume();
    return { ok: false, status: 400, error: "批次暂存目录异常" };
  }

  const tmpName = `.tmp-stream-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}.part`;
  const tmpAbs = resolve(dirSafety.absPath, tmpName);
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
      return { ok: false, status: 400, error: "创建上传临时文件失败" };
    }
    try {
      const fdReal = realpathSync(`/proc/self/fd/${fd}`);
      if (!isInside(fdReal, kbCheck.workspaceRealPath) || fdReal !== tmpAbs) {
        input.req.resume();
        return { ok: false, status: 400, error: "上传临时文件路径复核失败" };
      }
    } catch {
      // ignore if /proc/self/fd unavailable
    }

    const maxBytes = kbCheck.config.maxFileBytes;
    const hash = createHash("sha256");
    let totalBytes = 0;
    let tooLarge = false;

    await new Promise<void>((resolveStream, rejectStream) => {
      input.req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          tooLarge = true;
          return;
        }
        try {
          let off = 0;
          while (off < chunk.length) {
            off += writeSync(fd!, chunk, off, chunk.length - off);
          }
          hash.update(chunk);
        } catch (writeErr) {
          rejectStream(writeErr);
        }
      });
      input.req.on("end", () => resolveStream());
      input.req.on("error", (err) => rejectStream(err));
    });

    if (tooLarge) {
      return {
        ok: false,
        status: 413,
        error: `文件体积超过单文件上限（${maxBytes} bytes）`,
      };
    }
    if (totalBytes === 0) {
      return { ok: false, status: 400, error: "不能上传空文件" };
    }

    // 流接收完毕后，再次实时复核上传会话与底层口令是否已被吊销
    const rechecked = input.reverifySession();
    if (!rechecked.ok) {
      return rechecked;
    }

    const sha256 = hash.digest("hex");

    let metaCommitted = false;
    // 在状态锁内分配唯一 storedName、原子 rename 临时文件并更新 meta.json
    const lockRes = withFileLockSync(ingestStateLockPath(host), () => {
      const metaLoaded = readBatchMetaSync(kbCheck.workspaceRealPath, input.batchId);
      if (!metaLoaded.ok) {
        return { ok: false as const, status: 404 as const, error: "找不到该投递批次" };
      }
      const meta = metaLoaded.meta;
      if (meta.workspaceId !== rechecked.session.workspaceId || meta.tokenId !== rechecked.session.tokenId) {
        return { ok: false as const, status: 403 as const, error: "无权操作该投递批次" };
      }
      if (meta.status !== "staging") {
        return { ok: false as const, status: 409 as const, error: "该批次已提交，不能再追加文件" };
      }
      let diskFileCount = 0;
      try {
        diskFileCount = readdirSync(dirSafety.absPath).filter(
          (name) => name.toLowerCase() !== "meta.json" && !name.startsWith(".tmp-"),
        ).length;
      } catch {
        diskFileCount = meta.files.length;
      }
      if (Math.max(meta.files.length, diskFileCount) >= MAX_FILES_PER_BATCH) {
        return { ok: false as const, status: 400 as const, error: `单批次最多允许上传 ${MAX_FILES_PER_BATCH} 个文件` };
      }

      const ext = nameCheck.ext;
      const stem = nameCheck.normalizedName.slice(0, nameCheck.normalizedName.length - ext.length) || "file";
      let storedName = nameCheck.normalizedName;
      if (storedName.toLowerCase() === "meta.json") {
        storedName = `uploaded_meta${ext}`;
      }
      const existingNames = new Set(meta.files.map((f) => f.storedName.toLowerCase()));
      let seq = 2;
      while (
        existingNames.has(storedName.toLowerCase()) ||
        existsSync(resolve(dirSafety.absPath, storedName))
      ) {
        storedName = `${stem}-${seq}${ext}`;
        seq += 1;
      }

      const targetRelPath = `${batchRelDir}/${storedName}`;
      const targetSafety = ensureSafePathInWorkspace(kbCheck.workspaceRealPath, targetRelPath, { expectLeaf: "file" });
      if (!targetSafety.ok) {
        return { ok: false as const, status: 400 as const, error: "上传目标路径校验未通过" };
      }

      const lstTmp = lstatSync(tmpAbs);
      if (lstTmp.isSymbolicLink() || lstTmp.dev !== fst.dev || lstTmp.ino !== fst.ino) {
        return { ok: false as const, status: 400 as const, error: "上传临时文件校验不一致" };
      }

      renameSync(tmpAbs, targetSafety.absPath);
      renamed = true;
      closeSync(fd!);
      fd = undefined;

      const item: DropStagedFileItem = {
        storedName,
        originalName: nameCheck.normalizedName,
        relPath: targetSafety.normalizedRel,
        size: totalBytes,
        sha256,
        uploadedAt: now,
      };
      meta.files.push(item);
      meta.updatedAt = now;
      meta.statusMessage = fixedPublicStatusMessage("staging", meta.files.length);

      const savedMeta = writeBatchMetaSync(kbCheck.workspaceRealPath, meta);
      if (!savedMeta.ok) {
        try {
          unlinkSync(targetSafety.absPath);
        } catch {
          // ignore
        }
        return { ok: false as const, status: 400 as const, error: "保存批次元数据失败" };
      }
      metaCommitted = true;

      return { ok: true as const, file: item, meta };
    });
    void metaCommitted;
    return lockRes;
  } catch {
    return { ok: false, status: 400, error: "流式保存上传文件失败" };
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
}
