/**
 * 网关日志：人读的单行文本，前面加级别标签。debug/info 走 stdout，warn/error 走 stderr。
 * 级别由 GATEWAY_LOG_LEVEL 控制（默认 info），每次输出时读取。
 * 消息里的英文关键词（frame clipped、frame dropped、upload 等）运维会在 journalctl 里 grep，改文案时保留。
 */
import { format } from "node:util";
import { gatewayEnv, type LogLevel } from "./config.ts";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function logEnabled(level: LogLevel) {
  return RANK[level] >= RANK[gatewayEnv.logLevel()];
}

function emit(level: LogLevel, args: unknown[]) {
  if (!logEnabled(level)) return;
  const line = `[${level}] ${format(...args)}`;
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
  /** 启动横幅：原样输出到 stdout，不加标签、不受级别限制 */
  banner: (text: string) => console.log(text),
};

const throttledAt = new Map<string, number>();
const THROTTLE_KEYS_MAX = 1000;

/**
 * 持续失败时每次都会走到的地方用它：同一 key 在 windowMs 内只 warn 一次，其余记 debug。
 * key 要取值有限（模块名 + 租户目录这类），不要拼会话 id、文件路径。
 */
export function warnThrottled(key: string, windowMs: number, ...args: unknown[]) {
  const now = Date.now();
  const quiet = now - (throttledAt.get(key) ?? -Infinity) < windowMs;
  if (!quiet) {
    if (throttledAt.size >= THROTTLE_KEYS_MAX && !throttledAt.has(key)) throttledAt.clear();
    throttledAt.set(key, now);
  }
  emit(quiet ? "debug" : "warn", args);
}

/** 只用于 warn 的上下文：Error 取 code + message，不带堆栈；其他值原样 */
export function errText(err: unknown) {
  if (!(err instanceof Error)) return err;
  const code = (err as NodeJS.ErrnoException).code;
  return code && !err.message.includes(code) ? `${code} ${err.message}` : err.message;
}
