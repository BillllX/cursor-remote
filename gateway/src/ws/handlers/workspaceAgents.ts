// 工作区 Agent 的列表、打开、资料、已读和查看状态协议。
import {
  markWorkspaceAgentRead,
  openWorkspaceAgent,
  updateWorkspaceAgentProfile,
  workspaceAgentByChat,
  workspaceAgentsMessage,
} from "../../workspace/agents.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";
import { pushBadge } from "../../assistant/service.ts";
import { sendApns } from "../../assistant/apns.ts";
import { imRuntime } from "../../im/runtime.ts";

export function onWorkspaceAgentList({ ws, tenant }: WsCtx, message: MessageOf<"workspace_agent_list">) {
  send(ws, workspaceAgentsMessage(tenant, message.cursor));
}

export function onWorkspaceAgentOpen({ ws, tenant }: WsCtx, message: MessageOf<"workspace_agent_open">) {
  const opened = openWorkspaceAgent(tenant, message.path);
  if (!opened) {
    send(ws, { type: "error", message: "这个工作区不存在、已隐藏或不是一级目录。" });
    return;
  }
  send(ws, { type: "workspace_agent_opened", path: opened.path, chatId: opened.chatId });
}

export async function onWorkspaceAgentProfile({ ws, tenant }: WsCtx, message: MessageOf<"workspace_agent_profile">) {
  const avatar = message.avatar === undefined ? undefined : message.avatar?.trim() || null;
  if (avatar && !/^[0-9a-f]{64}$/.test(avatar)) {
    send(ws, { type: "error", message: "头像编号不合法。" });
    return;
  }
  if (avatar) {
    const meta = await imRuntime().store.blobMeta(avatar);
    if (!meta?.kinds.avatar || !meta.uploaders.includes(tenant.id) || meta.size > 5 * 1024 * 1024) {
      send(ws, { type: "error", message: "这个头像不是当前账号上传的有效头像。" });
      return;
    }
  }
  if (!updateWorkspaceAgentProfile(tenant, message.path, message.displayName, avatar)) {
    send(ws, { type: "error", message: "这个工作区不存在或不可见。" });
  }
}

export function onWorkspaceAgentRead({ ws, tenant }: WsCtx, message: MessageOf<"workspace_agent_read">) {
  if (!markWorkspaceAgentRead(tenant, message.chatId, message.seq)) {
    send(ws, { type: "error", chatId: message.chatId, message: "找不到这个工作区会话。" });
    return;
  }
  const found = workspaceAgentByChat(tenant, message.chatId);
  if (found) {
    send(ws, {
      type: "workspace_agent_update",
      chatId: message.chatId,
      unread: found.item.unread,
      readSeq: found.item.lastReadSeq,
      finishedSeq: found.item.lastFinishedSeq,
    });
    void pushBadge(tenant)
      .then((badgeParts) =>
        sendApns(
          { id: tenant.id, stateDir: tenant.stateDir },
          {
            itemId: `workspace-read-${message.chatId}`,
            kind: "workspace_agent_read",
            title: "",
            body: "",
            channel: "workspace",
            pushType: "background",
            badgeParts,
            cr: { kind: "workspace_agent_read", chatId: message.chatId },
            redactLog: true,
          },
        ),
      )
      .catch(() => undefined);
  }
}

export function onWorkspaceAgentViewing({ conn, tenant }: WsCtx, message: MessageOf<"workspace_agent_viewing">) {
  const chatId = typeof message.chatId === "string" ? message.chatId : "";
  conn.workspaceViewingChatId = chatId && workspaceAgentByChat(tenant, chatId) ? chatId : undefined;
}
