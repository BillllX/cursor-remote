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
