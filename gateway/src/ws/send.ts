// 向连接发送消息：流式事件跟随 owner、记入 transcript，并给同租户其它设备节流推送快照
import { WebSocket } from "ws";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { applyStreamEvent, clipSnapshot, isStreamEvent, snapshotMessage } from "../runlog.ts";
import { noteDelegationApproval } from "../runtime/approvals.ts";
import { slotByChat } from "../runtime/slots.ts";
import { gatewayState } from "../runtime/state.ts";
import type { Slot } from "../runtime/types.ts";
import { notifyWorkspaceAgentAttention } from "../workspace/agentNotifications.ts";
import { frameFor, reply } from "./frame.ts";

export function send(ws: WebSocket, message: ServerMessage) {
  const chatId = "chatId" in message && typeof message.chatId === "string" ? message.chatId : "";
  const tenantId = gatewayState.wsTenant.get(ws);
  const slot = chatId && tenantId ? slotByChat(tenantId, chatId) : undefined;
  if (slot?.transcript && isStreamEvent(message.type)) applyStreamEvent(slot.transcript, message);
  // applyStreamEvent 先写 awaitingApproval，再广播列表/快照；非 owner 收到的快照可直接恢复审批卡。
  if (message.type === "approval" && slot?.transcript) notifyWorkspaceAgentAttention(slot, "approval");
  let out = message;
  if (message.type === "tool-started" && slot?.transcript) {
    const at = slot.transcript.tools.find((item) => item.callId === message.callId)?.at;
    if (typeof at === "number") out = { ...message, at };
  }
  const capturing = slot && (slot.captureText || slot.captureError) ? slot : undefined;
  if (message.type === "text-delta") capturing?.captureText?.(message.text);
  if (message.type === "error" && "message" in message) capturing?.captureError?.(message.message);
  if (message.type === "done") capturing?.captureDone?.(message.status);
  if (message.type === "approval" && slot?.delegationId)
    noteDelegationApproval(slot, message.callId, message.name, message.args);
  // 流式事件跟当前 owner。应答仍回发起连接，避免翻页或写文件被另一台设备抢走。
  const owner = isStreamEvent(message.type) && slot?.owner?.readyState === WebSocket.OPEN ? slot.owner : null;
  const sock = owner || (ws.readyState === WebSocket.OPEN ? ws : null);
  const frame = sock ? frameFor(sock, out) : null;
  if (sock && frame !== null) sock.send(frame);
  if (slot && isStreamEvent(message.type)) mirrorRun(slot, message.type === "done");
}

const MIRROR_MS = 800;

/** 其他设备收不到逐字增量，改发累计快照（按 turnId 替换），done 立即补最后一份。 */
export function mirrorRun(slot: Slot, now = false) {
  if (now) {
    flushMirror(slot);
    return;
  }
  if (slot.mirrorTimer) return;
  slot.mirrorTimer = setTimeout(() => flushMirror(slot), MIRROR_MS);
}

function flushMirror(slot: Slot) {
  if (slot.mirrorTimer) {
    clearTimeout(slot.mirrorTimer);
    slot.mirrorTimer = undefined;
  }
  const transcript = slot.transcript;
  if (!transcript || transcript.epoch !== slot.epoch) return;
  const live = slot.owner?.readyState === WebSocket.OPEN ? slot.owner : null;
  let full: ServerMessage | null = null;
  for (const conn of gatewayState.conns.values()) {
    if (conn.ws === live || !conn.authed || conn.tenant?.id !== slot.tenantId) continue;
    if (conn.ws.readyState !== WebSocket.OPEN) continue;
    full ??= snapshotMessage(slot.chatId, transcript, queuedRows(slot));
    reply(conn.ws, clipSnapshot(full, conn.maxMessageBytes));
  }
}

export function queuedRows(slot: Slot) {
  return slot.pending
    .filter((item) => item.text.trim() || item.turnId)
    .map((item) => ({ turnId: item.turnId, userText: item.text }));
}
