// 出站帧护栏：按连接声明的接收上限裁剪或丢弃消息（纯逻辑，只读连接表）
import { WebSocket } from "ws";
import { formatBytes } from "../../../shared/preview.ts";
import type { HistoryTurn, ServerMessage } from "../../../shared/protocol.ts";
import { encodeCursor, rowKey } from "../im/listCursor.ts";
import { log } from "../log.ts";
import { gatewayState } from "../runtime/state.ts";
import type { WorkspaceFiles } from "../runtime/types.ts";

export function reply(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame = frameFor(ws, message);
  if (frame !== null) ws.send(frame);
}

/**
 * 出站最后一道护栏：单条消息超过该连接声明的接收上限时按类型裁剪，裁不动就丢弃并记日志。
 * 超限的消息发出去，iOS 会以「消息太长」断线，重连后又请求同一份数据，陷入断线循环。
 */
export function frameFor(sock: WebSocket, message: ServerMessage): string | null {
  const text = JSON.stringify(message);
  const limit = gatewayState.conns.get(sock)?.maxMessageBytes ?? 0;
  // UTF-16 码元数 ×3 一定不小于 UTF-8 字节数，小消息不必逐字节计算
  if (limit <= 0 || text.length * 3 <= limit) return text;
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return text;
  const fitted = shrinkMessage(message, Math.floor(limit * 0.85));
  if (fitted) {
    const next = JSON.stringify(fitted);
    if (Buffer.byteLength(next) <= limit) {
      log.info("frame clipped", message.type, bytes, "->", Buffer.byteLength(next));
      return next;
    }
  }
  log.warn("frame dropped", message.type, bytes, ">", limit);
  return null;
}

export function shrinkMessage(message: ServerMessage, budget: number): ServerMessage | null {
  if (message.type === "file_content") return fitFileContent(message, budget);
  if (message.type === "search_hits") return fitSearchHits(message, budget);
  if (message.type === "im_history") return fitImHistory(message, budget);
  if (message.type === "im_list") return fitImList(message, budget);
  if (message.type === "history")
    return { ...message, turns: fitTurnsFromEnd(message.turns, budget, 40) as HistoryTurn[] };
  if (message.type === "files") {
    const { paths, status, truncated, ...base } = message;
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, truncated: true }));
    const fitted = fitWorkspaceFiles(
      { paths, status: status || {}, truncated: Boolean(truncated) },
      budget / 0.8,
      overhead,
    );
    return { ...message, ...fitted };
  }
  // 这几类客户端会落盘、回推，截过的正文可能被当成真内容；上游各自有 deferred / 分页护栏
  if (message.type === "stored_state" || message.type === "stored_chat" || message.type === "chat_turns") return null;
  // 其余（工具结果、快照等）只用于展示：逐级截短长字符串，保住消息本身，客户端状态不会卡住
  for (const cap of [64 * 1024, 16 * 1024, 4 * 1024, 1024]) {
    const clipped = clipLongStrings(message, cap) as ServerMessage;
    if (Buffer.byteLength(JSON.stringify(clipped)) <= budget) return clipped;
  }
  return null;
}

function clipLongStrings(value: unknown, cap: number): unknown {
  if (typeof value === "string") return value.length > cap ? `${value.slice(0, cap)}…（过长已截断）` : value;
  if (Array.isArray(value)) return value.map((item) => clipLongStrings(item, cap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clipLongStrings(item, cap);
    return out;
  }
  return value;
}

/** 截到 JSON 编码后不超过 maxBytes（转义后的字节，不是原文长度），不拆代理对 */
function clipJsonString(text: string, maxBytes: number): string {
  if (maxBytes <= 2) return "";
  const full = Buffer.byteLength(JSON.stringify(text));
  if (full <= maxBytes) return text;
  let n = Math.floor((text.length * maxBytes) / full);
  while (n > 0) {
    const code = text.charCodeAt(n - 1);
    if (code >= 0xd800 && code <= 0xdbff) n -= 1;
    if (Buffer.byteLength(JSON.stringify(text.slice(0, n))) <= maxBytes) break;
    n = Math.floor(n * 0.9);
  }
  return text.slice(0, Math.max(0, n));
}

const CLIPPED_NOTE = "\n\n…（内容过长，这台设备只显示前一部分，完整版见网页端）";

type FileContentMessage = Extract<ServerMessage, { type: "file_content" }>;

/**
 * 有 url 的（svg、markdown、html、canvas）去掉正文，客户端改走 HTTP 拉；
 * 纯文本和 diff 截短正文；其余没有 url 的半截就是坏文档，直接报太大
 */
function fitFileContent(message: FileContentMessage, budget: number): FileContentMessage {
  if (message.url) return { ...message, content: undefined, truncated: true };
  if (typeof message.content !== "string") return message;
  if (!message.diff && message.kind && message.kind !== "text") {
    const size = message.size ?? Buffer.byteLength(message.content);
    return {
      ...message,
      content: undefined,
      error: `文件太大（${formatBytes(size)}），这台设备打不开`,
      truncated: true,
    };
  }
  const overhead = Buffer.byteLength(JSON.stringify({ ...message, content: CLIPPED_NOTE, truncated: true }));
  return { ...message, content: clipJsonString(message.content, budget - overhead) + CLIPPED_NOTE, truncated: true };
}

type SearchHitsMessage = Extract<ServerMessage, { type: "search_hits" }>;

function fitSearchHits(message: SearchHitsMessage, budget: number): SearchHitsMessage {
  let used = Buffer.byteLength(JSON.stringify({ ...message, hits: [], truncated: true }));
  const hits: SearchHitsMessage["hits"] = [];
  for (const hit of message.hits) {
    const row = hit.text.length > 400 ? { ...hit, text: `${hit.text.slice(0, 400)}…` } : hit;
    const cost = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (used + cost > budget) break;
    hits.push(row);
    used += cost;
  }
  return { ...message, hits, truncated: true };
}

type ImHistoryMessage = Extract<ServerMessage, { type: "im_history" }>;

/**
 * 从翻页方向的远端丢消息并置 more=true：默认 / before 翻页丢最旧的（客户端接着用 before=最旧 seq 往前翻），
 * after 翻页丢最新的（接着用 after=最新 seq 往后翻），这样丢掉的消息下一页还能拿到
 */
function fitImHistory(message: ImHistoryMessage, budget: number): ImHistoryMessage {
  const forward = message.after !== undefined;
  const messages = [...message.messages];
  let used = Buffer.byteLength(JSON.stringify({ ...message, messages: [], more: true }));
  const sizes = messages.map((item) => Buffer.byteLength(JSON.stringify(item)) + 1);
  used += sizes.reduce((sum, size) => sum + size, 0);
  while (messages.length && used > budget) {
    used -= (forward ? sizes.pop() : sizes.shift()) ?? 0;
    if (forward) messages.pop();
    else messages.shift();
  }
  return { ...message, messages, more: true };
}

type ImListMessage = Extract<ServerMessage, { type: "im_list" }>;
type ImLast = NonNullable<ImListMessage["convs"][number]["last"]>;

/**
 * 先把每行 last 正文里的长字符串截到 100 字（blob id 64 位不受影响）；还装不下就从末尾丢行，
 * 置 more=true、cursor=最后保留那行的排序键，客户端接着用 cursor 翻下一页，丢掉的行都能拿到
 */
function fitImList(message: ImListMessage, budget: number): ImListMessage | null {
  const convs = message.convs.map((row) =>
    row.last?.body
      ? { ...row, last: { ...row.last, body: clipLongStrings(row.last.body, 100) as ImLast["body"] } }
      : row,
  );
  const clipped = { ...message, convs };
  if (Buffer.byteLength(JSON.stringify(clipped)) <= budget) return clipped;
  const probe = { ...message, convs: [], more: true, cursor: encodeCursor(rowKey(convs[0] ?? emptyRow)) };
  let used = Buffer.byteLength(JSON.stringify(probe)) + 64;
  const kept: ImListMessage["convs"] = [];
  for (const row of convs) {
    const cost = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (used + cost > budget) break;
    kept.push(row);
    used += cost;
  }
  if (!kept.length) return null;
  return { ...message, convs: kept, more: true, cursor: encodeCursor(rowKey(kept[kept.length - 1])) };
}

const emptyRow = { pin: false, convId: "" };

/** 从最后一条往前装，条数和字节双上限；单条超预算先按 load_chat 的规则截短 */
export function fitTurnsFromEnd(all: unknown[], budget: number, maxCount: number): unknown[] {
  const page: unknown[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0 && page.length < maxCount; i -= 1) {
    let turn = all[i];
    let size = Buffer.byteLength(JSON.stringify(turn));
    if (size > budget) {
      turn = clipTurnForPage(turn, budget);
      size = Buffer.byteLength(JSON.stringify(turn));
    }
    if (bytes + size > budget) break;
    page.unshift(turn);
    bytes += size;
  }
  return page;
}

/// load_chat 组页时单条 turn 超预算的兜底截断：砍长字符串字段并打 clipped 标记。
/// 截断副本只用于展示——sync_chat 回传时网关按 id 回退服务端完整版（见 sync_chat 合并），截断内容不会回写落盘
export function clipTurnForPage(turn: unknown, budget: number): unknown {
  if (!turn || typeof turn !== "object") return turn;
  const row = { ...(turn as Record<string, unknown>) };
  const cap = 64 * 1024;
  for (const key of ["thinking", "assistant", "user"]) {
    const value = row[key];
    if (typeof value === "string" && value.length > cap) row[key] = `${value.slice(0, cap)}…（过长已截断）`;
  }
  if (Array.isArray(row.tools)) {
    row.tools = row.tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const t = { ...(tool as Record<string, unknown>) };
      for (const key of ["result", "args"]) {
        const value = t[key];
        if (typeof value === "string" && value.length > cap) {
          t[key] = `${value.slice(0, cap)}…（过长已截断）`;
        } else if (value && typeof value === "object" && Buffer.byteLength(JSON.stringify(value)) > cap) {
          t[key] = { truncated: true, note: "内容过长，完整版见网页端" };
        }
      }
      return t;
    });
  }
  row.clipped = true;
  // 极端情况截完仍超预算（海量短字段）：换成占位 turn，保住 id 让客户端页码不断——总比撑爆 WS 断连强
  if (Buffer.byteLength(JSON.stringify(row)) > budget) {
    return {
      id: (turn as { id?: unknown }).id,
      user: "",
      assistant: "（此条消息过大，无法在此设备显示，完整版见网页端）",
      clipped: true,
    };
  }
  return row;
}

/**
 * files 回包按连接声明的单条上限裁剪（limit = 0 不限，网页端原样）。
 * 路径按排名从前往后装，装不下就停；status 只保留实际发出的路径和已删除项，
 * 否则 8000 条路径之外的 git 状态会单独把一条消息撑过 iOS 的 1MiB 帧上限。
 */
export function fitWorkspaceFiles(listed: WorkspaceFiles, limit: number, overhead: number): WorkspaceFiles {
  if (limit <= 0) return listed;
  const budget = Math.floor(limit * 0.8) - overhead;
  const status: Record<string, string> = {};
  let used = 64;
  for (const [path, letter] of Object.entries(listed.status)) {
    if (letter !== "D") continue;
    const cost = Buffer.byteLength(JSON.stringify(path)) + letter.length + 4;
    if (used + cost > budget) break;
    status[path] = letter;
    used += cost;
  }
  const paths: string[] = [];
  for (const path of listed.paths) {
    const key = Buffer.byteLength(JSON.stringify(path));
    const letter = listed.status[path];
    const cost = key + 1 + (letter ? key + letter.length + 4 : 0);
    if (used + cost > budget) break;
    paths.push(path);
    if (letter) status[path] = letter;
    used += cost;
  }
  return { paths, status, truncated: listed.truncated || paths.length < listed.paths.length };
}
