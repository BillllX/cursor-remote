/**
 * 五段 cron（分 时 日 月 周），按 IANA 时区计算下一次触发的 UTC 时刻。
 * 支持 *、数字、a-b、a,b、步长 / 。日和周都受限时按标准 cron 取“或”。
 * 夏令时：不存在的本地时刻顺延到换算后的有效时刻；重复的本地时刻只取第一次。
 */

export type CronSpec = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
};

function field(raw: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长不合法：${part}`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepRaw ? max : lo) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron 字段超出范围：${part}（${min}-${max}）`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 要五段：分 时 日 月 周");
  const weekdays = field(parts[4], 0, 7).map((d) => (d === 7 ? 0 : d));
  return {
    minutes: field(parts[0], 0, 59),
    hours: field(parts[1], 0, 23),
    days: new Set(field(parts[2], 1, 31)),
    months: new Set(field(parts[3], 1, 12)),
    weekdays: new Set(weekdays),
    dayRestricted: parts[2] !== "*",
    weekdayRestricted: parts[4] !== "*",
  };
}

export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(utcMs: number, tz: string) {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function offsetAt(utcMs: number, tz: string) {
  const p = localParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(utcMs / 60_000) * 60_000;
}

/** 本地时刻 → UTC。不存在的时刻落在换算后的下一个有效时刻 */
export function localToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const candidates = [-1, 0, 1].map((shift) => guess - offsetAt(guess + shift * 3 * 3_600_000, tz));
  const hits = candidates.filter((utc) => localMatches(utc, y, m, d, h, mi, tz));
  if (hits.length) return Math.min(...hits);
  return Math.max(...candidates);
}

function localMatches(utc: number, y: number, m: number, d: number, h: number, mi: number, tz: string) {
  const p = localParts(utc, tz);
  return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === mi;
}

function dayMatches(spec: CronSpec, y: number, m: number, d: number) {
  if (!spec.months.has(m)) return false;
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = spec.days.has(d);
  const dowOk = spec.weekdays.has(weekday);
  if (spec.dayRestricted && spec.weekdayRestricted) return domOk || dowOk;
  if (spec.dayRestricted) return domOk;
  if (spec.weekdayRestricted) return dowOk;
  return true;
}

/** 严格晚于 afterMs 的下一次触发（UTC 毫秒）。一年内没有就返回 null */
export function nextRun(expr: string | CronSpec, tz: string, afterMs: number): number | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const start = localParts(afterMs, tz);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < 400; i += 1, cursor += 86_400_000) {
    const day = new Date(cursor);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(spec, y, m, d)) continue;
    for (const h of spec.hours) {
      for (const mi of spec.minutes) {
        const utc = localToUtc(y, m, d, h, mi, tz);
        if (utc > afterMs) return utc;
      }
    }
  }
  return null;
}

export function describeLocal(utcMs: number, tz: string) {
  const p = localParts(utcMs, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
