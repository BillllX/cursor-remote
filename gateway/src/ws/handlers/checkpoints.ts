// 检查点与还原：列出、还原文件/片段、撤销/恢复检查点
import { cwdOf, persistConn, slotOf } from "../../runtime/slots.ts";
import { noteNativeRestore, restoreCheckpoint, sendCheckpoints, undoEdits } from "../../workspace/checkpoints.ts";
import { pushWorkspace, revertHunk, workspacePath } from "../../workspace/files.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export function onListCheckpoints({ ws, conn }: WsCtx, message: MessageOf<"list_checkpoints">) {
  sendCheckpoints(ws, slotOf(conn, message.chatId));
}

export function onRevertFile({ ws, conn }: WsCtx, message: MessageOf<"revert_file">) {
  const slot = slotOf(conn, message.chatId);
  if (slot.run || slot.externalAbort) {
    send(ws, {
      type: "error",
      chatId: slot.chatId,
      message: "Agent 还在跑，先停再还原。",
    });
    return;
  }
  const result = undoEdits(cwdOf(conn, slot), [message.path]);
  send(ws, {
    type: "undone",
    chatId: slot.chatId,
    paths: result.paths,
    error: result.error,
  });
  if (result.paths.length) {
    const gone = new Set(result.paths);
    slot.edited = slot.edited.filter((item) => {
      const path = workspacePath(cwdOf(conn, slot), item);
      return !path || !gone.has(path);
    });
    pushWorkspace(ws, slot, conn, result.paths);
    noteNativeRestore(conn, slot, undefined, result.paths);
  }
}

export function onRevertHunk({ ws, conn }: WsCtx, message: MessageOf<"revert_hunk">) {
  const slot = slotOf(conn, message.chatId);
  if (slot.run || slot.externalAbort) {
    send(ws, {
      type: "error",
      chatId: slot.chatId,
      message: "Agent 还在跑，先停再还原。",
    });
    return;
  }
  const result = revertHunk(cwdOf(conn, slot), message.path, message.hunk);
  send(ws, {
    type: "undone",
    chatId: slot.chatId,
    paths: result.error ? [] : [result.path],
    error: result.error,
  });
  if (!result.error) {
    pushWorkspace(ws, slot, conn, [result.path]);
    noteNativeRestore(conn, slot, undefined, [result.path]);
  }
}

export function onUndoOrRestore({ ws, conn }: WsCtx, message: MessageOf<"undo" | "restore">) {
  const slot = slotOf(conn, message.chatId);
  if (slot.run || slot.externalAbort) {
    send(ws, {
      type: "error",
      chatId: slot.chatId,
      message: "Agent 还在跑，先停再撤销。",
    });
    return;
  }
  const wanted =
    message.type === "restore"
      ? slot.checkpoints.find((item) => item.id === message.checkpointId)
      : slot.checkpoints[0];
  if (wanted) {
    const result = restoreCheckpoint(cwdOf(conn, slot), wanted, slot.edited);
    send(ws, {
      type: "restored",
      chatId: slot.chatId,
      checkpointId: wanted.id,
      label: wanted.label,
      error: result.error,
    });
    if (!result.error) {
      const preview = slot.edited.slice();
      slot.edited = [];
      pushWorkspace(ws, slot, conn, preview);
      noteNativeRestore(conn, slot, wanted.label);
    }
    persistConn(conn);
    return;
  }
  if (message.type === "restore") {
    send(ws, {
      type: "restored",
      chatId: slot.chatId,
      checkpointId: message.checkpointId,
      error: "找不到这个检查点",
    });
    return;
  }
  const result = undoEdits(cwdOf(conn, slot), slot.edited);
  send(ws, {
    type: "undone",
    chatId: slot.chatId,
    paths: result.paths,
    error: result.error,
  });
  if (result.paths.length) {
    slot.edited = [];
    pushWorkspace(ws, slot, conn, result.paths);
    noteNativeRestore(conn, slot, undefined, result.paths);
  }
}
