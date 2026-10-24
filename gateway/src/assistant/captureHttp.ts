import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { inboxByKey, postInbox, type InboxItem } from "./inbox.ts";
import { BlobTooLarge } from "../im/store.ts";
import { log } from "../log.ts";
import { isInside } from "../pathInside.ts";
import { resolveTenant, type Tenant } from "../tenants.ts";
import { checkArtifactQuota, storeArtifact } from "../turnFiles.ts";

const JSON_LIMIT = 64 * 1024;
const FILE_LIMIT = 32 * 1024 * 1024;
const MAX_UPLOADS_PER_TENANT = 4;
const CLIENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;
const activeUploads = new Map<string, number>();
const activeKeys = new Set<string>();

type Intent = "总结" | "记住" | "建任务" | "稍后读" | "自定义";
const INTENTS = new Set<Intent>(["总结", "记住", "建任务", "稍后读", "自定义"]);

type CaptureInput = {
  clientId: string;
  kind: "text" | "link" | "location";
  text?: string;
  url?: string;
  title?: string;
  lat?: number;
  lng?: number;
  name?: string;
  intent: Intent;
  note?: string;
};

type FileMetadata = {
  clientId: string;
  kind: "image" | "file";
  filename: string;
  mime: string;
  intent: Intent;
  note?: string;
};

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, close = false) {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  };
  if (status === 429) headers["retry-after"] = "30";
  if (close) {
    headers.connection = "close";
    res.on("finish", () => req.destroy());
  }
  res.writeHead(status, headers).end(JSON.stringify(body));
}

function tenantFor(req: IncomingMessage): Tenant | null {
  const token = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""))?.[1]?.trim() || "";
  return token ? resolveTenant(token) : null;
}

function nativeOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers.origin === undefined) return true;
  reply(req, res, 403, { error: "forbidden", message: "仅供原生入口调用" }, true);
  return false;
}

async function readLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > limit) throw new BlobTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}

function common(input: Record<string, unknown>) {
  const clientId = clipped(input.clientId, 128) || "";
  const intent = clipped(input.intent, 16) as Intent | undefined;
  if (!CLIENT_ID_RE.test(clientId) || !intent || !INTENTS.has(intent)) return null;
  return { clientId, intent, note: clipped(input.note, 4000) };
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || character === "/" || character === "\\";
  });
}

export function validateCapture(input: unknown): CaptureInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const base = common(row);
  if (!base) return null;
  if (row.kind === "text") {
    const text = clipped(row.text, 32 * 1024);
    return text ? { ...base, kind: "text", text } : null;
  }
  if (row.kind === "link") {
    const url = clipped(row.url, 4096);
    try {
      const parsed = new URL(url || "");
      if (!["http:", "https:"].includes(parsed.protocol)) return null;
    } catch {
      return null;
    }
    return { ...base, kind: "link", url, title: clipped(row.title, 500) };
  }
  if (row.kind === "location") {
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }
    return { ...base, kind: "location", lat, lng, name: clipped(row.name, 500) };
  }
  return null;
}

export function validateFileMetadata(input: unknown): FileMetadata | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const base = common(row);
  const filename = clipped(row.filename, 255) || "";
  const mime = clipped(row.mime, 129)?.toLowerCase() || "";
  if (
    !base ||
    (row.kind !== "image" && row.kind !== "file") ||
    !filename ||
    filename !== basename(filename) ||
    hasUnsafeFilenameCharacter(filename) ||
    !MIME_RE.test(mime) ||
    mime === "text/html" ||
    mime.includes("svg") ||
    (row.kind === "image" && !mime.startsWith("image/"))
  ) {
    return null;
  }
  return { ...base, kind: row.kind, filename, mime };
}

export function sniffCaptureImageMime(head: Buffer): string | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
    if (["avif", "avis"].includes(brand)) return "image/avif";
  }
  return null;
}

function decodeMetadata(req: IncomingMessage): FileMetadata | null {
  const encoded = String(req.headers["x-jiebo-assistant"] || "");
  if (!encoded || encoded.length > 16_384) return null;
  try {
    return validateFileMetadata(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function key(clientId: string) {
  return `assistant-capture:${clientId}`;
}

function known(tenant: Tenant, clientId: string): InboxItem | undefined {
  return inboxByKey(tenant, key(clientId));
}

type ControlledFileReference = { path: string; sha: string; mime: string; size: number };

function post(tenant: Tenant, input: CaptureInput, fileReference?: ControlledFileReference) {
  const subject =
    input.kind === "text"
      ? input.text || ""
      : input.kind === "link"
        ? `${input.title ? `${input.title}\n` : ""}${input.url}`
        : `${input.name || "位置"}\n${input.lat}, ${input.lng}`;
  const prompt = [`请按“${input.intent}”处理下面的分享内容。`, input.note ? `用户备注：${input.note}` : "", subject]
    .filter(Boolean)
    .join("\n\n");
  const referenceText = fileReference ? `安全文件快照：${fileReference.path}（sha256:${fileReference.sha}）` : "";
  const body = [`意图：${input.intent}`, input.note ? `备注：${input.note}` : "", referenceText || subject]
    .filter(Boolean)
    .join("\n");
  return postInbox(tenant, {
    kind: "info",
    key: key(input.clientId),
    title: `来自分享：${input.intent}`,
    body,
    actionPrompt: fileReference
      ? `${prompt}\n\n${referenceText}\n这是租户受控快照，不是工作区路径；请通过受控快照引用读取，禁止拼接绝对路径。`
      : prompt,
    capture: fileReference
      ? { kind: "file", title: input.text, ...fileReference, intent: input.intent }
      : input.kind === "link"
        ? { kind: "link", title: input.title, url: input.url, intent: input.intent }
        : {
            kind: input.kind,
            title: input.kind === "location" ? input.name : undefined,
            intent: input.intent,
          },
  });
}

export async function handleAssistantIngest(req: IncomingMessage, res: ServerResponse) {
  if (!nativeOnly(req, res)) return;
  if (req.method !== "POST") return reply(req, res, 405, { error: "method" }, true);
  const tenant = tenantFor(req);
  if (!tenant) return reply(req, res, 401, { error: "unauthorized" }, true);
  try {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > JSON_LIMIT) return reply(req, res, 413, { error: "too_large" }, true);
    const input = validateCapture(JSON.parse((await readLimited(req, JSON_LIMIT)).toString("utf8")));
    if (!input) return reply(req, res, 400, { error: "bad_body" });
    const existing = known(tenant, input.clientId);
    if (existing) return reply(req, res, 200, { ok: true, created: false, itemId: existing.id });
    const result = post(tenant, input);
    return reply(req, res, 200, { ok: true, created: result.created, itemId: result.item.id });
  } catch (error) {
    return reply(req, res, error instanceof BlobTooLarge ? 413 : 400, { error: "bad_body" }, true);
  }
}

export async function handleAssistantFileIngest(req: IncomingMessage, res: ServerResponse) {
  if (!nativeOnly(req, res)) return;
  if (req.method !== "POST") return reply(req, res, 405, { error: "method" }, true);
  const tenant = tenantFor(req);
  if (!tenant) return reply(req, res, 401, { error: "unauthorized" }, true);
  const metadata = decodeMetadata(req);
  if (
    !metadata ||
    String(req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase() !== metadata.mime
  ) {
    return reply(req, res, 400, { error: "bad_metadata" }, true);
  }
  const existing = known(tenant, metadata.clientId);
  if (existing) return reply(req, res, 200, { ok: true, created: false, itemId: existing.id }, true);
  const reservation = `${tenant.id}:${metadata.clientId}`;
  const running = activeUploads.get(tenant.id) ?? 0;
  if (running >= MAX_UPLOADS_PER_TENANT || activeKeys.has(reservation)) {
    return reply(req, res, 429, { error: "busy" }, true);
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && (declared <= 0 || declared > FILE_LIMIT)) {
    return reply(req, res, declared > FILE_LIMIT ? 413 : 400, { error: "bad_size" }, true);
  }

  activeUploads.set(tenant.id, running + 1);
  activeKeys.add(reservation);
  // 请求体只在 Agent 无权写入的租户 stateDir 暂存；绝不在工作区创建上传临时文件。
  const directory = resolve(tenant.stateDir, "assistant", "capture-uploads");
  const digest = createHash("sha256").update(metadata.clientId).digest("hex").slice(0, 16);
  const suffix = randomBytes(8).toString("hex");
  const safeName = `${digest}-${suffix}-${metadata.filename}`;
  const temporaryPath = resolve(directory, `.${safeName}.tmp`);
  try {
    if (!isInside(temporaryPath, tenant.stateDir) || !isInside(temporaryPath, directory)) {
      return reply(req, res, 400, { error: "bad_path" }, true);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const [rootReal, directoryReal] = await Promise.all([realpath(tenant.stateDir), realpath(directory)]);
    if (!isInside(directoryReal, rootReal)) {
      return reply(req, res, 400, { error: "bad_path" }, true);
    }
    const handle = await open(temporaryPath, "wx", 0o600);
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const raw of req) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += chunk.length;
        if (size > FILE_LIMIT) throw new BlobTooLarge();
        if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
        await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!size) throw new Error("empty");
    if (metadata.kind === "image" && sniffCaptureImageMime(head) !== metadata.mime) {
      throw new Error("image mime mismatch");
    }
    const bytes = await readFile(temporaryPath);
    const artifact = storeArtifact(tenant.stateDir, bytes);
    await unlink(temporaryPath);
    checkArtifactQuota(tenant.stateDir);
    const reference: ControlledFileReference = {
      path: `captures/${digest}-${metadata.filename}`,
      sha: artifact.sha,
      mime: metadata.mime,
      size,
    };
    const capture: CaptureInput = {
      clientId: metadata.clientId,
      kind: "text",
      text: `${metadata.kind === "image" ? "图片" : "文件"}：${metadata.filename}`,
      intent: metadata.intent,
      note: metadata.note,
    };
    const result = post(tenant, capture, reference);
    log.info("assistant capture file", tenant.id, metadata.kind, size);
    return reply(req, res, 200, { ok: true, created: result.created, itemId: result.item.id, file: reference });
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof BlobTooLarge) return reply(req, res, 413, { error: "too_large" }, true);
    log.warn("assistant capture file failed", tenant.id, error instanceof Error ? error.message : error);
    return reply(req, res, 400, { error: "upload_failed" }, true);
  } finally {
    activeKeys.delete(reservation);
    const left = (activeUploads.get(tenant.id) ?? 1) - 1;
    if (left > 0) activeUploads.set(tenant.id, left);
    else activeUploads.delete(tenant.id);
  }
}
