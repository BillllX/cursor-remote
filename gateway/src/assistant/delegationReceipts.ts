import { getDelegation, updateDelegation, type Delegation } from "./delegations.ts";
import { postInbox } from "./inbox.ts";
import type { TenantRef } from "./store.ts";

/** 先落盘终态，后写收件箱。崩溃后用同一轮次键补发，已经写入的条目不会重复。 */
export function deliverDelegationReceipt(ref: TenantRef, item: Delegation) {
  if (!item.receiptPending || item.notifyPolicy === "collab_only") return;
  const current = getDelegation(ref, item.id);
  if (!current?.receiptPending || current.id !== item.id || current.attempt !== item.attempt ||
      current.notifyPolicy === "collab_only" || (current.status !== "done" && current.status !== "failed" && current.status !== "cancelled")) return;
  const key = (current.attempt ?? 1) === 1 ? `delegation:${current.id}` : `delegation:${current.id}:${current.attempt}`;
  postInbox(ref, {
    kind: "delegation",
    attention: current.status === "done" || current.status === "cancelled" ? "notice" : "recovery",
    title: `委派${current.status === "cancelled" ? "已取消" : current.interrupted ? "被中断" : current.status === "done" ? "完成" : "失败"}：${current.title}`,
    body: current.result?.slice(0, 3000) || "（没有输出）",
    key,
    chatId: current.childChatId,
    delegationId: current.id,
    delegationReceipt: { attempt: current.attempt ?? 1, status: current.status, files: current.deliveredFiles ?? [] },
  });
  updateDelegation(ref, current.id, { receiptPending: false });
}
