import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentMode, ClientMessage, HistoryTurn, PolicyId, PreviewKind, ServerMessage } from "../../shared/protocol.ts";
import {
  askDisallowedTools,
  defaultPolicy,
  isPlane,
  isPolicyProtectedPath,
  parsePolicy,
  planDisallowedTools,
  toolFingerprint,
} from "../../shared/policy.ts";
import { dialectOverlay } from "../../shared/dialect.ts";
import { PUBLISH_AGENT_PROMPT, PUBLISH_DENIED_PROMPT } from "../../shared/publishPrompt.ts";
import {
  buildCrewAgents,
  crewAgentToken,
  crewRoleOf,
  isCrewRole,
  isCrewToolName,
  pickReviewPanel,
  resolveCrewModel,
  reviewPanelPrompt,
  rosterKey,
  wantsMultiModelReview,
  workspaceConfinePrompt,
  type ReviewBinding,
} from "../../shared/crew.ts";
import { formatBytes, isByteKind, kindFromPath, mimeOf, sizeLimit } from "../../shared/preview.ts";
import {
  filePayload,
  matchMediaTenant,
  sendMediaBuffer,
  sendMediaFile,
} from "./media.ts";
import {
  allTenants,
  confinedCwd,
  getTenant,
  hasAuth,
  loadTenants,
  mediaSecret,
  requireCwd,
  resolveTenant,
  sandboxEnabledForTenant,
  workspaceFenceForTenant,
  saveDisk,
  settlePersistedChats,
  stateDir,
  type DiskSlot,
  type Tenant,
} from "./tenants.ts";
import { cursorBill } from "./cursorBill.ts";
import {
  noteModelTokens,
  noteOutput,
  noteRun,
  noteToolCall,
  noteTurn,
  usageRec,
  usageSnapshot,
} from "./usage.ts";
import {
  applyStreamEvent,
  clipSnapshot,
  diskSnapshot,
  isStreamEvent,
  markFromTranscript,
  mergeUploadedTurns,
  readRunMark,
  snapshotMessage,
  upsertTranscriptTurn,
  type RunTranscript,
} from "./runlog.ts";
import {
  endpointFor,
  externalModelIds,
  externalRoute,
  streamChatCompletions,
  type ChatHistoryItem,
  type ExternalProvider,
} from "./providers.ts";
import { adapterFor } from "./native/adapters/index.ts";
import { budgetFor, makeCompactor, modelSummarizer } from "./native/compact.ts";
import { buildSystemPrompt } from "./native/context.ts";
import { runNativeLoop } from "./native/loop.ts";
import { mcpTools } from "./native/mcp.ts";
import { deleteSession, loadSession, noteSession, resumeMessages, saveSession, sessionKey } from "./native/session.ts";
import { toolsForMode } from "./native/tools/registry.ts";
import { findBwrap, isReadOnlyCommand, shellTool } from "./native/tools/shell.ts";
import { taskTool } from "./native/tools/task.ts";
import type { ChatMessage, ToolSpec } from "./native/types.ts";
import { bindLoops, loopsForTenant, startLoop, stopLoop, type LoopJob } from "./loops.ts";
import { bindBackground } from "./assistant/background.ts";
import { addApproval, APPROVAL_TTL_MS, findApproval, settleApproval, summarizeArgs } from "./assistant/approvals.ts";
import { activeDelegationFor, createDelegation, getDelegation, updateDelegation } from "./assistant/delegations.ts";
import { postInbox } from "./assistant/inbox.ts";
import {
  assistantName,
  buildState,
  foregroundTools,
  handleOp,
  noteChatDeleted,
  noteUserTurn,
  onTenantHello,
  publishDelegation,
  publishState,
  runDelegateInBackground,
  runLoopInBackground,
  startAssistant,
  userRootPreamble,
  watchMemory,
  chatToolHost,
  type DelegateRequest,
} from "./assistant/service.ts";
import { assistantToolSpecs } from "./assistant/tools.ts";
import { createPublishController } from "./publish.ts";

loadDotEnv([
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
]);

const PORT = Number(process.env.GATEWAY_PORT || 8787);
const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const WEB_URL = new URL(process.env.CURSOR_REMOTE_WEB_ORIGIN || "http://127.0.0.1:3000");
const PROXY_WEB = !/^(0|false|off|no)$/i.test(process.env.GATEWAY_PROXY_WEB || "1");
const DEFAULT_MODEL = process.env.CURSOR_REMOTE_MODEL || "composer-2.5";

loadTenants();
for (const tenant of allTenants()) {
  if (!sandboxEnabledForTenant(tenant)) {
    console.warn(`租户 ${tenant.name}（${tenant.id}）不启用沙箱。`);
  }
}
let modelsCache: { at: number; ids: string[] } | null = null;

const publish = createPublishController({
  tenants: () =>
    allTenants().map((tenant) => ({
      id: tenant.id,
      workspaceRoot: tenant.workspaceRoot,
      stateDir: tenant.stateDir,
    })),
  ticketSecret: mediaSecret,
});

type AgentHandle = Awaited<ReturnType<typeof Agent.create>>;
type RunHandle = Awaited<ReturnType<AgentHandle["send"]>>;

function isAbortError(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name || "";
  const message = err instanceof Error ? err.message : String(err);
  return name === "AbortError" || /aborted/i.test(message);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function cancelRun(run: RunHandle | null | undefined) {
  if (!run?.supports("cancel")) return;
  try {
    await withTimeout(run.cancel(), 5_000);
  } catch (err) {
    if (!isAbortError(err)) {
      // Cancel failures / hangs should not take down the gateway.
    }
  }
}

process.on("unhandledRejection", (err) => {
  if (isAbortError(err)) return;
  console.error(err);
});
process.on("uncaughtException", (err) => {
  if (isAbortError(err)) return;
  const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
  // 超长帧会关掉那一条连接。不能因此退出进程，否则 systemd 重启后客户端立刻重发，变成连上就断。
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    console.error("websocket payload too large");
    return;
  }
  console.error(err);
  process.exit(1);
});

type Checkpoint = {
  id: string;
  label: string;
  commit: string;
  createdAt: number;
  gitDir?: string;
  workTree?: string;
  /** 打点时目录里没有文件。还原时没有可 restore 的路径，只删之后新建的文件 */
  empty?: boolean;
};

type PendingPrompt = {
  text: string;
  model?: string;
  mode: AgentMode;
  files?: string[];
  images?: Array<{ data: string; mimeType: string }>;
  confirmWrites: boolean;
  autoApprove: boolean;
  policy: PolicyId;
  dialect: boolean;
  /** P11：第三方模型的会话历史（客户端权威，随 prompt 上行） */
  history?: ChatHistoryItem[];
  /** 客户端回合 id。排队重放时带回，避免和另一轮缓冲混在一起 */
  turnId?: string;
};

type RunStats = {
  toolStarts: number;
  intercepts: number;
  approvals: number;
  replays: number;
};

type OpenTool = {
  name: string;
  args?: unknown;
  parentCallId?: string;
  agent?: string;
  model?: string;
};

type Slot = {
  tenantId: string;
  chatId: string;
  cwd: string;
  model?: string;
  /** 该会话最近一次 prompt 的模式；Loop 没指定 mode 时沿用 */
  mode?: AgentMode;
  agentId: string | null;
  agent: AgentHandle | null;
  run: RunHandle | null;
  epoch: number;
  finished: boolean;
  edited: string[];
  checkpoints: Checkpoint[];
  awaitingApproval: boolean;
  lastShellCallId: string | null;
  owner: WebSocket | null;
  approvalWait: ((allow: boolean) => void) | null;
  approvalSettled: boolean | null;
  pending: PendingPrompt[];
  openTools: Map<string, OpenTool>;
  reseed: boolean;
  /** P11：第三方模型在途请求的取消柄（Cursor run 走 slot.run，这条路径没有 RunHandle） */
  externalAbort: AbortController | null;
  /** L2：Loop 本拍收集助手文本 / 错误 / 收尾状态，仅调度期间设置 */
  captureText?: (text: string) => void;
  captureError?: (text: string) => void;
  captureDone?: (status: string) => void;
  /** 委派来的子会话：审批要进收件箱并推送，等待时长按 approvalTimeoutMs */
  delegationId?: string;
  approvalTimeoutMs?: number;
  policy: PolicyId;
  approvedKeys: Set<string>;
  approvalCallId: string | null;
  runStats: RunStats;
  dialect: boolean;
  /** 已登记、且彼此模型不同的评审子代理。undefined 表示还没跟目录对齐过。 */
  reviewRoster?: ReviewBinding[];
  /** 这一轮还没被客户端确认的正文。断线后靠它补快照 */
  transcript?: RunTranscript;
  runFlush?: ReturnType<typeof setTimeout>;
};

type Conn = {
  cwd: string;
  model: string;
  authed: boolean;
  ip: string;
  tenant: Tenant | null;
  slots: Map<string, Slot>;
  ws: WebSocket;
  /** hello.client.maxMessageBytes：单条 WS 消息接收上限（0 = 不限，iOS 约 1MiB） */
  maxMessageBytes: number;
  /** hello.client.caps：客户端能力集（"sync_chat" / "stored_digest"） */
  caps: Set<string>;
  policy: PolicyId;
};

const liveByTenant = new Map<string, Map<string, Slot>>();
const conns = new Map<WebSocket, Conn>();
const namingChats = new Set<string>();
const namedChats = new Set<string>();
const loginHits = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function peerIp(req?: IncomingMessage) {
  if (!req) return "unknown";
  const remote = req.socket.remoteAddress || "";
  const fromLoopback = remote === "127.0.0.1" || remote === "::1" || remote === ":ffff:127.0.0.1";
  if (fromLoopback) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      const last = forwarded.split(",").map((item) => item.trim()).filter(Boolean).pop();
      if (last) return last;
    }
  }
  return remote || "unknown";
}

function loginBlocked(ip: string) {
  const row = loginHits.get(ip);
  return Boolean(row && row.blockedUntil > Date.now());
}

function noteLoginFail(ip: string) {
  const now = Date.now();
  const row = loginHits.get(ip) || { count: 0, resetAt: now + 10 * 60_000, blockedUntil: 0 };
  if (now > row.resetAt) {
    row.count = 0;
    row.resetAt = now + 10 * 60_000;
  }
  row.count += 1;
  if (row.count >= 8) row.blockedUntil = now + 10 * 60_000;
  loginHits.set(ip, row);
}

function noteLoginOk(ip: string) {
  loginHits.delete(ip);
}

function agentSocketPath(url = "/") {
  const path = (url.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  return path === "/" || path === "/ws" || path === "/bridge";
}

function liveSlotsOf(tenant: Tenant): Map<string, Slot> {
  let map = liveByTenant.get(tenant.id);
  if (!map) {
    map = new Map();
    liveByTenant.set(tenant.id, map);
  }
  return map;
}

/** 连接登出后，它发起的那一轮还会继续往这个 ws 发事件：归属不随 detachConn 清掉。 */
const wsTenant = new WeakMap<WebSocket, string>();

function bindTenant(conn: Conn, tenant: Tenant) {
  wsTenant.set(conn.ws, tenant.id);
  conn.tenant = tenant;
  conn.slots = liveSlotsOf(tenant);
  conn.cwd = tenant.workspaceRoot;
  conn.authed = true;
}

function detachConn(conn: Conn) {
  if (!conn.tenant) return;
  persistConn(conn);
  for (const slot of conn.slots.values()) {
    if (slot.owner === conn.ws) slot.owner = null;
  }
  conn.tenant = null;
  conn.slots = new Map();
  conn.authed = false;
}

function payload(tenant: Tenant, chatId: string | undefined, path: string, file: Parameters<typeof filePayload>[4], diff: boolean) {
  return filePayload(mediaSecret(), tenant.id, chatId, path, file, diff);
}

function sanitizeWorkspaceName(raw: string): string | null {
  const name = raw.trim().replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!name || name.length > 80) return null;
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    return null;
  }
  return name;
}

function isUserWorkspace(cwd: string, root: string) {
  const next = confinedCwd(cwd, root);
  const base = confinedCwd(root, root);
  return Boolean(next && base && next === base);
}

function listWorkspaceItems(tenant: Tenant): { path: string; name: string; user?: boolean }[] {
  const root = resolve(tenant.workspaceRoot);
  const skip = new Set(["node_modules", "dist", "coverage", "venv", "__pycache__"]);
  const byPath = new Map<string, string>();
  const rootName = assistantName(tenant);
  byPath.set(root, rootName);
  try {
    for (const name of readdirSync(root).sort()) {
      if (name.startsWith(".") || skip.has(name)) continue;
      const abs = resolve(root, name);
      try {
        if (statSync(abs).isDirectory()) byPath.set(abs, name);
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // root missing
  }
  for (const slot of tenant.disk.slots) {
    const cwd = confinedCwd(slot.cwd, root);
    if (!cwd || byPath.has(cwd)) continue;
    const rel = relative(root, cwd);
    byPath.set(cwd, rel || basename(cwd));
  }
  return [...byPath.entries()].map(([path, name]) =>
    path === root ? { path, name: rootName, user: true as const } : { path, name },
  );
}

function emitWorkspaces(ws: WebSocket, tenant: Tenant) {
  send(ws, {
    type: "workspaces",
    root: resolve(tenant.workspaceRoot),
    items: listWorkspaceItems(tenant),
  });
}

function ensureWorkspaceDir(cwd: string) {
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
}

function proxyWeb(req: IncomingMessage, res: ServerResponse) {
  const headers: Record<string, string | string[] | number | undefined> = {
    host: WEB_URL.host,
    "x-forwarded-host": String(req.headers.host || ""),
    "x-forwarded-proto": String(req.headers["x-forwarded-proto"] || "http"),
    "x-forwarded-for": peerIp(req),
  };
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const upstream = httpRequest(
    {
      protocol: WEB_URL.protocol,
      hostname: WEB_URL.hostname,
      port: WEB_URL.port || (WEB_URL.protocol === "https:" ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    },
    (incoming) => {
      const outHeaders = { ...incoming.headers };
      delete outHeaders["transfer-encoding"];
      res.writeHead(incoming.statusCode || 502, outHeaders);
      incoming.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("网页没起来。请先启动 Next（本机 npm run dev，或 VPS 上的 cursor-remote 服务）。");
  });
  req.pipe(upstream);
}

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const headers = { ...req.headers, host: WEB_URL.host };
  const upstream = httpRequest({
    protocol: WEB_URL.protocol,
    hostname: WEB_URL.hostname,
    port: WEB_URL.port || (WEB_URL.protocol === "https:" ? 443 : 80),
    path: req.url,
    method: "GET",
    headers,
  });
  upstream.on("upgrade", (incoming, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}`];
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${key}: ${item}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upSocket.write(head);
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
}

function loadDotEnv(files: string[]) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

function reply(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function send(ws: WebSocket, message: ServerMessage) {
  const chatId = "chatId" in message && typeof message.chatId === "string" ? message.chatId : "";
  const tenantId = wsTenant.get(ws);
  const slot = chatId && tenantId ? slotByChat(tenantId, chatId) : undefined;
  if (slot?.transcript && isStreamEvent(message.type)) applyStreamEvent(slot.transcript, message);
  const capturing = slot && (slot.captureText || slot.captureError) ? slot : undefined;
  if (message.type === "text-delta") capturing?.captureText?.(message.text);
  if (message.type === "error" && "message" in message) capturing?.captureError?.(message.message);
  if (message.type === "done") capturing?.captureDone?.(message.status);
  if (message.type === "approval" && slot?.delegationId) noteDelegationApproval(slot, message.callId, message.name, message.args);
  // 流式事件跟当前 owner。应答仍回发起连接，避免翻页或写文件被另一台设备抢走。
  const owner = isStreamEvent(message.type) && slot?.owner?.readyState === WebSocket.OPEN ? slot.owner : null;
  const sock = owner || (ws.readyState === WebSocket.OPEN ? ws : null);
  if (sock) sock.send(JSON.stringify(message));
}

/** 会话编号由客户端生成，不同租户可能撞号：只在发起连接所属租户里找。 */
function slotByChat(tenantId: string, chatId: string): Slot | undefined {
  return liveByTenant.get(tenantId)?.get(chatId);
}

function stopRunFlush(slot: Slot) {
  if (!slot.runFlush) return;
  clearTimeout(slot.runFlush);
  slot.runFlush = undefined;
}

function armRunFlush(slot: Slot) {
  stopRunFlush(slot);
  slot.runFlush = setTimeout(() => {
    slot.runFlush = undefined;
    const transcript = slot.transcript;
    if (!transcript || transcript.epoch !== slot.epoch || transcript.phase !== "running") return;
    flushTranscript(slot, false);
    if (slot.transcript?.phase === "running" && slot.transcript.epoch === slot.epoch) armRunFlush(slot);
  }, 3_000);
}

function openTranscript(slot: Slot, turnId: string | undefined, userText: string, epoch: number) {
  slot.transcript = {
    turnId: turnId?.trim() || crypto.randomUUID(),
    userText,
    assistant: "",
    thinking: "",
    tools: [],
    phase: "running",
    epoch,
  };
  armRunFlush(slot);
}

function continueTranscript(slot: Slot, epoch: number) {
  if (!slot.transcript) return;
  slot.transcript.epoch = epoch;
  slot.transcript.phase = "running";
  slot.transcript.awaitingApproval = undefined;
  slot.transcript.status = undefined;
  armRunFlush(slot);
}

function flushTranscript(slot: Slot, broadcast: boolean) {
  const tenant = getTenant(slot.tenantId);
  const transcript = slot.transcript;
  if (!tenant || !transcript) return;
  if (transcript.epoch !== slot.epoch) return;
  if (tenant.disk.deletedIds.includes(slot.chatId)) return;
  const mark = markFromTranscript(transcript);
  let chat = tenant.disk.chats.find((item) => chatIdOf(item) === slot.chatId);
  if (!chat) {
    if (tenant.disk.chats.length >= MAX_STORED_CHATS) return;
    chat = { id: slot.chatId, title: "新对话", turns: [], cwd: slot.cwd };
    tenant.disk.chats = [...tenant.disk.chats, chat];
  }
  if (!chat || typeof chat !== "object") return;
  const row = chat as Record<string, unknown>;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  row.turns = upsertTranscriptTurn(turns, transcript);
  row.runMark = mark;
  if (broadcast && transcript.phase === "done") {
    tenant.disk.rev += 1;
    tenant.disk.chatRevs[slot.chatId] = tenant.disk.rev;
  }
  persistTenant(tenant);
  if (broadcast && transcript.phase === "done") {
    broadcastDigest(tenant, null as unknown as WebSocket);
  }
}

function queuedRows(slot: Slot) {
  return slot.pending
    .filter((item) => item.text.trim() || item.turnId)
    .map((item) => ({ turnId: item.turnId, userText: item.text }));
}

function emitRunSnapshots(ws: WebSocket, tenant: Tenant) {
  const limit = conns.get(ws)?.maxMessageBytes ?? 0;
  const covered = new Set<string>();
  for (const slot of liveSlotsOf(tenant).values()) {
    if (slot.transcript && slot.transcript.epoch === slot.epoch) {
      covered.add(slot.chatId);
      const queued = queuedRows(slot);
      const full = snapshotMessage(slot.chatId, slot.transcript, queued);
      const clipped = clipSnapshot(full, limit);
      if (clipped.type === "run_snapshot" && clipped.clipped) flushTranscript(slot, false);
      send(ws, clipped);
      continue;
    }
    if (!slot.pending.length) continue;
    covered.add(slot.chatId);
    send(ws, {
      type: "run_snapshot",
      chatId: slot.chatId,
      phase: "done",
      userText: "",
      assistant: "",
      queued: queuedRows(slot),
    });
  }
  for (const chat of tenant.disk.chats) {
    const id = chatIdOf(chat);
    const mark = readRunMark(chat);
    if (!id || !mark || covered.has(id)) continue;
    const turns =
      chat && typeof chat === "object" && Array.isArray((chat as { turns?: unknown }).turns)
        ? ((chat as { turns: unknown[] }).turns)
        : [];
    const full = diskSnapshot(id, mark, turns, mark.phase === "running");
    send(ws, clipSnapshot(full, limit));
  }
}

function protectChatUpload(
  tenant: Tenant,
  chatId: string,
  incoming: unknown,
  turnsProvided: boolean,
): unknown {
  if (!incoming || typeof incoming !== "object") return incoming;
  const prev = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
  const slot = liveSlotsOf(tenant).get(chatId);
  const transcript = slot?.transcript && slot.transcript.epoch === slot.epoch ? slot.transcript : null;
  let baseTurns: unknown[] =
    prev && typeof prev === "object" && Array.isArray((prev as { turns?: unknown }).turns)
      ? (prev as { turns: unknown[] }).turns
      : [];
  if (transcript) baseTurns = upsertTranscriptTurn(baseTurns, transcript);
  const mark = transcript ? markFromTranscript(transcript) : readRunMark(prev);
  const row = { ...(incoming as Record<string, unknown>) };
  if (isAssistantChat(tenant, chatId)) {
    row.title = assistantName(tenant);
    row.assistant = true;
  }
  if (!turnsProvided) {
    if (baseTurns.length || mark) row.turns = baseTurns;
    if (mark) row.runMark = mark;
    return row;
  }
  const incomingTurns = Array.isArray(row.turns) ? row.turns : [];
  const merged = mergeUploadedTurns(baseTurns, incomingTurns, mark);
  row.turns = transcript ? upsertTranscriptTurn(merged.turns, transcript) : merged.turns;
  const stillRunning = Boolean(transcript && transcript.phase === "running");
  if (merged.clearMark && !stillRunning) {
    delete row.runMark;
    if (slot?.transcript?.phase === "done") {
      stopRunFlush(slot);
      slot.transcript = undefined;
    }
  } else if (mark) {
    row.runMark = mark;
  }
  return row;
}

function parseClient(raw: string): ClientMessage | null {
  try {
    const data = JSON.parse(raw) as ClientMessage;
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function persistConn(conn: Conn) {
  const tenant = conn.tenant;
  if (!tenant) return;
  persistTenant(tenant, conn.slots);
}

function persistTenant(tenant: Tenant, slots = liveSlotsOf(tenant)) {
  const byId = new Map(tenant.disk.slots.map((item) => [item.chatId, item]));
  for (const slot of slots.values()) {
    byId.set(slot.chatId, {
      chatId: slot.chatId,
      agentId: slot.agentId,
      cwd: requireCwd(slot.cwd, tenant.workspaceRoot),
      model: slot.model,
      edited: slot.edited,
      checkpoints: slot.checkpoints,
      reviewRoster: slot.reviewRoster,
    });
  }
  tenant.disk.slots = [...byId.values()];
  saveDisk(tenant);
}

function chatIdsFrom(chats: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const item of chats) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

function pruneDroppedSlots(tenant: Tenant, keepIds: Set<string>) {
  if (!keepIds.size) return;
  const live = liveSlotsOf(tenant);
  for (const [chatId, slot] of [...live.entries()]) {
    if (keepIds.has(chatId)) continue;
    resolveApprovalWait(slot, false);
    void cancelRun(slot.run);
    void disposeSlot(slot);
    live.delete(chatId);
  }
  tenant.disk.slots = tenant.disk.slots.filter((item) => keepIds.has(item.chatId));
}

function chatIdOf(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

/** 每个租户唯一的个人助理会话：编号固定、工作目录固定在 USER 根目录、不能删除 */
function assistantChatIdOf(tenant: Tenant) {
  return `assistant-${tenant.id}`;
}

function isAssistantChat(tenant: Tenant | null | undefined, chatId: string) {
  return Boolean(tenant && chatId && chatId === assistantChatIdOf(tenant));
}

function assistantCwd(tenant: Tenant) {
  return confinedCwd(tenant.workspaceRoot, tenant.workspaceRoot) || resolve(tenant.workspaceRoot);
}

/** 助理会话不分段新建：每满这么多轮换一个新的模型会话，靠记忆块 + 最近摘录续上 */
const ASSISTANT_ROLL_TURNS = 40;
const assistantRolledAt = new WeakMap<Slot, number>();

/** 缺了就建；只认编号，不改客户端写回的标题等字段，避免每次同步都触发重新对账 */
function ensureAssistantChat(tenant: Tenant) {
  const id = assistantChatIdOf(tenant);
  const exists = tenant.disk.chats.some((item) => chatIdOf(item) === id);
  const deleted = tenant.disk.deletedIds.includes(id);
  if (exists && !deleted) return false;
  tenant.disk.deletedIds = tenant.disk.deletedIds.filter((item) => item !== id);
  if (!exists) {
    tenant.disk.chats = [
      { id, title: assistantName(tenant), turns: [], cwd: assistantCwd(tenant), assistant: true },
      ...tenant.disk.chats,
    ];
  }
  tenant.disk.rev += 1;
  tenant.disk.chatRevs[id] = tenant.disk.rev;
  persistTenant(tenant);
  return true;
}

function tombstoneChat(tenant: Tenant, chatId: string) {
  if (!chatId || isAssistantChat(tenant, chatId)) return;
  tenant.disk.deletedIds = [chatId, ...tenant.disk.deletedIds.filter((id) => id !== chatId)].slice(0, 500);
  tenant.disk.chats = tenant.disk.chats.filter((item) => chatIdOf(item) !== chatId);
  delete tenant.disk.chatRevs[chatId];
  noteChatDeleted(tenant, chatId);
}

/// 全量 chatRevs 视图：没有记录的老会话补 0（迁移期），保证 digest/stored_state 一致
function effectiveChatRevs(tenant: Tenant): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of tenant.disk.chats) {
    const id = chatIdOf(item);
    if (id) out[id] = tenant.disk.chatRevs[id] ?? 0;
  }
  return out;
}

/// 会话条数硬顶（P4 审核）：sync_chat 可追加未知 id，无上限会被死循环/恶意客户端打爆磁盘
const MAX_STORED_CHATS = 500;

/// 规范化 JSON 序列化（对象键排序），用于变更检测——
/// 避免 Swift(JSONSerialization) 与 JS(插入序) 的键序差异把相同内容误判为 changed
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/// chatRevs 裁剪到当前存活会话集（P4 审核）：gone 过滤/旧状态残留的脏 key 随 persist 一直带着
function pruneChatRevs(tenant: Tenant) {
  const live = new Set(chatIdsFrom(tenant.disk.chats));
  for (const id of Object.keys(tenant.disk.chatRevs)) {
    if (!live.has(id)) delete tenant.disk.chatRevs[id];
  }
}

/// sync 被接受后向同租户其他支持 digest 的连接广播目录（P4 审核：多设备实时对账，
/// 否则对端要等自己 rev 分叉才发现变化，互相覆盖）。旧客户端无 caps 不收。
function broadcastDigest(tenant: Tenant, except: WebSocket) {
  for (const other of conns.values()) {
    if (other.ws === except || !other.authed || other.tenant?.id !== tenant.id) continue;
    if (!other.caps.has("stored_digest")) continue;
    send(other.ws, {
      type: "stored_digest",
      rev: tenant.disk.rev,
      deletedIds: tenant.disk.deletedIds,
      chatRevs: effectiveChatRevs(tenant),
    });
  }
}

function visibleChats(tenant: Tenant) {
  if (!tenant.disk.deletedIds.length) return tenant.disk.chats;
  const gone = new Set(tenant.disk.deletedIds);
  return tenant.disk.chats.filter((item) => {
    const id = chatIdOf(item);
    return !id || !gone.has(id);
  });
}

/// P8：slim_state 客户端的会话元数据视图——剥掉 turns（内容走 load_chat 分页），
/// 补响应期计算的 preview（不落盘，避免 digest 抖动）。真空会话保留 turns:[]：
/// 客户端按「有无 turns 键」区分「真空（已完整）」与「有内容未加载」（评审 GLM M3）
function chatPreviewOf(turns: unknown[]): string {
  // 与 iOS preview 语义逐字对齐：先倒序找最后一条非空 user，没有再倒序找 assistant
  //（不是「最后一条非空消息」——assistant 收尾的会话也应显示最后的提问）
  for (const key of ["user", "assistant"] as const) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (!turn || typeof turn !== "object") continue;
      const text = (turn as Record<string, unknown>)[key];
      if (typeof text === "string" && text.trim()) return text.slice(0, 100);
    }
  }
  return "";
}

function slimChat(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const row = item as Record<string, unknown>;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const rest = { ...row };
  delete rest.turns;
  delete rest.preview; // 不信持久化里的旧值，响应期重算
  if (!turns.length) return { ...rest, turns: [] };
  return { ...rest, preview: chatPreviewOf(turns) };
}

/// load_chat 组页时单条 turn 超预算的兜底截断：砍长字符串字段并打 clipped 标记。
/// 截断副本只用于展示——sync_chat 回传时网关按 id 回退服务端完整版（见 sync_chat 合并），截断内容不会回写落盘
function clipTurnForPage(turn: unknown, budget: number): unknown {
  if (!turn || typeof turn !== "object") return turn;
  const row = { ...(turn as Record<string, unknown>) };
  const cap = 64 * 1024;
  for (const key of ["thinking", "assistant", "user"]) {
    const value = row[key];
    if (typeof value === "string" && value.length > cap) row[key] = `${value.slice(0, cap)}…（过长已截断）`;
  }
  if (Array.isArray(row.tools)) {
    row.tools = row.tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const t = { ...(tool as Record<string, unknown>) };
      for (const key of ["result", "args"]) {
        const value = t[key];
        if (typeof value === "string" && value.length > cap) {
          t[key] = `${value.slice(0, cap)}…（过长已截断）`;
        } else if (value && typeof value === "object" && Buffer.byteLength(JSON.stringify(value)) > cap) {
          t[key] = { truncated: true, note: "内容过长，完整版见网页端" };
        }
      }
      return t;
    });
  }
  row.clipped = true;
  // 极端情况截完仍超预算（海量短字段）：换成占位 turn，保住 id 让客户端页码不断——总比撑爆 WS 断连强
  if (Buffer.byteLength(JSON.stringify(row)) > budget) {
    return {
      id: (turn as { id?: unknown }).id,
      user: "",
      assistant: "（此条消息过大，无法在此设备显示，完整版见网页端）",
      clipped: true,
    };
  }
  return row;
}

function storedStatePayload(tenant: Tenant, slim = false) {
  const live = new Set(runningChatIds(tenant));
  const chats = visibleChats(tenant).map((item) =>
    live.has(chatIdOf(item)) ? item : settlePersistedChats([item])[0],
  );
  return {
    type: "stored_state" as const,
    chats: slim ? chats.map(slimChat) : chats,
    rev: tenant.disk.rev,
    deletedIds: tenant.disk.deletedIds,
    chatRevs: effectiveChatRevs(tenant),
  };
}

/// 分叉时的状态对齐：支持 digest 的客户端发目录（P4c），否则全量 stored_state（含 deferral 护栏）
function emitStateSync(ws: WebSocket, tenant: Tenant) {
  const conn = conns.get(ws);
  if (conn?.caps.has("stored_digest")) {
    send(ws, {
      type: "stored_digest",
      rev: tenant.disk.rev,
      deletedIds: tenant.disk.deletedIds,
      chatRevs: effectiveChatRevs(tenant),
    });
    return;
  }
  emitStoredState(ws, tenant);
}

function emitStoredState(ws: WebSocket, tenant: Tenant) {
  const conn = conns.get(ws);
  const payload = storedStatePayload(tenant, conn?.caps.has("slim_state") ?? false);
  const limit = conn?.maxMessageBytes ?? 0;
  if (limit > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > limit) {
      // 客户端收不了这么大的单条 WS 消息（iOS URLSessionWebSocketTask 约 1MiB），改走 HTTP /state
      console.log("stored_state deferred", tenant.id, bytes, ">", limit);
      send(ws, { type: "stored_state_deferred", rev: tenant.disk.rev });
      return;
    }
  }
  send(ws, payload);
}

async function forgetChat(conn: Conn, chatId: string) {
  const tenant = conn.tenant;
  if (!tenant || isAssistantChat(tenant, chatId)) return;
  tombstoneChat(tenant, chatId);
  const stopped = stopLoop(tenant.id, chatId);
  if (stopped) publishLoop(tenant.id, { type: "loop_state", ...stopped });
  const slot = conn.slots.get(chatId);
  if (slot) {
    resolveApprovalWait(slot, false);
    slot.pending = []; // 删除会话不续跑排队消息（旧 external 栈返回后 drain 会扑空，Grok R2）
    stopRunFlush(slot);
    slot.transcript = undefined;
    slot.epoch += 1; // 过期门：旧栈 finishRun/drainPending 一律失效
    await cancelRun(slot.run);
    await disposeSlot(slot);
    conn.slots.delete(chatId);
  }
  deleteSession(tenant.stateDir, chatId);
  tenant.disk.slots = tenant.disk.slots.filter((item) => item.chatId !== chatId);
  pruneDroppedSlots(tenant, chatIdsFrom(tenant.disk.chats));
  tenant.disk.rev += 1;
  persistConn(conn);
}

function hydrateConn(conn: Conn) {
  const tenant = conn.tenant;
  if (!tenant) return;
  for (const saved of tenant.disk.slots) {
    if (conn.slots.has(saved.chatId)) continue;
    conn.slots.set(saved.chatId, makeSlot(tenant, saved.chatId, saved, conn.ws));
  }
}

function diskSlot(tenant: Tenant, chatId: string): DiskSlot | undefined {
  return tenant.disk.slots.find((item) => item.chatId === chatId);
}

function diskChatCwd(tenant: Tenant, chatId: string): string | undefined {
  for (const item of tenant.disk.chats) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; cwd?: unknown };
    if (row.id !== chatId || typeof row.cwd !== "string" || !row.cwd.trim()) continue;
    return row.cwd;
  }
}

function makeSlot(tenant: Tenant, chatId: string, saved: DiskSlot | undefined, owner: WebSocket): Slot {
  return {
    tenantId: tenant.id,
    chatId,
    cwd: requireCwd(diskChatCwd(tenant, chatId) || saved?.cwd, tenant.workspaceRoot),
    model: saved?.model,
    agentId: saved?.agentId || null,
    agent: null,
    run: null,
    epoch: 0,
    finished: true,
    edited: saved?.edited || [],
    checkpoints: Array.isArray(saved?.checkpoints) ? (saved.checkpoints as Checkpoint[]) : [],
    awaitingApproval: false,
    lastShellCallId: null,
    owner,
    approvalWait: null,
    approvalSettled: null,
    pending: [],
    openTools: new Map(),
    reseed: false,
    externalAbort: null,
    policy: defaultPolicy(),
    approvedKeys: new Set(),
    approvalCallId: null,
    runStats: { toolStarts: 0, intercepts: 0, approvals: 0, replays: 0 },
    dialect: true,
    reviewRoster: rosterFromDisk(saved?.reviewRoster),
  };
}

function rosterFromDisk(raw: DiskSlot["reviewRoster"]): ReviewBinding[] | undefined {
  if (!Array.isArray(raw)) return;
  const rows: ReviewBinding[] = [];
  for (const item of raw) {
    if (!item || typeof item.name !== "string" || typeof item.modelId !== "string") continue;
    const name = item.name.trim();
    const modelId = item.modelId.trim();
    if (!name || !modelId) continue;
    rows.push({ name, modelId });
  }
  return raw.length ? rows : undefined;
}

function slotOf(conn: Conn, chatId: string): Slot {
  const tenant = conn.tenant;
  if (!tenant) throw new Error("先发 hello。");
  let slot = conn.slots.get(chatId);
  if (!slot) {
    slot = makeSlot(tenant, chatId, diskSlot(tenant, chatId), conn.ws);
    conn.slots.set(chatId, slot);
  }
  slot.owner = conn.ws;
  slot.tenantId = tenant.id;
  return slot;
}

function runningChatIds(tenant: Tenant) {
  return [...liveSlotsOf(tenant).values()]
    // P11：externalAbort 非空 = 第三方在途（无 RunHandle）——也算 running，否则重连丢运行态
    .filter((slot) => (!slot.finished && (slot.run || slot.externalAbort)) || slot.pending.length)
    .map((slot) => slot.chatId);
}

function queuedChatIds(tenant: Tenant) {
  return [...liveSlotsOf(tenant).values()].filter((slot) => slot.pending.length).map((slot) => slot.chatId);
}

function globalRunningCount() {
  let n = 0;
  for (const tenant of allTenants()) {
    n += [...liveSlotsOf(tenant).values()].filter(
      (slot) => !slot.finished && (slot.run || slot.externalAbort),
    ).length;
  }
  return n;
}

function maxRunning() {
  return Math.max(allTenants().length, 1);
}

function attachLiveSlots(conn: Conn) {
  for (const slot of conn.slots.values()) {
    slot.owner = conn.ws;
  }
}

function tenantOwnsChat(tenant: Tenant, chatId: string) {
  if (!chatId) return false;
  if (liveSlotsOf(tenant).has(chatId)) return true;
  if (tenant.disk.slots.some((item) => item.chatId === chatId)) return true;
  return tenant.disk.chats.some((item) => chatIdOf(item) === chatId);
}

function chatOwnedByOther(chatId: string, except: Tenant) {
  if (!chatId) return false;
  for (const tenant of allTenants()) {
    if (tenant.id === except.id) continue;
    if (tenantOwnsChat(tenant, chatId)) return true;
  }
  return false;
}

function resolveApprovalWait(slot: Slot, allow: boolean) {
  const wait = slot.approvalWait;
  slot.approvalWait = null;
  if (slot.delegationId && (wait || slot.awaitingApproval)) noteDelegationAnswered(slot);
  if (wait) {
    slot.awaitingApproval = false;
    wait(allow);
    return;
  }
  if (slot.awaitingApproval) {
    slot.awaitingApproval = false;
    slot.approvalSettled = allow;
  }
}

function rememberApproved(slot: Slot) {
  const id = slot.approvalCallId;
  const tool = id ? slot.openTools.get(id) : undefined;
  if (tool) slot.approvedKeys.add(toolFingerprint(tool.name, tool.args));
}

function waitForApproval(slot: Slot, ms = slot.approvalTimeoutMs ?? 120_000) {
  if (slot.approvalSettled != null) {
    const value = slot.approvalSettled;
    slot.approvalSettled = null;
    return Promise.resolve(value);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      // waiter 已被替换时也要 resolve，否则旧调用方永远挂着
      if (slot.approvalWait === done) {
        slot.approvalWait = null;
        slot.awaitingApproval = false;
        if (slot.delegationId) noteDelegationExpired(slot);
      }
      resolve(false);
    }, ms);
    const done = (allow: boolean) => {
      clearTimeout(timer);
      resolve(allow);
    };
    slot.approvalWait = done;
  });
}

function cwdOf(conn: Conn, slot: Slot) {
  const root = conn.tenant?.workspaceRoot || slot.cwd;
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) return requireCwd(root, root);
  return requireCwd(slot.cwd || conn.cwd, root);
}

function cwdForChat(tenant: Tenant, chatId: string) {
  if (isAssistantChat(tenant, chatId)) return assistantCwd(tenant);
  const fromChat = diskChatCwd(tenant, chatId);
  if (fromChat) {
    const next = confinedCwd(fromChat, tenant.workspaceRoot);
    if (next) return next;
  }
  const live = liveSlotsOf(tenant).get(chatId);
  if (live?.cwd) {
    const next = confinedCwd(live.cwd, tenant.workspaceRoot);
    if (next) return next;
  }
  const saved = diskSlot(tenant, chatId);
  if (saved?.cwd) {
    const next = confinedCwd(saved.cwd, tenant.workspaceRoot);
    if (next) return next;
  }
  return tenant.workspaceRoot;
}

async function listModels(apiKey: string): Promise<string[]> {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60_000) return modelsCache.ids;
  try {
    const listed = await Promise.race([
      Cursor.models.list({ apiKey }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("models timeout")), 4000);
      }),
    ]);
    const ids = listed.map((item) => item.id).filter(Boolean);
    const next = ids.length ? ids : [DEFAULT_MODEL];
    modelsCache = { at: Date.now(), ids: next };
    return next;
  } catch {
    return modelsCache?.ids || [DEFAULT_MODEL];
  }
}

async function disposeSlot(slot: Slot) {
  const agent = slot.agent;
  slot.agent = null;
  slot.run = null;
  // P11：第三方在途请求一并取消（new_session/fresh/delete 都走这里）——
  // 不 abort 的话旧流 delta 无 epoch 门可挡，会混进新会话（Grok 评审 C1）
  slot.externalAbort?.abort();
  slot.externalAbort = null;
  if (!agent) return;
  try {
    await agent[Symbol.asyncDispose]();
  } catch {
    // Agent may already be closed.
  }
}

function isAgentMissing(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === "agent_not_found") return true;
  const text = [rec.message, err instanceof Error ? err.message : ""].filter(Boolean).join(" ");
  return /agent[-_ ].*not found/i.test(text) || /agent_not_found/i.test(text);
}

async function ensureAgent(conn: Conn, slot: Slot): Promise<AgentHandle> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("服务器未配置 CURSOR_API_KEY。写入环境或 .env 后重启 gateway。");
  }
  const cwd = cwdOf(conn, slot);
  if (slot.agent) return slot.agent;

  const modelId = (slot.model || conn.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const catalog = await listModels(apiKey);
  const sandbox = sandboxEnabledForTenant(conn.tenant);
  const local: { cwd: string; sandboxOptions?: { enabled: boolean }; customTools?: ReturnType<typeof foregroundTools> } = {
    cwd,
    sandboxOptions: { enabled: sandbox },
  };
  // 助理工具只挂在唯一的助理会话上；其他会话没有记忆工具
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) {
    local.customTools = foregroundTools(conn.tenant, slot.chatId);
  }
  const base = { apiKey, model: { id: modelId }, local };
  const overlay = slot.dialect === false ? undefined : dialectOverlay;
  const panel = [...(slot.reviewRoster ?? pickReviewPanel(modelId, catalog))];

  const open = async (next: ReviewBinding[] | null, resumeId: string | null) => {
    const opts = next
      ? { ...base, agents: buildCrewAgents(modelId, catalog, cwd, overlay, next, workspaceFenceForTenant(conn.tenant)) }
      : base;
    if (resumeId) return Agent.resume(resumeId, opts);
    return Agent.create(opts);
  };

  // 某个评审模型被拒时丢掉这一个再试，保留 explore / builder 和其余评审。
  // Agent.resume 会不会吃进新的 agents 没有类型保证，名单变化时上层会另开 agent。
  const openWithCrewFallback = async (resumeId: string | null) => {
    let next = panel;
    let bare = false;
    while (true) {
      try {
        return await open(bare ? null : next, resumeId);
      } catch (err) {
        if (isAgentMissing(err)) throw err;
        if (bare) throw err;
        if (next.length) {
          const dropped = next[next.length - 1];
          console.error("drop reviewer after crew reject", dropped.modelId, err);
          next = next.slice(0, -1);
          continue;
        }
        console.error("crew agents rejected, retrying without them", err);
        bare = true;
      }
    }
  };

  const resumeId = slot.agentId;
  try {
    slot.agent = await openWithCrewFallback(resumeId);
  } catch (err) {
    if (!resumeId || !isAgentMissing(err)) throw err;
    console.warn("agent missing, opening a new one", { chatId: slot.chatId, agentId: resumeId });
    await disposeSlot(slot);
    slot.agentId = null;
    slot.reseed = true;
    slot.agent = await openWithCrewFallback(null);
  }
  if (!resumeId && diskChatTurns(conn.tenant, slot.chatId).length) slot.reseed = true;
  slot.agentId = slot.agent.agentId;
  persistConn(conn);
  return slot.agent;
}

async function syncReviewRoster(conn: Conn, slot: Slot, lead: string) {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  const catalog = apiKey ? await listModels(apiKey) : [];
  const next = pickReviewPanel(lead, catalog);
  const known = slot.reviewRoster;
  const same = known ? rosterKey(known) === rosterKey(next) : false;
  if (same) return;
  const stale = known !== undefined || Boolean(slot.agent || slot.agentId);
  if (stale && (slot.agent || slot.agentId)) {
    if (slot.agent) await disposeSlot(slot);
    slot.agentId = null;
    slot.reseed = true;
  }
  slot.reviewRoster = next;
  if (stale) persistConn(conn);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function clipHistory(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

function diskChatTurns(tenant: Tenant | null | undefined, chatId: string) {
  if (!tenant || !chatId) return [] as { user: string; assistant: string }[];
  const chat = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
  if (!isRecord(chat) || !Array.isArray(chat.turns)) return [];
  const out: { user: string; assistant: string }[] = [];
  for (const raw of chat.turns) {
    if (!isRecord(raw)) continue;
    const error = typeof raw.error === "string" ? raw.error : "";
    if (/agent[-_ ].*not found/i.test(error)) continue;
    const user = typeof raw.user === "string" ? raw.user.trim() : "";
    const assistant = typeof raw.assistant === "string" ? raw.assistant.trim() : "";
    if (!user && !assistant) continue;
    out.push({ user, assistant });
  }
  return out;
}

function attachReseedContext(
  tenant: Tenant | null | undefined,
  chatId: string,
  currentText: string,
  prompt: string,
) {
  const wanted = currentText.trim();
  const prior = diskChatTurns(tenant, chatId).filter((turn) => {
    if (!wanted) return Boolean(turn.user || turn.assistant);
    if (turn.user === wanted && !turn.assistant) return false;
    return Boolean(turn.user || turn.assistant);
  });
  if (!prior.length) return prompt;
  const pieces: string[] = [];
  let used = 0;
  const budget = 24_000;
  for (const turn of prior.slice(-10).reverse()) {
    const user = turn.user ? clipHistory(turn.user, 1_500) : "（附图或空消息）";
    const assistant = turn.assistant ? clipHistory(turn.assistant, 4_000) : "（无文字回复）";
    const block = `用户：${user}\n助手：${assistant}`;
    if (used && used + block.length > budget) break;
    pieces.push(block);
    used += block.length;
  }
  pieces.reverse();
  return `以下是同一工作区里此前的对话摘录，文件以磁盘为准。请直接接着当前请求继续，不要复述这段说明，也不要说自己是新会话。

${pieces.join("\n\n")}

当前请求：
${prompt}`;
}

function conversationToTurns(conv: unknown[], roster?: ReviewBinding[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const item of conv) {
    if (!isRecord(item) || item.type === "shellConversationTurn") continue;
    const user =
      isRecord(item.userMessage) && typeof item.userMessage.text === "string"
        ? item.userMessage.text
        : "";
    const steps = Array.isArray(item.steps) ? item.steps : [];
    let assistant = "";
    let thinking = "";
    const tools: NonNullable<HistoryTurn["tools"]> = [];
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const msg = step.message;
      if (step.type === "assistantMessage" && isRecord(msg) && typeof msg.text === "string") {
        assistant += msg.text;
      } else if (step.type === "thinkingMessage" && isRecord(msg) && typeof msg.text === "string") {
        thinking += msg.text;
      } else if (step.type === "toolCall" && isRecord(msg)) {
        const name = typeof msg.type === "string" ? msg.type : "tool";
        const wrap = msg.result;
        let result: unknown;
        let status: "completed" | "error" = "completed";
        if (isRecord(wrap)) {
          if (wrap.status === "error") status = "error";
          result = "value" in wrap ? wrap.value : wrap;
        }
        tools.push({
          callId: crypto.randomUUID(),
          name,
          args: msg.args,
          result,
          status,
          agent: crewRoleOf(name, msg.args),
          model: resolveCrewModel(name, msg.args, roster),
        });
      }
    }
    if (!user && !assistant && !tools.length) continue;
    out.push({
      id: crypto.randomUUID(),
      user,
      assistant: clipHistory(assistant, 80_000),
      thinking: thinking ? clipHistory(thinking, 20_000) : undefined,
      tools,
    });
  }
  return out;
}

async function sendAgentHistory(ws: WebSocket, conn: Conn, slot: Slot) {
  const agentId = slot.agentId;
  if (!agentId) return;
  try {
    const listed = await Agent.listRuns(agentId, {
      runtime: "local",
      cwd: cwdOf(conn, slot),
      limit: 12,
    });
    const turns: HistoryTurn[] = [];
    for (const run of listed.items) {
      try {
        if (typeof run.supports === "function" && !run.supports("conversation")) continue;
        const conv = await run.conversation();
        turns.push(...conversationToTurns(conv as unknown[], slot.reviewRoster));
      } catch {
        continue;
      }
      if (turns.length >= 40) break;
    }
    if (turns.length) {
      send(ws, { type: "history", chatId: slot.chatId, turns: turns.slice(-40) });
    }
  } catch {
    // History is best-effort; local store may not have runs yet.
  }
}

function shellToolName(name: string) {
  return /(shell|bash|terminal|command)/i.test(name);
}

function rememberShellCall(slot: Slot, name: string, callId: string) {
  if (shellToolName(name) && callId) slot.lastShellCallId = callId;
}

function snapshotFromResult(result: unknown): { stdout?: string; stderr?: string } {
  if (typeof result === "string" && result) return { stdout: result };
  if (!isRecord(result)) return {};
  const inner = isRecord(result.value) ? result.value : isRecord(result.result) ? result.result : result;
  const stdout =
    typeof inner.stdout === "string"
      ? inner.stdout
      : typeof inner.output === "string"
        ? inner.output
        : typeof inner.text === "string"
          ? inner.text
          : "";
  const stderr = typeof inner.stderr === "string" ? inner.stderr : "";
  return {
    stdout: stdout || undefined,
    stderr: stderr || undefined,
  };
}

function parseShellDelta(event: Record<string, unknown>): {
  callId: string;
  stream: "stdout" | "stderr";
  chunk: string;
} | null {
  const callId = String(
    event.callId || event.call_id || event.toolCallId || event.tool_call_id || event.id || "",
  );
  const stream: "stdout" | "stderr" =
    event.stream === "stderr" || (typeof event.stderr === "string" && event.stderr && !event.stdout)
      ? "stderr"
      : "stdout";
  let chunk = "";
  if (typeof event.chunk === "string") chunk = event.chunk;
  else if (typeof event.data === "string") chunk = event.data;
  else if (typeof event.text === "string") chunk = event.text;
  else if (stream === "stderr" && typeof event.stderr === "string") chunk = event.stderr;
  else if (typeof event.stdout === "string") chunk = event.stdout;
  else if (typeof event.output === "string") chunk = event.output;
  if (!chunk) return null;
  return { callId, stream, chunk };
}

function emitToolOutput(
  ws: WebSocket,
  slot: Slot,
  payload: {
    callId?: string;
    stream?: "stdout" | "stderr";
    chunk?: string;
    stdout?: string;
    stderr?: string;
  },
) {
  const callId = payload.callId || slot.lastShellCallId;
  if (!callId) return;
  if (!payload.chunk && payload.stdout == null && payload.stderr == null) return;
  send(ws, {
    type: "tool-output",
    chatId: slot.chatId,
    callId,
    stream: payload.stream,
    chunk: payload.chunk,
    stdout: payload.stdout,
    stderr: payload.stderr,
  });
}

function isAskQuestionTool(name: string): boolean {
  return /ask.?question/i.test(name);
}

/// 提问工具的选项必须原样送到客户端。通用摘要会把 questions 丢掉，界面就只剩一次突然结束。
function presentToolArgs(name: string, args: unknown): unknown {
  if (!isAskQuestionTool(name)) return summarizeToolArgs(args);
  const asked = sanitizeAskArgs(args);
  return asked ?? summarizeToolArgs(args);
}

function sanitizeAskArgs(args: unknown): { title: string; questions: unknown[] } | null {
  const record =
    args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const nested =
    record?.args && typeof record.args === "object"
      ? (record.args as Record<string, unknown>)
      : null;
  const source = nested?.questions ? nested : record;
  if (!source) return null;
  const raw = Array.isArray(source.questions) ? source.questions : [];
  const questions = raw.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const prompt = typeof row.prompt === "string" ? row.prompt.slice(0, 500) : "";
    if (!prompt) return [];
    const id = typeof row.id === "string" && row.id ? row.id.slice(0, 80) : prompt.slice(0, 40);
    const allowMultiple = row.allow_multiple === true || row.allowMultiple === true;
    const options = (Array.isArray(row.options) ? row.options : []).slice(0, 12).flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const opt = option as Record<string, unknown>;
      const label = typeof opt.label === "string" ? opt.label.slice(0, 200) : "";
      if (!label) return [];
      const optionId = typeof opt.id === "string" && opt.id ? opt.id.slice(0, 80) : label.slice(0, 40);
      return [{ id: optionId, label }];
    });
    return [{ id, prompt, allowMultiple, options }];
  });
  if (!questions.length) return null;
  const title = typeof source.title === "string" ? source.title.slice(0, 200) : "";
  return { title, questions };
}

function summarizeToolArgs(args: unknown): unknown {
  if (args == null || typeof args !== "object") return args;
  const record = args as Record<string, unknown>;
  const keep = [
    "path",
    "file",
    "target",
    "file_path",
    "command",
    "pattern",
    "query",
    "cwd",
    "old_string",
    "new_string",
    "oldString",
    "newString",
    "oldText",
    "newText",
    "contents",
    "content",
    "diff",
    "patch",
    "description",
    "title",
    "prompt",
    "subagent_type",
    "subagentType",
    "name",
    "agent",
    "model",
    "readonly",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    if (key in record) out[key] = record[key];
  }
  if (typeof out.prompt === "string" && out.prompt.length > 500) {
    out.prompt = `${out.prompt.slice(0, 500)}\n…`;
  }
  return Object.keys(out).length ? out : args;
}

function pathFromTool(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "target", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

function rememberEdit(slot: Slot, name: string, args: unknown, cwd?: string) {
  if (!isMutatingTool(name, args)) return;
  const raw = pathFromTool(args);
  const path = cwd ? workspacePath(cwd, raw) || raw : raw;
  if (path && !slot.edited.includes(path)) slot.edited.push(path);
}

function workspacePath(cwd: string, raw: string): string | null {
  const abs = raw.startsWith("/") ? raw : resolve(cwd, raw);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

function tenantForCwd(cwd: string): Tenant | undefined {
  const abs = resolve(cwd);
  for (const tenant of allTenants()) {
    if (confinedCwd(abs, tenant.workspaceRoot)) return tenant;
  }
}

function shadowGitEnv(cwd: string): Record<string, string> | null {
  const tenant = tenantForCwd(cwd);
  if (!tenant) return null;
  const dir = shadowGitDir(cwd, tenant.stateDir);
  if (!existsSync(resolve(dir, "HEAD"))) return null;
  const env = {
    GIT_DIR: dir,
    GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: resolve(dir, "cursor-remote-index"),
  };
  try {
    git(cwd, ["rev-parse", "--verify", "HEAD"], env);
    return env;
  } catch {
    return null;
  }
}

function isTracked(cwd: string, path: string): boolean {
  const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
  if (!gitRoot(cwd) && !env) return false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    return true;
  } catch {
    return false;
  }
}

function undoEdits(cwd: string, paths: string[]): { paths: string[]; error?: string } {
  if (!paths.length) return { paths: [], error: "这一轮没有记下改过的文件" };
  const restored: string[] = [];
  const failed: string[] = [];
  for (const raw of paths) {
    const path = workspacePath(cwd, raw);
    if (!path) continue;
    try {
      if (isTracked(cwd, path)) {
        const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
        execFileSync("git", ["checkout", "--", path], {
          cwd,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
          env: env ? { ...process.env, ...env } : process.env,
        });
        restored.push(path);
      } else {
        const abs = resolve(cwd, path);
        if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
        restored.push(path);
      }
    } catch {
      failed.push(path);
    }
  }
  if (!restored.length) {
    return { paths: [], error: failed.length ? "git 还原失败" : "没有可还原的文件" };
  }
  return {
    paths: restored,
    error: failed.length ? `部分失败：${failed.join(", ")}` : undefined,
  };
}

function gitIdentity(): Record<string, string> {
  const name = process.env.GIT_AUTHOR_NAME || process.env.CURSOR_REMOTE_GIT_NAME || "cursor-remote";
  const email =
    process.env.GIT_AUTHOR_EMAIL || process.env.CURSOR_REMOTE_GIT_EMAIL || "cursor-remote@localhost";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || name,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || email,
  };
}

function gitBytes(cwd: string, args: string[], extraEnv?: Record<string, string>): Buffer {
  const ident = gitIdentity();
  return execFileSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "-c",
      `user.name=${ident.GIT_AUTHOR_NAME}`,
      "-c",
      `user.email=${ident.GIT_AUTHOR_EMAIL}`,
      ...args,
    ],
    {
      cwd,
      encoding: "buffer",
      timeout: 15000,
      maxBuffer: 80 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...ident, ...extraEnv },
    },
  );
}

function git(cwd: string, args: string[], extraEnv?: Record<string, string>): string {
  return gitBytes(cwd, args, extraEnv).toString("utf8").trim();
}

function shadowGitDir(cwd: string, stateDir: string) {
  const id = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return resolve(stateDir, "shadow-git", id);
}

function ensureShadowGit(cwd: string) {
  const tenant = tenantForCwd(cwd);
  if (!tenant) throw new Error("工作区不属于任何租户");
  const dir = shadowGitDir(cwd, tenant.stateDir);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(resolve(dir, "HEAD"))) {
    execFileSync("git", ["init", "--bare", dir], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const info = resolve(dir, "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(
    resolve(info, "exclude"),
    ["node_modules/", ".next/", ".git/", ".DS_Store", "*.tsbuildinfo", ".cursor-remote-index"].join("\n") + "\n",
  );
  return dir;
}

function checkpointGit(cwd: string, checkpoint?: Checkpoint): { cwd: string; env: Record<string, string> } {
  const tenant = tenantForCwd(cwd);
  if (checkpoint?.gitDir && tenant) {
    const workTree = confinedCwd(checkpoint.workTree || cwd, tenant.workspaceRoot) || cwd;
    const gitDir = resolve(checkpoint.gitDir);
    const rel = relative(tenant.stateDir, gitDir);
    if (rel && !rel.startsWith("..") && !rel.split(/[/\\]/).includes("..")) {
      return {
        cwd: workTree,
        env: {
          GIT_DIR: gitDir,
          GIT_WORK_TREE: workTree,
          GIT_INDEX_FILE: resolve(gitDir, "cursor-remote-index"),
        },
      };
    }
  }
  const root = gitRoot(cwd);
  if (root) {
    let gitDir = git(root, ["rev-parse", "--git-dir"]);
    if (!gitDir.startsWith("/")) gitDir = resolve(root, gitDir);
    return {
      cwd: root,
      env: { GIT_INDEX_FILE: resolve(gitDir, "cursor-remote-index") },
    };
  }
  const gitDir = ensureShadowGit(cwd);
  return {
    cwd,
    env: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: cwd,
      GIT_INDEX_FILE: resolve(gitDir, "cursor-remote-index"),
    },
  };
}

function publicCheckpoints(slot: Slot) {
  return slot.checkpoints.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
}

function sendCheckpoints(ws: WebSocket, slot: Slot) {
  send(ws, { type: "checkpoints", chatId: slot.chatId, items: publicCheckpoints(slot) });
}

function pushWorkspace(ws: WebSocket, slot: Slot, conn: Conn, paths: string[] = []) {
  const cwd = cwdOf(conn, slot);
  const listed = listWorkspaceFiles(cwd, "");
  send(ws, {
    type: "files",
    chatId: slot.chatId,
    query: "",
    paths: listed.paths,
    status: listed.status,
    truncated: listed.truncated,
  });
  const unique = [...new Set(paths.filter(Boolean))];
  for (const path of unique) {
    const file = readWorkspaceFile(cwd, path);
    send(ws, payload(conn.tenant || getTenant(slot.tenantId)!, slot.chatId, path, file, false));
    const diff = readWorkspaceDiff(cwd, path);
    send(ws, payload(conn.tenant || getTenant(slot.tenantId)!, slot.chatId, path, diff, true));
  }
}

/** 聊天目录在 git 工作区里的相对路径。根目录本身返回空串。 */
function workspacePrefix(root: string, cwd: string): string {
  const rel = relative(resolve(root), resolve(cwd)).replace(/\\/g, "/");
  if (!rel || rel === ".") return "";
  if (rel === ".." || rel.startsWith("../") || rel.split("/").includes("..")) {
    throw new Error("检查点工作区不在仓库内");
  }
  return rel;
}

/** 把检查点树里的仓库路径收成聊天目录内的相对路径。仓库外的路径丢掉。 */
function cwdPathFromTree(treePath: string, prefix: string): string | null {
  const norm = treePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return null;
  if (!prefix) return norm;
  if (norm === prefix) return null;
  const lead = `${prefix}/`;
  if (!norm.startsWith(lead)) return null;
  return norm.slice(lead.length);
}

/** 目录里有没有任何非目录条目（含 git 忽略的文件和符号链接，不看 .git）。空目录检查点据此判定 */
function dirHasEntries(dir: string): boolean {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch {
      return true;
    }
    for (const name of names) {
      if (cur === dir && name === ".git") continue;
      try {
        const st = lstatSync(resolve(cur, name));
        if (st.isDirectory()) stack.push(resolve(cur, name));
        else return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

function createCheckpoint(cwd: string, label: string): Checkpoint {
  const ctx = checkpointGit(cwd);
  try {
    git(ctx.cwd, ["read-tree", "HEAD"], ctx.env);
  } catch {
    git(ctx.cwd, ["read-tree", "--empty"], ctx.env);
  }
  // 子目录只快照自己。add -A 打在仓库根上会把兄弟项目卷进来，还原时再按根路径删文件。
  const prefix = workspacePrefix(ctx.cwd, cwd);
  const empty = !dirHasEntries(cwd);
  const listed = prefix ? [prefix] : listWorkspaceFiles(cwd, "").paths;
  try {
    if (listed.length) {
      for (let i = 0; i < listed.length; i += 200) {
        git(ctx.cwd, ["add", "-A", "--", ...listed.slice(i, i + 200)], ctx.env);
      }
    } else {
      git(ctx.cwd, ["add", "-A"], ctx.env);
    }
    git(ctx.cwd, ["add", "-u", "--", ...(prefix ? [prefix] : ["."])], ctx.env);
  } catch {
    if (prefix) throw new Error("子目录检查点没记下，已停止，避免快照整个仓库");
    git(ctx.cwd, ["add", "-A"], ctx.env);
  }
  const tree = git(ctx.cwd, ["write-tree"], ctx.env);
  const args = ["commit-tree", tree, "-m", `cursor-remote: ${label}`];
  try {
    args.splice(2, 0, "-p", git(ctx.cwd, ["rev-parse", "HEAD"], ctx.env));
  } catch {
    // empty repo, no parent
  }
  const commit = git(ctx.cwd, args, ctx.env);
  const id = commit.slice(0, 8);
  git(ctx.cwd, ["update-ref", `refs/cursor-remote/${id}`, commit], ctx.env);
  if (ctx.env.GIT_DIR) {
    git(ctx.cwd, ["update-ref", "HEAD", commit], ctx.env);
  }
  return {
    id,
    label,
    commit,
    createdAt: Date.now(),
    gitDir: ctx.env.GIT_DIR,
    workTree: ctx.cwd,
    empty: empty || undefined,
  };
}

function restoreCheckpoint(
  cwd: string,
  checkpoint: Checkpoint,
  extra: string[] = [],
): { error?: string } {
  try {
    const ctx = checkpointGit(cwd, checkpoint);
    const prefix = workspacePrefix(ctx.cwd, cwd);
    const keep = new Set<string>();
    if (!checkpoint.empty) {
      if (prefix) {
        git(ctx.cwd, ["restore", "--source", checkpoint.commit, "--worktree", "--", prefix], ctx.env);
      } else {
        git(ctx.cwd, ["restore", "--source", checkpoint.commit, "--worktree", "."], ctx.env);
      }
    }
    if (ctx.env.GIT_DIR) {
      git(ctx.cwd, ["update-ref", "HEAD", checkpoint.commit], ctx.env);
      git(ctx.cwd, ["read-tree", checkpoint.commit], ctx.env);
    }
    if (!checkpoint.empty) {
      const treePaths = git(ctx.cwd, ["ls-tree", "-z", "-r", "--name-only", checkpoint.commit], ctx.env)
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const name of treePaths) {
        const local = cwdPathFromTree(name, prefix);
        if (local) keep.add(local);
      }
      const treeHasScope = prefix
        ? treePaths.some((name) => name === prefix || name.startsWith(`${prefix}/`))
        : treePaths.length > 0;
      if (prefix && !treeHasScope) {
        return { error: "检查点里没有这个目录的文件，已停止删除。" };
      }
      if (treeHasScope && keep.size === 0) {
        return { error: "检查点路径对不上当前目录，已停止删除文件。" };
      }
    }
    const extras = new Set(extra.map((raw) => workspacePath(cwd, raw)).filter(Boolean) as string[]);
    for (const path of listWorkspaceFiles(cwd, "").paths) extras.add(path);
    for (const path of extras) {
      if (!path || keep.has(path)) continue;
      const abs = resolve(cwd, path);
      try {
        if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
      } catch {
        // skip files we cannot remove
      }
    }
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "还原检查点失败" };
  }
}

function nativeStateDir(conn: Conn, slot: Slot): string | null {
  return (conn.tenant || getTenant(slot.tenantId))?.stateDir ?? null;
}

/** 文件被还原后，自研 Agent 的会话里记一笔，否则模型下一轮会以为改动还在 */
function noteNativeRestore(conn: Conn, slot: Slot, label?: string, paths?: string[]) {
  const dir = nativeStateDir(conn, slot);
  if (!dir) return;
  const what = paths?.length ? `这些文件已撤销到改动前：${paths.slice(0, 20).join(", ")}` : `工作区已还原到检查点${label ? `「${label}」` : ""}`;
  noteSession(dir, slot.chatId, `（系统提示：${what}。之前的改动可能已不存在，动手前先重新读取文件。）`);
}

function rollbackToLatestCheckpoint(
  ws: WebSocket,
  slot: Slot,
  conn: Conn,
  silent = false,
): { error?: string; restored: boolean } {
  const cwd = cwdOf(conn, slot);
  const wanted = slot.checkpoints[0];
  if (wanted) {
    const preview = slot.edited.slice();
    const result = restoreCheckpoint(cwd, wanted, slot.edited);
    slot.edited = [];
    if (!result.error) {
      noteNativeRestore(conn, slot, wanted.label);
      send(ws, {
        type: "restored",
        chatId: slot.chatId,
        checkpointId: wanted.id,
        label: wanted.label,
        silent,
      });
      pushWorkspace(ws, slot, conn, silent ? [] : preview);
    }
    return { error: result.error, restored: !result.error };
  }
  const undone = undoEdits(cwd, slot.edited);
  slot.edited = [];
  if (undone.paths.length) {
    send(ws, {
      type: "undone",
      chatId: slot.chatId,
      paths: undone.paths,
      error: undone.error,
    });
    pushWorkspace(ws, slot, conn, undone.paths);
  }
  return { error: undone.error, restored: undone.paths.length > 0 };
}

type WorkspaceFile = {
  path: string;
  content?: string;
  error?: string;
  kind?: PreviewKind;
  mime?: string;
  size?: number;
  hasHead?: boolean;
};

function readWorkspaceFile(cwd: string, raw: string): WorkspaceFile {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const abs = resolve(cwd, path);
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { path, error: "这不是文件" };
    const kind = kindFromPath(path);
    const mime = mimeOf(path, kind);
    const limit = sizeLimit(kind);
    if (st.size > limit) {
      return {
        path,
        error: `文件太大（${formatBytes(st.size)}），不在这里打开`,
        kind,
        mime,
        size: st.size,
      };
    }
    if (isByteKind(kind)) {
      return { path, kind, mime, size: st.size };
    }
    if ((kind === "html" || kind === "markdown") && st.size > 400_000) {
      return { path, kind, mime, size: st.size };
    }
    const buf = readFileSync(abs);
    if (kind === "text" && buf.includes(0)) {
      return {
        path,
        error: "二进制文件，没法预览",
        kind: "binary",
        mime: "application/octet-stream",
        size: st.size,
      };
    }
    return { path, content: buf.toString("utf8"), kind, mime, size: st.size };
  } catch {
    return { path, error: "读不了这个文件" };
  }
}

function writeWorkspaceFile(
  cwd: string,
  raw: string,
  content: string,
): { path: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path)) return { path, error: "不能改策略文件" };
  if (content.length > 500_000) return { path, error: "内容超过 500KB，不在这里保存" };
  const abs = resolve(cwd, path);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { path };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "写不了这个文件" };
  }
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const UPLOAD_DIR = ".cursor-remote/uploads";

function safeUploadName(raw: string): string {
  const base = basename(raw || "file").replace(/[\\/]/g, "");
  const cleaned =
    base.replace(/[\x00-\x1f:*?"<>|]/g, "_").replace(/^\.+/g, "").trim() || "file";
  return cleaned.slice(0, 120);
}

function uniqueUploadPath(cwd: string, name: string): string | null {
  const safe = safeUploadName(name);
  for (let n = 0; n < 200; n++) {
    const stem =
      n === 0
        ? safe
        : (() => {
            const dot = safe.lastIndexOf(".");
            const head = dot > 0 ? safe.slice(0, dot) : safe;
            const ext = dot > 0 ? safe.slice(dot) : "";
            return `${head}-${n}${ext}`;
          })();
    const rel = `${UPLOAD_DIR}/${stem}`;
    if (!workspacePath(cwd, rel)) return null;
    if (!existsSync(resolve(cwd, rel))) return rel;
  }
  return null;
}

function writeWorkspaceBytes(
  cwd: string,
  raw: string,
  buf: Buffer,
): { path: string; error?: string; size?: number } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path)) return { path, error: "不能改策略文件" };
  if (buf.length > MAX_UPLOAD_BYTES) return { path, error: "文件超过 32MB" };
  try {
    mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
    writeFileSync(resolve(cwd, path), buf);
    return { path, size: buf.length };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "写不了这个文件" };
  }
}

function mentionBase(raw: string) {
  return raw.replace(/:\d+(?:-\d+)?$/, "").replace(/\/+$/, "");
}

function expandAttachments(cwd: string, files: string[]): string {
  const parts: string[] = [];
  for (const raw of files.slice(0, 20)) {
    if (/^diff$/i.test(raw)) {
      try {
        const extra = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
        const out = git(cwd, ["diff", "HEAD"], extra);
        parts.push(
          out
            ? `Current uncommitted diff:\n\`\`\`diff\n${out.slice(0, 30_000)}\n\`\`\``
            : "No uncommitted diff.",
        );
      } catch {
        parts.push("Not a git workspace (no Diff).");
      }
      continue;
    }
    const path = workspacePath(cwd, mentionBase(raw));
    if (!path) continue;
    const abs = resolve(cwd, path);
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        const kids: string[] = [];
        walkFiles(abs, abs, kids, 0);
        parts.push(
          `Folder ${path}/ (${kids.length} files):\n${kids
            .slice(0, 80)
            .map((kid) => `- ${path}/${kid}`)
            .join("\n")}`,
        );
        continue;
      }
      if (parts.filter((item) => item.startsWith("File ") || item.startsWith("Attached ")).length >= 4) continue;
      const file = readWorkspaceFile(cwd, path);
      if (file.content != null) {
        parts.push(`File ${path}:\n\`\`\`\n${file.content.slice(0, 20_000)}\n\`\`\``);
      } else if (!file.error) {
        parts.push(
          `Attached workspace file ${path} (${file.kind || "binary"}${file.size != null ? `, ${formatBytes(file.size)}` : ""}). It is already in the working directory; read it with tools.`,
        );
      }
    } catch {
      // skip unreadable attachment
    }
  }
  return parts.join("\n\n");
}

function runFsOp(
  cwd: string,
  op: "create" | "mkdir" | "rename" | "delete",
  raw: string,
  to?: string,
): { path: string; to?: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path) || (to && isPolicyProtectedPath(to))) {
    return { path, to, error: "不能改策略文件" };
  }
  const abs = resolve(cwd, path);
  try {
    if (op === "mkdir") {
      mkdirSync(abs, { recursive: true });
      return { path };
    }
    if (op === "create") {
      mkdirSync(dirname(abs), { recursive: true });
      if (existsSync(abs)) return { path, error: "已经有这个文件" };
      writeFileSync(abs, "");
      return { path };
    }
    if (op === "rename") {
      if (!to?.trim()) return { path, error: "缺少新名字" };
      const dest = workspacePath(cwd, to);
      if (!dest) return { path, to, error: "新路径不在工作区里" };
      const destAbs = resolve(cwd, dest);
      if (existsSync(destAbs)) return { path, to: dest, error: "目标已存在" };
      mkdirSync(dirname(destAbs), { recursive: true });
      renameSync(abs, destAbs);
      return { path, to: dest };
    }
    if (op === "delete") {
      if (!existsSync(abs)) return { path, error: "不存在" };
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (readdirSync(abs).length) return { path, error: "目录不是空的" };
        rmdirSync(abs);
      } else {
        unlinkSync(abs);
      }
      return { path };
    }
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "操作失败" };
  }
  return { path, error: "未知操作" };
}

function readWorkspaceDiff(cwd: string, raw: string): WorkspaceFile {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  try {
    if (kind === "image" || kind === "svg") {
      const abs = resolve(cwd, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return { path, error: "这不是文件", kind, mime };
      }
      const size = statSync(abs).size;
      if (!isTracked(cwd, path)) {
        return { path, kind, mime, size, hasHead: false };
      }
      const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
      const out = git(cwd, ["diff", "HEAD", "--", path], env);
      if (!out) return { path, error: "没有未提交的改动", kind, mime, size };
      return { path, kind, mime, size, hasHead: true };
    }
    if (isByteKind(kind)) {
      return { path, error: "这类文件没有文本 diff", kind, mime };
    }
    if (isTracked(cwd, path)) {
      const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
      const out = git(cwd, ["diff", "HEAD", "--", path], env);
      if (out) return { path, content: out, kind: "text", mime: "text/x-diff" };
      return { path, error: "没有未提交的改动", kind };
    }
    const file = readWorkspaceFile(cwd, path);
    if (file.error || file.content == null) {
      return { path, error: file.error || "读不了这个文件", kind: file.kind, mime: file.mime, size: file.size };
    }
    const lines = file.content.split("\n");
    const body = [
      `diff --git a/${path} b/${path}`,
      "new file",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return { path, content: body, kind: "text", mime: "text/x-diff", size: file.size };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "没有 diff", kind, mime };
  }
}

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function sanitizeImages(
  images: Array<{ data: string; mimeType: string }> | undefined,
): Array<{ data: string; mimeType: string }> {
  if (!images?.length) return [];
  return images
    .filter(
      (img) =>
        IMAGE_MIME.has(img.mimeType) &&
        typeof img.data === "string" &&
        img.data.length > 24 &&
        img.data.length < 12_000_000,
    )
    .slice(0, 5)
    .map((img) => ({
      data: img.data.replace(/^data:[^;]+;base64,/, ""),
      mimeType: img.mimeType,
    }));
}

function shellPublishes(name: string, args: unknown) {
  if (!/(shell|bash|terminal|command)/i.test(name)) return false;
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const cmd = typeof record.command === "string" ? record.command : "";
  return /(?:^|[\s;|&`'"(])(?:\S*\/)?jiebo-publish\b/.test(cmd);
}

function isMutatingTool(name: string, args: unknown): boolean {
  const n = name.toLowerCase();
  if (/todo|createplan/.test(n)) return false;
  if (/(write|strreplace|apply.?patch|editnotebook|delete|unlink|createfile)/.test(n)) {
    return true;
  }
  if (/(^|[^a-z])edit([^a-z]|$)/.test(n) && !/read/.test(n)) return true;
  if (/(shell|bash|terminal|command)/.test(n)) {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const cmd = typeof record.command === "string" ? record.command : "";
    return /(^|\s)(rm|mv|cp|chmod|chown|sudo|mkdir|touch|tee|dd|truncate|git\s+(add|commit|push|reset|checkout)|npm\s+i(nstall)?|pnpm\s+add|yarn\s+add|pip\s+install)\b/i.test(
      cmd,
    );
  }
  return false;
}

function toolEscapesWorkspace(cwd: string, name: string, args: unknown): boolean {
  const raw = pathFromTool(args);
  if (raw && !workspacePath(cwd, raw)) return true;
  if (!/(shell|bash|terminal|command)/i.test(name)) return false;
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const working = typeof record.working_directory === "string" ? record.working_directory : "";
  // workspacePath 对工作区根本身返回 null，"." 或根的绝对路径不算越界
  if (working && resolve(cwd, working) !== resolve(cwd) && !workspacePath(cwd, working)) return true;
  const cmd = typeof record.command === "string" ? record.command : "";
  if (!cmd) return false;
  for (const match of cmd.matchAll(/(?:^|[\s;|&])(?:\d*>{1,2}|tee(?:\s+-a)?)\s*(\/[^\s;|&]+)/g)) {
    const abs = match[1];
    if (abs === "/dev/null" || abs.startsWith("/dev/")) continue;
    if (!workspacePath(cwd, abs)) return true;
  }
  return false;
}

function loadWorkspaceRules(cwd: string): string {
  const chunks: string[] = [];
  const take = (rel: string) => {
    const abs = resolve(cwd, rel);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return;
      const text = readFileSync(abs, "utf8").trim();
      if (text) chunks.push(`# ${rel}\n${text}`);
    } catch {
      // skip unreadable rule files
    }
  };
  take(".cursorrules");
  take("AGENTS.md");
  const dir = resolve(cwd, ".cursor/rules");
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const name of readdirSync(dir).sort()) {
        if (!/\.(md|mdc)$/i.test(name)) continue;
        take(`.cursor/rules/${name}`);
      }
    }
  } catch {
    // no rules directory
  }
  return chunks.join("\n\n").slice(0, 16_000);
}

function wrapPrompt(
  text: string,
  mode: AgentMode,
  files?: string[],
  rules?: string,
  cwd?: string,
  panel: ReviewBinding[] = [],
  atUserRoot = false,
  confine = true,
): string {
  let body = text;
  if (files?.length) {
    const expanded = cwd ? expandAttachments(cwd, files) : "";
    body = `The user attached these workspace files as context:\n${files
      .map((file) => `- ${file}`)
      .join("\n")}${expanded ? `\n\n${expanded}` : ""}\n\n${text}`;
  }
  if (rules?.trim()) {
    body = `Workspace rules (follow these):\n${rules.trim()}\n\n${body}`;
  }
  const bound = cwd && confine ? `${workspaceConfinePrompt(cwd)}\n\n` : "";
  if (mode === "ask") {
    return `${bound}ASK MODE (read-only). You must not modify the workspace.
Do not call write, edit, delete, apply patch, or any mutating shell command (rm, mv, git commit, npm install, etc.).
Do not run jiebo-publish.
If the user wants a change, explain what you would do and stop. Answer in text only.
Do not spawn subagents. Any suggested change must stay inside the current workspace.

${body}`;
  }
  if (mode === "plan") {
    return `${bound}Plan mode: 只出方案，不要改文件，不要跑会改系统的命令。用中文分步写清楚。用户点「执行这个计划」后才会动手。
方案里的每一步都只能动当前工作区里的文件，不要提议改工作区外的路径。
${atUserRoot ? "不要执行 jiebo-publish。需要外网地址时，把 jiebo-publish start -- <启动命令> 写进方案。网站只能在这个 USER 工作区里做。" : "不要执行 jiebo-publish，也不要把它写进方案。对外网站只能在 USER 工作区里创建。"}
可以派出 explore 子代理做只读摸底。不要派出 builder。
${reviewPanelPrompt(panel)}

${body}`;
  }
  return `${bound}CANVAS: If this turn's deliverable is a standalone analytical artifact (table, chart, review, metrics, timeline, architecture comparison), write exactly one file at .cursor-remote/canvases/<kebab-name>.canvas.tsx.
Import only from "cursor/canvas". Default-export one React component. Embed data inline. No fetch(), no relative imports, no npm packages.
Link that file in the reply, e.g. [仓库概览](.cursor-remote/canvases/repo-overview.canvas.tsx). Do not write a canvas for ordinary Q&A or a pure code edit.
画布颜色跟应用主题走：只用 cursor/canvas 组件和 useHostTheme() 上色，不要写死 hex、rgb、hsl，也不要另做一套深浅色。宿主会套上用户当前的配色。

命令或工具失败时不要结束整个任务。同一件事最多再试 2 次，每次换一种做法，不要原样重复。仍失败就把这一步记下来；后面不依赖它的步骤继续做。全部做完再说明哪一步没成。

${atUserRoot ? PUBLISH_AGENT_PROMPT : PUBLISH_DENIED_PROMPT}

CREW: Named subagents via the Task/Agent tool: explore (read-only search), builder (implement). Subagents must stay inside the current workspace.
${reviewPanelPrompt(panel)}

${body}`;
}

function walkFiles(root: string, dir: string, acc: string[], depth: number) {
  if (depth > 3 || acc.length > 200) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === ".next" ||
      name === "dist" ||
      name === ".loop" ||
      name === ".cursor" ||
      name === ".venv" ||
      name === "venv" ||
      name === "coverage"
    ) {
      continue;
    }
    const full = resolve(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        if (full !== root && existsSync(resolve(full, ".git"))) continue;
        walkFiles(root, full, acc, depth + 1);
      } else acc.push(relative(root, full));
    } catch {
      // skip unreadable
    }
  }
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitLetter(xy: string): string {
  if (xy === "??" || xy.includes("?")) return "U";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  if (xy.includes("R") || xy.includes("C")) return "R";
  return "M";
}

function unescapeGitPath(file: string): string {
  if (!(file.startsWith('"') && file.endsWith('"'))) return file;
  const inner = file.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === "\\") {
        bytes.push(next.charCodeAt(0));
        i += 1;
        continue;
      }
      const oct = /^\\([0-7]{3})/.exec(inner.slice(i));
      if (oct) {
        bytes.push(Number.parseInt(oct[1], 8));
        i += oct[0].length - 1;
        continue;
      }
    }
    bytes.push(inner.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

function parsePorcelain(out: string, root: string, cwd: string): Record<string, string> {
  const map: Record<string, string> = {};
  const nul = out.includes("\0");
  const chunks = nul ? out.split("\0") : out.split("\n");
  for (let i = 0; i < chunks.length; i++) {
    const raw = chunks[i];
    if (raw.length < 3) continue;
    const xy = raw.slice(0, 2);
    let file = unescapeGitPath(raw.slice(3));
    if ((xy.includes("R") || xy.includes("C")) && nul && i + 1 < chunks.length) {
      file = unescapeGitPath(chunks[++i]);
    } else {
      const arrow = file.lastIndexOf(" -> ");
      if (arrow >= 0) file = file.slice(arrow + 4);
    }
    if (!file) continue;
    const rel = relative(cwd, resolve(root, file));
    if (!rel || rel.startsWith("..")) continue;
    map[rel] = gitLetter(xy);
  }
  return map;
}

function headNames(cwd: string, extra?: Record<string, string>): Set<string> {
  try {
    const out = extra
      ? git(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], extra)
      : execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
          cwd,
          encoding: "utf8",
          timeout: 4000,
          stdio: ["ignore", "pipe", "ignore"],
        });
    return new Set(
      out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function dropGhostStatus(
  cwd: string,
  map: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const head = headNames(cwd, extra);
  const next: Record<string, string> = {};
  for (const [path, letter] of Object.entries(map)) {
    if (existsSync(resolve(cwd, path)) || head.has(path)) next[path] = letter;
  }
  return next;
}

function gitStatusMap(cwd: string): Record<string, string> {
  const run = (root: string, extra?: Record<string, string>) => {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain", "-uall", "-z"], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      env: extra ? { ...process.env, ...extra } : process.env,
    });
    return dropGhostStatus(cwd, parsePorcelain(out, root, cwd), extra);
  };
  const root = gitRoot(cwd);
  if (root) {
    try {
      return run(root);
    } catch {
      return {};
    }
  }
  const extra = shadowGitEnv(cwd);
  if (!extra) return {};
  try {
    return run(cwd, extra);
  } catch {
    return {};
  }
}

function listWorkspaceFiles(
  cwd: string,
  query: string,
): { paths: string[]; status: Record<string, string>; truncated: boolean } {
  let paths: string[] = [];
  const root = gitRoot(cwd);
  const shadow = root ? null : shadowGitEnv(cwd);
  try {
    if (root) {
      // quotepath 默认会把中文路径收成 "\345\256..."，后面的 existsSync 对不上磁盘，整批被丢掉。
      const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
        cwd,
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      paths = out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else if (shadow) {
      paths = git(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], shadow)
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      walkFiles(cwd, cwd, paths, 0);
    }
  } catch {
    walkFiles(cwd, cwd, paths, 0);
  }
  const status = gitStatusMap(cwd);
  paths = paths.filter((path) => existsSync(resolve(cwd, path)));
  for (const path of Object.keys(status)) {
    if (status[path] === "D") continue;
    if (!paths.includes(path) && existsSync(resolve(cwd, path))) paths.push(path);
  }
  const q = query.trim().toLowerCase();
  const filtered = q
    ? paths.filter((path) => {
        const base = path.split("/").pop() || path;
        return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
      })
    : paths;
  const dirty = Object.keys(status);
  const rest = filtered.filter((path) => !status[path]);
  const ranked = q
    ? filtered
    : [...dirty.filter((path) => filtered.includes(path)), ...rest];
  const sliced = ranked.slice(0, 8000);
  return { paths: sliced, status, truncated: ranked.length > sliced.length };
}

function parseSearchHits(raw: string): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = [];
  for (const row of raw.split("\n")) {
    if (!row) continue;
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!match) continue;
    hits.push({
      path: match[1].replace(/^\.\//, ""),
      line: Number(match[2]),
      text: match[3].replace(/\s+/g, " ").trim().slice(0, 140),
    });
    if (hits.length >= 100) break;
  }
  return hits;
}

function searchWorkspace(cwd: string, query: string): { path: string; line: number; text: string }[] {
  const needle = query.trim();
  if (!needle || needle.length > 200) return [];
  const globs = [
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!**/.next/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/.venv/**",
  ];
  try {
    const out = execFileSync(
      "rg",
      [
        "-n",
        "--fixed-strings",
        "--hidden",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        "24",
        "--max-filesize",
        "200K",
        ...globs,
        "--",
        needle,
        ".",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return parseSearchHits(out);
  } catch (err) {
    const failed = err as { status?: number; stdout?: string };
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  try {
    const extra = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
    const out = execFileSync(
      "git",
      ["-c", "core.quotepath=false", "grep", "-n", "-I", "-F", "-e", needle, "--", "."],
      {
        cwd,
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: extra ? { ...process.env, ...extra } : process.env,
      },
    );
    return parseSearchHits(out);
  } catch (err) {
    const failed = err as { status?: number; stdout?: string };
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  const paths: string[] = [];
  walkFiles(cwd, cwd, paths, 0);
  const hits: { path: string; line: number; text: string }[] = [];
  const lower = needle.toLowerCase();
  for (const path of paths) {
    const abs = resolve(cwd, path);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 200_000) continue;
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(lower)) continue;
        hits.push({
          path,
          line: i + 1,
          text: lines[i].replace(/\s+/g, " ").trim().slice(0, 140),
        });
        n += 1;
        if (n >= 8 || hits.length >= 100) break;
      }
    } catch {
      // skip unreadable
    }
    if (hits.length >= 100) break;
  }
  return hits;
}

function revertHunk(
  cwd: string,
  raw: string,
  hunk: string,
): { path: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const headerRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const hunkLines = hunk.split("\n");
  const atIdx = hunkLines.findIndex((line) => headerRe.test(line));
  if (atIdx < 0) return { path, error: "看不懂这段 diff" };
  const header = headerRe.exec(hunkLines[atIdx]);
  if (!header) return { path, error: "看不懂这段 diff" };
  const file = readWorkspaceFile(cwd, path);
  if (file.error || file.content == null) {
    return { path, error: file.error || "读不了这个文件" };
  }
  let i = Number(header[1]) - 1;
  const lines = file.content.split("\n");
  const body = hunkLines.slice(atIdx + 1);
  for (let k = 0; k < body.length; k++) {
    const row = body[k];
    if (k === body.length - 1 && row === "") continue;
    if (row.startsWith("+")) {
      if (i < 0 || i >= lines.length) return { path, error: "这段 diff 对不上文件" };
      lines.splice(i, 1);
    } else if (row.startsWith("-")) {
      lines.splice(Math.max(i, 0), 0, row.slice(1));
      i += 1;
    } else if (row.startsWith("\\")) {
      continue;
    } else {
      i += 1;
    }
  }
  const abs = resolve(cwd, path);
  const next = lines.join("\n");
  try {
    if (!next.trim() && !isTracked(cwd, path)) {
      if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
    } else {
      writeFileSync(abs, next);
    }
  } catch {
    return { path, error: "写回失败" };
  }
  return { path };
}

function closeOpenTools(ws: WebSocket, slot: Slot, runStatus: string) {
  if (!slot.openTools) slot.openTools = new Map();
  if (!slot.openTools.size) return;
  const failed = /cancel|error/i.test(runStatus);
  const status = failed ? "error" : "completed";
  for (const [callId, meta] of slot.openTools) {
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name: meta.name,
      status,
      result: failed ? "已中断" : undefined,
      parentCallId: meta.parentCallId,
      agent: meta.agent,
      model: meta.model,
    });
  }
  slot.openTools.clear();
}

function finishRun(
  ws: WebSocket,
  slot: Slot,
  status: string,
  durationMs?: number,
  epoch?: number,
) {
  if (epoch != null && slot.epoch !== epoch) return;
  slot.run = null;
  if (slot.finished) return;
  closeOpenTools(ws, slot, status);
  slot.finished = true;
  noteRun(slot.tenantId, durationMs); // P9 计量：finished 门保证一次 run 只计一次
  send(ws, {
    type: "done",
    chatId: slot.chatId,
    status,
    durationMs,
    policy: slot.policy,
    toolStarts: slot.runStats.toolStarts,
    intercepts: slot.runStats.intercepts,
    approvals: slot.runStats.approvals,
    replays: slot.runStats.replays,
    dialect: slot.dialect,
  });
  const approval = status === "approval";
  if (!approval) stopRunFlush(slot);
  flushTranscript(slot, !approval);
  if (!approval) indexUserTurn(slot);
}

/** 助理会话每轮完成后进会话搜索索引；其他会话不进 */
function indexUserTurn(slot: Slot) {
  const tenant = getTenant(slot.tenantId);
  const transcript = slot.transcript;
  if (!tenant || !transcript || !isAssistantChat(tenant, slot.chatId)) return;
  const chat = tenant.disk.chats.find((item) => chatIdOf(item) === slot.chatId) as
    | { title?: unknown; turns?: unknown[] }
    | undefined;
  const turns = Array.isArray(chat?.turns) ? chat.turns.length : 1;
  try {
    noteUserTurn(tenant, {
      chatId: slot.chatId,
      turn: Math.max(turns - 1, 0),
      title: typeof chat?.title === "string" ? chat.title : "",
      user: transcript.userText || "",
      assistant: transcript.assistant || "",
    });
  } catch (err) {
    console.error("index user turn", err);
  }
}

function sanitizeChatTitle(raw: string) {
  let title = raw.trim().split(/\r?\n/)[0] || "";
  title = title.replace(/^[#>*\-\s]+/, "");
  title = title.replace(/^标题[:：]\s*/, "");
  title = title.replace(/^["「『“]+|["」』”。！？.!?]+$/g, "").trim();
  if (title.length > 24) title = title.slice(0, 24).trim();
  return title;
}

/** P11：第三方 OpenAI 兼容模型的问答 run——SSE 流映射成现有 text/thinking-delta 事件，
 *  iOS 端 turn 组装与 Cursor run 完全同一条链路。无工具，不产生 edited/checkpoint。 */
async function runExternalChat(
  ws: WebSocket,
  slot: Slot,
  ext: { provider: ExternalProvider; model: string; full: string },
  input: {
    text: string;
    images: Array<{ data: string; mimeType: string }>;
    history: ChatHistoryItem[];
    epoch: number;
    cwd: string;
    assistantBlock?: string;
  },
) {
  const { epoch } = input;
  const t0 = Date.now();
  send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
  send(ws, {
    type: "run_meta",
    chatId: slot.chatId,
    model: ext.full,
    mode: "ask", // 第三方一律按问答对待（无工具），UI 不显示工具相关徽标
    policy: slot.policy,
    dialect: false,
  });
  if (input.images.length && !ext.provider.vision) {
    send(ws, {
      type: "error",
      chatId: slot.chatId,
      message: `${ext.provider.name} 这个模型不收图片（providers.json 里 vision: true 才放行）。`,
    });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
    return;
  }
  const rules = loadWorkspaceRules(input.cwd);
  const system = input.assistantBlock
    ? [
        input.assistantBlock,
        "当前模型没有工具，读不了也改不了工作区文件——只能根据对话和上面的记忆数据回答；需要动手时请让用户换 Cursor 目录里的模型。",
        rules ? `工作区规则：\n${rules}` : "",
        "回答用中文（除非用户用别的语言提问），代码块标语言。",
      ]
        .filter(Boolean)
        .join("\n\n")
    : [
        "你是「接驳」客户端里的问答助手。你没有工具，读不了也改不了工作区文件——只能根据对话内容回答。",
        `用户的工作区路径：${input.cwd}。`,
        rules ? `工作区规则：\n${rules}` : "",
        "回答用中文（除非用户用别的语言提问），代码块标语言。",
      ].filter(Boolean).join("\n");
  const abort = new AbortController();
  slot.externalAbort = abort;
  try {
    await streamChatCompletions({
      provider: ext.provider,
      model: ext.model,
      system,
      history: input.history,
      text: input.text,
      images: input.images,
      signal: abort.signal,
      onText: (delta) => {
        send(ws, { type: "text-delta", chatId: slot.chatId, text: delta });
        noteOutput(slot.tenantId, delta.length); // P9 计量：与 Cursor run 同口径
      },
      onThinking: (delta) => {
        send(ws, { type: "thinking-delta", chatId: slot.chatId, text: delta });
        noteOutput(slot.tenantId, delta.length);
      },
    });
    finishRun(ws, slot, "completed", Date.now() - t0, epoch);
  } catch (err) {
    if (isAbortError(err)) {
      finishRun(ws, slot, "cancelled", Date.now() - t0, epoch);
    } else {
      send(ws, {
        type: "error",
        chatId: slot.chatId,
        message: err instanceof Error ? err.message : "第三方模型调用失败",
      });
      finishRun(ws, slot, "error", Date.now() - t0, epoch);
    }
  } finally {
    if (slot.externalAbort === abort) slot.externalAbort = null;
  }
}

function recordRunCheckpoint(ws: WebSocket, conn: Conn, slot: Slot, cwd: string, mode: AgentMode) {
  try {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const kind = mode === "plan" ? "Plan" : "Agent";
    let label = `${kind} · ${stamp}`;
    if (slot.checkpoints.some((item) => item.label === label)) {
      label = `${kind} · ${stamp} · ${slot.checkpoints.length + 1}`;
    }
    const checkpoint = createCheckpoint(cwd, label);
    slot.checkpoints.unshift(checkpoint);
    slot.checkpoints = slot.checkpoints.slice(0, 10);
    sendCheckpoints(ws, slot);
    persistConn(conn);
  } catch (err) {
    send(ws, {
      type: "status",
      chatId: slot.chatId,
      status: "RUNNING",
      message: `检查点没记下：${err instanceof Error ? err.message : "未知错误"}`,
    });
  }
}

const NATIVE_RESULT_PREVIEW = 4000;

function lastUserMessageIndex(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

/** 自研 Agent 的一轮：工具调用循环跑在网关里，事件映射成与 Cursor run 相同的协议，
 *  审批、检查点、撤销、计量都复用现有机制。 */
async function runNativeChat(
  ws: WebSocket,
  conn: Conn,
  slot: Slot,
  ext: { provider: ExternalProvider; model: string; full: string },
  input: {
    prompt: string;
    /** 用户原文：存进会话、与客户端 history 对齐。prompt 是加了规则和约束的包装版，只用于本轮 */
    userText: string;
    images: Array<{ data: string; mimeType: string }>;
    history: ChatHistoryItem[];
    epoch: number;
    cwd: string;
    mode: AgentMode;
    confirmWrites: boolean;
    autoApprove: boolean;
    /** USER 根目录：个人助理人设 + 记忆块，放进 system，不与 wrapPrompt 重复 */
    assistantBlock?: string;
  },
) {
  const { epoch, cwd, mode } = input;
  const atAssistant = isAssistantChat(conn.tenant, slot.chatId);
  const rootAssistantName = atAssistant && conn.tenant ? assistantName(conn.tenant) : undefined;
  const t0 = Date.now();
  send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
  send(ws, { type: "run_meta", chatId: slot.chatId, model: ext.full, mode, policy: slot.policy, dialect: slot.dialect });
  if (input.images.length && !ext.provider.vision) {
    send(ws, {
      type: "error",
      chatId: slot.chatId,
      message: `${ext.provider.name} 这个模型不收图片（providers.json 里 vision: true 才放行）。`,
    });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
    return;
  }
  if (!input.autoApprove && (mode === "agent" || mode === "plan")) recordRunCheckpoint(ws, conn, slot, cwd, mode);

  const sandbox = sandboxEnabledForTenant(conn.tenant);
  const extraTools = !sandbox || findBwrap() ? [shellTool({ sandbox, masks: [stateDir()] })] : [];
  const stateDirOf = nativeStateDir(conn, slot);
  // 从这里起登记 abort：连 MCP 期间点停止也能立即退出
  const abort = new AbortController();
  slot.externalAbort = abort;
  // 沙箱租户不拉起本机进程，只用 HTTP 类 MCP 服务
  const mcp = await mcpTools([...new Set([stateDir(), stateDirOf].filter((dir): dir is string => Boolean(dir)))], {
    allowStdio: !sandbox,
    signal: abort.signal,
  });
  if (mcp.errors.length) console.error("mcp", mcp.errors.join(" | "));
  if (abort.signal.aborted || slot.epoch !== epoch || slot.finished) {
    if (slot.externalAbort === abort) slot.externalAbort = null;
    return;
  }
  const endpoint = endpointFor(ext.provider, ext.model);
  const adapter = adapterFor(endpoint.adapter);
  let approvedAll = input.autoApprove;
  const live = () => slot.epoch === epoch && !slot.finished;
  const subagentRole = (args: Record<string, unknown>) =>
    args.subagent_type === "builder" && mode === "agent" ? "builder" : "explore";
  const nativeVet = (spec: ToolSpec, args: Record<string, unknown>) => {
    if (spec.category !== "shell") return null;
    if (workspaceFenceForTenant(conn.tenant) && toolEscapesWorkspace(cwd, spec.name, args)) {
      return "命令的工作目录或输出重定向超出了当前工作区，已拦截。";
    }
    if (shellPublishes(spec.name, args)) {
      const root = conn.tenant?.workspaceRoot;
      if (!root || !isUserWorkspace(cwd, root)) return "对外网站只能在 USER 工作区里创建，这个会话不能执行 jiebo-publish。";
    }
    return null;
  };
  const nativeNeedsApproval = (spec: ToolSpec, args: Record<string, unknown>) => {
    if (mode !== "agent" || approvedAll || !input.confirmWrites) return false;
    if (spec.category === "shell") {
      if (isReadOnlyCommand(typeof args.command === "string" ? args.command : "")) return false;
    } else if (spec.category !== "write" && spec.category !== "mcp") return false;
    if (isPlane(slot.policy) && slot.approvedKeys.has(toolFingerprint(spec.name, args))) return false;
    return true;
  };
  const nativeApprove = async (
    call: { id: string; name: string },
    args: Record<string, unknown>,
    _spec: ToolSpec,
    parentCallId?: string,
  ) => {
    slot.awaitingApproval = true;
    slot.approvalCallId = call.id;
    slot.runStats.approvals += 1;
    const parentMeta = parentCallId ? slot.openTools.get(parentCallId) : undefined;
    send(ws, {
      type: "approval",
      chatId: slot.chatId,
      callId: call.id,
      name: call.name,
      args: summarizeToolArgs(args),
      parentCallId,
      agent: parentMeta?.agent,
    });
    const allowed = await waitForApproval(slot);
    if (allowed) {
      rememberApproved(slot);
      if (!isPlane(slot.policy)) approvedAll = true;
    }
    slot.awaitingApproval = false;
    slot.approvalCallId = null;
    return allowed;
  };
  const nativeTurn = (turn: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }) => {
    const used = turn.usage;
    if (used) noteModelTokens(slot.tenantId, used.inputTokens ?? 0, used.outputTokens ?? 0, used.cacheReadTokens ?? 0);
  };
  const nativeToolCompleted = (
    call: { id: string; name: string },
    result: { ok: boolean; content: string; changed?: string[] },
    spec: ToolSpec | undefined,
    parentCallId?: string,
    agent?: string,
  ) => {
    if (!live()) return;
    if (slot.openTools.delete(call.id)) noteToolCall(slot.tenantId);
    const preview =
      result.content.length > NATIVE_RESULT_PREVIEW ? `${result.content.slice(0, NATIVE_RESULT_PREVIEW)}…` : result.content;
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId: call.id,
      name: call.name,
      status: result.ok ? "completed" : "error",
      result: preview,
      parentCallId,
      agent,
    });
    if (result.changed?.length) pushWorkspace(ws, slot, conn, result.changed);
    else if (spec?.category === "shell") pushWorkspace(ws, slot, conn);
  };
  const baseTools = toolsForMode(mode, [...extraTools, ...mcp.tools]);
  const compactor = makeCompactor({
    budgetChars: budgetFor(),
    summarize: modelSummarizer(adapter, endpoint, nativeTurn),
    onCompact: (info) => {
      if (!live()) return;
      console.log(`native compact chat=${slot.chatId} stage=${info.stage} ${info.before}→${info.after} summarized=${info.summarized}`);
    },
  });
  const assistantSpecs =
    atAssistant && conn.tenant ? assistantToolSpecs(chatToolHost(conn.tenant, slot.chatId)) : [];
  const taskSpec = taskTool({
    adapter,
    endpoint,
    modelLabel: ext.full,
    tools: [...baseTools, ...assistantSpecs],
    allowBuilder: mode === "agent",
    compact: compactor,
    hooks: {
      needsApproval: nativeNeedsApproval,
      vet: nativeVet,
      turn: nativeTurn,
      approve: nativeApprove,
      toolStarted: (call, args, spec, parentId, role) => {
        if (!live()) return;
        send(ws, {
          type: "tool-started",
          chatId: slot.chatId,
          callId: call.id,
          name: call.name,
          args,
          parentCallId: parentId,
          agent: role,
        });
        slot.openTools.set(call.id, { name: call.name, args, parentCallId: parentId, agent: role });
        slot.runStats.toolStarts += 1;
        if (spec?.category === "write") rememberEdit(slot, call.name, args, cwd);
      },
      toolCompleted: (call, result, spec, parentId) => {
        nativeToolCompleted(call, result, spec, parentId, slot.openTools.get(parentId)?.agent);
      },
    },
  });
  const tools = toolsForMode(mode, [...extraTools, ...mcp.tools, ...assistantSpecs, taskSpec]);
  const prior = resumeMessages(stateDirOf ? loadSession(stateDirOf, slot.chatId) : null, input.history);
  const notes = prior.notes.length ? `${prior.notes.join("\n")}\n\n` : "";
  const systemCore = buildSystemPrompt({ cwd, mode, tools, modelLabel: ext.full, assistantName: rootAssistantName });
  const systemContent = input.assistantBlock ? `${input.assistantBlock}\n\n${systemCore}` : systemCore;
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...prior.messages,
    { role: "user", content: notes + input.prompt, images: input.images.length ? input.images : undefined },
  ];
  const userKeys = [...prior.userKeys, sessionKey(input.userText)];
  const persist = (result: { messages: ChatMessage[] }, errored = false) => {
    if (!stateDirOf) return;
    const saved = result.messages.slice();
    const userIndex = lastUserMessageIndex(saved);
    const current = userIndex >= 0 ? saved[userIndex] : undefined;
    if (current?.role === "user") {
      saved[userIndex] = { ...current, content: notes + (input.userText || "（附图）") };
    }
    try {
      // iOS 上行 history 时跳过出错的轮次，key 也不记，否则下一轮对不上存档
      saveSession(stateDirOf, slot.chatId, { model: ext.full, userKeys: errored ? prior.userKeys : userKeys, messages: saved });
    } catch (err) {
      console.error("native session save", err instanceof Error ? err.message : err);
    }
  };

  try {
    const result = await runNativeLoop({
      adapter,
      endpoint,
      messages,
      tools,
      cwd,
      signal: abort.signal,
      hooks: {
        compact: compactor,
        text: (delta) => {
          if (!live()) return;
          send(ws, { type: "text-delta", chatId: slot.chatId, text: delta });
          noteOutput(slot.tenantId, delta.length);
        },
        thinking: (delta) => {
          if (!live()) return;
          send(ws, { type: "thinking-delta", chatId: slot.chatId, text: delta });
          noteOutput(slot.tenantId, delta.length);
        },
        toolStarted: (call, args, spec) => {
          if (!live()) return;
          const agent = call.name === "task" ? subagentRole(args) : undefined;
          send(ws, {
            type: "tool-started",
            chatId: slot.chatId,
            callId: call.id,
            name: call.name,
            args,
            agent,
          });
          slot.openTools.set(call.id, { name: call.name, args, agent });
          slot.runStats.toolStarts += 1;
          if (spec?.category === "write") rememberEdit(slot, call.name, args, cwd);
        },
        toolCompleted: (call, result, spec) => {
          const meta = slot.openTools.get(call.id);
          nativeToolCompleted(call, result, spec, meta?.parentCallId, meta?.agent);
        },
        toolOutput: (call, chunk) => {
          // 客户端收不过来时丢弃实时输出，最终结果里仍有头尾
          if (!live() || ws.bufferedAmount > 4 * 1024 * 1024) return;
          const stream = chunk.stderr != null ? "stderr" : "stdout";
          send(ws, { type: "tool-output", chatId: slot.chatId, callId: call.id, stream, chunk: chunk.stderr ?? chunk.stdout ?? "" });
        },
        turn: nativeTurn,
        retrying: (attempt, waitMs, reason) => {
          if (!live()) return;
          send(ws, {
            type: "status",
            chatId: slot.chatId,
            status: "RUNNING",
            message: `模型接口暂时不可用（${reason.slice(0, 80)}），${Math.ceil(waitMs / 1000)} 秒后第 ${attempt} 次重试`,
          });
        },
        vet: nativeVet,
        needsApproval: nativeNeedsApproval,
        approve: (call, args, spec) => nativeApprove(call, args, spec),
      },
    });

    // 用户点停止时 slot 已 finished，但同一 epoch 的半截对话仍要存；denied 的还原提示由 rollbackToLatestCheckpoint 随后追加
    // 出错前已经执行过的工具调用也要存，否则下一轮模型不知道文件已被改过
    if (slot.epoch === epoch) {
      if (result.status !== "error") persist(result);
      else {
        const lastUser = lastUserMessageIndex(result.messages);
        if (lastUser >= 0 && result.messages.length > lastUser + 1) persist(result, true);
      }
    }
    if (!live()) return;
    if (result.status === "denied") {
      rollbackToLatestCheckpoint(ws, slot, conn, true);
      send(ws, { type: "status", chatId: slot.chatId, status: "CANCELLED", message: "已拒绝写入，已还原到发送前。" });
      send(ws, { type: "text-delta", chatId: slot.chatId, text: "\n\n已拒绝写入，已还原到发送前。" });
      finishRun(ws, slot, "cancelled", Date.now() - t0, epoch);
      return;
    }
    if (result.status === "max_steps") {
      send(ws, { type: "text-delta", chatId: slot.chatId, text: `\n\n已达到单轮 ${result.steps} 步上限，先停在这里。回复「继续」接着做。` });
    }
    if (result.status === "error") {
      send(ws, { type: "error", chatId: slot.chatId, message: result.error || `${ext.provider.name} 调用失败` });
      finishRun(ws, slot, "error", Date.now() - t0, epoch);
      return;
    }
    finishRun(ws, slot, result.status === "cancelled" ? "cancelled" : "completed", Date.now() - t0, epoch);
  } catch (err) {
    if (!live()) return;
    send(ws, { type: "error", chatId: slot.chatId, message: err instanceof Error ? err.message : "自研 Agent 出错" });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
  } finally {
    if (slot.externalAbort === abort) slot.externalAbort = null;
    if (slot.approvalCallId && !slot.awaitingApproval) slot.approvalCallId = null;
  }
}

async function titleChat(ws: WebSocket, tenant: Tenant, chatId: string, text: string) {
  if (!chatId || namedChats.has(chatId) || namingChats.has(chatId)) return;
  const apiKey = process.env.CURSOR_API_KEY?.trim() || "";
  if (!apiKey) return;
  namingChats.add(chatId);
  const titleT0 = Date.now();
  try {
    const scratch = resolve(tenant.stateDir, "title-scratch");
    mkdirSync(scratch, { recursive: true });
    const result = await Agent.prompt(
      `用户第一条指令：\n${(text || "（附图）").trim().slice(0, 2000)}`,
      {
        apiKey,
        model: { id: DEFAULT_MODEL },
        local: { cwd: scratch, settingSources: [] },
        tools: [],
        systemPrompt:
          "你给这次对话起一个短标题。只输出标题本身，不要引号、句号或解释。中文优先，最多 16 个字，概括用户想做什么。",
      },
    );
    const title = sanitizeChatTitle(result.result || "");
    if (!title || title === "新对话") return;
    namedChats.add(chatId);
    noteOutput(tenant.id, title.length); // 标题输出也走同一 API key
    send(ws, { type: "chat_title", chatId, title });
  } catch (err) {
    console.error("titleChat", err instanceof Error ? err.message : err);
  } finally {
    namingChats.delete(chatId);
    noteRun(tenant.id, Date.now() - titleT0); // 起标题是一次真实 agent 调用（Kimi R1 M3），成败都计
  }
}

function clipReviewError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "评审失败";
  return raw.replace(/cursor_[A-Za-z0-9_-]+/g, "cursor_…").slice(0, 300);
}

function reviewsForLead(rows: Array<{ name: string; modelId: string; ok: boolean; text: string }>): string {
  if (!rows.length) return "";
  const body = rows
    .map((row) => `## ${row.name}（${row.modelId}）\n${row.ok ? row.text : `这次没评成：${row.text}`}`)
    .join("\n\n");
  return [
    "",
    "网关已经用不同模型分别评审过上面的内容。你只汇总一致结论、分歧和必须先改的点。",
    "不要再派 reviewer 或 review-* 重复评审，也不要说你又调用了这些模型。",
    body,
  ].join("\n");
}

async function runReviewPanel(
  ws: WebSocket,
  conn: Conn,
  slot: Slot,
  panel: ReviewBinding[],
  userText: string,
  cwd: string,
  apiKey: string,
  epoch: number,
): Promise<string> {
  const sandbox = sandboxEnabledForTenant(conn.tenant);
  const source = userText.length > 24_000 ? `${userText.slice(0, 24_000)}\n…（原文过长，已截断）` : userText;
  send(ws, {
    type: "text-delta",
    chatId: slot.chatId,
    text: `正在用 ${panel.map((row) => row.modelId).join("、")} 分别评审。\n\n`,
  });
  const jobs = panel.map(async (row) => {
    const callId = crypto.randomUUID();
    if (slot.finished || slot.epoch !== epoch) return null;
    const args = { subagent_type: row.name, description: `${row.modelId} 评审` };
    if (!slot.openTools) slot.openTools = new Map();
    slot.openTools.set(callId, { name: "task", args, agent: "reviewer", model: row.modelId });
    slot.runStats.toolStarts += 1;
    send(ws, {
      type: "tool-started",
      chatId: slot.chatId,
      callId,
      name: "task",
      args,
      agent: "reviewer",
      model: row.modelId,
    });
    const started = Date.now();
    const finish = (status: "completed" | "error", result: string) => {
      slot.openTools?.delete(callId);
      if (slot.epoch !== epoch) return;
      noteToolCall(slot.tenantId);
      if (status === "completed") noteOutput(slot.tenantId, result.length);
      noteRun(slot.tenantId, Date.now() - started);
      send(ws, {
        type: "tool-completed",
        chatId: slot.chatId,
        callId,
        name: "task",
        status,
        result,
        agent: "reviewer",
        model: row.modelId,
      });
    };
    try {
      const result = await Promise.race([
        Agent.prompt(
          [
            `你是独立评审，绑定模型 ${row.modelId}。只评审，不要改文件，不要派子代理。`,
            workspaceConfinePrompt(cwd),
            "对照仓库里的相关代码。列出具体问题，按 CRITICAL / MAJOR / MINOR。没有问题的部分直接说可行。用中文。",
            "",
            "要评审的内容：",
            source,
          ].join("\n"),
          {
            apiKey,
            model: { id: row.modelId },
            local: { cwd, sandboxOptions: { enabled: sandbox } },
            disallowedTools: ["edit", "delete", "shell", "task", "mcp", "applyAgentDiff", "generateImage"],
          },
        ),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("评审超时")), 4 * 60_000);
        }),
      ]);
      if (slot.finished || slot.epoch !== epoch) return null;
      const text = (result.result || "").trim() || result.error?.message || "没有返回正文";
      const ok = result.status === "finished" && Boolean(result.result?.trim());
      finish(ok ? "completed" : "error", text);
      return { name: row.name, modelId: row.modelId, ok, text };
    } catch (err) {
      if (slot.finished || slot.epoch !== epoch) return null;
      const text = clipReviewError(err);
      finish("error", text);
      return { name: row.name, modelId: row.modelId, ok: false, text };
    }
  });
  const rows = (await Promise.all(jobs)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  return reviewsForLead(rows);
}

async function handlePrompt(
  ws: WebSocket,
  conn: Conn,
  slot: Slot,
  text: string,
  model?: string,
  mode: AgentMode = "agent",
  files?: string[],
  images?: Array<{ data: string; mimeType: string }>,
  confirmWrites = false,
  autoApprove = false,
  fresh = false,
  policy?: PolicyId,
  dialect?: boolean,
  history?: ChatHistoryItem[],
  enqueue = true,
  turnId?: string,
  keepTranscript = false,
): Promise<void | "busy"> {
  const nextPolicy = parsePolicy(policy ?? slot.policy ?? conn.policy);
  const nextDialect = dialect !== false;
  // P11：history 白名单——只放行 user/assistant 的字符串文本，
  // 防客户端注入 system/tool 角色覆盖网关系统约束（Grok 评审 M5）
  const safeHistory = (history ?? []).filter(
    (h): h is ChatHistoryItem =>
      !!h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string",
  );
  if (fresh) {
    resolveApprovalWait(slot, false);
    await cancelRun(slot.run);
    slot.epoch += 1;
    await disposeSlot(slot);
    const nativeDir = nativeStateDir(conn, slot);
    if (nativeDir) deleteSession(nativeDir, slot.chatId);
    slot.agentId = null;
    slot.run = null;
    slot.finished = true;
    slot.edited = [];
    slot.checkpoints = [];
    slot.awaitingApproval = false;
    slot.lastShellCallId = null;
    slot.pending = [];
    slot.openTools.clear();
  }
  if (slot.run || slot.externalAbort || !slot.finished) {
    if (!enqueue) return "busy";
    slot.pending.push({
      text,
      model,
      mode,
      files,
      images,
      confirmWrites,
      autoApprove,
      policy: nextPolicy,
      dialect: nextDialect,
      history: safeHistory,
      turnId,
    });
    if (slot.pending.length > 8) slot.pending.shift();
    send(ws, { type: "status", chatId: slot.chatId, status: "QUEUED" });
    return;
  }

  if (globalRunningCount() >= maxRunning()) {
    if (!enqueue) return "busy";
    slot.pending.push({
      text,
      model,
      mode,
      files,
      images,
      confirmWrites,
      autoApprove,
      policy: nextPolicy,
      dialect: nextDialect,
      history: safeHistory,
      turnId,
    });
    if (slot.pending.length > 8) slot.pending.shift();
    send(ws, { type: "status", chatId: slot.chatId, status: "QUEUED", message: "同时跑的任务已满，排队中" });
    return;
  }

  const safeImages = sanitizeImages(images);
  const cwd = cwdOf(conn, slot);
  const userText = text.trim() || (safeImages.length ? "请看附图。" : "");
  const usedModel = (model && model.trim()) || slot.model || conn.model;
  if (slot.policy !== nextPolicy || slot.dialect !== nextDialect) {
    await disposeSlot(slot);
    slot.agentId = null;
    slot.reseed = true;
  }
  slot.policy = nextPolicy;
  conn.policy = nextPolicy;
  slot.dialect = nextDialect;
  slot.model = usedModel;
  slot.mode = mode;
  conn.model = usedModel;
  const externalEarly = externalRoute(usedModel);
  if (!externalEarly) await syncReviewRoster(conn, slot, usedModel);
  const atUserRoot = Boolean(conn.tenant && isUserWorkspace(cwd, conn.tenant.workspaceRoot));
  let assistantBlock = "";
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) {
    try {
      assistantBlock = userRootPreamble(conn.tenant);
    } catch (err) {
      console.error("assistant preamble", err);
    }
  }
  let prompt = wrapPrompt(
    userText,
    mode,
    files,
    loadWorkspaceRules(cwd),
    cwd,
    slot.reviewRoster || [],
    atUserRoot,
    workspaceFenceForTenant(conn.tenant),
  );
  const extra = nextDialect ? dialectOverlay(usedModel) : "";
  if (extra) prompt = `${prompt}\n\n${extra}`;
  // Cursor SDK 路径：人设进 user 包装；第三方自研 Agent 路径改由 runNativeChat 写进 system
  if (assistantBlock && !externalEarly) {
    prompt = `${assistantBlock}\n\n${prompt}`;
  }
  if (!prompt) return;

  const epoch = ++slot.epoch;
  if (keepTranscript && slot.transcript) continueTranscript(slot, epoch);
  else openTranscript(slot, turnId, userText, epoch);
  slot.finished = false;
  slot.edited = [];
  slot.awaitingApproval = false;
  slot.approvalWait = null;
  slot.approvalSettled = null;
  slot.lastShellCallId = null;
  slot.approvalCallId = null;
  slot.openTools = new Map();
  if (autoApprove) slot.runStats.replays += 1;
  else slot.runStats = { toolStarts: 0, intercepts: 0, approvals: 0, replays: 0 };

  // P11：第三方模型（"minimax:MiniMax-M2" 等）默认走自研 Agent；providers.json 里 tools: false 的退回纯问答。
  // 历史由客户端随 prompt 上行（iOS 是会话内容权威源）
  const external = externalEarly;
  if (external && external.provider.tools) {
    await runNativeChat(ws, conn, slot, external, {
      prompt,
      userText: text.trim(),
      images: safeImages,
      history: safeHistory,
      epoch: slot.epoch,
      cwd,
      mode,
      confirmWrites,
      autoApprove,
      assistantBlock: externalEarly ? assistantBlock || undefined : undefined,
    });
    drainPending(ws, conn, slot, epoch);
    return;
  }
  if (external) {
    if (wantsMultiModelReview(userText) && !autoApprove && !keepTranscript) {
      send(ws, {
        type: "text-delta",
        chatId: slot.chatId,
        text: "当前模型是第三方纯问答，不能分别调用目录里的其他模型。下面只由这一个模型回答。\n\n",
      });
    }
    await runExternalChat(ws, slot, external, {
      text: userText,
      images: safeImages,
      history: safeHistory,
      epoch: slot.epoch,
      cwd,
      assistantBlock: assistantBlock || undefined,
    });
    // 与 cursor 路径同一 drain 口径——否则排队消息永久滞留、超上限被静默丢弃（Kimi 评审 C1）；
    // epoch 守卫挡 fresh/new_session 后返回的过期栈（Grok R2）
    drainPending(ws, conn, slot, epoch);
    return;
  }

  let replayApproved = false;

  if (!autoApprove && (mode === "agent" || mode === "plan")) recordRunCheckpoint(ws, conn, slot, cwd, mode);

  let run: RunHandle | null = null;
  let blockedAsk = false;
  const blockedCalls = new Set<string>();
  const startedCalls = new Set<string>();
  const crewMeta = new Map<
    string,
    { agent?: string; model?: string; parentCallId?: string }
  >();

  const metaFor = (
    callId: string,
    name: string,
    args: unknown,
    parentCallId?: string,
  ) => {
    const parent = parentCallId ? crewMeta.get(parentCallId) : undefined;
    const agent = crewRoleOf(name, args) || parent?.agent;
    const model =
      resolveCrewModel(name, args, slot.reviewRoster) ||
      (crewAgentToken(name, args) ? undefined : parent?.model);
    const row = {
      agent,
      model,
      parentCallId: parentCallId || undefined,
    };
    crewMeta.set(callId, row);
    return row;
  };

  const blockOffRootPublish = (name: string, args: unknown, callId: string) => {
    if (!shellPublishes(name, args)) return false;
    const root = conn.tenant?.workspaceRoot;
    if (root && isUserWorkspace(cwd, root)) return false;
    if (blockedCalls.has(callId)) return true;
    blockedCalls.add(callId);
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name,
      status: "error",
      result: "对外网站只能在 USER 工作区里创建。",
    });
    send(ws, {
      type: "text-delta",
      chatId: slot.chatId,
      text: "\n\n对外网站只能在 USER 工作区里创建。换到那个会话再做。",
    });
    if (run) void cancelRun(run);
    return true;
  };

  const blockReadonlyWrite = (name: string, args: unknown, callId: string) => {
    if ((mode !== "ask" && mode !== "plan") || (!isMutatingTool(name, args) && !shellPublishes(name, args))) return false;
    if (blockedCalls.has(callId)) return true;
    blockedAsk = true;
    blockedCalls.add(callId);
    slot.runStats.intercepts += 1;
    const reason =
      mode === "plan"
        ? "Plan 模式只出方案，点「执行这个计划」才会改文件。"
        : "Ask 模式已拦截写操作";
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name,
      status: "error",
      result: reason,
    });
    send(ws, {
      type: "text-delta",
      chatId: slot.chatId,
      text:
        mode === "plan"
          ? "\n\nPlan 不会改文件。要动手请点这条回复下的「执行这个计划」。"
          : "\n\nAsk 模式不会改文件或跑会改系统的命令。这次写操作已拦截。",
    });
    if (run) void cancelRun(run);
    return true;
  };

  const blockUnapprovedWrite = (name: string, args: unknown, callId: string) => {
    if (mode !== "agent" && mode !== "plan") return false;
    if (!confirmWrites || autoApprove) return false;
    if (!isMutatingTool(name, args)) return false;
    if (isPlane(slot.policy) && slot.approvedKeys.has(toolFingerprint(name, args))) return false;
    rememberEdit(slot, name, args, cwd);
    if (slot.awaitingApproval) return true;
    slot.awaitingApproval = true;
    slot.approvalCallId = callId;
    slot.runStats.approvals += 1;
    const meta = crewMeta.get(callId);
    send(ws, {
      type: "approval",
      chatId: slot.chatId,
      callId,
      name,
      args: summarizeToolArgs(args),
      parentCallId: meta?.parentCallId,
      agent: meta?.agent,
      model: meta?.model,
    });
    if (run) void cancelRun(run);
    return true;
  };

  const blockOutsideWorkspace = (name: string, args: unknown, callId: string) => {
    if (!workspaceFenceForTenant(conn.tenant)) return false;
    const shell = /(shell|bash|terminal|command)/i.test(name);
    if (!isMutatingTool(name, args) && !shell) return false;
    if (!toolEscapesWorkspace(cwd, name, args)) return false;
    if (blockedCalls.has(callId)) return true;
    blockedCalls.add(callId);
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name,
      status: "error",
      result: "只能改当前工作区里的文件",
    });
    send(ws, {
      type: "text-delta",
      chatId: slot.chatId,
      text: "\n\n这次写操作超出当前工作区，已拦截。",
    });
    if (run) void cancelRun(run);
    return true;
  };

  const blockCrew = (name: string, args: unknown, callId: string) => {
    if (!isCrewToolName(name) && !isCrewRole(crewRoleOf(name, args))) return false;
    const role = crewRoleOf(name, args);
    let reason = "";
    if (mode === "ask") reason = "Ask 模式不会派子代理。";
    else if (mode === "plan" && role === "builder") {
      reason = "Plan 模式不会派 builder 改代码。";
    }
    if (!reason) return false;
    if (blockedCalls.has(callId)) return true;
    blockedAsk = true;
    blockedCalls.add(callId);
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name,
      status: "error",
      result: reason,
    });
    send(ws, {
      type: "text-delta",
      chatId: slot.chatId,
      text: `\n\n${reason}`,
    });
    if (run) void cancelRun(run);
    return true;
  };

  const blockExploreWrite = (
    name: string,
    args: unknown,
    callId: string,
    parentCallId?: string,
  ) => {
    const agent =
      crewRoleOf(name, args) ||
      (parentCallId ? crewMeta.get(parentCallId)?.agent : undefined) ||
      crewMeta.get(callId)?.agent;
    if (agent !== "explore" || !isMutatingTool(name, args)) return false;
    if (blockedCalls.has(callId)) return true;
    blockedAsk = true;
    blockedCalls.add(callId);
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name,
      status: "error",
      result: "explore 只读，已拦截写操作",
    });
    send(ws, {
      type: "text-delta",
      chatId: slot.chatId,
      text: "\n\nexplore 只读，这次写操作已拦截。",
    });
    if (run) void cancelRun(run);
    return true;
  };

  const startTool = (
    callId: string,
    name: string,
    args: unknown,
    parentCallId?: string,
  ) => {
    if (startedCalls.has(callId)) return;
    const parent = parentCallId || crewMeta.get(callId)?.parentCallId;
    const meta = metaFor(callId, name, args, parent);
    send(ws, {
      type: "tool-started",
      chatId: slot.chatId,
      callId,
      name,
      args: presentToolArgs(name, args),
      parentCallId: meta.parentCallId,
      agent: meta.agent,
      model: meta.model,
    });
    startedCalls.add(callId);
    slot.runStats.toolStarts += 1;
    if (!slot.openTools) slot.openTools = new Map();
    slot.openTools.set(callId, {
      name,
      args,
      parentCallId: meta.parentCallId,
      agent: meta.agent,
      model: meta.model,
    });
    if (
      !blockCrew(name, args, callId) &&
      !blockExploreWrite(name, args, callId, meta.parentCallId) &&
      !blockOffRootPublish(name, args, callId) &&
      !blockReadonlyWrite(name, args, callId) &&
      !blockUnapprovedWrite(name, args, callId) &&
      !blockOutsideWorkspace(name, args, callId)
    ) {
      rememberEdit(slot, name, args, cwd);
    }
    rememberShellCall(slot, name, callId);
  };

  const finishTool = (
    callId: string,
    name: string,
    status: "completed" | "error",
    result: unknown,
    args?: unknown,
  ) => {
    if (blockedCalls.has(callId)) return;
    // P9 计量：onDelta 与 run.stream() 两通道都会 finishTool 同一 callId——
    // openTools.delete 只有首次返回 true，凭它保证一次调用只计一次
    const wasOpen = slot.openTools?.delete(callId) === true;
    if (wasOpen) noteToolCall(slot.tenantId);
    const meta = crewMeta.get(callId);
    send(ws, {
      type: "tool-completed",
      chatId: slot.chatId,
      callId,
      name,
      status,
      result,
      parentCallId: meta?.parentCallId,
      agent: meta?.agent,
      model: meta?.model,
    });
    if (!slot.awaitingApproval && status !== "error" && isMutatingTool(name, args)) {
      const raw = pathFromTool(args);
      const rel = raw ? workspacePath(cwd, raw) || raw : "";
      pushWorkspace(ws, slot, conn, rel ? [rel] : slot.edited);
    }
  };

  try {
    if (wantsMultiModelReview(userText) && !autoApprove && !keepTranscript) {
      const panel = slot.reviewRoster || [];
      const apiKey = process.env.CURSOR_API_KEY?.trim();
      if (panel.length < 2) {
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: "目录里除了当前模型，没有足够的其他模型可以并行评审。\n\n",
        });
        prompt +=
          "\n\n目录里除了当前模型，没有足够的其他模型可以并行评审。直接告诉用户，不要用同一个模型假装多家。";
      } else if (apiKey) {
        prompt += await runReviewPanel(ws, conn, slot, panel, userText, cwd, apiKey, epoch);
        if (slot.finished || slot.epoch !== epoch) return;
      }
    }
    if (isAssistantChat(conn.tenant, slot.chatId) && (slot.agent || slot.agentId)) {
      const turns = diskChatTurns(conn.tenant, slot.chatId).length;
      if (turns > 0 && turns % ASSISTANT_ROLL_TURNS === 0 && assistantRolledAt.get(slot) !== turns) {
        assistantRolledAt.set(slot, turns);
        if (slot.agent) await disposeSlot(slot);
        slot.agentId = null;
        slot.reseed = true;
      }
    }
    const agent = await ensureAgent(conn, slot);
    if (slot.reseed) {
      prompt = attachReseedContext(conn.tenant, slot.chatId, userText, prompt);
      slot.reseed = false;
    }
    const payload = safeImages.length ? { text: prompt, images: safeImages } : prompt;
    slot.agentId = agent.agentId;
    send(ws, { type: "session", chatId: slot.chatId, agentId: agent.agentId, cwd });
    send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
    send(ws, {
      type: "run_meta",
      chatId: slot.chatId,
      model: usedModel,
      mode,
      policy: slot.policy,
      dialect: slot.dialect,
    });

    const sendOpts: {
      model: { id: string };
      mode: "plan" | "agent";
      local: { force: boolean };
      disallowedTools?: string[];
    } = {
      model: { id: usedModel },
      mode: mode === "plan" ? "plan" : "agent",
      local: { force: true },
    };
    if (isPlane(slot.policy) && mode === "ask") sendOpts.disallowedTools = askDisallowedTools();
    if (isPlane(slot.policy) && mode === "plan") sendOpts.disallowedTools = planDisallowedTools();

    const runWatch: {
      turnEnded: boolean;
      quiet?: ReturnType<typeof setTimeout>;
      stop?: () => void;
    } = { turnEnded: false };
    const clearRunQuiet = () => {
      if (!runWatch.quiet) return;
      clearTimeout(runWatch.quiet);
      runWatch.quiet = undefined;
    };
    // 模型这一轮已经结束、又没有新输出时，stream 有时不再关闭，前端会一直停在「正在动手」。
    const noteRunActivity = (continuing: boolean) => {
      if (continuing) {
        runWatch.turnEnded = false;
        clearRunQuiet();
        return;
      }
      if (!runWatch.turnEnded) return;
      clearRunQuiet();
      runWatch.quiet = setTimeout(() => runWatch.stop?.(), 8_000);
    };
    const onDelta = ({ update }: { update: unknown }) => {
        const rec = update as {
          type?: string;
          callId?: string;
          text?: string;
          toolCall?: {
            name?: string;
            type?: string;
            args?: unknown;
            result?: unknown;
            status?: string;
          };
          event?: Record<string, unknown>;
          taskUpdate?: {
            type?: string;
            callId?: string;
            toolCall?: {
              name?: string;
              type?: string;
              args?: unknown;
              result?: unknown;
              status?: string;
            };
            event?: Record<string, unknown>;
          };
        };
        const toolName = (tool?: { name?: string; type?: string }) =>
          tool?.name || tool?.type || "tool";
        switch (rec.type) {
          case "text-delta":
            noteRunActivity(true);
            if (rec.text) {
              send(ws, { type: "text-delta", chatId: slot.chatId, text: rec.text });
              noteOutput(slot.tenantId, rec.text.length); // P9 计量：模型输出
            }
            break;
          case "thinking-delta":
            noteRunActivity(true);
            if (rec.text) {
              send(ws, { type: "thinking-delta", chatId: slot.chatId, text: rec.text });
              noteOutput(slot.tenantId, rec.text.length); // P9 计量：thinking 也烧 token
            }
            break;
          case "tool-call-started":
            noteRunActivity(true);
            startTool(rec.callId || "", toolName(rec.toolCall), rec.toolCall?.args);
            break;
          case "turn-ended":
            runWatch.turnEnded = true;
            noteRunActivity(false);
            break;
          case "shell-output-delta": {
            noteRunActivity(false);
            const parsed = parseShellDelta(rec.event || {});
            if (parsed) {
              emitToolOutput(ws, slot, {
                callId: parsed.callId,
                stream: parsed.stream,
                chunk: parsed.chunk,
              });
            }
            break;
          }
          case "tool-call-completed":
            noteRunActivity(false);
            finishTool(
              rec.callId || "",
              toolName(rec.toolCall),
              rec.toolCall?.status === "error" ? "error" : "completed",
              rec.toolCall?.result,
              rec.toolCall?.args,
            );
            break;
          case "tool-call-delta": {
            const nested = rec.taskUpdate;
            if (!nested) break;
            if (nested.type === "tool-call-started") {
              noteRunActivity(true);
              startTool(
                nested.callId || "",
                toolName(nested.toolCall),
                nested.toolCall?.args,
                rec.callId,
              );
            } else if (nested.type === "tool-call-completed") {
              noteRunActivity(false);
              finishTool(
                nested.callId || "",
                toolName(nested.toolCall),
                nested.toolCall?.status === "error" ? "error" : "completed",
                nested.toolCall?.result,
                nested.toolCall?.args,
              );
            } else if (nested.type === "shell-output-delta") {
              noteRunActivity(false);
              const parsed = parseShellDelta(nested.event || {});
              if (parsed) {
                emitToolOutput(ws, slot, {
                  callId: parsed.callId,
                  stream: parsed.stream,
                  chunk: parsed.chunk,
                });
              }
            }
            break;
          }
          default:
            break;
        }
      };

    const startSend = async (opts: typeof sendOpts) =>
      agent.send(payload, { ...opts, onDelta });
    try {
      run = await startSend(sendOpts);
    } catch (err) {
      if (!sendOpts.disallowedTools) throw err;
      console.error("disallowedTools rejected, retrying without them", err);
      const { disallowedTools: _drop, ...rest } = sendOpts;
      run = await startSend(rest);
    }

    if (slot.epoch !== epoch || slot.finished) {
      try {
        await cancelRun(run);
      } catch {
        // Stale run after cancel or a newer prompt.
      }
      return;
    }
    slot.run = run;
    if (blockedAsk) await cancelRun(run);
    if (slot.awaitingApproval && !autoApprove) {
      await cancelRun(run);
      const allowed = await waitForApproval(slot);
      if (slot.epoch !== epoch || slot.finished) return;
      rollbackToLatestCheckpoint(ws, slot, conn, true);
      if (!allowed) {
        send(ws, {
          type: "status",
          chatId: slot.chatId,
          status: "CANCELLED",
          message: "已拒绝写入，已还原到发送前。",
        });
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: "\n\n已拒绝写入，已还原到发送前。",
        });
        finishRun(ws, slot, "cancelled", undefined, epoch);
        return;
      }
      send(ws, {
        type: "text-delta",
        chatId: slot.chatId,
        text: "\n\n已允许写入，按确认后重新执行这一轮。",
      });
      rememberApproved(slot);
      replayApproved = true;
      slot.run = null;
      slot.finished = true;
      slot.awaitingApproval = false;
    }

    if (!replayApproved) {
    let streamStatus: string | undefined;
    const terminalStatus = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
    const iterator = run.stream()[Symbol.asyncIterator]();
    const stopped = new Promise<void>((resolve) => {
      runWatch.stop = resolve;
    });
    try {
    while (true) {
      const pending = iterator.next().then(
        (value) => ({ kind: "event" as const, value }),
        (err: unknown) => ({ kind: "error" as const, err }),
      );
      const next = await Promise.race([
        pending,
        stopped.then(() => ({ kind: "quiet" as const })),
      ]);
      if (next.kind === "quiet") {
        streamStatus = streamStatus || "FINISHED";
        send(ws, { type: "status", chatId: slot.chatId, status: streamStatus });
        break;
      }
      if (next.kind === "error") {
        if (!isAbortError(next.err)) throw next.err;
        break;
      }
      if (next.value.done) break;
      const event = next.value.value;
      if (event.type === "task" && event.text) {
        noteRunActivity(true);
        send(ws, { type: "task", chatId: slot.chatId, text: event.text });
      }
      if (event.type === "status") {
        send(ws, {
          type: "status",
          chatId: slot.chatId,
          status: event.status,
          message: event.message,
        });
        if (terminalStatus.has(event.status)) {
          streamStatus = event.status;
          break;
        }
      }
      if (event.type === "tool_call" && event.status === "running") {
        noteRunActivity(true);
        startTool(event.call_id, event.name, event.args);
        const snap = snapshotFromResult(event.result);
        if (snap.stdout || snap.stderr) {
          emitToolOutput(ws, slot, { callId: event.call_id, ...snap });
        }
      }
      if (
        event.type === "tool_call" &&
        (event.status === "completed" || event.status === "error")
      ) {
        noteRunActivity(false);
        finishTool(event.call_id, event.name, event.status, event.result, event.args);
      }
      if (slot.awaitingApproval && !autoApprove) break;
    }
    } catch (err) {
      if (!isAbortError(err)) throw err;
    } finally {
      clearRunQuiet();
      runWatch.stop = undefined;
      try {
        await iterator.return?.();
      } catch {
        // stream already closed
      }
    }

    if (slot.awaitingApproval && !autoApprove) {
      await cancelRun(run);
      const allowed = await waitForApproval(slot);
      if (slot.epoch !== epoch || slot.finished) return;
      rollbackToLatestCheckpoint(ws, slot, conn, true);
      if (!allowed) {
        send(ws, {
          type: "status",
          chatId: slot.chatId,
          status: "CANCELLED",
          message: "已拒绝写入，已还原到发送前。",
        });
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: "\n\n已拒绝写入，已还原到发送前。",
        });
        finishRun(ws, slot, "cancelled", undefined, epoch);
        return;
      }
      send(ws, {
        type: "text-delta",
        chatId: slot.chatId,
        text: "\n\n已允许写入，按确认后重新执行这一轮。",
      });
      rememberApproved(slot);
      replayApproved = true;
      slot.run = null;
      slot.finished = true;
      slot.awaitingApproval = false;
    }

    if (!replayApproved) {
    const normalizeRunStatus = (status?: string) => {
      const key = (status || "finished").toLowerCase();
      if (key === "expired") return "error";
      if (key === "canceled") return "cancelled";
      return key;
    };
    let result: { status: string; durationMs?: number } = {
      status: normalizeRunStatus(streamStatus),
    };
    try {
      const waited = await withTimeout(run.wait(), 8_000);
      result = { status: normalizeRunStatus(waited.status), durationMs: waited.durationMs };
    } catch (err) {
      const timedOut = err instanceof Error && err.message === "timeout";
      if (!timedOut && !isAbortError(err)) throw err;
      if (timedOut) await cancelRun(run);
      result = {
        status: slot.awaitingApproval ? "approval" : normalizeRunStatus(streamStatus),
      };
    }
    if (mode === "ask" && slot.edited.length) {
      const undone = undoEdits(cwd, slot.edited);
      slot.edited = [];
      if (undone.paths.length) {
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: `\n\nAsk 模式已还原误改：${undone.paths.join(", ")}`,
        });
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: undone.paths,
          error: undone.error,
        });
      }
    } else if (slot.edited.length) {
      pushWorkspace(ws, slot, conn, slot.edited);
    }
    finishRun(
      ws,
      slot,
      slot.awaitingApproval ? "approval" : result.status,
      result.durationMs,
      epoch,
    );
    }
    }
  } catch (err) {
    if (isAbortError(err) && (replayApproved || slot.awaitingApproval)) {
      // SDK abort after cancel is expected around confirm-write.
    } else {
      const messageText = err instanceof Error ? err.message : "gateway 出错了";
      send(ws, { type: "error", chatId: slot.chatId, message: messageText });
      finishRun(ws, slot, "error", undefined, epoch);
    }
  } finally {
    if (!replayApproved) {
      finishRun(
        ws,
        slot,
        slot.awaitingApproval ? "approval" : "cancelled",
        undefined,
        epoch,
      );
      drainPending(ws, conn, slot, epoch);
    }
  }
  if (replayApproved) {
    await handlePrompt(
      ws,
      conn,
      slot,
      text,
      usedModel,
      mode,
      files,
      images,
      confirmWrites,
      !isPlane(slot.policy),
      false,
      slot.policy,
      slot.dialect,
      undefined,
      true,
      slot.transcript?.turnId,
      true,
    );
  }
}

/** run 收尾后排空 pending：本 slot 有空位直接续跑下一条，否则让全局队列找空位（P11 抽取：cursor 与第三方路径同一口径）。
 *  epoch 守卫：过期栈（fresh/new_session 后返回的旧 run）不得碰 pending——
 *  否则 shift 掉新 run 的排队消息又调度失败 = 静默丢消息（Grok R2 MAJOR）。
 *  peek-then-shift：条件失败时消息留队首，等当前 run 收尾再排。 */
function drainPending(ws: WebSocket, conn: Conn, slot: Slot, epoch?: number) {
  // 失配 = 新栈已接管/slot 已重置：本栈不得碰 pending，但容量可能已释放
  // （new_session/fresh/delete），kick 一下让全局排队的其他 slot 补位（Grok R3 m1）
  if (epoch != null && slot.epoch !== epoch) {
    kickGlobalQueue();
    return;
  }
  const next = slot.pending[0];
  if (next && slot.finished && !slot.run && !slot.externalAbort) {
    slot.pending.shift();
    queueMicrotask(() => {
      void handlePrompt(
        ws,
        conn,
        slot,
        next.text,
        next.model,
        next.mode,
        next.files,
        next.images,
        next.confirmWrites,
        next.autoApprove,
        false,
        next.policy,
        next.dialect,
        next.history,
        true,
        next.turnId,
        false,
      );
    });
  } else if (!next) {
    kickGlobalQueue();
  }
}

function kickGlobalQueue() {
  if (globalRunningCount() >= maxRunning()) return;
  for (const tenant of allTenants()) {
    for (const slot of liveSlotsOf(tenant).values()) {
      if (!slot.pending.length || !slot.finished || slot.run || slot.externalAbort) continue;
      const owner = slot.owner;
      if (!owner || owner.readyState !== WebSocket.OPEN) continue;
      const ownerConn = conns.get(owner);
      if (!ownerConn?.tenant || ownerConn.tenant.id !== tenant.id) continue;
      const next = slot.pending.shift();
      if (!next) continue;
      queueMicrotask(() => {
        void handlePrompt(
          owner,
          ownerConn,
          slot,
          next.text,
          next.model,
          next.mode,
          next.files,
          next.images,
          next.confirmWrites,
          next.autoApprove,
          false,
          next.policy,
          next.dialect,
          next.history,
          true,
          next.turnId,
          false,
        );
      });
      return;
    }
  }
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
  res.setHeader(
    "access-control-allow-headers",
    requested || "authorization, content-type",
  );
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-max-age", "86400");
  res.setHeader("vary", "origin");
}

function parseMultipartUpload(buf: Buffer, contentType: string): {
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
    const filename =
      /filename="([^"]*)"/i.exec(headers)?.[1] ||
      /filename\*=(?:UTF-8'')?([^;\s]+)/i.exec(headers)?.[1];
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

async function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL) {
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
        console.warn("upload multipart empty", name, raw.length);
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
    console.warn("upload unauthorized", req.method, name);
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
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "没法在工作区里放下这个文件" }));
    return;
  }
  const written = writeWorkspaceBytes(cwd, rel, buf);
  if (written.error) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: written.error, path: written.path }));
    return;
  }
  console.log("upload", written.path, written.size);
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({ path: written.path, size: written.size, name }),
  );
}

function handleMedia(req: IncomingMessage, res: ServerResponse, url: URL) {
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
function handleState(req: IncomingMessage, res: ServerResponse) {
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

function cwdWritable(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function healthPayload() {
  const tenants = allTenants();
  const cwdOk = tenants.length ? tenants.every((item) => cwdWritable(item.workspaceRoot)) : false;
  const stateOk = tenants.length ? tenants.every((item) => cwdWritable(item.stateDir)) : false;
  const ready = Boolean(hasAuth() && process.env.CURSOR_API_KEY?.trim() && cwdOk && stateOk);
  return {
    ok: ready,
    tenants: tenants.map((item) => item.id),
    cwdWritable: cwdOk,
    stateWritable: stateOk,
    hasApiKey: Boolean(process.env.CURSOR_API_KEY?.trim()),
    hasAuth: hasAuth(),
    host: HOST,
  };
}

const httpServer = createServer((req, res) => {
  if (publish.handleHttp(req, res)) return;
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    const body = healthPayload();
    res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/media") {
    try {
      handleMedia(req, res, url);
    } catch (err) {
      console.error("media", err instanceof Error ? err.message : err);
      if (!res.headersSent) res.writeHead(500).end("media failed");
      else res.destroy();
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/state") {
    handleState(req, res);
    return;
  }
  if (url.pathname === "/upload") {
    void handleUpload(req, res, url).catch((err) => {
      console.error("upload", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "上传失败" }));
      }
    });
    return;
  }
  if (!PROXY_WEB) {
    res.writeHead(404).end("not found");
    return;
  }
  proxyWeb(req, res);
});

// perMessageDeflate：WS 帧压缩（JSON 文本 10-20x），浏览器/ws 自动协商；
// 不支持扩展的客户端（iOS URLSessionWebSocketTask 不协商扩展）会优雅回落为不压缩。
// 注意：ws 的 threshold 只在关闭 context takeover 时生效； takeover 还会让每连接常驻 zlib 窗口，一并关掉。
const wss = new WebSocketServer({
  noServer: true,
  // 单条会话会带上完整工具记录。cursorremote 一条对话已经超过 40MB，16MB 上限会把网关打崩。
  maxPayload: 96 * 1024 * 1024,
  perMessageDeflate: {
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024,
  },
});

httpServer.on("upgrade", (req, socket, head) => {
  if (publish.handleUpgrade(req, socket, head)) return;
  if (agentSocketPath(req.url)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }
  if (!PROXY_WEB) {
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head);
});

wss.on("connection", (ws, req: IncomingMessage) => {
  const conn: Conn = {
    cwd: "",
    model: DEFAULT_MODEL,
    authed: false,
    ip: peerIp(req),
    tenant: null,
    slots: new Map(),
    ws,
    maxMessageBytes: 0,
    caps: new Set(),
    policy: defaultPolicy(),
  };
  conns.set(ws, conn);

  ws.on("error", (err) => {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
    console.error("ws error", code || (err instanceof Error ? err.message : err));
  });

  ws.on("message", async (data) => {
    const message = parseClient(String(data));
    if (!message) return;

    try {
      if (message.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (message.type === "hello") {
        if (loginBlocked(conn.ip)) {
          send(ws, { type: "auth", ok: false, message: "试太多次了，过几分钟再试。" });
          return;
        }
        if (!hasAuth()) {
          send(ws, {
            type: "auth",
            ok: false,
            message: "还没设登录密码。写入 tenants.json 或 CURSOR_REMOTE_TOKEN 后重启 gateway。",
          });
          return;
        }
        const tenant = resolveTenant(message.token || "");
        if (!tenant) {
          noteLoginFail(conn.ip);
          send(ws, { type: "auth", ok: false, message: "密码不对。" });
          return;
        }
        noteLoginOk(conn.ip);
        if (conn.authed) detachConn(conn);
        // 客户端声明的单条消息接收上限（iOS URLSessionWebSocketTask 约 1MiB）；0 = 不限
        const declared = Number(message.client?.maxMessageBytes) || 0;
        conn.maxMessageBytes = declared > 0 ? Math.min(declared, 8 * 1024 * 1024) : 0;
        conn.caps = new Set(
          Array.isArray(message.client?.caps)
            ? message.client.caps.filter((item): item is string => typeof item === "string")
            : [],
        );
        bindTenant(conn, tenant);
        usageRec(tenant.id); // P9：建行 + touch lastActiveAt（登录即活动）
        const apiKey = process.env.CURSOR_API_KEY?.trim() || "";
        hydrateConn(conn);
        attachLiveSlots(conn);
        const cached = modelsCache?.ids?.length ? modelsCache.ids : [DEFAULT_MODEL];
        const emitReady = (models: string[]) => {
          send(ws, {
            type: "ready",
            cwd: conn.cwd,
            hasApiKey: Boolean(apiKey),
            model: conn.model,
            models: [...models, ...externalModelIds()], // P11：第三方模型（provider:model）合并下发
            agentId: null,
            runningChatIds: runningChatIds(tenant),
            queuedChatIds: queuedChatIds(tenant),
            workspaceRoot: resolve(tenant.workspaceRoot),
            tenantId: tenant.id,
            tenantName: tenant.name,
            admin: tenant.admin,
            policy: conn.policy || defaultPolicy(),
            loops: loopsForTenant(tenant.id),
            assistantName: assistantName(tenant),
            assistantChatId: assistantChatIdOf(tenant),
          });
        };
        try {
          ensureAssistantChat(tenant);
          onTenantHello(tenant);
        } catch (err) {
          console.error("assistant hello", err);
        }
        emitReady(cached);
        emitStoredState(ws, tenant);
        emitWorkspaces(ws, tenant);
        for (const chatId of runningChatIds(tenant)) {
          send(ws, { type: "status", chatId, status: "RUNNING" });
        }
        for (const slot of conn.slots.values()) {
          if (slot.checkpoints.length) sendCheckpoints(ws, slot);
        }
        emitRunSnapshots(ws, tenant);
        if (apiKey) {
          void listModels(apiKey).then((models) => {
            if (models.join("\n") !== cached.join("\n")) emitReady(models);
          });
        }
        return;
      }

      if (!conn.authed || !conn.tenant) {
        send(ws, { type: "error", message: "先发 hello。" });
        return;
      }
      const tenant = conn.tenant;

      if (message.type === "assistant_get") {
        if (message.memory) watchMemory(tenant.id, true);
        send(ws, { type: "assistant_state", state: await buildState(tenant, { memory: Boolean(message.memory) }) });
        return;
      }

      if (message.type === "assistant_op") {
        const args = message.args && typeof message.args === "object" ? message.args : {};
        const result = message.op === "approval_answer" ? answerDelegationApproval(tenant, args) : await handleOp(tenant, message.op, args);
        send(ws, { type: "assistant_result", reqId: message.reqId, op: message.op, ...result });
        if (result.ok) void publishState(tenant);
        return;
      }

      if (message.type === "loop_start") {
        const result = startLoop({
          tenantId: tenant.id,
          chatId: message.chatId,
          goal: message.goal,
          intervalSec: message.intervalSec,
          maxTicks: message.maxTicks,
          model: message.model,
          mode: message.mode,
        });
        if ("error" in result) {
          send(ws, { type: "error", chatId: message.chatId, message: result.error });
          return;
        }
        publishLoop(tenant.id, { type: "loop_state", ...result.state });
        return;
      }

      if (message.type === "loop_stop") {
        const state = stopLoop(tenant.id, message.chatId);
        publishLoop(tenant.id, {
          type: "loop_state",
          chatId: message.chatId,
          status: "stopped",
          goal: state?.goal ?? "",
          intervalSec: state?.intervalSec ?? 0,
          tick: state?.tick ?? 0,
          maxTicks: state?.maxTicks,
          lastSummary: state?.lastSummary ?? "没有在跑的 Loop。",
        });
        return;
      }

      // P9：管理员查询全租户使用统计。租户行是网关自计量；
      // cursor 是当前 CURSOR_API_KEY 的官方账单（与 CLI /usage 同一接口）。
      if (message.type === "admin_stats") {
        if (!tenant.admin) {
          send(ws, { type: "error", message: "需要管理员权限。" });
          return;
        }
        const rows = allTenants().map((item) => {
          const usage = usageSnapshot(item.id);
          const online = [...conns.values()].filter(
            (other) => other.authed && other.tenant?.id === item.id,
          ).length;
          return {
            id: item.id,
            name: item.name,
            admin: item.admin,
            online,
            chats: item.disk.chats.length,
            turns: usage.turns,
            runs: usage.runs,
            toolCalls: usage.toolCalls,
            runMs: usage.runMs,
            inChars: usage.inChars,
            outChars: usage.outChars,
            estTokens: Math.round((usage.inChars + usage.outChars) / 4),
            modelInTokens: usage.modelInTokens,
            modelOutTokens: usage.modelOutTokens,
            modelCacheTokens: usage.modelCacheTokens,
            firstSeenAt: usage.firstSeenAt,
            lastActiveAt: usage.lastActiveAt,
          };
        });
        const cursor = await cursorBill(process.env.CURSOR_API_KEY?.trim() || "");
        send(ws, { type: "admin_stats", serverTime: Date.now(), tenants: rows, cursor });
        return;
      }

      if (message.type === "sync_state") {
        const clientRev = typeof message.rev === "number" ? message.rev : 0;
        if (clientRev < tenant.disk.rev) {
          emitStateSync(ws, tenant);
          return;
        }
        const prevCwd = new Map<string, string>();
        const prevJson = new Map<string, string>();
        const prevIds = chatIdsFrom(tenant.disk.chats);
        for (const item of tenant.disk.chats) {
          if (!item || typeof item !== "object") continue;
          const row = item as { id?: unknown; cwd?: unknown };
          if (typeof row.id === "string" && row.id) {
            if (typeof row.cwd === "string" && row.cwd) prevCwd.set(row.id, row.cwd);
            prevJson.set(row.id, stableStringify(item));
          }
        }
        // 助理会话不占 MAX_STORED_CHATS 名额；客户端漏带时用服务端那份，不能被墓碑化
        const assistantId = assistantChatIdOf(tenant);
        const uploaded: unknown[] = Array.isArray(message.chats) ? message.chats : [];
        const assistantRow =
          uploaded.find((item) => chatIdOf(item) === assistantId) ??
          tenant.disk.chats.find((item) => chatIdOf(item) === assistantId);
        const incoming = uploaded.filter((item) => chatIdOf(item) !== assistantId).slice(0, MAX_STORED_CHATS);
        if (assistantRow) incoming.unshift(assistantRow);
        const incomingIds = chatIdsFrom(incoming);
        for (const id of prevIds) {
          if (!incomingIds.has(id)) tombstoneChat(tenant, id);
        }
        const gone = new Set(tenant.disk.deletedIds);
        tenant.disk.chats = incoming
          .filter((item) => {
            const id = chatIdOf(item);
            return !id || !gone.has(id);
          })
          .map((item) => {
            if (!item || typeof item !== "object") return item;
            const row = item as { id?: unknown; cwd?: unknown };
            const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
            const id = typeof row.id === "string" ? row.id : "";
            const next = isAssistantChat(tenant, id)
              ? assistantCwd(tenant)
              : wanted || (id ? confinedCwd(prevCwd.get(id), tenant.workspaceRoot) : null) || tenant.workspaceRoot;
            const withCwd = row.cwd === next ? item : { ...row, cwd: next };
            const provided = Boolean(item && typeof item === "object" && Array.isArray((item as { turns?: unknown }).turns));
            return protectChatUpload(tenant, id, withCwd, provided);
          });
        tenant.disk.rev = clientRev;
        // P4c：按会话变更检测（规范化序列化，键序无关），只给真正变了的会话记新版本号
        for (const item of tenant.disk.chats) {
          const id = chatIdOf(item);
          if (!id) continue;
          if (prevJson.get(id) !== stableStringify(item)) {
            tenant.disk.chatRevs[id] = clientRev;
          }
        }
        pruneChatRevs(tenant);
        pruneDroppedSlots(tenant, chatIdsFrom(tenant.disk.chats));
        persistConn(conn);
        send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: effectiveChatRevs(tenant) });
        broadcastDigest(tenant, ws); // 多设备实时对账
        return;
      }

      // P4b：单会话增量上传——只替换/追加这一条，不做 tombstone（结构变化仍走 sync_state）
      if (message.type === "sync_chat") {
        const clientRev = typeof message.rev === "number" ? message.rev : 0;
        if (clientRev < tenant.disk.rev) {
          emitStateSync(ws, tenant);
          return;
        }
        const id = chatIdOf(message.chat);
        if (!id) return;
        if (tenant.disk.deletedIds.includes(id)) {
          // 已删除的会话不接受内容更新；ack 带上该 id 让客户端收敛 inflight（空表会泄漏）
          send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
          return;
        }
        const prev = tenant.disk.chats.find((item) => chatIdOf(item) === id);
        // cwd 限定：与 sync_state 同一套（新值优先，其次旧值，最后租户根）
        let next = message.chat;
        if (next && typeof next === "object") {
          const row = next as { cwd?: unknown };
          const prevRow = prev && typeof prev === "object" ? (prev as { cwd?: unknown }) : {};
          const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
          const fallback = typeof prevRow.cwd === "string" ? confinedCwd(prevRow.cwd, tenant.workspaceRoot) : null;
          const cwd = isAssistantChat(tenant, id) ? assistantCwd(tenant) : wanted || fallback || tenant.workspaceRoot;
          if (row.cwd !== cwd) next = { ...next, cwd };
        }
        // P8 slim 合并：incoming 没有 turns 键 = 元数据更新，保留服务端 turns
        //（键缺失 ≠ 清空，空数组才是清空；web 永远带 turns 走全量替换，不受影响）。
        // incoming 带 turns 时，clipped 标记的 turn 是 load_chat 分页的截断展示副本——
        // 按 id 回退服务端完整版，截断内容不允许回写落盘
        if (next && typeof next === "object") {
          const row = next as Record<string, unknown>;
          const prevTurns = prev && typeof prev === "object" ? (prev as { turns?: unknown }).turns : undefined;
          if (Array.isArray(prevTurns)) {
            if (!("turns" in row)) {
              next = { ...row, turns: prevTurns };
            } else if (Array.isArray(row.turns)) {
              const fullById = new Map(
                prevTurns.map((t) => [t && typeof t === "object" ? (t as { id?: unknown }).id : null, t]),
              );
              next = {
                ...row,
                turns: row.turns.flatMap((t) => {
                  if (!t || typeof t !== "object" || (t as { clipped?: unknown }).clipped !== true) return [t];
                  // 残片按 id 回退服务端完整版；id 对不上（服务端没有）则丢弃——
                  // 保留残片会把截断占位内容永久落盘（GLM 评审 M1）
                  const full = fullById.get((t as { id?: unknown }).id);
                  return full ? [full] : [];
                }),
              };
            }
          } else if (!("turns" in row)) {
            // 新会话且缺 turns 键：补空数组——磁盘 chat 永远带 turns 键，
            // web 端 chat.turns.map 不踩空（Kimi 设计评审 MINOR10）
            next = { ...row, turns: [] };
          }
        }
        const turnsProvided = Boolean(
          message.chat &&
            typeof message.chat === "object" &&
            Array.isArray((message.chat as { turns?: unknown }).turns),
        );
        next = protectChatUpload(tenant, id, next, turnsProvided);
        const changed = stableStringify(prev ?? null) !== stableStringify(next);
        const stored = tenant.disk.chats.filter((item) => !isAssistantChat(tenant, chatIdOf(item))).length;
        if (changed && !prev && !isAssistantChat(tenant, id) && stored >= MAX_STORED_CHATS) {
          // 条数硬顶：追加新会话被拒（替换既有会话不受限），回 ack 让客户端收敛 inflight
          console.warn("sync_chat 拒绝：会话数超上限", tenant.id, MAX_STORED_CHATS);
          send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
          return;
        }
        // 先写 rev 再落盘（P4 审核：崩溃窗口不能出现「新内容旧 rev」）；幂等重推也落盘，
        // 否则 rev 只在内存里，重启后对账分叉。
        // chatRevs[id] 只在内容真变时前进（P8 审核：无变化 sync 也 bump 的话，其他端重连时
        // 会把纯元数据/未读类本地脏误判成正文变更，整会话作废重载）
        tenant.disk.rev = clientRev;
        if (changed) {
          tenant.disk.chatRevs[id] = clientRev;
          tenant.disk.chats = prev
            ? tenant.disk.chats.map((item) => (chatIdOf(item) === id ? next : item))
            : [...tenant.disk.chats, next];
        }
        persistConn(conn);
        // ack 回报服务端真实 chatRev（无变化时不前进），客户端对账口径与 digest 一致
        send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: tenant.disk.chatRevs[id] ?? clientRev } });
        if (changed) broadcastDigest(tenant, ws); // 多设备实时对账
        return;
      }

      // P4c：stored_digest 后按需拉取单个会话全量
      if (message.type === "load_chats") {
        const ids = (Array.isArray(message.ids) ? message.ids : [])
          .filter((item): item is string => typeof item === "string" && Boolean(item))
          .slice(0, 200); // 上限防滥用；正常分叉差异只有几条
        const gone = new Set(tenant.disk.deletedIds);
        const connNow = conns.get(ws);
        const limit = connNow?.maxMessageBytes ?? 0;
        // 注意：load_chats 对 slim 客户端也回全量——它只服务 digest 差异对账（通常单会话），
        // 是跨设备 turns 更新的唯一通道；slim 只作用于 stored_state 启动全量
        for (const id of ids) {
          if (gone.has(id)) continue;
          const chat = tenant.disk.chats.find((item) => chatIdOf(item) === id);
          if (!chat) continue;
          const payload = { type: "stored_chat" as const, chat, rev: tenant.disk.chatRevs[id] ?? 0 };
          // 单条同样过接收上限护栏：超限回落 deferred，客户端走 HTTP /state 全量
          if (limit > 0 && Buffer.byteLength(JSON.stringify(payload)) > limit) {
            send(ws, { type: "stored_state_deferred", rev: tenant.disk.rev });
            continue;
          }
          send(ws, payload);
        }
        return;
      }

      // P8：slim 客户端的会话内容分页——from 省略=最后一页，否则返回 turns[..<from] 的上一页。
      // 条数（40）与字节（接收上限 80%）双上限：落盘 turns 没有 history 路径的 80KB clip，
      // 单条巨 turn 也能撑爆 WS 帧，必须按字节组页（评审 GLM m4 / Grok M5）
      if (message.type === "load_chat") {
        const id = typeof message.chatId === "string" ? message.chatId : "";
        // 分页代际 nonce 原样回显（Kimi R2 M1）：客户端降级/重启分页后靠它丢弃旧链迟到页
        const nonce =
          typeof message.nonce === "number" && Number.isFinite(message.nonce) ? message.nonce : undefined;
        const gone = tenant.disk.deletedIds.includes(id);
        const chat = id && !gone ? tenant.disk.chats.find((item) => chatIdOf(item) === id) : null;
        const all =
          chat && typeof chat === "object" && Array.isArray((chat as { turns?: unknown }).turns)
            ? (chat as { turns: unknown[] }).turns
            : [];
        const to =
          typeof message.from === "number" && Number.isFinite(message.from)
            ? Math.max(0, Math.min(Math.floor(message.from), all.length))
            : all.length;
        const declared = conn.maxMessageBytes;
        const budget = declared > 0 ? Math.floor(declared * 0.8) : 800 * 1024;
        const page: unknown[] = [];
        let bytes = 0;
        let from = to;
        while (from > 0 && page.length < 40) {
          let turn = all[from - 1];
          let size = Buffer.byteLength(JSON.stringify(turn));
          if (size > budget) {
            turn = clipTurnForPage(turn, budget);
            size = Buffer.byteLength(JSON.stringify(turn));
          }
          if (bytes + size > budget && page.length > 0) break;
          page.unshift(turn);
          bytes += size;
          from -= 1;
        }
        // 与 stored_state 同口径的 settle：非 live 会话的磁盘 running 残留（崩溃遗留）
        // 不能原样下发，否则 iOS 上永远转圈（Kimi 设计评审 MINOR6）
        const settledPage = runningChatIds(tenant).includes(id)
          ? page
          : (settlePersistedChats([{ turns: page }])[0] as { turns: unknown[] }).turns;
        send(ws, { type: "chat_turns", chatId: id, turns: settledPage, from, hasMore: from > 0, total: all.length, nonce });
        return;
      }

      if (message.type === "write_file") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const written = writeWorkspaceFile(cwd, message.path, message.content);
        send(ws, {
          type: "file_written",
          chatId: message.chatId,
          path: written.path,
          error: written.error,
        });
        return;
      }

      if (message.type === "upload_file") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const raw = typeof message.data === "string" ? message.data : "";
        const b64 = raw.replace(/^data:[^;]+;base64,/, "");
        const fail = (error: string) => {
          send(ws, {
            type: "file_uploaded",
            chatId: message.chatId,
            id: message.id,
            name: message.name,
            path: message.name || "",
            error,
          });
        };
        if (!b64) {
          fail("没有文件内容");
          return;
        }
        let buf: Buffer;
        try {
          buf = Buffer.from(b64, "base64");
        } catch {
          fail("文件解码失败");
          return;
        }
        if (!buf.length) {
          fail("空文件");
          return;
        }
        if (buf.length > MAX_UPLOAD_BYTES) {
          fail("文件超过 32MB");
          return;
        }
        const rel = uniqueUploadPath(cwd, message.name || "file");
        if (!rel) {
          fail("没法在工作区里放下这个文件");
          return;
        }
        const written = writeWorkspaceBytes(cwd, rel, buf);
        send(ws, {
          type: "file_uploaded",
          chatId: message.chatId,
          id: message.id,
          name: message.name,
          path: written.path,
          error: written.error,
          size: written.size,
        });
        if (!written.error && message.chatId) {
          pushWorkspace(ws, slotOf(conn, message.chatId), conn, [written.path]);
        }
        return;
      }

      if (message.type === "fs_op") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const result = runFsOp(cwd, message.op, message.path, message.to);
        send(ws, {
          type: "fs_done",
          chatId: message.chatId,
          op: message.op,
          path: result.path,
          to: result.to,
          error: result.error,
        });
        if (!result.error && message.chatId) {
          pushWorkspace(ws, slotOf(conn, message.chatId), conn, [result.to || result.path]);
        }
        return;
      }

      if (message.type === "list_files") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const listed = listWorkspaceFiles(cwd, message.query || "");
        send(ws, {
          type: "files",
          chatId: message.chatId,
          query: message.query || "",
          paths: listed.paths,
          status: listed.status,
          mention: Boolean(message.mention),
          truncated: listed.truncated,
        });
        return;
      }

      if (message.type === "search_text") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        send(ws, {
          type: "search_hits",
          chatId: message.chatId,
          query: message.query,
          hits: searchWorkspace(cwd, message.query),
        });
        return;
      }

      if (message.type === "set_workspace") {
        const next = confinedCwd(message.cwd || conn.cwd, tenant.workspaceRoot);
        if (!next) {
          send(ws, { type: "error", chatId: message.chatId, message: "工作区必须在允许的目录里。" });
          return;
        }
        try {
          ensureWorkspaceDir(next);
        } catch {
          send(ws, { type: "error", chatId: message.chatId, message: "建不了这个工作区目录。" });
          return;
        }
        if (message.chatId && isAssistantChat(tenant, message.chatId)) {
          send(ws, { type: "error", chatId: message.chatId, message: "助理会话固定在 USER 根目录，不能换工作区。" });
          return;
        }
        if (message.chatId) {
          const slot = slotOf(conn, message.chatId);
          if (next !== slot.cwd) {
            slot.cwd = next;
            await disposeSlot(slot);
            slot.agentId = null;
          }
          persistConn(conn);
          send(ws, {
            type: "session",
            chatId: slot.chatId,
            agentId: slot.agentId || "",
            cwd: slot.cwd,
          });
        } else {
          conn.cwd = next;
          send(ws, { type: "session", chatId: "", agentId: "", cwd: conn.cwd });
        }
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "list_workspaces") {
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "create_workspace") {
        const name = sanitizeWorkspaceName(message.name);
        if (!name) {
          send(ws, { type: "error", message: "工作区名字不合法。" });
          return;
        }
        const next = confinedCwd(resolve(tenant.workspaceRoot, name), tenant.workspaceRoot);
        if (!next) {
          send(ws, { type: "error", message: "工作区必须在允许的目录里。" });
          return;
        }
        try {
          if (existsSync(next) && !statSync(next).isDirectory()) {
            send(ws, { type: "error", message: "已经有同名文件。" });
            return;
          }
          ensureWorkspaceDir(next);
        } catch {
          send(ws, { type: "error", message: "建不了这个工作区目录。" });
          return;
        }
        send(ws, { type: "workspace_created", path: next, name });
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "resume_session") {
        const slot = slotOf(conn, message.chatId);
        const stored = slot.agentId || diskSlot(tenant, slot.chatId)?.agentId || "";
        if (message.agentId !== stored) {
          // 宽容化（P7 后）：agentId 陈旧不再报错「不能恢复别人的会话」——resume 只是状态重挂，
          // 客户端拿着旧 agentId（agent 被轮换/多端同步延迟/跨环境残留）需要的是纠正而非拒绝。
          // 回当前真实状态（stored 为空时 agentId:"" → 客户端清掉陈旧值自愈），会话照常可用。
          send(ws, { type: "session", chatId: slot.chatId, agentId: stored, cwd: cwdOf(conn, slot) });
          if (stored) {
            sendCheckpoints(ws, slot);
            void sendAgentHistory(ws, conn, slot);
          }
          return;
        }
        send(ws, {
          type: "session",
          chatId: slot.chatId,
          agentId: slot.agentId || "",
          cwd: cwdOf(conn, slot),
        });
        sendCheckpoints(ws, slot);
        void sendAgentHistory(ws, conn, slot);
        return;
      }

      if (message.type === "delete_session") {
        if (isAssistantChat(tenant, message.chatId)) {
          send(ws, { type: "error", chatId: message.chatId, message: "助理会话不能删除。" });
          emitStoredState(ws, tenant);
          return;
        }
        await forgetChat(conn, message.chatId);
        emitStoredState(ws, tenant);
        return;
      }

      if (message.type === "new_session") {
        const slot = slotOf(conn, message.chatId);
        resolveApprovalWait(slot, false);
        // 过期门+清队列提到 cancelRun 之前：cancel 让出期间旧栈若以旧 epoch 走完
        // finishRun/drain，会把 pending 推进 microtask 拦不住（Grok R3 m2，对齐 forgetChat）
        slot.epoch += 1;
        slot.pending = [];
        await cancelRun(slot.run);
        finishRun(ws, slot, "cancelled");
        await disposeSlot(slot);
        deleteSession(tenant.stateDir, slot.chatId);
        slot.agentId = null;
        slot.edited = [];
        slot.checkpoints = [];
        slot.openTools.clear();
        const next = isAssistantChat(tenant, slot.chatId)
          ? assistantCwd(tenant)
          : message.cwd
            ? confinedCwd(message.cwd, tenant.workspaceRoot)
            : null;
        if (next) {
          try {
            ensureWorkspaceDir(next);
            slot.cwd = next;
          } catch {
            send(ws, { type: "error", chatId: slot.chatId, message: "建不了这个工作区目录。" });
          }
        }
        persistConn(conn);
        send(ws, { type: "session", chatId: slot.chatId, agentId: "", cwd: cwdOf(conn, slot) });
        send(ws, { type: "status", chatId: slot.chatId, status: "IDLE" });
        sendCheckpoints(ws, slot);
        persistConn(conn);
        return;
      }

      if (message.type === "approval_reply") {
        const slot = slotOf(conn, message.chatId);
        // 迟到的回复（旧工具、已超时）不能批准当前正在等的另一项
        if (message.callId && slot.approvalCallId && message.callId !== slot.approvalCallId) return;
        resolveApprovalWait(slot, Boolean(message.allow));
        return;
      }

      if (message.type === "cancel") {
        const slot = slotOf(conn, message.chatId);
        resolveApprovalWait(slot, false);
        const alreadyDone = slot.finished;
        slot.externalAbort?.abort(); // P11：第三方在途请求（无 RunHandle，走 AbortController）
        await cancelRun(slot.run);
        finishRun(ws, slot, "cancelled");
        if (alreadyDone) {
          send(ws, { type: "done", chatId: slot.chatId, status: "cancelled" });
        }
        return;
      }

      if (message.type === "drop_queued") {
        const slot = slotOf(conn, message.chatId);
        const needle = (message.text || "").trim();
        if (!needle) slot.pending = [];
        else {
          const index = slot.pending.findIndex((item) => item.text.trim() === needle);
          if (index >= 0) slot.pending.splice(index, 1);
        }
        return;
      }

      if (message.type === "set_model") {
        const id = message.model.trim();
        if (id) {
          conn.model = id;
          if (message.chatId) slotOf(conn, message.chatId).model = id;
        }
        return;
      }

      if (message.type === "list_checkpoints") {
        sendCheckpoints(ws, slotOf(conn, message.chatId));
        return;
      }

      if (message.type === "read_file") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const file = message.diff
          ? readWorkspaceDiff(cwd, message.path)
          : readWorkspaceFile(cwd, message.path);
        reply(ws, payload(tenant, message.chatId, message.path, file, Boolean(message.diff)));
        return;
      }

      if (message.type === "revert_file") {
        const slot = slotOf(conn, message.chatId);
        if (slot.run || slot.externalAbort) {
          send(ws, {
            type: "error",
            chatId: slot.chatId,
            message: "Agent 还在跑，先停再还原。",
          });
          return;
        }
        const result = undoEdits(cwdOf(conn, slot), [message.path]);
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: result.paths,
          error: result.error,
        });
        if (result.paths.length) {
          const gone = new Set(result.paths);
          slot.edited = slot.edited.filter((item) => {
            const path = workspacePath(cwdOf(conn, slot), item);
            return !path || !gone.has(path);
          });
          pushWorkspace(ws, slot, conn, result.paths);
          noteNativeRestore(conn, slot, undefined, result.paths);
        }
        return;
      }

      if (message.type === "revert_hunk") {
        const slot = slotOf(conn, message.chatId);
        if (slot.run || slot.externalAbort) {
          send(ws, {
            type: "error",
            chatId: slot.chatId,
            message: "Agent 还在跑，先停再还原。",
          });
          return;
        }
        const result = revertHunk(cwdOf(conn, slot), message.path, message.hunk);
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: result.error ? [] : [result.path],
          error: result.error,
        });
        if (!result.error) {
          pushWorkspace(ws, slot, conn, [result.path]);
          noteNativeRestore(conn, slot, undefined, [result.path]);
        }
        return;
      }

      if (message.type === "undo" || message.type === "restore") {
        const slot = slotOf(conn, message.chatId);
        if (slot.run || slot.externalAbort) {
          send(ws, {
            type: "error",
            chatId: slot.chatId,
            message: "Agent 还在跑，先停再撤销。",
          });
          return;
        }
        const wanted =
          message.type === "restore"
            ? slot.checkpoints.find((item) => item.id === message.checkpointId)
            : slot.checkpoints[0];
        if (wanted) {
          const result = restoreCheckpoint(cwdOf(conn, slot), wanted, slot.edited);
          send(ws, {
            type: "restored",
            chatId: slot.chatId,
            checkpointId: wanted.id,
            label: wanted.label,
            error: result.error,
          });
          if (!result.error) {
            const preview = slot.edited.slice();
            slot.edited = [];
            pushWorkspace(ws, slot, conn, preview);
            noteNativeRestore(conn, slot, wanted.label);
          }
          persistConn(conn);
          return;
        }
        if (message.type === "restore") {
          send(ws, {
            type: "restored",
            chatId: slot.chatId,
            checkpointId: message.checkpointId,
            error: "找不到这个检查点",
          });
          return;
        }
        const result = undoEdits(cwdOf(conn, slot), slot.edited);
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: result.paths,
          error: result.error,
        });
        if (result.paths.length) {
          slot.edited = [];
          pushWorkspace(ws, slot, conn, result.paths);
          noteNativeRestore(conn, slot, undefined, result.paths);
        }
        return;
      }

      if (message.type === "set_policy") {
        const next = parsePolicy(message.policy, conn.policy);
        conn.policy = next;
        if (message.chatId) {
          const slot = slotOf(conn, message.chatId);
          if (slot.policy !== next) {
            slot.policy = next;
            slot.approvedKeys.clear();
            await disposeSlot(slot);
            slot.agentId = null;
            slot.reseed = true;
          }
        }
        send(ws, { type: "policy", policy: next, chatId: message.chatId });
        return;
      }

      if (message.type === "prompt") {
        const slot = slotOf(conn, message.chatId);
        // P9 计量：一条用户消息记一个 turn（排队也算——用户确实发了）；
        // 埋点在分发处而非 handlePrompt，pending 重放不会重复计数
        noteTurn(tenant.id, (message.text || "").length);
        await handlePrompt(
          ws,
          conn,
          slot,
          message.text,
          message.model,
          message.mode,
          message.files,
          message.images,
          Boolean(message.confirmWrites),
          Boolean(message.autoApprove),
          Boolean(message.fresh),
          parsePolicy(message.policy, conn.policy),
          message.dialect,
          message.history,
          true,
          message.turnId,
        );
        if (message.nameChat) void titleChat(ws, tenant, slot.chatId, message.text);
      }
    } catch (err) {
      const messageText =
        err instanceof CursorAgentError
          ? err.message
          : err instanceof Error
            ? err.message
            : "gateway 出错了";
      const chatId = "chatId" in message && message.chatId ? message.chatId : undefined;
      send(ws, { type: "error", chatId, message: messageText });
      if (chatId) {
        const slot = conn.slots.get(chatId);
        if (slot && !slot.finished) finishRun(ws, slot, "error");
      }
    }
  });

  ws.on("close", () => {
    if (conn.authed) persistConn(conn);
    for (const slot of conn.slots.values()) {
      if (slot.owner === ws) slot.owner = null;
    }
    conns.delete(ws);
  });
});

function openConn(tenantId: string): Conn | undefined {
  for (const conn of conns.values()) {
    if (conn.authed && conn.tenant?.id === tenantId && conn.ws.readyState === WebSocket.OPEN) return conn;
  }
  return undefined;
}

function loopBusy(tenantId: string, chatId: string): false | { reason: string; retryMs?: number } {
  const tenant = getTenant(tenantId);
  if (!tenant) return false;
  const slot = liveSlotsOf(tenant).get(chatId);
  if (slot?.awaitingApproval) {
    return { reason: "上一拍的写入还在等你批准，本拍顺延。", retryMs: 60_000 };
  }
  if (slot && (slot.pending.length > 0 || !slot.finished)) {
    return { reason: "会话还在跑，本拍顺延。" };
  }
  if (globalRunningCount() >= maxRunning()) return { reason: "同时跑的任务已满，本拍顺延。" };
  return false;
}

async function dispatchLoop(job: LoopJob) {
  const tenant = getTenant(job.tenantId);
  const previous = tenant ? liveSlotsOf(tenant).get(job.chatId) : undefined;
  const previousOwner = previous?.owner?.readyState === WebSocket.OPEN ? previous.owner : null;
  const ownerConn = previousOwner ? conns.get(previousOwner) : undefined;
  // 优先用会话当前 owner 的连接跑，免得工作区、事件去向和 owner 分属两台设备
  const conn = ownerConn?.authed && ownerConn.tenant?.id === job.tenantId ? ownerConn : openConn(job.tenantId);
  if (!conn) {
    if (!tenant) return { text: "", error: "offline" as const };
    // 没人在线：走后台策略（只读工具、grok-4.7），不再顺延等人上线
    const result = await runLoopInBackground(tenant, {
      chatId: job.chatId,
      cwd: cwdForChat(tenant, job.chatId),
      text: job.text,
      label: `Loop：${job.text.split("\n")[0].slice(0, 30)}`,
    });
    if (!result.ok) return { text: "", error: result.busy ? ("deferred" as const) : result.error };
    return { text: result.text };
  }
  const slot = slotOf(conn, job.chatId);
  if (previousOwner) slot.owner = previousOwner;
  let text = "";
  let error = "";
  let doneStatus = "";
  const prevText = slot.captureText;
  const prevErr = slot.captureError;
  const prevDone = slot.captureDone;
  slot.captureText = (chunk) => {
    text += chunk;
    prevText?.(chunk);
  };
  slot.captureError = (chunk) => {
    error = chunk;
    prevErr?.(chunk);
  };
  slot.captureDone = (status) => {
    doneStatus = status;
    prevDone?.(status);
  };
  let outcome: void | "busy" = undefined;
  try {
    outcome = await handlePrompt(
      conn.ws,
      conn,
      slot,
      job.text,
      job.model,
      job.mode ?? slot.mode ?? "agent",
      undefined,
      undefined,
      // Loop 无人盯着时也会到点开跑：写入一律要确认，不继承会话的自动批准
      true,
      false,
      false,
      slot.policy,
      slot.dialect,
      undefined,
      false,
    );
  } finally {
    slot.captureText = prevText;
    slot.captureError = prevErr;
    slot.captureDone = prevDone;
  }
  // 审批会原地等到批准、拒绝或超时；没批准时以 cancelled 收尾并已还原。这一拍算数，不然到点会反复弹审批
  if (doneStatus === "approval" || (doneStatus === "cancelled" && slot.runStats.approvals > 0)) {
    return { text, error: "approval" as const };
  }
  // 没开跑、被取消、或 epoch 失配没有 done：不当成一拍，也不留在 pending 里等 drain 再跑
  if (outcome === "busy" || !doneStatus || doneStatus === "cancelled") {
    return { text: "", error: "deferred" as const };
  }
  // Cursor 收尾是 finished，第三方是 completed。两条都算真正跑完的一拍
  if (doneStatus !== "completed" && doneStatus !== "finished") return { text, error: error || doneStatus };
  return { text };
}

function publishLoop(tenantId: string, message: ServerMessage) {
  for (const conn of conns.values()) {
    if (conn.authed && conn.tenant?.id === tenantId) reply(conn.ws, message);
  }
}

bindLoops({ busy: loopBusy, dispatch: dispatchLoop, publish: publishLoop });

function noteDelegationApproval(slot: Slot, callId: string, tool: string, args: unknown) {
  const tenant = getTenant(slot.tenantId);
  if (!tenant || !slot.delegationId) return;
  const record = updateDelegation(tenant, slot.delegationId, { status: "awaiting" });
  if (!record) return;
  const approval = addApproval(
    tenant,
    {
      chatId: slot.chatId,
      callId,
      tool,
      summary: summarizeArgs(args),
      delegationId: record.id,
      parentChatId: record.parentChatId,
    },
    Date.now(),
    slot.approvalTimeoutMs ?? APPROVAL_TTL_MS,
  );
  postInbox(tenant, {
    kind: "approval",
    title: `委派「${record.title}」要${tool === "shell" ? "跑命令" : "改文件"}，等你批准`,
    body: `${approval.summary ? `${tool}：${approval.summary}\n` : ""}在父会话、收件箱或子会话的工具卡上批准或拒绝。24 小时没人答就按拒绝处理。`,
    key: `approval:${slot.chatId}:${callId}`,
    chatId: record.parentChatId || slot.chatId,
    delegationId: record.id,
  });
  publishDelegation(tenant, record, approval);
}

/** 审批有了结果（批准、拒绝、取消）：摘掉挂起项，委派回到运行中，等运行自己收尾 */
function noteDelegationAnswered(slot: Slot) {
  const tenant = getTenant(slot.tenantId);
  if (!tenant || !slot.delegationId) return;
  settleApproval(tenant, slot.chatId);
  const current = getDelegation(tenant, slot.delegationId);
  if (current?.status !== "awaiting") return;
  const record = updateDelegation(tenant, slot.delegationId, { status: "running" });
  if (record) publishDelegation(tenant, record);
}

function noteDelegationExpired(slot: Slot) {
  const tenant = getTenant(slot.tenantId);
  if (!tenant || !slot.delegationId) return;
  const record = getDelegation(tenant, slot.delegationId);
  noteDelegationAnswered(slot);
  postInbox(tenant, {
    kind: "delegation",
    title: `委派「${record?.title ?? ""}」的审批超时`,
    body: "24 小时没人答，已按拒绝处理。子会话里可以重新交代。",
    key: `approval-expired:${slot.chatId}:${slot.approvalCallId ?? ""}`,
    chatId: slot.chatId,
    delegationId: slot.delegationId,
  });
}

/** 收件箱、父会话或任一设备作答委派子会话的挂起审批；不抢子会话的 owner */
function answerDelegationApproval(tenant: Tenant, args: Record<string, unknown>) {
  const chatId = typeof args.chatId === "string" ? args.chatId : "";
  const callId = typeof args.callId === "string" ? args.callId : "";
  if (!chatId || !callId || typeof args.allow !== "boolean") return { ok: false, error: "要带 chatId、callId 和 allow。" };
  const slot = liveSlotsOf(tenant).get(chatId);
  if (!slot || !slot.awaitingApproval || slot.approvalCallId !== callId) {
    // 落盘的挂起项还在、运行却没了：多半是网关重启后的残留，顺手清掉
    if (findApproval(tenant, chatId, callId)) settleApproval(tenant, chatId, callId);
    return { ok: false, error: "这项审批已经结束或过期了。" };
  }
  if (!slot.delegationId) return { ok: false, error: "只能在这里作答委派子会话的审批。" };
  resolveApprovalWait(slot, args.allow);
  return { ok: true };
}

function delegationWorkspaces(tenant: Tenant) {
  return listWorkspaceItems(tenant)
    .filter((item) => !item.user)
    .map((item) => item.name);
}

async function startDelegation(req: DelegateRequest): Promise<string> {
  const tenant = getTenant(req.tenant.id);
  if (!tenant) return JSON.stringify({ ok: false, error: "租户不存在" });
  const name = sanitizeWorkspaceName(req.workspace.replace(/^\.\//, ""));
  const root = resolve(tenant.workspaceRoot);
  const cwd = name ? confinedCwd(resolve(root, name), root) : null;
  if (!name || !cwd || cwd === root || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return JSON.stringify({ ok: false, error: `没有这个子工作区：${req.workspace}。可用：${delegationWorkspaces(tenant).join("、")}` });
  }
  const task = req.task.trim();
  if (!task) return JSON.stringify({ ok: false, error: "任务说明为空" });
  const busy = activeDelegationFor(tenant, name);
  if (busy) return JSON.stringify({ ok: false, error: `子工作区 ${name} 已有委派「${busy.title}」在跑，等它完成再交新的。` });
  const parent = req.parentChatId ? liveSlotsOf(tenant).get(req.parentChatId) : undefined;
  const ownerConn = parent?.owner?.readyState === WebSocket.OPEN ? conns.get(parent.owner) : undefined;
  const conn = req.background ? undefined : ownerConn?.authed ? ownerConn : openConn(tenant.id);
  const background = !conn;
  const title = (req.title || task.split("\n")[0]).slice(0, 30);
  const childChatId = crypto.randomUUID();
  const record = createDelegation(tenant, {
    parentChatId: req.parentChatId,
    childChatId,
    workspace: name,
    title,
    task,
    mode: background ? "background" : "foreground",
  });
  tenant.disk.chats = [
    ...tenant.disk.chats,
    { id: childChatId, title: `委派：${title}`, turns: [], cwd, parentChatId: req.parentChatId, delegationId: record.id },
  ];
  tenant.disk.rev += 1;
  tenant.disk.chatRevs[childChatId] = tenant.disk.rev;
  persistTenant(tenant);
  broadcastDigest(tenant, null as unknown as WebSocket);
  publishDelegation(tenant, record);

  const finish = (ok: boolean, text: string) => {
    settleApproval(tenant, childChatId);
    const done = updateDelegation(tenant, record.id, { status: ok ? "done" : "failed", result: text, endedAt: Date.now() });
    if (done) publishDelegation(tenant, done);
    postInbox(tenant, {
      kind: "delegation",
      title: `委派${ok ? "完成" : "失败"}：${title}`,
      body: text.slice(0, 3000) || "（没有输出）",
      key: `delegation:${record.id}`,
      chatId: childChatId,
      delegationId: record.id,
    });
  };

  if (background) {
    void runDelegateInBackground(tenant, { chatId: childChatId, cwd, task, label: `委派：${title}` }).then((result) =>
      finish(result.ok, result.ok ? result.text : result.error),
    );
    return JSON.stringify({ ok: true, id: record.id, childChatId, mode: "background", note: "后台委派只读，结果进收件箱。" });
  }

  const slot = slotOf(conn, childChatId);
  slot.cwd = cwd;
  slot.delegationId = record.id;
  slot.approvalTimeoutMs = APPROVAL_TTL_MS;
  let text = "";
  let error = "";
  const settled = new Promise<string>((resolveDone) => {
    slot.captureText = (chunk) => {
      text += chunk;
    };
    slot.captureError = (chunk) => {
      error = chunk;
    };
    slot.captureDone = (status) => {
      if (status === "approval") return;
      resolveDone(status);
    };
  });
  const prompt = [
    "这是从个人工作区委派来的任务。做完用三五句话汇报：做了什么、改了哪些文件、还有什么没做。",
    "",
    task,
  ].join("\n");
  void handlePrompt(conn.ws, conn, slot, prompt, undefined, "agent", undefined, undefined, true, false, false, slot.policy, slot.dialect);
  void settled.then((status) => {
    slot.captureText = undefined;
    slot.captureError = undefined;
    slot.captureDone = undefined;
    const ok = status === "completed" || status === "finished";
    finish(ok, ok ? text.trim() : error || `结束状态：${status}`);
  });
  return JSON.stringify({ ok: true, id: record.id, childChatId, mode: "foreground", note: "子会话已开工，写文件要你批准；完成后汇报到收件箱。" });
}

bindBackground({
  apiKey: () => process.env.CURSOR_API_KEY?.trim() || "",
  listModels,
  prompt: (message, options) => Agent.prompt(message, options),
  sandbox: (tenantId) => sandboxEnabledForTenant(getTenant(tenantId)),
});

startAssistant({
  tenants: () => allTenants(),
  publish: publishLoop,
  globalStateDir: stateDir(),
  delegate: startDelegation,
  workspaces: (tenant) => {
    const full = getTenant(tenant.id);
    return full ? delegationWorkspaces(full) : [];
  },
  appUrl: () => "./",
});

httpServer.listen(PORT, HOST, () => {
  publish.boot();
  const tenants = allTenants();
  for (const tenant of tenants) {
    mkdirSync(tenant.workspaceRoot, { recursive: true });
    mkdirSync(tenant.stateDir, { recursive: true });
  }
  console.log(`cursor-remote gateway  http://${HOST}:${PORT}`);
  if (tenants.length === 1) {
    console.log(`工作区                 ${tenants[0].workspaceRoot}`);
  } else {
    console.log(`租户                   ${tenants.map((item) => item.id).join(", ") || "(无)"}`);
  }
  console.log(`状态目录               ${stateDir()}`);
  if (PROXY_WEB) console.log(`本机网页               ${WEB_URL.origin}`);
  if (!process.env.CURSOR_API_KEY?.trim()) {
    console.warn("缺少 CURSOR_API_KEY：写入环境或 .env 后重启 gateway。");
  }
  if (!hasAuth()) {
    console.warn("缺少登录配置：写入 tenants.json 或 CURSOR_REMOTE_TOKEN 后重启 gateway。");
  }
});
