// 长录音服务端与客户端共享的契约类型定义（对应 docs/personal-audio-assistant/api-contract.md v1）

export const RECORDING_SCHEMA_VERSION = 1;
export const RECORDING_CANONICAL_SAMPLE_RATE = 24_000;
export const RECORDING_MAX_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB
export const RECORDING_MAX_CHUNKS = 512;
export const RECORDING_MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB / session
export const RECORDING_MAX_JSON_BYTES = 256 * 1024; // 256 KiB
export const RECORDING_MAX_MANIFEST_BYTES = 1024 * 1024; // 1 MiB
export const RECORDING_MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024; // 4 MiB
export const RECORDING_MAX_DURATION_FRAMES = 8 * 3600 * RECORDING_CANONICAL_SAMPLE_RATE; // 8h @ 24kHz
export const RECORDING_DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const RECORDING_MAX_PROVISIONAL_PER_DEVICE = 2;
export const RECORDING_PROVISIONAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
export const RECORDING_DEFAULT_TENANT_QUOTA_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB / tenant

export type RecordingCaptureState =
  | "ready"
  | "recording"
  | "paused"
  | "interrupted"
  | "sealed"
  | "recovery_required";

export type RecordingTransferState =
  | "local_only"
  | "waiting_network"
  | "waiting_auth"
  | "uploading"
  | "awaiting_chunks"
  | "durable"
  | "failed";

export type RecordingProcessingState =
  | "not_started"
  | "queued"
  | "transcribing"
  | "summarizing"
  | "delivering"
  | "delivered"
  | "partial_pending"
  | "needs_attention"
  | "cancelling"
  | "cancelled"
  | "deleting"
  | "deleted";

export type RecordingCoverage = "complete" | "partial" | "none";

export type RecordingRoute = {
  kind: "personal" | "workspace";
  workspaceId: string | null;
};

export type RecordingAsrPolicy = "on_device_preferred" | "on_device_only" | "server_allowed";

export type RecordingPolicySnapshot = {
  version: number;
  network: "wifi_only" | "wifi_and_cellular";
  asr: RecordingAsrPolicy;
  /** 是否同时上传原音段（开启本地边录边转后可按用户偏好关闭原音同步，仅传文字+时间戳） */
  syncAudio: boolean;
  uploadDuringRecording: boolean;
  rawRetentionDays: number;
  textRetentionDays: number;
  memory: "confirm_only" | "disabled";
  reminders: "explicit_only";
};

export type RecordingAudioFormat = {
  codec: "aac_lc" | "pcm_s16le";
  container: "m4a" | "caf";
  sampleRate: number;
  channels: number;
  bitrate?: number;
};

export type RecordingChunkDecl = {
  seq: number;
  chunkId?: string;
  epochId: string;
  captureStartFrame: number;
  validFrameCount: number;
  originalSampleRate?: number;
  originalStartFrame?: number;
  encoderDelayFrames: number;
  paddingFrames: number;
  bytes: number;
  sha256: string;
  format: RecordingAudioFormat;
  /** 修订时声明复用同租户同会话已校验段的 receiptId */
  reuseReceiptId?: string;
};

export type RecordingEpochDecl = {
  epochId: string;
  hardwareSampleRate: number;
  channels: number;
  routeKind: string;
  hostTimeStart: string;
  timebaseNumer?: number;
  timebaseDenom?: number;
  wallTimeStart: string;
  canonicalStartFrame: number;
  sourceFrameCount: number;
};

export type RecordingTimelineEvent = {
  eventId: string;
  type: "pause" | "resume" | "interruption" | "route_change" | "recovery_gap";
  startWallTime: string;
  endWallTime?: string | null;
  canonicalFrame: number;
  reason?: string;
};

export type RecordingMissingRange = {
  startFrame: number;
  endFrame: number;
  reason: string;
};

export type RecordingTranscriptSegment = {
  segmentId: string;
  startFrame: number;
  endFrame: number;
  text: string;
  speakerLocalId?: string | null;
  identityStatus?: "unconfirmed" | "user_confirmed";
  confidence?: number | null;
  uncertain?: boolean;
};

export type RecordingTranscriptPayload = {
  transcriptVersion: number;
  source: "on_device_speech_analyzer" | "on_device_sf_speech" | "server_asr";
  locale: string;
  provider?: string;
  model?: string;
  timestampGranularity: "word" | "utterance" | "segment" | "coarse";
  segments: RecordingTranscriptSegment[];
  warnings?: string[];
};

export type RecordingManifest = {
  manifestVersion: number;
  manifestHash: string;
  sessionId: string;
  generation: number;
  policyHash: string;
  title?: string;
  startedAt?: string;
  stoppedAt: string;
  completeCapture: boolean;
  /** 是否期望上传原音段（false 表示客户端仅提交端侧转写与清单，不上传音频文件） */
  audioUploaded?: boolean;
  expectedTotalFrames: number;
  expectedTotalBytes: number;
  chunks: RecordingChunkDecl[];
  epochs: RecordingEpochDecl[];
  timelineEvents: RecordingTimelineEvent[];
  missingRanges: RecordingMissingRange[];
  /** 端侧边录边转产生的内联逐字稿（可选，超大时也可经 PUT /transcript 单独上传） */
  onDeviceTranscript?: RecordingTranscriptPayload;
};

export type RecordingCitation = {
  segmentId: string;
  startFrame: number;
  endFrame: number;
  transcriptRevision: number;
};

export type RecordingClaim = {
  claimId: string;
  text: string;
  kind: "fact" | "proposal" | "uncertain";
  citations: RecordingCitation[];
};

export type RecordingSectionSummary = {
  sectionId: string;
  title: string;
  startFrame: number;
  endFrame: number;
  summary: string;
  citations: RecordingCitation[];
};

export type RecordingMemoryCandidate = {
  candidateId: string;
  text: string;
  topic?: string;
  subject: "user" | "third_party" | "unknown";
  evidenceRefs: RecordingCitation[];
  confirmation: "pending" | "confirmed" | "dismissed";
  proposedScope: "personal" | "workspace";
  sourceSessionId: string;
  memoryId?: string;
};

export type RecordingReminderCandidate = {
  candidateId: string;
  text: string;
  suggestedTimeText?: string | null;
  evidenceRefs: RecordingCitation[];
  status: "suggested" | "dismissed";
};

export type RecordingDeliveryReceipt = {
  status: "pending" | "acknowledged" | "failed" | "revoked";
  deliveryKey: string;
  targetReceipt?: string;
  ackAt?: string;
  workspaceBatchId?: string;
  workspaceKey?: string;
  inboxItemId?: string;
  error?: string;
};

export type RecordingResultPayload = {
  sessionId: string;
  generation: number;
  resultRevision: number;
  coverage: RecordingCoverage;
  transcriptRevision: number;
  transcriptSource: RecordingTranscriptPayload["source"];
  timestampGranularity: RecordingTranscriptPayload["timestampGranularity"];
  title: string;
  summary: string;
  sections: RecordingSectionSummary[];
  segments: RecordingTranscriptSegment[];
  claims: RecordingClaim[];
  memoryCandidates: RecordingMemoryCandidate[];
  reminderCandidates: RecordingReminderCandidate[];
  missingRanges: RecordingMissingRange[];
  audioAvailable: boolean;
  audioExpired: boolean;
  usedFallbackSummary?: boolean;
  delivery: RecordingDeliveryReceipt;
};

export type RecordingErrorBody = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    requestId: string;
  };
  state?: {
    captureState: RecordingCaptureState;
    transferState: RecordingTransferState;
    processingState: RecordingProcessingState;
  };
  revision?: number;
};

export type RecordingSessionStatusView = {
  sessionId: string;
  deviceId: string;
  generation: number;
  revision: number;
  title?: string;
  createdAt: string;
  startedAt: string;
  stoppedAt: string | null;
  route: RecordingRoute;
  policySnapshot: RecordingPolicySnapshot;
  policyHash: string;
  format: RecordingAudioFormat;
  captureState: RecordingCaptureState;
  transferState: RecordingTransferState;
  processingState: RecordingProcessingState;
  coverage: RecordingCoverage;
  expectedChunks: number;
  verifiedChunks: number;
  missingSeqs: number[];
  missingRanges: RecordingMissingRange[];
  expectedTotalFrames: number;
  expectedTotalBytes: number;
  hasTranscript: boolean;
  audioUploaded: boolean;
  audioExpired: boolean;
  rawExpiresAt: string | null;
  textExpiresAt: string | null;
  resultRevision: number | null;
  lastError: { code: string; message: string; retryable: boolean; at: string } | null;
  nextAttemptAt: string | null;
};

export type RecordingGrantRecord = {
  grantId: string;
  tokenHash: string;
  tenantId: string;
  deviceId: string;
  namespacePrefix: string;
  route: RecordingRoute;
  policySnapshot: RecordingPolicySnapshot;
  policyHash: string;
  maxChunkBytes: number;
  maxTotalBytes: number;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
};

export type RecordingJobStage = "transcribe" | "summarize" | "deliver" | "purge";

export type RecordingJobRecord = {
  jobId: string;
  sessionId: string;
  generation: number;
  stage: RecordingJobStage;
  inputHash: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  nextAttemptAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type RecordingDeletionStatus = {
  sessionId: string;
  generation: number;
  status: "deleting" | "deleted";
  deletedAt: string;
  objectsPurged: boolean;
  indexPurged: boolean;
  deliveriesRevoked: boolean;
  localCleanupPending: boolean;
  backupPolicyNote: string;
};
