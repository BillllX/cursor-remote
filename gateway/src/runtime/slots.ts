// 租户绑定、连接持久化与会话槽位：建槽/认领/释放、运行计数、会话工作目录
import { WebSocket } from "ws";
import type { ReviewBinding } from "../../../shared/crew.ts";
import { defaultPolicy } from "../../../shared/policy.ts";
import { bodySummary } from "../chatBodies.ts";
import { log } from "../log.ts";
import { allTenants, confinedCwd, type DiskSlot, requireCwd, saveDisk, type Tenant } from "../tenants.ts";
import { cancelRun } from "./abort.ts";
import { resolveApprovalWait } from "./approvals.ts";
import { assistantCwd, chatIdOf, isAssistantChat } from "./chats.ts";
import { gatewayState, liveSlotsOf } from "./state.ts";
import type { Checkpoint, Conn, Slot } from "./types.ts";

export function bindTenant(conn: Conn, tenant: Tenant) {
  gatewayState.wsTenant.set(conn.ws, tenant.id);
  conn.tenant = tenant;
  conn.slots = liveSlotsOf(tenant);
  conn.cwd = tenant.workspaceRoot;
  conn.authed = true;
}

export function detachConn(conn: Conn) {
  if (!conn.tenant) return;
  persistConn(conn);
  for (const slot of conn.slots.values()) {
    if (slot.owner === conn.ws) slot.owner = null;
  }
  conn.tenant = null;
  conn.slots = new Map();
  conn.authed = false;
}

/** 运行中 owner 不换手：另一台设备连上或查文件不能把流式输出抢走。空闲或原 owner 已断开才接管。 */
function claimSlot(slot: Slot, ws: WebSocket) {
  const busy = !slot.finished || slot.pending.length > 0 || slot.awaitingApproval;
  if (busy && slot.owner && slot.owner !== ws && slot.owner.readyState === WebSocket.OPEN) return;
  slot.owner = ws;
}

/** 会话编号由客户端生成，不同租户可能撞号：只在发起连接所属租户里找。 */
export function slotByChat(tenantId: string, chatId: string): Slot | undefined {
  return gatewayState.liveByTenant.get(tenantId)?.get(chatId);
}

export function persistConn(conn: Conn) {
  const tenant = conn.tenant;
  if (!tenant) return;
  persistTenant(tenant, conn.slots);
}

export function persistTenant(tenant: Tenant, slots = liveSlotsOf(tenant)) {
  const byId = new Map(tenant.disk.slots.map((item) => [item.chatId, item]));
  for (const slot of slots.values()) {
    byId.set(slot.chatId, {
      chatId: slot.chatId,
      agentId: slot.agentId,
      cwd: requireCwd(slot.cwd, tenant.workspaceRoot),
      model: slot.model,
      edited: slot.edited,
      checkpoints: slot.checkpoints,
      reviewRoster: slot.reviewRoster,
    });
  }
  tenant.disk.slots = [...byId.values()];
  saveDisk(tenant);
}

export function chatIdsFrom(chats: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const item of chats) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

export function pruneDroppedSlots(tenant: Tenant, keepIds: Set<string>) {
  if (!keepIds.size) return;
  const live = liveSlotsOf(tenant);
  for (const [chatId, slot] of [...live.entries()]) {
    if (keepIds.has(chatId)) continue;
    resolveApprovalWait(slot, false);
    void cancelRun(slot.run);
    void disposeSlot(slot);
    live.delete(chatId);
  }
  tenant.disk.slots = tenant.disk.slots.filter((item) => keepIds.has(item.chatId));
}

export function hydrateConn(conn: Conn) {
  const tenant = conn.tenant;
  if (!tenant) return;
  for (const saved of tenant.disk.slots) {
    if (conn.slots.has(saved.chatId)) continue;
    conn.slots.set(saved.chatId, makeSlot(tenant, saved.chatId, saved, conn.ws));
  }
}

export function diskSlot(tenant: Tenant, chatId: string): DiskSlot | undefined {
  return tenant.disk.slots.find((item) => item.chatId === chatId);
}

function diskChatCwd(tenant: Tenant, chatId: string): string | undefined {
  for (const item of tenant.disk.chats) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; cwd?: unknown };
    if (row.id !== chatId || typeof row.cwd !== "string" || !row.cwd.trim()) continue;
    return row.cwd;
  }
}

function makeSlot(tenant: Tenant, chatId: string, saved: DiskSlot | undefined, owner: WebSocket): Slot {
  return {
    tenantId: tenant.id,
    chatId,
    cwd: requireCwd(diskChatCwd(tenant, chatId) || saved?.cwd, tenant.workspaceRoot),
    model: saved?.model,
    agentId: saved?.agentId || null,
    agent: null,
    run: null,
    epoch: 0,
    finished: true,
    edited: saved?.edited || [],
    checkpoints: Array.isArray(saved?.checkpoints) ? (saved.checkpoints as Checkpoint[]) : [],
    awaitingApproval: false,
    lastShellCallId: null,
    owner,
    approvalWait: null,
    approvalSettled: null,
    pending: [],
    openTools: new Map(),
    reseed: false,
    externalAbort: null,
    policy: defaultPolicy(),
    approvedKeys: new Set(),
    approvalCallId: null,
    runStats: { toolStarts: 0, intercepts: 0, approvals: 0, replays: 0 },
    dialect: true,
    reviewRoster: rosterFromDisk(saved?.reviewRoster),
  };
}

function rosterFromDisk(raw: DiskSlot["reviewRoster"]): ReviewBinding[] | undefined {
  if (!Array.isArray(raw)) return;
  const rows: ReviewBinding[] = [];
  for (const item of raw) {
    if (!item || typeof item.name !== "string" || typeof item.modelId !== "string") continue;
    const name = item.name.trim();
    const modelId = item.modelId.trim();
    if (!name || !modelId) continue;
    rows.push({ name, modelId });
  }
  return raw.length ? rows : undefined;
}

export function slotOf(conn: Conn, chatId: string): Slot {
  const tenant = conn.tenant;
  if (!tenant) throw new Error("先发 hello。");
  let slot = conn.slots.get(chatId);
  if (!slot) {
    slot = makeSlot(tenant, chatId, diskSlot(tenant, chatId), conn.ws);
    conn.slots.set(chatId, slot);
  }
  claimSlot(slot, conn.ws);
  slot.tenantId = tenant.id;
  return slot;
}

export function runningChatIds(tenant: Tenant) {
  return (
    [...liveSlotsOf(tenant).values()]
      // P11：externalAbort 非空 = 第三方在途（无 RunHandle）——也算 running，否则重连丢运行态
      .filter((slot) => (!slot.finished && (slot.run || slot.externalAbort)) || slot.pending.length)
      .map((slot) => slot.chatId)
  );
}

export function queuedChatIds(tenant: Tenant) {
  return [...liveSlotsOf(tenant).values()].filter((slot) => slot.pending.length).map((slot) => slot.chatId);
}

export function globalRunningCount() {
  let n = 0;
  for (const tenant of allTenants()) {
    n += [...liveSlotsOf(tenant).values()].filter((slot) => !slot.finished && (slot.run || slot.externalAbort)).length;
  }
  return n;
}

export function maxRunning() {
  return Math.max(allTenants().length, 1);
}

export function attachLiveSlots(conn: Conn) {
  for (const slot of conn.slots.values()) {
    claimSlot(slot, conn.ws);
  }
}

function tenantOwnsChat(tenant: Tenant, chatId: string) {
  if (!chatId) return false;
  if (liveSlotsOf(tenant).has(chatId)) return true;
  if (tenant.disk.slots.some((item) => item.chatId === chatId)) return true;
  return tenant.disk.chats.some((item) => chatIdOf(item) === chatId);
}

export function chatOwnedByOther(chatId: string, except: Tenant) {
  if (!chatId) return false;
  for (const tenant of allTenants()) {
    if (tenant.id === except.id) continue;
    if (tenantOwnsChat(tenant, chatId)) return true;
  }
  return false;
}

export function cwdOf(conn: Conn, slot: Slot) {
  const root = conn.tenant?.workspaceRoot || slot.cwd;
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) return requireCwd(root, root);
  return requireCwd(slot.cwd || conn.cwd, root);
}

/**
 * 有过回合的会话目录固定在服务端那份：客户端上传、切会话时的 set_workspace、new_session 都改不了它，
 * 否则某台设备上旧的或误填的 cwd 会把会话挪组，还会重置 Agent。空会话仍可换目录（iOS 复用空白新对话）。
 */
export function lockedChatCwd(tenant: Tenant, chatId: string): string | null {
  if (isAssistantChat(tenant, chatId)) return assistantCwd(tenant);
  const row = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
  if (!row || typeof row !== "object") return null;
  const raw = (row as { cwd?: unknown }).cwd;
  const cwd = typeof raw === "string" && raw.trim() ? confinedCwd(raw, tenant.workspaceRoot) : null;
  if (!cwd) return null;
  return (bodySummary(row)?.count ?? 0) > 0 ? cwd : null;
}

export function cwdForChat(tenant: Tenant, chatId: string) {
  if (isAssistantChat(tenant, chatId)) return assistantCwd(tenant);
  const fromChat = diskChatCwd(tenant, chatId);
  if (fromChat) {
    const next = confinedCwd(fromChat, tenant.workspaceRoot);
    if (next) return next;
  }
  const live = liveSlotsOf(tenant).get(chatId);
  if (live?.cwd) {
    const next = confinedCwd(live.cwd, tenant.workspaceRoot);
    if (next) return next;
  }
  const saved = diskSlot(tenant, chatId);
  if (saved?.cwd) {
    const next = confinedCwd(saved.cwd, tenant.workspaceRoot);
    if (next) return next;
  }
  return tenant.workspaceRoot;
}

export async function disposeSlot(slot: Slot) {
  const agent = slot.agent;
  slot.agent = null;
  slot.run = null;
  // P11：第三方在途请求一并取消（new_session/fresh/delete 都走这里）——
  // 不 abort 的话旧流 delta 无 epoch 门可挡，会混进新会话（Grok 评审 C1）
  slot.externalAbort?.abort();
  slot.externalAbort = null;
  if (!agent) return;
  try {
    await agent[Symbol.asyncDispose]();
  } catch (err) {
    // Agent may already be closed.
    log.debug("释放 Agent 失败", slot.chatId, err instanceof Error ? err.message : err);
  }
}
