"use client";

import { useEffect, useRef } from "react";
import styles from "./PaginationBar.module.css";

export type PaginationBarProps = {
  /** 是否还有更多数据可分页加载 */
  hasMore: boolean;
  /** 当前是否正在请求下一页 */
  loading?: boolean;
  /** 已加载条数 */
  loadedCount?: number;
  /** 总条数（未知时可省略） */
  totalCount?: number;
  /** 按钮文案，默认“加载更多”或“加载更早内容” */
  label?: string;
  /** 展示位置：底部续拉或顶部向上加载更早内容 */
  placement?: "bottom" | "top";
  /** 紧凑模式（适合侧栏、抽屉与浮层内嵌列表） */
  compact?: boolean;
  /** 开启后进入视口自动触发一次下一页加载（仅 bottom 模式生效） */
  autoLoad?: boolean;
  onLoadMore: () => void;
};

/** 通用分页浏览控件：支持手动点击翻页、可选底部触底自动续拉及条数进度提示。 */
export function PaginationBar({
  hasMore,
  loading = false,
  loadedCount,
  totalCount,
  label,
  placement = "bottom",
  compact = false,
  autoLoad = false,
  onLoadMore,
}: PaginationBarProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onLoadMore);
  callbackRef.current = onLoadMore;
  // 防呆守卫：同一已加载条数下最多自动触发一次，避免失败后 loading 复位引发 IntersectionObserver 无限重试死循环
  const autoAttemptedCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (!autoLoad || placement !== "bottom" || !hasMore || loading) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const currentCount = typeof loadedCount === "number" ? loadedCount : -1;
    if (autoAttemptedCountRef.current === currentCount) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          autoAttemptedCountRef.current = currentCount;
          observer.disconnect();
          callbackRef.current();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoLoad, hasMore, loading, placement, loadedCount]);

  if (!hasMore && !loading) return null;

  const buttonText = loading
    ? "正在加载…"
    : label || (placement === "top" ? "加载更早内容" : "加载更多");

  const meta =
    typeof loadedCount === "number" && typeof totalCount === "number" && totalCount > 0
      ? `已显示 ${Math.min(loadedCount, totalCount)} / ${totalCount} 条`
      : typeof loadedCount === "number" && loadedCount > 0
        ? `已加载 ${loadedCount} 条`
        : null;

  return (
    <div
      ref={sentinelRef}
      className={`${styles.bar}${placement === "top" ? ` ${styles.top}` : ""}${compact ? ` ${styles.compact}` : ""}`}
      role="navigation"
      aria-label="分页浏览"
    >
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      <button type="button" className={styles.button} disabled={loading} onClick={onLoadMore}>
        {buttonText}
      </button>
    </div>
  );
}
