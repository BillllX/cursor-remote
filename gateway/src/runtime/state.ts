// 模块级运行状态（进程内单例）：各租户的活动槽位、连接表、ws 归属、登录限流、会话命名等
import type { WebSocket } from "ws";
import type { Tenant } from "../tenants.ts";
import type { Conn, Slot } from "./types.ts";

export const liveByTenant = new Map<string, Map<string, Slot>>();

export const conns = new Map<WebSocket, Conn>();

export const namingChats = new Set<string>();

export const namedChats = new Set<string>();

export const loginHits = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

export function liveSlotsOf(tenant: Tenant): Map<string, Slot> {
  let map = liveByTenant.get(tenant.id);
  if (!map) {
    map = new Map();
    liveByTenant.set(tenant.id, map);
  }
  return map;
}

/** 连接登出后，它发起的那一轮还会继续往这个 ws 发事件：归属不随 detachConn 清掉。 */
export const wsTenant = new WeakMap<WebSocket, string>();

export const assistantRolledAt = new WeakMap<Slot, number>();
