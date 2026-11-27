// 租户独立的长录音 SQLite WAL 存储与原子文件管理器
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isInside } from "../pathInside.ts";
import { computeManifestHash, computePolicyHash, sha256Hex } from "./canonical.ts";
import { isSha256Hex, isValidUuidLike, RecordingError } from "./errors.ts";
import { initializeRecordingSchema } from "./schema.ts";
import {
  RECORDING_CANONICAL_SAMPLE_RATE,
  RECORDING_DEFAULT_GRANT_TTL_MS,
  RECORDING_DEFAULT_TENANT_QUOTA_BYTES,
  RECORDING_MAX_CHUNK_BYTES,
  RECORDING_MAX_CHUNKS,
  RECORDING_MAX_DURATION_FRAMES,
  RECORDING_MAX_PROVISIONAL_PER_DEVICE,
  RECORDING_MAX_TOTAL_BYTES,
  type RecordingAudioFormat,
  type RecordingCaptureState,
  type RecordingCoverage,
  type RecordingDeletionStatus,
  type RecordingDeliveryReceipt,
  type RecordingGrantRecord,
  type RecordingJobRecord,
  type RecordingJobStage,
  type RecordingManifest,
  type RecordingMissingRange,
  type RecordingPolicySnapshot,
  type RecordingProcessingState,
  type RecordingResultPayload,
  type RecordingRoute,
  type RecordingSessionStatusView,
  type RecordingTranscriptPayload,
  type RecordingTransferState,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

export type SessionRow = {
  session_id: string;
  device_id: string;
  generation: number;
  revision: number;
  provisional: number;
  title: string | null;
  created_at: number;
  started_at: number;
  stopped_at: number | null;
  route_kind: "personal" | "workspace";
  workspace_id: string | null;
  policy_json: string;
  policy_hash: string;
  format_json: string;
  capture_state: RecordingCaptureState;
  transfer_state: RecordingTransferState;
  processing_state: RecordingProcessingState;
  coverage: RecordingCoverage;
  expected_chunks: number;
  expected_total_frames: number;
  expected_total_bytes: number;
  audio_uploaded: number;
  audio_expired: number;
  raw_expires_at: number | null;
  text_expires_at: number | null;
  manifest_hash: string | null;
  transcript_revision: number;
  result_revision: number | null;
  missing_ranges_json: string;
  last_error_json: string | null;
  next_attempt_at: number | null;
  updated_at: number;
};

export type ChunkRow = {
  session_id: string;
  generation: number;
  seq: number;
  epoch_id: string;
  capture_start_frame: number;
  valid_frame_count: number;
  bytes: number;
  sha256: string;
  mime: string;
  rel_path: string;
  receipt_id: string;
  created_at: number;
  expired: number;
};

type TombstoneRow = {
  session_id: string;
  generation: number;
  deleted_at: number;
  delete_linked_memories: number;
  objects_purged: number;
  index_purged: number;
  deliveries_revoked: number;
  local_cleanup_acked: number;
};

type GrantRow = {
  grant_id: string;
  token_hash: string;
  device_id: string;
  namespace_prefix: string;
  route_kind: "personal" | "workspace";
  workspace_id: string | null;
  policy_json: string;
  policy_hash: string;
  max_chunk_bytes: number;
  max_total_bytes: number;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
};

export function normalizePolicySnapshot(raw: Partial<RecordingPolicySnapshot> | undefined): RecordingPolicySnapshot {
  const rawDays = Number.isInteger(raw?.rawRetentionDays)
    ? Math.max(1, Math.min(365, raw!.rawRetentionDays!))
    : 30;
  const textDays = Number.isInteger(raw?.textRetentionDays)
    ? Math.max(rawDays, Math.min(3650, raw!.textRetentionDays!))
    : 90;
  const asr =
    raw?.asr === "on_device_only" || raw?.asr === "server_allowed" || raw?.asr === "on_device_preferred"
      ? raw.asr
      : "on_device_preferred";
  return {
    version: Number.isInteger(raw?.version) && raw!.version! > 0 ? raw!.version! : 1,
    network: raw?.network === "wifi_and_cellular" ? "wifi_and_cellular" : "wifi_only",
    asr,
    syncAudio: raw?.syncAudio !== false,
    uploadDuringRecording: raw?.uploadDuringRecording === true,
    rawRetentionDays: rawDays,
    textRetentionDays: textDays,
    memory: raw?.memory === "disabled" ? "disabled" : "confirm_only",
    reminders: "explicit_only",
  };
}

export function normalizeFormat(raw: Partial<RecordingAudioFormat> | undefined): RecordingAudioFormat {
  return {
    codec: raw?.codec === "pcm_s16le" ? "pcm_s16le" : "aac_lc",
    container: raw?.container === "caf" ? "caf" : "m4a",
    sampleRate:
      Number.isInteger(raw?.sampleRate) && raw!.sampleRate! > 0
        ? raw!.sampleRate!
        : RECORDING_CANONICAL_SAMPLE_RATE,
    channels: raw?.channels === 2 ? 2 : 1,
    bitrate: Number.isInteger(raw?.bitrate) && raw!.bitrate! > 0 ? raw!.bitrate! : 64_000,
  };
}

export class RecordingStore {
  readonly tenantId: string;
  readonly rootDir: string;
  readonly chunksDir: string;
  readonly tmpDir: string;
  readonly db: DatabaseSync;
  readonly quotaBytes: number;
  readonly clock: () => number;

  constructor(
    tenantId: string,
    stateDir: string,
    opts?: { quotaBytes?: number; clock?: () => number },
  ) {
    this.tenantId = tenantId;
    this.rootDir = resolve(stateDir, "recordings");
    this.chunksDir = resolve(this.rootDir, "chunks");
    this.tmpDir = resolve(this.rootDir, "tmp");
    this.quotaBytes = opts?.quotaBytes ?? RECORDING_DEFAULT_TENANT_QUOTA_BYTES;
    this.clock = opts?.clock ?? Date.now;

    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.chunksDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });

    const dbPath = join(this.rootDir, "recordings.sqlite");
    this.db = new DatabaseSync(dbPath);
    initializeRecordingSchema(this.db);
    for (const name of ["recordings.sqlite", "recordings.sqlite-wal", "recordings.sqlite-shm"]) {
      try {
        chmodSync(join(this.rootDir, name), 0o600);
      } catch {
        // WAL 文件尚未生成时忽略
      }
    }
  }

  close() {
    this.db.close();
  }

  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }

  exec(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  audit(sessionId: string | null, generation: number | null, actor: string, action: string, result: string, reason?: string) {
    this.exec(
      `INSERT INTO recording_audit (session_id, generation, actor, action, result, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      generation,
      actor,
      action,
      result,
      reason ?? null,
      this.clock(),
    );
  }

  usedBytes(): number {
    const row = this.one<{ total: number }>(
      "SELECT COALESCE(SUM(bytes), 0) AS total FROM recording_chunks WHERE expired = 0",
    );
    return Number(row?.total ?? 0);
  }

  remainingQuotaBytes(): number {
    return Math.max(0, this.quotaBytes - this.usedBytes());
  }

  // MARK: - Upload Grants（短期作用域上传授权）

  issueUploadGrant(input: {
    deviceId: string;
    route: RecordingRoute;
    policySnapshot: Partial<RecordingPolicySnapshot>;
    namespacePrefix?: string;
    ttlMs?: number;
  }): { grant: string; grantId: string; expiresAt: string; policyHash: string; limits: { maxChunkBytes: number; maxChunks: number; maxTotalBytes: number } } {
    const deviceId = input.deviceId.trim();
    if (!deviceId || deviceId.length > 128) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "设备标识无效" });
    }
    if (input.route.kind === "workspace" && !input.route.workspaceId?.trim()) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "项目路由必须指定目标工作区" });
    }
    const policy = normalizePolicySnapshot(input.policySnapshot);
    const policyHash = computePolicyHash(policy);
    const now = this.clock();
    const ttl = Math.max(60_000, Math.min(7 * DAY_MS, input.ttlMs ?? RECORDING_DEFAULT_GRANT_TTL_MS));
    const expiresAt = now + ttl;
    const grantId = `gr_${randomBytes(10).toString("hex")}`;
    const rawToken = `jbrg_${randomBytes(32).toString("base64url")}`;
    const tokenHash = sha256Hex(rawToken);
    const namespacePrefix = (input.namespacePrefix || `dev:${deviceId}`).slice(0, 128);

    this.tx(() => {
      this.exec(
        `INSERT INTO recording_upload_grants
          (grant_id, token_hash, device_id, namespace_prefix, route_kind, workspace_id, policy_json, policy_hash, max_chunk_bytes, max_total_bytes, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        grantId,
        tokenHash,
        deviceId,
        namespacePrefix,
        input.route.kind,
        input.route.kind === "workspace" ? input.route.workspaceId : null,
        JSON.stringify(policy),
        policyHash,
        RECORDING_MAX_CHUNK_BYTES,
        RECORDING_MAX_TOTAL_BYTES,
        expiresAt,
        now,
      );
      this.audit(null, null, `device:${deviceId}`, "issue_upload_grant", "ok", grantId);
    });

    return {
      grant: rawToken,
      grantId,
      expiresAt: new Date(expiresAt).toISOString(),
      policyHash,
      limits: {
        maxChunkBytes: RECORDING_MAX_CHUNK_BYTES,
        maxChunks: RECORDING_MAX_CHUNKS,
        maxTotalBytes: RECORDING_MAX_TOTAL_BYTES,
      },
    };
  }

  verifyUploadGrant(rawToken: string): RecordingGrantRecord {
    if (!rawToken || !rawToken.startsWith("jbrg_")) {
      throw new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "上传凭证无效，请刷新授权" });
    }
    const row = this.one<GrantRow>(
      "SELECT * FROM recording_upload_grants WHERE token_hash = ?",
      sha256Hex(rawToken),
    );
    if (!row) {
      throw new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "上传凭证不存在或已失效" });
    }
    if (row.revoked_at !== null) {
      throw new RecordingError({ status: 403, code: "SCOPE_DENIED", message: "上传授权已被撤销" });
    }
    if (this.clock() > row.expires_at) {
      throw new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "上传凭证已过期，请刷新授权" });
    }
    return {
      grantId: row.grant_id,
      tokenHash: row.token_hash,
      tenantId: this.tenantId,
      deviceId: row.device_id,
      namespacePrefix: row.namespace_prefix,
      route: { kind: row.route_kind, workspaceId: row.workspace_id },
      policySnapshot: JSON.parse(row.policy_json) as RecordingPolicySnapshot,
      policyHash: row.policy_hash,
      maxChunkBytes: row.max_chunk_bytes,
      maxTotalBytes: row.max_total_bytes,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  revokeDeviceGrants(deviceId: string) {
    this.exec(
      "UPDATE recording_upload_grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
      this.clock(),
      deviceId,
    );
  }

  // MARK: - Sessions 创建与查询

  private assertNotDeleted(sessionId: string) {
    const tomb = this.one<TombstoneRow>("SELECT * FROM recording_tombstones WHERE session_id = ?", sessionId);
    if (tomb) {
      throw new RecordingError({
        status: 410,
        code: "DELETED",
        message: "这条录音已删除，不可继续读写",
      });
    }
  }

  createOrGetSession(input: {
    sessionId: string;
    deviceId: string;
    title?: string;
    startedAt?: string;
    route: RecordingRoute;
    policySnapshot?: Partial<RecordingPolicySnapshot>;
    format?: Partial<RecordingAudioFormat>;
  }): { created: boolean; session: RecordingSessionStatusView } {
    if (!isValidUuidLike(input.sessionId)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "sessionId 必须是标准 UUID" });
    }
    const deviceId = input.deviceId.trim();
    if (!deviceId || deviceId.length > 128) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "deviceId 无效" });
    }
    if (input.route.kind === "workspace" && !input.route.workspaceId?.trim()) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "项目录音必须指定工作区" });
    }
    const policy = normalizePolicySnapshot(input.policySnapshot);
    const policyHash = computePolicyHash(policy);
    const format = normalizeFormat(input.format);
    const now = this.clock();
    const startedMs = input.startedAt ? Date.parse(input.startedAt) || now : now;

    return this.tx(() => {
      this.assertNotDeleted(input.sessionId);
      const existing = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
      if (existing) {
        if (existing.device_id !== deviceId) {
          throw new RecordingError({
            status: 409,
            code: "SESSION_CONFLICT",
            message: "sessionId 已被其他设备占用，禁止复用",
            revision: existing.revision,
          });
        }
        return { created: false, session: this.buildStatusView(existing) };
      }

      const rawExpires = now + policy.rawRetentionDays * DAY_MS;
      const textExpires = now + policy.textRetentionDays * DAY_MS;
      this.exec(
        `INSERT INTO recording_sessions (
          session_id, device_id, generation, revision, provisional, title,
          created_at, started_at, stopped_at, route_kind, workspace_id,
          policy_json, policy_hash, format_json,
          capture_state, transfer_state, processing_state, coverage,
          expected_chunks, expected_total_frames, expected_total_bytes,
          audio_uploaded, audio_expired, raw_expires_at, text_expires_at,
          manifest_hash, transcript_revision, result_revision,
          missing_ranges_json, last_error_json, next_attempt_at, updated_at
        ) VALUES (?, ?, 1, 1, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'recording', 'local_only', 'not_started', 'none', 0, 0, 0, ?, 0, ?, ?, NULL, 0, NULL, '[]', NULL, NULL, ?)`,
        input.sessionId,
        deviceId,
        input.title?.trim().slice(0, 120) || null,
        now,
        startedMs,
        input.route.kind,
        input.route.kind === "workspace" ? input.route.workspaceId : null,
        JSON.stringify(policy),
        policyHash,
        JSON.stringify(format),
        policy.syncAudio ? 1 : 0,
        rawExpires,
        textExpires,
        now,
      );
      this.audit(input.sessionId, 1, `device:${deviceId}`, "create_session", "ok");
      const created = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId)!;
      return { created: true, session: this.buildStatusView(created) };
    });
  }

  private ensureProvisionalSessionTx(sessionId: string, grant: RecordingGrantRecord): SessionRow {
    this.assertNotDeleted(sessionId);
    const existing = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
    if (existing) {
      if (existing.device_id !== grant.deviceId) {
        throw new RecordingError({ status: 403, code: "SCOPE_DENIED", message: "上传凭证设备与录音归属不一致" });
      }
      return existing;
    }

    const provisionalCount = Number(
      this.one<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM recording_sessions WHERE device_id = ? AND provisional = 1",
        grant.deviceId,
      )?.cnt ?? 0,
    );
    if (provisionalCount >= RECORDING_MAX_PROVISIONAL_PER_DEVICE) {
      throw new RecordingError({
        status: 429,
        code: "RATE_LIMITED",
        message: "该设备待提交清单的临时录音数已达上限，请先完成前一条同步",
        retryable: true,
        retryAfterSeconds: 30,
      });
    }

    const now = this.clock();
    const policy = grant.policySnapshot;
    const rawExpires = now + policy.rawRetentionDays * DAY_MS;
    const textExpires = now + policy.textRetentionDays * DAY_MS;
    this.exec(
      `INSERT INTO recording_sessions (
        session_id, device_id, generation, revision, provisional, title,
        created_at, started_at, stopped_at, route_kind, workspace_id,
        policy_json, policy_hash, format_json,
        capture_state, transfer_state, processing_state, coverage,
        expected_chunks, expected_total_frames, expected_total_bytes,
        audio_uploaded, audio_expired, raw_expires_at, text_expires_at,
        manifest_hash, transcript_revision, result_revision,
        missing_ranges_json, last_error_json, next_attempt_at, updated_at
      ) VALUES (?, ?, 1, 1, 1, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'sealed', 'uploading', 'not_started', 'none', 0, 0, 0, ?, 0, ?, ?, NULL, 0, NULL, '[]', NULL, NULL, ?)`,
      sessionId,
      grant.deviceId,
      now,
      now,
      grant.route.kind,
      grant.route.workspaceId,
      JSON.stringify(policy),
      grant.policyHash,
      JSON.stringify(normalizeFormat(undefined)),
      policy.syncAudio ? 1 : 0,
      rawExpires,
      textExpires,
      now,
    );
    this.audit(sessionId, 1, `grant:${grant.grantId}`, "create_provisional_session", "ok");
    return this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId)!;
  }

  /** 预检 chunk 上传权限、tombstone、generation 与配额（在读流之前调用） */
  precheckChunkUpload(input: {
    sessionId: string;
    seq: number;
    generation: number;
    declaredBytes?: number;
    grant?: RecordingGrantRecord;
    deviceId?: string;
  }) {
    if (!isValidUuidLike(input.sessionId)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "sessionId 无效" });
    }
    if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq >= RECORDING_MAX_CHUNKS) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "音频段序号超出允许范围" });
    }
    if (!Number.isInteger(input.generation) || input.generation < 1) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "generation 无效" });
    }
    this.assertNotDeleted(input.sessionId);

    const existing = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
    if (existing) {
      if (existing.processing_state === "deleting" || existing.processing_state === "deleted") {
        throw new RecordingError({ status: 410, code: "DELETED", message: "录音已删除" });
      }
      if (input.grant && existing.device_id !== input.grant.deviceId) {
        throw new RecordingError({ status: 403, code: "SCOPE_DENIED", message: "凭证设备不匹配" });
      }
      if (existing.generation !== input.generation) {
        throw new RecordingError({
          status: 409,
          code: "GENERATION_STALE",
          message: "录音版本已变更，请先对账后再上传",
          state: this.stateOf(existing),
          revision: existing.revision,
        });
      }
    }

    const maxChunk = input.grant?.maxChunkBytes ?? RECORDING_MAX_CHUNK_BYTES;
    if (input.declaredBytes !== undefined && input.declaredBytes > maxChunk) {
      throw new RecordingError({
        status: 413,
        code: "CHUNK_TOO_LARGE",
        message: "单个音频段超过 8MiB 上限，请细分或调整码率后重试",
      });
    }
    if (input.declaredBytes !== undefined && input.declaredBytes > this.remainingQuotaBytes()) {
      throw new RecordingError({
        status: 507,
        code: "QUOTA_EXCEEDED",
        message: "私有录音存储空间不足，原音已保留在手机本机",
      });
    }
  }

  /** 将已流式落盘的临时音频段校验并原子提交到租户私有目录 */
  commitChunkFile(input: {
    sessionId: string;
    generation: number;
    seq: number;
    epochId: string;
    captureStartFrame: number;
    validFrameCount: number;
    sha256: string;
    bytes: number;
    mime: string;
    tmpFilePath: string;
    grant?: RecordingGrantRecord;
    actor: string;
  }): {
    sessionId: string;
    generation: number;
    seq: number;
    state: "durable";
    sha256: string;
    bytes: number;
    receiptId: string;
    revision: number;
    replayed: boolean;
    autoFinalized: boolean;
  } {
    if (!isSha256Hex(input.sha256)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "SHA-256 校验值格式无效" });
    }
    if (input.bytes <= 0 || input.bytes > RECORDING_MAX_CHUNK_BYTES) {
      throw new RecordingError({ status: 413, code: "CHUNK_TOO_LARGE", message: "音频段大小无效或超过 8MiB" });
    }
    if (!Number.isInteger(input.captureStartFrame) || input.captureStartFrame < 0 || !Number.isInteger(input.validFrameCount) || input.validFrameCount <= 0) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "音频段帧偏移或帧数无效" });
    }

    const sessionChunkDir = resolve(this.chunksDir, input.sessionId);
    if (!isInside(sessionChunkDir, this.chunksDir)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "非法的会话目录" });
    }

    const relPath = `chunks/${input.sessionId}/g${input.generation}-s${String(input.seq).padStart(4, "0")}-${input.sha256.slice(0, 16)}.m4a`;
    const finalPath = resolve(this.rootDir, relPath);
    if (!isInside(finalPath, this.chunksDir)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "非法的目标路径" });
    }

    let movedTmp = false;
    try {
      const result = this.tx(() => {
        this.assertNotDeleted(input.sessionId);
        let session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
        if (!session) {
          if (!input.grant) {
            throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音会话不存在" });
          }
          session = this.ensureProvisionalSessionTx(input.sessionId, input.grant);
        }
        if (session.processing_state === "deleting" || session.processing_state === "deleted") {
          throw new RecordingError({ status: 410, code: "DELETED", message: "录音已删除" });
        }
        if (session.generation !== input.generation) {
          throw new RecordingError({
            status: 409,
            code: "GENERATION_STALE",
            message: "录音版本已变更，拒绝旧版本音频段",
            state: this.stateOf(session),
            revision: session.revision,
          });
        }

        const existingChunk = this.one<ChunkRow>(
          "SELECT * FROM recording_chunks WHERE session_id = ? AND generation = ? AND seq = ?",
          input.sessionId,
          input.generation,
          input.seq,
        );
        if (existingChunk) {
          if (existingChunk.sha256 === input.sha256 && existingChunk.bytes === input.bytes) {
            return {
              sessionId: input.sessionId,
              generation: input.generation,
              seq: input.seq,
              state: "durable" as const,
              sha256: existingChunk.sha256,
              bytes: existingChunk.bytes,
              receiptId: existingChunk.receipt_id,
              revision: session.revision,
              replayed: true,
              autoFinalized: false,
            };
          }
          throw new RecordingError({
            status: 409,
            code: "HASH_CONFLICT",
            message: "同一音频段序号已存在不同内容，拒绝覆盖",
            state: this.stateOf(session),
            revision: session.revision,
          });
        }

        // 检查会话总字节上限与租户配额
        const sessionBytes = Number(
          this.one<{ total: number }>(
            "SELECT COALESCE(SUM(bytes), 0) AS total FROM recording_chunks WHERE session_id = ? AND generation = ? AND expired = 0",
            input.sessionId,
            input.generation,
          )?.total ?? 0,
        );
        if (sessionBytes + input.bytes > RECORDING_MAX_TOTAL_BYTES) {
          throw new RecordingError({ status: 413, code: "CHUNK_TOO_LARGE", message: "单场录音累计体积超出上限" });
        }
        if (input.bytes > this.remainingQuotaBytes()) {
          throw new RecordingError({ status: 507, code: "QUOTA_EXCEEDED", message: "租户录音存储配额已满" });
        }

        mkdirSync(sessionChunkDir, { recursive: true, mode: 0o700 });
        renameSync(input.tmpFilePath, finalPath);
        movedTmp = true;

        const now = this.clock();
        const receiptId = `rcpt_${randomBytes(12).toString("hex")}`;
        this.exec(
          `INSERT INTO recording_chunks
            (session_id, generation, seq, epoch_id, capture_start_frame, valid_frame_count, bytes, sha256, mime, rel_path, receipt_id, created_at, expired)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          input.sessionId,
          input.generation,
          input.seq,
          input.epochId.slice(0, 64),
          input.captureStartFrame,
          input.validFrameCount,
          input.bytes,
          input.sha256,
          input.mime,
          relPath,
          receiptId,
          now,
        );

        const nextRev = session.revision + 1;
        this.exec(
          `UPDATE recording_sessions
             SET revision = ?,
                 transfer_state = CASE WHEN transfer_state = 'local_only' THEN 'uploading' ELSE transfer_state END,
                 updated_at = ?
           WHERE session_id = ?`,
          nextRev,
          now,
          input.sessionId,
        );
        this.audit(input.sessionId, input.generation, input.actor, "commit_chunk", "ok", `seq=${input.seq}`);

        // 如果最终 manifest 早已到达，尝试自动 CAS finalize
        const finalized = this.tryAutoFinalizeTx(input.sessionId, input.generation);
        const refreshed = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId)!;

        return {
          sessionId: input.sessionId,
          generation: input.generation,
          seq: input.seq,
          state: "durable" as const,
          sha256: input.sha256,
          bytes: input.bytes,
          receiptId,
          revision: refreshed.revision,
          replayed: false,
          autoFinalized: finalized,
        };
      });
      return result;
    } catch (err) {
      if (movedTmp) {
        try {
          unlinkSync(finalPath);
        } catch {
          // 事务回滚清理
        }
      }
      throw err;
    } finally {
      if (!movedTmp && existsSync(input.tmpFilePath)) {
        try {
          unlinkSync(input.tmpFilePath);
        } catch {
          // 忽略
        }
      }
    }
  }

  // MARK: - 端侧逐字稿上传（支持边录边转后单独提交，也可随 manifest 内联提交）

  saveTranscript(input: {
    sessionId: string;
    generation: number;
    payload: RecordingTranscriptPayload;
    grant?: RecordingGrantRecord;
    actor: string;
  }): { sessionId: string; generation: number; transcriptRevision: number; replayed: boolean; autoFinalized: boolean } {
    if (!isValidUuidLike(input.sessionId)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "sessionId 无效" });
    }
    this.validateTranscriptPayload(input.payload);
    const inputHash = sha256Hex(JSON.stringify(input.payload));

    return this.tx(() => {
      this.assertNotDeleted(input.sessionId);
      let session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
      if (!session) {
        if (!input.grant) {
          throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音会话不存在" });
        }
        session = this.ensureProvisionalSessionTx(input.sessionId, input.grant);
      }
      if (input.grant && (session.device_id !== input.grant.deviceId || session.policy_hash !== input.grant.policyHash)) {
        throw new RecordingError({ status: 403, code: "SCOPE_DENIED", message: "上传授权与录音归属或策略不一致" });
      }
      if (session.generation !== input.generation) {
        throw new RecordingError({
          status: 409,
          code: "GENERATION_STALE",
          message: "录音版本已变更",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }

      const existingSame = this.one<{ revision: number }>(
        "SELECT revision FROM recording_transcripts WHERE session_id = ? AND generation = ? AND input_hash = ?",
        input.sessionId,
        input.generation,
        inputHash,
      );
      if (existingSame) {
        return {
          sessionId: input.sessionId,
          generation: input.generation,
          transcriptRevision: existingSame.revision,
          replayed: true,
          autoFinalized: false,
        };
      }

      const nextTranscriptRev = session.transcript_revision + 1;
      const now = this.clock();
      this.exec(
        `INSERT INTO recording_transcripts
          (session_id, generation, revision, source, locale, granularity, payload_json, input_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.sessionId,
        input.generation,
        nextTranscriptRev,
        input.payload.source,
        input.payload.locale,
        input.payload.timestampGranularity,
        JSON.stringify(input.payload),
        inputHash,
        now,
      );
      this.exec(
        "UPDATE recording_sessions SET transcript_revision = ?, revision = revision + 1, updated_at = ? WHERE session_id = ?",
        nextTranscriptRev,
        now,
        input.sessionId,
      );
      this.audit(input.sessionId, input.generation, input.actor, "save_transcript", "ok", `rev=${nextTranscriptRev}`);
      const finalized = this.tryAutoFinalizeTx(input.sessionId, input.generation);
      return {
        sessionId: input.sessionId,
        generation: input.generation,
        transcriptRevision: nextTranscriptRev,
        replayed: false,
        autoFinalized: finalized,
      };
    });
  }

  private validateTranscriptPayload(payload: RecordingTranscriptPayload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.segments)) {
      throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "逐字稿格式缺少 segments 数组" });
    }
    for (const seg of payload.segments) {
      if (
        !seg ||
        typeof seg.segmentId !== "string" ||
        !seg.segmentId.trim() ||
        !Number.isInteger(seg.startFrame) ||
        !Number.isInteger(seg.endFrame) ||
        seg.startFrame < 0 ||
        seg.endFrame < seg.startFrame ||
        typeof seg.text !== "string"
      ) {
        throw new RecordingError({ status: 422, code: "TIMELINE_INVALID", message: "逐字稿分段时间轴或内容不合法" });
      }
    }
  }

  // MARK: - Manifest 提交与自动 CAS finalize

  commitManifest(input: {
    sessionId: string;
    manifest: RecordingManifest;
    grant?: RecordingGrantRecord;
    actor: string;
  }): {
    statusCode: number;
    session: RecordingSessionStatusView;
    missingSeqs: number[];
    replayed: boolean;
  } {
    const manifest = input.manifest;
    if (!manifest || typeof manifest !== "object") {
      throw new RecordingError({ status: 400, code: "INVALID_MANIFEST", message: "清单 JSON 无效" });
    }
    if (manifest.sessionId !== input.sessionId || !isValidUuidLike(manifest.sessionId)) {
      throw new RecordingError({ status: 400, code: "INVALID_MANIFEST", message: "清单 sessionId 与路径不一致" });
    }
    if (!Number.isInteger(manifest.generation) || manifest.generation < 1) {
      throw new RecordingError({ status: 400, code: "INVALID_MANIFEST", message: "清单 generation 无效" });
    }
    if (!Array.isArray(manifest.chunks) || !Array.isArray(manifest.epochs) || !Array.isArray(manifest.timelineEvents) || !Array.isArray(manifest.missingRanges)) {
      throw new RecordingError({ status: 400, code: "INVALID_MANIFEST", message: "清单缺少必需数组字段" });
    }
    if (manifest.chunks.length > RECORDING_MAX_CHUNKS) {
      throw new RecordingError({ status: 400, code: "INVALID_MANIFEST", message: "清单段数超过 512 上限" });
    }
    if (!Number.isInteger(manifest.expectedTotalFrames) || manifest.expectedTotalFrames < 0 || manifest.expectedTotalFrames > RECORDING_MAX_DURATION_FRAMES) {
      throw new RecordingError({ status: 422, code: "TIMELINE_INVALID", message: "总帧数超出允许上限（最长 8 小时）" });
    }
    if (!Number.isInteger(manifest.expectedTotalBytes) || manifest.expectedTotalBytes < 0 || manifest.expectedTotalBytes > RECORDING_MAX_TOTAL_BYTES) {
      throw new RecordingError({ status: 413, code: "CHUNK_TOO_LARGE", message: "录音总字节数超过单场上限" });
    }

    // 校验 manifestHash（JCS 规范 JSON）
    const expectedHash = computeManifestHash(manifest);
    if (manifest.manifestHash && manifest.manifestHash !== expectedHash) {
      throw new RecordingError({ status: 422, code: "HASH_MISMATCH", message: "清单 manifestHash 校验不通过" });
    }
    const normalizedManifest: RecordingManifest = { ...manifest, manifestHash: expectedHash };

    // 校验 chunks 顺序、唯一性、字节与帧边界
    const audioUploaded = manifest.audioUploaded !== false;
    const seenSeq = new Set<number>();
    let sumBytes = 0;
    let prevEndFrame = 0;
    const sortedChunks = [...manifest.chunks].sort((a, b) => a.seq - b.seq);
    for (const chunk of sortedChunks) {
      if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || chunk.seq >= RECORDING_MAX_CHUNKS || seenSeq.has(chunk.seq)) {
        throw new RecordingError({ status: 422, code: "TIMELINE_INVALID", message: "清单中存在重复或非法 chunk seq" });
      }
      seenSeq.add(chunk.seq);
      if (audioUploaded) {
        if (!isSha256Hex(chunk.sha256) || !Number.isInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > RECORDING_MAX_CHUNK_BYTES) {
          throw new RecordingError({ status: 422, code: "INVALID_MANIFEST", message: `音频段 ${chunk.seq} 元数据或哈希无效` });
        }
        sumBytes += chunk.bytes;
      }
      if (!Number.isInteger(chunk.captureStartFrame) || !Number.isInteger(chunk.validFrameCount) || chunk.captureStartFrame < prevEndFrame || chunk.validFrameCount <= 0) {
        throw new RecordingError({ status: 422, code: "TIMELINE_INVALID", message: `音频段 ${chunk.seq} 时间轴重叠或无效` });
      }
      prevEndFrame = chunk.captureStartFrame + chunk.validFrameCount;
    }
    if (audioUploaded && sumBytes !== manifest.expectedTotalBytes) {
      throw new RecordingError({ status: 422, code: "INVALID_MANIFEST", message: "清单总字节数与各段之和不一致" });
    }
    if (audioUploaded && manifest.chunks.length === 0 && !manifest.onDeviceTranscript) {
      throw new RecordingError({ status: 400, code: "INVALID_MANIFEST", message: "空录音清单缺少音频段或端侧逐字稿" });
    }
    if (manifest.onDeviceTranscript) {
      this.validateTranscriptPayload(manifest.onDeviceTranscript);
    }

    return this.tx(() => {
      this.assertNotDeleted(input.sessionId);
      let session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
      if (!session) {
        if (!input.grant) {
          throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音会话不存在" });
        }
        session = this.ensureProvisionalSessionTx(input.sessionId, input.grant);
      }
      if (input.grant && (session.device_id !== input.grant.deviceId || session.policy_hash !== input.grant.policyHash)) {
        throw new RecordingError({ status: 403, code: "SCOPE_DENIED", message: "上传授权与录音归属或策略不一致" });
      }
      if (session.generation !== manifest.generation) {
        throw new RecordingError({
          status: 409,
          code: "GENERATION_STALE",
          message: "录音版本已变更，拒绝旧版本清单",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }
      if (manifest.policyHash && manifest.policyHash !== session.policy_hash) {
        throw new RecordingError({
          status: 409,
          code: "MANIFEST_CONFLICT",
          message: "清单策略哈希与会话授权不一致",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }

      const existingManifest = this.one<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM recording_manifests WHERE session_id = ? AND generation = ?",
        input.sessionId,
        manifest.generation,
      );
      if (existingManifest) {
        if (existingManifest.manifest_hash === expectedHash) {
          const view = this.buildStatusView(session);
          return { statusCode: 202, session: view, missingSeqs: view.missingSeqs, replayed: true };
        }
        throw new RecordingError({
          status: 409,
          code: "MANIFEST_CONFLICT",
          message: "同版本清单已锁定，不能覆盖；修改请走修订流程",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }

      const now = this.clock();
      // 若修订声明了 reuseReceiptId，把同租户同会话已校验段复制到新 generation
      if (audioUploaded) {
        for (const decl of sortedChunks) {
          if (!decl.reuseReceiptId) continue;
          const reused = this.one<ChunkRow>(
            "SELECT * FROM recording_chunks WHERE session_id = ? AND receipt_id = ? AND sha256 = ? AND expired = 0",
            input.sessionId,
            decl.reuseReceiptId,
            decl.sha256,
          );
          if (!reused) {
            throw new RecordingError({
              status: 422,
              code: "INVALID_MANIFEST",
              message: `无法复用音频段 ${decl.seq} 的凭据`,
            });
          }
          const already = this.one<ChunkRow>(
            "SELECT * FROM recording_chunks WHERE session_id = ? AND generation = ? AND seq = ?",
            input.sessionId,
            manifest.generation,
            decl.seq,
          );
          if (!already) {
            this.exec(
              `INSERT INTO recording_chunks
                (session_id, generation, seq, epoch_id, capture_start_frame, valid_frame_count, bytes, sha256, mime, rel_path, receipt_id, created_at, expired)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
              input.sessionId,
              manifest.generation,
              decl.seq,
              decl.epochId,
              decl.captureStartFrame,
              decl.validFrameCount,
              reused.bytes,
              reused.sha256,
              reused.mime,
              reused.rel_path,
              `rcpt_${randomBytes(12).toString("hex")}`,
              now,
            );
          }
        }
      }

      this.exec(
        `INSERT INTO recording_manifests (session_id, generation, manifest_hash, manifest_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.sessionId,
        manifest.generation,
        expectedHash,
        JSON.stringify(normalizedManifest),
        now,
      );

      // 如清单自带端侧逐字稿，同时入库为首个 transcript revision
      let transcriptRev = session.transcript_revision;
      if (normalizedManifest.onDeviceTranscript) {
        const tHash = sha256Hex(JSON.stringify(normalizedManifest.onDeviceTranscript));
        const same = this.one<{ revision: number }>(
          "SELECT revision FROM recording_transcripts WHERE session_id = ? AND generation = ? AND input_hash = ?",
          input.sessionId,
          manifest.generation,
          tHash,
        );
        if (!same) {
          transcriptRev += 1;
          this.exec(
            `INSERT INTO recording_transcripts
              (session_id, generation, revision, source, locale, granularity, payload_json, input_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.sessionId,
            manifest.generation,
            transcriptRev,
            normalizedManifest.onDeviceTranscript.source,
            normalizedManifest.onDeviceTranscript.locale,
            normalizedManifest.onDeviceTranscript.timestampGranularity,
            JSON.stringify(normalizedManifest.onDeviceTranscript),
            tHash,
            now,
          );
        }
      }

      const stoppedMs = Date.parse(normalizedManifest.stoppedAt) || now;
      const startedMs = normalizedManifest.startedAt ? Date.parse(normalizedManifest.startedAt) || session.started_at : session.started_at;
      const expectedChunks = audioUploaded ? normalizedManifest.chunks.length : 0;
      const coverage: RecordingCoverage =
        normalizedManifest.completeCapture && normalizedManifest.missingRanges.length === 0 ? "complete" : "partial";

      this.exec(
        `UPDATE recording_sessions
           SET provisional = 0,
               title = COALESCE(?, title),
               started_at = ?,
               stopped_at = ?,
               capture_state = 'sealed',
               transfer_state = CASE WHEN ? = 0 THEN 'durable' ELSE 'awaiting_chunks' END,
               coverage = ?,
               expected_chunks = ?,
               expected_total_frames = ?,
               expected_total_bytes = ?,
               audio_uploaded = ?,
               manifest_hash = ?,
               transcript_revision = ?,
               missing_ranges_json = ?,
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        normalizedManifest.title?.trim().slice(0, 120) || null,
        startedMs,
        stoppedMs,
        expectedChunks,
        coverage,
        expectedChunks,
        normalizedManifest.expectedTotalFrames,
        normalizedManifest.expectedTotalBytes,
        audioUploaded ? 1 : 0,
        expectedHash,
        transcriptRev,
        JSON.stringify(normalizedManifest.missingRanges),
        now,
        input.sessionId,
      );

      this.audit(input.sessionId, manifest.generation, input.actor, "commit_manifest", "ok", expectedHash.slice(0, 16));
      this.tryAutoFinalizeTx(input.sessionId, manifest.generation);

      const refreshed = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId)!;
      const view = this.buildStatusView(refreshed);
      return { statusCode: 202, session: view, missingSeqs: view.missingSeqs, replayed: false };
    });
  }

  /**
   * 事务内自动 finalize：
   * 1. 检查 manifest 是否已到；
   * 2. 若需上传原音，检查所有声明的 chunks 是否全部 durable 且 sha256/bytes 一致，且无未声明的额外段；
   * 3. 若不完整（completeCapture=false 或 missingRanges 非空），进入 partial_pending，不自动交付整场摘要；
   * 4. 若完整：若已有端侧逐字稿则直接写 summarize job，否则写 transcribe job（遵循策略禁止偷传云端 ASR）。
   */
  private tryAutoFinalizeTx(sessionId: string, generation: number): boolean {
    const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
    if (!session || session.generation !== generation) return false;
    if (
      session.processing_state !== "not_started" &&
      session.processing_state !== "partial_pending"
    ) {
      return false;
    }

    const mRow = this.one<{ manifest_hash: string; manifest_json: string }>(
      "SELECT manifest_hash, manifest_json FROM recording_manifests WHERE session_id = ? AND generation = ?",
      sessionId,
      generation,
    );
    if (!mRow) return false;
    const manifest = JSON.parse(mRow.manifest_json) as RecordingManifest;
    const audioUploaded = manifest.audioUploaded !== false;

    if (audioUploaded) {
      const uploaded = this.all<ChunkRow>(
        "SELECT * FROM recording_chunks WHERE session_id = ? AND generation = ? AND expired = 0",
        sessionId,
        generation,
      );
      const bySeq = new Map(uploaded.map((c) => [c.seq, c]));
      const declaredSeqs = new Set(manifest.chunks.map((c) => c.seq));
      // 检查是否缺段或哈希不一致
      for (const decl of manifest.chunks) {
        const actual = bySeq.get(decl.seq);
        if (!actual) return false;
        if (actual.sha256 !== decl.sha256 || actual.bytes !== decl.bytes) {
          this.exec(
            `UPDATE recording_sessions
               SET processing_state = 'needs_attention',
                   last_error_json = ?,
                   revision = revision + 1,
                   updated_at = ?
             WHERE session_id = ?`,
            JSON.stringify({
              code: "HASH_MISMATCH",
              message: `音频段 ${decl.seq} 校验与清单不一致`,
              retryable: false,
              at: new Date(this.clock()).toISOString(),
            }),
            this.clock(),
            sessionId,
          );
          return false;
        }
      }
      // 不允许存在未声明的多余段
      for (const actual of uploaded) {
        if (!declaredSeqs.has(actual.seq)) {
          this.exec(
            `UPDATE recording_sessions
               SET processing_state = 'needs_attention',
                   last_error_json = ?,
                   revision = revision + 1,
                   updated_at = ?
             WHERE session_id = ?`,
            JSON.stringify({
              code: "INVALID_MANIFEST",
              message: `发现清单未声明的音频段 ${actual.seq}`,
              retryable: false,
              at: new Date(this.clock()).toISOString(),
            }),
            this.clock(),
            sessionId,
          );
          return false;
        }
      }
    } else if (session.transcript_revision === 0) {
      // 仅传文本模式下，必须等逐字稿也到达
      return false;
    }

    const now = this.clock();
    const isComplete = manifest.completeCapture && manifest.missingRanges.length === 0;
    if (!isComplete) {
      this.exec(
        `UPDATE recording_sessions
           SET transfer_state = 'durable',
               processing_state = 'partial_pending',
               coverage = 'partial',
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        now,
        sessionId,
      );
      return false;
    }

    this.enqueueProcessingFromManifestTx(session, manifest, mRow.manifest_hash, "complete");
    return true;
  }

  private enqueueProcessingFromManifestTx(
    session: SessionRow,
    _manifest: RecordingManifest,
    manifestHash: string,
    coverage: RecordingCoverage,
  ) {
    const now = this.clock();
    const stage: RecordingJobStage = session.transcript_revision > 0 ? "summarize" : "transcribe";
    const inputHash =
      stage === "summarize"
        ? sha256Hex(`${manifestHash}:t${session.transcript_revision}:${coverage}`)
        : sha256Hex(`${manifestHash}:asr:${coverage}`);

    this.exec(
      `UPDATE recording_sessions
         SET transfer_state = 'durable',
             processing_state = 'queued',
             coverage = ?,
             last_error_json = NULL,
             revision = revision + 1,
             updated_at = ?
       WHERE session_id = ?`,
      coverage,
      now,
      session.session_id,
    );

    this.enqueueJobTx({
      sessionId: session.session_id,
      generation: session.generation,
      stage,
      inputHash,
    });
  }

  enqueueJobTx(input: {
    sessionId: string;
    generation: number;
    stage: RecordingJobStage;
    inputHash: string;
    maxAttempts?: number;
    delayMs?: number;
  }): string {
    const existing = this.one<{ job_id: string }>(
      `SELECT job_id FROM recording_jobs
       WHERE session_id = ? AND generation = ? AND stage = ? AND input_hash = ?`,
      input.sessionId,
      input.generation,
      input.stage,
      input.inputHash,
    );
    if (existing) return existing.job_id;
    const now = this.clock();
    const jobId = `rjob_${randomUUID().slice(0, 12)}`;
    this.exec(
      `INSERT INTO recording_jobs
        (job_id, session_id, generation, stage, input_hash, status, attempt, max_attempts, lease_owner, lease_until, next_attempt_at, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`,
      jobId,
      input.sessionId,
      input.generation,
      input.stage,
      input.inputHash,
      input.maxAttempts ?? 3,
      now + (input.delayMs ?? 0),
      now,
      now,
    );
    return jobId;
  }

  finalizeExplicit(sessionId: string, generation: number, manifestHash: string, actor: string): {
    statusCode: number;
    session: RecordingSessionStatusView;
    missingSeqs: number[];
  } {
    return this.tx(() => {
      this.assertNotDeleted(sessionId);
      const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
      if (!session) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音会话不存在" });
      if (session.generation !== generation) {
        throw new RecordingError({
          status: 409,
          code: "GENERATION_STALE",
          message: "录音版本已变更",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }
      if (!session.manifest_hash) {
        throw new RecordingError({
          status: 409,
          code: "MANIFEST_REQUIRED",
          message: "尚未提交最终清单，无法确认完成",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }
      if (manifestHash && session.manifest_hash !== manifestHash) {
        throw new RecordingError({
          status: 409,
          code: "MANIFEST_CONFLICT",
          message: "提供的 manifestHash 与服务端已锁定清单不一致",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }

      if (
        session.processing_state === "queued" ||
        session.processing_state === "transcribing" ||
        session.processing_state === "summarizing" ||
        session.processing_state === "delivering" ||
        session.processing_state === "delivered"
      ) {
        const view = this.buildStatusView(session);
        return { statusCode: 200, session: view, missingSeqs: view.missingSeqs };
      }

      this.tryAutoFinalizeTx(sessionId, generation);
      this.audit(sessionId, generation, actor, "finalize_explicit", "ok");
      const refreshed = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId)!;
      const view = this.buildStatusView(refreshed);
      const code = refreshed.processing_state === "queued" ? 200 : 202;
      return { statusCode: code, session: view, missingSeqs: view.missingSeqs };
    });
  }

  // MARK: - Accept Partial / Cancel / Retry / Revision / Delete

  acceptPartial(sessionId: string, expectedRevision: number | undefined, actor: string): RecordingSessionStatusView {
    return this.tx(() => {
      this.assertNotDeleted(sessionId);
      const session = this.requireSessionRevisionTx(sessionId, expectedRevision);
      if (session.processing_state !== "partial_pending") {
        throw new RecordingError({
          status: 409,
          code: "INVALID_STATE",
          message: "当前状态不是待确认的部分录音",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }
      const mRow = this.one<{ manifest_hash: string; manifest_json: string }>(
        "SELECT manifest_hash, manifest_json FROM recording_manifests WHERE session_id = ? AND generation = ?",
        sessionId,
        session.generation,
      );
      if (!mRow) {
        throw new RecordingError({ status: 409, code: "MANIFEST_REQUIRED", message: "缺少最终清单" });
      }
      const manifest = JSON.parse(mRow.manifest_json) as RecordingManifest;
      this.enqueueProcessingFromManifestTx(session, manifest, mRow.manifest_hash, "partial");
      this.audit(sessionId, session.generation, actor, "accept_partial", "ok");
      return this.buildStatusView(this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId)!);
    });
  }

  cancelProcessing(sessionId: string, expectedRevision: number | undefined, actor: string): RecordingSessionStatusView {
    return this.tx(() => {
      this.assertNotDeleted(sessionId);
      const session = this.requireSessionRevisionTx(sessionId, expectedRevision);
      const now = this.clock();
      this.exec(
        `UPDATE recording_jobs SET status = 'cancelled', updated_at = ?
         WHERE session_id = ? AND generation = ? AND status IN ('queued', 'running')`,
        now,
        sessionId,
        session.generation,
      );
      this.exec(
        `UPDATE recording_sessions
           SET processing_state = 'cancelled',
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        now,
        sessionId,
      );
      this.audit(sessionId, session.generation, actor, "cancel_processing", "ok");
      return this.buildStatusView(this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId)!);
    });
  }

  retryProcessing(sessionId: string, expectedRevision: number | undefined, stageHint: RecordingJobStage | undefined, actor: string): RecordingSessionStatusView {
    return this.tx(() => {
      this.assertNotDeleted(sessionId);
      const session = this.requireSessionRevisionTx(sessionId, expectedRevision);
      const now = this.clock();
      const mRow = this.one<{ manifest_hash: string; manifest_json: string }>(
        "SELECT manifest_hash, manifest_json FROM recording_manifests WHERE session_id = ? AND generation = ?",
        sessionId,
        session.generation,
      );
      if (!mRow) {
        throw new RecordingError({ status: 409, code: "MANIFEST_REQUIRED", message: "缺少最终清单，无法重试整理" });
      }

      let targetGen = session.generation;
      let targetManifestHash = mRow.manifest_hash;

      // cancelled 恢复时创建新 generation 继承已校验音频段与清单（不重传音频）
      if (session.processing_state === "cancelled") {
        targetGen = session.generation + 1;
        const manifest = JSON.parse(mRow.manifest_json) as RecordingManifest;
        const cloned: RecordingManifest = { ...manifest, generation: targetGen };
        targetManifestHash = computeManifestHash(cloned);
        cloned.manifestHash = targetManifestHash;

        this.exec(
          "INSERT INTO recording_manifests (session_id, generation, manifest_hash, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)",
          sessionId,
          targetGen,
          targetManifestHash,
          JSON.stringify(cloned),
          now,
        );
        const chunks = this.all<ChunkRow>(
          "SELECT * FROM recording_chunks WHERE session_id = ? AND generation = ? AND expired = 0",
          sessionId,
          session.generation,
        );
        for (const chunk of chunks) {
          this.exec(
            `INSERT INTO recording_chunks
              (session_id, generation, seq, epoch_id, capture_start_frame, valid_frame_count, bytes, sha256, mime, rel_path, receipt_id, created_at, expired)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            sessionId,
            targetGen,
            chunk.seq,
            chunk.epoch_id,
            chunk.capture_start_frame,
            chunk.valid_frame_count,
            chunk.bytes,
            chunk.sha256,
            chunk.mime,
            chunk.rel_path,
            `rcpt_${randomBytes(12).toString("hex")}`,
            now,
          );
        }
        // 复制最新逐字稿到新 generation
        const latestTranscript = this.one<{
          revision: number;
          source: string;
          locale: string;
          granularity: string;
          payload_json: string;
          input_hash: string;
        }>(
          "SELECT * FROM recording_transcripts WHERE session_id = ? AND generation = ? ORDER BY revision DESC LIMIT 1",
          sessionId,
          session.generation,
        );
        if (latestTranscript) {
          this.exec(
            `INSERT INTO recording_transcripts
              (session_id, generation, revision, source, locale, granularity, payload_json, input_hash, created_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
            sessionId,
            targetGen,
            latestTranscript.source,
            latestTranscript.locale,
            latestTranscript.granularity,
            latestTranscript.payload_json,
            latestTranscript.input_hash,
            now,
          );
        }
        this.exec(
          `UPDATE recording_sessions
             SET generation = ?,
                 manifest_hash = ?,
                 transcript_revision = ?,
                 processing_state = 'queued',
                 last_error_json = NULL,
                 revision = revision + 1,
                 updated_at = ?
           WHERE session_id = ?`,
          targetGen,
          targetManifestHash,
          latestTranscript ? 1 : 0,
          now,
          sessionId,
        );
      } else {
        this.exec(
          `UPDATE recording_sessions
             SET processing_state = 'queued',
                 last_error_json = NULL,
                 revision = revision + 1,
                 updated_at = ?
           WHERE session_id = ?`,
          now,
          sessionId,
        );
      }

      const refreshed = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId)!;
      const stage: RecordingJobStage =
        stageHint || (refreshed.transcript_revision > 0 ? "summarize" : "transcribe");
      const budgetSuffix = `retry_${randomBytes(4).toString("hex")}`;
      this.enqueueJobTx({
        sessionId,
        generation: targetGen,
        stage,
        inputHash: sha256Hex(`${targetManifestHash}:${stage}:${budgetSuffix}`),
      });
      this.audit(sessionId, targetGen, actor, "retry_processing", "ok", stage);
      return this.buildStatusView(this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId)!);
    });
  }

  createRevision(input: {
    sessionId: string;
    expectedRevision?: number;
    reason: "repair" | "route_change";
    actor: string;
  }): RecordingSessionStatusView {
    if (input.reason === "route_change") {
      throw new RecordingError({
        status: 409,
        code: "ROUTE_CHANGE_NOT_ENABLED",
        message: "当前版本暂不支持跨路由静默迁移录音归属",
      });
    }
    return this.tx(() => {
      this.assertNotDeleted(input.sessionId);
      const session = this.requireSessionRevisionTx(input.sessionId, input.expectedRevision);
      const now = this.clock();
      const nextGen = session.generation + 1;
      this.exec(
        "UPDATE recording_jobs SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND generation = ? AND status IN ('queued', 'running')",
        now,
        input.sessionId,
        session.generation,
      );
      this.revokeDeviceGrants(session.device_id);
      this.exec(
        `UPDATE recording_sessions
           SET generation = ?,
               manifest_hash = NULL,
               transfer_state = 'awaiting_chunks',
               processing_state = 'not_started',
               last_error_json = NULL,
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        nextGen,
        now,
        input.sessionId,
      );
      this.audit(input.sessionId, nextGen, input.actor, "create_revision", "ok", input.reason);
      return this.buildStatusView(this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId)!);
    });
  }

  deleteSession(input: {
    sessionId: string;
    expectedRevision?: number;
    deleteLinkedMemories?: boolean;
    actor: string;
  }): RecordingDeletionStatus {
    return this.tx(() => {
      const existingTomb = this.one<TombstoneRow>("SELECT * FROM recording_tombstones WHERE session_id = ?", input.sessionId);
      if (existingTomb) {
        return this.tombstoneToStatus(existingTomb);
      }
      const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
      if (!session) {
        throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音不存在" });
      }
      if (input.expectedRevision !== undefined && session.revision !== input.expectedRevision) {
        throw new RecordingError({
          status: 409,
          code: "GENERATION_STALE",
          message: "录音状态已更新，请刷新后再删除",
          state: this.stateOf(session),
          revision: session.revision,
        });
      }

      const now = this.clock();
      const nextGen = session.generation + 1;
      // 1. 立刻立 tombstone 并封锁旧任务与设备 grant
      this.exec(
        `INSERT INTO recording_tombstones
          (session_id, generation, deleted_at, delete_linked_memories, objects_purged, index_purged, deliveries_revoked, local_cleanup_acked)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0)`,
        input.sessionId,
        nextGen,
        now,
        input.deleteLinkedMemories ? 1 : 0,
      );
      this.exec(
        "UPDATE recording_jobs SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status IN ('queued', 'running')",
        now,
        input.sessionId,
      );
      this.exec(
        `UPDATE recording_sessions
           SET generation = ?,
               processing_state = 'deleting',
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        nextGen,
        now,
        input.sessionId,
      );
      this.enqueueJobTx({
        sessionId: input.sessionId,
        generation: nextGen,
        stage: "purge",
        inputHash: sha256Hex(`purge:${input.sessionId}:${nextGen}`),
        maxAttempts: 5,
      });
      this.audit(input.sessionId, nextGen, input.actor, "delete_session", "ok");
      return this.tombstoneToStatus(
        this.one<TombstoneRow>("SELECT * FROM recording_tombstones WHERE session_id = ?", input.sessionId)!,
      );
    });
  }

  getDeletionStatus(sessionId: string): RecordingDeletionStatus {
    const tomb = this.one<TombstoneRow>("SELECT * FROM recording_tombstones WHERE session_id = ?", sessionId);
    if (!tomb) {
      throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "未找到删除记录" });
    }
    return this.tombstoneToStatus(tomb);
  }

  /** 执行物理清理（可由 purge job 或同步调用执行） */
  executePurge(sessionId: string): { memoryIdsToForget: string[]; inboxItemIds: string[] } {
    const tomb = this.one<TombstoneRow>("SELECT * FROM recording_tombstones WHERE session_id = ?", sessionId);
    if (!tomb) return { memoryIdsToForget: [], inboxItemIds: [] };

    const memoryIdsToForget: string[] = [];
    const inboxItemIds: string[] = [];

    if (tomb.delete_linked_memories) {
      const results = this.all<{ payload_json: string }>(
        "SELECT payload_json FROM recording_results WHERE session_id = ?",
        sessionId,
      );
      for (const row of results) {
        const parsed = JSON.parse(row.payload_json) as RecordingResultPayload;
        for (const cand of parsed.memoryCandidates) {
          if (cand.confirmation === "confirmed" && cand.memoryId) {
            memoryIdsToForget.push(cand.memoryId);
          }
        }
      }
    }

    const deliveries = this.all<{ delivery_key: string; inbox_item_id: string | null }>(
      "SELECT delivery_key, inbox_item_id FROM recording_deliveries WHERE session_id = ?",
      sessionId,
    );
    for (const del of deliveries) {
      if (del.inbox_item_id) inboxItemIds.push(del.inbox_item_id);
    }

    // 清理磁盘上的音频段文件
    const sessionChunkDir = resolve(this.chunksDir, sessionId);
    if (isInside(sessionChunkDir, this.chunksDir) && existsSync(sessionChunkDir)) {
      rmSync(sessionChunkDir, { recursive: true, force: true });
    }

    const now = this.clock();
    this.tx(() => {
      this.exec("DELETE FROM recording_chunks WHERE session_id = ?", sessionId);
      this.exec("DELETE FROM recording_manifests WHERE session_id = ?", sessionId);
      this.exec("DELETE FROM recording_transcripts WHERE session_id = ?", sessionId);
      this.exec("DELETE FROM recording_results WHERE session_id = ?", sessionId);
      this.exec("UPDATE recording_deliveries SET status = 'revoked', updated_at = ? WHERE session_id = ?", now, sessionId);
      this.exec(
        `UPDATE recording_sessions
           SET processing_state = 'deleted',
               audio_expired = 1,
               title = NULL,
               result_revision = NULL,
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        now,
        sessionId,
      );
      this.exec(
        `UPDATE recording_tombstones
           SET objects_purged = 1,
               index_purged = 1,
               deliveries_revoked = 1
         WHERE session_id = ?`,
        sessionId,
      );
    });

    return { memoryIdsToForget, inboxItemIds };
  }

  // MARK: - 读取视图、音频段与结果

  getSession(sessionId: string): RecordingSessionStatusView {
    const tomb = this.one<TombstoneRow>("SELECT * FROM recording_tombstones WHERE session_id = ?", sessionId);
    if (tomb) {
      throw new RecordingError({ status: 410, code: "DELETED", message: "录音已删除" });
    }
    const row = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
    if (!row) {
      throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音不存在" });
    }
    return this.buildStatusView(row);
  }

  listSessions(opts?: { limit?: number; cursor?: string }): { items: RecordingSessionStatusView[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 30));
    const cursorMs = opts?.cursor ? Number(Buffer.from(opts.cursor, "base64url").toString("utf8")) : null;
    const rows =
      cursorMs && Number.isFinite(cursorMs)
        ? this.all<SessionRow>(
            `SELECT * FROM recording_sessions
             WHERE processing_state NOT IN ('deleted', 'deleting') AND updated_at < ?
             ORDER BY updated_at DESC LIMIT ?`,
            cursorMs,
            limit + 1,
          )
        : this.all<SessionRow>(
            `SELECT * FROM recording_sessions
             WHERE processing_state NOT IN ('deleted', 'deleting')
             ORDER BY updated_at DESC LIMIT ?`,
            limit + 1,
          );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && slice.length > 0
        ? Buffer.from(String(slice[slice.length - 1]!.updated_at), "utf8").toString("base64url")
        : null;
    return {
      items: slice.map((row) => this.buildStatusView(row)),
      nextCursor,
    };
  }

  getChunkFileForPlayback(sessionId: string, seq: number): { absPath: string; mime: string; size: number; sha256: string } {
    this.assertNotDeleted(sessionId);
    const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
    if (!session) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音不存在" });
    if (session.audio_expired || (session.raw_expires_at !== null && this.clock() > session.raw_expires_at)) {
      throw new RecordingError({ status: 410, code: "AUDIO_EXPIRED", message: "原音已按保留期清理，仅保留文字记录" });
    }
    const chunk = this.one<ChunkRow>(
      "SELECT * FROM recording_chunks WHERE session_id = ? AND generation = ? AND seq = ?",
      sessionId,
      session.generation,
      seq,
    );
    if (!chunk) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "未找到该音频段" });
    if (chunk.expired) {
      throw new RecordingError({ status: 410, code: "AUDIO_EXPIRED", message: "原音已按保留期清理" });
    }
    const absPath = resolve(this.rootDir, chunk.rel_path);
    if (!isInside(absPath, this.chunksDir) || !existsSync(absPath)) {
      throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "音频文件不可用" });
    }
    return { absPath, mime: chunk.mime, size: statSync(absPath).size, sha256: chunk.sha256 };
  }

  getResult(sessionId: string): { ready: true; result: RecordingResultPayload } | { ready: false; session: RecordingSessionStatusView } {
    this.assertNotDeleted(sessionId);
    const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
    if (!session) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音不存在" });
    if (session.result_revision === null) {
      return { ready: false, session: this.buildStatusView(session) };
    }
    const row = this.one<{ payload_json: string }>(
      "SELECT payload_json FROM recording_results WHERE session_id = ? AND generation = ? AND result_revision = ?",
      sessionId,
      session.generation,
      session.result_revision,
    );
    if (!row) {
      return { ready: false, session: this.buildStatusView(session) };
    }
    const payload = JSON.parse(row.payload_json) as RecordingResultPayload;
    payload.audioExpired = Boolean(session.audio_expired || (session.raw_expires_at !== null && this.clock() > session.raw_expires_at));
    payload.audioAvailable = Boolean(session.audio_uploaded) && !payload.audioExpired;
    return { ready: true, result: payload };
  }

  // MARK: - Worker 使用的事务原语（结果落盘、记忆候选显式确认、Job 租赁、保留期清理）

  getLatestTranscript(sessionId: string, generation: number): { revision: number; payload: RecordingTranscriptPayload } | null {
    const row = this.one<{ revision: number; payload_json: string }>(
      "SELECT revision, payload_json FROM recording_transcripts WHERE session_id = ? AND generation = ? ORDER BY revision DESC LIMIT 1",
      sessionId,
      generation,
    );
    if (!row) return null;
    return { revision: row.revision, payload: JSON.parse(row.payload_json) as RecordingTranscriptPayload };
  }

  getManifest(sessionId: string, generation: number): RecordingManifest | null {
    const row = this.one<{ manifest_json: string }>(
      "SELECT manifest_json FROM recording_manifests WHERE session_id = ? AND generation = ?",
      sessionId,
      generation,
    );
    return row ? (JSON.parse(row.manifest_json) as RecordingManifest) : null;
  }

  getSessionRow(sessionId: string): SessionRow | undefined {
    return this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
  }

  listChunks(sessionId: string, generation: number): ChunkRow[] {
    return this.all<ChunkRow>(
      "SELECT * FROM recording_chunks WHERE session_id = ? AND generation = ? AND expired = 0 ORDER BY seq ASC",
      sessionId,
      generation,
    );
  }

  isGenerationActive(sessionId: string, generation: number): boolean {
    const tomb = this.one<{ session_id: string }>("SELECT session_id FROM recording_tombstones WHERE session_id = ?", sessionId);
    if (tomb) return false;
    const row = this.one<{ generation: number; processing_state: RecordingProcessingState }>(
      "SELECT generation, processing_state FROM recording_sessions WHERE session_id = ?",
      sessionId,
    );
    if (!row) return false;
    if (row.generation !== generation) return false;
    return !["cancelled", "cancelling", "deleting", "deleted"].includes(row.processing_state);
  }

  setProcessingStateIfActive(
    sessionId: string,
    generation: number,
    state: RecordingProcessingState,
    error?: { code: string; message: string; retryable: boolean } | null,
    nextAttemptAt?: number | null,
  ): boolean {
    return this.tx(() => {
      if (!this.isGenerationActive(sessionId, generation)) return false;
      const now = this.clock();
      this.exec(
        `UPDATE recording_sessions
           SET processing_state = ?,
               last_error_json = ?,
               next_attempt_at = ?,
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ? AND generation = ?`,
        state,
        error ? JSON.stringify({ ...error, at: new Date(now).toISOString() }) : null,
        nextAttemptAt ?? null,
        now,
        sessionId,
        generation,
      );
      return true;
    });
  }

  saveResultAndQueueDelivery(sessionId: string, generation: number, result: RecordingResultPayload): boolean {
    return this.tx(() => {
      if (!this.isGenerationActive(sessionId, generation)) return false;
      const now = this.clock();
      const prevRev = Number(
        this.one<{ r: number | null }>(
          "SELECT MAX(result_revision) AS r FROM recording_results WHERE session_id = ? AND generation = ?",
          sessionId,
          generation,
        )?.r ?? 0,
      );
      const resultRev = prevRev + 1;
      const payload: RecordingResultPayload = {
        ...result,
        resultRevision: resultRev,
        delivery: {
          status: "pending",
          deliveryKey: `${this.tenantId}:${sessionId}:${generation}:${resultRev}`,
        },
      };

      this.exec(
        `INSERT INTO recording_results
          (session_id, generation, result_revision, transcript_revision, coverage, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        generation,
        resultRev,
        payload.transcriptRevision,
        payload.coverage,
        JSON.stringify(payload),
        now,
        now,
      );
      this.exec(
        `UPDATE recording_sessions
           SET title = COALESCE(?, title),
               result_revision = ?,
               processing_state = 'delivering',
               last_error_json = NULL,
               revision = revision + 1,
               updated_at = ?
         WHERE session_id = ?`,
        payload.title || null,
        resultRev,
        now,
        sessionId,
      );
      this.enqueueJobTx({
        sessionId,
        generation,
        stage: "deliver",
        inputHash: sha256Hex(`deliver:${sessionId}:${generation}:${resultRev}`),
      });
      return true;
    });
  }

  recordDeliveryAck(input: {
    sessionId: string;
    generation: number;
    resultRevision: number;
    route: RecordingRoute;
    receipt: RecordingDeliveryReceipt;
  }): boolean {
    return this.tx(() => {
      if (!this.isGenerationActive(input.sessionId, input.generation)) return false;
      const now = this.clock();
      this.exec(
        `INSERT OR REPLACE INTO recording_deliveries
          (delivery_key, session_id, generation, result_revision, route_kind, workspace_id, status, target_receipt, workspace_batch_id, workspace_key, inbox_item_id, error, ack_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.receipt.deliveryKey,
        input.sessionId,
        input.generation,
        input.resultRevision,
        input.route.kind,
        input.route.workspaceId,
        input.receipt.status,
        input.receipt.targetReceipt ?? null,
        input.receipt.workspaceBatchId ?? null,
        input.receipt.workspaceKey ?? null,
        input.receipt.inboxItemId ?? null,
        input.receipt.error ?? null,
        input.receipt.status === "acknowledged" ? now : null,
        now,
        now,
      );

      const resRow = this.one<{ payload_json: string }>(
        "SELECT payload_json FROM recording_results WHERE session_id = ? AND generation = ? AND result_revision = ?",
        input.sessionId,
        input.generation,
        input.resultRevision,
      );
      if (resRow) {
        const parsed = JSON.parse(resRow.payload_json) as RecordingResultPayload;
        parsed.delivery = input.receipt;
        this.exec(
          "UPDATE recording_results SET payload_json = ?, updated_at = ? WHERE session_id = ? AND generation = ? AND result_revision = ?",
          JSON.stringify(parsed),
          now,
          input.sessionId,
          input.generation,
          input.resultRevision,
        );
      }

      if (input.receipt.status === "acknowledged") {
        this.exec(
          `UPDATE recording_sessions
             SET processing_state = 'delivered',
                 last_error_json = NULL,
                 next_attempt_at = NULL,
                 revision = revision + 1,
                 updated_at = ?
           WHERE session_id = ?`,
          now,
          input.sessionId,
        );
        this.audit(input.sessionId, input.generation, "worker", "deliver_result", "ok", input.receipt.deliveryKey);
      }
      return true;
    });
  }

  /** 用户显式点击确认或忽略某条记忆建议（绝不从录音正文自动写入） */
  updateMemoryCandidate(input: {
    sessionId: string;
    candidateId: string;
    action: "confirm" | "dismiss";
    saveConfirmedMemory?: (text: string, topic: string) => { ok: true; memoryId: string } | { ok: false; error: string };
    actor: string;
  }): RecordingResultPayload {
    return this.tx(() => {
      this.assertNotDeleted(input.sessionId);
      const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", input.sessionId);
      if (!session || session.result_revision === null) {
        throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "整理结果尚未生成" });
      }
      const resRow = this.one<{ payload_json: string }>(
        "SELECT payload_json FROM recording_results WHERE session_id = ? AND generation = ? AND result_revision = ?",
        input.sessionId,
        session.generation,
        session.result_revision,
      );
      if (!resRow) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "整理结果不存在" });
      const payload = JSON.parse(resRow.payload_json) as RecordingResultPayload;
      const cand = payload.memoryCandidates.find((c) => c.candidateId === input.candidateId);
      if (!cand) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "未找到该记忆建议" });

      if (input.action === "dismiss") {
        cand.confirmation = "dismissed";
      } else {
        if (cand.confirmation === "confirmed") return payload;
        if (cand.subject === "third_party") {
          throw new RecordingError({
            status: 400,
            code: "INVALID_METADATA",
            message: "他人陈述默认不能直接转为你的个人事实记忆",
          });
        }
        if (input.saveConfirmedMemory) {
          const saved = input.saveConfirmedMemory(cand.text, cand.topic || "录音整理");
          if (!saved.ok) {
            throw new RecordingError({ status: 400, code: "MEMORY_REJECTED", message: saved.error });
          }
          cand.memoryId = saved.memoryId;
        }
        cand.confirmation = "confirmed";
      }

      const now = this.clock();
      this.exec(
        "UPDATE recording_results SET payload_json = ?, updated_at = ? WHERE session_id = ? AND generation = ? AND result_revision = ?",
        JSON.stringify(payload),
        now,
        input.sessionId,
        session.generation,
        session.result_revision,
      );
      this.exec("UPDATE recording_sessions SET revision = revision + 1, updated_at = ? WHERE session_id = ?", now, input.sessionId);
      this.audit(input.sessionId, session.generation, input.actor, `memory_candidate_${input.action}`, "ok", input.candidateId);
      return payload;
    });
  }

  // MARK: - 持久 Job 队列领取与状态转移

  claimDueJob(leaseOwner: string, leaseMs = 60_000): RecordingJobRecord | null {
    return this.tx(() => {
      const now = this.clock();
      // 回收过期租约（worker 崩溃恢复）
      this.exec(
        `UPDATE recording_jobs
           SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?`,
        now,
        now,
      );

      const row = this.one<{
        job_id: string;
        session_id: string;
        generation: number;
        stage: RecordingJobStage;
        input_hash: string;
        status: RecordingJobRecord["status"];
        attempt: number;
        max_attempts: number;
        lease_owner: string | null;
        lease_until: number | null;
        next_attempt_at: number;
        error_code: string | null;
        error_message: string | null;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT * FROM recording_jobs
         WHERE status = 'queued' AND next_attempt_at <= ?
         ORDER BY CASE WHEN stage = 'purge' THEN 0 ELSE 1 END, next_attempt_at ASC
         LIMIT 1`,
        now,
      );
      if (!row) return null;

      const leaseUntil = now + leaseMs;
      this.exec(
        `UPDATE recording_jobs
           SET status = 'running', attempt = attempt + 1, lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE job_id = ?`,
        leaseOwner,
        leaseUntil,
        now,
        row.job_id,
      );
      return {
        jobId: row.job_id,
        sessionId: row.session_id,
        generation: row.generation,
        stage: row.stage,
        inputHash: row.input_hash,
        status: "running",
        attempt: row.attempt + 1,
        maxAttempts: row.max_attempts,
        leaseOwner,
        leaseUntil,
        nextAttemptAt: row.next_attempt_at,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        updatedAt: now,
      };
    });
  }

  completeJob(jobId: string) {
    this.exec(
      "UPDATE recording_jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE job_id = ?",
      this.clock(),
      jobId,
    );
  }

  failJob(job: RecordingJobRecord, error: { code: string; message: string; retryable: boolean }) {
    const now = this.clock();
    const canRetry = error.retryable && job.attempt < job.maxAttempts;
    const backoff = RETRY_BACKOFF_MS[Math.min(job.attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 30 * 60_000;
    const nextAttemptAt = now + backoff;

    this.tx(() => {
      this.exec(
        `UPDATE recording_jobs
           SET status = ?,
               lease_owner = NULL,
               lease_until = NULL,
               next_attempt_at = ?,
               error_code = ?,
               error_message = ?,
               updated_at = ?
         WHERE job_id = ?`,
        canRetry ? "queued" : "failed",
        nextAttemptAt,
        error.code,
        error.message,
        now,
        job.jobId,
      );
      if (job.stage !== "purge") {
        this.setProcessingStateIfActive(
          job.sessionId,
          job.generation,
          canRetry ? "queued" : "needs_attention",
          error,
          canRetry ? nextAttemptAt : null,
        );
      }
    });
  }

  /** 按保留期清理过期原音与过期文本 */
  sweepRetention(): { expiredAudioSessions: number; expiredTextSessions: number } {
    const now = this.clock();
    let expiredAudioSessions = 0;
    let expiredTextSessions = 0;

    // 1. 原音到期：删除磁盘 chunk，保留逐字稿与摘要并标记 audio_expired=1
    const audioDue = this.all<SessionRow>(
      `SELECT * FROM recording_sessions
       WHERE audio_expired = 0 AND raw_expires_at IS NOT NULL AND raw_expires_at <= ?
         AND processing_state NOT IN ('deleting', 'deleted')`,
      now,
    );
    for (const session of audioDue) {
      const dir = resolve(this.chunksDir, session.session_id);
      if (isInside(dir, this.chunksDir) && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      this.tx(() => {
        this.exec("UPDATE recording_chunks SET expired = 1 WHERE session_id = ?", session.session_id);
        this.exec(
          "UPDATE recording_sessions SET audio_expired = 1, revision = revision + 1, updated_at = ? WHERE session_id = ?",
          now,
          session.session_id,
        );
        this.audit(session.session_id, session.generation, "retention", "expire_raw_audio", "ok");
      });
      expiredAudioSessions += 1;
    }

    // 2. 文本到期：触发删除流程
    const textDue = this.all<SessionRow>(
      `SELECT * FROM recording_sessions
       WHERE text_expires_at IS NOT NULL AND text_expires_at <= ?
         AND processing_state NOT IN ('deleting', 'deleted')`,
      now,
    );
    for (const session of textDue) {
      try {
        this.deleteSession({ sessionId: session.session_id, deleteLinkedMemories: false, actor: "retention" });
        expiredTextSessions += 1;
      } catch {
        // 并发已删则忽略
      }
    }

    return { expiredAudioSessions, expiredTextSessions };
  }

  // MARK: - 内部辅助方法

  private requireSessionRevisionTx(sessionId: string, expectedRevision: number | undefined): SessionRow {
    const session = this.one<SessionRow>("SELECT * FROM recording_sessions WHERE session_id = ?", sessionId);
    if (!session) throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "录音不存在" });
    if (expectedRevision !== undefined && session.revision !== expectedRevision) {
      throw new RecordingError({
        status: 409,
        code: "GENERATION_STALE",
        message: "录音状态已被更新，请刷新后重试",
        state: this.stateOf(session),
        revision: session.revision,
      });
    }
    return session;
  }

  private stateOf(row: SessionRow) {
    return {
      captureState: row.capture_state,
      transferState: row.transfer_state,
      processingState: row.processing_state,
    };
  }

  private tombstoneToStatus(tomb: TombstoneRow): RecordingDeletionStatus {
    const done = Boolean(tomb.objects_purged && tomb.index_purged && tomb.deliveries_revoked);
    return {
      sessionId: tomb.session_id,
      generation: tomb.generation,
      status: done ? "deleted" : "deleting",
      deletedAt: new Date(tomb.deleted_at).toISOString(),
      objectsPurged: Boolean(tomb.objects_purged),
      indexPurged: Boolean(tomb.index_purged),
      deliveriesRevoked: Boolean(tomb.deliveries_revoked),
      localCleanupPending: !tomb.local_cleanup_acked,
      backupPolicyNote: "活跃对象与索引已清除；若开启外部备份，备份保留按运维周期自然过期。",
    };
  }

  private buildStatusView(row: SessionRow): RecordingSessionStatusView {
    const uploadedSeqs = new Set(
      this.all<{ seq: number }>(
        "SELECT seq FROM recording_chunks WHERE session_id = ? AND generation = ? AND expired = 0",
        row.session_id,
        row.generation,
      ).map((r) => r.seq),
    );
    let missingSeqs: number[] = [];
    if (row.audio_uploaded && row.manifest_hash) {
      const mRow = this.one<{ manifest_json: string }>(
        "SELECT manifest_json FROM recording_manifests WHERE session_id = ? AND generation = ?",
        row.session_id,
        row.generation,
      );
      if (mRow) {
        const manifest = JSON.parse(mRow.manifest_json) as RecordingManifest;
        missingSeqs = manifest.chunks.map((c) => c.seq).filter((seq) => !uploadedSeqs.has(seq)).sort((a, b) => a - b);
      }
    }
    return {
      sessionId: row.session_id,
      deviceId: row.device_id,
      generation: row.generation,
      revision: row.revision,
      title: row.title ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: new Date(row.started_at).toISOString(),
      stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
      route: { kind: row.route_kind, workspaceId: row.workspace_id },
      policySnapshot: JSON.parse(row.policy_json) as RecordingPolicySnapshot,
      policyHash: row.policy_hash,
      format: JSON.parse(row.format_json) as RecordingAudioFormat,
      captureState: row.capture_state,
      transferState: row.transfer_state,
      processingState: row.processing_state,
      coverage: row.coverage,
      expectedChunks: row.expected_chunks,
      verifiedChunks: uploadedSeqs.size,
      missingSeqs,
      missingRanges: JSON.parse(row.missing_ranges_json) as RecordingMissingRange[],
      expectedTotalFrames: row.expected_total_frames,
      expectedTotalBytes: row.expected_total_bytes,
      hasTranscript: row.transcript_revision > 0,
      audioUploaded: Boolean(row.audio_uploaded),
      audioExpired: Boolean(row.audio_expired || (row.raw_expires_at !== null && this.clock() > row.raw_expires_at)),
      rawExpiresAt: row.raw_expires_at ? new Date(row.raw_expires_at).toISOString() : null,
      textExpiresAt: row.text_expires_at ? new Date(row.text_expires_at).toISOString() : null,
      resultRevision: row.result_revision,
      lastError: row.last_error_json ? JSON.parse(row.last_error_json) : null,
      nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
    };
  }
}
