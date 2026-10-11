// 已存会话状态：合并压缩、摘要广播、按页裁剪与 stored_state 推送
import type { WebSocket } from "ws";
import { assistantName, noteChatDeleted } from "../assistant/service.ts";
import { isBodyLoaded, slimChat } from "../chatBodies.ts";
import { log } from "../log.ts";
import { keepToolsAt, keepTurnFiles } from "../runlog.ts";
import { assistantChatIdOf, assistantCwd, chatIdOf, isAssistantChat } from "../runtime/chats.ts";
import { chatIdsFrom, persistTenant, runningChatIds } from "../runtime/slots.ts";
import { conns } from "../runtime/state.ts";
import { settlePersistedChats, type Tenant } from "../tenants.ts";
import { send } from "../ws/send.ts";

/** 工具正文落盘上限。高于网页卡片的 1.2 万展示截断，diff 字段仍留得住。 */
const TOOL_TEXT_CAP = 24_000;

const TOOL_TEXT_MARK = "\n…（过长已截断）";

/** 落盘只留每个会话最近这么多轮的用户图片 */
const KEEP_TURN_IMAGES = 20;

/** 缺了就建；只认编号，不改客户端写回的标题等字段，避免每次同步都触发重新对账 */
export function ensureAssistantChat(tenant: Tenant) {
  const id = assistantChatIdOf(tenant);
  const exists = tenant.disk.chats.some((item) => chatIdOf(item) === id);
  const deleted = tenant.disk.deletedIds.includes(id);
  if (exists && !deleted) return false;
  tenant.disk.deletedIds = tenant.disk.deletedIds.filter((item) => item !== id);
  if (!exists) {
    tenant.disk.chats = [
      { id, title: assistantName(tenant), turns: [], cwd: assistantCwd(tenant), assistant: true },
      ...tenant.disk.chats,
    ];
  }
  tenant.disk.rev += 1;
  tenant.disk.chatRevs[id] = tenant.disk.rev;
  persistTenant(tenant);
  return true;
}

export function tombstoneChat(tenant: Tenant, chatId: string) {
  if (!chatId || isAssistantChat(tenant, chatId)) return;
  tenant.disk.deletedIds = [chatId, ...tenant.disk.deletedIds.filter((id) => id !== chatId)].slice(0, 500);
  tenant.disk.chats = tenant.disk.chats.filter((item) => chatIdOf(item) !== chatId);
  delete tenant.disk.chatRevs[chatId];
  noteChatDeleted(tenant, chatId);
}

/// 全量 chatRevs 视图：没有记录的老会话补 0（迁移期），保证 digest/stored_state 一致
export function effectiveChatRevs(tenant: Tenant): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of tenant.disk.chats) {
    const id = chatIdOf(item);
    if (id) out[id] = tenant.disk.chatRevs[id] ?? 0;
  }
  return out;
}

/// 会话条数硬顶（P4 审核）：sync_chat 可追加未知 id，无上限会被死循环/恶意客户端打爆磁盘
export const MAX_STORED_CHATS = 500;

/// 规范化 JSON 序列化（对象键排序），用于变更检测——
/// 避免 Swift(JSONSerialization) 与 JS(插入序) 的键序差异把相同内容误判为 changed
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/// chatRevs 裁剪到当前存活会话集（P4 审核）：gone 过滤/旧状态残留的脏 key 随 persist 一直带着
export function pruneChatRevs(tenant: Tenant) {
  const live = new Set(chatIdsFrom(tenant.disk.chats));
  for (const id of Object.keys(tenant.disk.chatRevs)) {
    if (!live.has(id)) delete tenant.disk.chatRevs[id];
  }
}

/// sync 被接受后向同租户其他支持 digest 的连接广播目录（P4 审核：多设备实时对账，
/// 否则对端要等自己 rev 分叉才发现变化，互相覆盖）。旧客户端无 caps 不收。
export function broadcastDigest(tenant: Tenant, except?: WebSocket) {
  for (const other of conns.values()) {
    if (other.ws === except || !other.authed || other.tenant?.id !== tenant.id) continue;
    if (!other.caps.has("stored_digest")) continue;
    send(other.ws, {
      type: "stored_digest",
      rev: tenant.disk.rev,
      deletedIds: tenant.disk.deletedIds,
      chatRevs: effectiveChatRevs(tenant),
      reason: "changed",
    });
  }
}

function visibleChats(tenant: Tenant) {
  if (!tenant.disk.deletedIds.length) return tenant.disk.chats;
  const gone = new Set(tenant.disk.deletedIds);
  return tenant.disk.chats.filter((item) => {
    const id = chatIdOf(item);
    return !id || !gone.has(id);
  });
}

/// P8：slim_state 客户端的会话元数据视图——剥掉 turns（内容走 load_chat 分页），
/// 补响应期计算的 preview（不落盘，避免 digest 抖动）。真空会话保留 turns:[]：
/// 客户端按「有无 turns 键」区分「真空（已完整）」与「有内容未加载」（评审 GLM M3）
/** 草稿只存在客户端：上传时丢掉，不落盘也不下发。 */
export function omitClientDraft(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const rest = { ...(item as Record<string, unknown>) };
  delete rest.draft;
  delete rest.draftImages;
  return rest;
}

function capStoredString(value: string, hit: { n: number }): string {
  if (value.length <= TOOL_TEXT_CAP) return value;
  hit.n += 1;
  return value.slice(0, TOOL_TEXT_CAP - TOOL_TEXT_MARK.length) + TOOL_TEXT_MARK;
}

function capStoredValue(value: unknown, hit: { n: number }, depth = 0): unknown {
  if (typeof value === "string") return capStoredString(value, hit);
  if (depth >= 8 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = depth === 0 && value.length > 400 ? value.slice(0, 400) : value;
    if (items.length !== value.length) hit.n += 1;
    return items.map((item) => capStoredValue(item, hit, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capStoredValue(item, hit, depth + 1);
  }
  return out;
}

/**
 * 回填已确认过的工具正文，再截断过长的 result/args。
 * keepBody 只表示「这轮没带正文」，正文从上一份磁盘记录按 callId 拷回。
 */
export function mergeAndCompactChat(prev: unknown, next: unknown, hit: { n: number } = { n: 0 }): unknown {
  if (!next || typeof next !== "object") return next;
  const row = next as { turns?: unknown };
  if (!Array.isArray(row.turns)) return next;
  const prevTools = new Map<string, { args?: unknown; result?: unknown; review?: unknown }>();
  const prevTurns = prev && typeof prev === "object" ? (prev as { turns?: unknown }).turns : undefined;
  if (Array.isArray(prevTurns)) {
    for (const turn of prevTurns) {
      if (!turn || typeof turn !== "object" || !Array.isArray((turn as { tools?: unknown }).tools)) continue;
      for (const tool of (turn as { tools: unknown[] }).tools) {
        if (!tool || typeof tool !== "object") continue;
        const callId = (tool as { callId?: unknown }).callId;
        if (typeof callId !== "string" || !callId) continue;
        prevTools.set(callId, tool as { args?: unknown; result?: unknown; review?: unknown });
      }
    }
  }
  const keepImagesFrom = row.turns.length - KEEP_TURN_IMAGES;
  const diskTurns = Array.isArray(prevTurns) ? prevTurns : undefined;
  const withFiles = keepToolsAt(diskTurns, keepTurnFiles(diskTurns, row.turns));
  const turns = withFiles.map((item, index) => {
    let turn = item;
    if (index < keepImagesFrom && turn && typeof turn === "object" && "images" in turn) {
      const rest = { ...(turn as Record<string, unknown>) };
      delete rest.images;
      turn = rest;
      hit.n += 1;
    }
    if (!turn || typeof turn !== "object" || !Array.isArray((turn as { tools?: unknown }).tools)) return turn;
    const tools = (turn as { tools: unknown[] }).tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const rowTool = { ...(tool as Record<string, unknown>) };
      const callId = typeof rowTool.callId === "string" ? rowTool.callId : "";
      const old = callId ? prevTools.get(callId) : undefined;
      if (rowTool.keepBody === true && old) {
        if (!("args" in rowTool) && "args" in old) rowTool.args = old.args;
        if (!("result" in rowTool) && "result" in old) rowTool.result = old.result;
      }
      // 在途的整段同步可能早于「保留」，别把刚落盘的标记盖掉
      if (
        (rowTool.review == null || rowTool.review === "") &&
        (old?.review === "accepted" || old?.review === "rejected")
      ) {
        rowTool.review = old.review;
      }
      delete rowTool.keepBody;
      if ("args" in rowTool) rowTool.args = capStoredValue(rowTool.args, hit);
      if ("result" in rowTool) rowTool.result = capStoredValue(rowTool.result, hit);
      return rowTool;
    });
    return { ...(turn as Record<string, unknown>), tools };
  });
  return { ...(next as Record<string, unknown>), turns };
}

/** 启动时把磁盘上已经超长的工具记录截掉。不改版本号，避免把打开着的客户端整页刷掉。 */
export function compactTenantChats(tenant: { disk: { chats: unknown[] } }): boolean {
  const hit = { n: 0 };
  // 已拆分落盘的正文写入前都压缩过，不必装回来再压
  tenant.disk.chats = tenant.disk.chats.map((chat) =>
    isBodyLoaded(chat) ? mergeAndCompactChat(chat, chat, hit) : chat,
  );
  return hit.n > 0;
}

export function storedStatePayload(tenant: Tenant, slim = false) {
  const live = new Set(runningChatIds(tenant));
  const visible = visibleChats(tenant);
  // 精简视图不带 turns，收尾「运行中」标记没意义，也省得把每条会话的正文装回内存
  const chats = slim
    ? visible.map((item) => slimChat(tenant.bodies, item))
    : visible.map((item) => (live.has(chatIdOf(item)) ? item : settlePersistedChats([item])[0]));
  return {
    type: "stored_state" as const,
    chats,
    rev: tenant.disk.rev,
    deletedIds: tenant.disk.deletedIds,
    chatRevs: effectiveChatRevs(tenant),
  };
}

/// 分叉时的状态对齐：支持 digest 的客户端发目录（P4c），否则全量 stored_state（含 deferral 护栏）
export function emitStateSync(ws: WebSocket, tenant: Tenant) {
  const conn = conns.get(ws);
  if (conn?.caps.has("stored_digest")) {
    send(ws, {
      type: "stored_digest",
      rev: tenant.disk.rev,
      deletedIds: tenant.disk.deletedIds,
      chatRevs: effectiveChatRevs(tenant),
      reason: "rejected",
    });
    return;
  }
  emitStoredState(ws, tenant);
}

export function emitStoredState(ws: WebSocket, tenant: Tenant) {
  const conn = conns.get(ws);
  const payload = storedStatePayload(tenant, conn?.caps.has("slim_state") ?? false);
  const limit = conn?.maxMessageBytes ?? 0;
  if (limit > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > limit) {
      // 客户端收不了这么大的单条 WS 消息（iOS URLSessionWebSocketTask 约 1MiB），改走 HTTP /state
      log.info("stored_state deferred", tenant.id, bytes, ">", limit);
      send(ws, { type: "stored_state_deferred", rev: tenant.disk.rev });
      return;
    }
  }
  send(ws, payload);
}
