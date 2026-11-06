import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getTenant } from "../tenants.ts";
import { readWorkspaceAgentFile, workspaceAgentById, workspaceAgentDirectories } from "../workspace/agents.ts";
import {
  DEFAULT_ALLOWED_EXTS,
  DEFAULT_MAX_FILE_BYTES,
  safeReadWorkspaceTextFileSync,
  validateKbHtmlRelPath,
} from "./contract.ts";
import { scanWorkspaceKbHtmlBoards } from "./hub.ts";
import { commitDropBatchAndEnqueue } from "./queue.ts";
import { createDropBatch, getDropBatchPublicStatus, MAX_FILES_PER_BATCH, streamStageFileIntoBatch } from "./staging.ts";
import {
  bindBatchIdToDropSession,
  normalizeClientIp,
  verifyDropPasscodeAndCreateSession,
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
  const entry = activePageTickets.get(clean);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    activePageTickets.delete(clean);
    return false;
  }
  if (entry.tenantId !== tenantId || entry.clientIp !== clientIp) return false;
  const a = Buffer.from(clean);
  const b = Buffer.from(clean);
  return timingSafeEqual(a, b);
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
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src *; img-src data:; frame-src data: about:; child-src data: about:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox allow-scripts",
  });
  res.end(headOnly ? undefined : raw);
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
 * 生成顶层沙箱隔离（`CSP: sandbox allow-scripts`）的单文件内联知识库协作与投递门户 HTML 页面。
 * 支持验证口令后在「知识库看板（HTML）」与「上传新文档」两个标签页之间无缝切换，点击任意看板即可全宽内联预览。
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
      padding: 24px 16px 48px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container { max-width: 1040px; margin: 0 auto; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px;
      margin-bottom: 16px;
    }
    h1 { margin: 0 0 6px; font-size: 20px; font-weight: 600; }
    h2 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
    .sub { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: rgba(59, 130, 246, 0.15);
      color: var(--accent);
      margin-bottom: 10px;
    }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    input[type="text"], input[type="password"], textarea {
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      margin-bottom: 14px;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: 0;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-ghost {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 6px 12px;
      font-size: 13px;
    }
    .btn-rm {
      background: transparent;
      color: var(--muted);
      padding: 2px 8px;
      font-size: 12px;
      border: 1px solid var(--border);
      margin-left: 8px;
    }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
    }
    .tab-group { display: flex; gap: 8px; }
    .tab-btn {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 14px;
    }
    .tab-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .board-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .board-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s, transform 0.1s;
    }
    .board-card:hover, .board-card.active {
      border-color: var(--accent);
    }
    .board-tag {
      display: inline-block;
      font-size: 11px;
      padding: 1px 7px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.15);
      color: var(--accent);
      margin-bottom: 6px;
    }
    .board-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; color: var(--text); }
    .board-meta { font-size: 12px; color: var(--muted); word-break: break-all; }
    .board-viewer {
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      background: #ffffff;
      margin-top: 12px;
    }
    .board-viewer-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .board-iframe {
      width: 100%;
      height: 76vh;
      min-height: 540px;
      border: 0;
      display: block;
      background: #ffffff;
    }
    .dropzone {
      border: 2px dashed var(--border);
      border-radius: 10px;
      padding: 28px 16px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s;
      margin-bottom: 14px;
    }
    .dropzone.dragover { border-color: var(--accent); }
    .rules {
      font-size: 12px;
      color: var(--muted);
      background: rgba(139, 155, 176, 0.08);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 14px;
    }
    .file-list { list-style: none; padding: 0; margin: 0 0 14px; }
    .file-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      font-size: 13px;
    }
    .file-err { border-color: var(--danger); color: var(--danger); }
    .file-ok { border-color: var(--success); }
    .status-box {
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      font-size: 13px;
      margin-top: 12px;
    }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <span class="badge">知识库协作门户 · 自动分类归档与看板查阅</span>
      <h1>工作区资料投递箱 & 知识库看板</h1>
      <p class="sub">输入管理员分配的投递口令，即可在线查阅目标知识库工作区的各层 HTML 汇总看板，或上传新业务文档由 AI 自动分类归档并同步更新 HTML。</p>
      <div class="rules">
        <strong>上传规格说明：</strong><br/>
        • 单个文件最大 <strong>32 MB</strong>，单批次最多 <strong>${MAX_FILES_PER_BATCH} 个文件</strong>（多文件将自动逐个流式上传）；<br/>
        • 支持格式：<code>${escapeHtml(allowedListText)}</code>；<br/>
        • 严禁上传 <code>.exe / .sh / .bat / .js / .html</code> 等可执行脚本；超过 32MB 的巨型底表请先分卷或压缩为 <code>.zip</code>。
      </div>
    </div>

    <div id="step-auth" class="card">
      <h2>第一步：验证工作区口令</h2>
      <label for="submitter">您的称呼 / 部门（必填，便于归档留痕）</label>
      <input id="submitter" type="text" maxlength="40" autocomplete="off" placeholder="例如：张工-财务部" />
      <label for="passcode">工作区投递口令</label>
      <input id="passcode" type="password" maxlength="64" autocomplete="off" placeholder="请输入 6–64 位投递口令" />
      <button id="btn-auth" type="button">进入知识库看板与投递中心</button>
      <div id="auth-msg" class="status-box hidden"></div>
    </div>

    <div id="step-main" class="card hidden">
      <div class="tabs">
        <div>
          <h2 id="ws-title" style="margin:0 0 4px;">知识库工作区</h2>
          <div id="batch-info" style="font-size:12px;color:var(--muted);"></div>
        </div>
        <div class="tab-group">
          <button id="tab-boards" type="button" class="tab-btn active">📊 知识库看板 (<span id="board-count">0</span>)</button>
          <button id="tab-upload" type="button" class="tab-btn">📤 上传新文档</button>
        </div>
      </div>

      <!-- 面板 A：知识库 HTML 看板中心 -->
      <div id="pane-boards">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-size:13px;color:var(--muted);">点击下方任意知识库卡片即可直接在线查阅全内联 HTML 看板：</span>
          <button id="btn-refresh-boards" type="button" class="btn-ghost">刷新看板列表</button>
        </div>
        <div id="boards-empty" class="status-box hidden">当前知识库暂无已生成的同名 HTML 看板。您可以切换到「上传新文档」投递资料。</div>
        <div id="boards-grid" class="board-grid"></div>

        <div id="board-viewer" class="board-viewer hidden">
          <div class="board-viewer-bar">
            <strong id="viewer-title">看板预览</strong>
            <button id="btn-close-viewer" type="button" class="btn-ghost">收起预览</button>
          </div>
          <iframe id="viewer-frame" class="board-iframe" sandbox="allow-scripts"></iframe>
        </div>
      </div>

      <!-- 面板 B：上传新文档 -->
      <div id="pane-upload" class="hidden">
        <div id="dropzone" class="dropzone">
          <div>点击选择文件，或将多个文件直接拖拽至此处</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">单文件 ≤ 32MB · 单批 ≤ ${MAX_FILES_PER_BATCH} 个文件 · 选入后立即本地预检体积与格式</div>
          <input id="file-input" type="file" multiple class="hidden" />
        </div>
        <ul id="file-list" class="file-list"></ul>
        <label for="batch-note">批次补充说明（可选，帮助 AI 更精准分类与提炼摘要）</label>
        <textarea id="batch-note" rows="2" maxlength="500" placeholder="例如：11月最新三农信代偿台账与洋钱罐风险预估"></textarea>
        <button id="btn-submit" type="button">上传并提交 AI 自动归档</button>
        <div id="upload-msg" class="status-box hidden"></div>
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
      const tabUpload = document.getElementById("tab-upload");
      const paneBoards = document.getElementById("pane-boards");
      const paneUpload = document.getElementById("pane-upload");
      const boardCountEl = document.getElementById("board-count");
      const boardsGrid = document.getElementById("boards-grid");
      const boardsEmpty = document.getElementById("boards-empty");
      const btnRefreshBoards = document.getElementById("btn-refresh-boards");
      const boardViewer = document.getElementById("board-viewer");
      const viewerTitle = document.getElementById("viewer-title");
      const viewerFrame = document.getElementById("viewer-frame");
      const btnCloseViewer = document.getElementById("btn-close-viewer");
      const dropzone = document.getElementById("dropzone");
      const fileInput = document.getElementById("file-input");
      const fileListEl = document.getElementById("file-list");
      const noteEl = document.getElementById("batch-note");
      const btnSubmit = document.getElementById("btn-submit");
      const uploadMsg = document.getElementById("upload-msg");

      let sessionToken = "";
      let batchId = "";
      let receiptToken = "";
      let maxFileBytes = ${DEFAULT_MAX_FILE_BYTES};
      let allowedExts = ${JSON.stringify([...DEFAULT_ALLOWED_EXTS])};
      let pendingFiles = [];
      let boardsList = [];
      let activeBoardPath = "";

      function showBox(el, text, isErr) {
        el.textContent = text;
        el.classList.remove("hidden");
        el.style.borderColor = isErr ? "var(--danger)" : "var(--border)";
      }

      function switchTab(tab) {
        if (tab === "boards") {
          tabBoards.classList.add("active");
          tabUpload.classList.remove("active");
          paneBoards.classList.remove("hidden");
          paneUpload.classList.add("hidden");
        } else {
          tabUpload.classList.add("active");
          tabBoards.classList.remove("active");
          paneUpload.classList.remove("hidden");
          paneBoards.classList.add("hidden");
        }
      }

      tabBoards.addEventListener("click", function() { switchTab("boards"); });
      tabUpload.addEventListener("click", function() { switchTab("upload"); });

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
          const tag = document.createElement("span");
          tag.className = "board-tag";
          tag.textContent = b.level === "category" ? ("顶层总览 · " + b.category) : ("专题看板 · " + b.category);
          const title = document.createElement("div");
          title.className = "board-title";
          title.textContent = b.title;
          const meta = document.createElement("div");
          meta.className = "board-meta";
          const dt = b.updatedAt ? new Date(b.updatedAt).toLocaleString("zh-CN") : "";
          meta.textContent = b.relPath + (dt ? " · 更新于 " + dt : "");
          card.appendChild(tag);
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
        renderBoards(boardsList);
        viewerTitle.textContent = "正在加载：" + title + " (" + relPath + ")…";
        boardViewer.classList.remove("hidden");
        try {
          const u = API_BASE + "/board?path=" + encodeURIComponent(relPath);
          const res = await fetch(u, {
            headers: {
              "authorization": "Bearer " + sessionToken,
              "x-drop-page-ticket": PAGE_TICKET
            }
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            viewerTitle.textContent = "加载失败：" + (data.error || "无法读取该看板");
            return;
          }
          viewerTitle.textContent = title + " — " + relPath;
          viewerFrame.srcdoc = data.htmlContent || "";
        } catch (e) {
          viewerTitle.textContent = "网络请求失败，无法加载看板";
        }
      }

      btnCloseViewer.addEventListener("click", function() {
        activeBoardPath = "";
        boardViewer.classList.add("hidden");
        viewerFrame.srcdoc = "";
        renderBoards(boardsList);
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
          if (Array.isArray(data.boards) && data.boards.length > 0) {
            switchTab("boards");
            openBoardPreview(data.boards[0].relPath, data.boards[0].title);
          } else {
            switchTab("upload");
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

      const batchRes = createDropBatch(host, authRes.session);
      if (!batchRes.ok || !bindBatchIdToDropSession(authRes.session.sessionToken, batchRes.batchId)) {
        sendJson(res, 400, { ok: false, error: "创建投递批次失败" });
        return;
      }

      const boards = scanWorkspaceKbHtmlBoards(authRes.session.workspacePath, authRes.session.kbConfig);

      sendJson(res, 200, {
        ok: true,
        dropSessionToken: authRes.session.sessionToken,
        batchId: batchRes.batchId,
        receiptToken: batchRes.receiptToken,
        workspaceTitle: authRes.session.workspaceTitle,
        maxFileBytes: authRes.session.kbConfig.maxFileBytes,
        allowedExts: authRes.session.kbConfig.allowedExts,
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

  sendJson(res, 404, { ok: false, error: "未知的投递接口路径" });
  return true;
}
