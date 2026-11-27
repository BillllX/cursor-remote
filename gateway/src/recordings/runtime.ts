// 租户长录音运行时与持久化后台整理 Worker
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { forgetMemory } from "../assistant/memory.ts";
import { log } from "../log.ts";
import type { Tenant } from "../tenants.ts";
import { getAsrAdapter, mergeChunkTranscriptSegments } from "./asr.ts";
import { sha256Hex } from "./canonical.ts";
import { deliverRecordingResult } from "./delivery.ts";
import { RecordingStore } from "./store.ts";
import { summarizeRecordingTranscript } from "./summarizer.ts";
import type { RecordingAudioFormat, RecordingJobRecord, RecordingPolicySnapshot } from "./types.ts";

const storeCache = new Map<string, { stateDir: string; store: RecordingStore }>();

export function getRecordingStore(tenant: Pick<Tenant, "id" | "stateDir">): RecordingStore {
  const existing = storeCache.get(tenant.id);
  if (existing && existing.stateDir === tenant.stateDir) {
    return existing.store;
  }
  if (existing) {
    existing.store.close();
  }
  const store = new RecordingStore(tenant.id, tenant.stateDir);
  storeCache.set(tenant.id, { stateDir: tenant.stateDir, store });
  return store;
}

export function closeRecordingStores() {
  for (const entry of storeCache.values()) {
    try {
      entry.store.close();
    } catch {
      // 忽略关闭异常
    }
  }
  storeCache.clear();
}

export type WorkerRunOptions = {
  leaseOwner?: string;
  llmSummarize?: (prompt: string) => Promise<string | null>;
};

/** 执行单个到期 Job（同时供定时轮询循环和单元测试直接驱动） */
export async function processNextRecordingJob(
  tenant: Tenant,
  store: RecordingStore,
  opts?: WorkerRunOptions,
): Promise<boolean> {
  const owner = opts?.leaseOwner ?? `worker-${process.pid}-${randomBytes(3).toString("hex")}`;
  const job = store.claimDueJob(owner);
  if (!job) return false;

  try {
    await executeJob(tenant, store, job, opts);
    store.completeJob(job.jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "处理失败";
    const retryable = err && typeof err === "object" && "retryable" in err ? Boolean((err as { retryable: unknown }).retryable) : true;
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "WORKER_ERROR";
    log.warn("recording worker job failed", tenant.id, job.sessionId, job.stage, code, message);
    store.failJob(job, { code, message, retryable });
  }
  return true;
}

async function executeJob(
  tenant: Tenant,
  store: RecordingStore,
  job: RecordingJobRecord,
  opts?: WorkerRunOptions,
) {
  if (job.stage === "purge") {
    const purged = store.executePurge(job.sessionId);
    for (const memoryId of purged.memoryIdsToForget) {
      try {
        forgetMemory(tenant, memoryId, "page");
      } catch {
        // 记忆可能已被用户手动删掉
      }
    }
    return;
  }

  if (!store.isGenerationActive(job.sessionId, job.generation)) {
    return;
  }

  const session = store.getSessionRow(job.sessionId);
  if (!session || session.generation !== job.generation) return;
  const policy = JSON.parse(session.policy_json) as RecordingPolicySnapshot;

  if (job.stage === "transcribe") {
    store.setProcessingStateIfActive(job.sessionId, job.generation, "transcribing");
    // 若端侧逐字稿已经后补上来，直接复用不再跑云端 ASR
    const existingTranscript = store.getLatestTranscript(job.sessionId, job.generation);
    if (existingTranscript) {
      store.tx(() => {
        if (!store.isGenerationActive(job.sessionId, job.generation)) return;
        store.enqueueJobTx({
          sessionId: job.sessionId,
          generation: job.generation,
          stage: "summarize",
          inputHash: sha256Hex(`${session.manifest_hash ?? ""}:t${existingTranscript.revision}:${session.coverage}`),
        });
      });
      return;
    }

    if (policy.asr !== "server_allowed") {
      throw Object.assign(new Error("当前录音未授权服务端转写，请等待手机端侧转写补传完成后再整理"), {
        code: "ON_DEVICE_TRANSCRIPT_REQUIRED",
        retryable: false,
      });
    }

    const adapter = getAsrAdapter();
    if (!adapter) {
      throw Object.assign(new Error("服务端暂未配置云端转写供应商；请开启手机本地边录边转，或配置服务端 ASR 适配器后重试"), {
        code: "ASR_PROVIDER_NOT_CONFIGURED",
        retryable: false,
      });
    }

    const chunks = store.listChunks(job.sessionId, job.generation);
    const format = JSON.parse(session.format_json) as RecordingAudioFormat;
    const chunkOutputs = [];
    for (const chunk of chunks) {
      if (!store.isGenerationActive(job.sessionId, job.generation)) return;
      const absPath = resolve(store.rootDir, chunk.rel_path);
      if (chunk.bytes > adapter.capabilities.maxBytes) {
        throw Object.assign(new Error(`音频段 ${chunk.seq} 超过 ASR 单段大小上限`), {
          code: "ASR_LIMIT_EXCEEDED",
          retryable: false,
        });
      }
      const res = await adapter.transcribeChunk({
        sessionId: job.sessionId,
        generation: job.generation,
        seq: chunk.seq,
        epochId: chunk.epoch_id,
        absPath,
        sha256: chunk.sha256,
        bytes: chunk.bytes,
        captureStartFrame: chunk.capture_start_frame,
        validFrameCount: chunk.valid_frame_count,
        format,
        localeHint: "zh-CN",
      });
      chunkOutputs.push({
        epochId: chunk.epoch_id,
        seq: chunk.seq,
        captureStartFrame: chunk.capture_start_frame,
        validFrameCount: chunk.valid_frame_count,
        segments: res.segments,
      });
    }

    if (!store.isGenerationActive(job.sessionId, job.generation)) return;
    const merged = mergeChunkTranscriptSegments(chunkOutputs, "zh-CN", {
      source: "server_asr",
      provider: adapter.capabilities.provider,
      model: adapter.capabilities.model,
      timestampGranularity: adapter.capabilities.timestampGranularity,
    });
    const saved = store.saveTranscript({
      sessionId: job.sessionId,
      generation: job.generation,
      payload: merged,
      actor: "worker:asr",
    });
    store.tx(() => {
      if (!store.isGenerationActive(job.sessionId, job.generation)) return;
      store.enqueueJobTx({
        sessionId: job.sessionId,
        generation: job.generation,
        stage: "summarize",
        inputHash: sha256Hex(`${session.manifest_hash ?? ""}:t${saved.transcriptRevision}:${session.coverage}`),
      });
    });
    return;
  }

  if (job.stage === "summarize") {
    store.setProcessingStateIfActive(job.sessionId, job.generation, "summarizing");
    const transcript = store.getLatestTranscript(job.sessionId, job.generation);
    if (!transcript) {
      throw Object.assign(new Error("缺少可供整理的逐字稿"), { code: "TRANSCRIPT_MISSING", retryable: false });
    }
    const audioExpired = Boolean(session.audio_expired || (session.raw_expires_at !== null && store.clock() > session.raw_expires_at));
    const result = await summarizeRecordingTranscript({
      tenant,
      sessionId: job.sessionId,
      generation: job.generation,
      transcriptRevision: transcript.revision,
      coverage: session.coverage,
      route: { kind: session.route_kind, workspaceId: session.workspace_id },
      titleHint: session.title ?? undefined,
      transcript: transcript.payload,
      missingRanges: JSON.parse(session.missing_ranges_json),
      audioAvailable: Boolean(session.audio_uploaded) && !audioExpired,
      audioExpired,
      memoryEnabled: policy.memory === "confirm_only",
      llmSummarize: opts?.llmSummarize,
    });
    // 提交前再次检查 generation 与 tombstone，删除后绝不复活
    store.saveResultAndQueueDelivery(job.sessionId, job.generation, result);
    return;
  }

  if (job.stage === "deliver") {
    store.setProcessingStateIfActive(job.sessionId, job.generation, "delivering");
    const current = store.getResult(job.sessionId);
    if (!current.ready) return;
    const receipt = await deliverRecordingResult({
      tenant,
      route: { kind: session.route_kind, workspaceId: session.workspace_id },
      result: current.result,
    });
    if (receipt.status !== "acknowledged") {
      throw Object.assign(new Error(receipt.error || "交付未确认"), { code: "DELIVERY_FAILED", retryable: true });
    }
    store.recordDeliveryAck({
      sessionId: job.sessionId,
      generation: job.generation,
      resultRevision: current.result.resultRevision,
      route: { kind: session.route_kind, workspaceId: session.workspace_id },
      receipt,
    });
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

/** 启动长录音后台整理轮询与保留期定时清理 */
export function startRecordingsRuntime(deps: { tenants: () => Tenant[] }) {
  if (pollTimer) return;
  const leaseOwner = `gw-${process.pid}`;
  pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void (async () => {
      try {
        for (const tenant of deps.tenants()) {
          const store = getRecordingStore(tenant);
          let processed = 0;
          while (processed < 4) {
            const did = await processNextRecordingJob(tenant, store, { leaseOwner });
            if (!did) break;
            processed += 1;
          }
        }
      } catch (err) {
        log.warn("recordings worker poll error", err instanceof Error ? err.message : err);
      } finally {
        polling = false;
      }
    })();
  }, 2_000);
  pollTimer.unref();

  retentionTimer = setInterval(() => {
    for (const tenant of deps.tenants()) {
      try {
        const store = getRecordingStore(tenant);
        const swept = store.sweepRetention();
        if (swept.expiredAudioSessions || swept.expiredTextSessions) {
          log.info("recordings retention sweep", tenant.id, swept.expiredAudioSessions, swept.expiredTextSessions);
        }
      } catch (err) {
        log.warn("recordings retention sweep failed", tenant.id, err instanceof Error ? err.message : err);
      }
    }
  }, 15 * 60_000);
  retentionTimer.unref();
}

export function stopRecordingsRuntime() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  closeRecordingStores();
}
