// 会话槽位：恢复、删除、新建、审批回复、取消、丢弃排队、切模型、改策略
import { parsePolicy } from "../../../../shared/policy.ts";
import { confinedCwd } from "../../tenants.ts";
import { deleteSession } from "../../native/session.ts";
import { cancelRun } from "../../runtime/abort.ts";
import { resolveApprovalWait } from "../../runtime/approvals.ts";
import { isAssistantChat } from "../../runtime/chats.ts";
import { cwdOf, diskSlot, disposeSlot, lockedChatCwd, persistConn, slotOf } from "../../runtime/slots.ts";
import { emitStoredState } from "../../sync/storedState.ts";
import { sendCheckpoints } from "../../workspace/checkpoints.ts";
import { ensureWorkspaceDir } from "../../workspace/workspaces.ts";
import { send } from "../send.ts";
import { finishRun } from "../../chat/finish.ts";
import { forgetChat } from "../../chat/forget.ts";
import { sendAgentHistory } from "../../chat/history.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export function onResumeSession({ ws, conn, tenant }: WsCtx, message: MessageOf<"resume_session">) {
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
}

export async function onDeleteSession({ ws, conn, tenant }: WsCtx, message: MessageOf<"delete_session">) {
  if (isAssistantChat(tenant, message.chatId)) {
    send(ws, { type: "error", chatId: message.chatId, message: "助理会话不能删除。" });
    emitStoredState(ws, tenant);
    return;
  }
  await forgetChat(conn, message.chatId);
  emitStoredState(ws, tenant);
}

export async function onNewSession({ ws, conn, tenant }: WsCtx, message: MessageOf<"new_session">) {
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
    lockedChatCwd(tenant, slot.chatId) || (message.cwd ? confinedCwd(message.cwd, tenant.workspaceRoot) : null);
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
}

export function onApprovalReply({ conn }: WsCtx, message: MessageOf<"approval_reply">) {
  const slot = slotOf(conn, message.chatId);
  // 迟到的回复（旧工具、已超时）不能批准当前正在等的另一项
  if (message.callId && slot.approvalCallId && message.callId !== slot.approvalCallId) return;
  resolveApprovalWait(slot, Boolean(message.allow));
}

export async function onCancel({ ws, conn }: WsCtx, message: MessageOf<"cancel">) {
  const slot = slotOf(conn, message.chatId);
  resolveApprovalWait(slot, false);
  const alreadyDone = slot.finished;
  slot.externalAbort?.abort(); // P11：第三方在途请求（无 RunHandle，走 AbortController）
  await cancelRun(slot.run);
  finishRun(ws, slot, "cancelled");
  if (alreadyDone) {
    send(ws, { type: "done", chatId: slot.chatId, status: "cancelled" });
  }
}

export function onDropQueued({ conn }: WsCtx, message: MessageOf<"drop_queued">) {
  const slot = slotOf(conn, message.chatId);
  const needle = (message.text || "").trim();
  if (!needle) slot.pending = [];
  else {
    const index = slot.pending.findIndex((item) => item.text.trim() === needle);
    if (index >= 0) slot.pending.splice(index, 1);
  }
}

export function onSetModel({ conn }: WsCtx, message: MessageOf<"set_model">) {
  const id = message.model.trim();
  if (id) {
    conn.model = id;
    if (message.chatId) slotOf(conn, message.chatId).model = id;
  }
}

export async function onSetPolicy({ ws, conn }: WsCtx, message: MessageOf<"set_policy">) {
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
}
