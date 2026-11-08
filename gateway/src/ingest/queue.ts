import { assistantPath, readJson, type TenantRef } from "../assistant/store.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { isAllowedUploadFileName, loadKbWorkspaceConfig } from "./contract.ts";
import {
  allocateDropBatchCredentials,
  cleanupAbortedStagingBatchSync,
  createDropBatch,
  fixedPublicStatusMessage,
  ingestStateLockPath,
  isValidBatchId,
  MAX_FILES_PER_BATCH,
  readBatchMetaSync,
  sanitizeBatchNote,
  stageFileIntoBatch,
  writeBatchMetaSync,
  type DropBatchMeta,
  type DropBatchStatus,
} from "./staging.ts";
import { sanitizeSubmitterName, SESSION_TTL_MS, type DropSessionGrant, type DropTenantHost } from "./tokens.ts";

export type IngestQueueEntry = {
  batchId: string;
  tenantId: string;
  workspaceId: string;
  workspaceKeySnapshot: string;
  submitterName: string;
  note: string;
  status: "queued" | "processing" | "completed" | "partial" | "failed";
  attempts: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  errorReason?: string;
};

type IngestQueueFile = {
  version: 1;
  items: IngestQueueEntry[];
};

export type IngestWorkerResult = {
  status: "completed" | "partial" | "failed";
  statusMessage: string;
  archivedPaths?: string[];
  updatedHtmlPaths?: string[];
  errorReason?: string;
};

export type IngestBatchWorker = (ctx: {
  host: DropTenantHost;
  entry: IngestQueueEntry;
  workspacePath: string;
  meta: DropBatchMeta;
}) => Promise<IngestWorkerResult>;

const MAX_FINISHED_QUEUE_HISTORY = 500;
const MAX_ACTIVE_QUEUE_ITEMS = 500;
const MAX_RETRY_ATTEMPTS = 2;

/** 内存运行锁：`${tenantId}:${workspaceId}` -> Promise<void>，确保同一工作区严格串行（并发度 = 1） */
const runningWorkspaces = new Map<string, Promise<void>>();

let registeredWorker: IngestBatchWorker | null = null;

export function bindIngestBatchWorker(worker: IngestBatchWorker | null) {
  registeredWorker = worker;
}

function queueStorePath(ref: TenantRef): string {
  return assistantPath(ref, "ingest-queue.json");
}

function readQueueFileUnlocked(ref: TenantRef): IngestQueueFile {
  const raw = readJson<Partial<IngestQueueFile>>(queueStorePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter((x): x is IngestQueueEntry => Boolean(x && typeof x.batchId === "string"))
    : [];
  return { version: 1, items };
}

/** 仅裁剪已终态（completed/partial/failed）的历史记录，绝不裁掉任何 queued 或 processing 的活跃任务 */
function pruneQueueItems(items: IngestQueueEntry[]): IngestQueueEntry[] {
  const active: IngestQueueEntry[] = [];
  const finished: IngestQueueEntry[] = [];
  for (const item of items) {
    if (item.status === "queued" || item.status === "processing") {
      active.push(item);
    } else {
      finished.push(item);
    }
  }
  const keptFinished = finished.slice(-MAX_FINISHED_QUEUE_HISTORY);
  return [...keptFinished, ...active];
}

function writeQueueFileUnlocked(ref: TenantRef, data: IngestQueueFile) {
  const pruned: IngestQueueFile = {
    version: 1,
    items: pruneQueueItems(data.items),
  };
  atomicWriteFileSync(queueStorePath(ref), `${JSON.stringify(pruned, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

/**
 * 提交一个已完成文件上传的批次进入持久化归档队列（幂等操作）：
 * 1. 与 stageFileIntoBatch 共用同一把 `ingestStateLockPath` 锁，消除并发竞态；
 * 2. 若该 batchId 已经处于非 `staging` 状态或已在队列中，直接幂等返回成功（并自愈补齐缺失的队列项或 meta 状态）；
 * 3. 先持久化写入 `ingest-queue.json`，再更新 `meta.json` 状态为 `queued`（保证即使中间崩溃，队列里也一定有记录，不会丢单）；
 * 4. 异步唤醒该工作区的串行队列消费器。
 */
export function commitDropBatchAndEnqueue(
  host: DropTenantHost,
  session: DropSessionGrant,
  input: {
    batchId: string;
    note?: unknown;
  },
  now = Date.now(),
):
  | {
      ok: true;
      idempotent: boolean;
      meta: DropBatchMeta;
      queueEntry: IngestQueueEntry;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 429;
      error: string;
    } {
  if (!isValidBatchId(input.batchId)) {
    return { ok: false, status: 400, error: "非法的批次号" };
  }
  const noteCheck = sanitizeBatchNote(input.note);
  if (!noteCheck.ok) {
    return { ok: false, status: 400, error: noteCheck.error };
  }

  const wsRef = host.resolveWorkspace(session.workspaceId);
  if (!wsRef) {
    return { ok: false, status: 403, error: "目标工作区不存在" };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    return { ok: false, status: 403, error: kbCheck.error };
  }

  const lockFile = ingestStateLockPath(host);
  const result = withFileLockSync(lockFile, () => {
    const metaRes = readBatchMetaSync(kbCheck.workspaceRealPath, input.batchId);
    if (!metaRes.ok) {
      return { ok: false as const, status: 404 as const, error: "找不到该投递批次" };
    }
    const meta = metaRes.meta;
    if (
      meta.workspaceId !== session.workspaceId ||
      meta.tokenId !== session.tokenId ||
      !session.batchId ||
      session.batchId !== input.batchId
    ) {
      return { ok: false as const, status: 403 as const, error: "无权提交该投递批次" };
    }

    const qData = readQueueFileUnlocked(host);
    const existingEntry = qData.items.find((item) => item.batchId === input.batchId);

    // 幂等支持：若 meta 已经不是 staging，或者已在队列中（含上次写完队列尚未写完 meta 的崩溃恢复场景）
    if (meta.status !== "staging" || existingEntry) {
      if (meta.status === "staging" && existingEntry) {
        meta.note = existingEntry.note;
        meta.status = existingEntry.status;
        meta.statusMessage = fixedPublicStatusMessage(existingEntry.status, meta.files.length);
        meta.committedAt = existingEntry.queuedAt;
        meta.updatedAt = now;
        writeBatchMetaSync(kbCheck.workspaceRealPath, meta);
      }
      let finalEntry = existingEntry;
      if (!finalEntry) {
        finalEntry = {
          batchId: meta.batchId,
          tenantId: host.id,
          workspaceId: wsRef.workspaceId,
          workspaceKeySnapshot: wsRef.key,
          submitterName: meta.submitterName,
          note: meta.note,
          status: meta.status === "staging" || meta.status === "processing" ? "queued" : meta.status,
          attempts: 0,
          queuedAt: meta.committedAt ?? meta.createdAt,
          ...(meta.finishedAt ? { finishedAt: meta.finishedAt } : {}),
        };
        if (finalEntry.status === "queued") {
          qData.items.push(finalEntry);
          writeQueueFileUnlocked(host, qData);
        }
      }
      return {
        ok: true as const,
        idempotent: true,
        meta,
        queueEntry: finalEntry,
      };
    }

    if (meta.files.length === 0) {
      return { ok: false as const, status: 400 as const, error: "批次内还没有上传任何文件，无法提交" };
    }

    const activeCount = qData.items.filter((x) => x.status === "queued" || x.status === "processing").length;
    if (activeCount >= MAX_ACTIVE_QUEUE_ITEMS) {
      return { ok: false as const, status: 429 as const, error: "当前排队归档的批次过多，请稍后再试" };
    }

    const entry: IngestQueueEntry = {
      batchId: meta.batchId,
      tenantId: host.id,
      workspaceId: wsRef.workspaceId,
      workspaceKeySnapshot: wsRef.key,
      submitterName: meta.submitterName,
      note: noteCheck.note,
      status: "queued",
      attempts: 0,
      queuedAt: now,
    };

    // 先持久化写队列（权威恢复源），再更新 meta.json
    const filtered = qData.items.filter((item) => item.batchId !== meta.batchId);
    filtered.push(entry);
    qData.items = filtered;
    writeQueueFileUnlocked(host, qData);

    meta.note = noteCheck.note;
    meta.status = "queued";
    meta.statusMessage = fixedPublicStatusMessage("queued", meta.files.length);
    meta.committedAt = now;
    meta.updatedAt = now;

    const savedMeta = writeBatchMetaSync(kbCheck.workspaceRealPath, meta);
    if (!savedMeta.ok) {
      qData.items = qData.items.filter((item) => item.batchId !== meta.batchId);
      writeQueueFileUnlocked(host, qData);
      return { ok: false as const, status: 400 as const, error: savedMeta.error };
    }

    return {
      ok: true as const,
      idempotent: false,
      meta,
      queueEntry: entry,
    };
  });

  if (result.ok && result.queueEntry.status === "queued") {
    void drainWorkspaceIngestQueue(host, wsRef.workspaceId);
  }
  return result;
}

/** 列出指定租户队列中的条目（测试与诊断用） */
export function listIngestQueue(ref: TenantRef): IngestQueueEntry[] {
  return readQueueFileUnlocked(ref).items;
}

/** 检查当前租户的活跃归档队列是否仍有容量（未达到 MAX_ACTIVE_QUEUE_ITEMS） */
export function hasIngestQueueCapacity(ref: TenantRef): boolean {
  const qData = readQueueFileUnlocked(ref);
  const activeCount = qData.items.filter((x) => x.status === "queued" || x.status === "processing").length;
  return activeCount < MAX_ACTIVE_QUEUE_ITEMS;
}

/**
 * 一步完成「创建投递批次 → 写入 1..N 个文件 → 提交归档队列并唤醒后台执行器」：
 * 供单步 Webhook（JSON/多文件模式）、iOS 分享扩展直投知识库、以及日常巡检/助理工具（kb_ingest_submit）统一调用。
 * 1. 落盘前先完成全部文件名、后缀、非空、单文件体积、备注与活跃队列容量预检；
 * 2. 若中途任何一步失败，自动调用 cleanupAbortedStagingBatchSync 清理未提交的 staging 目录，确保工作区零残留。
 */
export function submitDirectIngestBatch(
  host: DropTenantHost,
  input: {
    workspaceKeyOrId: string;
    tokenId: string;
    submitterName: string;
    note?: unknown;
    files: Array<{ fileName: string; data: Buffer }>;
  },
  now = Date.now(),
):
  | {
      ok: true;
      batchId: string;
      receiptToken: string;
      workspaceKey: string;
      workspaceTitle: string;
      meta: DropBatchMeta;
      queueEntry: IngestQueueEntry;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 413 | 429;
      error: string;
    } {
  const submitterCheck = sanitizeSubmitterName(input.submitterName);
  if (!submitterCheck.ok) {
    return { ok: false, status: 400, error: submitterCheck.error };
  }
  const noteCheck = sanitizeBatchNote(input.note);
  if (!noteCheck.ok) {
    return { ok: false, status: 400, error: noteCheck.error };
  }

  const wsRef = host.resolveWorkspace(input.workspaceKeyOrId.trim());
  if (!wsRef) {
    return { ok: false, status: 404, error: `找不到目标知识库工作区：${input.workspaceKeyOrId}` };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    return { ok: false, status: 403, error: kbCheck.error };
  }

  if (!Array.isArray(input.files) || input.files.length === 0) {
    return { ok: false, status: 400, error: "请至少提供一个待归档文件" };
  }
  if (input.files.length > MAX_FILES_PER_BATCH) {
    return { ok: false, status: 400, error: `单批次最多允许提交 ${MAX_FILES_PER_BATCH} 个文件` };
  }

  for (const f of input.files) {
    const nameCheck = isAllowedUploadFileName(f.fileName, kbCheck.config);
    if (!nameCheck.ok) {
      return { ok: false, status: 400, error: nameCheck.error };
    }
    if (!Buffer.isBuffer(f.data) || f.data.length === 0) {
      return { ok: false, status: 400, error: `文件 "${f.fileName}" 内容不能为空` };
    }
    if (f.data.length > kbCheck.config.maxFileBytes) {
      return {
        ok: false,
        status: 413,
        error: `文件 "${f.fileName}" 体积（${f.data.length} bytes）超过单文件上限（${kbCheck.config.maxFileBytes} bytes）`,
      };
    }
  }

  if (!hasIngestQueueCapacity(host)) {
    return { ok: false, status: 429, error: "当前排队归档的批次过多，请稍后再试" };
  }

  const creds = allocateDropBatchCredentials(now);
  const session: DropSessionGrant = {
    sessionToken: `ds_direct_${creds.batchId}`,
    qaSessionId: `qa_direct_${creds.batchId}`,
    tokenId: input.tokenId,
    tenantId: host.id,
    workspaceId: wsRef.workspaceId,
    workspaceKey: wsRef.key,
    workspacePath: kbCheck.workspaceRealPath,
    workspaceTitle: kbCheck.config.title,
    kbConfig: kbCheck.config,
    submitterName: submitterCheck.name,
    batchId: creds.batchId,
    receiptHash: creds.receiptHash,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  const created = createDropBatch(host, session, now, creds);
  if (!created.ok) {
    return { ok: false, status: 400, error: created.error };
  }

  for (const f of input.files) {
    const staged = stageFileIntoBatch(
      host,
      session,
      {
        batchId: creds.batchId,
        fileName: f.fileName,
        data: f.data,
      },
      now,
    );
    if (!staged.ok) {
      cleanupAbortedStagingBatchSync(host, kbCheck.workspaceRealPath, creds.batchId);
      return staged;
    }
  }

  const committed = commitDropBatchAndEnqueue(
    host,
    session,
    {
      batchId: creds.batchId,
      note: noteCheck.note,
    },
    now,
  );
  if (!committed.ok) {
    cleanupAbortedStagingBatchSync(host, kbCheck.workspaceRealPath, creds.batchId);
    return committed;
  }

  return {
    ok: true,
    batchId: creds.batchId,
    receiptToken: creds.receiptToken,
    workspaceKey: wsRef.key,
    workspaceTitle: kbCheck.config.title,
    meta: committed.meta,
    queueEntry: committed.queueEntry,
  };
}

/** 测试辅助：强制修改队列中某批次的状态与尝试次数（用于模拟网关在 processing 期间崩溃） */
export function forceQueueEntryStateForTest(
  ref: TenantRef,
  batchId: string,
  patch: Partial<Pick<IngestQueueEntry, "status" | "attempts" | "errorReason">>,
) {
  const lockFile = ingestStateLockPath(ref);
  withFileLockSync(lockFile, () => {
    const qData = readQueueFileUnlocked(ref);
    const found = qData.items.find((x) => x.batchId === batchId);
    if (!found) throw new Error(`batch not found in queue: ${batchId}`);
    Object.assign(found, patch);
    writeQueueFileUnlocked(ref, qData);
  });
}

/**
 * 网关启动时恢复中断的 processing 任务：
 * 若上次进程崩溃或重启时某批次处于 `processing`：
 * - 若尝试次数 < MAX_RETRY_ATTEMPTS，重置回 `queued` 重新调度；
 * - 若已达最大重试次数，标记为 `failed`（原文件保留在 inbox/<batchId>/ 不动）。
 */
export function recoverInterruptedIngestQueue(host: DropTenantHost, now = Date.now()): string[] {
  const lockFile = ingestStateLockPath(host);
  const workspaceIdsToDrain = new Set<string>();

  withFileLockSync(lockFile, () => {
    const qData = readQueueFileUnlocked(host);
    let mutated = false;
    for (const item of qData.items) {
      if (item.status === "processing") {
        mutated = true;
        const wsRef = host.resolveWorkspace(item.workspaceId) ?? host.resolveWorkspace(item.workspaceKeySnapshot);
        const kbCheck = wsRef ? loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot) : null;
        const metaRes = kbCheck && kbCheck.ok ? readBatchMetaSync(kbCheck.workspaceRealPath, item.batchId) : null;

        // 若此前 finalizeBatchStatus 已将 meta.json 写为终态（completed/partial/failed），在写队列前崩溃，直接把队列对齐到该终态，绝不重跑
        if (
          metaRes &&
          metaRes.ok &&
          (metaRes.meta.status === "completed" || metaRes.meta.status === "partial" || metaRes.meta.status === "failed")
        ) {
          item.status = metaRes.meta.status;
          item.finishedAt = metaRes.meta.finishedAt ?? now;
          if (metaRes.meta.errorReason) item.errorReason = metaRes.meta.errorReason;
        } else if (item.attempts < MAX_RETRY_ATTEMPTS && wsRef && kbCheck && kbCheck.ok) {
          item.status = "queued";
          workspaceIdsToDrain.add(item.workspaceId);
          if (metaRes && metaRes.ok) {
            metaRes.meta.status = "queued";
            metaRes.meta.statusMessage = fixedPublicStatusMessage("queued", metaRes.meta.files.length);
            metaRes.meta.updatedAt = now;
            writeBatchMetaSync(kbCheck.workspaceRealPath, metaRes.meta);
          }
        } else {
          item.status = "failed";
          item.finishedAt = now;
          item.errorReason = "归档任务在网关重启时中断且超过重试上限，原始文件已安全保留在 inbox 批次目录中";
          if (kbCheck && kbCheck.ok && metaRes && metaRes.ok) {
            metaRes.meta.status = "failed";
            metaRes.meta.statusMessage = fixedPublicStatusMessage("failed", metaRes.meta.files.length);
            metaRes.meta.errorReason = item.errorReason;
            metaRes.meta.finishedAt = now;
            metaRes.meta.updatedAt = now;
            writeBatchMetaSync(kbCheck.workspaceRealPath, metaRes.meta);
          }
        }
      } else if (item.status === "queued") {
        workspaceIdsToDrain.add(item.workspaceId);
        // 若此前在写完队列、尚未写完 meta.json 时崩溃，恢复时自动同步 meta.json
        const wsRef = host.resolveWorkspace(item.workspaceId) ?? host.resolveWorkspace(item.workspaceKeySnapshot);
        if (wsRef) {
          const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
          if (kbCheck.ok) {
            const metaRes = readBatchMetaSync(kbCheck.workspaceRealPath, item.batchId);
            if (metaRes.ok && metaRes.meta.status === "staging") {
              metaRes.meta.note = item.note;
              metaRes.meta.status = "queued";
              metaRes.meta.statusMessage = fixedPublicStatusMessage("queued", metaRes.meta.files.length);
              metaRes.meta.committedAt = item.queuedAt;
              metaRes.meta.updatedAt = now;
              writeBatchMetaSync(kbCheck.workspaceRealPath, metaRes.meta);
            }
          }
        }
      } else {
        // 若此前在写完终态队列（completed/partial/failed）、尚未写完 meta.json 时崩溃，恢复时自动将终态同步回 meta.json
        const wsRef = host.resolveWorkspace(item.workspaceId) ?? host.resolveWorkspace(item.workspaceKeySnapshot);
        if (wsRef) {
          const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
          if (kbCheck.ok) {
            const metaRes = readBatchMetaSync(kbCheck.workspaceRealPath, item.batchId);
            if (metaRes.ok && metaRes.meta.status !== item.status) {
              metaRes.meta.status = item.status;
              metaRes.meta.statusMessage = fixedPublicStatusMessage(item.status, metaRes.meta.files.length);
              metaRes.meta.updatedAt = now;
              metaRes.meta.finishedAt = item.finishedAt ?? now;
              if (item.errorReason) metaRes.meta.errorReason = item.errorReason;
              writeBatchMetaSync(kbCheck.workspaceRealPath, metaRes.meta);
            }
          }
        }
      }
    }
    if (mutated) {
      writeQueueFileUnlocked(host, qData);
    }
  });

  const list = [...workspaceIdsToDrain];
  for (const wsId of list) {
    void drainWorkspaceIngestQueue(host, wsId);
  }
  return list;
}

/**
 * 串行消费某个工作区队列中的所有 `queued` 批次（同一 workspaceId 严格单飞，并发度 = 1）
 */
export function drainWorkspaceIngestQueue(host: DropTenantHost, workspaceId: string): Promise<void> {
  if (!registeredWorker) return Promise.resolve();
  const lockKey = `${host.id}:${workspaceId}`;
  const prev = runningWorkspaces.get(lockKey) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await runWorkspaceQueueLoop(host, workspaceId);
    })
    .finally(() => {
      if (runningWorkspaces.get(lockKey) === next) {
        runningWorkspaces.delete(lockKey);
      }
    });
  runningWorkspaces.set(lockKey, next);
  return next;
}

async function runWorkspaceQueueLoop(host: DropTenantHost, workspaceId: string) {
  const lockFile = ingestStateLockPath(host);
  while (registeredWorker) {
    // 取队首 queued 任务并置为 processing
    const claimed = withFileLockSync(lockFile, () => {
      const qData = readQueueFileUnlocked(host);
      const nextEntry = qData.items.find((x) => x.workspaceId === workspaceId && x.status === "queued");
      if (!nextEntry) return null;
      nextEntry.status = "processing";
      nextEntry.attempts += 1;
      nextEntry.startedAt = Date.now();
      writeQueueFileUnlocked(host, qData);
      return { ...nextEntry };
    });

    if (!claimed) break;

    const wsRef = host.resolveWorkspace(workspaceId);
    const kbCheck = wsRef ? loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot) : null;
    if (!wsRef || !kbCheck || !kbCheck.ok) {
      finalizeBatchStatus(host, undefined, claimed.batchId, {
        status: "failed",
        statusMessage: fixedPublicStatusMessage("failed", 0),
        errorReason: kbCheck && !kbCheck.ok ? kbCheck.error : "工作区不可用",
      });
      continue;
    }

    const workspacePath = kbCheck.workspaceRealPath;
    const metaRes = readBatchMetaSync(workspacePath, claimed.batchId);
    if (!metaRes.ok) {
      finalizeBatchStatus(host, workspacePath, claimed.batchId, {
        status: "failed",
        statusMessage: fixedPublicStatusMessage("failed", 0),
        errorReason: metaRes.error,
      });
      continue;
    }

    // 更新 meta.json 为 processing
    metaRes.meta.status = "processing";
    metaRes.meta.statusMessage = fixedPublicStatusMessage("processing", metaRes.meta.files.length);
    metaRes.meta.updatedAt = Date.now();
    writeBatchMetaSync(workspacePath, metaRes.meta);

    let workerOut: IngestWorkerResult;
    try {
      workerOut = await registeredWorker({
        host,
        entry: claimed,
        workspacePath,
        meta: metaRes.meta,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      workerOut = {
        status: "failed",
        statusMessage: fixedPublicStatusMessage("failed", metaRes.meta.files.length),
        errorReason: msg,
      };
    }

    finalizeBatchStatus(host, workspacePath, claimed.batchId, workerOut);
  }
}

function finalizeBatchStatus(
  host: DropTenantHost,
  workspacePath: string | undefined,
  batchId: string,
  result: IngestWorkerResult,
) {
  const now = Date.now();
  const lockFile = ingestStateLockPath(host);
  withFileLockSync(lockFile, () => {
    // 先写 meta.json 终态，再写队列终态：若中间崩溃，队列仍为 processing，重启恢复时会感知并同步
    if (workspacePath) {
      const metaRes = readBatchMetaSync(workspacePath, batchId);
      if (metaRes.ok) {
        const m: DropBatchMeta = {
          ...metaRes.meta,
          status: result.status as DropBatchStatus,
          statusMessage: fixedPublicStatusMessage(result.status as DropBatchStatus, metaRes.meta.files.length),
          updatedAt: now,
          finishedAt: now,
          ...(result.archivedPaths ? { archivedPaths: result.archivedPaths } : {}),
          ...(result.updatedHtmlPaths ? { updatedHtmlPaths: result.updatedHtmlPaths } : {}),
          ...(result.errorReason ? { errorReason: result.errorReason } : {}),
        };
        writeBatchMetaSync(workspacePath, m);
      }
    }
    const qData = readQueueFileUnlocked(host);
    const found = qData.items.find((x) => x.batchId === batchId);
    if (found) {
      found.status = result.status;
      found.finishedAt = now;
      if (result.errorReason) found.errorReason = result.errorReason;
      writeQueueFileUnlocked(host, qData);
    }
  });
}
