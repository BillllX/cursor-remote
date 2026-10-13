// 客户端上行消息的分发：解析 → ping → hello（登录）→ 鉴权门槛 → 按 type 查注册表；表里没有的 type 静默忽略。
// 处理函数在同一个 try 里 await，同步、异步抛出的错误都走下面同一个 catch；不按连接排队。
import type { RawData } from "ws";
import { CursorAgentError } from "@cursor/sdk";
import { parseClient } from "./parse.ts";
import { send } from "./send.ts";
import { finishRun } from "../chat/finish.ts";
import { onAdminStats } from "./handlers/admin.ts";
import { onAssistantGet, onAssistantOp } from "./handlers/assistant.ts";
import { onListCheckpoints, onRevertFile, onRevertHunk, onUndoOrRestore } from "./handlers/checkpoints.ts";
import { onFsOp, onListFiles, onReadFile, onSearchText, onUploadFile, onWriteFile } from "./handlers/files.ts";
import { onHello } from "./handlers/hello.ts";
import {
  onImBlock,
  onImContacts,
  onImHistory,
  onImList,
  onImPresence,
  onImProfile,
  onImRead,
  onImRecall,
  onImSend,
  onImSettings,
} from "./handlers/im.ts";
import { onLoopStart, onLoopStop } from "./handlers/loops.ts";
import { onPrompt } from "./handlers/prompt.ts";
import {
  onApprovalReply,
  onCancel,
  onDeleteSession,
  onDropQueued,
  onNewSession,
  onResumeSession,
  onSetModel,
  onSetPolicy,
} from "./handlers/sessions.ts";
import {
  onLoadChat,
  onLoadChats,
  onLoadState,
  onSyncChat,
  onSyncState,
  onToolReview,
  onTruncateTurns,
} from "./handlers/state.ts";
import {
  onCreateWorkspace,
  onDeleteWorkspace,
  onListWorkspaces,
  onRenameWorkspace,
  onSetWorkspace,
} from "./handlers/workspaces.ts";
import type { Handler, HandlerTable, WsConnCtx } from "./handlers/types.ts";

/** 鉴权之后的“消息类型 → 处理函数”注册表 */
export const handlers: HandlerTable = {
  assistant_get: onAssistantGet,
  assistant_op: onAssistantOp,
  loop_start: onLoopStart,
  loop_stop: onLoopStop,
  admin_stats: onAdminStats,
  sync_state: onSyncState,
  tool_review: onToolReview,
  load_state: onLoadState,
  truncate_turns: onTruncateTurns,
  sync_chat: onSyncChat,
  load_chats: onLoadChats,
  load_chat: onLoadChat,
  write_file: onWriteFile,
  upload_file: onUploadFile,
  fs_op: onFsOp,
  list_files: onListFiles,
  search_text: onSearchText,
  read_file: onReadFile,
  set_workspace: onSetWorkspace,
  list_workspaces: onListWorkspaces,
  create_workspace: onCreateWorkspace,
  rename_workspace: onRenameWorkspace,
  delete_workspace: onDeleteWorkspace,
  resume_session: onResumeSession,
  delete_session: onDeleteSession,
  new_session: onNewSession,
  approval_reply: onApprovalReply,
  cancel: onCancel,
  drop_queued: onDropQueued,
  set_model: onSetModel,
  set_policy: onSetPolicy,
  list_checkpoints: onListCheckpoints,
  revert_file: onRevertFile,
  revert_hunk: onRevertHunk,
  undo: onUndoOrRestore,
  restore: onUndoOrRestore,
  prompt: onPrompt,
  im_contacts: onImContacts,
  im_list: onImList,
  im_history: onImHistory,
  im_send: onImSend,
  im_recall: onImRecall,
  im_read: onImRead,
  im_settings: onImSettings,
  im_profile: onImProfile,
  im_block: onImBlock,
  im_presence: onImPresence,
};

export async function handleMessage(ctx: WsConnCtx, data: RawData, table: HandlerTable = handlers) {
  const { ws, conn, state } = ctx;
  const message = parseClient(String(data));
  if (!message) return;

  try {
    if (message.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    if (message.type === "hello") {
      onHello(ctx, message);
      return;
    }

    if (!conn.authed || !conn.tenant) {
      send(ws, { type: "error", message: "先发 hello。" });
      return;
    }
    const tenant = conn.tenant;

    const handler = table[message.type] as Handler<typeof message.type> | undefined;
    if (handler) await handler({ ws, conn, state, tenant }, message);
  } catch (err) {
    const messageText =
      err instanceof CursorAgentError ? err.message : err instanceof Error ? err.message : "gateway 出错了";
    const chatId = "chatId" in message && message.chatId ? message.chatId : undefined;
    send(ws, { type: "error", chatId, message: messageText });
    if (chatId) {
      const slot = conn.slots.get(chatId);
      if (slot && !slot.finished) finishRun(ws, slot, "error");
    }
  }
}
