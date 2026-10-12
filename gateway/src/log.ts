/**
 * 网关日志：人读的单行文本，前面加级别标签。debug/info 走 stdout，warn/error 走 stderr。
 * 级别由 GATEWAY_LOG_LEVEL 控制（默认 info），格式由 GATEWAY_LOG_FORMAT 控制（默认 text），都在每次输出时读取。
 * 消息里的英文关键词（frame clipped、frame dropped、upload 等）运维会在 journalctl 里 grep，改文案时保留。
 *
 * text：`[warn] 消息`；log.with({ tenant, chatId }) 的子 logger 是 `[warn] [t=租户 c=会话] 消息`。
 * json：每条一行 {"level","time","tenant","chatId","msg"}，tenant/chatId 没有就不出现；横幅也按 info 输出成 JSON 行。
 */
import { format } from "node:util";
import { gatewayEnv, type LogLevel } from "./config.ts";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = { tenant?: string; chatId?: string };

export function logEnabled(level: LogLevel) {
  return RANK[level] >= RANK[gatewayEnv.logLevel()];
}

function textPrefix(ctx: LogContext) {
  const parts: string[] = [];
  if (ctx.tenant) parts.push(`t=${ctx.tenant}`);
  if (ctx.chatId) parts.push(`c=${ctx.chatId}`);
  return parts.length ? `[${parts.join(" ")}] ` : "";
}

function write(level: LogLevel, line: string) {
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}

function jsonLine(level: LogLevel, ctx: LogContext, msg: string) {
  return JSON.stringify({
    level,
    time: new Date().toISOString(),
    tenant: ctx.tenant || undefined,
    chatId: ctx.chatId || undefined,
    msg,
  });
}

function emit(level: LogLevel, args: unknown[], ctx: LogContext = {}) {
  if (!logEnabled(level)) return;
  const msg = format(...args);
  write(level, gatewayEnv.logFormat() === "json" ? jsonLine(level, ctx, msg) : `[${level}] ${textPrefix(ctx)}${msg}`);
}

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /** 子 logger：上下文与父级合并，后给的字段覆盖先给的 */
  with: (ctx: LogContext) => Logger;
};

function logger(ctx: LogContext): Logger {
  return {
    debug: (...args) => emit("debug", args, ctx),
    info: (...args) => emit("info", args, ctx),
    warn: (...args) => emit("warn", args, ctx),
    error: (...args) => emit("error", args, ctx),
    with: (more) => logger({ ...ctx, ...more }),
  };
}

export const log = {
  ...logger({}),
  /** 启动横幅：text 格式原样输出到 stdout，不加标签、不受级别限制 */
  banner: (text: string) => console.log(gatewayEnv.logFormat() === "json" ? jsonLine("info", {}, text) : text),
};

/** 对话运行路径上的子 logger：带槽位的租户与会话 */
export function slotLog(slot: { tenantId: string; chatId: string }): Logger {
  return log.with({ tenant: slot.tenantId, chatId: slot.chatId });
}

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
