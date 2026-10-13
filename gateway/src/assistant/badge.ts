import { readFile } from "node:fs/promises";
import { assistantPath, type TenantRef } from "./store.ts";

/** assistant_state.inbox 下发的条数；App 的助理角标只数这些里没读的 */
export const STATE_INBOX_LIMIT = 60;

async function readItems(file: string): Promise<Array<{ read?: boolean }>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { items?: unknown };
    return Array.isArray(parsed.items) ? (parsed.items as Array<{ read?: boolean }>) : [];
  } catch {
    return [];
  }
}

/**
 * 助理待处理数，和 iOS ChatStore.assistantBadgeCount 同一口径：
 * 最近 STATE_INBOX_LIMIT 条收件箱里没读的 + 挂起的审批。异步读文件，不卡住推送和事件循环
 */
export async function assistantBadge(ref: TenantRef): Promise<number> {
  const [inbox, approvals] = await Promise.all([
    readItems(assistantPath(ref, "inbox.json")),
    readItems(assistantPath(ref, "approvals.json")),
  ]);
  return inbox.slice(-STATE_INBOX_LIMIT).filter((item) => !item.read).length + approvals.length;
}

/** 等 work 最多 ms 毫秒；超时或失败返回 undefined（推送就不带角标，照旧发出去） */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 角标分量的等待上限：超时就用缓存/不带这个分量，不拖慢推送 */
export const BADGE_WAIT_MS = 500;
/** 缓存里的读数多久还算新鲜 */
const BADGE_CACHE_MS = 5 * 60_000;

const badgeCache = new Map<string, { value: number; at: number }>();

/** 带超时和短缓存的读数：按时完成记下并返回；超时/失败用新鲜缓存顶着（比不带更接近真值），缓存也过期才 undefined */
export async function withinCached(
  key: string,
  work: () => Promise<number>,
  ms: number,
  cacheMs: number = BADGE_CACHE_MS,
): Promise<number | undefined> {
  const value = await within(work(), ms);
  if (value !== undefined) {
    badgeCache.set(key, { value, at: Date.now() });
    return value;
  }
  const hit = badgeCache.get(key);
  return hit && Date.now() - hit.at <= cacheMs ? hit.value : undefined;
}

/** 带超时和短缓存的助理待处理数（IM 推送和助理推送用同一份，超时互相顶） */
export function assistantBadgeCached(ref: TenantRef, ms: number = BADGE_WAIT_MS): Promise<number | undefined> {
  return withinCached(`assistant:${ref.stateDir}`, () => assistantBadge(ref), ms);
}
