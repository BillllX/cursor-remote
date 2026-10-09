"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/// 同时开着几个弹层时只有最后打开的那个接管 Tab
const traps: HTMLElement[] = [];

/// 最近几次获得焦点的元素。弹层里的 autoFocus 会在 effect 之前把焦点抢进来，
/// 所以打开时要往回找“弹层外最后一个有焦点的元素”，关闭时还给它
const focusHistory: HTMLElement[] = [];
let tracking = false;

function trackFocus(event: FocusEvent) {
  if (!(event.target instanceof HTMLElement)) return;
  focusHistory.push(event.target);
  if (focusHistory.length > 8) focusHistory.shift();
}

function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

function focusInto(root: HTMLElement, last = false) {
  const items = focusables(root);
  (items.length ? items[last ? items.length - 1 : 0] : root).focus({ preventScroll: true });
}

function onTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const root = traps[traps.length - 1];
  if (!root) return;
  const items = focusables(root);
  const current = document.activeElement;
  if (!items.length || !(current instanceof HTMLElement) || !root.contains(current)) {
    event.preventDefault();
    focusInto(root, event.shiftKey);
    return;
  }
  if (event.shiftKey && current === items[0]) {
    event.preventDefault();
    items[items.length - 1].focus();
  } else if (!event.shiftKey && current === items[items.length - 1]) {
    event.preventDefault();
    items[0].focus();
  }
}

function outsideFocus(root: HTMLElement) {
  const now = document.activeElement;
  if (now instanceof HTMLElement && now !== document.body && !root.contains(now)) return now;
  for (let i = focusHistory.length - 1; i >= 0; i -= 1) {
    const el = focusHistory[i];
    if (el.isConnected && !root.contains(el)) return el;
  }
  return null;
}

/**
 * 模态弹层的焦点圈定：打开时焦点不在里面就移进去（没有可聚焦元素时聚焦容器本身），
 * Tab / Shift+Tab 在里面循环；关闭时如果焦点丢了（落在 body 或还在弹层里），还给打开前的元素。
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!tracking && typeof document !== "undefined") {
      document.addEventListener("focusin", trackFocus, true);
      tracking = true;
    }
  }, []);
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = outsideFocus(root);
    if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
    if (!traps.length) document.addEventListener("keydown", onTab);
    traps.push(root);
    const frame = window.requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) focusInto(root);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const index = traps.lastIndexOf(root);
      if (index >= 0) traps.splice(index, 1);
      if (!traps.length) document.removeEventListener("keydown", onTab);
      const now = document.activeElement;
      const lost = !now || now === document.body || root.contains(now);
      if (lost && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [active]);
  return ref;
}
