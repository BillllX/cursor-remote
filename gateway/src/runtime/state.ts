// 跨模块共享的运行时状态：各租户的活动槽位、连接表、ws 归属、登录限流、会话命名等。
// 进程内只有 gatewayState 一份，随进程存亡；ws 处理器经 ctx.state 访问它，其余模块直接引用。
import type { WebSocket } from "ws";
import type { Tenant } from "../tenants.ts";
import type { Conn, Slot } from "./types.ts";

export type LoginHit = { count: number; resetAt: number; blockedUntil: number };

export type GatewayState = {
  /** 租户 id → 会话 id → 活动槽位；同租户的所有连接共用同一张表 */
  liveByTenant: Map<string, Map<string, Slot>>;
  conns: Map<WebSocket, Conn>;
  /** 键是 chatNameKey(租户, 会话)：不同租户的会话 id 可以相同 */
  namingChats: Set<string>;
  /** 已起过标题的会话，键同上；会话删除时清掉，超过 NAMED_CHATS_MAX 淘汰最早的 */
  namedChats: Set<string>;
  /** 按来源 IP 的登录失败计数 */
  loginHits: Map<string, LoginHit>;
  /** 连接登出后，它发起的那一轮还会继续往这个 ws 发事件：归属不随 detachConn 清掉。 */
  wsTenant: WeakMap<WebSocket, string>;
  assistantRolledAt: WeakMap<Slot, number>;
};

/** 新建一份空状态；生产只用 gatewayState，测试用它造互不干扰的状态 */
export function createGatewayState(): GatewayState {
  return {
    liveByTenant: new Map(),
    conns: new Map(),
    namingChats: new Set(),
    namedChats: new Set(),
    loginHits: new Map(),
    wsTenant: new WeakMap(),
    assistantRolledAt: new WeakMap(),
  };
}

export const gatewayState = createGatewayState();

export const NAMED_CHATS_MAX = 5_000;

export function chatNameKey(tenantId: string, chatId: string) {
  return `${tenantId}\u0000${chatId}`;
}

export function markChatNamed(state: GatewayState, tenantId: string, chatId: string, max = NAMED_CHATS_MAX) {
  const key = chatNameKey(tenantId, chatId);
  state.namedChats.delete(key);
  state.namedChats.add(key);
  for (const old of state.namedChats) {
    if (state.namedChats.size <= max) break;
    state.namedChats.delete(old);
  }
}

export function forgetChatName(state: GatewayState, tenantId: string, chatId: string) {
  const key = chatNameKey(tenantId, chatId);
  state.namedChats.delete(key);
  state.namingChats.delete(key);
}

export function liveSlotsOf(tenant: Tenant, state: GatewayState = gatewayState): Map<string, Slot> {
  let map = state.liveByTenant.get(tenant.id);
  if (!map) {
    map = new Map();
    state.liveByTenant.set(tenant.id, map);
  }
  return map;
}
