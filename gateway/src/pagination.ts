/** 通用偏移分页工具：统一处理非负整数游标、页大小限幅与标准分页元信息。 */

export type OffsetPage<T> = {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
  offset: number;
};

/** 解析不透明偏移游标（仅接受非负整数字符串），非法值回落到 0。 */
export function parseOffsetCursor(cursor?: string | null): number {
  if (typeof cursor !== "string") return 0;
  const trimmed = cursor.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** 将请求页大小收敛到 [1, maxLimit]，未提供或非法时取 defaultLimit。 */
export function clampPageLimit(limit: unknown, defaultLimit: number, maxLimit: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return defaultLimit;
  const n = Math.floor(limit);
  if (n < 1) return defaultLimit;
  return Math.min(n, maxLimit);
}

/** 对有序全集切片，输出标准分页元信息。 */
export function sliceOffsetPage<T>(
  all: readonly T[],
  opts: { cursor?: string | null; limit?: unknown; defaultLimit: number; maxLimit: number },
): OffsetPage<T> {
  const offset = Math.min(parseOffsetCursor(opts.cursor), all.length);
  const limit = clampPageLimit(opts.limit, opts.defaultLimit, opts.maxLimit);
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < all.length;
  return {
    items,
    total: all.length,
    hasMore,
    ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
    offset,
  };
}
