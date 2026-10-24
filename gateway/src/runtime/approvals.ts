// 审批等待：解除/记住/超时等待，以及委派子会话审批进收件箱
import { toolFingerprint } from "../../../shared/policy.ts";
import { addApproval, APPROVAL_TTL_MS, settleApproval, summarizeArgs } from "../assistant/approvals.ts";
import { getDelegation, updateDelegation } from "../assistant/delegations.ts";
import { postInbox } from "../assistant/inbox.ts";
import { publishDelegation } from "../assistant/service.ts";
import { emitCollabSideEvent } from "../collab/sink.ts";
import { getTenant } from "../tenants.ts";
import type { Slot } from "./types.ts";

export function resolveApprovalWait(slot: Slot, allow: boolean) {
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

export function rememberApproved(slot: Slot) {
  const id = slot.approvalCallId;
  const tool = id ? slot.openTools.get(id) : undefined;
  if (tool) slot.approvedKeys.add(toolFingerprint(tool.name, tool.args));
}

export function waitForApproval(slot: Slot, ms = slot.approvalTimeoutMs ?? 120_000) {
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

export function noteDelegationApproval(slot: Slot, callId: string, tool: string, args: unknown) {
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
  if (record.notifyPolicy === "collab_only" && record.collabTaskId) {
    void emitCollabSideEvent(tenant, {
      taskId: record.collabTaskId,
      type: "approval",
      payload: {
        approvalId: approval.id,
        callId,
        tool,
        summary: approval.summary,
        expiresAt: approval.expiresAt,
      },
    });
    return;
  }
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
  if (record?.notifyPolicy === "collab_only" && record.collabTaskId) {
    void emitCollabSideEvent(tenant, {
      taskId: record.collabTaskId,
      type: "approval_expired",
      payload: { callId: slot.approvalCallId ?? "" },
    });
    return;
  }
  postInbox(tenant, {
    kind: "delegation",
    title: `委派「${record?.title ?? ""}」的审批超时`,
    body: "24 小时没人答，已按拒绝处理。子会话里可以重新交代。",
    key: `approval-expired:${slot.chatId}:${slot.approvalCallId ?? ""}`,
    chatId: slot.chatId,
    delegationId: slot.delegationId,
  });
}
