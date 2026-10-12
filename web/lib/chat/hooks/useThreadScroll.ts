// 对话线程的滚动：贴底跟随、切换会话时还原各自的位置、“回到最新 / 有新内容”按钮
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Chat } from "../types";

export function useThreadScroll({
  activeIdRef,
  active,
  activeId,
  threadFindOpen,
}: {
  activeIdRef: RefObject<string>;
  active: Chat;
  activeId: string;
  threadFindOpen: boolean;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  // -1 表示离开时贴在底部，回来继续贴底
  const scrollMap = useRef<Record<string, number>>({});
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const restoreRef = useRef<number | null>(null);
  const restoreTimerRef = useRef(0);
  const expectTopRef = useRef(-1);
  const shownChatRef = useRef("");
  const [jumpState, setJumpState] = useState<"" | "far" | "new">("");

  // 只在“贴底”时跟随新内容；用户往上翻过就不再拽回，直到他自己回到底部或点“回到最新”。
  // 代码挪动滚动位置时记下目标值，onScroll 据此区分“程序滚”和“用户滚”（滚轮、键盘、拖滚动条、查找跳转）。
  const moveThread = useCallback((el: HTMLDivElement, top: number) => {
    el.scrollTop = top;
    expectTopRef.current = el.scrollTop;
    lastTopRef.current = el.scrollTop;
  }, []);

  // 待还原优先；否则贴底时跟到最底。正文还在分段加载时，等够高了再还原。
  const reconcileThread = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const want = restoreRef.current;
    if (want != null) {
      if (el.scrollHeight - el.clientHeight >= want) {
        moveThread(el, want);
        restoreRef.current = null;
      }
      return;
    }
    if (stickRef.current) moveThread(el, el.scrollHeight);
  }, [moveThread]);

  const scrollThreadToEnd = useCallback(
    (smooth = false) => {
      const el = threadRef.current;
      stickRef.current = true;
      restoreRef.current = null;
      setJumpState("");
      if (!el) return;
      scrollMap.current[activeIdRef.current] = -1;
      const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 3;
      if (smooth && !far) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        return;
      }
      reconcileThread();
      requestAnimationFrame(reconcileThread);
    },
    [reconcileThread, activeIdRef],
  );

  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const programmatic = Math.abs(top - expectTopRef.current) <= 1;
    expectTopRef.current = -1;
    if (!programmatic) restoreRef.current = null;
    const dist = el.scrollHeight - top - el.clientHeight;
    const movedUp = top < lastTopRef.current - 1;
    lastTopRef.current = top;
    if (dist <= 4) stickRef.current = true;
    else if (movedUp && !programmatic) stickRef.current = false;
    if (restoreRef.current == null) scrollMap.current[activeIdRef.current] = stickRef.current ? -1 : top;
    const show = !stickRef.current && dist > 160;
    setJumpState((prev) => (show ? prev || "far" : ""));
  }, [activeIdRef]);

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (shownChatRef.current !== activeId) {
      shownChatRef.current = activeId;
      setJumpState("");
      window.clearTimeout(restoreTimerRef.current);
      const saved = scrollMap.current[activeId];
      if (saved == null || saved < 0) {
        stickRef.current = true;
        restoreRef.current = null;
      } else {
        stickRef.current = false;
        restoreRef.current = saved;
        // 正文最终没那么高（被删减、折叠）时，不让还原一直挂着
        restoreTimerRef.current = window.setTimeout(() => {
          const node = threadRef.current;
          const want = restoreRef.current;
          restoreRef.current = null;
          if (node && want != null) moveThread(node, Math.min(want, node.scrollHeight - node.clientHeight));
        }, 1500);
      }
    }
    const pending = restoreRef.current != null;
    reconcileThread();
    if (!pending && !stickRef.current && el.scrollHeight - el.scrollTop - el.clientHeight > 160) setJumpState("new");
  }, [active?.turns, activeId, moveThread, reconcileThread]);

  useEffect(() => () => window.clearTimeout(restoreTimerRef.current), []);

  const hasThread = Boolean(active?.turns.length);
  useEffect(() => {
    const el = threadRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // 图片、代码高亮、折叠展开、查找栏开合这类不改 turns 的高度变化
    const ro = new ResizeObserver(() => reconcileThread());
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [activeId, hasThread, threadFindOpen, reconcileThread]);

  return { threadRef, scrollMap, stickRef, restoreRef, jumpState, scrollThreadToEnd, onThreadScroll };
}
