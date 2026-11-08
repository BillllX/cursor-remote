import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getTenant } from "../tenants.ts";
import { readWorkspaceAgentFile, workspaceAgentById, workspaceAgentDirectories } from "../workspace/agents.ts";
import {
  DEFAULT_ALLOWED_EXTS,
  DEFAULT_MAX_FILE_BYTES,
  isAllowedUploadFileName,
  safeReadWorkspaceTextFileSync,
  validateKbHtmlRelPath,
} from "./contract.ts";
import { scanWorkspaceKbHtmlBoards } from "./hub.ts";
import { commitDropBatchAndEnqueue, hasIngestQueueCapacity, submitDirectIngestBatch } from "./queue.ts";
import { runKbQaAsk } from "./qaRunner.ts";
import {
  clearQaSessionStorageSync,
  ensureQaSessionStorageSync,
  measureQaSessionDiskUsageSync,
  QA_MAX_FILE_BYTES,
  QA_UPLOAD_ALLOWED_EXTS,
  safeReadQaFileSync,
  streamUploadQaTempFile,
  validateQaTempFileName,
} from "./qaStorage.ts";
import {
  allocateDropBatchCredentials,
  cleanupAbortedStagingBatchSync,
  getDropBatchPublicStatus,
  MAX_FILES_PER_BATCH,
  sanitizeBatchNote,
  streamStageFileIntoBatch,
} from "./staging.ts";
import {
  bindBatchIdToDropSession,
  normalizeClientIp,
  reverifyStatelessDropSession,
  verifyDropPasscodeAndCreateSession,
  verifyDropPasscodeStateless,
  verifyDropSessionToken,
  type DropTenantHost,
} from "./tokens.ts";
import { MAX_KB_HTML_BYTES } from "./tools.ts";

export type DropPortalTenant = {
  id: string;
  workspaceRoot: string;
  stateDir: string;
  name?: string;
};

const PAGE_TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PAGE_TICKETS = 2048;

/** 短期页面访问票据：仅在服务端直出 /p/<tenant>/drop HTML 时内嵌下发，绑定 tenantId 与 clientIp */
const activePageTickets = new Map<string, { tenantId: string; clientIp: string; expiresAt: number }>();

function issuePageTicket(tenantId: string, clientIp: string, now = Date.now()): string {
  for (const [k, v] of activePageTickets.entries()) {
    if (v.expiresAt <= now) activePageTickets.delete(k);
  }
  while (activePageTickets.size >= MAX_PAGE_TICKETS) {
    const oldest = activePageTickets.keys().next().value;
    if (!oldest) break;
    activePageTickets.delete(oldest);
  }
  const ticket = `pt_${randomBytes(24).toString("hex")}`;
  activePageTickets.set(ticket, {
    tenantId,
    clientIp,
    expiresAt: now + PAGE_TICKET_TTL_MS,
  });
  return ticket;
}

function verifyPageTicket(tenantId: string, clientIp: string, rawTicket: string, now = Date.now()): boolean {
  const clean = rawTicket.trim();
  if (!clean.startsWith("pt_")) return false;
  let matched = false;
  for (const [storedTicket, entry] of activePageTickets.entries()) {
    if (entry.expiresAt <= now) {
      activePageTickets.delete(storedTicket);
      continue;
    }
    const a = Buffer.from(clean);
    const b = Buffer.from(storedTicket);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (entry.tenantId === tenantId && entry.clientIp === clientIp) {
        matched = true;
      }
    }
  }
  return matched;
}

/** 构造供 HTTP 投递门户使用的 DropTenantHost */
export function buildDropTenantHost(tenant: DropPortalTenant): DropTenantHost {
  return {
    id: tenant.id,
    stateDir: tenant.stateDir,
    workspaceRoot: tenant.workspaceRoot,
    resolveWorkspace: (keyOrId: string) => {
      const target = keyOrId.trim();
      if (!target) return null;
      const registered = getTenant(tenant.id);
      const fullTenant =
        registered && registered.stateDir === tenant.stateDir && registered.workspaceRoot === tenant.workspaceRoot
          ? registered
          : ({
              id: tenant.id,
              stateDir: tenant.stateDir,
              workspaceRoot: tenant.workspaceRoot,
            } as Parameters<typeof readWorkspaceAgentFile>[0]);

      if (target.startsWith("wsa_")) {
        const byId = workspaceAgentById(fullTenant, target);
        if (byId) return { workspaceId: byId.item.workspaceId, key: byId.key, path: byId.path };
      }
      const file = readWorkspaceAgentFile(fullTenant);
      const dir = workspaceAgentDirectories(fullTenant).find((d) => d.key === target);
      if (dir && file.items[dir.key]) {
        return {
          workspaceId: file.items[dir.key].workspaceId,
          key: dir.key,
          path: dir.path,
        };
      }
      return null;
    },
  };
}

function applySandboxedApiCors(res: ServerResponse) {
  res.setHeader("access-control-allow-origin", "null");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-drop-receipt, x-drop-page-ticket");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("vary", "origin");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  if (res.headersSent || res.writableEnded) return;
  applySandboxedApiCors(res);
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(raw.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
    ...extraHeaders,
  });
  res.end(raw);
}

/**
 * 顶层文档启用 `CSP: sandbox allow-scripts`（不带 `allow-same-origin`）：
 * 1. 使顶层文档直接处于唯一的不透明源（opaque origin），彻底隔绝同域名下其他 `/p/<租户>` 页面通过 `window.open` 访问本页 `window`、DOM 或脚本上下文；
 * 2. `connect-src *` 允许沙箱内脚本直接 `fetch` 调用 `/p/<tenant>/drop/api/*`，并携带服务端直出内嵌的 `X-Drop-Page-Ticket` 票据完成请求；
 * 3. `frame-src data:` / `child-src data:` 允许在页面内通过 `<iframe sandbox="allow-scripts" srcdoc="...">` 安全预览知识库 HTML 看板。
 */
function sendHtml(res: ServerResponse, status: number, page: string, headOnly: boolean) {
  if (res.headersSent || res.writableEnded) return;
  const raw = Buffer.from(page, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(raw.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src *; img-src data:; frame-src data: about:; child-src data: about:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-scripts allow-downloads",
  });
  res.end(headOnly ? undefined : raw);
}

function sendBinaryAttachment(res: ServerResponse, fileName: string, buffer: Buffer) {
  if (res.headersSent || res.writableEnded) return;
  applySandboxedApiCors(res);
  const asciiFallback = fileName.replace(/[^\x20-\x7e]|["\\;\r\n]/g, "_") || "download.txt";
  const utf8Encoded = encodeURIComponent(fileName);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(buffer.length),
    "content-disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
  });
  res.end(buffer);
}

function extractBearerToken(req: IncomingMessage): string {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1]?.trim() || "";
}

/**
 * 提取客户端真实 IP（仅当 socket 对端是回环反代时才采信转发头，且取 XFF 最后一跳，防客户端伪造请求头绕过限流）
 */
function extractClientIp(req: IncomingMessage): string {
  const remote = (req.socket?.remoteAddress || "").trim();
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback) {
    const realIp = String(req.headers["x-real-ip"] || "").trim();
    if (realIp) return normalizeClientIp(realIp);
    const xff = String(req.headers["x-forwarded-for"] || "").trim();
    if (xff) {
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return normalizeClientIp(parts[parts.length - 1]);
      }
    }
  }
  return normalizeClientIp(remote || "unknown");
}

/**
 * 安全读取小体积 JSON 请求体：超限时排空请求流而不调用 req.destroy()，确保客户端能完整收到 413 JSON 响应。
 */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 32 * 1024,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: 400 | 413; error: string }> {
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    await new Promise<void>((resolveRead, rejectRead) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolveRead());
      req.on("error", (err) => rejectRead(err));
    });
    if (tooLarge) {
      return { ok: false, status: 413, error: "请求体积超出上限" };
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "请求体必须是 JSON 对象" };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "无效的 JSON 请求体" };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 生成顶层沙箱隔离（`CSP: sandbox allow-scripts allow-downloads`）的单文件内联知识库协作与投递门户 HTML 页面。
 * 采用横向双栏紧凑设计：左侧按优先级由上至下依次为「知识库只读问答（核心区）→ 资料上传 → 知识库页面目录」，右侧常驻实时预览工作台。
 */
export function renderDropPortalHtml(tenantId: string, tenantName?: string, pageTicket = ""): string {
  const displayTenant = escapeHtml(tenantName || tenantId);
  const basePath = `/p/${encodeURIComponent(tenantId)}/drop`;
  const allowedListText = DEFAULT_ALLOWED_EXTS.join(" / ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>工作区资料投递箱与知识库看板 · ${displayTenant}</title>
  <style>
    :root {
      --bg: #0f1419;
      --card: #182028;
      --border: #2a3644;
      --text: #e7edf3;
      --muted: #8b9bb0;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f4f6f9;
        --card: #ffffff;
        --border: #dce3ec;
        --text: #1a2330;
        --muted: #5a6b82;
        --accent: #2563eb;
        --accent-hover: #1d4ed8;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px 16px 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    .container { max-width: 1680px; margin: 0 auto; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }
    .card-qa-primary {
      border-color: rgba(59, 130, 246, 0.45);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
    }
    .auth-card {
      max-width: 460px;
      margin: 40px auto;
      padding: 20px 22px;
    }
    h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
    h2 { margin: 0; font-size: 16px; font-weight: 600; }
    .sub { color: var(--muted); font-size: 12px; margin: 0 0 14px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      background: rgba(59, 130, 246, 0.15);
      color: var(--accent);
    }
    label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; color: var(--muted); }
    input[type="text"], input[type="password"], textarea {
      width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-ghost {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 4px 10px;
      font-size: 12px;
    }
    .btn-ghost.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn-rm {
      background: transparent;
      color: var(--muted);
      padding: 2px 7px;
      font-size: 11px;
      border: 1px solid var(--border);
      margin-left: 4px;
    }
    .workspace-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 16px;
      margin-bottom: 12px;
    }
    .split-workbench {
      display: grid;
      grid-template-columns: minmax(460px, 43%) minmax(520px, 57%);
      gap: 12px;
      align-items: start;
    }
    @media (max-width: 1100px) {
      .split-workbench {
        grid-template-columns: 1fr;
      }
      .right-column {
        position: static;
      }
    }
    .left-column {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }
    .right-column {
      position: sticky;
      top: 12px;
      min-width: 0;
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    .step-pill {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(59, 130, 246, 0.15);
      color: var(--accent);
    }
    .qa-chat-box {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      padding: 10px 12px;
      min-height: 260px;
      max-height: 440px;
      overflow-y: auto;
      margin-bottom: 10px;
    }
    .qa-msg {
      padding: 8px 11px;
      border-radius: 8px;
      margin-bottom: 8px;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .qa-msg:last-child { margin-bottom: 0; }
    .qa-msg-user {
      background: rgba(59, 130, 246, 0.14);
      border: 1px solid rgba(59, 130, 246, 0.35);
    }
    .qa-msg-ai {
      background: var(--card);
      border: 1px solid var(--border);
    }
    .qa-msg-role {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 3px;
    }
    .qa-composer {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .qa-composer textarea {
      flex: 1;
      resize: vertical;
      min-height: 58px;
      margin: 0;
    }
    .qa-chip-list {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .qa-file-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      font-size: 11px;
    }
    .dropzone {
      border: 1.5px dashed var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .dropzone.dragover { border-color: var(--accent); }
    .upload-action-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .upload-action-row input[type="text"] {
      flex: 1;
      margin: 0;
    }
    .file-list { list-style: none; padding: 0; margin: 0 0 8px; }
    .file-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .file-err { border-color: var(--danger); color: var(--danger); }
    .file-ok { border-color: var(--success); }
    .board-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(185px, 1fr));
      gap: 8px;
      max-height: 240px;
      overflow-y: auto;
      padding-right: 2px;
    }
    .board-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, background 0.15s;
    }
    .board-card:hover, .board-card.active {
      border-color: var(--accent);
      background: rgba(59, 130, 246, 0.08);
    }
    .board-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 2px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .board-meta {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .preview-dock-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 96px);
    }
    .board-viewer-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 12px;
      background: var(--card);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .preview-switch-group {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .board-viewer {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: #ffffff;
    }
    .board-iframe {
      width: 100%;
      height: calc(100vh - 145px);
      min-height: 620px;
      border: 0;
      display: block;
      background: #ffffff;
    }
    .preview-empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
      min-height: 520px;
      background: var(--bg);
    }
    .qa-preview-box {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--card);
    }
    .qa-preview-pre {
      margin: 0;
      padding: 14px;
      font-size: 12px;
      height: calc(100vh - 145px);
      min-height: 620px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
      background: var(--bg);
      color: var(--text);
    }
    .status-box {
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-size: 12px;
      margin-top: 8px;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="container">
    <div id="step-auth" class="card auth-card">
      <h1>工作区资料投递箱 & 知识库</h1>
      <p class="sub">输入口令即可向知识库提问、上传归档文档或查阅看板（单文件 ≤ 32 MB）</p>
      <div style="margin-bottom:10px;">
        <label for="submitter">您的称呼 / 部门</label>
        <input id="submitter" type="text" maxlength="40" autocomplete="off" placeholder="例如：张工-财务部" />
      </div>
      <div style="margin-bottom:14px;">
        <label for="passcode">工作区口令</label>
        <input id="passcode" type="password" maxlength="64" autocomplete="off" placeholder="请输入 6–64 位投递口令" />
      </div>
      <button id="btn-auth" type="button" style="width:100%;">进入知识库工作台</button>
      <div id="auth-msg" class="status-box hidden"></div>
    </div>

    <div id="step-main" class="hidden">
      <div class="workspace-topbar">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="badge">知识库</span>
          <h2 id="ws-title">知识库工作区</h2>
        </div>
        <div id="batch-info" style="font-size:12px;color:var(--muted);"></div>
      </div>

      <div class="split-workbench">
        <!-- 左侧栏：1. 提问（核心区） -> 2. 上传 -> 3. 知识库页面 -->
        <div class="left-column">
          <!-- 1. 提问（最上方核心区域：知识库只读问答） -->
          <div id="pane-qa" class="card card-qa-primary" style="margin-bottom:0;">
            <div class="section-header">
              <h3 class="section-title">
                <span>💬 知识库提问</span>
                <span class="step-pill" title="问答仅读取知识库白名单并在临时沙箱生成报表">知识库只读问答</span>
                <span id="qa-board-hint" style="font-size:11px;font-weight:400;color:var(--muted);"></span>
              </h3>
              <div style="display:flex;gap:6px;align-items:center;">
                <button id="btn-qa-attach" type="button" class="btn-ghost">📎 比对附件</button>
                <input id="qa-file-input" type="file" accept=".csv,.md,.txt,.json,.sql" class="hidden" />
                <button id="btn-qa-clear" type="button" class="btn-ghost">清空</button>
              </div>
            </div>

            <div id="qa-temp-files" class="qa-chip-list hidden"></div>

            <div id="qa-chat-box" class="qa-chat-box">
              <div id="qa-empty-hint" style="color:var(--muted);font-size:12px;text-align:center;padding:48px 12px;">
                直接询问业务数据，或让 AI 生成 CSV / HTML 统计表供右侧预览与下载
              </div>
              <div id="qa-messages"></div>
            </div>

            <div class="qa-composer">
              <textarea id="qa-input" rows="2" maxlength="4000" placeholder="输入问题或统计指令（Enter 发送，Shift+Enter 换行）…"></textarea>
              <button id="btn-qa-send" type="button" style="height:58px;padding:0 18px;">发送提问</button>
            </div>
            <div id="qa-msg-box" class="status-box hidden"></div>
          </div>

          <!-- 2. 上传（紧凑资料投递区） -->
          <div id="pane-upload" class="card" style="margin-bottom:0;">
            <div class="section-header" style="margin-bottom:8px;">
              <h3 class="section-title">
                <span>📤 上传资料</span>
              </h3>
              <span style="font-size:11px;color:var(--muted);">≤ 32MB · 最多 ${MAX_FILES_PER_BATCH} 个 (${escapeHtml(allowedListText)})</span>
            </div>
            <div id="dropzone" class="dropzone">
              <span>点击选择或拖拽文件至此上传</span>
              <input id="file-input" type="file" multiple class="hidden" />
            </div>
            <ul id="file-list" class="file-list"></ul>
            <div class="upload-action-row">
              <input id="batch-note" type="text" maxlength="500" placeholder="补充说明（可选，帮助 AI 归档分类）" />
              <button id="btn-submit" type="button">上传归档</button>
            </div>
            <div id="upload-msg" class="status-box hidden"></div>
          </div>

          <!-- 3. 知识库页面（HTML 看板目录） -->
          <div id="pane-boards" class="card" style="margin-bottom:0;">
            <div class="section-header" style="margin-bottom:8px;">
              <h3 class="section-title">
                <span>📊 知识库页面 (<span id="board-count">0</span>)</span>
              </h3>
              <button id="btn-refresh-boards" type="button" class="btn-ghost">刷新</button>
            </div>
            <div id="boards-empty" class="status-box hidden" style="margin-top:0;">暂无已生成的知识库看板页面</div>
            <div id="boards-grid" class="board-grid"></div>
          </div>
        </div>

        <!-- 右侧常驻预览栏：统一承载「知识库看板预览」与「AI 生成的临时统计文件预览」 -->
        <div class="right-column">
          <div class="preview-dock-card">
            <div class="board-viewer-bar">
              <div style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                <span id="preview-mode-badge" class="step-pill" style="margin-right:6px;">预览</span>
                <strong id="viewer-title">点击左侧知识库页面或问答报表预览</strong>
                <strong id="qa-preview-title" class="hidden">临时统计文件预览</strong>
              </div>
              <div class="preview-switch-group">
                <button id="tab-boards" type="button" class="btn-ghost active">📊 知识库</button>
                <button id="tab-qa" type="button" class="btn-ghost">📄 问答报表</button>
                <button id="btn-ask-this-board" type="button" class="btn-ghost hidden">💬 就此页提问</button>
                <button id="btn-download-active-qa" type="button" class="btn-ghost hidden">⬇️ 下载</button>
                <button id="btn-close-viewer" type="button" class="btn-ghost hidden">关闭</button>
                <button id="btn-close-qa-preview" type="button" class="btn-ghost hidden">关闭</button>
              </div>
            </div>

            <!-- 空状态占位 -->
            <div id="preview-empty" class="preview-empty-state">
              <div style="font-size:24px;margin-bottom:6px;">🖥️</div>
              <div>选择左侧「知识库页面」或问答生成的报表在此预览</div>
            </div>

            <!-- 视图 1：知识库 HTML 看板预览 -->
            <div id="board-viewer" class="board-viewer hidden">
              <iframe id="viewer-frame" class="board-iframe" sandbox="allow-scripts"></iframe>
            </div>

            <!-- 视图 2：问答生成的临时统计文件预览 -->
            <div id="qa-file-preview" class="qa-preview-box hidden">
              <pre id="qa-preview-pre" class="qa-preview-pre hidden"></pre>
              <iframe id="qa-preview-frame" class="board-iframe hidden" sandbox=""></iframe>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    (function() {
      try { window.opener = null; } catch (_) {}
      const API_BASE = ${JSON.stringify(basePath)} + "/api";
      const PAGE_TICKET = ${JSON.stringify(pageTicket)};
      const submitterEl = document.getElementById("submitter");
      const passcodeEl = document.getElementById("passcode");
      const btnAuth = document.getElementById("btn-auth");
      const authMsg = document.getElementById("auth-msg");
      const stepAuth = document.getElementById("step-auth");
      const stepMain = document.getElementById("step-main");
      const wsTitle = document.getElementById("ws-title");
      const batchInfo = document.getElementById("batch-info");
      const tabBoards = document.getElementById("tab-boards");
      const tabQa = document.getElementById("tab-qa");
      const boardCountEl = document.getElementById("board-count");
      const boardsGrid = document.getElementById("boards-grid");
      const boardsEmpty = document.getElementById("boards-empty");
      const btnRefreshBoards = document.getElementById("btn-refresh-boards");
      const boardViewer = document.getElementById("board-viewer");
      const viewerTitle = document.getElementById("viewer-title");
      const viewerFrame = document.getElementById("viewer-frame");
      const btnCloseViewer = document.getElementById("btn-close-viewer");
      const btnAskThisBoard = document.getElementById("btn-ask-this-board");
      const dropzone = document.getElementById("dropzone");
      const fileInput = document.getElementById("file-input");
      const fileListEl = document.getElementById("file-list");
      const noteEl = document.getElementById("batch-note");
      const btnSubmit = document.getElementById("btn-submit");
      const uploadMsg = document.getElementById("upload-msg");
      const btnQaAttach = document.getElementById("btn-qa-attach");
      const qaFileInput = document.getElementById("qa-file-input");
      const btnQaClear = document.getElementById("btn-qa-clear");
      const qaTempFilesEl = document.getElementById("qa-temp-files");
      const qaEmptyHint = document.getElementById("qa-empty-hint");
      const qaMessagesEl = document.getElementById("qa-messages");
      const qaChatBox = document.getElementById("qa-chat-box");
      const qaInputEl = document.getElementById("qa-input");
      const btnQaSend = document.getElementById("btn-qa-send");
      const qaBoardHint = document.getElementById("qa-board-hint");
      const qaMsgBox = document.getElementById("qa-msg-box");
      const qaFilePreview = document.getElementById("qa-file-preview");
      const qaPreviewTitle = document.getElementById("qa-preview-title");
      const qaPreviewPre = document.getElementById("qa-preview-pre");
      const qaPreviewFrame = document.getElementById("qa-preview-frame");
      const btnCloseQaPreview = document.getElementById("btn-close-qa-preview");
      const previewEmpty = document.getElementById("preview-empty");
      const previewModeBadge = document.getElementById("preview-mode-badge");
      const btnDownloadActiveQa = document.getElementById("btn-download-active-qa");

      let sessionToken = "";
      let batchId = "";
      let receiptToken = "";
      let maxFileBytes = ${DEFAULT_MAX_FILE_BYTES};
      let allowedExts = ${JSON.stringify([...DEFAULT_ALLOWED_EXTS])};
      let pendingFiles = [];
      let boardsList = [];
      let activeBoardPath = "";
      let activeBoardTitle = "";
      let activeQaFileName = "";
      let qaTempFiles = [];

      function showBox(el, text, isErr) {
        el.textContent = text;
        el.classList.remove("hidden");
        el.style.borderColor = isErr ? "var(--danger)" : "var(--border)";
      }

      function updateQaBoardHint() {
        if (activeBoardPath) {
          qaBoardHint.textContent = "· 关联: " + activeBoardPath;
        } else {
          qaBoardHint.textContent = "";
        }
      }

      function switchRightPreview(mode) {
        const hasBoard = Boolean(activeBoardPath);
        const hasQaFile = Boolean(activeQaFileName);
        if (mode === "board" && hasBoard) {
          tabBoards.classList.add("active");
          tabQa.classList.remove("active");
          previewModeBadge.textContent = "📊 知识库";
          if (activeBoardTitle) {
            viewerTitle.textContent = activeBoardTitle;
          }
          viewerTitle.classList.remove("hidden");
          qaPreviewTitle.classList.add("hidden");
          previewEmpty.classList.add("hidden");
          boardViewer.classList.remove("hidden");
          qaFilePreview.classList.add("hidden");
          btnAskThisBoard.classList.remove("hidden");
          btnCloseViewer.classList.remove("hidden");
          btnDownloadActiveQa.classList.add("hidden");
          btnCloseQaPreview.classList.add("hidden");
        } else if (mode === "qa" && hasQaFile) {
          tabQa.classList.add("active");
          tabBoards.classList.remove("active");
          previewModeBadge.textContent = "📄 报表";
          viewerTitle.classList.add("hidden");
          qaPreviewTitle.classList.remove("hidden");
          previewEmpty.classList.add("hidden");
          boardViewer.classList.add("hidden");
          qaFilePreview.classList.remove("hidden");
          btnAskThisBoard.classList.add("hidden");
          btnCloseViewer.classList.add("hidden");
          btnDownloadActiveQa.classList.remove("hidden");
          btnCloseQaPreview.classList.remove("hidden");
        } else {
          tabBoards.classList.toggle("active", mode !== "qa");
          tabQa.classList.toggle("active", mode === "qa");
          previewModeBadge.textContent = "预览";
          viewerTitle.classList.remove("hidden");
          viewerTitle.textContent = mode === "qa" ? "暂未选择问答报表" : "点击左侧知识库页面或问答报表预览";
          qaPreviewTitle.classList.add("hidden");
          previewEmpty.classList.remove("hidden");
          boardViewer.classList.add("hidden");
          qaFilePreview.classList.add("hidden");
          btnAskThisBoard.classList.add("hidden");
          btnCloseViewer.classList.add("hidden");
          btnDownloadActiveQa.classList.add("hidden");
          btnCloseQaPreview.classList.add("hidden");
        }
        updateQaBoardHint();
      }

      tabBoards.addEventListener("click", function() { switchRightPreview("board"); });
      tabQa.addEventListener("click", function() { switchRightPreview("qa"); });
      btnAskThisBoard.addEventListener("click", function() {
        updateQaBoardHint();
        qaInputEl.focus();
      });
      btnDownloadActiveQa.addEventListener("click", function() {
        if (activeQaFileName) {
          previewOrDownloadQaFile(activeQaFileName, true);
        }
      });

      function renderBoards(boards) {
        boardsList = Array.isArray(boards) ? boards : [];
        boardCountEl.textContent = String(boardsList.length);
        boardsGrid.innerHTML = "";
        if (boardsList.length === 0) {
          boardsEmpty.classList.remove("hidden");
          return;
        }
        boardsEmpty.classList.add("hidden");
        boardsList.forEach(function(b) {
          const card = document.createElement("div");
          card.className = "board-card" + (activeBoardPath === b.relPath ? " active" : "");
          card.title = b.relPath;
          const title = document.createElement("div");
          title.className = "board-title";
          title.textContent = b.title;
          const meta = document.createElement("div");
          meta.className = "board-meta";
          meta.textContent = (b.category ? b.category + " · " : "") + b.relPath;
          card.appendChild(title);
          card.appendChild(meta);
          card.addEventListener("click", function() {
            openBoardPreview(b.relPath, b.title);
          });
          boardsGrid.appendChild(card);
        });
      }

      async function openBoardPreview(relPath, title) {
        activeBoardPath = relPath;
        activeBoardTitle = "正在加载：" + title + " (" + relPath + ")…";
        renderBoards(boardsList);
        viewerTitle.textContent = activeBoardTitle;
        switchRightPreview("board");
        try {
          const u = API_BASE + "/board?path=" + encodeURIComponent(relPath);
          const res = await fetch(u, {
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET
            }
          });
          const data = await res.json();
          if (activeBoardPath !== relPath) return;
          if (!res.ok || !data.ok) {
            activeBoardTitle = "加载失败：" + (data.error || "无法读取该看板");
            viewerTitle.textContent = activeBoardTitle;
            return;
          }
          activeBoardTitle = title + " — " + relPath;
          viewerTitle.textContent = activeBoardTitle;
          viewerFrame.srcdoc = data.htmlContent || "";
        } catch (e) {
          if (activeBoardPath !== relPath) return;
          activeBoardTitle = "网络请求失败，无法加载看板";
          viewerTitle.textContent = activeBoardTitle;
        }
      }

      btnCloseViewer.addEventListener("click", function() {
        activeBoardPath = "";
        activeBoardTitle = "";
        viewerFrame.srcdoc = "";
        renderBoards(boardsList);
        if (activeQaFileName) {
          switchRightPreview("qa");
        } else {
          switchRightPreview("empty");
        }
      });

      async function refreshBoardsList() {
        if (!sessionToken) return;
        try {
          const res = await fetch(API_BASE + "/boards", {
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET
            }
          });
          const data = await res.json();
          if (res.ok && data.ok && Array.isArray(data.boards)) {
            renderBoards(data.boards);
          }
        } catch (_) {}
      }

      btnRefreshBoards.addEventListener("click", refreshBoardsList);

      btnAuth.addEventListener("click", async function() {
        const submitterName = submitterEl.value.trim();
        const passcode = passcodeEl.value.trim();
        if (!submitterName || !passcode) {
          showBox(authMsg, "请填写您的称呼和投递口令", true);
          return;
        }
        btnAuth.disabled = true;
        try {
          const res = await fetch(API_BASE + "/auth", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-drop-page-ticket": PAGE_TICKET
            },
            body: JSON.stringify({ passcode: passcode, submitterName: submitterName })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            showBox(authMsg, data.error || "验证失败", true);
            btnAuth.disabled = false;
            return;
          }
          passcodeEl.value = "";
          sessionToken = data.dropSessionToken;
          batchId = data.batchId;
          receiptToken = data.receiptToken;
          maxFileBytes = data.maxFileBytes || maxFileBytes;
          allowedExts = data.allowedExts || allowedExts;
          wsTitle.textContent = data.workspaceTitle;
          batchInfo.textContent = "当前投递批次：" + batchId + " · 访客：" + submitterName;
          stepAuth.classList.add("hidden");
          stepMain.classList.remove("hidden");
          renderBoards(data.boards || []);
          updateQaBoardHint();
          if (Array.isArray(data.boards) && data.boards.length > 0) {
            openBoardPreview(data.boards[0].relPath, data.boards[0].title);
          } else {
            switchRightPreview("empty");
          }
        } catch (e) {
          showBox(authMsg, "网络请求失败，请重试", true);
          btnAuth.disabled = false;
        }
      });

      function extOf(name) {
        const idx = name.lastIndexOf(".");
        return idx > 0 ? name.slice(idx).toLowerCase() : "";
      }

      function renderFiles() {
        fileListEl.innerHTML = "";
        pendingFiles.forEach(function(item, idx) {
          const li = document.createElement("li");
          li.className = "file-item" + (item.error ? " file-err" : item.uploaded ? " file-ok" : "");
          const span = document.createElement("span");
          const sizeMB = (item.file.size / (1024 * 1024)).toFixed(2) + " MB";
          span.textContent = item.file.name + " (" + sizeMB + ") — " + (item.error || item.statusText);
          li.appendChild(span);
          if (!item.uploaded) {
            const rmBtn = document.createElement("button");
            rmBtn.type = "button";
            rmBtn.className = "btn-rm";
            rmBtn.textContent = "移除";
            rmBtn.addEventListener("click", function() {
              pendingFiles.splice(idx, 1);
              renderFiles();
            });
            li.appendChild(rmBtn);
          }
          fileListEl.appendChild(li);
        });
      }

      function addSelectedFiles(fileList) {
        let skippedOverLimit = 0;
        for (let i = 0; i < fileList.length; i++) {
          const validCount = pendingFiles.filter(function(x) { return !x.error; }).length;
          if (validCount >= ${MAX_FILES_PER_BATCH}) {
            skippedOverLimit += 1;
            continue;
          }
          const f = fileList[i];
          const ext = extOf(f.name);
          let err = "";
          if (f.size === 0) err = "空文件不可上传";
          else if (f.size > maxFileBytes) err = "超过单文件 32MB 上限，请压缩或拆分";
          else if (!allowedExts.includes(ext)) err = "不支持的格式 (" + (ext || "无后缀") + ")";
          pendingFiles.push({ file: f, error: err, uploaded: false, statusText: "预检通过，待上传" });
        }
        renderFiles();
        if (skippedOverLimit > 0) {
          showBox(uploadMsg, "单批次最多允许上传 ${MAX_FILES_PER_BATCH} 个有效文件，已忽略超出的 " + skippedOverLimit + " 个文件", true);
        }
      }

      dropzone.addEventListener("click", function() { fileInput.click(); });
      fileInput.addEventListener("change", function() {
        if (fileInput.files) addSelectedFiles(fileInput.files);
        fileInput.value = "";
      });
      dropzone.addEventListener("dragover", function(e) { e.preventDefault(); dropzone.classList.add("dragover"); });
      dropzone.addEventListener("dragleave", function() { dropzone.classList.remove("dragover"); });
      dropzone.addEventListener("drop", function(e) {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        if (e.dataTransfer && e.dataTransfer.files) addSelectedFiles(e.dataTransfer.files);
      });

      async function pollStatus() {
        try {
          const u = API_BASE + "/status?batchId=" + encodeURIComponent(batchId);
          const res = await fetch(u, {
            headers: {
              "x-drop-receipt": receiptToken,
              "x-drop-page-ticket": PAGE_TICKET
            }
          });
          const data = await res.json();
          if (res.ok && data.ok && data.status) {
            showBox(uploadMsg, "当前状态 [" + data.status.status + "]：" + data.status.statusMessage, data.status.status === "failed");
            if (data.status.status === "queued" || data.status.status === "processing") {
              setTimeout(pollStatus, 2500);
            } else if (data.status.status === "completed" || data.status.status === "partial") {
              refreshBoardsList();
            }
          }
        } catch (_) {}
      }

      btnSubmit.addEventListener("click", async function() {
        const validItems = pendingFiles.filter(function(x) { return !x.error; });
        if (validItems.length === 0) {
          showBox(uploadMsg, "请至少添加一个通过预检的文件", true);
          return;
        }
        btnSubmit.disabled = true;
        try {
          for (let i = 0; i < validItems.length; i++) {
            const item = validItems[i];
            if (item.uploaded) continue;
            item.statusText = "正在流式上传…";
            renderFiles();
            const u = API_BASE + "/upload?batchId=" + encodeURIComponent(batchId) + "&fileName=" + encodeURIComponent(item.file.name);
            const res = await fetch(u, {
              method: "POST",
              headers: {
                "authorization": "Bearer " + sessionToken,
                "x-drop-page-ticket": PAGE_TICKET,
                "content-type": "application/octet-stream"
              },
              body: item.file
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
              item.error = data.error || "上传失败";
              renderFiles();
              showBox(uploadMsg, "文件上传失败：" + item.error, true);
              btnSubmit.disabled = false;
              return;
            }
            item.uploaded = true;
            item.statusText = "已落盘";
            renderFiles();
          }
          showBox(uploadMsg, "全部文件已落盘，正在提交 AI 归档队列…", false);
          const cRes = await fetch(API_BASE + "/commit", {
            method: "POST",
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET,
              "content-type": "application/json"
            },
            body: JSON.stringify({ batchId: batchId, note: noteEl.value.trim() })
          });
          const cData = await cRes.json();
          if (!cRes.ok || !cData.ok) {
            showBox(uploadMsg, cData.error || "提交批次失败", true);
            btnSubmit.disabled = false;
            return;
          }
          showBox(uploadMsg, "已提交成功！AI 正在后台自动分类归档并更新知识库，完成后看板列表将自动刷新…", false);
          setTimeout(pollStatus, 1000);
        } catch (err) {
          showBox(uploadMsg, "网络异常，请点击重试", true);
          btnSubmit.disabled = false;
        }
      });

      function renderQaTempFiles(files) {
        qaTempFiles = Array.isArray(files) ? files : [];
        qaTempFilesEl.innerHTML = "";
        if (qaTempFiles.length === 0) {
          qaTempFilesEl.classList.add("hidden");
          return;
        }
        qaTempFilesEl.classList.remove("hidden");
        qaTempFiles.forEach(function(f) {
          const chip = document.createElement("div");
          chip.className = "qa-file-chip";
          const tag = document.createElement("span");
          tag.textContent = (f.scope === "outputs" ? "📊 " : "📎 ") + f.name + " (" + (f.size / 1024).toFixed(1) + "KB)";
          chip.appendChild(tag);

          if (f.scope === "outputs") {
            const btnPrev = document.createElement("button");
            btnPrev.type = "button";
            btnPrev.className = "btn-rm";
            btnPrev.textContent = "预览";
            btnPrev.addEventListener("click", function() {
              previewOrDownloadQaFile(f.name, false);
            });
            chip.appendChild(btnPrev);

            const btnDl = document.createElement("button");
            btnDl.type = "button";
            btnDl.className = "btn-rm";
            btnDl.textContent = "下载";
            btnDl.addEventListener("click", function() {
              previewOrDownloadQaFile(f.name, true);
            });
            chip.appendChild(btnDl);
          }
          qaTempFilesEl.appendChild(chip);
        });
      }

      async function previewOrDownloadQaFile(fileName, triggerDownload) {
        try {
          const u = API_BASE + "/qa/file?name=" + encodeURIComponent(fileName);
          const res = await fetch(u, {
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET
            }
          });
          if (!res.ok) {
            showBox(qaMsgBox, "读取临时统计文件失败（可能已过期或被清理）", true);
            return;
          }
          const blob = await res.blob();
          if (triggerDownload) {
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 5000);
            return;
          }
          const text = await blob.text();
          activeQaFileName = fileName;
          qaPreviewTitle.textContent = fileName;
          switchRightPreview("qa");
          if (fileName.toLowerCase().endsWith(".html")) {
            qaPreviewPre.classList.add("hidden");
            qaPreviewFrame.classList.remove("hidden");
            qaPreviewFrame.srcdoc = text;
          } else {
            qaPreviewFrame.classList.add("hidden");
            qaPreviewFrame.srcdoc = "";
            qaPreviewPre.classList.remove("hidden");
            qaPreviewPre.textContent = text;
          }
        } catch (err) {
          showBox(qaMsgBox, "网络异常，无法读取临时文件", true);
        }
      }

      btnCloseQaPreview.addEventListener("click", function() {
        activeQaFileName = "";
        qaPreviewPre.textContent = "";
        qaPreviewFrame.srcdoc = "";
        if (activeBoardPath) {
          switchRightPreview("board");
        } else {
          switchRightPreview("empty");
        }
      });

      function appendQaMessageBubble(role, text, citedPaths, generatedFiles) {
        qaEmptyHint.classList.add("hidden");
        const box = document.createElement("div");
        box.className = "qa-msg " + (role === "user" ? "qa-msg-user" : "qa-msg-ai");
        const roleEl = document.createElement("div");
        roleEl.className = "qa-msg-role";
        roleEl.textContent = role === "user" ? "提问" : "AI 回答";
        const bodyEl = document.createElement("div");
        bodyEl.textContent = text;
        box.appendChild(roleEl);
        box.appendChild(bodyEl);

        if (Array.isArray(citedPaths) && citedPaths.length > 0) {
          const citeEl = document.createElement("div");
          citeEl.style.marginTop = "6px";
          citeEl.style.fontSize = "11px";
          citeEl.style.color = "var(--muted)";
          citeEl.textContent = "来源：" + citedPaths.join(" 、 ");
          box.appendChild(citeEl);
        }

        if (Array.isArray(generatedFiles) && generatedFiles.length > 0) {
          const genWrap = document.createElement("div");
          genWrap.className = "qa-chip-list";
          genWrap.style.marginTop = "6px";
          genWrap.style.marginBottom = "0";
          generatedFiles.forEach(function(gf) {
            const chip = document.createElement("div");
            chip.className = "qa-file-chip";
            const lbl = document.createElement("span");
            lbl.textContent = "📄 " + gf.name;
            chip.appendChild(lbl);

            const pBtn = document.createElement("button");
            pBtn.type = "button";
            pBtn.className = "btn-rm";
            pBtn.textContent = "预览";
            pBtn.addEventListener("click", function() {
              previewOrDownloadQaFile(gf.name, false);
            });
            chip.appendChild(pBtn);

            const dBtn = document.createElement("button");
            dBtn.type = "button";
            dBtn.className = "btn-rm";
            dBtn.textContent = "下载";
            dBtn.addEventListener("click", function() {
              previewOrDownloadQaFile(gf.name, true);
            });
            chip.appendChild(dBtn);
            genWrap.appendChild(chip);
          });
          box.appendChild(genWrap);
        }

        qaMessagesEl.appendChild(box);
        qaChatBox.scrollTop = qaChatBox.scrollHeight;
      }

      btnQaAttach.addEventListener("click", function() { qaFileInput.click(); });
      qaFileInput.addEventListener("change", async function() {
        if (!qaFileInput.files || qaFileInput.files.length === 0) return;
        const f = qaFileInput.files[0];
        qaFileInput.value = "";
        if (f.size === 0 || f.size > ${QA_MAX_FILE_BYTES}) {
          showBox(qaMsgBox, "问答临时比对附件大小需在 1B – 4MB 之间", true);
          return;
        }
        btnQaAttach.disabled = true;
        try {
          const u = API_BASE + "/qa/upload?fileName=" + encodeURIComponent(f.name);
          const res = await fetch(u, {
            method: "POST",
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET,
              "content-type": "application/octet-stream"
            },
            body: f
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            showBox(qaMsgBox, data.error || "上传临时比对附件失败", true);
          } else {
            showBox(qaMsgBox, "已上传临时比对附件：" + data.file.name + "（仅存放在临时目录，不写入知识库）", false);
            if (Array.isArray(data.files)) renderQaTempFiles(data.files);
          }
        } catch (err) {
          showBox(qaMsgBox, "网络异常，上传临时附件失败", true);
        } finally {
          btnQaAttach.disabled = false;
        }
      });

      passcodeEl.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.isComposing && !btnAuth.disabled) {
          e.preventDefault();
          btnAuth.click();
        }
      });

      qaInputEl.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          if (!btnQaSend.disabled) {
            btnQaSend.click();
          }
        }
      });

      btnQaSend.addEventListener("click", async function() {
        const question = qaInputEl.value.trim();
        if (!question) {
          showBox(qaMsgBox, "请输入您要询问或统计的问题", true);
          return;
        }
        btnQaSend.disabled = true;
        qaInputEl.value = "";
        appendQaMessageBubble("user", question, [], []);
        showBox(qaMsgBox, "AI 正在只读检索知识库并分析统计，请稍候…", false);
        try {
          const res = await fetch(API_BASE + "/qa/ask", {
            method: "POST",
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              question: question,
              activeBoardPath: activeBoardPath || undefined
            })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            showBox(qaMsgBox, data.error || "提问失败", true);
          } else {
            qaMsgBox.classList.add("hidden");
            appendQaMessageBubble("ai", data.answer, data.citedPaths || [], data.generatedFiles || []);
            if (Array.isArray(data.tempFiles)) {
              renderQaTempFiles(data.tempFiles);
            }
            if (Array.isArray(data.generatedFiles) && data.generatedFiles.length > 0) {
              previewOrDownloadQaFile(data.generatedFiles[0].name, false);
            }
          }
        } catch (err) {
          showBox(qaMsgBox, "网络请求异常，请重试", true);
        } finally {
          btnQaSend.disabled = false;
        }
      });

      btnQaClear.addEventListener("click", async function() {
        btnQaClear.disabled = true;
        try {
          const res = await fetch(API_BASE + "/qa/clear", {
            method: "POST",
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET,
              "content-type": "application/json"
            },
            body: JSON.stringify({})
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            qaMessagesEl.innerHTML = "";
            qaEmptyHint.classList.remove("hidden");
            activeQaFileName = "";
            qaPreviewPre.textContent = "";
            qaPreviewFrame.srcdoc = "";
            if (activeBoardPath) {
              switchRightPreview("board");
            } else {
              switchRightPreview("empty");
            }
            renderQaTempFiles([]);
            showBox(qaMsgBox, "已清空当前问答对话并物理销毁临时目录中的所有文件", false);
          }
        } catch (_) {
        } finally {
          btnQaClear.disabled = false;
        }
      });

      renderQaTempFiles([]);
    })();
  </script>
</body>
</html>`;
}

/**
 * 拦截并处理 `/p/<tenant>/drop` 与 `/p/<tenant>/drop/api/*` 请求。
 * 若请求路径不属于 `/drop` 路由，返回 `false` 交由 `publish.ts` 后续逻辑处理。
 */
export function handleDropPortalHttp(
  tenant: DropPortalTenant,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  const basePrefix = `/p/${tenant.id}/drop`;
  if (pathname !== basePrefix && pathname !== `${basePrefix}/` && !pathname.startsWith(`${basePrefix}/api/`)) {
    return false;
  }

  const clientIp = extractClientIp(req);

  // 1. 静态投递门户 HTML 页面（顶层 CSP: sandbox allow-scripts 唯一不透明源隔离 + 内嵌短期 pageTicket）
  if (pathname === basePrefix || pathname === `${basePrefix}/`) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "只支持 GET/HEAD" });
      return true;
    }
    const ticket = req.method === "HEAD" ? "" : issuePageTicket(tenant.id, clientIp);
    sendHtml(res, 200, renderDropPortalHtml(tenant.id, tenant.name, ticket), req.method === "HEAD");
    return true;
  }

  // 处理沙箱不透明源发出的 CORS OPTIONS 预检请求
  if (req.method === "OPTIONS") {
    applySandboxedApiCors(res);
    res.writeHead(204, {
      "content-length": "0",
      "cache-control": "no-store",
      "cross-origin-resource-policy": "cross-origin",
    });
    res.end();
    return true;
  }

  // 若请求来自浏览器沙箱（Origin: null），强制要求携带有效的 X-Drop-Page-Ticket
  const reqOrigin = String(req.headers.origin || "").trim();
  const pageTicketHeader = String(req.headers["x-drop-page-ticket"] || "").trim();
  if (reqOrigin === "null" || pageTicketHeader) {
    if (!verifyPageTicket(tenant.id, clientIp, pageTicketHeader)) {
      req.resume();
      sendJson(res, 403, { ok: false, error: "页面安全票据无效或已过期，请刷新投递页面重试" });
      return true;
    }
  }

  const host = buildDropTenantHost(tenant);
  const url = new URL(req.url || "/", "http://127.0.0.1");

  // 2. POST /p/<tenant>/drop/api/auth — 口令校验 + 创建批次并绑定 session + 返回该知识库的 HTML 看板列表
  if (pathname === `${basePrefix}/api/auth`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    void (async () => {
      const parsed = await readJsonBody(req, 16 * 1024);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      const passcode = typeof parsed.data.passcode === "string" ? parsed.data.passcode : "";
      const submitterName = typeof parsed.data.submitterName === "string" ? parsed.data.submitterName : "";

      const authRes = verifyDropPasscodeAndCreateSession(host, {
        passcode,
        submitterName,
        clientIp,
      });
      if (!authRes.ok) {
        const extra: Record<string, string> = {};
        if (authRes.status === 429 && authRes.retryAfterSec) {
          extra["retry-after"] = String(authRes.retryAfterSec);
        }
        sendJson(res, authRes.status, { ok: false, error: authRes.error }, extra);
        return;
      }

      const creds = allocateDropBatchCredentials();
      if (!bindBatchIdToDropSession(authRes.session.sessionToken, creds.batchId, creds.receiptHash)) {
        sendJson(res, 400, { ok: false, error: "分配投递批次凭证失败" });
        return;
      }

      const boards = scanWorkspaceKbHtmlBoards(authRes.session.workspacePath, authRes.session.kbConfig);

      sendJson(res, 200, {
        ok: true,
        dropSessionToken: authRes.session.sessionToken,
        qaSessionId: authRes.session.qaSessionId,
        batchId: creds.batchId,
        receiptToken: creds.receiptToken,
        workspaceTitle: authRes.session.workspaceTitle,
        maxFileBytes: authRes.session.kbConfig.maxFileBytes,
        allowedExts: authRes.session.kbConfig.allowedExts,
        qaAllowedUploadExts: [...QA_UPLOAD_ALLOWED_EXTS],
        boards,
      });
    })().catch(() => {
      sendJson(res, 500, { ok: false, error: "处理投递鉴权时出错" });
    });
    return true;
  }

  // 2b. GET /p/<tenant>/drop/api/boards — 刷新当前授权知识库工作区的同名 HTML 看板列表
  if (pathname === `${basePrefix}/api/boards`) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "只支持 GET" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token);
    if (!sessCheck.ok) {
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }
    const boards = scanWorkspaceKbHtmlBoards(sessCheck.session.workspacePath, sessCheck.session.kbConfig);
    sendJson(res, 200, { ok: true, boards });
    return true;
  }

  // 2c. GET /p/<tenant>/drop/api/board?path=... — 受控读取当前授权工作区下的同名 .html 知识库看板（严禁读取任何原始底表或非同名 HTML）
  if (pathname === `${basePrefix}/api/board`) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "只支持 GET" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token);
    if (!sessCheck.ok) {
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }
    const rawRelPath = (url.searchParams.get("path") || "").trim();
    const validHtml = validateKbHtmlRelPath(sessCheck.session.workspacePath, sessCheck.session.kbConfig, rawRelPath);
    if (!validHtml.ok) {
      sendJson(res, 403, { ok: false, error: "仅允许预览知识库目录同名的汇总 HTML 看板" });
      return true;
    }
    const readRes = safeReadWorkspaceTextFileSync(
      sessCheck.session.workspacePath,
      validHtml.normalizedRel,
      MAX_KB_HTML_BYTES + 64 * 1024,
    );
    if (!readRes.ok) {
      sendJson(res, 404, { ok: false, error: "找不到该知识库 HTML 看板" });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      path: validHtml.normalizedRel,
      htmlContent: readRes.text,
    });
    return true;
  }

  // 3. POST /p/<tenant>/drop/api/upload — 先校验 Bearer Session 与文件名后缀，再逐 chunk 流式写入临时文件并在结束时二次复核会话
  if (pathname === `${basePrefix}/api/upload`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token);
    if (!sessCheck.ok) {
      req.resume();
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }

    const batchId = (url.searchParams.get("batchId") || "").trim();
    const rawFileName = url.searchParams.get("fileName") || "";
    let fileName = rawFileName;
    try {
      fileName = decodeURIComponent(rawFileName);
    } catch {
      fileName = rawFileName;
    }

    const maxBytes = sessCheck.session.kbConfig.maxFileBytes;
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      sendJson(res, 413, { ok: false, error: `文件体积超过单文件上限（${maxBytes} bytes）` });
      return true;
    }

    void (async () => {
      const staged = await streamStageFileIntoBatch(host, sessCheck.session, {
        batchId,
        fileName,
        req,
        reverifySession: () => verifyDropSessionToken(host, token),
      });
      if (!staged.ok) {
        sendJson(res, staged.status, { ok: false, error: staged.error });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        storedName: staged.file.storedName,
        size: staged.file.size,
        sha256: staged.file.sha256,
        fileCount: staged.meta.files.length,
      });
    })().catch(() => {
      sendJson(res, 500, { ok: false, error: "保存上传文件时出错" });
    });
    return true;
  }

  // 4. POST /p/<tenant>/drop/api/commit — 读完 JSON 体后二次复核会话未被吊销，再锁定批次入队
  if (pathname === `${basePrefix}/api/commit`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token);
    if (!sessCheck.ok) {
      req.resume();
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }

    void (async () => {
      const parsed = await readJsonBody(req, 16 * 1024);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      const rechecked = verifyDropSessionToken(host, token);
      if (!rechecked.ok) {
        sendJson(res, rechecked.status, { ok: false, error: rechecked.error });
        return;
      }

      const batchId = typeof parsed.data.batchId === "string" ? parsed.data.batchId : "";
      const note = parsed.data.note;

      const committed = commitDropBatchAndEnqueue(host, rechecked.session, {
        batchId,
        note,
      });
      if (!committed.ok) {
        sendJson(res, committed.status, { ok: false, error: committed.error });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        idempotent: committed.idempotent,
        batchId: committed.meta.batchId,
        status: committed.meta.status,
        statusMessage: committed.meta.statusMessage,
        fileCount: committed.meta.files.length,
      });
    })().catch(() => {
      sendJson(res, 500, { ok: false, error: "提交归档批次时出错" });
    });
    return true;
  }

  // 5. GET /p/<tenant>/drop/api/status — 仅接受 X-Drop-Receipt 请求头
  if (pathname === `${basePrefix}/api/status`) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "只支持 GET" });
      return true;
    }
    const batchId = url.searchParams.get("batchId") || "";
    const receiptToken = String(req.headers["x-drop-receipt"] || "").trim();
    const statusRes = getDropBatchPublicStatus(host, { batchId, receiptToken });
    if (!statusRes.ok) {
      sendJson(res, statusRes.status, { ok: false, error: statusRes.error });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      status: statusRes.status,
    });
    return true;
  }

  // 6. POST /p/<tenant>/drop/api/qa/ask — 只读知识库问答与临时统计生成（严禁写知识库工作区本身）
  if (pathname === `${basePrefix}/api/qa/ask`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token, Date.now(), clientIp);
    if (!sessCheck.ok) {
      req.resume();
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }

    void (async () => {
      const parsed = await readJsonBody(req, 32 * 1024);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { ok: false, error: parsed.error });
        return;
      }
      const rechecked = verifyDropSessionToken(host, token, Date.now(), clientIp);
      if (!rechecked.ok) {
        sendJson(res, rechecked.status, { ok: false, error: rechecked.error });
        return;
      }

      const question = typeof parsed.data.question === "string" ? parsed.data.question : "";
      const activeBoardPath = typeof parsed.data.activeBoardPath === "string" ? parsed.data.activeBoardPath : undefined;

      const askRes = await runKbQaAsk({
        host,
        initialSession: rechecked.session,
        question,
        activeBoardPath,
        reverifySession: () => verifyDropSessionToken(host, token, Date.now(), clientIp),
      });

      if (!askRes.ok) {
        sendJson(res, askRes.status, { ok: false, error: askRes.error });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        qaSessionId: rechecked.session.qaSessionId,
        answer: askRes.answer,
        citedPaths: askRes.citedPaths,
        generatedFiles: askRes.generatedFiles,
        tempFiles: askRes.allTempFiles,
        turns: askRes.turns,
      });
    })().catch(() => {
      sendJson(res, 500, { ok: false, error: "处理知识库问答请求时出错" });
    });
    return true;
  }

  // 7. POST /p/<tenant>/drop/api/qa/upload — 流式上传仅用于当前问答会话比对的临时附件（写入工作区外的独立临时目录 uploads/）
  if (pathname === `${basePrefix}/api/qa/upload`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token, Date.now(), clientIp);
    if (!sessCheck.ok) {
      req.resume();
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }

    const rawFileName = url.searchParams.get("fileName") || "";
    let fileName = rawFileName;
    try {
      fileName = decodeURIComponent(rawFileName);
    } catch {
      fileName = rawFileName;
    }

    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > QA_MAX_FILE_BYTES) {
      req.resume();
      sendJson(res, 413, { ok: false, error: `问答临时附件超过 4MB 上限` });
      return true;
    }

    void (async () => {
      const uploaded = await streamUploadQaTempFile(host, sessCheck.session, {
        fileName,
        req,
        reverifySession: () => verifyDropSessionToken(host, token, Date.now(), clientIp),
      });
      if (!uploaded.ok) {
        sendJson(res, uploaded.status, { ok: false, error: uploaded.error });
        return;
      }
      const ensured = ensureQaSessionStorageSync(host, sessCheck.session);
      const files = ensured.ok ? measureQaSessionDiskUsageSync(ensured.sessionDir).files : [uploaded.file];
      sendJson(res, 200, {
        ok: true,
        file: uploaded.file,
        totalBytes: uploaded.totalBytes,
        fileCount: uploaded.fileCount,
        files,
      });
    })().catch(() => {
      sendJson(res, 500, { ok: false, error: "保存问答临时附件时出错" });
    });
    return true;
  }

  // 8. GET /p/<tenant>/drop/api/qa/files — 查询当前问答会话的临时文件列表与多轮历史
  if (pathname === `${basePrefix}/api/qa/files`) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "只支持 GET" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token, Date.now(), clientIp);
    if (!sessCheck.ok) {
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }
    const ensured = ensureQaSessionStorageSync(host, sessCheck.session);
    if (!ensured.ok) {
      sendJson(res, ensured.status, { ok: false, error: ensured.error });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      qaSessionId: sessCheck.session.qaSessionId,
      files: ensured.usage.files,
      totalBytes: ensured.usage.totalBytes,
      fileCount: ensured.usage.fileCount,
      turns: ensured.meta.turns,
    });
    return true;
  }

  // 9. GET /p/<tenant>/drop/api/qa/file?name=... — 受控下载当前问答会话临时目录 outputs/ 下的统计文件
  if (pathname === `${basePrefix}/api/qa/file`) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "只支持 GET" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token, Date.now(), clientIp);
    if (!sessCheck.ok) {
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }
    const rawName = (url.searchParams.get("name") || "").trim();
    const scopeParam = url.searchParams.get("scope") === "uploads" ? "uploads" : "outputs";
    const nameCheck = validateQaTempFileName(rawName, scopeParam);
    if (!nameCheck.ok) {
      sendJson(res, 400, { ok: false, error: nameCheck.error });
      return true;
    }

    const ensured = ensureQaSessionStorageSync(host, sessCheck.session);
    if (!ensured.ok) {
      sendJson(res, ensured.status, { ok: false, error: ensured.error });
      return true;
    }

    const readRes = safeReadQaFileSync(ensured.sessionDir, `${scopeParam}/${nameCheck.cleanName}`, QA_MAX_FILE_BYTES);
    if (!readRes.ok) {
      sendJson(res, 404, { ok: false, error: readRes.error });
      return true;
    }

    sendBinaryAttachment(res, nameCheck.cleanName, readRes.buffer);
    return true;
  }

  // 10. POST /p/<tenant>/drop/api/qa/clear — 主动清空当前问答记录并物理销毁该会话的临时目录
  if (pathname === `${basePrefix}/api/qa/clear`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    const token = extractBearerToken(req);
    const sessCheck = verifyDropSessionToken(host, token, Date.now(), clientIp);
    if (!sessCheck.ok) {
      req.resume();
      sendJson(res, sessCheck.status, { ok: false, error: sessCheck.error });
      return true;
    }
    req.resume();
    clearQaSessionStorageSync(host, sessCheck.session.qaSessionId, sessCheck.session.workspaceId, {
      reopenAfterClear: true,
    });
    sendJson(res, 200, {
      ok: true,
      cleared: true,
    });
    return true;
  }

  // 11. POST /p/<tenant>/drop/api/webhook — 单步直传 Webhook API（免网页 PageTicket 握手，支持二进制流直传与 JSON 多文件/邮件拆解入队）
  if (pathname === `${basePrefix}/api/webhook`) {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "只支持 POST" });
      return true;
    }
    // 禁止任何来自浏览器跨域页面（携带 Origin 头）的直调，防范跨站伪造调用
    if (req.headers.origin !== undefined) {
      req.resume();
      sendJson(res, 403, { ok: false, error: "Webhook 接口仅供脚本、服务端或原生工具调用" });
      return true;
    }

    const passcode = extractBearerToken(req) || String(req.headers["x-drop-passcode"] || "").trim();
    const querySubmitter = (url.searchParams.get("submitterName") || url.searchParams.get("submitter") || "").trim();
    let headerSubmitter = String(req.headers["x-drop-submitter"] || "").trim();
    try {
      if (headerSubmitter) headerSubmitter = decodeURIComponent(headerSubmitter);
    } catch {
      // keep raw
    }
    const submitterName = querySubmitter || headerSubmitter;

    const authRes = verifyDropPasscodeStateless(host, {
      passcode,
      submitterName: submitterName || undefined,
      clientIp,
    });
    if (!authRes.ok) {
      req.resume();
      const extra: Record<string, string> = {};
      if (authRes.status === 429 && authRes.retryAfterSec) {
        extra["retry-after"] = String(authRes.retryAfterSec);
      }
      sendJson(res, authRes.status, { ok: false, error: authRes.error }, extra);
      return true;
    }

    const contentType = String(req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const rawQueryFileName = (url.searchParams.get("fileName") || "").trim();
    let rawHeaderFileName = String(req.headers["x-drop-filename"] || "").trim();
    try {
      if (rawHeaderFileName) rawHeaderFileName = decodeURIComponent(rawHeaderFileName);
    } catch {
      // keep raw
    }

    // 模式 B：Content-Type 为 application/json 且未显式指定单文件名时，按结构化 JSON 载荷（支持多文件/邮件转发拆解）处理
    if (contentType === "application/json" && !rawQueryFileName && !rawHeaderFileName) {
      const maxJsonBytes = Math.min(
        64 * 1024 * 1024,
        Math.ceil(authRes.session.kbConfig.maxFileBytes * 1.5) + 64 * 1024,
      );
      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxJsonBytes) {
        req.resume();
        sendJson(res, 413, { ok: false, error: `JSON 载荷体积超过上限（${maxJsonBytes} bytes）` });
        return true;
      }

      void (async () => {
        const parsed = await readJsonBody(req, maxJsonBytes);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { ok: false, error: parsed.error });
          return;
        }
        const rechecked = reverifyStatelessDropSession(host, authRes.session);
        if (!rechecked.ok) {
          sendJson(res, rechecked.status, { ok: false, error: rechecked.error });
          return;
        }

        const bodySubmitter =
          typeof parsed.data.submitterName === "string" && parsed.data.submitterName.trim()
            ? parsed.data.submitterName.trim()
            : rechecked.session.submitterName;
        let fallbackHeaderNote = String(req.headers["x-drop-note"] || "").trim();
        try {
          if (fallbackHeaderNote) fallbackHeaderNote = decodeURIComponent(fallbackHeaderNote);
        } catch {
          // keep raw
        }
        const bodyNote =
          parsed.data.note !== undefined
            ? parsed.data.note
            : url.searchParams.get("note") || fallbackHeaderNote || undefined;

        const fileItems: Array<{ fileName: string; data: Buffer }> = [];
        if (Array.isArray(parsed.data.files) && parsed.data.files.length > 0) {
          if (parsed.data.files.length > MAX_FILES_PER_BATCH) {
            sendJson(res, 400, { ok: false, error: `单批次最多允许提交 ${MAX_FILES_PER_BATCH} 个文件` });
            return;
          }
          for (const rawItem of parsed.data.files) {
            if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
              sendJson(res, 400, { ok: false, error: "files 数组元素必须是对象" });
              return;
            }
            const itemObj = rawItem as Record<string, unknown>;
            const fName = typeof itemObj.fileName === "string" ? itemObj.fileName.trim() : "";
            if (itemObj.encoding !== undefined && itemObj.encoding !== "utf8" && itemObj.encoding !== "base64") {
              sendJson(res, 400, {
                ok: false,
                error: `文件 "${fName || "未知"}" 的 encoding 只能是 "utf8" 或 "base64"`,
              });
              return;
            }
            const encoding = itemObj.encoding === "base64" ? "base64" : "utf8";
            if (typeof itemObj.content !== "string") {
              sendJson(res, 400, { ok: false, error: `文件 "${fName || "未知"}" 缺少字符串类型的 content 字段` });
              return;
            }
            const buf =
              encoding === "base64" ? Buffer.from(itemObj.content, "base64") : Buffer.from(itemObj.content, "utf8");
            fileItems.push({ fileName: fName, data: buf });
          }
        } else if (typeof parsed.data.fileName === "string" && typeof parsed.data.content === "string") {
          if (
            parsed.data.encoding !== undefined &&
            parsed.data.encoding !== "utf8" &&
            parsed.data.encoding !== "base64"
          ) {
            sendJson(res, 400, { ok: false, error: `encoding 只能是 "utf8" 或 "base64"` });
            return;
          }
          const encoding = parsed.data.encoding === "base64" ? "base64" : "utf8";
          const buf =
            encoding === "base64"
              ? Buffer.from(parsed.data.content, "base64")
              : Buffer.from(parsed.data.content, "utf8");
          fileItems.push({ fileName: parsed.data.fileName.trim(), data: buf });
        } else {
          sendJson(res, 400, {
            ok: false,
            error: "JSON 载荷需提供 { fileName, content, encoding? } 或 { files: [{ fileName, content, encoding? }] }",
          });
          return;
        }

        const submitted = submitDirectIngestBatch(host, {
          workspaceKeyOrId: rechecked.session.workspaceId,
          tokenId: rechecked.session.tokenId,
          submitterName: bodySubmitter,
          note: bodyNote,
          files: fileItems,
        });
        if (!submitted.ok) {
          sendJson(res, submitted.status, { ok: false, error: submitted.error });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          batchId: submitted.batchId,
          receiptToken: submitted.receiptToken,
          workspaceKey: submitted.workspaceKey,
          workspaceTitle: submitted.workspaceTitle,
          status: submitted.meta.status,
          statusMessage: submitted.meta.statusMessage,
          fileCount: submitted.meta.files.length,
          files: submitted.meta.files.map((f) => ({
            storedName: f.storedName,
            size: f.size,
            sha256: f.sha256,
          })),
        });
      })().catch(() => {
        sendJson(res, 500, { ok: false, error: "处理 JSON Webhook 投递时出错" });
      });
      return true;
    }

    // 模式 A：单文件二进制流式直传（POST /p/<tenant>/drop/api/webhook?fileName=xxx.xlsx&note=...）
    const fileName = rawQueryFileName || rawHeaderFileName;

    const nameCheck = isAllowedUploadFileName(fileName, authRes.session.kbConfig);
    if (!nameCheck.ok) {
      req.resume();
      sendJson(res, 400, { ok: false, error: nameCheck.error });
      return true;
    }

    const queryNote = url.searchParams.get("note");
    let headerNote = String(req.headers["x-drop-note"] || "").trim();
    try {
      if (headerNote) headerNote = decodeURIComponent(headerNote);
    } catch {
      // keep raw
    }
    const rawNote = queryNote !== null ? queryNote : headerNote;
    const noteCheck = sanitizeBatchNote(rawNote || undefined);
    if (!noteCheck.ok) {
      req.resume();
      sendJson(res, 400, { ok: false, error: noteCheck.error });
      return true;
    }

    const maxBytes = authRes.session.kbConfig.maxFileBytes;
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      sendJson(res, 413, { ok: false, error: `文件体积超过单文件上限（${maxBytes} bytes）` });
      return true;
    }

    if (!hasIngestQueueCapacity(host)) {
      req.resume();
      sendJson(res, 429, { ok: false, error: "当前排队归档的批次过多，请稍后再试" });
      return true;
    }

    const creds = allocateDropBatchCredentials();
    const webhookSession = {
      ...authRes.session,
      batchId: creds.batchId,
      receiptHash: creds.receiptHash,
    };

    void (async () => {
      const staged = await streamStageFileIntoBatch(host, webhookSession, {
        batchId: creds.batchId,
        fileName: nameCheck.normalizedName,
        req,
        reverifySession: () => {
          const rev = reverifyStatelessDropSession(host, webhookSession);
          if (!rev.ok) return rev;
          return {
            ok: true,
            session: {
              ...rev.session,
              batchId: creds.batchId,
              receiptHash: creds.receiptHash,
            },
          };
        },
      });
      if (!staged.ok) {
        cleanupAbortedStagingBatchSync(host, webhookSession.workspacePath, creds.batchId);
        sendJson(res, staged.status, { ok: false, error: staged.error });
        return;
      }

      const committed = commitDropBatchAndEnqueue(host, webhookSession, {
        batchId: creds.batchId,
        note: noteCheck.note,
      });
      if (!committed.ok) {
        cleanupAbortedStagingBatchSync(host, webhookSession.workspacePath, creds.batchId);
        sendJson(res, committed.status, { ok: false, error: committed.error });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        batchId: creds.batchId,
        receiptToken: creds.receiptToken,
        workspaceKey: webhookSession.workspaceKey,
        workspaceTitle: webhookSession.workspaceTitle,
        status: committed.meta.status,
        statusMessage: committed.meta.statusMessage,
        fileCount: committed.meta.files.length,
        storedName: staged.file.storedName,
        size: staged.file.size,
        sha256: staged.file.sha256,
      });
    })().catch(() => {
      cleanupAbortedStagingBatchSync(host, webhookSession.workspacePath, creds.batchId);
      sendJson(res, 500, { ok: false, error: "处理流式 Webhook 投递时出错" });
    });
    return true;
  }

  sendJson(res, 404, { ok: false, error: "未知的投递接口路径" });
  return true;
}
