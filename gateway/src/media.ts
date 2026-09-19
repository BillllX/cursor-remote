import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
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
) {
  const kind = file.kind;
  const ticket = chatId ? mediaTicket(secret, tenantId, chatId) : undefined;
  const rel = file.path || path;
  const httpText = Boolean(kind && preferHttpText(kind) && !diff);
  const bust = file.size != null ? String(file.size) : undefined;
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
      kind && (needsMediaUrl(kind) || httpText)
        ? mediaPath(chatId || "", rel, ticket, httpText ? bust : undefined)
        : undefined,
    headUrl:
      kind && needsMediaUrl(kind) && file.hasHead
        ? mediaPath(chatId || "", rel, ticket, "HEAD")
        : undefined,
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

function filenameOf(path: string) {
  return basename(path).replace(/[\r\n"]/g, "_") || "file";
}

function headersFor(
  mime: string,
  size: number,
  filename: string,
  range: { start: number; end: number } | null,
) {
  const headers: Record<string, string | number> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": `inline; filename="${filename}"`,
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
  res.writeHead(status, headersFor(mime, buf.length, filenameOf(path), range));
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
  const mime = mimeOf(path, kind);
  const range = parseRange(req.headers.range, st.size);
  if (req.headers.range && !range) {
    res.writeHead(416, { "content-range": `bytes */${st.size}` });
    res.end();
    return;
  }
  const status = range ? 206 : 200;
  res.writeHead(status, headersFor(mime, st.size, filenameOf(path), range));
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
