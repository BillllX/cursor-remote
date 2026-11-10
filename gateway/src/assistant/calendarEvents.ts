import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { assistantPath, clip, newId, readJson, type TenantRef } from "./store.ts";
import { listTodos } from "./todos.ts";

/**
 * 双轨日历引擎（时段日程事件 calendar-events.json + 待办 todos.json 并行）：
 * - 支持带起止时间的日程事件（CalendarEvent）、CAS 版本号（rev）、地点、参与人、公开/私密可见性；
 * - 提醒严格遵守「只响一次、不每年重复」（触发后标记 reminded: true，绝不生成 RRULE:FREQ=YEARLY）；
 * - 提供面向同事的脱敏忙闲查询（Free/Busy）：visibility === "private" 的私人日程对同事仅显示「忙碌」，隐去标题与备注；
 * - 提供冲突检查（checkCalendarConflicts），供主人创建日程或批准同事预约提案时执行原子校验。
 */

export type CalendarEventVisibility = "public" | "private";
export type CalendarEventStatus = "confirmed" | "cancelled";

export type CalendarEvent = {
  id: string;
  rev: number;
  title: string;
  /** ISO 8601 带时区字符串（如 2026-11-12T15:00:00+08:00） */
  startIso: string;
  endIso: string;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  location?: string;
  notes?: string;
  attendees?: string[];
  visibility: CalendarEventVisibility;
  busy: "busy" | "free";
  status: CalendarEventStatus;
  /** 提前多少分钟提醒（仅触发一次，触发后置 reminded = true，绝不按年重复） */
  remindMinutesBefore?: number;
  reminded?: boolean;
  source?: "owner" | "colleague_proposal";
  proposerName?: string;
  proposalId?: string;
  createdAt: number;
  updatedAt: number;
};

type CalendarEventsFile = {
  version: 1;
  events: CalendarEvent[];
};

export type FreeBusySlot = {
  startAt: number;
  endAt: number;
  startIso: string;
  endIso: string;
  busy: "busy";
  /** 对同事脱敏后的摘要：公开事件显示标题，私密事件或待办提醒仅显示「忙碌」 */
  summary: string;
  location?: string;
};

const ISO_WITH_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function eventsFilePath(ref: TenantRef): string {
  return assistantPath(ref, "calendar-events.json");
}

function readEventsFileUnlocked(ref: TenantRef): CalendarEventsFile {
  const raw = readJson<Partial<CalendarEventsFile>>(eventsFilePath(ref), { version: 1, events: [] });
  const events = Array.isArray(raw.events)
    ? raw.events.filter((e): e is CalendarEvent => Boolean(e && typeof e.id === "string"))
    : [];
  return { version: 1, events };
}

function writeEventsFileUnlocked(ref: TenantRef, data: CalendarEventsFile) {
  atomicWriteFileSync(eventsFilePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

export function parseEventTimeInput(
  rawStart: string,
  rawEnd?: string,
):
  | {
      ok: true;
      startIso: string;
      endIso: string;
      startAt: number;
      endAt: number;
      allDay: boolean;
    }
  | { ok: false; error: string } {
  const s = (rawStart || "").trim();
  const e = (rawEnd || "").trim();
  if (!s) {
    return { ok: false, error: "请提供开始时间（如 2026-11-12T15:00:00+08:00 或全天日期 2026-11-12）" };
  }

  // 全天日期 YYYY-MM-DD（默认按东八区 +08:00 当天 00:00 至次日 00:00 计算）
  if (DATE_ONLY_RE.test(s)) {
    const startIso = `${s}T00:00:00+08:00`;
    const startAt = Date.parse(startIso);
    if (!Number.isFinite(startAt)) {
      return { ok: false, error: `无效的开始日期：${s}` };
    }
    let endAt = startAt + 86_400_000;
    if (e) {
      if (DATE_ONLY_RE.test(e)) {
        const parsedEnd = Date.parse(`${e}T00:00:00+08:00`) + 86_400_000;
        if (!Number.isFinite(parsedEnd) || parsedEnd <= startAt) {
          return { ok: false, error: "全天日程的结束日期不能早于开始日期" };
        }
        endAt = parsedEnd;
      } else {
        return {
          ok: false,
          error: "当开始时间为全天日期（YYYY-MM-DD）时，结束时间也应为 YYYY-MM-DD 格式",
        };
      }
    }
    if (endAt - startAt > 30 * 86_400_000) {
      return { ok: false, error: "单条日程跨度不能超过 30 天" };
    }
    const endDayStr = new Date(endAt + 8 * 3_600_000).toISOString().slice(0, 10);
    const endIso = `${endDayStr}T00:00:00+08:00`;
    return { ok: true, startIso, endIso, startAt, endAt, allDay: true };
  }

  if (!ISO_WITH_TZ_RE.test(s)) {
    return {
      ok: false,
      error: "开始时间需为带时区的 ISO 格式（如 2026-11-12T15:00:00+08:00）或 YYYY-MM-DD",
    };
  }
  const startAt = Date.parse(s);
  if (!Number.isFinite(startAt)) {
    return { ok: false, error: `无法解析开始时间：${s}` };
  }

  let endAt = startAt + 60 * 60_000;
  let endIso = formatShanghaiIso(endAt);
  if (e) {
    if (!ISO_WITH_TZ_RE.test(e)) {
      return {
        ok: false,
        error: "结束时间需为带时区的 ISO 格式（如 2026-11-12T16:00:00+08:00）",
      };
    }
    const parsedEnd = Date.parse(e);
    if (!Number.isFinite(parsedEnd) || parsedEnd <= startAt) {
      return { ok: false, error: "结束时间必须晚于开始时间" };
    }
    endAt = parsedEnd;
    endIso = e;
  }

  if (endAt - startAt > 30 * 86_400_000) {
    return { ok: false, error: "单条日程跨度不能超过 30 天" };
  }

  return { ok: true, startIso: s, endIso, startAt, endAt, allDay: false };
}

export function formatShanghaiIso(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/** 列出指定时间窗口内的日历时段事件（默认只返回 confirmed 状态） */
export function listCalendarEvents(
  ref: TenantRef,
  opts: {
    fromMs?: number;
    toMs?: number;
    includeCancelled?: boolean;
  } = {},
): CalendarEvent[] {
  const data = readEventsFileUnlocked(ref);
  return data.events
    .filter((ev) => {
      if (!opts.includeCancelled && ev.status === "cancelled") return false;
      if (opts.fromMs !== undefined && ev.endAt <= opts.fromMs) return false;
      if (opts.toMs !== undefined && ev.startAt >= opts.toMs) return false;
      return true;
    })
    .sort((a, b) => a.startAt - b.startAt);
}

/** 检查指定时间段 [startAt, endAt) 是否与已有 confirmed 且 busy==="busy" 的事件冲突 */
export function checkCalendarConflicts(
  ref: TenantRef,
  startAt: number,
  endAt: number,
  excludeEventId?: string,
): CalendarEvent[] {
  const events = listCalendarEvents(ref, { fromMs: startAt, toMs: endAt });
  return events.filter(
    (ev) =>
      ev.id !== excludeEventId &&
      ev.status === "confirmed" &&
      ev.busy === "busy" &&
      ev.startAt < endAt &&
      ev.endAt > startAt,
  );
}

/** 新增一条日历时段事件（支持 forceAllowConflict 控制是否在冲突时拒绝） */
export function addCalendarEvent(
  ref: TenantRef,
  input: {
    title: string;
    startIso: string;
    endIso?: string;
    location?: string;
    notes?: string;
    attendees?: string[];
    visibility?: CalendarEventVisibility;
    busy?: "busy" | "free";
    remindMinutesBefore?: number;
    source?: "owner" | "colleague_proposal";
    proposerName?: string;
    proposalId?: string;
    allowConflict?: boolean;
  },
  now = Date.now(),
):
  | { ok: true; event: CalendarEvent; conflicts: CalendarEvent[] }
  | { ok: false; error: string; conflicts?: CalendarEvent[] } {
  const title = clip((input.title || "").trim(), 200);
  if (!title) {
    return { ok: false, error: "日程标题不能为空" };
  }
  const timeParsed = parseEventTimeInput(input.startIso, input.endIso);
  if (!timeParsed.ok) return timeParsed;

  const remindMinutesBefore =
    typeof input.remindMinutesBefore === "number" &&
    Number.isFinite(input.remindMinutesBefore) &&
    input.remindMinutesBefore >= 0
      ? Math.min(10080, Math.floor(input.remindMinutesBefore))
      : undefined;

  const file = eventsFilePath(ref);
  return withFileLockSync(file, () => {
    const data = readEventsFileUnlocked(ref);
    const conflicts = data.events.filter(
      (ev) =>
        ev.status === "confirmed" &&
        ev.busy === "busy" &&
        ev.startAt < timeParsed.endAt &&
        ev.endAt > timeParsed.startAt,
    );

    if (conflicts.length > 0 && !input.allowConflict) {
      return {
        ok: false as const,
        error: `该时间段与现有日程冲突（${conflicts.map((c) => `${c.title} ${c.startIso}~${c.endIso}`).join("；")}）`,
        conflicts,
      };
    }

    const triggerMs = remindMinutesBefore !== undefined ? timeParsed.startAt - remindMinutesBefore * 60_000 : undefined;

    const event: CalendarEvent = {
      id: newId("ev"),
      rev: 1,
      title,
      startIso: timeParsed.startIso,
      endIso: timeParsed.endIso,
      startAt: timeParsed.startAt,
      endAt: timeParsed.endAt,
      ...(timeParsed.allDay ? { allDay: true } : {}),
      ...(input.location?.trim() ? { location: clip(input.location.trim(), 120) } : {}),
      ...(input.notes?.trim() ? { notes: clip(input.notes.trim(), 1000) } : {}),
      ...(Array.isArray(input.attendees) && input.attendees.length > 0
        ? {
            attendees: input.attendees
              .map((a) => clip(String(a).trim(), 60))
              .filter(Boolean)
              .slice(0, 20),
          }
        : {}),
      visibility: input.visibility === "public" ? "public" : "private",
      busy: input.busy === "free" ? "free" : "busy",
      status: "confirmed",
      ...(remindMinutesBefore !== undefined ? { remindMinutesBefore } : {}),
      // 若提醒时间已过则直接标为已提醒，严格保证只响一次、不每年重复
      reminded: triggerMs !== undefined ? triggerMs <= now : undefined,
      source: input.source ?? "owner",
      ...(input.proposerName ? { proposerName: clip(input.proposerName, 40) } : {}),
      ...(input.proposalId ? { proposalId: input.proposalId } : {}),
      createdAt: now,
      updatedAt: now,
    };

    data.events.push(event);
    writeEventsFileUnlocked(ref, data);
    return { ok: true as const, event, conflicts };
  });
}

/** 更新或取消一条已有日历时段事件（支持 CAS expectedRev 校验） */
export function updateCalendarEvent(
  ref: TenantRef,
  id: string,
  patch: {
    expectedRev?: number;
    title?: string;
    startIso?: string;
    endIso?: string;
    location?: string;
    notes?: string;
    visibility?: CalendarEventVisibility;
    busy?: "busy" | "free";
    status?: CalendarEventStatus;
    remindMinutesBefore?: number | null;
    allowConflict?: boolean;
  },
  now = Date.now(),
): { ok: true; event: CalendarEvent } | { ok: false; error: string; conflicts?: CalendarEvent[] } {
  const targetId = (id || "").trim();
  if (!targetId) return { ok: false, error: "请提供日程 ID" };

  const file = eventsFilePath(ref);
  return withFileLockSync(file, () => {
    const data = readEventsFileUnlocked(ref);
    const ev = data.events.find((x) => x.id === targetId);
    if (!ev) return { ok: false as const, error: `找不到日程：${targetId}` };

    if (patch.expectedRev !== undefined && ev.rev !== patch.expectedRev) {
      return {
        ok: false as const,
        error: `日程版本已变化（当前 rev=${ev.rev}，期望 rev=${patch.expectedRev}），请刷新后重试`,
      };
    }

    let nextStartIso = ev.startIso;
    let nextEndIso = ev.endIso;
    let nextStartAt = ev.startAt;
    let nextEndAt = ev.endAt;
    let nextAllDay = Boolean(ev.allDay);

    if (patch.startIso !== undefined || patch.endIso !== undefined) {
      const parsed = parseEventTimeInput(
        patch.startIso ?? ev.startIso,
        patch.endIso ?? (patch.startIso && !patch.endIso ? undefined : ev.endIso),
      );
      if (!parsed.ok) return parsed;
      nextStartIso = parsed.startIso;
      nextEndIso = parsed.endIso;
      nextStartAt = parsed.startAt;
      nextEndAt = parsed.endAt;
      nextAllDay = parsed.allDay;
    }

    const nextStatus = patch.status ?? ev.status;
    const nextBusy = patch.busy ?? ev.busy;

    if (nextStatus === "confirmed" && nextBusy === "busy" && !patch.allowConflict) {
      const conflicts = data.events.filter(
        (other) =>
          other.id !== ev.id &&
          other.status === "confirmed" &&
          other.busy === "busy" &&
          other.startAt < nextEndAt &&
          other.endAt > nextStartAt,
      );
      if (conflicts.length > 0) {
        return {
          ok: false as const,
          error: `修改后的时间段与现有日程冲突（${conflicts.map((c) => `${c.title} ${c.startIso}~${c.endIso}`).join("；")}）`,
          conflicts,
        };
      }
    }

    if (patch.title !== undefined) {
      const cleanTitle = clip(patch.title.trim(), 200);
      if (!cleanTitle) return { ok: false as const, error: "日程标题不能为空" };
      ev.title = cleanTitle;
    }
    ev.startIso = nextStartIso;
    ev.endIso = nextEndIso;
    ev.startAt = nextStartAt;
    ev.endAt = nextEndAt;
    ev.allDay = nextAllDay || undefined;

    if (patch.location !== undefined) {
      ev.location = patch.location.trim() ? clip(patch.location.trim(), 120) : undefined;
    }
    if (patch.notes !== undefined) {
      ev.notes = patch.notes.trim() ? clip(patch.notes.trim(), 1000) : undefined;
    }
    if (patch.visibility !== undefined) {
      ev.visibility = patch.visibility;
    }
    ev.busy = nextBusy;
    ev.status = nextStatus;

    if (patch.remindMinutesBefore !== undefined) {
      if (patch.remindMinutesBefore === null) {
        delete ev.remindMinutesBefore;
        delete ev.reminded;
      } else {
        const mins = Math.max(0, Math.min(10080, Math.floor(patch.remindMinutesBefore)));
        ev.remindMinutesBefore = mins;
        ev.reminded = ev.startAt - mins * 60_000 <= now;
      }
    } else if (ev.remindMinutesBefore !== undefined && (patch.startIso !== undefined || patch.endIso !== undefined)) {
      ev.reminded = ev.startAt - ev.remindMinutesBefore * 60_000 <= now;
    }

    ev.rev += 1;
    ev.updatedAt = now;
    writeEventsFileUnlocked(ref, data);
    return { ok: true as const, event: { ...ev } };
  });
}

/** 取出到点的日程单次提醒并标记为已提醒（严格只响一次、不每年重复） */
export function takeDueCalendarEventReminders(ref: TenantRef, now = Date.now()): CalendarEvent[] {
  const file = eventsFilePath(ref);
  return withFileLockSync(file, () => {
    const data = readEventsFileUnlocked(ref);
    const due = data.events.filter((ev) => {
      if (ev.status !== "confirmed" || ev.reminded || ev.remindMinutesBefore === undefined) return false;
      const triggerAt = ev.startAt - ev.remindMinutesBefore * 60_000;
      return triggerAt <= now && ev.endAt >= now - 3_600_000;
    });
    if (due.length === 0) return [];
    for (const ev of due) {
      ev.reminded = true;
    }
    writeEventsFileUnlocked(ref, data);
    return due.map((e) => ({ ...e }));
  });
}

/**
 * 面向同事的脱敏忙闲查询（Free/Busy Engine）：
 * - 合并 `calendar-events.json` 中 status==="confirmed" && busy==="busy" 的时段事件，以及 `todos.json` 中带具体提醒时刻的未完成待办（按 30 分钟时段计）；
 * - 隐私铁律：`visibility === "private"` 的事件及个人待办对同事一律只返回 `summary: "忙碌"`，绝不暴露私人标题或备注；只有主人显式设为 `visibility === "public"` 的事件才展示标题。
 */
export function queryColleagueFreeBusy(
  ref: TenantRef,
  input: {
    fromIso: string;
    toIso: string;
  },
):
  | {
      ok: true;
      fromIso: string;
      toIso: string;
      busySlots: FreeBusySlot[];
    }
  | { ok: false; error: string } {
  const parsed = parseEventTimeInput(input.fromIso, input.toIso);
  if (!parsed.ok) return parsed;

  const events = listCalendarEvents(ref, {
    fromMs: parsed.startAt,
    toMs: parsed.endAt,
    includeCancelled: false,
  });

  const busySlots: FreeBusySlot[] = [];

  for (const ev of events) {
    if (ev.busy !== "busy") continue;
    busySlots.push({
      startAt: ev.startAt,
      endAt: ev.endAt,
      startIso: ev.startIso,
      endIso: ev.endIso,
      busy: "busy",
      summary: ev.visibility === "public" ? ev.title : "忙碌",
      ...(ev.visibility === "public" && ev.location ? { location: ev.location } : {}),
    });
  }

  // 合并带具体时刻的未完成待办（统一脱敏为「忙碌」）
  const todos = listTodos(ref, { includeDone: false });
  for (const todo of todos) {
    if (!todo.remindAt) continue;
    const tStart = todo.remindAt;
    const tEnd = todo.remindAt + 30 * 60_000;
    if (tEnd <= parsed.startAt || tStart >= parsed.endAt) continue;
    busySlots.push({
      startAt: tStart,
      endAt: tEnd,
      startIso: formatShanghaiIso(tStart),
      endIso: formatShanghaiIso(tEnd),
      busy: "busy",
      summary: "忙碌",
    });
  }

  busySlots.sort((a, b) => a.startAt - b.startAt);
  return {
    ok: true,
    fromIso: parsed.startIso,
    toIso: parsed.endIso,
    busySlots,
  };
}
