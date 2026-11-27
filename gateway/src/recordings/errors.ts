// 长录音模块统一错误类型（映射为 api-contract.md 第 5 节的统一 JSON 错误结构）
import type { RecordingCaptureState, RecordingProcessingState, RecordingTransferState } from "./types.ts";

export class RecordingError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly state?: {
    captureState: RecordingCaptureState;
    transferState: RecordingTransferState;
    processingState: RecordingProcessingState;
  };
  readonly revision?: number;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterSeconds?: number;
    state?: {
      captureState: RecordingCaptureState;
      transferState: RecordingTransferState;
      processingState: RecordingProcessingState;
    };
    revision?: number;
  }) {
    super(opts.message);
    this.name = "RecordingError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.state = opts.state;
    this.revision = opts.revision;
  }
}

export function isValidUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
