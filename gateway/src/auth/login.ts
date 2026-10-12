// 登录来源 IP 与失败限流
import type { IncomingMessage } from "node:http";
import { gatewayState, type LoginHit } from "../runtime/state.ts";

const WINDOW_MS = 10 * 60_000;
const MAX_FAILS = 8;
/** 条目上限：换 IP 刷口令时表不会无限长；超了先淘汰最久没失败过的 */
export const LOGIN_HITS_MAX = 10_000;
/** 表长到这么多才顺手扫一遍过期条目，平时不付 O(n) */
const PRUNE_AT = 512;
/** 全表扫过期条目最多这么久一次：表一直很长时每次失败都扫会被刷成 CPU 打满 */
export const LOGIN_SWEEP_EVERY_MS = 60_000;
const lastSweep = new WeakMap<Map<string, LoginHit>, number>();

export function peerIp(req?: IncomingMessage) {
  if (!req) return "unknown";
  const remote = req.socket.remoteAddress || "";
  const fromLoopback = remote === "127.0.0.1" || remote === "::1" || remote === ":ffff:127.0.0.1";
  if (fromLoopback) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      const last = forwarded
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .pop();
      if (last) return last;
    }
  }
  return remote || "unknown";
}

/** 计数窗口和封禁都过了的条目与不存在等价 */
function expired(row: LoginHit, now: number) {
  return now > row.resetAt && row.blockedUntil <= now;
}

export function sweepExpiredLoginHits(hits: Map<string, LoginHit>, now = Date.now()) {
  lastSweep.set(hits, now);
  for (const [ip, row] of hits) if (expired(row, now)) hits.delete(ip);
}

export function loginBlocked(ip: string, hits: Map<string, LoginHit> = gatewayState.loginHits, now = Date.now()) {
  const row = hits.get(ip);
  if (row && expired(row, now)) hits.delete(ip);
  return Boolean(row && row.blockedUntil > now);
}

export function noteLoginFail(
  ip: string,
  hits: Map<string, LoginHit> = gatewayState.loginHits,
  now = Date.now(),
  max = LOGIN_HITS_MAX,
) {
  const row = hits.get(ip) || { count: 0, resetAt: now + WINDOW_MS, blockedUntil: 0 };
  if (now > row.resetAt) {
    row.count = 0;
    row.resetAt = now + WINDOW_MS;
  }
  row.count += 1;
  if (row.count >= MAX_FAILS) row.blockedUntil = now + WINDOW_MS;
  hits.delete(ip);
  hits.set(ip, row);
  if (hits.size >= PRUNE_AT && now - (lastSweep.get(hits) ?? -Infinity) >= LOGIN_SWEEP_EVERY_MS)
    sweepExpiredLoginHits(hits, now);
  // Map 按插入顺序迭代，上面每次重新插入，开头就是最久没失败过的
  while (hits.size > max) hits.delete(hits.keys().next().value!);
}

export function noteLoginOk(ip: string, hits: Map<string, LoginHit> = gatewayState.loginHits) {
  hits.delete(ip);
}
