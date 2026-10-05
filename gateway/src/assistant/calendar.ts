import { randomBytes, timingSafeEqual } from "node:crypto";
import { assistantPath, readJson, writeJson, type TenantRef } from "./store.ts";
import { listTodos, type Todo } from "./todos.ts";

/**
 * 苹果日历订阅：带日期的未完成待办生成一份只读 .ics，日历定期来拉。
 * 地址是 /media/cal/<token>.ics——挂在 /media 下是因为 nginx 只把 /media 等几个前缀转给网关，不用改服务器配置。
 * 默认开；知道链接的人能看到待办标题，所以只放标题、口令可重新生成。
 */

type CalendarFile = { token: string; enabled: boolean; lastFetchAt?: number; pushedAt?: number; createdAt: number };

export type CalendarInfo = { token: string; enabled: boolean; lastFetchAt?: number };

function file(ref: TenantRef) {
  return assistantPath(ref, "calendar.json");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

/** 口令 → 租户状态目录。错口令直接查不到，不必逐个租户读盘（这个地址谁都能打） */
const owners = new Map<string, string>();
let indexed = false;

function remember(ref: TenantRef, token: string, previous?: string) {
  if (previous && previous !== token) owners.delete(previous);
  owners.set(token, ref.stateDir);
}

export function findByToken<T extends TenantRef>(refs: T[], token: string): T | undefined {
  if (!indexed) {
    for (const ref of refs) {
      const data = readJson<CalendarFile | null>(file(ref), null);
      if (data?.token) owners.set(data.token, ref.stateDir);
    }
    indexed = true;
  }
  const dir = owners.get(token);
  const ref = dir ? refs.find((item) => item.stateDir === dir) : undefined;
  return ref && matchesToken(ref, token) ? ref : undefined;
}

/** 第一次用到时生成口令（默认开） */
export function calendarInfo(ref: TenantRef): CalendarInfo {
  let data = readJson<CalendarFile | null>(file(ref), null);
  if (!data?.token) {
    data = { token: newToken(), enabled: true, createdAt: Date.now() };
    writeJson(file(ref), data);
  }
  remember(ref, data.token);
  return { token: data.token, enabled: data.enabled, lastFetchAt: data.lastFetchAt };
}

export function setCalendar(ref: TenantRef, patch: { enabled?: boolean; rotate?: boolean }) {
  const current = calendarInfo(ref);
  const next: CalendarFile = {
    token: patch.rotate ? newToken() : current.token,
    enabled: patch.enabled ?? current.enabled,
    // 换了口令，旧订阅就拉不到了，订阅状态要从头算
    lastFetchAt: patch.rotate ? undefined : current.lastFetchAt,
    pushedAt: patch.rotate ? undefined : readJson<CalendarFile | null>(file(ref), null)?.pushedAt,
    createdAt: Date.now(),
  };
  writeJson(file(ref), next);
  remember(ref, next.token, current.token);
  return { token: next.token, enabled: next.enabled, lastFetchAt: next.lastFetchAt };
}

/**
 * 口令对得上就算数；比较用定长时间，防止按耗时猜口令。
 * 关掉同步时链接仍然有效、只是给空日历：直接 404 的话苹果日历会一直留着旧事件。要让链接作废就换口令。
 */
export function matchesToken(ref: TenantRef, token: string) {
  const data = readJson<CalendarFile | null>(file(ref), null);
  if (!data?.token) return false;
  const a = Buffer.from(data.token);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 记下日历来拉的时间；一分钟内重复拉不重复写盘。
 * 返回 true 表示该推一次状态：第一次被拉，或距上次推送已过半天——App 超过 3 天没见到新时间就会提示“可能取消了订阅”
 */
export function noteFetch(ref: TenantRef, now = Date.now()) {
  const data = readJson<CalendarFile | null>(file(ref), null);
  if (!data) return false;
  if (data.lastFetchAt && now - data.lastFetchAt < 60_000) return false;
  const pushedAt = data.pushedAt ?? 0;
  const push = !data.lastFetchAt || now - pushedAt > 12 * 3_600_000;
  writeJson(file(ref), { ...data, lastFetchAt: now, pushedAt: push ? now : data.pushedAt });
  return push;
}

function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545：每行不超过 75 字节，续行以一个空格开头；按字符切，不把多字节汉字切开 */
function fold(line: string) {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = out.length ? 74 : 75;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

function utcStamp(ms: number) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function nextDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10).replace(/-/g, "");
}

/** DTSTAMP 用待办自己的修改时间：用请求时间的话每次拉取所有事件都像被改过 */
function eventLines(todo: Todo) {
  const stamp = utcStamp(todo.updatedAt ?? todo.createdAt);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${todo.id}@jiebo`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${escapeText(todo.text)}`,
  ];
  if (todo.remindAt) {
    lines.push(`DTSTART:${utcStamp(todo.remindAt)}`, `DTEND:${utcStamp(todo.remindAt + 30 * 60_000)}`);
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(todo.text)}`, "TRIGGER:PT0M", "END:VALARM");
  } else if (todo.due) {
    const day = todo.due.slice(0, 10);
    lines.push(`DTSTART;VALUE=DATE:${day.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(day)}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

/** 未完成、带日期的待办；30 天前的旧日期不再放进日历 */
export function buildIcs(ref: TenantRef, name: string, now = Date.now()) {
  const cutoff = now - 30 * 86_400_000;
  const enabled = readJson<CalendarFile | null>(file(ref), null)?.enabled !== false;
  const todos = (enabled ? listTodos(ref) : []).filter((todo) => {
    if (todo.done || !todo.due) return false;
    const at = todo.remindAt ?? Date.parse(`${todo.due.slice(0, 10)}T23:59:59Z`);
    return Number.isFinite(at) && at >= cutoff;
  });
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Jiebo//Todos//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`${name}的待办`)}`,
    "X-PUBLISHED-TTL:PT15M",
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    ...todos.flatMap(eventLines),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
