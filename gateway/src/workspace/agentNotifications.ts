// 工作区主会话的“需要注意”事件：每轮只计一次未读，审批优先占用这一轮的序号。
import { sendApns } from "../assistant/apns.ts";
import { pushBadge } from "../assistant/service.ts";
import { slotLog } from "../log.ts";
import type { Slot } from "../runtime/types.ts";
import { getTenant } from "../tenants.ts";
import { noteWorkspaceAgentAttention } from "./agents.ts";

export function notifyWorkspaceAgentAttention(slot: Slot, kind: "approval" | "completed" | "failed") {
  const tenant = getTenant(slot.tenantId);
  if (!tenant) return;
  const turnId = slot.transcript?.turnId || "";
  const noted = noteWorkspaceAgentAttention(tenant, slot.chatId, turnId, kind);
  if (!noted || noted.watched || !noted.firstForTurn) return;
  const title = kind === "approval" ? "工作区需要处理" : kind === "failed" ? "工作区任务失败" : "工作区有新回复";
  const routeKind =
    kind === "approval" ? "workspace_agent_approval" : kind === "failed" ? "workspace_agent_failed" : "workspace_agent";
  void pushBadge(tenant)
    .then((badgeParts) =>
      sendApns(
        { id: tenant.id, stateDir: tenant.stateDir },
        {
          itemId: `workspace-${slot.chatId}-${noted.item.lastFinishedSeq}`,
          kind: routeKind,
          title,
          body: "",
          chatId: slot.chatId,
          channel: "workspace",
          threadId: `workspace-${slot.chatId}`,
          priority: kind === "approval" ? 10 : undefined,
          badgeParts,
          cr: { kind: routeKind, chatId: slot.chatId },
          redactLog: true,
        },
      ),
    )
    .catch((error) => slotLog(slot).error("workspace apns", error));
}
