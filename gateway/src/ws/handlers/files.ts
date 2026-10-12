// 工作区文件：写入、上传、文件操作、列表、搜索、读取
import { readSnapshotDiff, readSnapshotFile } from "../../turnFiles.ts";
import { cwdOf, slotOf } from "../../runtime/slots.ts";
import type { WorkspaceFile } from "../../runtime/types.ts";
import {
  filesMessage,
  listWorkspaceFilesForClient,
  MAX_UPLOAD_BYTES,
  payload,
  pushWorkspace,
  readWorkspaceDiff,
  readWorkspaceFile,
  runFsOp,
  searchWorkspace,
  uniqueUploadPath,
  workspacePath,
  writeWorkspaceBytes,
  writeWorkspaceFile,
} from "../../workspace/files.ts";
import { reply } from "../frame.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export function onWriteFile({ ws, conn }: WsCtx, message: MessageOf<"write_file">) {
  const cwd = message.chatId ? cwdOf(conn, slotOf(conn, message.chatId)) : conn.cwd;
  const written = writeWorkspaceFile(cwd, message.path, message.content);
  send(ws, {
    type: "file_written",
    chatId: message.chatId,
    path: written.path,
    error: written.error,
  });
}

export function onUploadFile({ ws, conn }: WsCtx, message: MessageOf<"upload_file">) {
  const cwd = message.chatId ? cwdOf(conn, slotOf(conn, message.chatId)) : conn.cwd;
  const raw = typeof message.data === "string" ? message.data : "";
  const b64 = raw.replace(/^data:[^;]+;base64,/, "");
  const fail = (error: string) => {
    send(ws, {
      type: "file_uploaded",
      chatId: message.chatId,
      id: message.id,
      name: message.name,
      path: message.name || "",
      error,
    });
  };
  if (!b64) {
    fail("没有文件内容");
    return;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    fail("文件解码失败");
    return;
  }
  if (!buf.length) {
    fail("空文件");
    return;
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    fail("文件超过 32MB");
    return;
  }
  const rel = uniqueUploadPath(cwd, message.name || "file");
  if (!rel) {
    fail("没法在工作区里放下这个文件");
    return;
  }
  const written = writeWorkspaceBytes(cwd, rel, buf);
  send(ws, {
    type: "file_uploaded",
    chatId: message.chatId,
    id: message.id,
    name: message.name,
    path: written.path,
    error: written.error,
    size: written.size,
  });
  if (!written.error && message.chatId) {
    pushWorkspace(ws, slotOf(conn, message.chatId), conn, [written.path]);
  }
}

export function onFsOp({ ws, conn }: WsCtx, message: MessageOf<"fs_op">) {
  const cwd = message.chatId ? cwdOf(conn, slotOf(conn, message.chatId)) : conn.cwd;
  const result = runFsOp(cwd, message.op, message.path, message.to);
  send(ws, {
    type: "fs_done",
    chatId: message.chatId,
    op: message.op,
    path: result.path,
    to: result.to,
    error: result.error,
  });
  if (!result.error && message.chatId) {
    pushWorkspace(ws, slotOf(conn, message.chatId), conn, [result.to || result.path]);
  }
}

export function onListFiles({ ws, conn }: WsCtx, message: MessageOf<"list_files">) {
  const cwd = message.chatId ? cwdOf(conn, slotOf(conn, message.chatId)) : conn.cwd;
  const listed = listWorkspaceFilesForClient(cwd, message.query || "");
  send(
    ws,
    filesMessage(
      conn,
      { chatId: message.chatId, query: message.query || "", mention: Boolean(message.mention) },
      listed,
    ),
  );
}

export function onSearchText({ ws, conn }: WsCtx, message: MessageOf<"search_text">) {
  const cwd = message.chatId ? cwdOf(conn, slotOf(conn, message.chatId)) : conn.cwd;
  send(ws, {
    type: "search_hits",
    chatId: message.chatId,
    query: message.query,
    hits: searchWorkspace(cwd, message.query),
  });
}

export function onReadFile({ ws, conn, tenant }: WsCtx, message: MessageOf<"read_file">) {
  const cwd = message.chatId ? cwdOf(conn, slotOf(conn, message.chatId)) : conn.cwd;
  const echo = {
    reqId: typeof message.reqId === "string" ? message.reqId : undefined,
    sha: typeof message.sha === "string" ? message.sha : undefined,
  };
  let file: WorkspaceFile;
  if (echo.sha != null) {
    // 快照只按 sha 寻址，path 只用来定 kind 和显示名
    const rel = workspacePath(cwd, message.path) || message.path;
    file = message.diff
      ? readSnapshotDiff(tenant.stateDir, rel, echo.sha)
      : readSnapshotFile(tenant.stateDir, rel, echo.sha);
  } else {
    file = message.diff ? readWorkspaceDiff(cwd, message.path) : readWorkspaceFile(cwd, message.path);
  }
  reply(ws, payload(tenant, message.chatId, message.path, file, Boolean(message.diff), echo));
}
