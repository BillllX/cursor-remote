import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { MediaTicket, PreviewKind } from "../../shared/protocol.ts";
import { isByteKind, mimeOf, needsMediaUrl, preferHttpText, sizeLimit } from "../../shared/preview.ts";

export function signMedia(secret: string, tenantId: string, chatId: string, exp: number) {
  return createHmac("sha256", secret).update(`${tenantId}\n${chatId}\n${exp}`).digest("base64url");
}

export function mediaTicket(secret: string, tenantId: string, chatId: string): MediaTicket | undefined {
  if (!secret || !tenantId || !chatId) return undefined;
  const exp = Date.now() + 2 * 60 * 60_000;
  return { exp, sig: signMedia(secret, tenantId, chatId, exp) };
}

export function mediaTicketOk(
  secret: string,
  tenantId: string,
  chatId: string,
  exp: string,
  sig: string,
) {
  const until = Number(exp);
  if (!secret || !tenantId || !chatId || !sig || !Number.isFinite(until) || Date.now() > until + 30_000) {
    return false;
  }
  const expected = Buffer.from(signMedia(secret, tenantId, chatId, until));
  const got = Buffer.from(sig);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export function matchMediaTenant(
  secret: string,
  tenantIds: string[],
  chatId: string,
  exp: string,
  sig: string,
): string | null {
  let matched: string | null = null;
  for (const id of tenantIds) {
    if (mediaTicketOk(secret, id, chatId, exp, sig)) matched = id;
  }
  return matched;
}

export function mediaPath(chatId: string, path: string, ticket?: MediaTicket, rev?: string) {
  if (!ticket || !chatId || !path) return undefined;
  const q = new URLSearchParams({
    path,
    chatId,
    exp: String(ticket.exp),
    sig: ticket.sig,
  });
  if (rev) q.set("rev", rev);
  return `/media?${q}`;
}

export function filePayload(
  secret: string,
  tenantId: string,
  chatId: string | undefined,
  path: string,
  file: {
    path?: string;
    content?: string;
    error?: string;
    kind?: PreviewKind;
    mime?: string;
    size?: number;
    hasHead?: boolean;
  },
  diff: boolean,
  echo: { reqId?: string; sha?: string } = {},
) {
  const kind = file.kind;
  const ticket = chatId ? mediaTicket(secret, tenantId, chatId) : undefined;
  const rel = file.path || path;
  const httpText = Boolean(kind && preferHttpText(kind) && !diff);
  const bust = file.size != null ? String(file.size) : undefined;
  // 快照按内容寻址，rev 本身就能防缓存；对照文本只走 content，不给 url
  const snapshot = echo.sha && !diff && !file.error ? `sha:${echo.sha}` : undefined;
  const live = !echo.sha;
  return {
    type: "file_content" as const,
    chatId,
    path: rel,
    content: file.content,
    error: file.error,
    diff,
    kind,
    mime: file.mime,
    size: file.size,
    media: ticket,
    url:
      kind && (needsMediaUrl(kind) || httpText) && (live || snapshot)
        ? mediaPath(chatId || "", rel, ticket, snapshot || (httpText ? bust : undefined))
        : undefined,
    headUrl:
      live && kind && needsMediaUrl(kind) && file.hasHead
        ? mediaPath(chatId || "", rel, ticket, "HEAD")
        : undefined,
    ...(echo.reqId != null ? { reqId: echo.reqId } : {}),
    ...(echo.sha != null ? { sha: echo.sha } : {}),
  };
}

function parseRange(header: string | undefined, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const hasStart = match[1] !== "";
  const hasEnd = match[2] !== "";
  if (!hasStart && !hasEnd) return null;
  let start = hasStart ? Number(match[1]) : Number.NaN;
  let end = hasEnd ? Number(match[2]) : Number.NaN;
  if (!hasStart) {
    const suffix = end;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else if (!hasEnd) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(path: string) {
  // Node 拒绝 header 里的非 Latin-1 字符；中文文件名会让 writeHead 抛 ERR_INVALID_CHAR，
  // 再被 uncaughtException 带去 process.exit，整台网关一起重连。
  const base = basename(path).replace(/[\r\n"]/g, "_").trim() || "file";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_") || "file";
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

function imageMimeFrom(buf: Buffer, fallback: string) {
  if (!fallback.startsWith("image/") || fallback.includes("svg")) return fallback;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 6 && buf.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return fallback;
}

function sniffFileMime(abs: string, fallback: string) {
  if (!fallback.startsWith("image/") || fallback.includes("svg")) return fallback;
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return imageMimeFrom(buf.subarray(0, n), fallback);
  } catch {
    return fallback;
  } finally {
    closeSync(fd);
  }
}

function headersFor(
  mime: string,
  size: number,
  path: string,
  range: { start: number; end: number } | null,
) {
  const headers: Record<string, string | number> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(path),
    "x-content-type-options": "nosniff",
  };
  if (range) {
    headers["content-length"] = range.end - range.start + 1;
    headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
  } else {
    headers["content-length"] = size;
  }
  return headers;
}

export function sendMediaBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  buf: Buffer,
  path: string,
  mime = mimeOf(path),
) {
  const range = parseRange(req.headers.range, buf.length);
  if (req.headers.range && !range) {
    res.writeHead(416, { "content-range": `bytes */${buf.length}` });
    res.end();
    return;
  }
  const status = range ? 206 : 200;
  const type = imageMimeFrom(buf.subarray(0, 16), mime);
  res.writeHead(status, headersFor(type, buf.length, path, range));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(range ? buf.subarray(range.start, range.end + 1) : buf);
}

export function sendMediaFile(
  req: IncomingMessage,
  res: ServerResponse,
  abs: string,
  path: string,
  kind: PreviewKind,
) {
  if (!existsSync(abs)) {
    res.writeHead(404).end("not found");
    return;
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  const limit = isByteKind(kind) ? sizeLimit(kind) : Math.max(sizeLimit(kind), 2_000_000);
  if (st.size > limit) {
    res.writeHead(413).end("too large");
    return;
  }
  const mime = sniffFileMime(abs, mimeOf(path, kind));
  const range = parseRange(req.headers.range, st.size);
  if (req.headers.range && !range) {
    res.writeHead(416, { "content-range": `bytes */${st.size}` });
    res.end();
    return;
  }
  const status = range ? 206 : 200;
  res.writeHead(status, headersFor(mime, st.size, path, range));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = range
    ? createReadStream(abs, { start: range.start, end: range.end })
    : createReadStream(abs);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

export { isByteKind, sizeLimit };
