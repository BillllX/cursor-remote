// 启动时读一次的环境派生值：首次调用时求值并缓存。index.ts 在 loadDotEnv 之后、原顶层常量的位置先调用一次，
// 之后各模块拿到的都是那一次的结果（等价于原来的顶层 const）。
import { gatewayEnv } from "../config.ts";

/** 第一次调用时求值并缓存；求值抛错时不缓存，下次调用照样抛 */
function once<T>(read: () => T): () => T {
  let box: { value: T } | undefined;
  return () => (box ??= { value: read() }).value;
}

export const gatewayHost = once(() => gatewayEnv.gatewayHost());
export const webUrl = once(() => new URL(gatewayEnv.webOrigin()));
export const defaultModel = once(() => gatewayEnv.defaultModel());
