// IM 会话号与可见性规则（纯函数）
import { createHash } from "node:crypto";

/** 租户 id 规则同 tenants.ts：小写字母、数字、短横线，不含 "~" */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DM_RE = /^dm~([a-z0-9][a-z0-9-]{0,31})~([a-z0-9][a-z0-9-]{0,31})$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_RE.test(value);
}

/**
 * 单聊会话号：`dm~<较小 id>~<较大 id>`（按字符串排序）。
 * 租户 id 里可能有短横线但不会有 "~"，所以按 "~" 切分没有歧义；"~" 也是 URL 非保留字符、可做目录名。
 */
export function dmConvId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `dm~${lo}~${hi}`;
}

/** 解析单聊会话号；格式不对、两边相同或没按顺序排都返回 null */
export function parseDmConvId(convId: unknown): [string, string] | null {
  if (typeof convId !== "string") return null;
  const match = DM_RE.exec(convId);
  if (!match) return null;
  const [, lo, hi] = match;
  if (!(lo < hi)) return null;
  return [lo, hi];
}

export type ImPeer = { id: string; name: string; imHidden?: boolean };

/** 同一网关内 imHidden 相同就互相可见（验收账号之间互相可见，和正式用户互不可见） */
export function imVisible(a: Pick<ImPeer, "imHidden">, b: Pick<ImPeer, "imHidden">): boolean {
  return Boolean(a.imHidden) === Boolean(b.imHidden);
}

/** APNs aps.thread-id：同一会话的通知归成一组 */
export function imThreadId(convId: string): string {
  return `im-${convId}`;
}

/** apns-collapse-id：会话号哈希 + seq，只含安全字符且不超过 64 字节；撤回时用同一个替换原通知 */
export function imCollapseId(convId: string, seq: number): string {
  const digest = createHash("sha256").update(convId).digest("hex").slice(0, 24);
  return `im-${digest}-${seq}`;
}
