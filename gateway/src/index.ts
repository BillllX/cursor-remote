import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentMode, HistoryTurn, PolicyId, ServerMessage, TurnFile } from "../../shared/protocol.ts";
import { slimChat } from "./chatBodies.ts";
import {
  askDisallowedTools,
  defaultPolicy,
  isPlane,
  parsePolicy,
  planDisallowedTools,
  toolFingerprint,
} from "../../shared/policy.ts";
import { dialectOverlay } from "../../shared/dialect.ts";
import { PUBLISH_AGENT_PROMPT, PUBLISH_DENIED_PROMPT, PUBLISH_OWNER_PROMPT } from "../../shared/publishPrompt.ts";
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
import { formatBytes } from "../../shared/preview.ts";
import {
  allTenants,
  confinedCwd,
  getTenant,
  hasAuth,
  loadTenants,
  requireCwd,
  resolveTenant,
  sandboxEnabledForTenant,
  workspaceFenceForTenant,
  saveDiskNow,
  settlePersistedChats,
  stateDir,
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
  readRunMark,
} from "./runlog.ts";
import {
  computeTurnFiles,
  readSnapshotDiff,
  readSnapshotFile,
  snapshotTree,
  TREE_BASELINE_MAX_FILES,
  type TurnBaseline,
} from "./turnFiles.ts";
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
import { deleteSession, loadSession, resumeMessages, saveSession, sessionKey } from "./native/session.ts";
import { toolsForMode } from "./native/tools/registry.ts";
import { findBwrap, isReadOnlyCommand, shellTool } from "./native/tools/shell.ts";
import { taskTool } from "./native/tools/task.ts";
import type { ChatMessage, ToolSpec } from "./native/types.ts";
import { bindLoops, loopsForTenant, startLoop, stopLoop, type LoopJob } from "./loops.ts";
import { bindBackground } from "./assistant/background.ts";
import { APPROVAL_TTL_MS, findApproval, settleApproval } from "./assistant/approvals.ts";
import { answerWorkspaceAsk, askWorkspace } from "./assistant/workspaceAsk.ts";
import { activeDelegationFor, createDelegation, getDelegation, updateDelegation } from "./assistant/delegations.ts";
import { postInbox } from "./assistant/inbox.ts";
import {
  assistantName,
  buildState,
  foregroundTools,
  handleOp,
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
  answerMemoryCard,
  calendarFeed,
  clockLine,
  parseClientClock,
  flushWorkspaceProposals,
  noteWorkspaceTurnEnd,
  noteWorkspaceTurnStart,
  workspaceContextFor,
  workspaceToolsFor,
  type CreateWorkspaceRequest,
  type DelegateRequest,
} from "./assistant/service.ts";
import { assistantToolSpecs, toolSpecs } from "./assistant/tools.ts";
import { createPublishController } from "./publish.ts";
import { gatewayEnv, loadDotEnv } from "./config.ts";
import { log } from "./log.ts";
import { loginBlocked, noteLoginFail, noteLoginOk, peerIp } from "./auth/login.ts";
import { agentSocketPath, handleMedia, handleState, handleUpload } from "./http/routes.ts";
import { cancelRun, isAbortError, withTimeout } from "./runtime/abort.ts";
import { rememberApproved, resolveApprovalWait, waitForApproval } from "./runtime/approvals.ts";
import { assistantChatIdOf, assistantCwd, chatIdOf, isAssistantChat } from "./runtime/chats.ts";
import { attachLiveSlots, bindTenant, chatIdsFrom, cwdForChat, cwdOf, detachConn, diskSlot, disposeSlot, globalRunningCount, hydrateConn, lockedChatCwd, maxRunning, persistConn, persistTenant, pruneDroppedSlots, queuedChatIds, runningChatIds, slotOf } from "./runtime/slots.ts";
import { assistantRolledAt, conns, liveSlotsOf, namedChats, namingChats } from "./runtime/state.ts";
import type { AgentHandle, Conn, RunHandle, Slot, WorkspaceFile } from "./runtime/types.ts";
import { broadcastDigest, compactTenantChats, effectiveChatRevs, emitStateSync, emitStoredState, ensureAssistantChat, MAX_STORED_CHATS, mergeAndCompactChat, omitClientDraft, pruneChatRevs, stableStringify, tombstoneChat } from "./sync/storedState.ts";
import { continueTranscript, emitRunSnapshots, flushTranscript, openTranscript, protectChatUpload, stopRunFlush } from "./sync/transcript.ts";
import { checkpointGit, createCheckpoint, nativeStateDir, noteNativeRestore, restoreCheckpoint, rollbackToLatestCheckpoint, sendCheckpoints, undoEdits, workspacePrefix } from "./workspace/checkpoints.ts";
import { filesMessage, listWorkspaceFiles, listWorkspaceFilesForClient, MAX_UPLOAD_BYTES, payload, pushWorkspace, readWorkspaceDiff, readWorkspaceFile, revertHunk, runFsOp, searchWorkspace, uniqueUploadPath, walkFiles, workspacePath, writeWorkspaceBytes, writeWorkspaceFile } from "./workspace/files.ts";
import { git, gitRoot, shadowGitEnv } from "./workspace/git.ts";
import { deleteWorkspace, emitWorkspaces, ensureWorkspaceDir, isUserWorkspace, listWorkspaceItems, mayPublishHere, readHiddenWorkspaces, renameWorkspace, sanitizeWorkspaceName, writeHiddenWorkspaces } from "./workspace/workspaces.ts";
import { clipTurnForPage, fitTurnsFromEnd, reply } from "./ws/frame.ts";
import { parseClient } from "./ws/parse.ts";
import { send } from "./ws/send.ts";

loadDotEnv([
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
]);

const PORT = gatewayEnv.gatewayPort();
const HOST = gatewayEnv.gatewayHost();
const WEB_URL = new URL(gatewayEnv.webOrigin());
const PROXY_WEB = gatewayEnv.proxyWeb();
const DEFAULT_MODEL = gatewayEnv.defaultModel();

loadTenants();
for (const tenant of allTenants()) {
  if (!sandboxEnabledForTenant(tenant)) {
    log.warn(`租户 ${tenant.name}（${tenant.id}）不启用沙箱。`);
  }
  if (compactTenantChats(tenant)) {
    saveDiskNow(tenant);
    log.info(`已截断过长的工具记录 ${tenant.name}（${tenant.id}）`);
  }
}
let modelsCache: { at: number; ids: string[] } | null = null;

const publish = createPublishController({
  tenants: () =>
    allTenants().map((tenant) => ({
      id: tenant.id,
      workspaceRoot: tenant.workspaceRoot,
      stateDir: tenant.stateDir,
      name: tenant.name,
    })),
});

process.on("unhandledRejection", (err) => {
  if (isAbortError(err)) return;
  log.error(err);
});
process.on("uncaughtException", (err) => {
  if (isAbortError(err)) return;
  const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
  // 超长帧会关掉那一条连接。不能因此退出进程，否则 systemd 重启后客户端立刻重发，变成连上就断。
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    log.error("websocket payload too large");
    return;
  }
  log.error(err);
  process.exit(1);
});

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

/** 助理会话不分段新建：每满这么多轮换一个新的模型会话，靠记忆块 + 最近摘录续上 */
const ASSISTANT_ROLL_TURNS = 40;

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
  // 删除方自己也要收到：rev 前进了，不对齐的话它下一次 sync_chat 会被拒一轮
  broadcastDigest(tenant);
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

function isAgentMissing(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === "agent_not_found") return true;
  const text = [rec.message, err instanceof Error ? err.message : ""].filter(Boolean).join(" ");
  return /agent[-_ ].*not found/i.test(text) || /agent_not_found/i.test(text);
}

async function ensureAgent(conn: Conn, slot: Slot): Promise<AgentHandle> {
  const apiKey = gatewayEnv.cursorApiKey();
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
  // 助理工具只挂在唯一的助理会话上；其他会话没有个人记忆工具，只能提议写工作区记忆
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) {
    local.customTools = foregroundTools(conn.tenant, slot.chatId);
  } else if (conn.tenant) {
    local.customTools = workspaceToolsFor(conn.tenant, slot.chatId, cwd);
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
          log.error("drop reviewer after crew reject", dropped.modelId, err);
          next = next.slice(0, -1);
          continue;
        }
        log.error("crew agents rejected, retrying without them", err);
        bare = true;
      }
    }
  };

  const resumeId = slot.agentId;
  try {
    slot.agent = await openWithCrewFallback(resumeId);
  } catch (err) {
    if (!resumeId || !isAgentMissing(err)) throw err;
    log.warn("agent missing, opening a new one", { chatId: slot.chatId, agentId: resumeId });
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
  const apiKey = gatewayEnv.cursorApiKey();
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

/** 续接时 prompt 前面拼了此前对话摘录（attachReseedContext），回放时只留「当前请求」之后的部分 */
function unwrapReseedPrompt(text: string): string {
  const mark = "\n\n当前请求：\n";
  if (!text.startsWith("以下是同一工作区里此前的对话摘录")) return text;
  const at = text.lastIndexOf(mark);
  return at >= 0 ? text.slice(at + mark.length) : text;
}

function conversationToTurns(conv: unknown[], roster?: ReviewBinding[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const raw of conv) {
    if (!isRecord(raw) || raw.type === "shellConversationTurn") continue;
    // SDK 1.x：{ type: "agentConversationTurn", turn: { userMessage, steps } }；旧格式字段直接在顶层
    const item = isRecord(raw.turn) ? raw.turn : raw;
    const user =
      isRecord(item.userMessage) && typeof item.userMessage.text === "string"
        ? unwrapReseedPrompt(item.userMessage.text)
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

/**
 * 只给落盘里没有任何回合的会话补回 SDK 历史。客户端按用户原文配对合并，而 SDK 记下的
 * 用户消息带着网关拼的规则和说明，配不上的回合会整批插到前面，落盘有正文时只会造成重复。
 */
async function sendAgentHistory(ws: WebSocket, conn: Conn, slot: Slot) {
  const agentId = slot.agentId;
  if (!agentId) return;
  if (diskChatTurns(conn.tenant, slot.chatId).length > 0) return;
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
      // 与 load_chat 同口径：条数 40、字节为接收上限的 80%（不限的连接按 800KB）
      const declared = conn.maxMessageBytes;
      const budget = declared > 0 ? Math.floor(declared * 0.8) : 800 * 1024;
      const page = fitTurnsFromEnd(turns, budget, 40) as HistoryTurn[];
      if (page.length) send(ws, { type: "history", chatId: slot.chatId, turns: page });
    }
  } catch (err) {
    // History is best-effort; local store may not have runs yet.
    log.debug("读 Agent 历史失败", slot.chatId, err instanceof Error ? err.message : err);
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
    } catch (err) {
      // skip unreadable attachment
      log.debug("附件读不了", raw, err instanceof Error ? err.message : err);
    }
  }
  return parts.join("\n\n");
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

/** 有租户时：W0 工作偏好 + 从 cwd 往上到 USER 根目录的分层规则；没有租户只读 cwd 这一层 */
function loadWorkspaceRules(cwd: string, tenant?: Tenant | null): string {
  if (tenant) {
    try {
      return workspaceContextFor(tenant, cwd);
    } catch (err) {
      log.error("workspace context", err);
    }
  }
  const chunks: string[] = [];
  const take = (rel: string) => {
    const abs = resolve(cwd, rel);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return;
      const text = readFileSync(abs, "utf8").trim();
      if (text) chunks.push(`# ${rel}\n${text}`);
    } catch (err) {
      // skip unreadable rule files
      log.debug("规则文件读不了", abs, err instanceof Error ? err.message : err);
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
  } catch (err) {
    // no rules directory
    log.debug("规则目录读不了", dir, err instanceof Error ? err.message : err);
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
  const publishPrompt = confine ? (atUserRoot ? PUBLISH_AGENT_PROMPT : PUBLISH_DENIED_PROMPT) : PUBLISH_OWNER_PROMPT;
  const planPublish = confine
    ? atUserRoot
      ? "不要执行 jiebo-publish。需要外网地址时，把 jiebo-publish start -- <启动命令> 写进方案。网站只能在这个 USER 工作区里做。"
      : "不要执行 jiebo-publish，也不要把它写进方案。对外网站只能在 USER 工作区里创建。"
    : "不要执行 jiebo-publish。需要外网地址时，把 jiebo-publish start -- <启动命令> 写进方案。这个用户的任意会话都能创建对外网站。";
  const crewStay = confine
    ? "Subagents must stay inside the current workspace."
    : "Subagents have the same reach as the USER workspace and may edit any directory under this user's root.";
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
${confine ? "方案里的每一步都只能动当前工作区里的文件，不要提议改工作区外的路径。" : "方案可以动这个用户根目录下的各个子工作区，和 USER 工作区权限相同。"}
${planPublish}
可以派出 explore 子代理做只读摸底。不要派出 builder。
${reviewPanelPrompt(panel)}

${body}`;
  }
  return `${bound}CANVAS: If this turn's deliverable is a standalone analytical artifact (table, chart, review, metrics, timeline, architecture comparison), write exactly one file at .cursor-remote/canvases/<kebab-name>.canvas.tsx.
Import only from "cursor/canvas". Default-export one React component. Embed data inline. No fetch(), no relative imports, no npm packages.
Link that file in the reply, e.g. [仓库概览](.cursor-remote/canvases/repo-overview.canvas.tsx). Do not write a canvas for ordinary Q&A or a pure code edit.
画布颜色跟应用主题走：只用 cursor/canvas 组件和 useHostTheme() 上色，不要写死 hex、rgb、hsl，也不要另做一套深浅色。宿主会套上用户当前的配色。

命令或工具失败时不要结束整个任务。同一件事最多再试 2 次，每次换一种做法，不要原样重复。仍失败就把这一步记下来；后面不依赖它的步骤继续做。全部做完再说明哪一步没成。

${publishPrompt}

CREW: Named subagents via the Task/Agent tool: explore (read-only search), builder (implement). ${crewStay}
${reviewPanelPrompt(panel)}

${body}`;
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
  const files = approval ? [] : attachTurnFiles(slot);
  const turnId = slot.transcript?.turnId || "";
  flushTranscript(slot, !approval);
  if (!approval) indexUserTurn(slot);
  if (!approval) noteWorkspaceTurn(slot);
  if (files.length && turnId) {
    const target = slot.owner?.readyState === WebSocket.OPEN ? slot.owner : ws;
    reply(target, { type: "turn_files", chatId: slot.chatId, turnId, files });
  }
}

/** 算这一轮的文件清单并存快照，写进 transcript 随落盘走。出错只记日志，不影响收尾 */
function attachTurnFiles(slot: Slot): TurnFile[] {
  const transcript = slot.transcript;
  const tenant = getTenant(slot.tenantId);
  if (!tenant || !transcript || transcript.epoch !== slot.epoch) return [];
  // 基线不在这里清：同一轮在 done 之后被继续时还要用开头那份
  const base = slot.turnBase?.turnId === transcript.turnId ? slot.turnBase : undefined;
  try {
    const cwd =
      base?.cwd ||
      (isAssistantChat(tenant, slot.chatId)
        ? assistantCwd(tenant)
        : requireCwd(slot.cwd || tenant.workspaceRoot, tenant.workspaceRoot));
    let baseline: TurnBaseline | null = null;
    const commit = base?.checkpoint?.commit || base?.tree;
    if (base && commit) {
      try {
        const ctx = checkpointGit(cwd, base.checkpoint);
        const prefix = workspacePrefix(ctx.cwd, cwd);
        const scope = prefix ? [prefix] : listWorkspaceFiles(cwd, "").paths;
        baseline = { commit, ctx, prefix, scope };
      } catch {
        baseline = null;
      }
    }
    const files = computeTurnFiles({
      cwd,
      stateDir: tenant.stateDir,
      tools: transcript.tools,
      baseline,
      assistantBody: transcript.assistant,
      fallbackDiff: (rel) => readWorkspaceDiff(cwd, rel).content ?? null,
    });
    if (files.length) transcript.files = files;
    else delete transcript.files;
    return files;
  } catch (err) {
    log.error("turn files", err instanceof Error ? err.message : err);
    return [];
  }
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
    log.error("index user turn", err);
  }
}

/** 子工作区会话每轮完成后：更新线程摘要，攒了工作区记忆提议的话等空闲出确认卡 */
function noteWorkspaceTurn(slot: Slot) {
  const tenant = getTenant(slot.tenantId);
  const transcript = slot.transcript;
  if (!tenant || !transcript || isAssistantChat(tenant, slot.chatId)) return;
  const chat = tenant.disk.chats.find((item) => chatIdOf(item) === slot.chatId) as { title?: unknown } | undefined;
  try {
    noteWorkspaceTurnEnd(tenant, {
      chatId: slot.chatId,
      cwd: requireCwd(slot.cwd || tenant.workspaceRoot, tenant.workspaceRoot),
      title: typeof chat?.title === "string" ? chat.title : "",
      user: transcript.userText || "",
      assistant: transcript.assistant || "",
    });
  } catch (err) {
    log.error("workspace turn", err);
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
  const rules = loadWorkspaceRules(input.cwd, getTenant(slot.tenantId));
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
    const turnId = slot.transcript?.turnId;
    if (turnId && slot.turnBase?.turnId !== turnId) slot.turnBase = { turnId, cwd, checkpoint };
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

/** 新回合没建检查点（autoApprove、检查点失败）时补一个只用于文件清单的 tree 基线，不进还原点列表 */
function ensureTurnBaseline(slot: Slot, cwd: string, mode: AgentMode) {
  if (mode !== "agent" && mode !== "plan") return;
  const turnId = slot.transcript?.turnId;
  if (!turnId || slot.turnBase?.turnId === turnId) return;
  // 先占位：建不成也不在同一轮的重放里补建，否则基线会落在半轮的位置
  const base: NonNullable<Slot["turnBase"]> = { turnId, cwd };
  slot.turnBase = base;
  try {
    const ctx = checkpointGit(cwd);
    const prefix = workspacePrefix(ctx.cwd, cwd);
    let scope: string[] = [];
    if (!prefix) {
      const listed = listWorkspaceFiles(cwd, "");
      if (listed.truncated || listed.paths.length > TREE_BASELINE_MAX_FILES) return;
      scope = listed.paths;
    }
    base.tree = snapshotTree({ ctx, prefix, scope }) || undefined;
  } catch (err) {
    // 没基线就只用工具路径
    const now = Date.now();
    const quiet = now - (baselineWarnedAt.get(cwd) ?? -Infinity) < BASELINE_WARN_MS;
    if (!quiet) baselineWarnedAt.set(cwd, now);
    (quiet ? log.debug : log.warn)("本轮文件基线没建成", slot.chatId, cwd, err instanceof Error ? err.message : err);
  }
}

/** 基线持续失败时每轮都会走到上面：同一目录 10 分钟内只 warn 一次，其余记 debug */
const BASELINE_WARN_MS = 10 * 60_000;
const baselineWarnedAt = new Map<string, number>();

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
  ensureTurnBaseline(slot, cwd, mode);

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
  if (mcp.errors.length) log.error("mcp", mcp.errors.join(" | "));
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
    if (shellPublishes(spec.name, args) && !mayPublishHere(conn.tenant, cwd)) {
      return "对外网站只能在 USER 工作区里创建，这个会话不能执行 jiebo-publish。";
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
      log.info(`native compact chat=${slot.chatId} stage=${info.stage} ${info.before}→${info.after} summarized=${info.summarized}`);
    },
  });
  const assistantSpecs = !conn.tenant
    ? []
    : atAssistant
      ? assistantToolSpecs(chatToolHost(conn.tenant, slot.chatId))
      : toolSpecs(workspaceToolsFor(conn.tenant, slot.chatId, cwd));
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
      log.error("native session save", err instanceof Error ? err.message : err);
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
  const apiKey = gatewayEnv.cursorApiKey();
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
    log.error("titleChat", err instanceof Error ? err.message : err);
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
      log.error("assistant preamble", err);
    }
  }
  let prompt = wrapPrompt(
    userText,
    mode,
    files,
    loadWorkspaceRules(cwd, conn.tenant),
    cwd,
    slot.reviewRoster || [],
    atUserRoot,
    workspaceFenceForTenant(conn.tenant),
  );
  const extra = nextDialect ? dialectOverlay(usedModel) : "";
  if (extra) prompt = `${prompt}\n\n${extra}`;
  // Cursor SDK 路径：人设进 user 包装；第三方自研 Agent 路径改由 runNativeChat 写进 system。
  // 时间行两条路径都放在用户消息里：它每轮都变，进 system 会让提示缓存失效
  const clock = assistantBlock ? clockLine(conn.clock) : "";
  if (clock) prompt = `${clock}\n\n${prompt}`;
  if (assistantBlock && !externalEarly) {
    prompt = `${assistantBlock}\n\n${prompt}`;
  }
  if (!prompt) return;

  const epoch = ++slot.epoch;
  if (keepTranscript && slot.transcript) continueTranscript(slot, epoch);
  else openTranscript(slot, turnId, userText, epoch, safeImages);
  if (conn.tenant && !isAssistantChat(conn.tenant, slot.chatId)) noteWorkspaceTurnStart(conn.tenant, slot.chatId);
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
      text: clock ? `${clock}\n\n${userText}` : userText,
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
  ensureTurnBaseline(slot, cwd, mode);

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
    if (mayPublishHere(conn.tenant, cwd)) return false;
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
      const apiKey = gatewayEnv.cursorApiKey();
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
      log.error("disallowedTools rejected, retrying without them", err);
      const { disallowedTools: _drop, ...rest } = sendOpts;
      run = await startSend(rest);
    }

    if (slot.epoch !== epoch || slot.finished) {
      try {
        await cancelRun(run);
      } catch (err) {
        // Stale run after cancel or a newer prompt.
        log.warn("取消过期运行失败", slot.chatId, err instanceof Error ? err.message : err);
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
      } catch (err) {
        // stream already closed
        log.debug("关闭运行流失败", slot.chatId, err instanceof Error ? err.message : err);
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
  const ready = Boolean(hasAuth() && gatewayEnv.cursorApiKey() && cwdOk && stateOk);
  return {
    ok: ready,
    tenants: tenants.map((item) => item.id),
    cwdWritable: cwdOk,
    stateWritable: stateOk,
    hasApiKey: Boolean(gatewayEnv.cursorApiKey()),
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
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/cal/")) {
    // 口令就是凭证，出错也不往日志里写路径
    const token = url.pathname.slice("/media/cal/".length).replace(/\.ics$/, "");
    let body: string | null = null;
    try {
      body = calendarFeed(allTenants(), token);
    } catch (err) {
      log.error("calendar feed", err instanceof Error ? err.message : err);
    }
    if (body === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": 'inline; filename="todos.ics"',
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/media") {
    try {
      handleMedia(req, res, url);
    } catch (err) {
      log.error("media", err instanceof Error ? err.message : err);
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
      log.error("upload", err instanceof Error ? err.message : err);
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
    log.error("ws error", code || (err instanceof Error ? err.message : err));
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
        const apiKey = gatewayEnv.cursorApiKey();
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
            features: ["turn_files", "read_sha", "read_req_id", "seg_hashes", "tool_at", "slim_chats"],
          });
        };
        try {
          ensureAssistantChat(tenant);
          onTenantHello(tenant);
        } catch (err) {
          log.error("assistant hello", err);
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
        const result =
          message.op === "approval_answer"
            ? answerDelegationApproval(tenant, args)
            : message.op === "delegation_cancel"
              ? await cancelDelegation(ws, tenant, args)
              : await handleOp(tenant, message.op, args);
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
        const cursor = await cursorBill(gatewayEnv.cursorApiKey());
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
          .map((raw) => {
            if (!raw || typeof raw !== "object") return raw;
            const item = omitClientDraft(raw);
            const row = item as { id?: unknown; cwd?: unknown };
            const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
            const id = typeof row.id === "string" ? row.id : "";
            const next =
              (id ? lockedChatCwd(tenant, id) : null) ||
              wanted ||
              (id ? confinedCwd(prevCwd.get(id), tenant.workspaceRoot) : null) ||
              tenant.workspaceRoot;
            const withCwd = row.cwd === next ? item : { ...row, cwd: next };
            const prevChat = id ? tenant.disk.chats.find((row) => chatIdOf(row) === id) : undefined;
            const merged = mergeAndCompactChat(prevChat, withCwd);
            const provided = Boolean(item && typeof item === "object" && Array.isArray((item as { turns?: unknown }).turns));
            // protect 可能因助手文本更长而留用磁盘上的旧工具列表，截断必须发生在那之后
            const uploaded = protectChatUpload(tenant, id, merged, provided);
            return mergeAndCompactChat(prevChat, uploaded);
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
        send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: effectiveChatRevs(tenant), keptBodies: true });
        broadcastDigest(tenant, ws); // 多设备实时对账
        return;
      }

      // 保留/还原只改标记。同时把磁盘上过长的工具正文截掉，打开着的标签不重载。
      if (message.type === "tool_review") {
        const chatId = typeof message.chatId === "string" ? message.chatId : "";
        const turnId = typeof message.turnId === "string" ? message.turnId : "";
        const reviews = Array.isArray(message.reviews) ? message.reviews : [];
        const ackRev = () => {
          send(ws, {
            type: "sync_ack",
            rev: tenant.disk.rev,
            chatRevs: chatId ? { [chatId]: tenant.disk.chatRevs[chatId] ?? tenant.disk.rev } : {},
            reviewOnly: true,
          });
        };
        if (!chatId || !turnId || tenant.disk.deletedIds.includes(chatId)) {
          ackRev();
          return;
        }
        const prev = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
        if (!prev || typeof prev !== "object") {
          ackRev();
          return;
        }
        const want = new Map<string, "accepted" | "rejected">();
        for (const item of reviews) {
          if (!item || typeof item !== "object") continue;
          const callId = (item as { callId?: unknown }).callId;
          const review = (item as { review?: unknown }).review;
          if (typeof callId !== "string" || !callId) continue;
          if (review !== "accepted" && review !== "rejected") continue;
          want.set(callId, review);
        }
        let applied = false;
        const stamped = { ...(prev as Record<string, unknown>) };
        if (Array.isArray(stamped.turns)) {
          stamped.turns = stamped.turns.map((turn) => {
            if (!turn || typeof turn !== "object" || (turn as { id?: unknown }).id !== turnId) return turn;
            if (!Array.isArray((turn as { tools?: unknown }).tools)) return turn;
            const tools = (turn as { tools: unknown[] }).tools.map((tool) => {
              if (!tool || typeof tool !== "object") return tool;
              const callId = (tool as { callId?: unknown }).callId;
              if (typeof callId !== "string" || !want.has(callId)) return tool;
              const review = want.get(callId);
              if ((tool as { review?: unknown }).review === review) return tool;
              applied = true;
              return { ...(tool as Record<string, unknown>), review };
            });
            return { ...(turn as Record<string, unknown>), tools };
          });
        }
        const hit = { n: 0 };
        const compacted = mergeAndCompactChat(prev, stamped, hit);
        if (applied || hit.n > 0) {
          tenant.disk.rev += 1;
          tenant.disk.chatRevs[chatId] = tenant.disk.rev;
          tenant.disk.chats = tenant.disk.chats.map((item) => (chatIdOf(item) === chatId ? compacted : item));
          persistConn(conn);
          broadcastDigest(tenant, ws);
        }
        ackRev();
        return;
      }

      if (message.type === "load_state") {
        emitStoredState(ws, tenant);
        return;
      }

      // 编辑、重试：截掉 turnId 及之后的回合
      if (message.type === "truncate_turns") {
        const id = typeof message.chatId === "string" ? message.chatId : "";
        const turnId = typeof message.turnId === "string" ? message.turnId : "";
        if (!id || !turnId) return;
        // 截断只动这一条会话、可重放，不做 rev 拒绝；rev 落后时接着服务端往前走
        const clientRev = typeof message.rev === "number" ? message.rev : 0;
        const nextRev = Math.max(clientRev, tenant.disk.rev + 1);
        const prev = tenant.disk.deletedIds.includes(id)
          ? undefined
          : tenant.disk.chats.find((item) => chatIdOf(item) === id);
        // 没截成（找不到回合或正在跑）：truncated: false，客户端重拉正文
        const ackCurrent = () =>
          send(ws, {
            type: "sync_ack",
            rev: tenant.disk.rev,
            chatRevs: prev ? { [id]: tenant.disk.chatRevs[id] ?? 0 } : {},
            truncated: false,
          });
        if (!prev || typeof prev !== "object") {
          ackCurrent();
          return;
        }
        const slot = liveSlotsOf(tenant).get(id);
        if (runningChatIds(tenant).includes(id) || slot?.transcript?.phase === "running") {
          ackCurrent();
          return;
        }
        const row = prev as Record<string, unknown>;
        const turns = Array.isArray(row.turns) ? row.turns : [];
        const index = turns.findIndex(
          (turn) => Boolean(turn) && typeof turn === "object" && (turn as { id?: unknown }).id === turnId,
        );
        if (index < 0) {
          ackCurrent();
          return;
        }
        const removed = new Set(
          turns
            .slice(index)
            .map((turn) => (turn && typeof turn === "object" ? (turn as { id?: unknown }).id : null))
            .filter((item): item is string => typeof item === "string" && Boolean(item)),
        );
        const next: Record<string, unknown> = { ...row, turns: turns.slice(0, index) };
        const mark = readRunMark(prev);
        if (mark && removed.has(mark.turnId)) delete next.runMark;
        // 否则 protectChatUpload / flushTranscript 会把删掉的回合按转录补回来
        if (slot?.transcript && removed.has(slot.transcript.turnId)) {
          stopRunFlush(slot);
          slot.transcript = undefined;
        }
        tenant.disk.rev = nextRev;
        tenant.disk.chatRevs[id] = nextRev;
        tenant.disk.chats = tenant.disk.chats.map((item) => (item === prev ? next : item));
        persistConn(conn);
        send(ws, { type: "sync_ack", rev: nextRev, chatRevs: { [id]: nextRev }, truncated: true });
        broadcastDigest(tenant, ws);
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
          const cwd = lockedChatCwd(tenant, id) || wanted || fallback || tenant.workspaceRoot;
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
        next = mergeAndCompactChat(prev, omitClientDraft(next));
        const turnsProvided = Boolean(
          message.chat &&
            typeof message.chat === "object" &&
            Array.isArray((message.chat as { turns?: unknown }).turns),
        );
        next = protectChatUpload(tenant, id, next, turnsProvided);
        next = mergeAndCompactChat(prev, next);
        const changed = stableStringify(prev ?? null) !== stableStringify(next);
        const stored = tenant.disk.chats.filter((item) => !isAssistantChat(tenant, chatIdOf(item))).length;
        if (changed && !prev && !isAssistantChat(tenant, id) && stored >= MAX_STORED_CHATS) {
          // 条数硬顶：追加新会话被拒（替换既有会话不受限），回 ack 让客户端收敛 inflight
          log.warn("sync_chat 拒绝：会话数超上限", tenant.id, MAX_STORED_CHATS);
          send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
          return;
        }
        // 先写 rev 再落盘（P4 审核：崩溃窗口不能出现「新内容旧 rev」）。
        // 无变化的重推不动全局 rev：否则其他设备的下一次推送会因 rev 落后被拒，白白多一轮对账。
        // chatRevs[id] 同样只在内容真变时前进（P8 审核：无变化 sync 也 bump 的话，其他端重连时
        // 会把纯元数据/未读类本地脏误判成正文变更，整会话作废重载）
        if (changed) {
          tenant.disk.rev = clientRev;
          tenant.disk.chatRevs[id] = clientRev;
          tenant.disk.chats = prev
            ? tenant.disk.chats.map((item) => (chatIdOf(item) === id ? next : item))
            : [...tenant.disk.chats, next];
        }
        persistConn(conn);
        // ack 回报服务端真实 chatRev（无变化时不前进），客户端对账口径与 digest 一致
        send(ws, {
          type: "sync_ack",
          rev: tenant.disk.rev,
          chatRevs: { [id]: tenant.disk.chatRevs[id] ?? clientRev },
          keptBodies: true,
        });
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
        // 注意：load_chats 对 slim_state 客户端也回全量——它只服务 digest 差异对账（通常单会话），
        // 是跨设备 turns 更新的唯一通道。带 slim_chats 的客户端按 segHashes 自己走 load_chat 补正文
        const slimRows = connNow?.caps.has("slim_chats") ?? false;
        for (const id of ids) {
          if (gone.has(id)) continue;
          const chat = tenant.disk.chats.find((item) => chatIdOf(item) === id);
          if (!chat) continue;
          const payload = {
            type: "stored_chat" as const,
            chat: slimRows ? slimChat(tenant.bodies, chat) : omitClientDraft(chat),
            rev: tenant.disk.chatRevs[id] ?? 0,
          };
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
        const listed = listWorkspaceFilesForClient(cwd, message.query || "");
        send(
          ws,
          filesMessage(conn, { chatId: message.chatId, query: message.query || "", mention: Boolean(message.mention) }, listed),
        );
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
        if (message.chatId && isAssistantChat(tenant, message.chatId)) {
          send(ws, { type: "error", chatId: message.chatId, message: "助理会话固定在 USER 根目录，不能换工作区。" });
          return;
        }
        const next =
          (message.chatId ? lockedChatCwd(tenant, message.chatId) : null) ||
          confinedCwd(message.cwd || conn.cwd, tenant.workspaceRoot);
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
        // 之前隐藏过的同名工作区：重新建就是取消隐藏
        const hidden = readHiddenWorkspaces(tenant);
        if (hidden.includes(name)) writeHiddenWorkspaces(tenant, hidden.filter((item) => item !== name));
        send(ws, { type: "workspace_created", path: next, name });
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "rename_workspace") {
        await renameWorkspace(ws, tenant, conn, String(message.path || ""), String(message.name || ""));
        return;
      }

      if (message.type === "delete_workspace") {
        deleteWorkspace(ws, tenant, conn, String(message.path || ""));
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
        const next =
          lockedChatCwd(tenant, slot.chatId) ||
          (message.cwd ? confinedCwd(message.cwd, tenant.workspaceRoot) : null);
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
        const echo = {
          reqId: typeof message.reqId === "string" ? message.reqId : undefined,
          sha: typeof message.sha === "string" ? message.sha : undefined,
        };
        let file: WorkspaceFile;
        if (echo.sha != null) {
          // 快照只按 sha 寻址，path 只用来定 kind 和显示名
          const rel = workspacePath(cwd, message.path) || message.path;
          file = message.diff
            ? readSnapshotDiff(tenant.stateDir, rel, echo.sha)
            : readSnapshotFile(tenant.stateDir, rel, echo.sha);
        } else {
          file = message.diff ? readWorkspaceDiff(cwd, message.path) : readWorkspaceFile(cwd, message.path);
        }
        reply(ws, payload(tenant, message.chatId, message.path, file, Boolean(message.diff), echo));
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
        conn.clock = parseClientClock(message.clientTime) ?? conn.clock;
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

/** 收件箱、父会话或任一设备作答委派子会话的挂起审批；不抢子会话的 owner */
function answerDelegationApproval(tenant: Tenant, args: Record<string, unknown>) {
  const chatId = typeof args.chatId === "string" ? args.chatId : "";
  const callId = typeof args.callId === "string" ? args.callId : "";
  if (!chatId || !callId || typeof args.allow !== "boolean") return { ok: false, error: "要带 chatId、callId 和 allow。" };
  const card = answerMemoryCard(tenant, chatId, callId, args.allow);
  if (card) return card;
  if (answerWorkspaceAsk(tenant, chatId, callId, args.allow)) return { ok: true };
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

/** 用户从任一设备停掉一项前台委派。后台委派是只读的，不提供停止 */
async function cancelDelegation(ws: WebSocket, tenant: Tenant, args: Record<string, unknown>) {
  const id = typeof args.delegationId === "string" ? args.delegationId : "";
  const record = id ? getDelegation(tenant, id) : undefined;
  if (!record) return { ok: false, error: "没有这项委派。" };
  if (record.status !== "running" && record.status !== "awaiting") return { ok: false, error: "这项委派已经结束了。" };
  const slot = liveSlotsOf(tenant).get(record.childChatId);
  if (!slot || slot.finished) {
    return { ok: false, error: record.mode === "background" ? "后台委派是只读的，不能停，很快会自己结束。" : "这项委派已经没有在跑了。" };
  }
  resolveApprovalWait(slot, false);
  slot.externalAbort?.abort();
  await cancelRun(slot.run);
  finishRun(slot.owner ?? ws, slot, "cancelled");
  return { ok: true };
}

function delegationWorkspaces(tenant: Tenant) {
  return listWorkspaceItems(tenant)
    .filter((item) => !item.user)
    .map((item) => item.name);
}

/** 助理请求新建工作区：先问用户，同意了才真正建目录 */
async function requestWorkspace(req: CreateWorkspaceRequest): Promise<string> {
  const tenant = getTenant(req.tenant.id);
  if (!tenant) return JSON.stringify({ ok: false, error: "租户不存在" });
  const name = sanitizeWorkspaceName(req.name.replace(/^\.\//, ""));
  const root = resolve(tenant.workspaceRoot);
  const cwd = name ? confinedCwd(resolve(root, name), root) : null;
  if (!name || !cwd || cwd === root) return JSON.stringify({ ok: false, error: "工作区名字不合法。" });
  if (existsSync(cwd)) {
    return statSync(cwd).isDirectory()
      ? JSON.stringify({ ok: true, name, existed: true, note: "已经有这个工作区，直接 delegate。" })
      : JSON.stringify({ ok: false, error: "已经有同名文件。" });
  }
  if (!req.parentChatId) return JSON.stringify({ ok: false, error: "只有和用户对话时才能请求新建工作区。" });
  const outcome = await askWorkspace(tenant, { chatId: req.parentChatId, name, reason: req.reason }, () => void publishState(tenant));
  if (outcome === "expired") return JSON.stringify({ ok: false, error: "用户没有回应，没有建。可以稍后再问一次。" });
  if (outcome === "denied") return JSON.stringify({ ok: false, denied: true, error: "用户拒绝了，没有建。" });
  try {
    ensureWorkspaceDir(cwd);
  } catch {
    return JSON.stringify({ ok: false, error: "建不了这个工作区目录。" });
  }
  for (const conn of conns.values()) {
    if (conn.authed && conn.tenant?.id === tenant.id) emitWorkspaces(conn.ws, tenant);
  }
  return JSON.stringify({ ok: true, name, note: "已建好，可以 delegate 了。" });
}

async function startDelegation(req: DelegateRequest): Promise<string> {
  const tenant = getTenant(req.tenant.id);
  if (!tenant) return JSON.stringify({ ok: false, error: "租户不存在" });
  const name = sanitizeWorkspaceName(req.workspace.replace(/^\.\//, ""));
  const root = resolve(tenant.workspaceRoot);
  const cwd = name ? confinedCwd(resolve(root, name), root) : null;
  if (!name || !cwd || cwd === root || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return JSON.stringify({ ok: false, error: `没有这个子工作区：${req.workspace}。可用：${delegationWorkspaces(tenant).join("、")}。需要新的可以先用 create_workspace（会请用户确认）。` });
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
  broadcastDigest(tenant);
  publishDelegation(tenant, record);

  const finish = (ok: boolean, text: string) => {
    settleApproval(tenant, childChatId);
    flushWorkspaceProposals(tenant, childChatId);
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
    finish(ok, ok ? text.trim() : status === "cancelled" ? "你停掉了这项委派。" : error || `结束状态：${status}`);
  });
  return JSON.stringify({ ok: true, id: record.id, childChatId, mode: "foreground", note: "子会话已开工，写文件要你批准；完成后汇报到收件箱。" });
}

bindBackground({
  apiKey: () => gatewayEnv.cursorApiKey(),
  listModels,
  prompt: (message, options) => Agent.prompt(message, options),
  sandbox: (tenantId) => sandboxEnabledForTenant(getTenant(tenantId)),
});

startAssistant({
  tenants: () => allTenants(),
  publish: publishLoop,
  globalStateDir: stateDir(),
  delegate: startDelegation,
  createWorkspace: requestWorkspace,
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
  log.banner(`cursor-remote gateway  http://${HOST}:${PORT}`);
  if (tenants.length === 1) {
    log.banner(`工作区                 ${tenants[0].workspaceRoot}`);
  } else {
    log.banner(`租户                   ${tenants.map((item) => item.id).join(", ") || "(无)"}`);
  }
  log.banner(`状态目录               ${stateDir()}`);
  if (PROXY_WEB) log.banner(`本机网页               ${WEB_URL.origin}`);
  if (!gatewayEnv.cursorApiKey()) {
    log.warn("缺少 CURSOR_API_KEY：写入环境或 .env 后重启 gateway。");
  }
  if (!hasAuth()) {
    log.warn("缺少登录配置：写入 tenants.json 或 CURSOR_REMOTE_TOKEN 后重启 gateway。");
  }
});
