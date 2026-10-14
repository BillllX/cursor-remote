// 删除会话：停 loop、取消运行、清槽位与会话存档
import { publishLoop } from "../bindings/loops.ts";
import { stopLoop } from "../loops.ts";
import { deleteSession } from "../native/session.ts";
import { cancelRun } from "../runtime/abort.ts";
import { resolveApprovalWait } from "../runtime/approvals.ts";
import { isAssistantChat } from "../runtime/chats.ts";
import { chatIdsFrom, disposeSlot, persistConn, pruneDroppedSlots } from "../runtime/slots.ts";
import type { Conn } from "../runtime/types.ts";
import { broadcastDigest, tombstoneChat } from "../sync/storedState.ts";
import { stopRunFlush } from "../sync/transcript.ts";
import { forgetWorkspaceAgentChat } from "../workspace/agents.ts";

export async function forgetChat(conn: Conn, chatId: string) {
  const tenant = conn.tenant;
  if (!tenant || isAssistantChat(tenant, chatId)) return;
  tombstoneChat(tenant, chatId);
  forgetWorkspaceAgentChat(tenant, chatId);
  const stopped = stopLoop(tenant.id, chatId);
  if (stopped) publishLoop(tenant.id, { type: "loop_state", ...stopped });
  const slot = conn.slots.get(chatId);
  if (slot) {
    resolveApprovalWait(slot, false);
    slot.pending = []; // 删除会话不续跑排队消息（旧 external 栈返回后 drain 会扑空，Grok R2）
    stopRunFlush(slot);
    slot.transcript = undefined;
    slot.epoch += 1; // 过期门：旧栈 finishRun/drainPending 一律失效
    await cancelRun(slot.run);
    await disposeSlot(slot);
    conn.slots.delete(chatId);
  }
  deleteSession(tenant.stateDir, chatId);
  tenant.disk.slots = tenant.disk.slots.filter((item) => item.chatId !== chatId);
  pruneDroppedSlots(tenant, chatIdsFrom(tenant.disk.chats));
  tenant.disk.rev += 1;
  persistConn(conn);
  // 删除方自己也要收到：rev 前进了，不对齐的话它下一次 sync_chat 会被拒一轮
  broadcastDigest(tenant);
}
