// 长录音专用 HTTP 端点：
// - /upload/recordings/v1/...（控制面 + 流式音频段/清单/端侧逐字稿上传，不改动全站 /upload 32MiB 上限）
// - /media/recordings/v1/...（Header Bearer 鉴权 + 单 Range 206/416 原音回放）
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { saveMemory } from "../assistant/memory.ts";
import { log } from "../log.ts";
import { parseRange } from "../media.ts";
import { isInside } from "../pathInside.ts";
import { allTenants, resolveTenant, type Tenant } from "../tenants.ts";
import { getAsrAdapter } from "./asr.ts";
import { isSha256Hex, RecordingError } from "./errors.ts";
import { getRecordingStore } from "./runtime.ts";
import {
  RECORDING_CANONICAL_SAMPLE_RATE,
  RECORDING_MAX_CHUNK_BYTES,
  RECORDING_MAX_CHUNKS,
  RECORDING_MAX_DURATION_FRAMES,
  RECORDING_MAX_JSON_BYTES,
  RECORDING_MAX_MANIFEST_BYTES,
  RECORDING_MAX_TOTAL_BYTES,
  RECORDING_MAX_TRANSCRIPT_BYTES,
  RECORDING_SCHEMA_VERSION,
  type RecordingAudioFormat,
  type RecordingErrorBody,
  type RecordingGrantRecord,
  type RecordingJobStage,
  type RecordingManifest,
  type RecordingPolicySnapshot,
  type RecordingRoute,
  type RecordingTranscriptPayload,
} from "./types.ts";

const UPLOAD_PREFIX = "/upload/recordings/v1";
const MEDIA_PREFIX = "/media/recordings/v1";
const MAX_CONCURRENT_STREAMS_PER_TENANT = 4;
const activeStreams = new Map<string, number>();

function newRequestId(): string {
  return `req_${randomBytes(6).toString("hex")}`;
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  opts?: { close?: boolean; etag?: string; retryAfterSeconds?: number },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (opts?.etag) headers.etag = opts.etag;
  if (opts?.retryAfterSeconds) headers["retry-after"] = String(opts.retryAfterSeconds);
  if (opts?.close) {
    headers.connection = "close";
    res.on("finish", () => req.destroy());
  }
  res.writeHead(status, headers).end(JSON.stringify(body));
}

function sendError(req: IncomingMessage, res: ServerResponse, err: unknown, close = false) {
  const requestId = newRequestId();
  if (err instanceof RecordingError) {
    const body: RecordingErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
        requestId,
      },
      ...(err.state ? { state: err.state } : {}),
      ...(err.revision !== undefined ? { revision: err.revision } : {}),
    };
    sendJson(req, res, err.status, body, { close, retryAfterSeconds: err.retryAfterSeconds });
    return;
  }
  log.warn("recordings http unexpected error", requestId, err instanceof Error ? err.message : err);
  const body: RecordingErrorBody = {
    error: {
      code: "INTERNAL_ERROR",
      message: "录音服务暂时出错，请稍后重试",
      retryable: true,
      requestId,
    },
  };
  sendJson(req, res, 500, body, { close });
}

function extractBearer(req: IncomingMessage): string {
  const header = String(req.headers.authorization || "");
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
}

/** 仅允许正式登录 Bearer（用于管理/查询/回放/删除/记忆确认） */
function requireLoginTenant(req: IncomingMessage, tenants: Tenant[]): Tenant {
  const token = extractBearer(req);
  if (!token) {
    throw new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "缺少登录凭证" });
  }
  // 显式拦截把上传 grant 当登录 token 用
  if (token.startsWith("jbrg_")) {
    throw new RecordingError({ status: 403, code: "SCOPE_DENIED", message: "上传授权不可用于查询或回放接口" });
  }
  const matched = resolveTenant(token) ?? tenants.find((t) => t === resolveTenant(token)) ?? null;
  if (!matched) {
    throw new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "登录凭证无效或已过期" });
  }
  return matched;
}

/** 支持正式登录 Bearer 或短期作用域上传 grant（服务器推导租户，不信任请求体 tenantId） */
function requireUploadPrincipal(
  req: IncomingMessage,
  tenants: Tenant[],
): { tenant: Tenant; grant?: RecordingGrantRecord; actor: string } {
  const token = extractBearer(req);
  if (!token) {
    throw new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "缺少授权凭证" });
  }
  if (token.startsWith("jbrg_")) {
    let lastError: RecordingError | null = null;
    for (const tenant of tenants) {
      const store = getRecordingStore(tenant);
      try {
        const grant = store.verifyUploadGrant(token);
        return { tenant, grant, actor: `grant:${grant.grantId}` };
      } catch (err) {
        if (err instanceof RecordingError && err.code === "SCOPE_DENIED") {
          lastError = err;
        } else if (err instanceof RecordingError && err.message.includes("过期")) {
          lastError = err;
        }
      }
    }
    throw (
      lastError ??
      new RecordingError({ status: 401, code: "TOKEN_EXPIRED", message: "上传凭证无效或已过期，请刷新授权" })
    );
  }
  const tenant = requireLoginTenant(req, tenants);
  return { tenant, actor: `tenant:${tenant.id}` };
}

async function readJsonBody<T>(req: IncomingMessage, limit: number): Promise<T> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new RecordingError({ status: 413, code: "CHUNK_TOO_LARGE", message: "请求体超过大小限制" });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += buf.length;
    if (size > limit) {
      throw new RecordingError({ status: 413, code: "CHUNK_TOO_LARGE", message: "请求体超过大小限制" });
    }
    chunks.push(buf);
  }
  if (!size) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "JSON 格式错误" });
  }
}

/** 校验基础音频封装魔数（MP4/M4A 含 ftyp，CAF 含 caff），防任意脚本/伪造文件落盘 */
function isPlausibleAudioContainer(head: Buffer, mime: string): boolean {
  if (head.length < 8) return false;
  const ascii4 = (start: number) => head.subarray(start, start + 4).toString("latin1");
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) {
    // ISO BMFF (m4a/mp4) 第 4..8 字节为 "ftyp"，或 ADTS AAC 同步头 0xFFFx
    if (ascii4(4) === "ftyp") return true;
    if (head[0] === 0xff && (head[1]! & 0xf0) === 0xf0) return true;
    return false;
  }
  if (mime.includes("caf") || mime.includes("x-caf")) {
    return ascii4(0) === "caff";
  }
  return ascii4(4) === "ftyp" || ascii4(0) === "caff";
}

async function streamToTempFileWithSha256(
  req: IncomingMessage,
  tmpDir: string,
  limitBytes: number,
  mime: string,
): Promise<{ tmpPath: string; bytes: number; sha256: string }> {
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tmpPath = resolve(tmpDir, `chunk-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  if (!isInside(tmpPath, tmpDir)) {
    throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "临时路径无效" });
  }
  const hash = createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  const handle = await open(tmpPath, "wx", 0o600);
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > limitBytes) {
        throw new RecordingError({ status: 413, code: "CHUNK_TOO_LARGE", message: "音频段超过 8MiB 上限" });
      }
      if (head.length < 16) {
        head = Buffer.concat([head, chunk]).subarray(0, 16);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  await handle.close();

  if (size <= 0) {
    await unlink(tmpPath).catch(() => undefined);
    throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "音频段不能为空" });
  }
  if (!isPlausibleAudioContainer(head, mime)) {
    await unlink(tmpPath).catch(() => undefined);
    throw new RecordingError({ status: 422, code: "AUDIO_CORRUPT", message: "音频容器头无效或已损坏" });
  }
  return { tmpPath, bytes: size, sha256: hash.digest("hex") };
}

export type RecordingsHttpContext = {
  tenants?: () => Tenant[];
};

export async function handleRecordingsUploadHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx?: RecordingsHttpContext,
) {
  const tenants = ctx?.tenants ? ctx.tenants() : allTenants();
  const rel = url.pathname.slice(UPLOAD_PREFIX.length) || "/";
  const method = (req.method || "GET").toUpperCase();

  try {
    // 1. GET /capabilities
    if (method === "GET" && rel === "/capabilities") {
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const adapter = getAsrAdapter();
      return sendJson(req, res, 200, {
        schemaVersion: RECORDING_SCHEMA_VERSION,
        enabled: true,
        canonicalSampleRate: RECORDING_CANONICAL_SAMPLE_RATE,
        limits: {
          maxChunkBytes: RECORDING_MAX_CHUNK_BYTES,
          maxChunks: RECORDING_MAX_CHUNKS,
          maxTotalBytes: RECORDING_MAX_TOTAL_BYTES,
          maxDurationFrames: RECORDING_MAX_DURATION_FRAMES,
          maxManifestBytes: RECORDING_MAX_MANIFEST_BYTES,
          maxTranscriptBytes: RECORDING_MAX_TRANSCRIPT_BYTES,
        },
        quota: {
          totalBytes: store.quotaBytes,
          usedBytes: store.usedBytes(),
          remainingBytes: store.remainingQuotaBytes(),
        },
        asr: {
          onDeviceSupported: true,
          serverAdapterAvailable: Boolean(adapter),
          serverProvider: adapter?.capabilities.provider ?? null,
        },
        features: {
          onDeviceTranscriptSync: true,
          audioSyncOptional: true,
          backgroundUpload: true,
          routeChange: false,
        },
      });
    }

    // 2. POST /upload-grants
    if (method === "POST" && rel === "/upload-grants") {
      const tenant = requireLoginTenant(req, tenants);
      const body = await readJsonBody<{
        deviceId?: string;
        route?: RecordingRoute;
        policySnapshot?: Partial<RecordingPolicySnapshot>;
        namespacePrefix?: string;
        ttlSeconds?: number;
      }>(req, RECORDING_MAX_JSON_BYTES);
      const store = getRecordingStore(tenant);
      const issued = store.issueUploadGrant({
        deviceId: String(body.deviceId || ""),
        route: body.route ?? { kind: "personal", workspaceId: null },
        policySnapshot: body.policySnapshot ?? {},
        namespacePrefix: body.namespacePrefix,
        ttlMs: typeof body.ttlSeconds === "number" ? body.ttlSeconds * 1000 : undefined,
      });
      return sendJson(req, res, 201, issued);
    }

    // 3. GET /sessions (列表)
    if (method === "GET" && (rel === "/sessions" || rel === "/sessions/")) {
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const limit = Number(url.searchParams.get("limit") || "30");
      const cursor = url.searchParams.get("cursor") || undefined;
      return sendJson(req, res, 200, store.listSessions({ limit: Number.isFinite(limit) ? limit : 30, cursor }));
    }

    // 4. POST /sessions (可选在线预检/占位)
    if (method === "POST" && (rel === "/sessions" || rel === "/sessions/")) {
      const tenant = requireLoginTenant(req, tenants);
      const body = await readJsonBody<{
        sessionId?: string;
        deviceId?: string;
        title?: string;
        startedAt?: string;
        route?: RecordingRoute;
        policySnapshot?: Partial<RecordingPolicySnapshot>;
        format?: Partial<RecordingAudioFormat>;
      }>(req, RECORDING_MAX_JSON_BYTES);
      const store = getRecordingStore(tenant);
      const out = store.createOrGetSession({
        sessionId: String(body.sessionId || ""),
        deviceId: String(body.deviceId || ""),
        title: body.title,
        startedAt: body.startedAt,
        route: body.route ?? { kind: "personal", workspaceId: null },
        policySnapshot: body.policySnapshot,
        format: body.format,
      });
      return sendJson(req, res, out.created ? 201 : 200, {
        ...out.session,
        limits: {
          maxChunkBytes: RECORDING_MAX_CHUNK_BYTES,
          maxChunks: RECORDING_MAX_CHUNKS,
          maxTotalBytes: RECORDING_MAX_TOTAL_BYTES,
        },
      });
    }

    // 匹配 /sessions/{id}/...
    const chunkMatch = /^\/sessions\/([^/]+)\/chunks\/(\d+)$/.exec(rel);
    if (method === "PUT" && chunkMatch) {
      const sessionId = decodeURIComponent(chunkMatch[1]!);
      const seq = Number(chunkMatch[2]!);
      const principal = requireUploadPrincipal(req, tenants);
      const store = getRecordingStore(principal.tenant);
      const generation = Number(req.headers["x-recording-generation"] || "1");
      const expectedSha = String(req.headers["x-chunk-sha256"] || "").trim().toLowerCase();
      const startFrame = Number(req.headers["x-capture-start-frame"]);
      const validFrames = Number(req.headers["x-valid-frame-count"]);
      const epochId = String(req.headers["x-epoch-id"] || "epoch-0").trim();
      const mime = String(req.headers["content-type"] || "audio/mp4")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const declared = Number(req.headers["content-length"]);

      if (!isSha256Hex(expectedSha)) {
        throw new RecordingError({ status: 400, code: "INVALID_METADATA", message: "缺少有效的 X-Chunk-SHA256 请求头" });
      }
      store.precheckChunkUpload({
        sessionId,
        seq,
        generation,
        declaredBytes: Number.isFinite(declared) ? declared : undefined,
        grant: principal.grant,
      });

      const running = activeStreams.get(principal.tenant.id) ?? 0;
      if (running >= MAX_CONCURRENT_STREAMS_PER_TENANT) {
        throw new RecordingError({
          status: 429,
          code: "RATE_LIMITED",
          message: "同时上传音频段过多，请稍后自动重试",
          retryable: true,
          retryAfterSeconds: 10,
        });
      }
      activeStreams.set(principal.tenant.id, running + 1);
      try {
        const streamed = await streamToTempFileWithSha256(
          req,
          store.tmpDir,
          principal.grant?.maxChunkBytes ?? RECORDING_MAX_CHUNK_BYTES,
          mime,
        );
        if (streamed.sha256 !== expectedSha) {
          await unlink(streamed.tmpPath).catch(() => undefined);
          throw new RecordingError({
            status: 422,
            code: "HASH_MISMATCH",
            message: "上传音频段的 SHA-256 校验与声明不符",
          });
        }
        const committed = store.commitChunkFile({
          sessionId,
          generation,
          seq,
          epochId,
          captureStartFrame: startFrame,
          validFrameCount: validFrames,
          sha256: streamed.sha256,
          bytes: streamed.bytes,
          mime,
          tmpFilePath: streamed.tmpPath,
          grant: principal.grant,
          actor: principal.actor,
        });
        return sendJson(req, res, committed.replayed ? 200 : 201, committed);
      } finally {
        const left = (activeStreams.get(principal.tenant.id) ?? 1) - 1;
        if (left > 0) activeStreams.set(principal.tenant.id, left);
        else activeStreams.delete(principal.tenant.id);
      }
    }

    // PUT /sessions/{id}/transcript（端侧边录边转生成的带时间戳逐字稿）
    const transcriptMatch = /^\/sessions\/([^/]+)\/transcript$/.exec(rel);
    if (method === "PUT" && transcriptMatch) {
      const sessionId = decodeURIComponent(transcriptMatch[1]!);
      const principal = requireUploadPrincipal(req, tenants);
      const store = getRecordingStore(principal.tenant);
      const generation = Number(req.headers["x-recording-generation"] || "1");
      const payload = await readJsonBody<RecordingTranscriptPayload>(req, RECORDING_MAX_TRANSCRIPT_BYTES);
      const saved = store.saveTranscript({
        sessionId,
        generation,
        payload,
        grant: principal.grant,
        actor: principal.actor,
      });
      return sendJson(req, res, saved.replayed ? 200 : 201, saved);
    }

    // PUT /sessions/{id}/manifest（不可变最终清单文件，到齐后自动触发整理）
    const manifestMatch = /^\/sessions\/([^/]+)\/manifest$/.exec(rel);
    if (method === "PUT" && manifestMatch) {
      const sessionId = decodeURIComponent(manifestMatch[1]!);
      const principal = requireUploadPrincipal(req, tenants);
      const store = getRecordingStore(principal.tenant);
      const manifest = await readJsonBody<RecordingManifest>(req, RECORDING_MAX_MANIFEST_BYTES);
      const out = store.commitManifest({
        sessionId,
        manifest,
        grant: principal.grant,
        actor: principal.actor,
      });
      return sendJson(req, res, out.statusCode, {
        ...out.session,
        missingSeqs: out.missingSeqs,
        replayed: out.replayed,
      });
    }

    // POST /sessions/{id}/finalize（可选快捷确认）
    const finalizeMatch = /^\/sessions\/([^/]+)\/finalize$/.exec(rel);
    if (method === "POST" && finalizeMatch) {
      const sessionId = decodeURIComponent(finalizeMatch[1]!);
      const principal = requireUploadPrincipal(req, tenants);
      const store = getRecordingStore(principal.tenant);
      const body = await readJsonBody<{ generation?: number; manifestHash?: string }>(req, RECORDING_MAX_JSON_BYTES);
      const out = store.finalizeExplicit(
        sessionId,
        Number(body.generation ?? 1),
        String(body.manifestHash || ""),
        principal.actor,
      );
      return sendJson(req, res, out.statusCode, {
        ...out.session,
        missingSeqs: out.missingSeqs,
      });
    }

    // GET /sessions/{id}（支持 ETag/304）
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(rel);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      if (method === "GET") {
        const view = store.getSession(sessionId);
        const etag = `"rev-${view.revision}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": "private, no-store" }).end();
          return;
        }
        return sendJson(req, res, 200, view, { etag });
      }
      if (method === "DELETE") {
        const body = await readJsonBody<{ expectedRevision?: number; deleteLinkedMemories?: boolean }>(
          req,
          RECORDING_MAX_JSON_BYTES,
        );
        const status = store.deleteSession({
          sessionId,
          expectedRevision: body.expectedRevision,
          deleteLinkedMemories: body.deleteLinkedMemories,
          actor: `tenant:${tenant.id}`,
        });
        return sendJson(req, res, 202, status);
      }
    }

    // GET /sessions/{id}/result
    const resultMatch = /^\/sessions\/([^/]+)\/result$/.exec(rel);
    if (method === "GET" && resultMatch) {
      const sessionId = decodeURIComponent(resultMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const out = store.getResult(sessionId);
      if (!out.ready) {
        return sendJson(req, res, 202, out.session);
      }
      return sendJson(req, res, 200, out.result);
    }

    // GET /sessions/{id}/deletion
    const deletionMatch = /^\/sessions\/([^/]+)\/deletion$/.exec(rel);
    if (method === "GET" && deletionMatch) {
      const sessionId = decodeURIComponent(deletionMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      return sendJson(req, res, 200, store.getDeletionStatus(sessionId));
    }

    // POST /sessions/{id}/retry
    const retryMatch = /^\/sessions\/([^/]+)\/retry$/.exec(rel);
    if (method === "POST" && retryMatch) {
      const sessionId = decodeURIComponent(retryMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const body = await readJsonBody<{ expectedRevision?: number; stage?: RecordingJobStage }>(
        req,
        RECORDING_MAX_JSON_BYTES,
      );
      const view = store.retryProcessing(sessionId, body.expectedRevision, body.stage, `tenant:${tenant.id}`);
      return sendJson(req, res, 202, view);
    }

    // POST /sessions/{id}/cancel
    const cancelMatch = /^\/sessions\/([^/]+)\/cancel$/.exec(rel);
    if (method === "POST" && cancelMatch) {
      const sessionId = decodeURIComponent(cancelMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const body = await readJsonBody<{ expectedRevision?: number }>(req, RECORDING_MAX_JSON_BYTES);
      const view = store.cancelProcessing(sessionId, body.expectedRevision, `tenant:${tenant.id}`);
      return sendJson(req, res, 202, view);
    }

    // POST /sessions/{id}/accept-partial
    const partialMatch = /^\/sessions\/([^/]+)\/accept-partial$/.exec(rel);
    if (method === "POST" && partialMatch) {
      const sessionId = decodeURIComponent(partialMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const body = await readJsonBody<{ expectedRevision?: number }>(req, RECORDING_MAX_JSON_BYTES);
      const view = store.acceptPartial(sessionId, body.expectedRevision, `tenant:${tenant.id}`);
      return sendJson(req, res, 202, view);
    }

    // POST /sessions/{id}/revisions
    const revisionMatch = /^\/sessions\/([^/]+)\/revisions$/.exec(rel);
    if (method === "POST" && revisionMatch) {
      const sessionId = decodeURIComponent(revisionMatch[1]!);
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const body = await readJsonBody<{ expectedRevision?: number; reason?: "repair" | "route_change" }>(
        req,
        RECORDING_MAX_JSON_BYTES,
      );
      const view = store.createRevision({
        sessionId,
        expectedRevision: body.expectedRevision,
        reason: body.reason === "route_change" ? "route_change" : "repair",
        actor: `tenant:${tenant.id}`,
      });
      return sendJson(req, res, 202, view);
    }

    // POST /sessions/{id}/memories/{candidateId}/confirm|dismiss（用户显式点击确认才写个人记忆）
    const memMatch = /^\/sessions\/([^/]+)\/memories\/([^/]+)\/(confirm|dismiss)$/.exec(rel);
    if (method === "POST" && memMatch) {
      const sessionId = decodeURIComponent(memMatch[1]!);
      const candidateId = decodeURIComponent(memMatch[2]!);
      const action = memMatch[3] as "confirm" | "dismiss";
      const tenant = requireLoginTenant(req, tenants);
      const store = getRecordingStore(tenant);
      const updated = store.updateMemoryCandidate({
        sessionId,
        candidateId,
        action,
        actor: `tenant:${tenant.id}`,
        saveConfirmedMemory:
          action === "confirm"
            ? (text, topic) => {
                const resMem = saveMemory(
                  tenant,
                  { text, topic, kind: "事实", basis: "user_said" },
                  "page",
                );
                if (!resMem.ok) return { ok: false, error: resMem.error };
                return { ok: true, memoryId: resMem.value.id };
              }
            : undefined,
      });
      return sendJson(req, res, 200, updated);
    }

    throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "未找到对应的录音接口" });
  } catch (err) {
    sendError(req, res, err, method === "PUT");
  }
}

export async function handleRecordingsMediaHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx?: RecordingsHttpContext,
) {
  const tenants = ctx?.tenants ? ctx.tenants() : allTenants();
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return sendError(req, res, new RecordingError({ status: 405, code: "METHOD_NOT_ALLOWED", message: "仅支持 GET/HEAD" }));
  }

  try {
    const tenant = requireLoginTenant(req, tenants);
    const rel = url.pathname.slice(MEDIA_PREFIX.length) || "/";
    const match = /^\/sessions\/([^/]+)\/chunks\/(\d+)$/.exec(rel);
    if (!match) {
      throw new RecordingError({ status: 404, code: "NOT_FOUND", message: "未找到音频段" });
    }
    const sessionId = decodeURIComponent(match[1]!);
    const seq = Number(match[2]!);
    const store = getRecordingStore(tenant);
    const chunk = store.getChunkFileForPlayback(sessionId, seq);

    const range = parseRange(req.headers.range, chunk.size);
    if (req.headers.range && !range) {
      res.writeHead(416, {
        "content-range": `bytes */${chunk.size}`,
        "cache-control": "private, no-store",
      }).end();
      return;
    }

    const headers: Record<string, string | number> = {
      "content-type": chunk.mime,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": "inline",
      "content-length": range ? range.end - range.start + 1 : chunk.size,
      etag: `"${chunk.sha256}"`,
    };
    if (range) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${chunk.size}`;
    }
    res.writeHead(range ? 206 : 200, headers);
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = range
      ? createReadStream(chunk.absPath, { start: range.start, end: range.end })
      : createReadStream(chunk.absPath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    sendError(req, res, err);
  }
}
