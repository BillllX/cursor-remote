import { existsSync, statSync } from "node:fs";
import { claimOutputs, outputKeys, releaseOutputs } from "../outputClaims.ts";
import { ensureSafePathInWorkspace, loadKbWorkspaceConfig } from "./contract.ts";
import { createHash, randomBytes } from "node:crypto";
import { localParts, validTimeZone } from "../assistant/cron.ts";
import { DEFAULT_TZ } from "../assistant/schedules.ts";
import { assistantPath, clip, readJson, readJsonl, writeJsonl, type TenantRef } from "../assistant/store.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { log } from "../log.ts";
import { KB_INGEST_LOG_REL_PATH, hasControlChars, safeReadWorkspaceTextFileSync } from "./contract.ts";
import { buildDropTenantHost, type DropPortalTenant } from "./http.ts";
import { listIngestQueue } from "./queue.ts";
import type { DropTenantHost } from "./tokens.ts";
import { rollbackWecomWatchLedgerOnBatchFailed } from "./wecomSource.ts";
import { getWorkspaceTaskExecutor } from "./workspaceScheduleExecutors.ts";
import {
  computeNextWorkspaceScheduleRunAt,
  normalizeActiveHours,
  normalizeDailyTimes,
  type WorkspaceScheduleExecutorKind,
  type WorkspaceScheduleMode,
  type WorkspaceScheduleMonthly,
  type WorkspaceSchedulePayload,
  type WorkspaceScheduleRecord,
  type WorkspaceScheduleRunRecord,
  type WorkspaceScheduleRunStatus,
} from "./workspaceScheduleTypes.ts";

export * from "./workspaceScheduleTypes.ts";
export * from "./workspaceScheduleExecutors.ts";

const SCHEDULES_FILENAME = "workspace-schedules.json";
const RUNS_FILENAME = "workspace-schedule-runs.jsonl";
const MAX_SCHEDULES_PER_TENANT = 100;
const MAX_RUN_HISTORY = 500;
const STEP1_LEASE_MS = 65 * 60_000;
const STEP2_LEASE_MS = 40 * 60_000;
export const WORKSPACE_SCHEDULER_TICK_MS = 15_000;

type SchedulesFile = {
  version: 1;
  items: WorkspaceScheduleRecord[];
};

/** 进程内单飞锁集合：`${tenantId}:${scheduleId}`，与磁盘 state 配合实现双重防重入 */
const inFlightScheduleKeys = new Set<string>();

function schedulesFilePath(ref: TenantRef): string {
  return assistantPath(ref, SCHEDULES_FILENAME);
}

function schedulesLockPath(ref: TenantRef): string {
  return assistantPath(ref, `${SCHEDULES_FILENAME}.lock`);
}

function runsFilePath(ref: TenantRef): string {
  return assistantPath(ref, RUNS_FILENAME);
}

function readSchedulesUnlocked(ref: TenantRef): SchedulesFile {
  const raw = readJson<Partial<SchedulesFile>>(schedulesFilePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw?.items)
    ? raw.items.filter((x): x is WorkspaceScheduleRecord => Boolean(x && typeof x.id === "string"))
    : [];
  return { version: 1, items };
}

function writeSchedulesUnlocked(ref: TenantRef, data: SchedulesFile): void {
  atomicWriteFileSync(schedulesFilePath(ref), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, fsync: true });
}

function appendRunRecordUnlocked(ref: TenantRef, record: WorkspaceScheduleRunRecord): void {
  const rows = readJsonl<WorkspaceScheduleRunRecord>(runsFilePath(ref));
  if (rows.some((row) => row.runId === record.runId)) return;
  rows.push(record);
  writeJsonl(runsFilePath(ref), rows.slice(-MAX_RUN_HISTORY), true);
}

export function listWorkspaceSchedules(
  host: DropTenantHost,
  opts?: { workspace?: string },
): WorkspaceScheduleRecord[] {
  const file = readSchedulesUnlocked(host);
  const q = opts?.workspace?.trim();
  if (!q || q === "__all__") return file.items;
  const resolved = host.resolveWorkspace(q);
  return file.items.filter(
    (x) =>
      x.workspaceKeySnapshot === q ||
      x.workspaceId === q ||
      (resolved && (x.workspaceId === resolved.workspaceId || x.workspaceKeySnapshot === resolved.key)),
  );
}

export function listWorkspaceScheduleRuns(
  host: DropTenantHost,
  opts?: { workspace?: string; scheduleId?: string; limit?: number },
): WorkspaceScheduleRunRecord[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 30)));
  const rows = readJsonl<WorkspaceScheduleRunRecord>(runsFilePath(host));
  const q = opts?.workspace?.trim();
  const resolved = q && q !== "__all__" ? host.resolveWorkspace(q) : null;
  const filtered = rows.filter((r) => {
    if (opts?.scheduleId && r.scheduleId !== opts.scheduleId) return false;
    if (q && q !== "__all__") {
      const matchWs =
        r.workspaceKey === q ||
        r.workspaceId === q ||
        Boolean(resolved && (r.workspaceId === resolved.workspaceId || r.workspaceKey === resolved.key));
      if (!matchWs) return false;
    }
    return true;
  });
  return filtered.slice(-limit).reverse();
}

export type UpsertWorkspaceScheduleInput = {
  id?: string;
  workspace: string;
  title: string;
  enabled?: boolean;
  executorKind: WorkspaceScheduleExecutorKind;
  payload?: WorkspaceSchedulePayload;
  scheduleMode?: WorkspaceScheduleMode;
  intervalMinutes?: number;
  dailyTimes?: string[];
  monthly?: WorkspaceScheduleMonthly;
  expectedUpdatedAt?: number;
  createOnly?: boolean;
  activeHours?: { start: string; end: string } | null;
  tz?: string;
};

export function upsertWorkspaceSchedule(
  host: DropTenantHost,
  input: UpsertWorkspaceScheduleInput,
  now = Date.now(),
): { ok: true; item: WorkspaceScheduleRecord; created: boolean } | { ok: false; error: string } {
  const wsTarget = (input.workspace || "").trim();
  if (!wsTarget) return { ok: false, error: "请指定目标工作区名称（如 Fintopia集团）" };
  const wsRef = host.resolveWorkspace(wsTarget);
  if (!wsRef) return { ok: false, error: `找不到工作区：${wsTarget}` };

  const title = (input.title || "").trim();
  if (!title || title.length > 120 || hasControlChars(title)) {
    return { ok: false, error: "定时任务标题不能为空且不超过 120 字符" };
  }

  const validKinds: WorkspaceScheduleExecutorKind[] = [
    "wecom_watch_sync",
    "wecom_mail_poll",
    "http_api_ingest",
    "workspace_script",
    "agent_prompt",
  ];
  if (!validKinds.includes(input.executorKind)) {
    return { ok: false, error: `不支持的任务执行器类型：${String(input.executorKind)}` };
  }

  if (input.scheduleMode && !["interval", "daily_times", "monthly"].includes(input.scheduleMode)) {
    return { ok: false, error: "不支持的触发频率" };
  }
  const intervalMinutes = Math.max(5, Math.min(10_080, Math.floor(input.intervalMinutes ?? 60)));
  const dailyTimes = normalizeDailyTimes(input.dailyTimes);
  const activeHours = normalizeActiveHours(input.activeHours);
  if (input.tz && !validTimeZone(input.tz)) return { ok: false, error: "请选择有效时区" };
  const tz = input.tz || DEFAULT_TZ;
  const payload = input.payload ?? {};

  return withFileLockSync(schedulesLockPath(host), () => {
    const file = readSchedulesUnlocked(host);
    const existingIdx = input.id
      ? file.items.findIndex((x) => x.id === input.id)
      : file.items.findIndex(
          (x) =>
            x.workspaceId === wsRef.workspaceId &&
            x.executorKind === input.executorKind &&
            x.title === title,
        );

    if (input.id && existingIdx < 0) {
      return { ok: false as const, error: `未找到定时任务：${input.id}` };
    }
    const prev = existingIdx >= 0 ? file.items[existingIdx] : undefined;
    if (input.createOnly && file.items.some((item) => item.workspaceId === wsRef.workspaceId && item.title === title)) {
      return { ok: false as const, error: "此工作区已有同名自动化，请编辑现有规则或使用其他名称。" };
    }
    if (prev && prev.workspaceId !== wsRef.workspaceId) {
      return { ok: false as const, error: `定时任务 ${prev.id} 属于工作区「${prev.workspaceKeySnapshot}」，不可跨工作区覆盖或迁移` };
    }
    if (existingIdx < 0 && file.items.length >= MAX_SCHEDULES_PER_TENANT) {
      return { ok: false as const, error: `定时任务数量已达上限（${MAX_SCHEDULES_PER_TENANT}）` };
    }

    const mergedPayload: WorkspaceSchedulePayload = {
      ...(prev?.payload ?? {}),
      ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)),
    };
    if (prev && input.expectedUpdatedAt !== undefined && prev.updatedAt !== input.expectedUpdatedAt) {
      return { ok: false as const, error: "规则已更新，请刷新后重新编辑。" };
    }
    if (prev && input.expectedUpdatedAt !== undefined && prev.state !== "idle") {
      return { ok: false as const, error: "当前运行完成后即可编辑。" };
    }
    if (input.executorKind === "http_api_ingest" && !mergedPayload.url?.trim()) {
      return { ok: false as const, error: "请填写来源 URL" };
    }
    if (input.executorKind === "workspace_script" && !mergedPayload.scriptRelPath?.trim()) {
      return { ok: false as const, error: "请填写脚本相对路径" };
    }
    if (input.executorKind === "agent_prompt" && !mergedPayload.prompt?.trim()) {
      return { ok: false as const, error: "请填写分析指令" };
    }
    try {
      outputKeys(wsRef.path, [mergedPayload.outputRelPath, ...(mergedPayload.reportInputs ?? []), ...(mergedPayload.outputTargets ?? [])].filter((path): path is string => Boolean(path)));
      if (input.executorKind === "agent_prompt" && mergedPayload.outputRelPath && !/\.md$/i.test(mergedPayload.outputRelPath)) throw new Error("分析报告的固定产物须以 .md 结尾。");
      if ((mergedPayload.outputTargets?.length ?? 0) > 12) throw new Error("最多声明 12 项需要协调的产物。");
      if (mergedPayload.reportInputs && mergedPayload.reportInputs.length > 12) throw new Error("最多声明 12 项月报资料。");
    } catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : "产物或资料路径无效。" }; }
    const enabled = input.enabled ?? prev?.enabled ?? true;
    const effectiveMode = input.scheduleMode ?? prev?.scheduleMode ?? "interval";
    const effectiveInterval = input.intervalMinutes !== undefined ? intervalMinutes : (prev?.intervalMinutes ?? 60);
    const effectiveDailyTimes =
      input.dailyTimes !== undefined ? dailyTimes : normalizeDailyTimes(prev?.dailyTimes);
    const monthly = input.monthly ?? prev?.monthly;
    if (effectiveMode === "monthly" && (!monthly || !Number.isInteger(monthly.day) ||
        monthly.day < 1 || monthly.day > 31 || !normalizeDailyTimes([monthly.time]).length ||
        !["skip", "last_day"].includes(monthly.shortMonth))) {
      return { ok: false as const, error: "请选择每月日期、时刻和短月份处理方式" };
    }
    if (effectiveMode === "daily_times" && !effectiveDailyTimes.length) {
      return { ok: false as const, error: "请填写至少一个有效的每日时刻" };
    }
    const effectiveActiveHours =
      input.activeHours === null
        ? undefined
        : input.activeHours !== undefined
          ? activeHours
          : prev?.activeHours;
    const effectiveTz = input.tz ? tz : (prev?.tz ?? tz);
    const nextRunAt = enabled
      ? computeNextWorkspaceScheduleRunAt(
          {
            scheduleMode: effectiveMode,
            intervalMinutes: effectiveInterval,
            dailyTimes: effectiveDailyTimes,
            monthly,
            activeHours: effectiveActiveHours,
            tz: effectiveTz,
          },
          now,
        )
      : null;

    const record: WorkspaceScheduleRecord = {
      id: prev?.id ?? `wsched_${randomBytes(6).toString("hex")}`,
      workspaceId: wsRef.workspaceId,
      workspaceKeySnapshot: wsRef.key,
      title,
      enabled,
      executorKind: input.executorKind,
      payload: mergedPayload,
      scheduleMode: effectiveMode,
      intervalMinutes: effectiveInterval,
      ...(effectiveDailyTimes.length > 0 ? { dailyTimes: effectiveDailyTimes } : {}),
      ...(effectiveMode === "monthly" ? { monthly } : {}),
      ...(effectiveActiveHours ? { activeHours: effectiveActiveHours } : {}),
      tz: effectiveTz,
      cursorState: prev?.cursorState ?? {},
      state: prev?.state ?? "idle",
      activeRunId: prev?.activeRunId,
      activeTrigger: prev?.activeTrigger,
      activeStartedAt: prev?.activeStartedAt,
      activeBatchIds: prev?.activeBatchIds,
      submittedBatchIds: prev?.submittedBatchIds,
      pendingBatchErrors: prev?.pendingBatchErrors,
      pendingBatchMailMap: prev?.pendingBatchMailMap,
      leaseUntil: prev?.leaseUntil,
      pendingPreSummary: prev?.pendingPreSummary,
      pendingUpdatedFiles: prev?.pendingUpdatedFiles,
      pendingCursorState: prev?.pendingCursorState,
      nextRunAt,
      lastStartedAt: prev?.lastStartedAt,
      lastFinishedAt: prev?.lastFinishedAt,
      lastStatus: prev?.lastStatus,
      lastSummary: prev?.lastSummary,
      lastUpdatedFiles: prev?.lastUpdatedFiles,
      lastError: prev?.lastError,
      consecutiveFailures: enabled && !prev?.enabled ? 0 : (prev?.consecutiveFailures ?? 0),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };

    if (existingIdx >= 0) {
      file.items[existingIdx] = record;
    } else {
      file.items.push(record);
    }
    writeSchedulesUnlocked(host, file);
    return { ok: true as const, item: record, created: existingIdx < 0 };
  });
}

export function toggleWorkspaceSchedule(
  host: DropTenantHost,
  idOrTitle: string,
  enabled: boolean,
  workspace?: string,
  now = Date.now(),
): { ok: true; item: WorkspaceScheduleRecord } | { ok: false; error: string } {
  const q = idOrTitle.trim();
  if (!q) return { ok: false, error: "请指定定时任务 ID 或标题" };
  return withFileLockSync(schedulesLockPath(host), () => {
    const file = readSchedulesUnlocked(host);
    const matches = file.items.filter(
      (x) => (x.id === q || x.title === q) && (!workspace || x.workspaceKeySnapshot === workspace || x.workspaceId === workspace),
    );
    if (matches.length === 0) return { ok: false as const, error: `未找到定时任务：${q}` };
    if (matches.length > 1 && !matches.some((x) => x.id === q)) {
      return { ok: false as const, error: `存在多个同名定时任务《${q}》，请指定工作区或使用任务 ID` };
    }
    const targetId = matches.find((x) => x.id === q)?.id ?? matches[0].id;
    const idx = file.items.findIndex((x) => x.id === targetId);
    const cur = file.items[idx];
    const nextRunAt = enabled
      ? computeNextWorkspaceScheduleRunAt(
          {
            scheduleMode: cur.scheduleMode,
            intervalMinutes: cur.intervalMinutes,
            dailyTimes: cur.dailyTimes,
            monthly: cur.monthly,
            activeHours: cur.activeHours,
            tz: cur.tz,
          },
          now,
        )
      : null;
    const updated: WorkspaceScheduleRecord = {
      ...cur,
      enabled,
      nextRunAt,
      consecutiveFailures: enabled ? 0 : cur.consecutiveFailures,
      updatedAt: now,
    };
    file.items[idx] = updated;
    writeSchedulesUnlocked(host, file);
    return { ok: true as const, item: updated };
  });
}

export function removeWorkspaceSchedule(
  host: DropTenantHost,
  idOrTitle: string,
  workspace?: string,
): { ok: true; removed: WorkspaceScheduleRecord } | { ok: false; error: string } {
  const q = idOrTitle.trim();
  if (!q) return { ok: false, error: "请指定要删除的定时任务 ID 或标题" };
  return withFileLockSync(schedulesLockPath(host), () => {
    const file = readSchedulesUnlocked(host);
    const matches = file.items.filter(
      (x) => (x.id === q || x.title === q) && (!workspace || x.workspaceKeySnapshot === workspace || x.workspaceId === workspace),
    );
    if (matches.length === 0) return { ok: false as const, error: `未找到定时任务：${q}` };
    if (matches.length > 1 && !matches.some((x) => x.id === q)) {
      return { ok: false as const, error: `存在多个同名定时任务《${q}》，请指定工作区或使用任务 ID` };
    }
    const targetId = matches.find((x) => x.id === q)?.id ?? matches[0].id;
    const idx = file.items.findIndex((x) => x.id === targetId);
    const cur = file.items[idx];
    if (cur.state !== "idle") {
      return { ok: false as const, error: `任务《${cur.title}》正在运行中，请等待运行结束后再删除` };
    }
    const [removed] = file.items.splice(idx, 1);
    writeSchedulesUnlocked(host, file);
    return { ok: true as const, removed };
  });
}

function readBatchLogFromWorkspace(
  workspacePath: string,
  batchId: string,
): { updatedFiles: string[]; summary?: string; errorReason?: string } {
  const res = safeReadWorkspaceTextFileSync(workspacePath, KB_INGEST_LOG_REL_PATH, 2 * 1024 * 1024);
  if (!res.ok || !res.text.trim()) return { updatedFiles: [] };
  const lines = res.text.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as {
        batchId?: string;
        movedFiles?: Array<{ to?: string }>;
        updatedHtmls?: string[];
        summary?: string;
        errorReason?: string;
      };
      if (obj && obj.batchId === batchId) {
        const files = [
          ...(Array.isArray(obj.updatedHtmls) ? obj.updatedHtmls : []),
          ...(Array.isArray(obj.movedFiles) ? obj.movedFiles.map((m) => m.to).filter((t): t is string => Boolean(t)) : []),
        ];
        return { updatedFiles: files, summary: obj.summary, errorReason: obj.errorReason };
      }
    } catch {
      // ignore
    }
  }
  return { updatedFiles: [] };
}

function computeNextCursorWithMailMap(
  baseCursor: Record<string, unknown>,
  proposedCursor: Record<string, unknown> | undefined,
  batchMailMap: Record<string, string> | undefined,
  failedBatchIds: Set<string>,
): Record<string, unknown> | undefined {
  if (!batchMailMap || Object.keys(batchMailMap).length === 0) {
    return failedBatchIds.size > 0 ? undefined : proposedCursor;
  }
  const prevSeen = Array.isArray(baseCursor.seenMailIds)
    ? baseCursor.seenMailIds.filter((x): x is string => typeof x === "string")
    : [];
  const succeededMailIds: string[] = [];
  for (const [bid, mailId] of Object.entries(batchMailMap)) {
    if (!failedBatchIds.has(bid) && mailId) {
      succeededMailIds.push(mailId);
    }
  }
  return {
    ...(proposedCursor ?? baseCursor),
    seenMailIds: [...new Set([...prevSeen, ...succeededMailIds])].slice(-500),
  };
}

function finalizeScheduleRunUnlocked(
  host: DropTenantHost,
  item: WorkspaceScheduleRecord,
  outcome: {
    runId: string;
    trigger: "scheduled" | "manual" | "backfill";
    startedAt: number;
    finishedAt: number;
    status: WorkspaceScheduleRunStatus;
    summary: string;
    batchIds?: string[];
    updatedFiles?: string[];
    nextCursorState?: Record<string, unknown>;
    error?: string;
  },
): WorkspaceScheduleRecord {
  const nextFailures = outcome.status === "failed" ? (item.consecutiveFailures ?? 0) + 1 : 0;
  const nextRunAt = outcome.trigger !== "scheduled" ? item.nextRunAt : item.enabled
    ? computeNextWorkspaceScheduleRunAt(
        {
          scheduleMode: item.scheduleMode,
          intervalMinutes: item.intervalMinutes,
          dailyTimes: item.dailyTimes,
            monthly: item.monthly,
          activeHours: item.activeHours,
          tz: item.tz,
        },
        outcome.finishedAt,
      )
    : null;

  const updated: WorkspaceScheduleRecord = {
    ...item,
    cursorState: outcome.trigger === "backfill" ? item.cursorState : outcome.nextCursorState ?? item.pendingCursorState ?? item.cursorState,
    state: "idle",
    activeRunId: undefined,
    activeTrigger: undefined,
    activePeriod: undefined,
    activeOutputRelPath: undefined,
    activeStartedAt: undefined,
    activeBatchIds: undefined,
    submittedBatchIds: undefined,
    pendingBatchErrors: undefined,
    pendingBatchMailMap: undefined,
    leaseUntil: undefined,
    pendingPreSummary: undefined,
    pendingUpdatedFiles: undefined,
    pendingCursorState: undefined,
    nextRunAt,
    lastStartedAt: outcome.startedAt,
    lastFinishedAt: outcome.finishedAt,
    lastStatus: outcome.status,
    lastSummary: clip(outcome.summary, 600),
    lastUpdatedFiles: outcome.updatedFiles ?? item.pendingUpdatedFiles ?? item.lastUpdatedFiles,
    lastError: outcome.error ? clip(outcome.error, 300) : undefined,
    consecutiveFailures: nextFailures,
    updatedAt: outcome.finishedAt,
  };

  appendRunRecordUnlocked(host, {
    runId: outcome.runId,
    scheduleId: item.id,
    workspaceId: item.workspaceId,
    workspaceKey: item.workspaceKeySnapshot,
    title: item.title,
    executorKind: item.executorKind,
    trigger: outcome.trigger,
    ...(item.activePeriod ? { period: item.activePeriod } : {}),
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    durationMs: Math.max(0, outcome.finishedAt - outcome.startedAt),
    status: outcome.status,
    summary: clip(outcome.summary, 600),
    ...(outcome.batchIds?.length ? { batchIds: outcome.batchIds } : {}),
    ...(outcome.updatedFiles?.length ? { updatedFiles: outcome.updatedFiles } : {}),
    ...(outcome.error ? { error: clip(outcome.error, 300) } : {}),
  });

  return updated;
}

function previousReportMonth(now: number, tz: string) {
  const { year, month } = localParts(now, tz);
  const prior = new Date(Date.UTC(year, month - 2, 1));
  return prior.toISOString().slice(0, 7);
}

type BackfillRequest = { period: string; token: string; newVersion: boolean };
function buildBackfillPreview(host: DropTenantHost, item: WorkspaceScheduleRecord, workspacePath: string, period: string, now: number) {
  if (item.executorKind !== "agent_prompt" || item.scheduleMode !== "monthly") return { ok: false as const, error: "只有按月执行的分析报告支持按期补跑。" };
  if (!/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(period) || period > previousReportMonth(now, item.tz)) {
    return { ok: false as const, error: "请选择已经结束的统计月份。" };
  }
  const history = readJsonl<WorkspaceScheduleRunRecord>(runsFilePath(host))
    .filter((row) => row.scheduleId === item.id && row.period === period && row.status !== "failed");
  const files = [...new Set(history.flatMap((row) => row.updatedFiles ?? []))].filter((path) => {
    const found = ensureSafePathInWorkspace(workspacePath, path, { expectLeaf: "file" });
    return found.ok && existsSync(found.absPath);
  });
  const sources = (item.payload.reportInputs ?? []).map((path) => {
    const found = ensureSafePathInWorkspace(workspacePath, path, { expectLeaf: "file" });
    if (!found.ok) return { path };
    try {
      const stat = statSync(found.absPath);
      return { path, size: stat.size, mtime: stat.mtimeMs };
    } catch { return { path }; }
  });
  const missingInputs = sources.filter((source) => source.mtime === undefined).map((source) => source.path);
  const versions = history.length;
  const token = createHash("sha256").update(JSON.stringify([item.id, item.updatedAt, period, history.map((row) => row.runId), files, sources])).digest("hex");
  return { ok: true as const, preview: { scheduleId: item.id, period, token, versions, files, missingInputs, inputsDeclared: Boolean(item.payload.reportInputs?.length) } };
}

export function previewWorkspaceBackfill(host: DropTenantHost, id: string, workspace: string | undefined, period: string) {
  const item = listWorkspaceSchedules(host, { workspace }).find((row) => row.id === id);
  if (!item) return { ok: false as const, error: "未找到这条月报规则。" };
  const target = host.resolveWorkspace(item.workspaceId) ?? host.resolveWorkspace(item.workspaceKeySnapshot);
  if (!target) return { ok: false as const, error: "原工作区已不可用。" };
  return buildBackfillPreview(host, item, target.path, period, Date.now());
}

function archivedReport(item: Pick<WorkspaceScheduleRecord, "id" | "activePeriod" | "activeRunId">) {
  return item.activePeriod && item.activeRunId ? `自动化报告/${item.id}/${item.activePeriod}-${item.activeRunId}.md` : undefined;
}

function scheduleOutputKeys(item: WorkspaceScheduleRecord, path: string) {
  const paths = [item.activeOutputRelPath || item.payload.outputRelPath].filter((file): file is string => Boolean(file));
  const archive = archivedReport(item);
  if (archive) paths.push(archive);
  if (item.activeTrigger !== "backfill") paths.push(...(item.payload.outputTargets ?? []));
  return outputKeys(path, paths);
}

export function restoreScheduleOutputClaims(host: DropTenantHost) {
  for (const item of listWorkspaceSchedules(host)) {
    if (item.state !== "running_step2" || !item.activeRunId) continue;
    const target = host.resolveWorkspace(item.workspaceId) ?? host.resolveWorkspace(item.workspaceKeySnapshot);
    if (target) {
      try {
        claimOutputs(scheduleOutputKeys(item, target.path), item.activeRunId, () =>
          readSchedulesUnlocked(host).items.some((row) => row.activeRunId === item.activeRunId));
      } catch (error) { log.warn("恢复产物占用失败", item.id, error); }
    }
  }
}

/**
 * 触发执行单条定时任务（支持后台扫描器自动触发或用户在面板/对话中点击「立即运行」）：
 * 1. 在文件锁 + 内存 Set 双重互斥下，仅当 `state === "idle"` 时才抢占为 `running_step1`；
 * 2. 一旦开始绝不再次重入执行；
 * 3. 若执行器直接完成（如 `no_change` 或无需归档），立即回写 `idle` 并从完成时刻推算 `nextRunAt`；
 * 4. 若执行器投入了知识库归档批次（`awaiting_ingest`），转入 `running_step2` 持续锁定，等后台归档完成后由 `notifyWorkspaceSchedulesOnBatchCompleted` 解锁回写。
 */
export async function triggerWorkspaceScheduleNow(
  host: DropTenantHost,
  idOrTitle: string,
  opts: { trigger?: "scheduled" | "manual" | "backfill"; workspace?: string; now?: number; onClaim?: (record: WorkspaceScheduleRecord) => void; backfill?: BackfillRequest } = {},
): Promise<{
  ok: boolean;
  schedule?: WorkspaceScheduleRecord;
  phase?: "completed" | "awaiting_ingest";
  message: string;
  error?: string;
}> {
  const q = idOrTitle.trim();
  const trigger = opts.trigger ?? "manual";
  const now = opts.now ?? Date.now();

  const claimRes = withFileLockSync(schedulesLockPath(host), () => {
    const file = readSchedulesUnlocked(host);
    const idx = file.items.findIndex(
      (x) =>
        (x.id === q || x.title === q) &&
        (!opts.workspace || x.workspaceKeySnapshot === opts.workspace || x.workspaceId === opts.workspace),
    );
    if (idx < 0) return { ok: false as const, error: `未找到定时任务：${q}` };
    const cur = file.items[idx];
    const flightKey = `${host.id}:${cur.id}`;

    if (inFlightScheduleKeys.has(flightKey) || cur.state !== "idle") {
      return {
        ok: false as const,
        error: `任务《${cur.title}》当前正在运行中（状态：${cur.state === "running_step2" ? "等待后台归档与看板刷新" : "正在采集执行"}），严禁并发重入`,
      };
    }

    const wsRef = host.resolveWorkspace(cur.workspaceKeySnapshot) ?? host.resolveWorkspace(cur.workspaceId);
    if (!wsRef) {
      return { ok: false as const, error: `任务关联的工作区不存在：${cur.workspaceKeySnapshot}` };
    }

    const period = opts.backfill?.period ?? (trigger === "scheduled" && cur.executorKind === "agent_prompt" && cur.scheduleMode === "monthly" ? previousReportMonth(cur.nextRunAt ?? now, cur.tz) : undefined);
    if (trigger === "backfill") {
      if (!opts.backfill || !period) return { ok: false as const, error: "请先检查补跑月份。" };
      const checked = buildBackfillPreview(host, cur, wsRef.path, period, now);
      if (!checked.ok) return checked;
      if (checked.preview.token !== opts.backfill.token) return { ok: false as const, error: "该期的资料或结果已变化，请重新检查。" };
      if (checked.preview.missingInputs.length) return { ok: false as const, error: "缺少已声明的月报资料，请补齐后再运行。" };
      if (checked.preview.versions && !opts.backfill.newVersion) return { ok: false as const, error: "该期已有结果，请明确选择生成新版本。" };
    }
    const runId = `wsrun_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const activeOutputRelPath = period
      ? trigger !== "backfill" && cur.payload.outputRelPath || `自动化报告/${cur.id}/${period}-${runId}.md`
      : cur.payload.outputRelPath;
    let keys: string[];
    try { keys = scheduleOutputKeys({ ...cur, activeOutputRelPath, activePeriod: period, activeRunId: runId, activeTrigger: trigger }, wsRef.path); }
    catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : "产物路径无效。" }; }
    const active = () => inFlightScheduleKeys.has(flightKey) || readSchedulesUnlocked(host).items.some((row) => row.activeRunId === runId && row.state === "running_step2");
    const holding = claimOutputs(keys, runId, active);
    const claimed: WorkspaceScheduleRecord = {
      ...cur,
      workspaceKeySnapshot: wsRef.key,
      state: holding ? "running_step1" : "waiting_output",
      activeOutputRelPath,
      activePeriod: period,
      activeRunId: runId,
      activeTrigger: trigger,
      activeStartedAt: now,
      activeBatchIds: undefined,
      submittedBatchIds: undefined,
      pendingBatchErrors: undefined,
      pendingBatchMailMap: undefined,
      leaseUntil: now + STEP1_LEASE_MS,
      lastStartedAt: now,
      updatedAt: now,
    };
    file.items[idx] = claimed;
    writeSchedulesUnlocked(host, file);
    inFlightScheduleKeys.add(flightKey);
    return { ok: true as const, claimed, workspacePath: wsRef.path, flightKey, runId, keys, active };
  });

  if (!claimRes.ok) {
    return { ok: false, message: claimRes.error, error: claimRes.error };
  }

  const { claimed, workspacePath, flightKey, runId, keys, active } = claimRes;
  const executor = getWorkspaceTaskExecutor(claimed.executorKind);

  try {
    opts.onClaim?.(claimed);
    if (claimed.state === "waiting_output") {
      while (!claimOutputs(keys, runId, active)) {
        if (!inFlightScheduleKeys.has(flightKey) || Date.now() > (claimed.leaseUntil ?? 0)) throw new Error("等待同一产物更新超时。");
        await new Promise<void>((resolve) => { setTimeout(resolve, 1000).unref(); });
      }
      const ready = withFileLockSync(schedulesLockPath(host), () => {
        const file = readSchedulesUnlocked(host);
        const current = file.items.find((item) => item.id === claimed.id && item.activeRunId === runId && item.state === "waiting_output");
        if (!current) return false;
        current.state = "running_step1";
        current.leaseUntil = Date.now() + STEP1_LEASE_MS;
        writeSchedulesUnlocked(host, file);
        return true;
      });
      if (!ready) throw new Error("这次运行已被中断。");
    }
    const missing = claimed.activePeriod && (claimed.payload.reportInputs ?? []).find((path) =>
      !ensureSafePathInWorkspace(workspacePath, path, { expectLeaf: "file" }).ok);
    const outcome = missing
      ? { phase: "completed" as const, status: "failed" as const, summary: `缺少声明的月报资料：${missing}`, error: `缺少声明的月报资料：${missing}` }
      : executor ? await executor({ host, schedule: claimed, workspacePath, now })
      : {
          phase: "completed" as const,
          status: "failed" as const,
          summary: `未注册的执行器类型：${claimed.executorKind}`,
          error: `未注册的执行器类型：${claimed.executorKind}`,
        };

    const finishTime = Date.now();
    const settled = withFileLockSync(schedulesLockPath(host), () => {
      const file = readSchedulesUnlocked(host);
      const idx = file.items.findIndex((x) => x.id === claimed.id);
      if (idx < 0) return null;
      const cur = file.items[idx];
      if (cur.activeRunId !== runId || cur.state !== "running_step1") return cur;

      if (outcome.phase === "awaiting_ingest" && outcome.batchIds.length > 0) {
        const queueEntries = listIngestQueue(host);
        const pendingBatchIds: string[] = [];
        const completedFiles: string[] = [...(outcome.updatedFiles ?? [])];
        const batchErrors: string[] = [];
        const failedBatchSet = new Set<string>();
        let latestDoneSummary = outcome.preSummary;

        for (const bid of outcome.batchIds) {
          const qEntry = queueEntries.find((e) => e.batchId === bid);
          if (!qEntry || qEntry.status === "queued" || qEntry.status === "processing") {
            pendingBatchIds.push(bid);
          } else {
            const logData = readBatchLogFromWorkspace(workspacePath, bid);
            completedFiles.push(...logData.updatedFiles);
            if (logData.summary) latestDoneSummary = logData.summary;
            if (qEntry.status === "failed") {
              failedBatchSet.add(bid);
              batchErrors.push(qEntry.errorReason || logData.errorReason || `归档批次 ${bid} 失败`);
            } else if (qEntry.status === "partial") {
              batchErrors.push(qEntry.errorReason || logData.errorReason || `归档批次 ${bid} 部分归档`);
            }
          }
        }

        const uniqueFiles = [...new Set(completedFiles)];

        if (pendingBatchIds.length > 0) {
          const step2Record: WorkspaceScheduleRecord = {
            ...cur,
            state: "running_step2",
            activeBatchIds: pendingBatchIds,
            submittedBatchIds: outcome.batchIds,
            pendingBatchErrors: batchErrors.length > 0 ? batchErrors : undefined,
            pendingBatchMailMap: outcome.batchMailMap,
            leaseUntil: finishTime + STEP2_LEASE_MS,
            pendingPreSummary: latestDoneSummary,
            pendingUpdatedFiles: uniqueFiles.length > 0 ? uniqueFiles : undefined,
            pendingCursorState: outcome.nextCursorState,
            lastSummary: latestDoneSummary,
            updatedAt: finishTime,
          };
          file.items[idx] = step2Record;
          writeSchedulesUnlocked(host, file);
          return step2Record;
        }

        const allFailed = failedBatchSet.size === outcome.batchIds.length;
        const finalStatus: WorkspaceScheduleRunStatus = allFailed
          ? "failed"
          : batchErrors.length > 0
            ? "partial"
            : "succeeded";
        const errStr = batchErrors.length > 0 ? batchErrors.join("；") : undefined;
        const nextCursor = computeNextCursorWithMailMap(
          cur.cursorState,
          outcome.nextCursorState,
          outcome.batchMailMap,
          failedBatchSet,
        );
        const finalized = finalizeScheduleRunUnlocked(host, cur, {
          runId,
          trigger,
          startedAt: claimed.activeStartedAt ?? now,
          finishedAt: finishTime,
          status: finalStatus,
          summary: errStr ? `${latestDoneSummary}（${errStr}）` : latestDoneSummary,
          batchIds: outcome.batchIds,
          updatedFiles: uniqueFiles,
          nextCursorState: allFailed && !outcome.batchMailMap ? undefined : nextCursor,
          error: errStr,
        });
        file.items[idx] = finalized;
        writeSchedulesUnlocked(host, file);
        return finalized;
      }

      const comp = outcome.phase === "completed" ? outcome : {
        status: "succeeded" as const,
        summary: outcome.preSummary,
        updatedFiles: outcome.updatedFiles,
        nextCursorState: outcome.nextCursorState,
        error: undefined,
      };
      const finalized = finalizeScheduleRunUnlocked(host, cur, {
        runId,
        trigger,
        startedAt: claimed.activeStartedAt ?? now,
        finishedAt: finishTime,
        status: comp.status,
        summary: comp.summary,
        updatedFiles: comp.updatedFiles,
        nextCursorState: comp.status === "failed" ? undefined : comp.nextCursorState,
        error: comp.error,
      });
      file.items[idx] = finalized;
      writeSchedulesUnlocked(host, file);
      return finalized;
    });

    const isStep2 = settled?.state === "running_step2";
    return {
      ok: true,
      schedule: settled ?? claimed,
      phase: isStep2 ? "awaiting_ingest" : "completed",
      message: settled?.lastSummary || "定时任务已执行",
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const finishTime = Date.now();
    const failedRec = withFileLockSync(schedulesLockPath(host), () => {
      const file = readSchedulesUnlocked(host);
      const idx = file.items.findIndex((x) => x.id === claimed.id);
      if (idx < 0) return undefined;
      const cur = file.items[idx];
      if (cur.activeRunId !== runId || cur.state !== "running_step1") return cur;
      const finalized = finalizeScheduleRunUnlocked(host, cur, {
        runId,
        trigger,
        startedAt: claimed.activeStartedAt ?? now,
        finishedAt: finishTime,
        status: "failed",
        summary: `执行异常：${errMsg}`,
        error: errMsg,
      });
      file.items[idx] = finalized;
      writeSchedulesUnlocked(host, file);
      return finalized;
    });
    return { ok: false, schedule: failedRec, message: `任务执行失败：${errMsg}`, error: errMsg };
  } finally {
    inFlightScheduleKeys.delete(flightKey);
    if (!active()) releaseOutputs(keys, runId);
  }
}

/** UI 在记录持久化后即可收到回执，执行结果由运行记录刷新。 */
export function startWorkspaceScheduleForUi(host: DropTenantHost, id: string, workspace?: string, backfill?: BackfillRequest):
  Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  return new Promise((resolve, reject) => {
    let claimed = false;
    void triggerWorkspaceScheduleNow(host, id, {
      workspace,
      backfill,
      trigger: backfill ? "backfill" : "manual",
      onClaim(record) {
        claimed = true;
        resolve({ ok: true, message: record.state === "waiting_output" ? `《${record.title}》已排队，正在等待同一产物。` : `已开始运行《${record.title}》，可在运行记录查看进度。` });
      },
    }).then(
      (result) => {
        if (!result.ok && !claimed) resolve({ ok: false, error: result.error || result.message });
      },
      (error: unknown) => {
        if (!claimed) reject(error);
        else log.error("workspace-schedule-ui", error);
      },
    );
  });
}

/**
 * 当后台知识库归档批次（`IngestRunner`）跑完时回调核销处于 `running_step2` 的定时任务：
 * 1. 从 `activeBatchIds` 移除已完成的 `batchId`，累积归档产物路径与摘要；
 * 2. 当 `activeBatchIds` 全部完成时，正式释放 `running_step2 -> idle` 锁，回写更新时间、更新内容与下次运行时间。
 */
export function notifyWorkspaceSchedulesOnBatchCompleted(ctx: {
  host: DropTenantHost;
  batchId: string;
  status: "completed" | "partial" | "failed";
  summaryText: string;
  movedFiles: Array<{ from: string; to: string; category: string }>;
  updatedHtmls: string[];
  errorReason?: string;
}): number {
  const { host, batchId, status, summaryText, movedFiles, updatedHtmls, errorReason } = ctx;
  if (!batchId) return 0;

  return withFileLockSync(schedulesLockPath(host), () => {
    const file = readSchedulesUnlocked(host);
    let settledCount = 0;
    let mutated = false;
    const now = Date.now();

    for (let i = 0; i < file.items.length; i++) {
      const item = file.items[i];
      if (item.state !== "running_step2" || !Array.isArray(item.activeBatchIds)) continue;
      if (!item.activeBatchIds.includes(batchId)) continue;

      const remaining = item.activeBatchIds.filter((id) => id !== batchId);
      const newFiles = [
        ...(item.pendingUpdatedFiles ?? []),
        ...updatedHtmls,
        ...movedFiles.map((m) => m.to),
      ];
      const uniqueFiles = [...new Set(newFiles)];
      const combinedSummary = summaryText.trim()
        ? clip(summaryText.trim(), 500)
        : item.pendingPreSummary || "已完成知识库归档更新";
      const batchErrors = [...(item.pendingBatchErrors ?? [])];
      if (status === "failed" || status === "partial") {
        batchErrors.push(errorReason || `归档批次 ${batchId} ${status === "failed" ? "失败" : "部分归档"}`);
      }
      const nextMailMap = item.pendingBatchMailMap ? { ...item.pendingBatchMailMap } : undefined;
      if (nextMailMap && status === "failed") {
        delete nextMailMap[batchId];
      }

      if (remaining.length > 0) {
        file.items[i] = {
          ...item,
          activeBatchIds: remaining,
          pendingBatchErrors: batchErrors.length > 0 ? batchErrors : undefined,
          pendingBatchMailMap: nextMailMap,
          pendingUpdatedFiles: uniqueFiles,
          pendingPreSummary: combinedSummary,
          leaseUntil: now + STEP2_LEASE_MS,
          updatedAt: now,
        };
        mutated = true;
        continue;
      }

      const allBatches = item.submittedBatchIds ?? [batchId];
      const queueEntries = listIngestQueue(host);
      const failedBatchSet = new Set<string>(status === "failed" ? [batchId] : []);
      for (const bid of allBatches) {
        if (queueEntries.find((e) => e.batchId === bid)?.status === "failed") {
          failedBatchSet.add(bid);
        }
      }
      const allFailed = failedBatchSet.size >= allBatches.length;
      const runStatus: WorkspaceScheduleRunStatus = allFailed
        ? "failed"
        : batchErrors.length > 0 || status === "partial"
          ? "partial"
          : "succeeded";
      const errStr = batchErrors.length > 0 ? batchErrors.join("；") : errorReason;
      const nextCursor = computeNextCursorWithMailMap(
        item.cursorState,
        item.pendingCursorState,
        item.pendingBatchMailMap,
        failedBatchSet,
      );

      file.items[i] = finalizeScheduleRunUnlocked(host, item, {
        runId: item.activeRunId ?? `wsrun_${now}`,
        trigger: item.activeTrigger ?? "scheduled",
        startedAt: item.activeStartedAt ?? item.lastStartedAt ?? now,
        finishedAt: now,
        status: runStatus,
        summary:
          runStatus === "failed"
            ? `后台归档未完成：${errStr || "归档失败"}`
            : errStr
              ? `${combinedSummary}（${errStr}）`
              : combinedSummary,
        batchIds: allBatches,
        updatedFiles: uniqueFiles,
        nextCursorState: allFailed && !item.pendingBatchMailMap ? undefined : nextCursor,
        error: runStatus === "succeeded" ? undefined : errStr || "归档批次未完全成功",
      });
      mutated = true;
      settledCount += 1;
    }

    if (mutated) {
      writeSchedulesUnlocked(host, file);
    }
    return settledCount;
  });
}

/**
 * 崩溃恢复与僵尸锁对账（网关启动及每次扫描 Tick 调用）：
 * 1. 若任务处于 `running_step1` 但进程内无此 `inFlightScheduleKeys`（说明上次进程重启中断）或租约超时，自动恢复为 `idle`；
 * 2. 若任务处于 `running_step2`，对照 `ingest-queue.json` 检查所有 `activeBatchIds` 是否均已结束或租约超时，若已结束则自动核销解锁。
 */
export function reconcileStaleWorkspaceSchedules(host: DropTenantHost, now = Date.now()): number {
  return withFileLockSync(schedulesLockPath(host), () => {
    const file = readSchedulesUnlocked(host);
    let recovered = 0;
    let mutated = false;
    const queueEntries = listIngestQueue(host);

    for (let i = 0; i < file.items.length; i++) {
      const item = file.items[i];
      if (item.state === "idle") continue;
      const flightKey = `${host.id}:${item.id}`;
      const leaseExpired = Boolean(item.leaseUntil && now > item.leaseUntil);

      if (item.state === "running_step1" || item.state === "waiting_output") {
        if (!inFlightScheduleKeys.has(flightKey)) {
          const archive = archivedReport(item);
          const workspace = host.resolveWorkspace(item.workspaceId) ?? host.resolveWorkspace(item.workspaceKeySnapshot);
          const saved = archive && workspace ? ensureSafePathInWorkspace(workspace.path, archive, { expectLeaf: "file" }) : undefined;
          let savedReport = false;
          if (saved?.ok) {
            try { savedReport = statSync(saved.absPath).size > 0; } catch { /* 文件还未交付 */ }
          }
          const known = item.activeRunId && readJsonl<WorkspaceScheduleRunRecord>(runsFilePath(host)).find((row) => row.runId === item.activeRunId);
          const needsIngest = Boolean(savedReport && workspace && item.activeTrigger !== "backfill" &&
            item.payload.ingestToKb !== false && loadKbWorkspaceConfig(workspace.path, host.workspaceRoot).ok);
          file.items[i] = finalizeScheduleRunUnlocked(host, item, {
            runId: item.activeRunId ?? `wsrun_${now}`,
            trigger: item.activeTrigger ?? "scheduled",
            startedAt: item.activeStartedAt ?? now,
            finishedAt: known ? known.finishedAt : now,
            status: known ? known.status : savedReport ? needsIngest ? "partial" : "succeeded" : "failed",
            summary: known ? known.summary : savedReport
              ? needsIngest ? "已找回本期报告；归档状态尚未确认，请核对后再处理。" : "网关重启后已找回本期报告，无需重跑。"
              : item.state === "waiting_output" ? "网关重启，排队中的运行尚未开始。" : "网关重启，运行中断。",
            updatedFiles: known ? known.updatedFiles : savedReport && archive ? [archive] : undefined,
            batchIds: known ? known.batchIds : undefined,
            error: known ? known.error : savedReport ? undefined : "process_restarted",
          });
          mutated = true;
          recovered += 1;
        }
        continue;
      }

      if (item.state === "running_step2") {
        const batchIds = item.activeBatchIds ?? [];
        const stillRunning = batchIds.filter((bid) => {
          const entry = queueEntries.find((e) => e.batchId === bid);
          return entry && (entry.status === "queued" || entry.status === "processing");
        });
        if (stillRunning.length === 0 || leaseExpired) {
          const allBatches = item.submittedBatchIds ?? batchIds;
          const failedBatchSet = new Set<string>();
          for (const bid of allBatches) {
            const q = queueEntries.find((e) => e.batchId === bid);
            if (!q || q.status === "failed" || (leaseExpired && stillRunning.includes(bid))) {
              failedBatchSet.add(bid);
              if (item.executorKind === "wecom_watch_sync") {
                try {
                  rollbackWecomWatchLedgerOnBatchFailed(
                    host,
                    bid,
                    leaseExpired ? "等待归档租约超时" : q?.errorReason || "归档未完成",
                  );
                } catch {
                  // ignore
                }
              }
            }
          }
          const anyFailed = failedBatchSet.size > 0;
          const allFailed = failedBatchSet.size >= allBatches.length;
          const nextCursor = computeNextCursorWithMailMap(
            item.cursorState,
            item.pendingCursorState,
            item.pendingBatchMailMap,
            failedBatchSet,
          );
          file.items[i] = finalizeScheduleRunUnlocked(host, item, {
            runId: item.activeRunId ?? `wsrun_${now}`,
            trigger: item.activeTrigger ?? "scheduled",
            startedAt: item.activeStartedAt ?? now,
            finishedAt: now,
            status: leaseExpired || allFailed ? "failed" : anyFailed ? "partial" : "succeeded",
            summary: leaseExpired
              ? "等待后台归档超时，已自动解锁"
              : item.pendingPreSummary || "后台归档已完成（对账核销）",
            batchIds: allBatches,
            updatedFiles: item.pendingUpdatedFiles,
            nextCursorState: (leaseExpired || allFailed) && !item.pendingBatchMailMap ? undefined : nextCursor,
            error: leaseExpired ? "step2_lease_expired" : anyFailed ? "batch_failed" : undefined,
          });
          mutated = true;
          recovered += 1;
        }
      }
    }

    if (mutated) {
      writeSchedulesUnlocked(host, file);
    }
    return recovered;
  });
}

let activeScheduleLoopTimer: ReturnType<typeof setInterval> | null = null;
let scheduleLoopRunning = false;

export async function runWorkspaceScheduleTickForTenant(host: DropTenantHost, now = Date.now()): Promise<number> {
  try {
    reconcileStaleWorkspaceSchedules(host, now);
  } catch (err) {
    log.error("reconcile workspace schedules", err instanceof Error ? err.message : err);
  }

  const dueItems = listWorkspaceSchedules(host).filter(
    (item) => item.enabled && item.state === "idle" && item.nextRunAt !== null && now >= item.nextRunAt,
  );

  let triggered = 0;
  for (const item of dueItems) {
    const flightKey = `${host.id}:${item.id}`;
    if (inFlightScheduleKeys.has(flightKey)) continue;
    triggered += 1;
    void triggerWorkspaceScheduleNow(host, item.id, { trigger: "scheduled", now }).catch((err) => {
      log.error("workspace schedule run error", item.id, err instanceof Error ? err.message : err);
    });
  }
  return triggered;
}

export function startWorkspaceScheduleLoop(opts: {
  tenants: () => DropPortalTenant[];
  tickIntervalMs?: number;
}): void {
  stopWorkspaceScheduleLoop();
  const intervalMs = opts.tickIntervalMs ?? WORKSPACE_SCHEDULER_TICK_MS;
  if (intervalMs <= 0) return;

  for (const tenant of opts.tenants()) {
    try {
      reconcileStaleWorkspaceSchedules(buildDropTenantHost(tenant));
    } catch (err) {
      log.error("startup reconcile workspace schedules", err instanceof Error ? err.message : err);
    }
  }

  activeScheduleLoopTimer = setInterval(() => {
    if (scheduleLoopRunning) return;
    scheduleLoopRunning = true;
    void (async () => {
      try {
        for (const tenant of opts.tenants()) {
          await runWorkspaceScheduleTickForTenant(buildDropTenantHost(tenant));
        }
      } catch (err) {
        log.error("workspace schedule tick error", err instanceof Error ? err.message : err);
      } finally {
        scheduleLoopRunning = false;
      }
    })();
  }, intervalMs);
  activeScheduleLoopTimer.unref?.();
}

export function stopWorkspaceScheduleLoop(): void {
  if (activeScheduleLoopTimer) {
    clearInterval(activeScheduleLoopTimer);
    activeScheduleLoopTimer = null;
  }
  scheduleLoopRunning = false;
}

