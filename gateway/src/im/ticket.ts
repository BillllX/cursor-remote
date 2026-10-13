// IM 下载票据：HMAC 签（租户, scope, exp），scope 是会话号或 "avatars"。
// 密钥由媒体密钥按用途派生，和 /media 的预览票据互不通用。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ImTicket } from "../../../shared/protocol.ts";

export const IM_TICKET_TTL_MS = 2 * 60 * 60_000;
export const AVATARS_SCOPE = "avatars";

function imKey(secret: string) {
  return createHmac("sha256", secret).update("cursor-remote-im-ticket").digest();
}

export function signImTicket(secret: string, tenantId: string, scope: string, exp: number): string {
  return createHmac("sha256", imKey(secret)).update(`${tenantId}\n${scope}\n${exp}`).digest("base64url");
}

export function imTicket(secret: string, tenantId: string, scope: string, now = Date.now()): ImTicket {
  const exp = now + IM_TICKET_TTL_MS;
  return { exp, sig: signImTicket(secret, tenantId, scope, exp) };
}

export function imTicketOk(
  secret: string,
  tenantId: string,
  scope: string,
  exp: string,
  sig: string,
  now = Date.now(),
) {
  const until = Number(exp);
  if (!secret || !tenantId || !scope || !sig || !Number.isFinite(until) || now > until) return false;
  const expected = Buffer.from(signImTicket(secret, tenantId, scope, until));
  const got = Buffer.from(sig);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

/** 票据里没有租户 id：逐个租户验签，找出签发对象 */
export function matchImTicketTenant(
  secret: string,
  tenantIds: string[],
  scope: string,
  exp: string,
  sig: string,
  now = Date.now(),
): string | null {
  let matched: string | null = null;
  for (const id of tenantIds) {
    if (imTicketOk(secret, id, scope, exp, sig, now)) matched = id;
  }
  return matched;
}
