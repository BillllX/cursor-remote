// 服务端 ASR 适配器契约（符合 long-recording-design.md 第 6 节）
// 当客户端使用 Apple 端侧边录边转（SpeechAnalyzer）并提交逐字稿时，直接跳过云端 ASR（零云端转写费用）；
// 仅在用户明确允许服务器转写（server_allowed）且未携带端侧逐字稿时调用此适配器。
import type { RecordingAudioFormat, RecordingTranscriptPayload } from "./types.ts";

export type AsrAdapterCapabilities = {
  provider: string;
  model: string;
  maxDurationMs: number;
  maxBytes: number;
  supportedLocales: string[];
  timestampGranularity: RecordingTranscriptPayload["timestampGranularity"];
  diarization: boolean;
  cancelSupport: boolean;
};

export type AsrChunkInput = {
  sessionId: string;
  generation: number;
  seq: number;
  epochId: string;
  absPath: string;
  sha256: string;
  bytes: number;
  captureStartFrame: number;
  validFrameCount: number;
  format: RecordingAudioFormat;
  localeHint: string;
};

export interface AsrProviderAdapter {
  readonly capabilities: AsrAdapterCapabilities;
  transcribeChunk(input: AsrChunkInput, signal?: AbortSignal): Promise<{
    segments: Array<{
      startFrame: number;
      endFrame: number;
      text: string;
      speakerLocalId?: string | null;
      confidence?: number | null;
      uncertain?: boolean;
    }>;
    warnings?: string[];
  }>;
}

let activeAsrAdapter: AsrProviderAdapter | null = null;

export function registerAsrAdapter(adapter: AsrProviderAdapter | null) {
  activeAsrAdapter = adapter;
}

export function getAsrAdapter(): AsrProviderAdapter | null {
  return activeAsrAdapter;
}

/**
 * 合并各音频段的 ASR 片段，按规范 frame 时间轴排序并去除上下文重叠窗口内的重复句，
 * 保留真实重复话语（仅当时间区间重叠且文本高度一致时去重），不伪造跨段说话人身份。
 */
export function mergeChunkTranscriptSegments(
  chunkOutputs: Array<{
    epochId: string;
    seq: number;
    captureStartFrame: number;
    validFrameCount: number;
    segments: Array<{
      startFrame: number;
      endFrame: number;
      text: string;
      speakerLocalId?: string | null;
      confidence?: number | null;
      uncertain?: boolean;
    }>;
  }>,
  locale: string,
  meta: {
    source: RecordingTranscriptPayload["source"];
    provider?: string;
    model?: string;
    timestampGranularity: RecordingTranscriptPayload["timestampGranularity"];
    warnings?: string[];
  },
): RecordingTranscriptPayload {
  const ordered = [...chunkOutputs].sort((a, b) => a.captureStartFrame - b.captureStartFrame || a.seq - b.seq);
  const merged: RecordingTranscriptPayload["segments"] = [];
  let segIndex = 0;

  for (const chunk of ordered) {
    const chunkMin = chunk.captureStartFrame;
    const chunkMax = chunk.captureStartFrame + chunk.validFrameCount;
    const sortedSegs = [...chunk.segments].sort((a, b) => a.startFrame - b.startFrame);
    for (const seg of sortedSegs) {
      const text = seg.text.trim();
      if (!text) continue;
      const startFrame = Math.max(chunkMin, Math.min(chunkMax, Math.floor(seg.startFrame)));
      const endFrame = Math.max(startFrame, Math.min(chunkMax, Math.floor(seg.endFrame)));

      const prev = merged[merged.length - 1];
      if (prev && startFrame <= prev.endFrame + 24_000) {
        // 仅在相邻窗口有时间重叠且归一化文本完全相同时去重，不误删真实重复发言
        const norm = (s: string) => s.replace(/[\s，。！？、,.!?]/g, "");
        if (norm(prev.text) === norm(text) && startFrame < prev.endFrame) {
          continue;
        }
      }

      segIndex += 1;
      const rawSpeaker = seg.speakerLocalId?.trim();
      const speakerLocalId = rawSpeaker
        ? rawSpeaker.includes(":")
          ? rawSpeaker
          : `${chunk.epochId}/${chunk.seq}:${rawSpeaker}`
        : null;

      merged.push({
        segmentId: `seg-${segIndex}`,
        startFrame,
        endFrame,
        text,
        speakerLocalId,
        identityStatus: "unconfirmed",
        confidence: typeof seg.confidence === "number" && Number.isFinite(seg.confidence) ? seg.confidence : null,
        ...(seg.uncertain ? { uncertain: true } : {}),
      });
    }
  }

  return {
    transcriptVersion: 1,
    source: meta.source,
    locale,
    provider: meta.provider,
    model: meta.model,
    timestampGranularity: meta.timestampGranularity,
    segments: merged,
    ...(meta.warnings?.length ? { warnings: meta.warnings } : {}),
  };
}
