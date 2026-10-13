// 原生 harness（自研工具循环）对话运行
import type { WebSocket } from "ws";
import { isPlane, toolFingerprint } from "../../../shared/policy.ts";
import type { AgentMode } from "../../../shared/protocol.ts";
import { assistantName, chatToolHost, workspaceToolsFor } from "../assistant/service.ts";
import { assistantToolSpecs, toolSpecs } from "../assistant/tools.ts";
import { log, slotLog } from "../log.ts";
import { adapterFor } from "../native/adapters/index.ts";
import { budgetFor, makeCompactor, modelSummarizer } from "../native/compact.ts";
import { buildSystemPrompt } from "../native/context.ts";
import { runNativeLoop } from "../native/loop.ts";
import { mcpTools } from "../native/mcp.ts";
import { loadSession, resumeMessages, saveSession, sessionKey } from "../native/session.ts";
import { toolsForMode } from "../native/tools/registry.ts";
import { findBwrap, isReadOnlyCommand, shellTool } from "../native/tools/shell.ts";
import { taskTool } from "../native/tools/task.ts";
import type { ChatMessage, ToolSpec } from "../native/types.ts";
import { type ChatHistoryItem, endpointFor, type ExternalProvider } from "../providers.ts";
import { rememberApproved, waitForApproval } from "../runtime/approvals.ts";
import { isAssistantChat } from "../runtime/chats.ts";
import type { Conn, Slot } from "../runtime/types.ts";
import { sandboxEnabledForTenant, stateDir, workspaceFenceForTenant } from "../tenants.ts";
import { noteModelTokens, noteOutput, noteToolCall } from "../usage.ts";
import { nativeStateDir, rollbackToLatestCheckpoint } from "../workspace/checkpoints.ts";
import { pushWorkspace, settleWorkspacePushes } from "../workspace/files.ts";
import { mayPublishHere } from "../workspace/workspaces.ts";
import { send } from "../ws/send.ts";
import { ensureTurnBaseline, recordRunCheckpoint } from "./baseline.ts";
import { finishRun } from "./finish.ts";
import { rememberEdit, shellPublishes, summarizeToolArgs, toolEscapesWorkspace } from "./tools.ts";

const NATIVE_RESULT_PREVIEW = 4000;

function lastUserMessageIndex(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

/** 自研 Agent 的一轮：工具调用循环跑在网关里，事件映射成与 Cursor run 相同的协议，
 *  审批、检查点、撤销、计量都复用现有机制。 */
export async function runNativeChat(
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
  send(ws, {
    type: "run_meta",
    chatId: slot.chatId,
    model: ext.full,
    mode,
    policy: slot.policy,
    dialect: slot.dialect,
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
  if (mcp.errors.length) slotLog(slot).error("mcp", mcp.errors.join(" | "));
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
      return "命令的工作目录、输出重定向或写入的路径超出了当前工作区，已拦截。";
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
      result.content.length > NATIVE_RESULT_PREVIEW
        ? `${result.content.slice(0, NATIVE_RESULT_PREVIEW)}…`
        : result.content;
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
      log.info(
        `native compact chat=${slot.chatId} stage=${info.stage} ${info.before}→${info.after} summarized=${info.summarized}`,
      );
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
      saveSession(stateDirOf, slot.chatId, {
        model: ext.full,
        userKeys: errored ? prior.userKeys : userKeys,
        messages: saved,
      });
    } catch (err) {
      slotLog(slot).error("native session save", err instanceof Error ? err.message : err);
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
          send(ws, {
            type: "tool-output",
            chatId: slot.chatId,
            callId: call.id,
            stream,
            chunk: chunk.stderr ?? chunk.stdout ?? "",
          });
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
      send(ws, {
        type: "text-delta",
        chatId: slot.chatId,
        text: `\n\n已达到单轮 ${result.steps} 步上限，先停在这里。回复「继续」接着做。`,
      });
    }
    if (result.status === "error") {
      send(ws, { type: "error", chatId: slot.chatId, message: result.error || `${ext.provider.name} 调用失败` });
      finishRun(ws, slot, "error", Date.now() - t0, epoch);
      return;
    }
    // 工具完成时的文件推送是异步的；收尾前等它们发完，保持“文件推送在 done 之前”的顺序（最多等 5 秒）
    await settleWorkspacePushes(ws);
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
