// 登录来源 IP 与失败限流
import type { IncomingMessage } from "node:http";
import { loginHits } from "../runtime/state.ts";

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

export function loginBlocked(ip: string) {
  const row = loginHits.get(ip);
  return Boolean(row && row.blockedUntil > Date.now());
}

export function noteLoginFail(ip: string) {
  const now = Date.now();
  const row = loginHits.get(ip) || { count: 0, resetAt: now + 10 * 60_000, blockedUntil: 0 };
  if (now > row.resetAt) {
    row.count = 0;
    row.resetAt = now + 10 * 60_000;
  }
  row.count += 1;
  if (row.count >= 8) row.blockedUntil = now + 10 * 60_000;
  loginHits.set(ip, row);
}

export function noteLoginOk(ip: string) {
  loginHits.delete(ip);
}
