// 对话运行核心：handlePrompt 与排队续跑（drainPending/kickGlobalQueue 与 handlePrompt 互相调用，放在同一文件）
import { WebSocket } from "ws";
import {
  crewAgentToken,
  crewRoleOf,
  isCrewRole,
  isCrewToolName,
  resolveCrewModel,
  wantsMultiModelReview,
} from "../../../shared/crew.ts";
import { dialectOverlay } from "../../../shared/dialect.ts";
import {
  askDisallowedTools,
  isPlane,
  parsePolicy,
  planDisallowedTools,
  toolFingerprint,
} from "../../../shared/policy.ts";
import type { AgentMode, PolicyId } from "../../../shared/protocol.ts";
import { clockLine, noteWorkspaceTurnStart, skillsCatalogWithMetaFor, userRootPreamble } from "../assistant/service.ts";
import { gatewayEnv } from "../config.ts";
import { broadcastFileChanged } from "../fileEvents.ts";
import { log, slotLog } from "../log.ts";
import { deleteSession } from "../native/session.ts";
import { type ChatHistoryItem, externalRoute } from "../providers.ts";
import { repairReplyText } from "../../../shared/replyText.ts";
import { cancelRun, isAbortError, withTimeout } from "../runtime/abort.ts";
import { rememberApproved, resolveApprovalWait, waitForApproval } from "../runtime/approvals.ts";
import { isAssistantChat } from "../runtime/chats.ts";
import { cwdOf, disposeSlot, globalRunningCount, maxRunning } from "../runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../runtime/state.ts";
import type { Conn, RunHandle, Slot } from "../runtime/types.ts";
import { continueTranscript, emitOwnerRunSnapshot, flushTranscript, openTranscript } from "../sync/transcript.ts";
import { allTenants, workspaceFenceForTenant } from "../tenants.ts";
import { noteOutput, noteToolCall } from "../usage.ts";
import { nativeStateDir, rollbackToLatestCheckpoint, undoEdits } from "../workspace/checkpoints.ts";
import { pushWorkspace, settleWorkspacePushes, workspacePath } from "../workspace/files.ts";
import { isUserWorkspace, mayPublishHere } from "../workspace/workspaces.ts";
import { send } from "../ws/send.ts";
import { ensureAgent } from "./agent.ts";
import { sanitizeImages } from "./attachments.ts";
import { ensureTurnBaseline, recordRunCheckpoint } from "./baseline.ts";
import { codexRoute, runCodexChat } from "./codexRunner.ts";
import { runExternalChat } from "./external.ts";
import { finishRun } from "./finish.ts";
import { attachReseedContext, diskChatContextStats } from "./history.ts";
import { runNativeChat } from "./native.ts";
import {
  loadDynamicMemoryContext,
  loadStaticRulesFingerprint,
  loadWorkspaceRules,
  wrapFollowupPrompt,
  wrapPrompt,
} from "./prompt.ts";
import { runReviewPanel, syncReviewRoster } from "./review.ts";
import {
  emitToolOutput,
  isMutatingTool,
  parseShellDelta,
  pathFromTool,
  presentToolArgs,
  rememberEdit,
  rememberShellCall,
  shellPublishes,
  snapshotFromResult,
  summarizeToolArgs,
  toolEscapesWorkspace,
} from "./tools.ts";

/** 助理会话不分段新建：每满这么多轮换一个新的模型会话，靠记忆块 + 最近摘录续上 */
export const ASSISTANT_ROLL_TURNS = 40;

/** 子工作区会话自动换壳轮数上限：满 15 轮自动换新 Agent 并靠 attachReseedContext + .jiebo/memory.md 轻装续接 */
export const WORKSPACE_ROLL_TURNS = 15;

/** 任意会话自上次换壳以来累计产生的工具参数+输出与思考上下文达 800KB 时，提前触发无感自动换壳 */
export const SESSION_ROLL_CONTEXT_CHARS = 800_000;

/** 判断当前 SDK 会话是否应触发无感滚动换壳（丢弃数 MB 历史工具垃圾，保留最近 10 轮纯文本摘录与工作区记忆） */
export function shouldRollSdkSession(input: {
  isAssistant: boolean;
  hasAgent: boolean;
  autoApprove?: boolean;
  keepTranscript?: boolean;
  turns: number;
  lastRolledTurn?: number;
  contextCharsSinceRoll: number;
}): boolean {
  if (!input.hasAgent || input.autoApprove || input.keepTranscript) return false;
  const last = Math.max(0, input.lastRolledTurn ?? 0);
  const turnsSinceRoll = input.turns - last;
  if (turnsSinceRoll <= 0) return false;
  const turnLimit = input.isAssistant ? ASSISTANT_ROLL_TURNS : WORKSPACE_ROLL_TURNS;
  if (turnsSinceRoll >= turnLimit) return true;
  if (input.contextCharsSinceRoll >= SESSION_ROLL_CONTEXT_CHARS) return true;
  return false;
}

/** 生成同一 SDK agentId 会话的静态规则与模式指纹：若指纹未变，后续轮次可发送紧凑续接提示词 */
export function buildPromptSeedKey(input: {
  agentId: string;
  cwd: string;
  mode: AgentMode;
  staticRulesHash: string;
  assistantBlock: string;
  dialect: boolean;
  panelKey: string;
}): string {
  return [
    input.agentId,
    input.cwd,
    input.mode,
    input.staticRulesHash,
    input.dialect ? "1" : "0",
    input.panelKey,
    input.assistantBlock
      ? `${input.assistantBlock.length}:${input.assistantBlock.slice(0, 64)}:${input.assistantBlock.slice(-64)}`
      : "",
  ].join("|");
}

/** 模型已发出 turn-ended 且没有任何未完成工具时，等待流自然关闭的静默宽限窗口（毫秒） */
export const RUN_QUIET_AFTER_TURN_ENDED_MS = 20_000;

/** Cursor SDK 流内遇到瞬时限流（resource_exhausted / 429）或网络闪断时的最大自动续跑次数 */
export const MAX_SDK_TRANSIENT_RETRIES = 2;

export const SDK_CONTINUATION_PROMPT =
  "刚才的运行因上游限流或连接瞬断中断，请直接从中断处继续完成剩余任务，不要重复已完成的步骤。";

export const SDK_LARGE_WRITE_CONTINUATION_HINT =
  "若刚才因单次写入内容过大导致流中断，请改用小步分块写入或用短脚本直接读取磁盘文件生成，避免单次工具参数过大。";

/** 构造自动续跑提示词：若上次中断发生在仅有 thinking/工具参数拼装但尚未成功发出 tool_call 时，追加大文件拆分提醒 */
export function buildSdkContinuationPrompt(interruptedBeforeToolCall = false): string {
  return interruptedBeforeToolCall
    ? `${SDK_CONTINUATION_PROMPT}${SDK_LARGE_WRITE_CONTINUATION_HINT}`
    : SDK_CONTINUATION_PROMPT;
}

/** 判断是否应在收到 turn-ended 后启动静默收尾定时器：只要还有工具或子代理在运行，绝不提前断流 */
export function shouldArmRunWatchQuiet(turnEnded: boolean, openToolsSize: number): boolean {
  return turnEnded && openToolsSize <= 0;
}

/** 识别 Cursor SDK 抛出的可自动退避续跑的瞬时错误（配额/速率限制、上游过载、网络闪断、无进展恢复熔断） */
export function isTransientSdkError(errOrMessage: unknown): boolean {
  if (!errOrMessage || isAbortError(errOrMessage)) return false;
  const text =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage instanceof Error
        ? `${errOrMessage.name} ${errOrMessage.message} ${(errOrMessage as { cause?: Error }).cause?.message || ""}`
        : String(errOrMessage);
  return /resource_exhausted|rate[_ -]?limit|\b429\b|too many requests|overloaded|\bunavailable\b|\b50[234]\b|econnreset|etimedout|eai_again|socket hang up|fetch failed|repeated resume attempts made no progress/i.test(
    text,
  );
}

/** 计算第 attempt 次（0-based）自动续跑的退避等待毫秒数 */
export function sdkRetryDelayMs(attempt: number, baseMs = 4_000): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), 16_000);
}

/** 可随时被取消/新 epoch 打断的退避等待 */
export async function waitWithSlotCheck(
  slot: { finished: boolean; epoch: number },
  epoch: number,
  totalMs: number,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, totalMs);
  while (Date.now() < deadline) {
    if (slot.finished || slot.epoch !== epoch) return false;
    const wait = Math.min(stepMs, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return !slot.finished && slot.epoch === epoch;
}

/** 这条消息实际要用的模型：本条消息带的优先，没带才沿用会话和连接上次的 */
export function promptModel(model: string | undefined, slot: { model?: string }, conn: { model: string }) {
  return (model && model.trim()) || slot.model || conn.model;
}

export async function handlePrompt(
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
  const safeHistory = (history ?? [])
    .filter(
      (h): h is ChatHistoryItem => !!h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string",
    )
    .map((item) => (item.role === "assistant" ? { ...item, text: repairReplyText(item.text) } : item));
  if (fresh) {
    resolveApprovalWait(slot, false);
    await cancelRun(slot.run);
    slot.epoch += 1;
    await disposeSlot(slot);
    const nativeDir = nativeStateDir(conn, slot);
    if (nativeDir) deleteSession(nativeDir, slot.chatId);
    slot.agentId = null;
    slot.codexThreadId = null;
    slot.lastEngine = undefined;
    slot.run = null;
    slot.finished = true;
    slot.edited = [];
    slot.checkpoints = [];
    slot.awaitingApproval = false;
    slot.lastShellCallId = null;
    slot.pending = [];
    slot.openTools.clear();
    gatewayState.promptSeedBySlot.delete(slot);
    const freshTurns = diskChatContextStats(conn.tenant, slot.chatId, 0).turns;
    slot.rolledAtTurn = freshTurns;
    gatewayState.assistantRolledAt.set(slot, freshTurns);
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
  const usedModel = promptModel(model, slot, conn);
  if (slot.policy !== nextPolicy || slot.dialect !== nextDialect || slot.mode !== mode) {
    await disposeSlot(slot);
    slot.agentId = null;
    slot.codexThreadId = null;
    slot.reseed = true;
    gatewayState.promptSeedBySlot.delete(slot);
  }
  slot.policy = nextPolicy;
  conn.policy = nextPolicy;
  slot.dialect = nextDialect;
  slot.model = usedModel;
  slot.mode = mode;
  conn.model = usedModel;
  const codexEarly = codexRoute(usedModel);
  const externalEarly = codexEarly ? null : externalRoute(usedModel);
  if (!externalEarly) await syncReviewRoster(conn, slot, usedModel);
  const atUserRoot = Boolean(conn.tenant && isUserWorkspace(cwd, conn.tenant.workspaceRoot));
  let assistantBlock = "";
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) {
    try {
      assistantBlock = userRootPreamble(conn.tenant);
    } catch (err) {
      slotLog(slot).error("assistant preamble", err);
    }
  }
  const fence = workspaceFenceForTenant(conn.tenant);
  const skillRunnerRole = mode === "ask" || mode === "plan" ? ("ask_plan" as const) : ("foreground" as const);
  let skillsBlock = "";
  let prewarmedSkills: Array<{ id: string; name: string }> = [];
  const consumesSkillsPrompt = !externalEarly || Boolean(externalEarly.provider.tools);
  if (conn.tenant && consumesSkillsPrompt) {
    try {
      const rendered = skillsCatalogWithMetaFor(conn.tenant, cwd, {
        query: userText,
        files,
        runnerRole: skillRunnerRole,
        recordPrewarm: !autoApprove && !keepTranscript,
      });
      skillsBlock = rendered.prompt;
      prewarmedSkills = rendered.prewarmedSkills;
    } catch (err) {
      slotLog(slot).error("skills catalog", err);
    }
  }
  let prompt = wrapPrompt(
    userText,
    mode,
    files,
    loadWorkspaceRules(cwd, conn.tenant, userText),
    cwd,
    slot.reviewRoster || [],
    atUserRoot,
    fence,
  );
  if (skillsBlock) prompt = `${skillsBlock}\n\n${prompt}`;
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

  let compactPrompt = wrapFollowupPrompt(
    userText,
    mode,
    files,
    loadDynamicMemoryContext(cwd, conn.tenant, userText),
    cwd,
    fence,
  );
  if (skillsBlock) compactPrompt = `${skillsBlock}\n\n${compactPrompt}`;
  if (clock) compactPrompt = `${clock}\n\n${compactPrompt}`;

  const epoch = ++slot.epoch;
  if (keepTranscript && slot.transcript) continueTranscript(slot, epoch);
  else openTranscript(slot, turnId, userText, epoch, safeImages);
  emitOwnerRunSnapshot(ws, slot);
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

  // Codex CLI 双引擎分流：前置拦截 `codex:<model>`，支持多模型交叉评审与排队续跑
  if (codexEarly) {
    let codexReviewAppended = false;
    if (wantsMultiModelReview(userText) && !autoApprove && !keepTranscript) {
      const panel = slot.reviewRoster || [];
      const apiKey = gatewayEnv.cursorApiKey();
      if (panel.length < 2) {
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: "目录里除了当前模型，没有足够的其他模型可以并行评审。\n\n",
        });
        prompt += "\n\n目录里除了当前模型，没有足够的其他模型可以并行评审。直接告诉用户，不要用同一个模型假装多家。";
        codexReviewAppended = true;
      } else if (apiKey) {
        prompt += await runReviewPanel(ws, conn, slot, panel, userText, cwd, apiKey, epoch, { files });
        codexReviewAppended = true;
        if (slot.finished || slot.epoch !== epoch) {
          drainPending(ws, conn, slot, epoch);
          return;
        }
      }
    }
    await runCodexChat(ws, conn, slot, codexEarly, {
      prompt,
      compactPrompt,
      userText: text.trim(),
      images: safeImages,
      history: safeHistory,
      epoch: slot.epoch,
      cwd,
      mode,
      confirmWrites,
      autoApprove,
      reviewAppended: codexReviewAppended,
      prewarmedSkills: prewarmedSkills.length ? prewarmedSkills : undefined,
    });
    drainPending(ws, conn, slot, epoch);
    return;
  }

  // P11：第三方模型（"minimax:MiniMax-M2" 等）默认走自研 Agent；providers.json 里 tools: false 的退回纯问答。
  // 历史由客户端随 prompt 上行（iOS 是会话内容权威源）
  const external = externalEarly;
  if (external && external.provider.tools) {
    slot.lastEngine = "native";
    if (wantsMultiModelReview(userText) && !autoApprove && !keepTranscript) {
      send(ws, {
        type: "text-delta",
        chatId: slot.chatId,
        text: "当前模型是第三方直连模型，不能分别调用目录里的其他模型。下面只由这一个模型回答。\n\n",
      });
    }
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
      prewarmedSkills: prewarmedSkills.length ? prewarmedSkills : undefined,
    });
    drainPending(ws, conn, slot, epoch);
    return;
  }
  if (external) {
    slot.lastEngine = "native";
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
  const crewMeta = new Map<string, { agent?: string; model?: string; parentCallId?: string }>();

  const metaFor = (callId: string, name: string, args: unknown, parentCallId?: string) => {
    const parent = parentCallId ? crewMeta.get(parentCallId) : undefined;
    const agent = crewRoleOf(name, args) || parent?.agent;
    const model =
      resolveCrewModel(name, args, slot.reviewRoster) || (crewAgentToken(name, args) ? undefined : parent?.model);
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
    if ((mode !== "ask" && mode !== "plan") || (!isMutatingTool(name, args) && !shellPublishes(name, args)))
      return false;
    if (blockedCalls.has(callId)) return true;
    blockedAsk = true;
    blockedCalls.add(callId);
    slot.runStats.intercepts += 1;
    const reason = mode === "plan" ? "Plan 模式只出方案，点「执行这个计划」才会改文件。" : "Ask 模式已拦截写操作";
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

  const blockExploreWrite = (name: string, args: unknown, callId: string, parentCallId?: string) => {
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

  const startTool = (callId: string, name: string, args: unknown, parentCallId?: string) => {
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

  const finishTool = (callId: string, name: string, status: "completed" | "error", result: unknown, args?: unknown) => {
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
      const rel = raw ? workspacePath(cwd, raw) || "" : "";
      const changed = rel ? [rel] : slot.edited;
      pushWorkspace(ws, slot, conn, changed);
      broadcastFileChanged(slot.tenantId, slot.chatId, changed);
    }
  };

  try {
    let reviewAppended = false;
    if (wantsMultiModelReview(userText) && !autoApprove && !keepTranscript) {
      const panel = slot.reviewRoster || [];
      const apiKey = gatewayEnv.cursorApiKey();
      if (panel.length < 2) {
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: "目录里除了当前模型，没有足够的其他模型可以并行评审。\n\n",
        });
        prompt += "\n\n目录里除了当前模型，没有足够的其他模型可以并行评审。直接告诉用户，不要用同一个模型假装多家。";
        reviewAppended = true;
      } else if (apiKey) {
        prompt += await runReviewPanel(ws, conn, slot, panel, userText, cwd, apiKey, epoch, { files });
        reviewAppended = true;
        if (slot.finished || slot.epoch !== epoch) return;
      }
    }
    if (conn.tenant && (slot.agent || slot.agentId) && !autoApprove && !keepTranscript) {
      const lastRolledTurn = slot.rolledAtTurn ?? gatewayState.assistantRolledAt.get(slot) ?? 0;
      const ctxStats = diskChatContextStats(conn.tenant, slot.chatId, lastRolledTurn);
      if (
        shouldRollSdkSession({
          isAssistant: isAssistantChat(conn.tenant, slot.chatId),
          hasAgent: true,
          autoApprove,
          keepTranscript,
          turns: ctxStats.turns,
          lastRolledTurn,
          contextCharsSinceRoll: ctxStats.contextCharsSinceRoll,
        })
      ) {
        slot.rolledAtTurn = ctxStats.turns;
        gatewayState.assistantRolledAt.set(slot, ctxStats.turns);
        gatewayState.promptSeedBySlot.delete(slot);
        if (slot.agent) await disposeSlot(slot);
        slot.agentId = null;
        slot.reseed = true;
      }
    }
    const baseFullPrompt = prompt;
    if (slot.lastEngine && slot.lastEngine !== "cursor") {
      if (slot.agent) await disposeSlot(slot);
      slot.agentId = null;
      slot.reseed = true;
      gatewayState.promptSeedBySlot.delete(slot);
    }
    slot.lastEngine = "cursor";
    const staticRulesHash = loadStaticRulesFingerprint(cwd, conn.tenant);
    const panelKey = (slot.reviewRoster || []).map((r) => `${r.name}:${r.modelId}`).join(",");
    let turnProgressed = false;
    let lastAttemptInterruptedBeforeTool = false;
    for (let sdkAttempt = 0; ; sdkAttempt += 1) {
      const prevAgentId = slot.agentId;
      const agent = await ensureAgent(conn, slot);
      const reseededNow = Boolean(slot.reseed || (prevAgentId && agent.agentId !== prevAgentId));
      const seedKey = buildPromptSeedKey({
        agentId: agent.agentId,
        cwd,
        mode,
        staticRulesHash,
        assistantBlock,
        dialect: nextDialect,
        panelKey,
      });
      if (reseededNow) {
        prompt = attachReseedContext(conn.tenant, slot.chatId, userText, baseFullPrompt, safeHistory);
        slot.reseed = false;
        turnProgressed = false;
        lastAttemptInterruptedBeforeTool = false;
      } else if (!reviewAppended && gatewayState.promptSeedBySlot.get(slot) === seedKey) {
        prompt = compactPrompt;
      } else {
        prompt = baseFullPrompt;
      }
      const initialPayload = safeImages.length ? { text: prompt, images: safeImages } : prompt;
      const payload =
        sdkAttempt > 0 && turnProgressed
          ? buildSdkContinuationPrompt(lastAttemptInterruptedBeforeTool)
          : initialPayload;
      let attemptSawThinking = false;
      let attemptSawToolCall = false;
      let pendingThinkingBeforeTool = false;
      slot.agentId = agent.agentId;
      if (sdkAttempt === 0) {
        send(ws, { type: "session", chatId: slot.chatId, agentId: agent.agentId, cwd });
        send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
        send(ws, {
          type: "run_meta",
          chatId: slot.chatId,
          model: usedModel,
          mode,
          policy: slot.policy,
          dialect: slot.dialect,
          ...(prewarmedSkills.length ? { prewarmedSkills } : {}),
        });
      } else {
        send(ws, { type: "session", chatId: slot.chatId, agentId: agent.agentId, cwd });
        send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
      }

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

      let attemptClosed = false;
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
      // 模型本轮已发出 turn-ended 且当前没有任何未完成工具时，才启动静默收尾定时器；
      // 只有主模型开始新的输出流（text-delta / thinking-delta / step-started / partial-tool-call）才清除 turnEnded，
      // 工具生命周期与输出事件只重置静默计时器并按 openTools.size 决定是否重新 arm。
      const noteRunActivity = (modelContinuing: boolean) => {
        if (modelContinuing) {
          runWatch.turnEnded = false;
          clearRunQuiet();
          return;
        }
        clearRunQuiet();
        if (!shouldArmRunWatchQuiet(runWatch.turnEnded, slot.openTools?.size ?? 0)) return;
        runWatch.quiet = setTimeout(() => {
          if (attemptClosed || slot.finished || slot.epoch !== epoch) return;
          if (!shouldArmRunWatchQuiet(runWatch.turnEnded, slot.openTools?.size ?? 0)) return;
          runWatch.stop?.();
        }, RUN_QUIET_AFTER_TURN_ENDED_MS);
      };
      const onDelta = ({ update }: { update: unknown }) => {
        if (attemptClosed || slot.finished || slot.epoch !== epoch) return;
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
        const toolName = (tool?: { name?: string; type?: string }) => tool?.name || tool?.type || "tool";
        switch (rec.type) {
          case "text-delta":
            turnProgressed = true;
            noteRunActivity(true);
            if (rec.text) {
              send(ws, { type: "text-delta", chatId: slot.chatId, text: rec.text });
              noteOutput(slot.tenantId, rec.text.length); // P9 计量：模型输出
            }
            break;
          case "thinking-delta":
            turnProgressed = true;
            attemptSawThinking = true;
            pendingThinkingBeforeTool = true;
            noteRunActivity(true);
            if (rec.text) {
              send(ws, { type: "thinking-delta", chatId: slot.chatId, text: rec.text });
              noteOutput(slot.tenantId, rec.text.length); // P9 计量：thinking 也烧 token
            }
            break;
          case "partial-tool-call":
          case "step-started":
          case "token-delta":
            turnProgressed = true;
            attemptSawThinking = true;
            pendingThinkingBeforeTool = true;
            noteRunActivity(true);
            break;
          case "step-completed":
          case "thinking-completed":
          case "summary":
            turnProgressed = true;
            attemptSawThinking = true;
            pendingThinkingBeforeTool = true;
            noteRunActivity(false);
            break;
          case "tool-call-started":
            turnProgressed = true;
            attemptSawToolCall = true;
            pendingThinkingBeforeTool = false;
            startTool(rec.callId || "", toolName(rec.toolCall), rec.toolCall?.args);
            noteRunActivity(false);
            break;
          case "turn-ended":
            runWatch.turnEnded = true;
            noteRunActivity(false);
            break;
          case "shell-output-delta": {
            turnProgressed = true;
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
            finishTool(
              rec.callId || "",
              toolName(rec.toolCall),
              rec.toolCall?.status === "error" ? "error" : "completed",
              rec.toolCall?.result,
              rec.toolCall?.args,
            );
            noteRunActivity(false);
            break;
          case "tool-call-delta": {
            const nested = rec.taskUpdate;
            if (!nested) {
              noteRunActivity(false);
              break;
            }
            if (nested.type === "tool-call-started") {
              turnProgressed = true;
              startTool(nested.callId || "", toolName(nested.toolCall), nested.toolCall?.args, rec.callId);
              noteRunActivity(false);
            } else if (nested.type === "tool-call-completed") {
              finishTool(
                nested.callId || "",
                toolName(nested.toolCall),
                nested.toolCall?.status === "error" ? "error" : "completed",
                nested.toolCall?.result,
                nested.toolCall?.args,
              );
              noteRunActivity(false);
            } else if (nested.type === "shell-output-delta") {
              turnProgressed = true;
              noteRunActivity(false);
              const parsed = parseShellDelta(nested.event || {});
              if (parsed) {
                emitToolOutput(ws, slot, {
                  callId: parsed.callId,
                  stream: parsed.stream,
                  chunk: parsed.chunk,
                });
              }
            } else {
              turnProgressed = true;
              noteRunActivity(false);
            }
            break;
          }
          default:
            noteRunActivity(false);
            break;
        }
      };

      try {
        const startSend = async (opts: typeof sendOpts) => agent.send(payload, { ...opts, onDelta });
        try {
          run = await startSend(sendOpts);
        } catch (err) {
          if (!sendOpts.disallowedTools) throw err;
          slotLog(slot).error("disallowedTools rejected, retrying without them", err);
          const { disallowedTools: _drop, ...rest } = sendOpts;
          run = await startSend(rest);
        }
        gatewayState.promptSeedBySlot.set(slot, seedKey);

        if (slot.epoch !== epoch || slot.finished) {
          attemptClosed = true;
          try {
            await cancelRun(run);
          } catch (err) {
            // Stale run after cancel or a newer prompt.
            slotLog(slot).warn("取消过期运行失败", err instanceof Error ? err.message : err);
          }
          return;
        }
        slot.run = run;
        if (blockedAsk) await cancelRun(run);
        if (slot.awaitingApproval && !autoApprove) {
          attemptClosed = true;
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
              const next = await Promise.race([pending, stopped.then(() => ({ kind: "quiet" as const }))]);
              if (next.kind === "quiet") {
                if (slot.finished || slot.epoch !== epoch) break;
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
                turnProgressed = true;
                noteRunActivity(false);
                send(ws, { type: "task", chatId: slot.chatId, text: event.text });
              }
              if (event.type === "status") {
                if (
                  (event.status === "ERROR" || event.status === "EXPIRED") &&
                  sdkAttempt < MAX_SDK_TRANSIENT_RETRIES &&
                  isTransientSdkError(event.message)
                ) {
                  throw new Error(event.message || event.status);
                }
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
                turnProgressed = true;
                attemptSawToolCall = true;
                pendingThinkingBeforeTool = false;
                startTool(event.call_id, event.name, event.args);
                noteRunActivity(false);
                const snap = snapshotFromResult(event.result);
                if (snap.stdout || snap.stderr) {
                  emitToolOutput(ws, slot, { callId: event.call_id, ...snap });
                }
              }
              if (event.type === "tool_call" && (event.status === "completed" || event.status === "error")) {
                finishTool(event.call_id, event.name, event.status, event.result, event.args);
                noteRunActivity(false);
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
            attemptClosed = true;
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
              const waitedErrorMsg = (waited as { error?: { message?: string } })?.error?.message;
              if (
                normalizeRunStatus(waited.status) === "error" &&
                sdkAttempt < MAX_SDK_TRANSIENT_RETRIES &&
                isTransientSdkError(waitedErrorMsg)
              ) {
                throw new Error(waitedErrorMsg || "resource_exhausted");
              }
              result = { status: normalizeRunStatus(waited.status), durationMs: waited.durationMs };
            } catch (err) {
              const timedOut = err instanceof Error && err.message === "timeout";
              if (!timedOut && !isAbortError(err)) throw err;
              if (timedOut) await cancelRun(run);
              result = {
                status: slot.awaitingApproval ? "approval" : normalizeRunStatus(streamStatus),
              };
            }
            attemptClosed = true;
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
              // pushWorkspace 现在是异步的；等它发完再收尾，保持“文件推送在 done 之前”的顺序
              await pushWorkspace(ws, slot, conn, slot.edited);
            }
            await settleWorkspacePushes(ws);
            finishRun(ws, slot, slot.awaitingApproval ? "approval" : result.status, result.durationMs, epoch);
          }
        }
        break;
      } catch (err) {
        attemptClosed = true;
        const canRetry =
          !replayApproved &&
          !blockedAsk &&
          !slot.awaitingApproval &&
          !slot.finished &&
          slot.epoch === epoch &&
          sdkAttempt < MAX_SDK_TRANSIENT_RETRIES &&
          isTransientSdkError(err);
        if (!canRetry) throw err;

        const failedRun = run;
        run = null;
        await cancelRun(failedRun);
        // cancelRun 异步等待期间，若用户已取消、切了新会话或进入审批，不再继续旧栈重试
        if (slot.finished || slot.epoch !== epoch || slot.awaitingApproval || replayApproved || blockedAsk) {
          return;
        }
        if (slot.run === failedRun) slot.run = null;
        if (slot.openTools && slot.openTools.size > 0) {
          for (const [callId, meta] of slot.openTools) {
            send(ws, {
              type: "tool-completed",
              chatId: slot.chatId,
              callId,
              name: meta.name,
              status: "error",
              result: "因上游限流或瞬断中断，正在自动续跑",
              parentCallId: meta.parentCallId,
              agent: meta.agent,
              model: meta.model,
            });
          }
          slot.openTools.clear();
        }
        startedCalls.clear();
        lastAttemptInterruptedBeforeTool = (attemptSawThinking && !attemptSawToolCall) || pendingThinkingBeforeTool;
        const reason = err instanceof Error ? err.message : String(err);
        const isNoProgressResume = /repeated resume attempts made no progress/i.test(reason);
        const isMissingAgent = /agent[-_ ].*not found/i.test(reason);
        if (isNoProgressResume || isMissingAgent) {
          flushTranscript(slot, false);
          await disposeSlot(slot);
          if (slot.finished || slot.epoch !== epoch || slot.awaitingApproval || replayApproved || blockedAsk) {
            return;
          }
          if (isMissingAgent) {
            slot.agentId = null;
            slot.reseed = true;
            turnProgressed = false;
          } else {
            // repeated resume attempts made no progress：保留 agentId，由下一轮 ensureAgent 重新 Agent.resume 并发送续跑指令
            turnProgressed = true;
          }
        }
        const waitMs = sdkRetryDelayMs(sdkAttempt);
        const statusHint = isNoProgressResume
          ? `检测到后台长任务恢复停滞，${Math.ceil(waitMs / 1000)} 秒后第 ${sdkAttempt + 1} 次自动续跑…`
          : `触发上游速率限制或连接瞬断（${reason.slice(0, 60)}），${Math.ceil(waitMs / 1000)} 秒后第 ${sdkAttempt + 1} 次自动续跑…`;
        slotLog(slot).warn("SDK 瞬时错误，退避后自动续跑", { attempt: sdkAttempt + 1, waitMs, reason });
        send(ws, {
          type: "status",
          chatId: slot.chatId,
          status: "RUNNING",
          message: statusHint,
        });
        const stillActive = await waitWithSlotCheck(slot, epoch, waitMs);
        if (!stillActive) return;
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
      finishRun(ws, slot, slot.awaitingApproval ? "approval" : "cancelled", undefined, epoch);
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
export function drainPending(ws: WebSocket, conn: Conn, slot: Slot, epoch?: number) {
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
      const ownerConn = gatewayState.conns.get(owner);
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
