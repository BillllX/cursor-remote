// 聊天列表里的工作区 Agent：目录清单、固定主会话映射、资料与未读。
// 映射独立于会话正文；所有读改写均同步完成，避免两台设备同时首次打开时创建两条主会话。
import crypto from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { WebSocket } from "ws";
import type { ImTicket, ServerMessage, WorkspaceAgentRow } from "../../../shared/protocol.ts";
import { atomicWriteFileSync } from "../fsAtomic.ts";
import { imTicket } from "../im/ticket.ts";
import { log } from "../log.ts";
import { chatIdOf } from "../runtime/chats.ts";
import { gatewayState, liveSlotsOf } from "../runtime/state.ts";
import { broadcastDigest } from "../sync/storedState.ts";
import { mediaSecret, saveDiskNow, type Tenant } from "../tenants.ts";
import { reply } from "../ws/frame.ts";

export const WORKSPACE_AVATARS_SCOPE = "workspace-avatars";

export type WorkspaceAgentItem = {
  path: string;
  mainChatId?: string;
  displayName?: string;
  avatarBlob?: string;
  lastReadSeq: number;
  unread: number;
  lastActivityAt: number;
  lastFinishedSeq: number;
  /** 一轮只计一次注意序号：待批先计，之后同 turnId 完成不重复增加。 */
  lastAttentionTurnId?: string;
};

type WorkspaceAgentFile = { version: 1; items: Record<string, WorkspaceAgentItem> };

function mappingFile(tenant: Tenant) {
  return resolve(tenant.stateDir, "workspace-agent-chats.json");
}

export function readWorkspaceAgentFile(tenant: Tenant): WorkspaceAgentFile {
  try {
    const parsed = JSON.parse(readFileSync(mappingFile(tenant), "utf8")) as Partial<WorkspaceAgentFile>;
    const items: Record<string, WorkspaceAgentItem> = {};
    if (parsed.items && typeof parsed.items === "object") {
      for (const [key, raw] of Object.entries(parsed.items)) {
        if (!validWorkspaceKey(key) || !raw || typeof raw !== "object") continue;
        const row = raw as Partial<WorkspaceAgentItem>;
        items[key] = {
          path: resolve(tenant.workspaceRoot, key),
          ...(typeof row.mainChatId === "string" && row.mainChatId ? { mainChatId: row.mainChatId } : {}),
          ...(typeof row.displayName === "string" && row.displayName.trim()
            ? { displayName: row.displayName.trim().slice(0, 80) }
            : {}),
          ...(typeof row.avatarBlob === "string" && /^[0-9a-f]{64}$/.test(row.avatarBlob)
            ? { avatarBlob: row.avatarBlob }
            : {}),
          lastReadSeq: nonnegative(row.lastReadSeq),
          unread: nonnegative(row.unread),
          lastActivityAt: nonnegative(row.lastActivityAt),
          lastFinishedSeq: nonnegative(row.lastFinishedSeq),
          ...(typeof row.lastAttentionTurnId === "string" && row.lastAttentionTurnId
            ? { lastAttentionTurnId: row.lastAttentionTurnId }
            : {}),
        };
      }
    }
    return { version: 1, items };
  } catch {
    return { version: 1, items: {} };
  }
}

function nonnegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function writeWorkspaceAgentFile(tenant: Tenant, file: WorkspaceAgentFile) {
  mkdirSync(tenant.stateDir, { recursive: true });
  atomicWriteFileSync(mappingFile(tenant), JSON.stringify(file), { encoding: "utf8" });
}

export function validWorkspaceKey(key: string) {
  return Boolean(
    key && key !== "." && key !== ".." && !key.startsWith(".") && !key.includes("/") && !key.includes("\\"),
  );
}

export function workspaceKey(tenant: Tenant, rawPath: string): string | null {
  const root = resolve(tenant.workspaceRoot);
  const path = resolve(rawPath);
  const key = relative(root, path);
  return validWorkspaceKey(key) && resolve(root, key) === path ? key : null;
}

/** 只以磁盘上真实存在、非隐藏的一级目录为基表；运行槽绝不能创造列表项。 */
export function workspaceAgentDirectories(tenant: Tenant): Array<{ key: string; path: string }> {
  const root = resolve(tenant.workspaceRoot);
  let hidden = new Set<string>();
  try {
    const raw = JSON.parse(readFileSync(resolve(tenant.stateDir, "hidden-workspaces.json"), "utf8")) as unknown;
    hidden = new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);
  } catch {
    // 没有隐藏清单。
  }
  const rows: Array<{ key: string; path: string }> = [];
  try {
    for (const key of readdirSync(root).sort()) {
      if (!validWorkspaceKey(key) || hidden.has(key)) continue;
      const path = resolve(root, key);
      try {
        if (statSync(path).isDirectory()) rows.push({ key, path });
      } catch {
        // 目录在快照期间消失，跳过即可。
      }
    }
  } catch {
    return [];
  }
  return rows;
}

function chatIsLive(tenant: Tenant, chatId: string | undefined) {
  if (!chatId || tenant.disk.deletedIds.includes(chatId)) return false;
  return tenant.disk.chats.some((chat) => chatIdOf(chat) === chatId);
}

function mainChatMatchesDirectory(tenant: Tenant, chatId: string | undefined, directory: string) {
  if (!chatIsLive(tenant, chatId)) return false;
  const chat = tenant.disk.chats.find((item) => chatIdOf(item) === chatId) as { cwd?: unknown } | undefined;
  return typeof chat?.cwd === "string" && resolve(chat.cwd) === resolve(directory);
}

function createMainChat(tenant: Tenant, path: string) {
  const chatId = crypto.randomUUID();
  tenant.disk.chats.push({ id: chatId, title: "新对话", turns: [], cwd: path });
  tenant.disk.deletedIds = tenant.disk.deletedIds.filter((id) => id !== chatId);
  tenant.disk.rev += 1;
  tenant.disk.chatRevs[chatId] = tenant.disk.rev;
  return chatId;
}

/**
 * 无 await 的同步临界段：读映射 → 验证墓碑 → 建普通会话 → 写映射 →
 * rev/chatRevs → state 持久化 → digest 广播。Node 事件循环内不会被另一条 open 插入。
 */
export function openWorkspaceAgent(
  tenant: Tenant,
  rawPath: string,
): { key: string; path: string; chatId: string } | null {
  const key = workspaceKey(tenant, rawPath);
  const directory = key ? workspaceAgentDirectories(tenant).find((item) => item.key === key) : undefined;
  if (!key || !directory) return null;
  const file = readWorkspaceAgentFile(tenant);
  const previous = file.items[key];
  let chatId = previous?.mainChatId;
  // 历史坏映射可能指向仍存活、但 cwd 已不属于该目录的会话；不能继续复用旧 Agent。
  const created = !mainChatMatchesDirectory(tenant, chatId, directory.path);
  const previousRev = tenant.disk.rev;
  if (created) chatId = createMainChat(tenant, directory.path);
  const mainChatId = chatId || createMainChat(tenant, directory.path);
  file.items[key] = {
    ...previous,
    path: directory.path,
    mainChatId,
    lastReadSeq: previous?.lastReadSeq ?? 0,
    unread: previous?.unread ?? 0,
    lastActivityAt: previous?.lastActivityAt ?? 0,
    lastFinishedSeq: previous?.lastFinishedSeq ?? 0,
  };
  try {
    writeWorkspaceAgentFile(tenant, file);
  } catch (error) {
    if (created) {
      tenant.disk.chats = tenant.disk.chats.filter((item) => chatIdOf(item) !== mainChatId);
      delete tenant.disk.chatRevs[mainChatId];
      tenant.disk.rev = previousRev;
    }
    throw error;
  }
  // 新建会话时 createMainChat 已推进版本；已有会话也立即持久化映射，整个 open 无异步窗口。
  saveDiskNow(tenant);
  broadcastDigest(tenant);
  broadcastWorkspaceAgents(tenant);
  return { key, path: directory.path, chatId: mainChatId };
}

export function workspaceMainChatIds(tenant: Tenant): Set<string> {
  const file = readWorkspaceAgentFile(tenant);
  return new Set(
    Object.values(file.items)
      .map((item) => item.mainChatId)
      .filter((id): id is string => Boolean(id) && chatIsLive(tenant, id)),
  );
}

export function workspaceAgentByChat(tenant: Tenant, chatId: string) {
  const file = readWorkspaceAgentFile(tenant);
  const found = Object.entries(file.items).find(([, item]) => item.mainChatId === chatId);
  return found ? { file, key: found[0], item: found[1] } : null;
}

export function forgetWorkspaceAgentChat(tenant: Tenant, chatId: string) {
  const file = readWorkspaceAgentFile(tenant);
  let changed = false;
  for (const item of Object.values(file.items)) {
    if (item.mainChatId !== chatId) continue;
    delete item.mainChatId;
    item.unread = 0;
    item.lastReadSeq = item.lastFinishedSeq;
    changed = true;
  }
  if (changed) {
    writeWorkspaceAgentFile(tenant, file);
    broadcastWorkspaceAgents(tenant);
  }
}

export function migrateWorkspaceAgent(tenant: Tenant, fromKey: string, toKey: string, toPath: string) {
  const file = readWorkspaceAgentFile(tenant);
  const item = file.items[fromKey];
  if (!item) return;
  delete file.items[fromKey];
  file.items[toKey] = { ...item, path: toPath };
  writeWorkspaceAgentFile(tenant, file);
}

/** 删除/隐藏工作区时一起清映射；空主会话由调用方墓碑化。 */
export function removeWorkspaceAgent(tenant: Tenant, key: string): string | undefined {
  const file = readWorkspaceAgentFile(tenant);
  const chatId = file.items[key]?.mainChatId;
  if (!file.items[key]) return chatId;
  delete file.items[key];
  writeWorkspaceAgentFile(tenant, file);
  return chatId;
}

export function updateWorkspaceAgentProfile(
  tenant: Tenant,
  rawPath: string,
  displayName: string | null | undefined,
  avatarBlob: string | null | undefined,
) {
  const key = workspaceKey(tenant, rawPath);
  if (!key || !workspaceAgentDirectories(tenant).some((item) => item.key === key)) return false;
  const file = readWorkspaceAgentFile(tenant);
  const previous = file.items[key];
  const item: WorkspaceAgentItem = previous ?? {
    path: resolve(tenant.workspaceRoot, key),
    lastReadSeq: 0,
    unread: 0,
    lastActivityAt: 0,
    lastFinishedSeq: 0,
  };
  if (displayName !== undefined) {
    const value = displayName?.trim().slice(0, 80);
    if (value) item.displayName = value;
    else delete item.displayName;
  }
  if (avatarBlob !== undefined) {
    if (avatarBlob && /^[0-9a-f]{64}$/.test(avatarBlob)) item.avatarBlob = avatarBlob;
    else delete item.avatarBlob;
  }
  file.items[key] = item;
  writeWorkspaceAgentFile(tenant, file);
  broadcastWorkspaceAgents(tenant);
  return true;
}

export function markWorkspaceAgentRead(tenant: Tenant, chatId: string, seq: number) {
  const found = workspaceAgentByChat(tenant, chatId);
  if (!found) return false;
  const next = Math.min(nonnegative(seq), found.item.lastFinishedSeq);
  if (next < found.item.lastReadSeq) return true;
  found.item.lastReadSeq = next;
  found.item.unread = Math.max(0, found.item.lastFinishedSeq - next);
  writeWorkspaceAgentFile(tenant, found.file);
  broadcastWorkspaceAgents(tenant);
  return true;
}

export function noteWorkspaceAgentFinished(tenant: Tenant, chatId: string) {
  return noteWorkspaceAgentAttention(tenant, chatId, "", "completed");
}

/**
 * 每个 turnId 最多增加一次注意序号。审批是该轮的首次注意事件；审批后的最终完成只刷新状态，
 * 不再次增加 unread。没有 turnId 的旧调用保持“每次完成计一次”的兼容行为。
 */
export function noteWorkspaceAgentAttention(
  tenant: Tenant,
  chatId: string,
  turnId: string,
  kind: "approval" | "completed" | "failed",
) {
  const found = workspaceAgentByChat(tenant, chatId);
  if (!found) return null;
  const firstForTurn = !turnId || found.item.lastAttentionTurnId !== turnId;
  if (firstForTurn) {
    found.item.lastFinishedSeq += 1;
    if (turnId) found.item.lastAttentionTurnId = turnId;
  }
  found.item.lastActivityAt = Date.now();
  const watched = [...gatewayState.conns.values()].some(
    (conn) =>
      conn.authed &&
      conn.tenant?.id === tenant.id &&
      conn.imForeground !== false &&
      conn.workspaceViewingChatId === chatId,
  );
  if (firstForTurn) {
    if (!watched) found.item.unread = Math.max(0, found.item.lastFinishedSeq - found.item.lastReadSeq);
    else {
      found.item.lastReadSeq = found.item.lastFinishedSeq;
      found.item.unread = 0;
    }
  }
  writeWorkspaceAgentFile(tenant, found.file);
  broadcastWorkspaceAgents(tenant);
  return { watched, firstForTurn, kind, item: found.item, key: found.key };
}

export function workspaceUnread(tenant: Tenant) {
  return Object.values(readWorkspaceAgentFile(tenant).items).reduce((sum, item) => sum + item.unread, 0);
}

export function workspaceAvatarAllowed(tenant: Tenant, sha: string) {
  return Object.values(readWorkspaceAgentFile(tenant).items).some((item) => item.avatarBlob === sha);
}

const WORKSPACE_AGENT_PAGE_SIZE = 100;

export function workspaceAgentPage(
  tenant: Tenant,
  cursor?: string,
): { rows: WorkspaceAgentRow[]; more: boolean; nextCursor?: string } {
  // 同一个同步调用里先取三份快照，再 join；改名不会在中间插入。
  const directories = workspaceAgentDirectories(tenant);
  const file = readWorkspaceAgentFile(tenant);
  const live = new Map(liveSlotsOf(tenant));
  const start = cursor ? directories.findIndex((item) => item.key > cursor) : 0;
  const page = start < 0 ? [] : directories.slice(start, start + WORKSPACE_AGENT_PAGE_SIZE);
  const rows = page.map(({ key, path }) => {
    const item = file.items[key];
    const chatId = item?.mainChatId;
    const validChatId = mainChatMatchesDirectory(tenant, chatId, path) ? chatId : undefined;
    const slot = validChatId ? live.get(validChatId) : undefined;
    const status = slot
      ? slot.awaitingApproval
        ? "awaiting"
        : !slot.finished
          ? "running"
          : slot.pending.length
            ? "queued"
            : "idle"
      : "idle";
    return {
      path,
      directoryName: key,
      displayName: item?.displayName || key,
      avatarBlob: item?.avatarBlob,
      mainChatId: validChatId,
      status,
      unread: item?.unread ?? 0,
      readSeq: item?.lastReadSeq ?? 0,
      finishedSeq: item?.lastFinishedSeq ?? 0,
      lastActivityAt: item?.lastActivityAt ?? 0,
    } satisfies WorkspaceAgentRow;
  });
  const more = start >= 0 && start + page.length < directories.length;
  return {
    rows,
    more,
    ...(more && page.length ? { nextCursor: page[page.length - 1].key } : {}),
  };
}

export function workspaceAgentRows(
  tenant: Tenant,
  cursor?: string,
): { rows: WorkspaceAgentRow[]; ticket: ImTicket; more: boolean; nextCursor?: string } {
  return {
    ...workspaceAgentPage(tenant, cursor),
    ticket: imTicket(mediaSecret(), tenant.id, WORKSPACE_AVATARS_SCOPE),
  };
}

export function workspaceAgentsMessage(tenant: Tenant, cursor?: string): ServerMessage {
  const { rows, ticket, more, nextCursor } = workspaceAgentRows(tenant, cursor);
  return {
    type: "workspace_agents",
    workspaces: rows,
    avatarTicket: ticket,
    reset: !cursor,
    more,
    ...(cursor ? { after: cursor } : {}),
    cursor: nextCursor,
  };
}

export function broadcastWorkspaceAgents(tenant: Tenant, except?: WebSocket) {
  let message: ServerMessage | undefined;
  for (const conn of gatewayState.conns.values()) {
    if (conn.ws === except || !conn.authed || conn.tenant?.id !== tenant.id) continue;
    message ??= workspaceAgentsMessage(tenant);
    reply(conn.ws, message);
  }
}

export function logWorkspaceAgentError(tenant: Tenant, operation: string, error: unknown) {
  log.warn(`工作区 Agent ${operation}失败`, tenant.id, error instanceof Error ? error.message : error);
}
