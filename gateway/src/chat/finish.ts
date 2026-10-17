// 一轮运行收尾：关闭未结束的工具、本轮文件改动、索引用户消息、工作区轮次记录
import type { WebSocket } from "ws";
import type { TurnFile } from "../../../shared/protocol.ts";
import { noteUserTurn, noteWorkspaceTurnEnd } from "../assistant/service.ts";
import { attachDelegatedFiles, mergeTurnFiles } from "../delegationFiles.ts";
import { broadcastFileChanged, broadcastTurnFiles } from "../fileEvents.ts";
import { slotLog } from "../log.ts";
import { assistantCwd, chatIdOf, isAssistantChat } from "../runtime/chats.ts";
import type { Slot } from "../runtime/types.ts";
import { flushTranscript, stopRunFlush } from "../sync/transcript.ts";
import { getTenant, requireCwd } from "../tenants.ts";
import { computeTurnFiles, type TurnBaseline } from "../turnFiles.ts";
import { noteRun } from "../usage.ts";
import { checkpointGit, workspacePrefix } from "../workspace/checkpoints.ts";
import { listWorkspaceFiles, readWorkspaceDiff } from "../workspace/files.ts";
import { send } from "../ws/send.ts";
import { notifyWorkspaceAgentAttention } from "../workspace/agentNotifications.ts";

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

export function finishRun(ws: WebSocket, slot: Slot, status: string, durationMs?: number, epoch?: number) {
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
    broadcastTurnFiles(slot.tenantId, slot.chatId, turnId, files);
    // shell 等工具可能无法在完成事件里精确报告 changed；回合清单是统一兜底。
    broadcastFileChanged(
      slot.tenantId,
      slot.chatId,
      files.filter((file) => !file.sourceChatId).map((file) => file.path),
    );
    const tenant = getTenant(slot.tenantId);
    const parent = tenant ? attachDelegatedFiles(tenant, slot, turnId, files) : null;
    if (parent) broadcastTurnFiles(slot.tenantId, parent.chatId, parent.turnId, parent.files);
  }
  if (!approval && !/cancel/i.test(status)) {
    notifyWorkspaceAgentAttention(slot, /error|fail/i.test(status) ? "failed" : "completed");
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
    const delegated = (transcript.files || []).filter((file) => Boolean(file.sourceChatId));
    const merged = mergeTurnFiles(files, delegated);
    if (merged.length) transcript.files = merged;
    else delete transcript.files;
    return merged;
  } catch (err) {
    slotLog(slot).error("turn files", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 助理会话每轮完成后进会话搜索索引；其他会话不进 */
function indexUserTurn(slot: Slot) {
  const tenant = getTenant(slot.tenantId);
  const transcript = slot.transcript;
  if (!tenant || !transcript || !isAssistantChat(tenant, slot.chatId)) return;
  const chat = tenant.disk.chats.find((item) => chatIdOf(item) === slot.chatId) as
    { title?: unknown; turns?: unknown[] } | undefined;
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
    slotLog(slot).error("index user turn", err);
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
    slotLog(slot).error("workspace turn", err);
  }
}
