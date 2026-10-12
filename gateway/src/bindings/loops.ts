// loops.ts 的宿主回调：忙闲判断、派发一拍、推送 loop 状态（bindLoops 调用留在 index.ts）
import { WebSocket } from "ws";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { runLoopInBackground } from "../assistant/service.ts";
import { handlePrompt } from "../chat/runner.ts";
import type { LoopJob } from "../loops.ts";
import { cwdForChat, globalRunningCount, maxRunning, slotOf } from "../runtime/slots.ts";
import { conns, liveSlotsOf } from "../runtime/state.ts";
import type { Conn } from "../runtime/types.ts";
import { getTenant } from "../tenants.ts";
import { reply } from "../ws/frame.ts";

export function openConn(tenantId: string): Conn | undefined {
  for (const conn of conns.values()) {
    if (conn.authed && conn.tenant?.id === tenantId && conn.ws.readyState === WebSocket.OPEN) return conn;
  }
  return undefined;
}

export function loopBusy(tenantId: string, chatId: string): false | { reason: string; retryMs?: number } {
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

export async function dispatchLoop(job: LoopJob) {
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

export function publishLoop(tenantId: string, message: ServerMessage) {
  for (const conn of conns.values()) {
    if (conn.authed && conn.tenant?.id === tenantId) reply(conn.ws, message);
  }
}
