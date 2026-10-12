// 工作区：切换、列出、新建、改名、删除
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { confinedCwd } from "../../tenants.ts";
import { isAssistantChat } from "../../runtime/chats.ts";
import { disposeSlot, lockedChatCwd, persistConn, slotOf } from "../../runtime/slots.ts";
import {
  deleteWorkspace,
  emitWorkspaces,
  ensureWorkspaceDir,
  readHiddenWorkspaces,
  renameWorkspace,
  sanitizeWorkspaceName,
  writeHiddenWorkspaces,
} from "../../workspace/workspaces.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export async function onSetWorkspace({ ws, conn, tenant }: WsCtx, message: MessageOf<"set_workspace">) {
  if (message.chatId && isAssistantChat(tenant, message.chatId)) {
    send(ws, { type: "error", chatId: message.chatId, message: "助理会话固定在 USER 根目录，不能换工作区。" });
    return;
  }
  const next =
    (message.chatId ? lockedChatCwd(tenant, message.chatId) : null) ||
    confinedCwd(message.cwd || conn.cwd, tenant.workspaceRoot);
  if (!next) {
    send(ws, { type: "error", chatId: message.chatId, message: "工作区必须在允许的目录里。" });
    return;
  }
  try {
    ensureWorkspaceDir(next);
  } catch {
    send(ws, { type: "error", chatId: message.chatId, message: "建不了这个工作区目录。" });
    return;
  }
  if (message.chatId) {
    const slot = slotOf(conn, message.chatId);
    if (next !== slot.cwd) {
      slot.cwd = next;
      await disposeSlot(slot);
      slot.agentId = null;
    }
    persistConn(conn);
    send(ws, {
      type: "session",
      chatId: slot.chatId,
      agentId: slot.agentId || "",
      cwd: slot.cwd,
    });
  } else {
    conn.cwd = next;
    send(ws, { type: "session", chatId: "", agentId: "", cwd: conn.cwd });
  }
  emitWorkspaces(ws, tenant);
}

export function onListWorkspaces({ ws, tenant }: WsCtx) {
  emitWorkspaces(ws, tenant);
}

export function onCreateWorkspace({ ws, tenant }: WsCtx, message: MessageOf<"create_workspace">) {
  const name = sanitizeWorkspaceName(message.name);
  if (!name) {
    send(ws, { type: "error", message: "工作区名字不合法。" });
    return;
  }
  const next = confinedCwd(resolve(tenant.workspaceRoot, name), tenant.workspaceRoot);
  if (!next) {
    send(ws, { type: "error", message: "工作区必须在允许的目录里。" });
    return;
  }
  try {
    if (existsSync(next) && !statSync(next).isDirectory()) {
      send(ws, { type: "error", message: "已经有同名文件。" });
      return;
    }
    ensureWorkspaceDir(next);
  } catch {
    send(ws, { type: "error", message: "建不了这个工作区目录。" });
    return;
  }
  // 之前隐藏过的同名工作区：重新建就是取消隐藏
  const hidden = readHiddenWorkspaces(tenant);
  if (hidden.includes(name))
    writeHiddenWorkspaces(
      tenant,
      hidden.filter((item) => item !== name),
    );
  send(ws, { type: "workspace_created", path: next, name });
  emitWorkspaces(ws, tenant);
}

export async function onRenameWorkspace({ ws, conn, tenant }: WsCtx, message: MessageOf<"rename_workspace">) {
  await renameWorkspace(ws, tenant, conn, String(message.path || ""), String(message.name || ""));
}

export function onDeleteWorkspace({ ws, conn, tenant }: WsCtx, message: MessageOf<"delete_workspace">) {
  deleteWorkspace(ws, tenant, conn, String(message.path || ""));
}
