// 侧栏/抽屉的 hook：关闭动画期间保持挂载、iPad 上拖拽关闭
import { useEffect, useRef, useState } from "react";

export function useHeldOpen(open: boolean, ms = 280) {
  const [held, setHeld] = useState(open);
  useEffect(() => {
    if (open) {
      setHeld(true);
      return;
    }
    const id = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(id);
  }, [open, ms]);
  return open || held;
}

function padOverlaySheet() {
  return window.matchMedia("(max-width: 1366px) and (any-pointer: coarse), (max-width: 920px)").matches;
}

export function useSheetDrag(open: boolean, onClose: () => void, edge: "left" | "right") {
  const ref = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !open) return;
    const el: HTMLElement = node;

    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let vx = 0;
    let dragging = false;
    let tracking = false;
    let pointerId = -1;

    const width = () => el.getBoundingClientRect().width || 320;

    function setDrag(px: number, opacity: number) {
      el.style.setProperty("--sheet-drag", `${px}px`);
      el.classList.add("sheet-dragging");
      const scrim = scrimRef.current;
      if (scrim) {
        scrim.style.setProperty("--scrim-drag", String(opacity));
        scrim.classList.add("sheet-dragging");
      }
    }

    function clearDrag() {
      el.style.removeProperty("--sheet-drag");
      el.classList.remove("sheet-dragging");
      const scrim = scrimRef.current;
      if (scrim) {
        scrim.style.removeProperty("--scrim-drag");
        scrim.classList.remove("sheet-dragging");
      }
    }

    function onDown(event: PointerEvent) {
      if (!open || !padOverlaySheet()) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      tracking = true;
      dragging = false;
      pointerId = event.pointerId;
      startX = lastX = event.clientX;
      startY = event.clientY;
      lastT = performance.now();
      vx = 0;
    }

    function onMove(event: PointerEvent) {
      if (!tracking || event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const now = performance.now();
      vx = (event.clientX - lastX) / Math.max(1, now - lastT);
      lastX = event.clientX;
      lastT = now;
      if (!dragging) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        const dismissDir = edge === "left" ? dx < 0 : dx > 0;
        if (Math.abs(dy) > Math.abs(dx) || !dismissDir) {
          tracking = false;
          return;
        }
        dragging = true;
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      const travel = edge === "left" ? Math.min(0, dx) : Math.max(0, dx);
      const progress = Math.min(1, Math.abs(travel) / width());
      setDrag(travel, 1 - progress);
    }

    function onUp(event: PointerEvent) {
      if (!tracking || event.pointerId !== pointerId) return;
      tracking = false;
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      const dx = event.clientX - startX;
      const travel = edge === "left" ? Math.min(0, dx) : Math.max(0, dx);
      const progress = Math.abs(travel) / width();
      const flick = edge === "left" ? vx < -0.35 : vx > 0.35;
      clearDrag();
      if (progress > 0.28 || flick) onClose();
    }

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      clearDrag();
    };
  }, [open, onClose, edge]);

  return { ref, scrimRef };
}
