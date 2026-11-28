// 管理员：全租户使用统计
import { allTenants } from "../../tenants.ts";
import { cursorBill } from "../../cursorBill.ts";
import { usageSnapshot } from "../../usage.ts";
import { gatewayEnv } from "../../config.ts";
import { send } from "../send.ts";
import { sliceOffsetPage } from "../../pagination.ts";
import type { MessageOf, WsCtx } from "./types.ts";

// P9：管理员查询全租户使用统计。租户行是网关自计量；
// cursor 是当前 CURSOR_API_KEY 的官方账单（与 CLI /usage 同一接口）。
export async function onAdminStats({ ws, state, tenant }: WsCtx, message?: MessageOf<"admin_stats">) {
  if (!tenant.admin) {
    send(ws, { type: "error", message: "需要管理员权限。" });
    return;
  }
  const rows = allTenants().map((item) => {
    const usage = usageSnapshot(item.id);
    const online = [...state.conns.values()].filter((other) => other.authed && other.tenant?.id === item.id).length;
    return {
      id: item.id,
      name: item.name,
      admin: item.admin,
      online,
      chats: item.disk.chats.length,
      turns: usage.turns,
      runs: usage.runs,
      toolCalls: usage.toolCalls,
      runMs: usage.runMs,
      inChars: usage.inChars,
      outChars: usage.outChars,
      estTokens: Math.round((usage.inChars + usage.outChars) / 4),
      modelInTokens: usage.modelInTokens,
      modelOutTokens: usage.modelOutTokens,
      modelCacheTokens: usage.modelCacheTokens,
      firstSeenAt: usage.firstSeenAt,
      lastActiveAt: usage.lastActiveAt,
    };
  });
  const hasPaging = message?.cursor !== undefined || message?.limit !== undefined;
  const paged = hasPaging
    ? sliceOffsetPage(rows, { cursor: message?.cursor, limit: message?.limit, defaultLimit: 30, maxLimit: 100 })
    : { items: rows, total: rows.length, hasMore: false, nextCursor: undefined, offset: 0 };
  // 翻页续拉（offset > 0）免重复拉取外部 Cursor 账单。
  const isFirstPage = paged.offset === 0;
  const cursor = isFirstPage ? await cursorBill(gatewayEnv.cursorApiKey()) : undefined;
  send(ws, {
    type: "admin_stats",
    serverTime: Date.now(),
    tenants: paged.items,
    ...(cursor ? { cursor } : {}),
    tenantsTotal: paged.total,
    tenantsHasMore: paged.hasMore,
    ...(paged.nextCursor ? { tenantsNextCursor: paged.nextCursor } : {}),
  });
}
