import { localParts, localToUtc, validTimeZone } from "../assistant/cron.ts";
import { DEFAULT_TZ } from "../assistant/schedules.ts";
import type { DropTenantHost } from "./tokens.ts";

export type WorkspaceScheduleExecutorKind =
  | "wecom_watch_sync"
  | "wecom_mail_poll"
  | "http_api_ingest"
  | "workspace_script"
  | "agent_prompt";

export type WorkspaceScheduleMode = "interval" | "daily_times";

export type WorkspaceScheduleState = "idle" | "running_step1" | "running_step2";

export type WorkspaceScheduleRunStatus = "succeeded" | "no_change" | "partial" | "failed";

export type WorkspaceSchedulePayload = {
  /** wecom_watch_sync: "all" 或指定关注项 ID/标题列表 */
  watchItemIds?: "all" | string[];
  /** wecom_watch_sync: 防半成品静默等待分钟数（默认 3 分钟） */
  quietPeriodMinutes?: number;
  /** wecom_mail_poll: 邮件搜索关键词 */
  mailKeyword?: string;
  /** wecom_mail_poll: 是否只拉带附件邮件 */
  onlyWithAttachments?: boolean;
  /** wecom_mail_poll: 单次最多处理邮件数（默认 5） */
  mailLimit?: number;
  /** http_api_ingest: 受控公开 HTTP/HTTPS URL */
  url?: string;
  /** http_api_ingest: 归档保存的目标文件名（如 api_report.md 或 data.csv） */
  targetFileName?: string;
  /** workspace_script: 解释器类型 */
  runner?: "python3" | "node" | "bash";
  /** workspace_script: 相对工作区根目录的脚本路径（如 scripts/pull.py） */
  scriptRelPath?: string;
  /** workspace_script: 传给脚本的参数数组 */
  args?: string[];
  /** workspace_script: 脚本产出的待入库相对文件路径（如 output/latest.csv），不填则将 stdout 作为产物 */
  outputRelPath?: string;
  /** workspace_script / agent_prompt: 是否将产物投入知识库归档队列刷新 HTML 看板（默认 true） */
  ingestToKb?: boolean;
  /** workspace_script / agent_prompt: 超时秒数（默认 60s） */
  timeoutSeconds?: number;
  /** agent_prompt: 定时执行的 AI 分析/汇总指令 */
  prompt?: string;
  /** 通用归档备注说明 */
  note?: string;
};

export type WorkspaceScheduleRecord = {
  id: string;
  workspaceId: string;
  workspaceKeySnapshot: string;
  title: string;
  enabled: boolean;

  executorKind: WorkspaceScheduleExecutorKind;
  payload: WorkspaceSchedulePayload;

  scheduleMode: WorkspaceScheduleMode;
  /** 固定间隔分钟数（5 ~ 10080，默认 60） */
  intervalMinutes: number;
  /** 每日固定触发时刻列表（如 ["08:45", "18:30"]） */
  dailyTimes?: string[];
  /** 允许运行的时间窗（如 { start: "08:00", end: "22:00" }） */
  activeHours?: { start: string; end: string };
  tz: string;

  /** 执行器增量水位游标（如 seenMailIds、lastBodySha256、lastOutputSha256） */
  cursorState: Record<string, unknown>;

  /** 两阶段单飞互斥锁状态 */
  state: WorkspaceScheduleState;
  activeRunId?: string;
  activeTrigger?: "scheduled" | "manual";
  activeStartedAt?: number;
  activeBatchIds?: string[];
  submittedBatchIds?: string[];
  pendingBatchErrors?: string[];
  pendingBatchMailMap?: Record<string, string>;
  leaseUntil?: number;
  pendingPreSummary?: string;
  pendingUpdatedFiles?: string[];
  pendingCursorState?: Record<string, unknown>;

  nextRunAt: number | null;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastStatus?: WorkspaceScheduleRunStatus;
  lastSummary?: string;
  lastUpdatedFiles?: string[];
  lastError?: string;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceScheduleRunRecord = {
  runId: string;
  scheduleId: string;
  workspaceId: string;
  workspaceKey: string;
  title: string;
  executorKind: WorkspaceScheduleExecutorKind;
  trigger: "scheduled" | "manual";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  status: WorkspaceScheduleRunStatus;
  summary: string;
  batchIds?: string[];
  updatedFiles?: string[];
  error?: string;
};

export type TaskExecutionOutcome =
  | {
      phase: "completed";
      status: WorkspaceScheduleRunStatus;
      summary: string;
      updatedFiles?: string[];
      nextCursorState?: Record<string, unknown>;
      error?: string;
    }
  | {
      phase: "awaiting_ingest";
      batchIds: string[];
      preSummary: string;
      updatedFiles?: string[];
      nextCursorState?: Record<string, unknown>;
      batchMailMap?: Record<string, string>;
    };

export type TaskExecutionContext = {
  host: DropTenantHost;
  schedule: WorkspaceScheduleRecord;
  workspacePath: string;
  now: number;
};

export type WorkspaceTaskExecutor = (ctx: TaskExecutionContext) => Promise<TaskExecutionOutcome>;

function parseHhMm(raw: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function normalizeDailyTimes(times?: string[]): string[] {
  if (!Array.isArray(times)) return [];
  const out = new Set<string>();
  for (const raw of times) {
    if (typeof raw !== "string") continue;
    const p = parseHhMm(raw);
    if (p) {
      out.add(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
    }
  }
  return [...out].sort();
}

export function normalizeActiveHours(
  activeHours?: { start: string; end: string } | null,
): { start: string; end: string } | undefined {
  if (!activeHours || typeof activeHours !== "object") return undefined;
  const s = parseHhMm(activeHours.start || "");
  const e = parseHhMm(activeHours.end || "");
  if (!s || !e) return undefined;
  const start = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  const end = `${String(e.hour).padStart(2, "0")}:${String(e.minute).padStart(2, "0")}`;
  if (start === end) return undefined;
  return { start, end };
}

function isWithinActiveHours(utcMs: number, tz: string, activeHours?: { start: string; end: string }): boolean {
  if (!activeHours) return true;
  const s = parseHhMm(activeHours.start);
  const e = parseHhMm(activeHours.end);
  if (!s || !e) return true;
  const parts = localParts(utcMs, tz);
  const curMin = parts.hour * 60 + parts.minute;
  const startMin = s.hour * 60 + s.minute;
  const endMin = e.hour * 60 + e.minute;
  if (startMin <= endMin) {
    return curMin >= startMin && curMin <= endMin;
  }
  return curMin >= startMin || curMin <= endMin;
}

/**
 * 计算下一次触发时间（Fixed-Delay 从基准时刻 baseNow 往后推算）：
 * 1. interval 模式：baseNow + intervalMinutes * 60_000；若配置了 activeHours 且落点在活跃时间窗外，顺延至下一个窗口起点；
 * 2. daily_times 模式：按 tz 时区寻找 > baseNow 的最近一个 HH:MM 时刻。
 */
export function computeNextWorkspaceScheduleRunAt(
  spec: {
    scheduleMode: WorkspaceScheduleMode;
    intervalMinutes: number;
    dailyTimes?: string[];
    activeHours?: { start: string; end: string };
    tz?: string;
  },
  baseNow = Date.now(),
): number {
  const tz = spec.tz && validTimeZone(spec.tz) ? spec.tz : DEFAULT_TZ;
  const safeInterval = Math.max(5, Math.min(10_080, Math.floor(spec.intervalMinutes || 60)));

  if (spec.scheduleMode === "daily_times") {
    const times = normalizeDailyTimes(spec.dailyTimes);
    const effectiveTimes = times.length > 0 ? times : ["09:00"];
    const baseParts = localParts(baseNow + 60_000, tz);
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const cal = new Date(Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + dayOffset));
      const y = cal.getUTCFullYear();
      const m = cal.getUTCMonth() + 1;
      const d = cal.getUTCDate();
      for (const hhmm of effectiveTimes) {
        const parsed = parseHhMm(hhmm);
        if (!parsed) continue;
        const candidateUtc = localToUtc(y, m, d, parsed.hour, parsed.minute, tz);
        if (candidateUtc > baseNow) {
          return candidateUtc;
        }
      }
    }
  }

  let candidate = baseNow + safeInterval * 60_000;
  if (spec.activeHours && !isWithinActiveHours(candidate, tz, spec.activeHours)) {
    const s = parseHhMm(spec.activeHours.start);
    if (s) {
      const candParts = localParts(candidate, tz);
      for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
        const cal = new Date(Date.UTC(candParts.year, candParts.month - 1, candParts.day + dayOffset));
        const y = cal.getUTCFullYear();
        const m = cal.getUTCMonth() + 1;
        const d = cal.getUTCDate();
        const winStartUtc = localToUtc(y, m, d, s.hour, s.minute, tz);
        if (winStartUtc >= candidate && isWithinActiveHours(winStartUtc, tz, spec.activeHours)) {
          candidate = winStartUtc;
          break;
        }
      }
    }
  }
  return candidate;
}
