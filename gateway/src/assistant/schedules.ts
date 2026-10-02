import { describeLocal, nextRun, parseCron, validTimeZone } from "./cron.ts";
import { postInbox } from "./inbox.ts";
import { assistantPath, clip, newId, readJson, readJsonl, writeJson, writeJsonl, type TenantRef } from "./store.ts";

export type ScheduleKind = "prompt" | "brief" | "remind";
export type OccurrenceState = "running" | "done" | "failed" | "interrupted" | "skipped";

export type Schedule = {
  id: string;
  title: string;
  kind: ScheduleKind;
  cron: string;
  tz: string;
  prompt: string;
  enabled: boolean;
  misfire: "runOnce" | "skip";
  nextAt: number | null;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastStatus?: OccurrenceState;
  failCount: number;
  pausedReason?: string;
  createdAt: number;
};

export type Occurrence = {
  occurrenceId: string;
  scheduleId: string;
  plannedAt: number;
  state: OccurrenceState;
  startedAt?: number;
  endedAt?: number;
  inboxItemId?: string;
  error?: string;
};

export type ScheduleExecutor = (
  ref: TenantRef,
  schedule: Schedule,
  occurrence: Occurrence,
) => Promise<{ ok: boolean; inboxItemId?: string; error?: string }>;

type SchedulesFile = { schedules: Schedule[]; seeded?: boolean };

export const DEFAULT_TZ = "Asia/Shanghai";
/** 超过这个时长才算漏跑 */
export const MISFIRE_GRACE_MS = 5 * 60_000;
export const MAX_FAILS = 3;
const MAX_OCCURRENCES = 2000;

function file(ref: TenantRef) {
  return assistantPath(ref, "schedules.json");
}
function occFile(ref: TenantRef) {
  return assistantPath(ref, "occurrences.jsonl");
}

function read(ref: TenantRef) {
  return readJson<SchedulesFile>(file(ref), { schedules: [] });
}

export function listSchedules(ref: TenantRef) {
  return read(ref).schedules;
}

export function listOccurrences(ref: TenantRef, limit = 50) {
  return readJsonl<Occurrence>(occFile(ref)).slice(-limit).reverse();
}

/** 第一次用助理时放一条每日简报（早上 9 点），你可以在今日页暂停或改时间 */
export function seedDefaults(ref: TenantRef, now = Date.now()) {
  const data = read(ref);
  if (data.seeded) return false;
  data.seeded = true;
  if (!data.schedules.some((item) => item.kind === "brief")) {
    data.schedules.push({
      id: "s_brief",
      title: "每日简报",
      kind: "brief",
      cron: "0 9 * * *",
      tz: DEFAULT_TZ,
      prompt: "生成今日简报",
      enabled: true,
      misfire: "runOnce",
      nextAt: nextRun("0 9 * * *", DEFAULT_TZ, now),
      failCount: 0,
      createdAt: now,
    });
  }
  writeJson(file(ref), data);
  return true;
}

export type ScheduleInput = {
  id?: string;
  title?: string;
  kind?: ScheduleKind;
  cron?: string;
  tz?: string;
  prompt?: string;
  enabled?: boolean;
  misfire?: "runOnce" | "skip";
};

export function setSchedule(ref: TenantRef, input: ScheduleInput, now = Date.now()) {
  const data = read(ref);
  const prev = input.id ? data.schedules.find((item) => item.id === input.id) : undefined;
  if (input.id && !prev) return { ok: false as const, error: `没有这个日程：${input.id}` };
  const cron = (input.cron ?? prev?.cron ?? "").trim();
  const tz = (input.tz ?? prev?.tz ?? DEFAULT_TZ).trim();
  const kind = input.kind ?? prev?.kind ?? "remind";
  const prompt = clip(input.prompt ?? prev?.prompt ?? "", 2000);
  const title = clip(input.title ?? prev?.title ?? (prompt || "日程"), 40);
  try {
    parseCron(cron);
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "cron 不合法" };
  }
  if (!validTimeZone(tz)) return { ok: false as const, error: `时区不认识：${tz}` };
  if (!["prompt", "brief", "remind"].includes(kind)) return { ok: false as const, error: "kind 只能是 prompt、brief、remind" };
  if (kind !== "brief" && !prompt) return { ok: false as const, error: "要写提醒或任务内容。" };
  const next = nextRun(cron, tz, now);
  if (next === null) return { ok: false as const, error: "这个 cron 一年内都不会触发。" };
  const enabled = input.enabled ?? prev?.enabled ?? true;
  const row: Schedule = {
    id: prev?.id ?? newId("s"),
    title,
    kind,
    cron,
    tz,
    prompt,
    enabled,
    misfire: input.misfire ?? prev?.misfire ?? "runOnce",
    nextAt: next,
    lastStartedAt: prev?.lastStartedAt,
    lastCompletedAt: prev?.lastCompletedAt,
    lastStatus: prev?.lastStatus,
    failCount: enabled && !prev?.enabled ? 0 : (prev?.failCount ?? 0),
    pausedReason: enabled ? undefined : prev?.pausedReason,
    createdAt: prev?.createdAt ?? now,
  };
  data.schedules = prev ? data.schedules.map((item) => (item.id === row.id ? row : item)) : [...data.schedules, row];
  writeJson(file(ref), data);
  return { ok: true as const, value: row };
}

export function removeSchedule(ref: TenantRef, id: string) {
  const data = read(ref);
  const next = data.schedules.filter((item) => item.id !== id);
  if (next.length === data.schedules.length) return false;
  writeJson(file(ref), { ...data, schedules: next });
  return true;
}

function patchSchedule(ref: TenantRef, id: string, patch: Partial<Schedule>) {
  const data = read(ref);
  const row = data.schedules.find((item) => item.id === id);
  if (!row) return;
  Object.assign(row, patch);
  writeJson(file(ref), data);
  return row;
}

function upsertOccurrence(ref: TenantRef, occ: Occurrence) {
  const rows = readJsonl<Occurrence>(occFile(ref));
  const at = rows.findIndex((row) => row.occurrenceId === occ.occurrenceId);
  if (at >= 0) rows[at] = occ;
  else rows.push(occ);
  writeJsonl(occFile(ref), rows.slice(-MAX_OCCURRENCES));
}

/** 网关启动：上次还在跑的记为中断，进收件箱，不自动重跑 */
export function recoverSchedules(ref: TenantRef) {
  const rows = readJsonl<Occurrence>(occFile(ref));
  const stale = rows.filter((row) => row.state === "running");
  if (!stale.length) return 0;
  for (const row of stale) {
    row.state = "interrupted";
    row.endedAt = Date.now();
    row.error = "网关重启";
  }
  writeJsonl(occFile(ref), rows);
  const schedules = listSchedules(ref);
  for (const row of stale) {
    const schedule = schedules.find((item) => item.id === row.scheduleId);
    patchSchedule(ref, row.scheduleId, { lastStatus: "interrupted" });
    postInbox(ref, {
      kind: "run",
      title: `日程被中断：${schedule?.title ?? row.scheduleId}`,
      body: "网关重启时这次日程还在运行，没有自动重跑。",
      key: `interrupted:${row.occurrenceId}`,
      scheduleId: row.scheduleId,
    });
  }
  return stale.length;
}

const inFlight = new Set<string>();

/**
 * 每次调度检查调一次。漏跑只补最近一次（runOnce）或直接跳过（skip）；
 * 上一次还在跑时本次记 skipped；单次运行 id 按本地时刻去重，夏令时重复的时刻只跑一次。
 * 返回本次启动的运行，测试里可以 await。
 */
export function tickSchedules(ref: TenantRef, exec: ScheduleExecutor, now = Date.now()): Promise<void>[] {
  const started: Promise<void>[] = [];
  for (const schedule of listSchedules(ref)) {
    if (!schedule.enabled || schedule.nextAt === null || schedule.nextAt > now) continue;
    let planned = schedule.nextAt;
    for (let i = 0; i < 20_000; i += 1) {
      const next = nextRun(schedule.cron, schedule.tz, planned);
      if (next === null || next > now) break;
      planned = next;
    }
    const after = nextRun(schedule.cron, schedule.tz, now);
    patchSchedule(ref, schedule.id, { nextAt: after });
    const occurrenceId = `${schedule.id}@${describeLocal(planned, schedule.tz)}`;
    const late = now - planned > MISFIRE_GRACE_MS || planned !== schedule.nextAt;
    const known = readJsonl<Occurrence>(occFile(ref)).find((row) => row.occurrenceId === occurrenceId);
    if (known) continue;
    const skip = (reason: string) => {
      upsertOccurrence(ref, { occurrenceId, scheduleId: schedule.id, plannedAt: planned, state: "skipped", error: reason, endedAt: now });
      patchSchedule(ref, schedule.id, { lastStatus: "skipped" });
    };
    if (late && schedule.misfire === "skip") {
      skip("错过了计划时间，按设置跳过");
      continue;
    }
    if (inFlight.has(schedule.id)) {
      skip("上一次还在运行");
      continue;
    }
    const occ: Occurrence = { occurrenceId, scheduleId: schedule.id, plannedAt: planned, state: "running", startedAt: now };
    upsertOccurrence(ref, occ);
    patchSchedule(ref, schedule.id, { lastStartedAt: now, lastStatus: "running" });
    inFlight.add(schedule.id);
    started.push(
      (async () => {
        let result: { ok: boolean; inboxItemId?: string; error?: string };
        try {
          result = await exec(ref, schedule, occ);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
          inFlight.delete(schedule.id);
        }
        const done: Occurrence = {
          ...occ,
          state: result.ok ? "done" : "failed",
          endedAt: Date.now(),
          inboxItemId: result.inboxItemId,
          error: result.error,
        };
        upsertOccurrence(ref, done);
        const current = listSchedules(ref).find((item) => item.id === schedule.id);
        const failCount = result.ok ? 0 : (current?.failCount ?? 0) + 1;
        const pause = failCount >= MAX_FAILS;
        patchSchedule(ref, schedule.id, {
          lastStatus: done.state,
          lastCompletedAt: result.ok ? Date.now() : current?.lastCompletedAt,
          failCount,
          ...(pause ? { enabled: false, pausedReason: `连续 ${MAX_FAILS} 次失败，已暂停` } : {}),
        });
        if (pause) {
          postInbox(ref, {
            kind: "run",
            title: `日程已暂停：${schedule.title}`,
            body: `连续 ${MAX_FAILS} 次失败。最后一次：${result.error ?? "未知错误"}。在今日页可以恢复。`,
            key: `paused:${occurrenceId}`,
            scheduleId: schedule.id,
          });
        }
      })(),
    );
  }
  return started;
}
