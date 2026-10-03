import { addApproval, settleApproval } from "./approvals.ts";
import { postInbox } from "./inbox.ts";
import type { TenantRef } from "./store.ts";

/**
 * 助理想新建工作区时的“先问用户”。
 * 工具调用停在这里等答复：同时落一条挂起审批（客户端在助理对话里渲染成确认卡）和一条收件箱消息（推送用）。
 * 答复走 assistant_op approval_answer，和委派子会话的审批共用同一个入口。
 */

export type WorkspaceAskOutcome = "allowed" | "denied" | "expired";

export const WORKSPACE_ASK_TOOL = "create_workspace";
export const WORKSPACE_ASK_TTL_MS = 30 * 60_000;

type Waiter = { tenantId: string; chatId: string; resolve: (outcome: WorkspaceAskOutcome) => void };

const waiters = new Map<string, Waiter>();

export function askWorkspace(
  ref: TenantRef,
  input: { chatId: string; name: string; reason: string; ttlMs?: number },
  onChange: () => void,
): Promise<WorkspaceAskOutcome> {
  const callId = crypto.randomUUID();
  const ttlMs = input.ttlMs ?? WORKSPACE_ASK_TTL_MS;
  const reason = input.reason.trim();
  addApproval(
    ref,
    {
      chatId: input.chatId,
      callId,
      tool: WORKSPACE_ASK_TOOL,
      summary: reason ? `${input.name} · ${reason}` : input.name,
      parentChatId: input.chatId,
    },
    Date.now(),
    ttlMs,
  );
  postInbox(ref, {
    kind: "approval",
    title: `助理想新建工作区「${input.name}」，等你确认`,
    body: reason ? `原因：${reason}\n在助理对话里点“同意”或“拒绝”。${Math.round(ttlMs / 60_000)} 分钟没答复就取消。` : "在助理对话里点“同意”或“拒绝”。",
    key: `approval:${input.chatId}:${callId}`,
    chatId: input.chatId,
  });
  onChange();
  return new Promise<WorkspaceAskOutcome>((resolve) => {
    const timer = setTimeout(() => finish("expired"), ttlMs);
    const finish = (outcome: WorkspaceAskOutcome) => {
      clearTimeout(timer);
      if (!waiters.delete(callId)) return;
      settleApproval(ref, input.chatId, callId);
      onChange();
      resolve(outcome);
    };
    waiters.set(callId, { tenantId: ref.id, chatId: input.chatId, resolve: finish });
  });
}

/** 作答。不是这类审批返回 false，让调用方继续按委派审批处理 */
export function answerWorkspaceAsk(ref: TenantRef, chatId: string, callId: string, allow: boolean) {
  const waiter = waiters.get(callId);
  if (!waiter || waiter.tenantId !== ref.id || waiter.chatId !== chatId) return false;
  waiter.resolve(allow ? "allowed" : "denied");
  return true;
}
