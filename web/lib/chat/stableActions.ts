// 稳定回调：给 React.memo 的行组件传“引用永远不变、调用时永远转给最新实现”的函数，
// 既不会因为回调每次渲染都是新函数而让 memo 失效，也不会像自定义 comparator 那样捡到过期闭包。
import { useLayoutEffect, useMemo, useRef } from "react";

type AnyFn = (...args: never[]) => unknown;

/**
 * 按 keys 生成一组稳定包装函数：包装函数本身不变，调用时读 getLatest() 里当下最新的同名函数。
 * 纯函数，不依赖 React，方便单测。
 */
export function createStableActions<T extends Record<string, AnyFn>>(
  getLatest: () => T,
  keys: readonly (keyof T)[],
): T {
  const stable = {} as T;
  for (const key of keys) {
    stable[key] = ((...args: never[]) => (getLatest()[key] as AnyFn)(...args)) as T[keyof T];
  }
  return stable;
}

/**
 * 每次渲染把最新的回调塞进 ref（提交后、任何事件触发前），返回的对象引用终身不变。
 * 要求 latest 的键集合在组件生命周期内固定。
 */
export function useStableActions<T extends Record<string, AnyFn>>(latest: T): T {
  const ref = useRef(latest);
  useLayoutEffect(() => {
    ref.current = latest;
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 键集合固定，包装函数只读 ref，故意只建一次
  return useMemo(() => createStableActions(() => ref.current, Object.keys(latest)), []);
}
