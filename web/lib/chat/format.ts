// 文案与数字格式化：错误提示、耗时、token/金额/百分比、相对时间
import type { CursorBill } from "@shared/protocol";

export function friendlyError(text: string) {
  if (/agent[- ].*not found/i.test(text)) return "这条会话在服务器上已经不在了，重试会开新的。";
  return text.replace(/agent-[a-z0-9-]+/gi, "Agent");
}

export function formatDuration(ms?: number) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function isProgressBlurb(text: string) {
  const t = text.trim();
  return t.length > 0 && t.length < 100 && /^正在/.test(t) && !t.includes("\n");
}

export function runMeta(status?: string, ms?: number) {
  const key = (status || "").toLowerCase();
  const label =
    key === "cancelled" || key === "canceled"
      ? "已停止"
      : key === "error" || key === "failed"
        ? "出错"
        : key === "approval"
          ? "待确认"
          : "完成";
  const time = formatDuration(ms);
  return time ? `${label} · ${time}` : label;
}

export function fmtTokens(value: number) {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

export function fmtCount(value: number) {
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return value.toLocaleString("zh-CN");
}

export function fmtDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function fmtUsd(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(value: number) {
  const n = Math.max(0, Math.min(100, value));
  if (n > 0 && n < 1) return "1%";
  return `${Math.round(n)}%`;
}

export function fmtCycle(ms?: number) {
  if (!ms || ms <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone: "UTC" }).format(ms);
}

export function onDemandText(row: NonNullable<CursorBill["onDemand"]>) {
  const used = fmtUsd(row.usedCents);
  if (row.kind === "fixed" && typeof row.limitCents === "number") return `${used} / ${fmtUsd(row.limitCents)}`;
  if (row.kind === "unlimited") return `${used} · 无上限`;
  if (row.kind === "disabled") return "已关闭";
  return "—";
}

export function fmtRelative(epochMs: number) {
  if (!(epochMs > 0)) return "—";
  const seconds = (Date.now() - epochMs) / 1000;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

/** 侧栏里用的短相对时间：刚刚 / 5 分 / 3 时 / 2 天 / 10月3日 */
export function fmtAgo(epochMs?: number, long = false) {
  if (!epochMs || !(epochMs > 0)) return "";
  const seconds = Math.max(0, (Date.now() - epochMs) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} ${long ? "分钟前" : "分"}`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} ${long ? "小时前" : "时"}`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)} ${long ? "天前" : "天"}`;
  const d = new Date(epochMs);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtClock(epochMs: number) {
  if (!(epochMs > 0)) return "";
  return new Date(epochMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
