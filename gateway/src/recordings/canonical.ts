// RFC 8785 / JCS 风格确定性 JSON 规范序列化与 SHA-256 计算
// 保证客户端（Swift）与服务端（Node.js）对同一 manifest / policy 计算出一致哈希
import { createHash } from "node:crypto";
import type { RecordingManifest, RecordingPolicySnapshot } from "./types.ts";

/**
 * 将 JSON 值做确定性规范化：
 * - 对象键按 UTF-16 code unit 字典序升序排列（跳过 undefined）；
 * - 拒绝 NaN / Infinity（避免浮点歧义）；
 * - 不添加多余空白。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("规范 JSON 不允许 NaN 或 Infinity");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`不支持的规范 JSON 类型：${typeof value}`);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 计算 policySnapshot 哈希 */
export function computePolicyHash(policy: RecordingPolicySnapshot): string {
  return sha256Hex(canonicalJson(policy));
}

/**
 * 计算 manifestHash：移除 manifestHash 字段后按规范 JSON 编码 UTF-8 再 SHA-256。
 * 同时允许客户端直接提交无 manifestHash 的对象用于服务端核对。
 */
export function computeManifestHash(manifest: Omit<RecordingManifest, "manifestHash"> & { manifestHash?: string }): string {
  const clone: Record<string, unknown> = { ...(manifest as Record<string, unknown>) };
  delete clone.manifestHash;
  return sha256Hex(canonicalJson(clone));
}

export function framesToMs(frames: number, sampleRate = 24_000): number {
  if (!Number.isFinite(frames) || frames <= 0 || sampleRate <= 0) return 0;
  return Math.floor((frames * 1000) / sampleRate);
}

export function formatDurationFrames(frames: number, sampleRate = 24_000): string {
  const totalSec = Math.floor(framesToMs(frames, sampleRate) / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}
