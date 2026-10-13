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
import { clockLine, noteWorkspaceTurnStart, userRootPreamble } from "../assistant/service.ts";
import { gatewayEnv } from "../config.ts";
import { log, slotLog } from "../log.ts";
import { deleteSession } from "../native/session.ts";
import { type ChatHistoryItem, externalRoute } from "../providers.ts";
import { cancelRun, isAbortError, withTimeout } from "../runtime/abort.ts";
import { rememberApproved, resolveApprovalWait, waitForApproval } from "../runtime/approvals.ts";
import { isAssistantChat } from "../runtime/chats.ts";
import { cwdOf, disposeSlot, globalRunningCount, maxRunning } from "../runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../runtime/state.ts";
import type { Conn, RunHandle, Slot } from "../runtime/types.ts";
import { continueTranscript, openTranscript } from "../sync/transcript.ts";
import { allTenants, workspaceFenceForTenant } from "../tenants.ts";
import { noteOutput, noteToolCall } from "../usage.ts";
import { nativeStateDir, rollbackToLatestCheckpoint, undoEdits } from "../workspace/checkpoints.ts";
import { pushWorkspace, settleWorkspacePushes, workspacePath } from "../workspace/files.ts";
import { isUserWorkspace, mayPublishHere } from "../workspace/workspaces.ts";
import { send } from "../ws/send.ts";
import { ensureAgent } from "./agent.ts";
import { sanitizeImages } from "./attachments.ts";
import { ensureTurnBaseline, recordRunCheckpoint } from "./baseline.ts";
import { runExternalChat } from "./external.ts";
import { finishRun } from "./finish.ts";
import { attachReseedContext, diskChatTurns } from "./history.ts";
import { runNativeChat } from "./native.ts";
import { loadWorkspaceRules, wrapPrompt } from "./prompt.ts";
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
const ASSISTANT_ROLL_TURNS = 40;

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
  const safeHistory = (history ?? []).filter(
    (h): h is ChatHistoryItem => !!h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string",
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
  const usedModel = promptModel(model, slot, conn);
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
      slotLog(slot).error("assistant preamble", err);
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
        prompt += "\n\n目录里除了当前模型，没有足够的其他模型可以并行评审。直接告诉用户，不要用同一个模型假装多家。";
      } else if (apiKey) {
        prompt += await runReviewPanel(ws, conn, slot, panel, userText, cwd, apiKey, epoch);
        if (slot.finished || slot.epoch !== epoch) return;
      }
    }
    if (isAssistantChat(conn.tenant, slot.chatId) && (slot.agent || slot.agentId)) {
      const turns = diskChatTurns(conn.tenant, slot.chatId).length;
      if (turns > 0 && turns % ASSISTANT_ROLL_TURNS === 0 && gatewayState.assistantRolledAt.get(slot) !== turns) {
        gatewayState.assistantRolledAt.set(slot, turns);
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
      const toolName = (tool?: { name?: string; type?: string }) => tool?.name || tool?.type || "tool";
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
            startTool(nested.callId || "", toolName(nested.toolCall), nested.toolCall?.args, rec.callId);
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

    const startSend = async (opts: typeof sendOpts) => agent.send(payload, { ...opts, onDelta });
    try {
      run = await startSend(sendOpts);
    } catch (err) {
      if (!sendOpts.disallowedTools) throw err;
      slotLog(slot).error("disallowedTools rejected, retrying without them", err);
      const { disallowedTools: _drop, ...rest } = sendOpts;
      run = await startSend(rest);
    }

    if (slot.epoch !== epoch || slot.finished) {
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
          if (event.type === "tool_call" && (event.status === "completed" || event.status === "error")) {
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
          // pushWorkspace 现在是异步的；等它发完再收尾，保持“文件推送在 done 之前”的顺序
          await pushWorkspace(ws, slot, conn, slot.edited);
        }
        await settleWorkspacePushes(ws);
        finishRun(ws, slot, slot.awaitingApproval ? "approval" : result.status, result.durationMs, epoch);
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
