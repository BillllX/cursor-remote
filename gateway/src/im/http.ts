// IM 的 HTTP 入口：POST /upload/im 上传附件，GET/HEAD /media/im 凭票据下载。
// nginx 只转发 /upload、/media 前缀，所以都挂在这两个前缀下。
//
// 上传鉴权：iOS 一律用 Authorization: Bearer <token> + 原始字节做 body——先鉴权再读 body，
// 边写临时文件边算 sha256，不进内存；每个租户同时最多 MAX_STREAM_UPLOADS_PER_TENANT 个，多了 429。
// multipart 只为兼容网页表单保留：要整包读进内存（token 在表单里时读完才知道是谁），
// 所以不管带不带 Authorization，全局最多同时 MAX_MULTIPART_UPLOADS 个，多了 503。
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyUploadCors, parseMultipartUpload } from "../http/routes.ts";
import { log } from "../log.ts";
import { parseRange } from "../media.ts";
import { allTenants, mediaSecret, resolveTenant } from "../tenants.ts";
import { MAX_UPLOAD_BYTES } from "../workspace/files.ts";
import { isBlobId } from "./body.ts";
import { imRuntime } from "./runtime.ts";
import { BlobTooLarge, type BlobKind, type ImStore } from "./store.ts";
import { matchImTicketTenant } from "./ticket.ts";

const MB = 1024 * 1024;
/** 按用途的大小上限；file 沿用工作区上传的 32MB */
export const BLOB_LIMITS: Record<BlobKind, number> = {
  image: 20 * MB,
  thumb: 1 * MB,
  voice: 2 * MB,
  file: MAX_UPLOAD_BYTES,
  avatar: 5 * MB,
  icon: 512 * 1024,
};
/** multipart 表单的边界、字段头等额外开销 */
const MULTIPART_OVERHEAD = 256 * 1024;
/** multipart 上传（整包进内存，可能还没鉴权）全局同时最多这么多个 */
export const MAX_MULTIPART_UPLOADS = 4;
/** 已鉴权的流式上传每个租户同时最多这么多个 */
export const MAX_STREAM_UPLOADS_PER_TENANT = 6;
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;

let multipartUploads = 0;
const streamUploads = new Map<string, number>();

/** 这个用途接受的 mime；图片类不收 svg（可执行脚本） */
export function blobMimeOk(kind: BlobKind, mime: string): boolean {
  if (!MIME_RE.test(mime)) return false;
  if (kind === "file") return true;
  if (kind === "voice") return mime.startsWith("audio/");
  return mime.startsWith("image/") && !mime.includes("svg");
}

const IMAGE_KINDS = new Set<BlobKind>(["image", "thumb", "avatar", "icon"]);

/** 按文件头认图片格式，认不出返回 null。图片类用途以它为准，不信客户端声明的 mime */
export function sniffImageMime(head: Buffer): string | null {
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

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 回完就断开：没读完的 body 不再收（不先 destroy，否则客户端拿不到状态码） */
function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, close = false) {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "private, no-store" };
  if (close) {
    headers.connection = "close";
    res.on("finish", () => req.destroy());
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/** 读进内存，超过 limit 抛 BlobTooLarge（暂停读取，留给调用方回 413） */
function readLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("close", onClose);
    };
    // 客户端中途断开：不一定有 error，只保证有 close；不处理的话并发名额永远不还
    const onClose = () => onError(new Error("上传中途断开"));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        fail(new BlobTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      done(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      fail(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

export async function handleImUpload(req: IncomingMessage, res: ServerResponse, url: URL, now = Date.now()) {
  applyUploadCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "0" }).end();
    return;
  }
  if (req.method !== "POST") return json(req, res, 405, { error: "method" }, true);
  const kind = (url.searchParams.get("kind") || "") as BlobKind;
  const mime = (url.searchParams.get("mime") || "").trim().toLowerCase();
  if (!Object.hasOwn(BLOB_LIMITS, kind)) {
    return json(req, res, 400, { error: "kind 只能是 image、thumb、voice、file、avatar、icon" }, true);
  }
  if (!blobMimeOk(kind, mime)) return json(req, res, 400, { error: "mime 不对" }, true);
  const limit = BLOB_LIMITS[kind];
  const multipart = /multipart\/form-data/i.test(String(req.headers["content-type"] || ""));
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""))?.[1]?.trim() || "";
  const tenant = bearer ? resolveTenant(bearer) : null;
  if ((bearer && !tenant) || (!bearer && !multipart)) {
    log.warn("im upload unauthorized", kind);
    return json(req, res, 401, { error: "unauthorized" }, true);
  }

  if (multipart) {
    // multipart 要整包读进内存再解析：不管带没带 Authorization，全局一起限并发
    if (multipartUploads >= MAX_MULTIPART_UPLOADS) {
      log.warn("im upload busy", kind);
      return json(req, res, 503, { error: "上传太多，稍后再试；建议用 Authorization 头 + 原始字节上传" }, true);
    }
    multipartUploads += 1;
    try {
      return await receive(req, res, { tenantId: tenant?.id ?? null, kind, mime, limit, multipart, now });
    } finally {
      multipartUploads -= 1;
    }
  }

  const id = (tenant as NonNullable<typeof tenant>).id;
  const running = streamUploads.get(id) ?? 0;
  if (running >= MAX_STREAM_UPLOADS_PER_TENANT) {
    log.warn("im upload busy", id, kind);
    return json(req, res, 429, { error: "同时上传太多，等前面的传完" }, true);
  }
  streamUploads.set(id, running + 1);
  try {
    return await receive(req, res, { tenantId: id, kind, mime, limit, multipart, now });
  } finally {
    const left = (streamUploads.get(id) ?? 1) - 1;
    if (left > 0) streamUploads.set(id, left);
    else streamUploads.delete(id);
  }
}

type Receive = {
  /** null = token 在表单里，读完才知道 */
  tenantId: string | null;
  kind: BlobKind;
  mime: string;
  limit: number;
  multipart: boolean;
  now: number;
};

async function receive(req: IncomingMessage, res: ServerResponse, opts: Receive) {
  const { store } = imRuntime();
  const declared = Number(req.headers["content-length"]);
  const cap = opts.multipart ? opts.limit + MULTIPART_OVERHEAD : opts.limit;
  if (Number.isFinite(declared) && declared > cap) return json(req, res, 413, { error: "文件太大" }, true);
  let upload: { tmp: string; sha: string; size: number };
  let tenantId = opts.tenantId;
  try {
    if (opts.multipart) {
      const parsed = parseMultipartUpload(await readLimited(req, cap), String(req.headers["content-type"]));
      tenantId ??= resolveTenant((parsed.token || "").trim())?.id ?? null;
      if (!tenantId) {
        log.warn("im upload unauthorized", opts.kind);
        return json(req, res, 401, { error: "unauthorized" });
      }
      upload = await store.ingest(parsed.file || Buffer.alloc(0), opts.limit);
    } else {
      upload = await store.ingest(req, opts.limit);
    }
  } catch (err) {
    if (err instanceof BlobTooLarge) return json(req, res, 413, { error: "文件太大" }, true);
    log.warn("im upload failed", opts.kind, err instanceof Error ? err.message : err);
    return json(req, res, 400, { error: "读不了这个文件" }, true);
  }
  const out = await finishUpload(store, upload, {
    kind: opts.kind,
    mime: opts.mime,
    tenantId: tenantId as string,
    now: opts.now,
  });
  json(req, res, out.status, out.body);
}

/**
 * 临时文件写完之后：校验（空文件、图片格式）并归位。不管成功、校验不过还是中途抛错，
 * finally 都删临时文件（归位成功后它已经不在了）
 */
export async function finishUpload(
  store: ImStore,
  upload: { tmp: string; sha: string; size: number },
  opts: { kind: BlobKind; mime: string; tenantId: string; now: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    if (!upload.size) return { status: 400, body: { error: "空文件" } };
    let mime = opts.mime;
    if (IMAGE_KINDS.has(opts.kind)) {
      const sniffed = sniffImageMime(await readHead(upload.tmp));
      if (!sniffed) return { status: 400, body: { error: "不是支持的图片格式（jpeg/png/gif/webp/heic/avif）" } };
      mime = sniffed;
    }
    const meta = await store.commitBlob(upload, opts.kind, mime, opts.tenantId, opts.now);
    log.info("im upload", opts.tenantId, opts.kind, meta.size);
    return { status: 200, body: { blob: meta.sha, size: meta.size, mime: meta.kinds[opts.kind] } };
  } finally {
    await unlink(upload.tmp).catch(() => undefined);
  }
}

export async function handleImMedia(req: IncomingMessage, res: ServerResponse, url: URL) {
  const scope = url.searchParams.get("scope") || "";
  const sha = url.searchParams.get("blob") || "";
  const exp = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";
  const noStore = { "cache-control": "private, no-store" };
  const tenantId = matchImTicketTenant(
    mediaSecret(),
    allTenants().map((item) => item.id),
    scope,
    exp,
    sig,
  );
  if (!tenantId) {
    res.writeHead(401, noStore).end("unauthorized");
    return;
  }
  if (!isBlobId(sha)) {
    res.writeHead(400, noStore).end("bad blob");
    return;
  }
  const { service, store } = imRuntime();
  const mime = await service.canDownload(tenantId, scope, sha);
  const file = store.blobFile(sha);
  const info = mime ? await stat(file).catch(() => null) : null;
  if (!mime || !info) {
    res.writeHead(404, noStore).end("not found");
    return;
  }
  const size = info.size;
  const range = parseRange(req.headers.range, size);
  if (req.headers.range && !range) {
    res.writeHead(416, { "content-range": `bytes */${size}` }).end();
    return;
  }
  // file 用途的 mime 是上传者声明的，可能是 svg / html：一律当附件下载
  const inline = /^(image|audio|video)\//.test(mime) && !mime.includes("svg");
  const headers: Record<string, string | number> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    // 用户上传的内容：不让它在网关域名下跑脚本
    "content-security-policy": "sandbox; default-src 'none'",
    "content-disposition": inline ? "inline" : "attachment",
    "content-length": range ? range.end - range.start + 1 : size,
  };
  if (range) headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = range ? createReadStream(file, { start: range.start, end: range.end }) : createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
