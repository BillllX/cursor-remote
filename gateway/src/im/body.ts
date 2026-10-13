// IM 消息体校验：按 kind 只留已知字段并检查取值，同时给出它引用的 blob
import type { ImBody, ImKind } from "../../../shared/protocol.ts";
import { ImError } from "./errors.ts";
import type { BlobKind } from "./store.ts";

export const IM_KINDS: readonly ImKind[] = ["text", "image", "voice", "file", "link", "location"];
export const MAX_TEXT_BYTES = 8 * 1024;
export const MAX_VOICE_MS = 60_000;
export const MAX_WAVEFORM = 100;
const BLOB_RE = /^[0-9a-f]{64}$/;
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;

/** 消息体里引用的附件，以及这个字段要求的上传用途 */
export type BlobUse = { sha: string; kind: BlobKind };
export type CheckedBody = { kind: ImKind; body: ImBody; blobs: BlobUse[] };

const bad = (message: string) => new ImError("bad_body", message);

export function isBlobId(value: unknown): value is string {
  return typeof value === "string" && BLOB_RE.test(value);
}

function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("body 必须是对象");
  return raw as Record<string, unknown>;
}

function blob(value: unknown, field: string): string {
  if (!isBlobId(value)) throw bad(`${field} 不是有效的 blob`);
  return value;
}

function str(value: unknown, field: string, max: number, opts: { required?: boolean } = {}): string {
  if (typeof value !== "string") throw bad(`${field} 必须是字符串`);
  if (opts.required && !value.trim()) throw bad(`${field} 不能为空`);
  if (value.length > max) throw bad(`${field} 太长（最多 ${max} 字）`);
  return value;
}

function optStr(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return str(value, field, max);
}

function num(value: unknown, field: string, min: number, max: number, int = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`${field} 必须是数字`);
  if (int && !Number.isInteger(value)) throw bad(`${field} 必须是整数`);
  if (value < min || value > max) throw bad(`${field} 超出范围（${min}–${max}）`);
  return value;
}

function httpUrl(value: unknown): string {
  const raw = str(value, "url", 2048, { required: true }).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad("url 不是有效地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw bad("url 只能是 http 或 https");
  return raw;
}

/** 校验并规整消息体；不认识的字段丢掉。文字超过 8KB 抛 too_large，其余问题抛 bad_body */
export function checkBody(kind: unknown, raw: unknown): CheckedBody {
  if (typeof kind !== "string" || !IM_KINDS.includes(kind as ImKind)) throw bad("不认识的消息类型");
  const b = obj(raw);
  switch (kind as ImKind) {
    case "text": {
      const text = typeof b.text === "string" ? b.text : "";
      if (!text.trim()) throw bad("文字不能为空");
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new ImError("too_large", "文字太长（最多 8KB）");
      return { kind: "text", body: { text }, blobs: [] };
    }
    case "image": {
      const main = blob(b.blob, "blob");
      const thumb = blob(b.thumb, "thumb");
      const w = num(b.w, "w", 1, 100_000, true);
      const h = num(b.h, "h", 1, 100_000, true);
      if (typeof b.original !== "boolean") throw bad("original 必须是布尔值");
      return {
        kind: "image",
        body: { blob: main, thumb, w, h, original: b.original },
        blobs: [
          { sha: main, kind: "image" },
          { sha: thumb, kind: "thumb" },
        ],
      };
    }
    case "voice": {
      const main = blob(b.blob, "blob");
      const durationMs = num(b.durationMs, "durationMs", 1, MAX_VOICE_MS, true);
      if (!Array.isArray(b.waveform)) throw bad("waveform 必须是数组");
      if (b.waveform.length > MAX_WAVEFORM) throw bad(`waveform 最多 ${MAX_WAVEFORM} 个点`);
      const waveform = b.waveform.map((point) => num(point, "waveform", 0, 1));
      return { kind: "voice", body: { blob: main, durationMs, waveform }, blobs: [{ sha: main, kind: "voice" }] };
    }
    case "file": {
      const main = blob(b.blob, "blob");
      const name = str(b.name, "name", 255, { required: true });
      if (/[/\\]/.test(name) || Array.from(name).some((ch) => ch.charCodeAt(0) < 0x20)) {
        throw bad("文件名不能含斜杠或控制字符");
      }
      const size = num(b.size, "size", 0, Number.MAX_SAFE_INTEGER, true);
      const mime = str(b.mime, "mime", 129, { required: true });
      if (!MIME_RE.test(mime)) throw bad("mime 格式不对");
      return { kind: "file", body: { blob: main, name, size, mime }, blobs: [{ sha: main, kind: "file" }] };
    }
    case "link": {
      const url = httpUrl(b.url);
      const title = optStr(b.title, "title", 200);
      const desc = optStr(b.desc, "desc", 500);
      const icon = b.icon === undefined || b.icon === null || b.icon === "" ? undefined : blob(b.icon, "icon");
      const body = { url, ...(title ? { title } : {}), ...(desc ? { desc } : {}), ...(icon ? { icon } : {}) };
      return { kind: "link", body, blobs: icon ? [{ sha: icon, kind: "icon" }] : [] };
    }
    case "location": {
      const lat = num(b.lat, "lat", -90, 90);
      const lng = num(b.lng, "lng", -180, 180);
      const name = str(b.name, "name", 200);
      const address = str(b.address, "address", 500);
      return { kind: "location", body: { lat, lng, name, address }, blobs: [] };
    }
  }
}

/** 已落盘的消息引用了哪些附件（不重新校验；撤回的行里 body 仍在） */
export function blobsOf(kind: ImKind, body: unknown): BlobUse[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const use = (value: unknown, as: BlobKind): BlobUse[] => (isBlobId(value) ? [{ sha: value, kind: as }] : []);
  switch (kind) {
    case "image":
      return [...use(b.blob, "image"), ...use(b.thumb, "thumb")];
    case "voice":
      return use(b.blob, "voice");
    case "file":
      return use(b.blob, "file");
    case "link":
      return use(b.icon, "icon");
    default:
      return [];
  }
}
