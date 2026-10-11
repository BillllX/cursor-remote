// HTTP 路由处理：上传、媒体、已存状态，以及 agent websocket 路径判断（createServer 与 listen 留在 index.ts）
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { isByteKind, kindFromPath, mimeOf, sizeLimit } from "../../../shared/preview.ts";
import { log } from "../log.ts";
import { matchMediaTenant, sendMediaBuffer, sendMediaFile } from "../media.ts";
import { chatOwnedByOther, cwdForChat } from "../runtime/slots.ts";
import { storedStatePayload } from "../sync/storedState.ts";
import { allTenants, getTenant, hasAuth, mediaSecret, resolveTenant } from "../tenants.ts";
import { isSha, readArtifact, SNAPSHOT_GONE } from "../turnFiles.ts";
import { MAX_UPLOAD_BYTES, uniqueUploadPath, workspacePath, writeWorkspaceBytes } from "../workspace/files.ts";
import { gitBytes, gitRoot, shadowGitEnv } from "../workspace/git.ts";

export function agentSocketPath(url = "/") {
  const path = (url.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  return path === "/" || path === "/ws" || path === "/bridge";
}

function uploadCorsOrigin(req: IncomingMessage): string | null {
  const origin = String(req.headers.origin || "");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const host = String(req.headers.host || "").split(":")[0];
    const name = url.hostname;
    if (
      name === host ||
      name === "localhost" ||
      name === "127.0.0.1" ||
      name === "aiagentswitcher.com" ||
      name.endsWith(".aiagentswitcher.com")
    ) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function applyUploadCors(req: IncomingMessage, res: ServerResponse) {
  const origin = uploadCorsOrigin(req);
  if (origin) res.setHeader("access-control-allow-origin", origin);
  const requested = String(req.headers["access-control-request-headers"] || "")
    .trim()
    .toLowerCase();
  res.setHeader("access-control-allow-headers", requested || "authorization, content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("vary", "origin");
}

function parseMultipartUpload(
  buf: Buffer,
  contentType: string,
): {
  token?: string;
  filename?: string;
  file?: Buffer;
} {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] || match?.[2] || "").trim();
  if (!boundary) return {};
  const sep = Buffer.from(`--${boundary}`);
  const out: { token?: string; filename?: string; file?: Buffer } = {};
  let start = buf.indexOf(sep);
  if (start < 0) return {};
  start += sep.length;
  if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
  const nextSep = Buffer.from(`\r\n--${boundary}`);
  while (start < buf.length) {
    if (buf[start] === 45 && buf[start + 1] === 45) break;
    const headerEnd = buf.indexOf("\r\n\r\n", start);
    if (headerEnd < 0) break;
    const headers = buf.slice(start, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;
    const next = buf.indexOf(nextSep, bodyStart);
    if (next < 0) break;
    const body = buf.slice(bodyStart, next);
    const name = /name="([^"]+)"/i.exec(headers)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1] || /filename\*=(?:UTF-8'')?([^;\s]+)/i.exec(headers)?.[1];
    if (name === "token") out.token = body.toString("utf8");
    else if (name === "file" || filename != null) {
      out.file = body;
      if (filename) out.filename = filename;
    }
    start = next + 2 + sep.length;
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
  }
  return out;
}

function readRequestBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL) {
  applyUploadCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "0" }).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: "method" }));
    return;
  }
  const chatId = url.searchParams.get("chatId") || "";
  let name = url.searchParams.get("name") || "file";
  let buf: Buffer;
  let formToken = "";
  try {
    const raw = await readRequestBody(req, MAX_UPLOAD_BYTES + 256_000);
    const contentType = String(req.headers["content-type"] || "");
    if (/multipart\/form-data/i.test(contentType)) {
      const parsed = parseMultipartUpload(raw, contentType);
      formToken = parsed.token || "";
      buf = parsed.file || Buffer.alloc(0);
      if (parsed.filename) {
        try {
          name = decodeURIComponent(parsed.filename);
        } catch {
          name = parsed.filename;
        }
      }
      if (!buf.length) {
        log.warn("upload multipart empty", name, raw.length);
      }
    } else {
      buf = raw;
    }
  } catch (err) {
    const tooBig = err instanceof Error && err.message === "too large";
    res
      .writeHead(tooBig ? 413 : 400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: tooBig ? "文件超过 32MB" : "读不了这个文件" }));
    return;
  }
  const header = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
  const token = bearer || formToken.trim();
  const tenant = resolveTenant(token);
  if (!tenant) {
    log.warn("upload unauthorized", req.method, name);
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (chatId && chatOwnedByOther(chatId, tenant)) {
    res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  if (!buf.length) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "空文件" }));
    return;
  }
  const cwd = chatId ? cwdForChat(tenant, chatId) : tenant.workspaceRoot;
  const rel = uniqueUploadPath(cwd, name);
  if (!rel) {
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "没法在工作区里放下这个文件" }));
    return;
  }
  const written = writeWorkspaceBytes(cwd, rel, buf);
  if (written.error) {
    res
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: written.error, path: written.path }));
    return;
  }
  log.info("upload", written.path, written.size);
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ path: written.path, size: written.size, name }));
}

export function handleMedia(req: IncomingMessage, res: ServerResponse, url: URL) {
  const chatId = url.searchParams.get("chatId") || "";
  const raw = url.searchParams.get("path") || "";
  const exp = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";
  const rev = (url.searchParams.get("rev") || "").trim();
  const header = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
  const bearerTenant = bearer ? resolveTenant(bearer) : null;
  const ticketTenantId = matchMediaTenant(
    mediaSecret(),
    allTenants().map((item) => item.id),
    chatId,
    exp,
    sig,
  );
  const tenant = bearerTenant || (ticketTenantId ? getTenant(ticketTenantId) : undefined);
  if (!hasAuth() || !tenant) {
    res.writeHead(401, { "cache-control": "private, no-store" }).end("unauthorized");
    return;
  }
  if (chatId && chatOwnedByOther(chatId, tenant)) {
    res.writeHead(403, { "cache-control": "private, no-store" }).end("forbidden");
    return;
  }
  if (!chatId || !raw) {
    res.writeHead(400).end("missing path");
    return;
  }
  if (rev.startsWith("sha:")) {
    // 回合快照只从本租户 artifacts 目录取，path 只决定 mime 和文件名
    const sha = rev.slice(4);
    if (!isSha(sha)) {
      res.writeHead(400).end("bad sha");
      return;
    }
    const buf = readArtifact(tenant.stateDir, sha);
    if (!buf) {
      res.writeHead(404, { "cache-control": "private, no-store" }).end(SNAPSHOT_GONE);
      return;
    }
    sendMediaBuffer(req, res, buf, raw, mimeOf(raw, kindFromPath(raw)));
    return;
  }
  const cwd = cwdForChat(tenant, chatId);
  const path = workspacePath(cwd, raw);
  if (!path) {
    res.writeHead(403).end("path");
    return;
  }
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  if (rev === "HEAD") {
    const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
    try {
      const buf = gitBytes(cwd, ["show", `HEAD:${path}`], env);
      const limit = isByteKind(kind) ? sizeLimit(kind) : Math.max(sizeLimit(kind), 2_000_000);
      if (buf.length > limit) {
        res.writeHead(413).end("too large");
        return;
      }
      sendMediaBuffer(req, res, buf, path, mime);
    } catch {
      res.writeHead(404).end("not in HEAD");
    }
    return;
  }
  sendMediaFile(req, res, resolve(cwd, path), path, kind);
}

/// GET /state：stored_state 的 HTTP 版，给收不了超大 WS 消息的客户端（iOS 约 1MiB 上限）
/// ?slim=1：与 WS hello 的 slim_state cap 对齐（HTTP 无连接态，靠参数传递）
export function handleState(req: IncomingMessage, res: ServerResponse) {
  const header = String(req.headers.authorization || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
  const tenant = bearer ? resolveTenant(bearer) : null;
  if (!hasAuth() || !tenant) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const slim = new URL(req.url || "/", "http://127.0.0.1").searchParams.get("slim") === "1";
  res.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
  res.end(JSON.stringify(storedStatePayload(tenant, slim)));
}
