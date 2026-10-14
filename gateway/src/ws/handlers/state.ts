// 会话存储同步：整表/单条上传、评审标记、截断回合、按需拉取与分页
import { slimChat } from "../../chatBodies.ts";
import { confinedCwd, settlePersistedChats } from "../../tenants.ts";
import { readRunMark } from "../../runlog.ts";
import { log } from "../../log.ts";
import { assistantChatIdOf, chatIdOf, isAssistantChat } from "../../runtime/chats.ts";
import { chatIdsFrom, lockedChatCwd, persistConn, pruneDroppedSlots, runningChatIds } from "../../runtime/slots.ts";
import { liveSlotsOf } from "../../runtime/state.ts";
import {
  broadcastDigest,
  effectiveChatRevs,
  emitStateSync,
  emitStoredState,
  MAX_STORED_CHATS,
  mergeAndCompactChat,
  omitClientDraft,
  pruneChatRevs,
  stableStringify,
  tombstoneChat,
} from "../../sync/storedState.ts";
import { protectChatUpload, stopRunFlush } from "../../sync/transcript.ts";
import { clipTurnForPage } from "../frame.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";
import { workspaceMainChatIds } from "../../workspace/agents.ts";

export function onSyncState({ ws, conn, tenant }: WsCtx, message: MessageOf<"sync_state">) {
  const clientRev = typeof message.rev === "number" ? message.rev : 0;
  if (clientRev < tenant.disk.rev) {
    emitStateSync(ws, tenant);
    return;
  }
  const prevCwd = new Map<string, string>();
  const prevJson = new Map<string, string>();
  const prevIds = chatIdsFrom(tenant.disk.chats);
  for (const item of tenant.disk.chats) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; cwd?: unknown };
    if (typeof row.id === "string" && row.id) {
      if (typeof row.cwd === "string" && row.cwd) prevCwd.set(row.id, row.cwd);
      prevJson.set(row.id, stableStringify(item));
    }
  }
  // 助理会话不占 MAX_STORED_CHATS 名额；客户端漏带时用服务端那份，不能被墓碑化
  const assistantId = assistantChatIdOf(tenant);
  const workspaceIds = workspaceMainChatIds(tenant);
  const uploaded: unknown[] = Array.isArray(message.chats) ? message.chats : [];
  const assistantRow =
    uploaded.find((item) => chatIdOf(item) === assistantId) ??
    tenant.disk.chats.find((item) => chatIdOf(item) === assistantId);
  const protectedRows = tenant.disk.chats.filter((item) => workspaceIds.has(chatIdOf(item)));
  const incoming = uploaded
    .filter((item) => chatIdOf(item) !== assistantId && !workspaceIds.has(chatIdOf(item)))
    .slice(0, MAX_STORED_CHATS);
  for (const row of protectedRows) {
    const id = chatIdOf(row);
    incoming.push(uploaded.find((item) => chatIdOf(item) === id) ?? row);
  }
  if (assistantRow) incoming.unshift(assistantRow);
  const incomingIds = chatIdsFrom(incoming);
  for (const id of prevIds) {
    if (!incomingIds.has(id) && !workspaceIds.has(id)) tombstoneChat(tenant, id);
  }
  const gone = new Set(tenant.disk.deletedIds);
  tenant.disk.chats = incoming
    .filter((item) => {
      const id = chatIdOf(item);
      return !id || !gone.has(id);
    })
    .map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const item = omitClientDraft(raw);
      const row = item as { id?: unknown; cwd?: unknown };
      const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
      const id = typeof row.id === "string" ? row.id : "";
      const next =
        (id ? lockedChatCwd(tenant, id) : null) ||
        wanted ||
        (id ? confinedCwd(prevCwd.get(id), tenant.workspaceRoot) : null) ||
        tenant.workspaceRoot;
      const withCwd = row.cwd === next ? item : { ...row, cwd: next };
      const prevChat = id ? tenant.disk.chats.find((row) => chatIdOf(row) === id) : undefined;
      const merged = mergeAndCompactChat(prevChat, withCwd);
      const provided = Boolean(item && typeof item === "object" && Array.isArray((item as { turns?: unknown }).turns));
      // protect 可能因助手文本更长而留用磁盘上的旧工具列表，截断必须发生在那之后
      const uploaded = protectChatUpload(tenant, id, merged, provided);
      return mergeAndCompactChat(prevChat, uploaded);
    });
  tenant.disk.rev = clientRev;
  // P4c：按会话变更检测（规范化序列化，键序无关），只给真正变了的会话记新版本号
  for (const item of tenant.disk.chats) {
    const id = chatIdOf(item);
    if (!id) continue;
    if (prevJson.get(id) !== stableStringify(item)) {
      tenant.disk.chatRevs[id] = clientRev;
    }
  }
  pruneChatRevs(tenant);
  pruneDroppedSlots(tenant, chatIdsFrom(tenant.disk.chats));
  persistConn(conn);
  send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: effectiveChatRevs(tenant), keptBodies: true });
  broadcastDigest(tenant, ws); // 多设备实时对账
}

// 保留/还原只改标记。同时把磁盘上过长的工具正文截掉，打开着的标签不重载。
export function onToolReview({ ws, conn, tenant }: WsCtx, message: MessageOf<"tool_review">) {
  const chatId = typeof message.chatId === "string" ? message.chatId : "";
  const turnId = typeof message.turnId === "string" ? message.turnId : "";
  const reviews = Array.isArray(message.reviews) ? message.reviews : [];
  const ackRev = () => {
    send(ws, {
      type: "sync_ack",
      rev: tenant.disk.rev,
      chatRevs: chatId ? { [chatId]: tenant.disk.chatRevs[chatId] ?? tenant.disk.rev } : {},
      reviewOnly: true,
    });
  };
  if (!chatId || !turnId || tenant.disk.deletedIds.includes(chatId)) {
    ackRev();
    return;
  }
  const prev = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
  if (!prev || typeof prev !== "object") {
    ackRev();
    return;
  }
  const want = new Map<string, "accepted" | "rejected">();
  for (const item of reviews) {
    if (!item || typeof item !== "object") continue;
    const callId = (item as { callId?: unknown }).callId;
    const review = (item as { review?: unknown }).review;
    if (typeof callId !== "string" || !callId) continue;
    if (review !== "accepted" && review !== "rejected") continue;
    want.set(callId, review);
  }
  let applied = false;
  const stamped = { ...(prev as Record<string, unknown>) };
  if (Array.isArray(stamped.turns)) {
    stamped.turns = stamped.turns.map((turn) => {
      if (!turn || typeof turn !== "object" || (turn as { id?: unknown }).id !== turnId) return turn;
      if (!Array.isArray((turn as { tools?: unknown }).tools)) return turn;
      const tools = (turn as { tools: unknown[] }).tools.map((tool) => {
        if (!tool || typeof tool !== "object") return tool;
        const callId = (tool as { callId?: unknown }).callId;
        if (typeof callId !== "string" || !want.has(callId)) return tool;
        const review = want.get(callId);
        if ((tool as { review?: unknown }).review === review) return tool;
        applied = true;
        return { ...(tool as Record<string, unknown>), review };
      });
      return { ...(turn as Record<string, unknown>), tools };
    });
  }
  const hit = { n: 0 };
  const compacted = mergeAndCompactChat(prev, stamped, hit);
  if (applied || hit.n > 0) {
    tenant.disk.rev += 1;
    tenant.disk.chatRevs[chatId] = tenant.disk.rev;
    tenant.disk.chats = tenant.disk.chats.map((item) => (chatIdOf(item) === chatId ? compacted : item));
    persistConn(conn);
    broadcastDigest(tenant, ws);
  }
  ackRev();
}

export function onLoadState({ ws, tenant }: WsCtx) {
  emitStoredState(ws, tenant);
}

// 编辑、重试：截掉 turnId 及之后的回合
export function onTruncateTurns({ ws, conn, state, tenant }: WsCtx, message: MessageOf<"truncate_turns">) {
  const id = typeof message.chatId === "string" ? message.chatId : "";
  const turnId = typeof message.turnId === "string" ? message.turnId : "";
  if (!id || !turnId) return;
  // 截断只动这一条会话、可重放，不做 rev 拒绝；rev 落后时接着服务端往前走
  const clientRev = typeof message.rev === "number" ? message.rev : 0;
  const nextRev = Math.max(clientRev, tenant.disk.rev + 1);
  const prev = tenant.disk.deletedIds.includes(id)
    ? undefined
    : tenant.disk.chats.find((item) => chatIdOf(item) === id);
  // 没截成（找不到回合或正在跑）：truncated: false，客户端重拉正文
  const ackCurrent = () =>
    send(ws, {
      type: "sync_ack",
      rev: tenant.disk.rev,
      chatRevs: prev ? { [id]: tenant.disk.chatRevs[id] ?? 0 } : {},
      truncated: false,
    });
  if (!prev || typeof prev !== "object") {
    ackCurrent();
    return;
  }
  const slot = liveSlotsOf(tenant, state).get(id);
  if (runningChatIds(tenant).includes(id) || slot?.transcript?.phase === "running") {
    ackCurrent();
    return;
  }
  const row = prev as Record<string, unknown>;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const index = turns.findIndex(
    (turn) => Boolean(turn) && typeof turn === "object" && (turn as { id?: unknown }).id === turnId,
  );
  if (index < 0) {
    ackCurrent();
    return;
  }
  const removed = new Set(
    turns
      .slice(index)
      .map((turn) => (turn && typeof turn === "object" ? (turn as { id?: unknown }).id : null))
      .filter((item): item is string => typeof item === "string" && Boolean(item)),
  );
  const next: Record<string, unknown> = { ...row, turns: turns.slice(0, index) };
  const mark = readRunMark(prev);
  if (mark && removed.has(mark.turnId)) delete next.runMark;
  // 否则 protectChatUpload / flushTranscript 会把删掉的回合按转录补回来
  if (slot?.transcript && removed.has(slot.transcript.turnId)) {
    stopRunFlush(slot);
    slot.transcript = undefined;
  }
  tenant.disk.rev = nextRev;
  tenant.disk.chatRevs[id] = nextRev;
  tenant.disk.chats = tenant.disk.chats.map((item) => (item === prev ? next : item));
  persistConn(conn);
  send(ws, { type: "sync_ack", rev: nextRev, chatRevs: { [id]: nextRev }, truncated: true });
  broadcastDigest(tenant, ws);
}

// P4b：单会话增量上传——只替换/追加这一条，不做 tombstone（结构变化仍走 sync_state）
export function onSyncChat({ ws, conn, tenant }: WsCtx, message: MessageOf<"sync_chat">) {
  const clientRev = typeof message.rev === "number" ? message.rev : 0;
  if (clientRev < tenant.disk.rev) {
    emitStateSync(ws, tenant);
    return;
  }
  const id = chatIdOf(message.chat);
  if (!id) return;
  if (tenant.disk.deletedIds.includes(id)) {
    // 已删除的会话不接受内容更新；ack 带上该 id 让客户端收敛 inflight（空表会泄漏）
    send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
    return;
  }
  const prev = tenant.disk.chats.find((item) => chatIdOf(item) === id);
  // cwd 限定：与 sync_state 同一套（新值优先，其次旧值，最后租户根）
  let next = message.chat;
  if (next && typeof next === "object") {
    const row = next as { cwd?: unknown };
    const prevRow = prev && typeof prev === "object" ? (prev as { cwd?: unknown }) : {};
    const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
    const fallback = typeof prevRow.cwd === "string" ? confinedCwd(prevRow.cwd, tenant.workspaceRoot) : null;
    const cwd = lockedChatCwd(tenant, id) || wanted || fallback || tenant.workspaceRoot;
    if (row.cwd !== cwd) next = { ...next, cwd };
  }
  // P8 slim 合并：incoming 没有 turns 键 = 元数据更新，保留服务端 turns
  //（键缺失 ≠ 清空，空数组才是清空；web 永远带 turns 走全量替换，不受影响）。
  // incoming 带 turns 时，clipped 标记的 turn 是 load_chat 分页的截断展示副本——
  // 按 id 回退服务端完整版，截断内容不允许回写落盘
  if (next && typeof next === "object") {
    const row = next as Record<string, unknown>;
    const prevTurns = prev && typeof prev === "object" ? (prev as { turns?: unknown }).turns : undefined;
    if (Array.isArray(prevTurns)) {
      if (!("turns" in row)) {
        next = { ...row, turns: prevTurns };
      } else if (Array.isArray(row.turns)) {
        const fullById = new Map(
          prevTurns.map((t) => [t && typeof t === "object" ? (t as { id?: unknown }).id : null, t]),
        );
        next = {
          ...row,
          turns: row.turns.flatMap((t) => {
            if (!t || typeof t !== "object" || (t as { clipped?: unknown }).clipped !== true) return [t];
            // 残片按 id 回退服务端完整版；id 对不上（服务端没有）则丢弃——
            // 保留残片会把截断占位内容永久落盘（GLM 评审 M1）
            const full = fullById.get((t as { id?: unknown }).id);
            return full ? [full] : [];
          }),
        };
      }
    } else if (!("turns" in row)) {
      // 新会话且缺 turns 键：补空数组——磁盘 chat 永远带 turns 键，
      // web 端 chat.turns.map 不踩空（Kimi 设计评审 MINOR10）
      next = { ...row, turns: [] };
    }
  }
  next = mergeAndCompactChat(prev, omitClientDraft(next));
  const turnsProvided = Boolean(
    message.chat && typeof message.chat === "object" && Array.isArray((message.chat as { turns?: unknown }).turns),
  );
  next = protectChatUpload(tenant, id, next, turnsProvided);
  next = mergeAndCompactChat(prev, next);
  const changed = stableStringify(prev ?? null) !== stableStringify(next);
  const workspaceIds = workspaceMainChatIds(tenant);
  const stored = tenant.disk.chats.filter(
    (item) => !isAssistantChat(tenant, chatIdOf(item)) && !workspaceIds.has(chatIdOf(item)),
  ).length;
  if (changed && !prev && !isAssistantChat(tenant, id) && !workspaceIds.has(id) && stored >= MAX_STORED_CHATS) {
    // 条数硬顶：追加新会话被拒（替换既有会话不受限），回 ack 让客户端收敛 inflight
    log.warn("sync_chat 拒绝：会话数超上限", tenant.id, MAX_STORED_CHATS);
    send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
    return;
  }
  // 先写 rev 再落盘（P4 审核：崩溃窗口不能出现「新内容旧 rev」）。
  // 无变化的重推不动全局 rev：否则其他设备的下一次推送会因 rev 落后被拒，白白多一轮对账。
  // chatRevs[id] 同样只在内容真变时前进（P8 审核：无变化 sync 也 bump 的话，其他端重连时
  // 会把纯元数据/未读类本地脏误判成正文变更，整会话作废重载）
  if (changed) {
    tenant.disk.rev = clientRev;
    tenant.disk.chatRevs[id] = clientRev;
    tenant.disk.chats = prev
      ? tenant.disk.chats.map((item) => (chatIdOf(item) === id ? next : item))
      : [...tenant.disk.chats, next];
  }
  persistConn(conn);
  // ack 回报服务端真实 chatRev（无变化时不前进），客户端对账口径与 digest 一致
  send(ws, {
    type: "sync_ack",
    rev: tenant.disk.rev,
    chatRevs: { [id]: tenant.disk.chatRevs[id] ?? clientRev },
    keptBodies: true,
  });
  if (changed) broadcastDigest(tenant, ws); // 多设备实时对账
}

// P4c：stored_digest 后按需拉取单个会话全量
export function onLoadChats({ ws, state, tenant }: WsCtx, message: MessageOf<"load_chats">) {
  const ids = (Array.isArray(message.ids) ? message.ids : [])
    .filter((item): item is string => typeof item === "string" && Boolean(item))
    .slice(0, 200); // 上限防滥用；正常分叉差异只有几条
  const gone = new Set(tenant.disk.deletedIds);
  const connNow = state.conns.get(ws);
  const limit = connNow?.maxMessageBytes ?? 0;
  // 注意：load_chats 对 slim_state 客户端也回全量——它只服务 digest 差异对账（通常单会话），
  // 是跨设备 turns 更新的唯一通道。带 slim_chats 的客户端按 segHashes 自己走 load_chat 补正文
  const slimRows = connNow?.caps.has("slim_chats") ?? false;
  for (const id of ids) {
    if (gone.has(id)) continue;
    const chat = tenant.disk.chats.find((item) => chatIdOf(item) === id);
    if (!chat) continue;
    const payload = {
      type: "stored_chat" as const,
      chat: slimRows ? slimChat(tenant.bodies, chat) : omitClientDraft(chat),
      rev: tenant.disk.chatRevs[id] ?? 0,
    };
    // 单条同样过接收上限护栏：超限回落 deferred，客户端走 HTTP /state 全量
    if (limit > 0 && Buffer.byteLength(JSON.stringify(payload)) > limit) {
      send(ws, { type: "stored_state_deferred", rev: tenant.disk.rev });
      continue;
    }
    send(ws, payload);
  }
}

// P8：slim 客户端的会话内容分页——from 省略=最后一页，否则返回 turns[..<from] 的上一页。
// 条数（40）与字节（接收上限 80%）双上限：落盘 turns 没有 history 路径的 80KB clip，
// 单条巨 turn 也能撑爆 WS 帧，必须按字节组页（评审 GLM m4 / Grok M5）
export function onLoadChat({ ws, conn, tenant }: WsCtx, message: MessageOf<"load_chat">) {
  const id = typeof message.chatId === "string" ? message.chatId : "";
  // 分页代际 nonce 原样回显（Kimi R2 M1）：客户端降级/重启分页后靠它丢弃旧链迟到页
  const nonce = typeof message.nonce === "number" && Number.isFinite(message.nonce) ? message.nonce : undefined;
  const gone = tenant.disk.deletedIds.includes(id);
  const chat = id && !gone ? tenant.disk.chats.find((item) => chatIdOf(item) === id) : null;
  const all =
    chat && typeof chat === "object" && Array.isArray((chat as { turns?: unknown }).turns)
      ? (chat as { turns: unknown[] }).turns
      : [];
  const to =
    typeof message.from === "number" && Number.isFinite(message.from)
      ? Math.max(0, Math.min(Math.floor(message.from), all.length))
      : all.length;
  const declared = conn.maxMessageBytes;
  const budget = declared > 0 ? Math.floor(declared * 0.8) : 800 * 1024;
  const page: unknown[] = [];
  let bytes = 0;
  let from = to;
  while (from > 0 && page.length < 40) {
    let turn = all[from - 1];
    let size = Buffer.byteLength(JSON.stringify(turn));
    if (size > budget) {
      turn = clipTurnForPage(turn, budget);
      size = Buffer.byteLength(JSON.stringify(turn));
    }
    if (bytes + size > budget && page.length > 0) break;
    page.unshift(turn);
    bytes += size;
    from -= 1;
  }
  // 与 stored_state 同口径的 settle：非 live 会话的磁盘 running 残留（崩溃遗留）
  // 不能原样下发，否则 iOS 上永远转圈（Kimi 设计评审 MINOR6）
  const settledPage = runningChatIds(tenant).includes(id)
    ? page
    : (settlePersistedChats([{ turns: page }])[0] as { turns: unknown[] }).turns;
  send(ws, { type: "chat_turns", chatId: id, turns: settledPage, from, hasMore: from > 0, total: all.length, nonce });
}
