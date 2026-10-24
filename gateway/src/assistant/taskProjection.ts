import type {
  AssistantApproval,
  AssistantInboxItem,
  DayThreadEvent,
  DraftCard,
  PersonalTask,
  PersonalTaskPriority,
  TaskReceipt,
  TaskSourceRef,
} from "../../../shared/protocol.ts";
import type { Delegation } from "./delegations.ts";
import type { BackgroundRun } from "./runs.ts";
import type { Schedule } from "./schedules.ts";
import type { Todo } from "./todos.ts";

export const TASK_PROJECTION_VERSION = 1;
export const DEFAULT_PROJECTION_LIMITS: { tasks: number; drafts: number; events: number } = {
  tasks: 120,
  drafts: 30,
  events: 80,
};

/** 状态按 String 接收，事实源将来增加 waiting_user/stalled 时投影无需先升级类型。 */
export type ProjectionRun = Omit<BackgroundRun, "status"> & { status: string };

export type TaskProjectionInput = {
  todos: Todo[];
  schedules: Schedule[];
  delegations: Delegation[];
  approvals: AssistantApproval[];
  runs: ProjectionRun[];
  inbox: AssistantInboxItem[];
  brief?: { day: string; text: string } | null;
};

export type TaskProjectionOptions = {
  now?: number;
  day?: string;
  limits?: Partial<typeof DEFAULT_PROJECTION_LIMITS>;
};

type Projection = {
  personalTasks: PersonalTask[];
  draftCards: DraftCard[];
  dayThread: DayThreadEvent[];
  projectionVersion: number;
  snapshotAt: number;
};

const DAY_MS = 86_400_000;
const PHASE_ORDER: Record<PersonalTask["phase"], number> = {
  needs_me: 0,
  in_progress: 1,
  planned: 2,
  completed: 3,
};
const PRIORITY_ORDER: Record<PersonalTaskPriority, number> = { high: 0, normal: 1, low: 2 };

function clip(value: string | undefined, max: number) {
  const text = value?.trim() ?? "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function source(kind: string, id: string): TaskSourceRef {
  return { kind, id };
}

function dayFor(at: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function timestampDay(at: number | undefined, day: string) {
  return at !== undefined && Number.isFinite(at) && dayFor(at) === day;
}

function receipt(id: string, status: string, at: number | undefined, summary?: string): TaskReceipt | undefined {
  if (at === undefined) return undefined;
  return { id, status, at, summary: clip(summary, 500) || undefined };
}

function dueAt(due: string | undefined) {
  if (!due) return undefined;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(due) ? Date.parse(`${due}T23:59:59+08:00`) : Date.parse(due);
  return Number.isFinite(value) ? value : undefined;
}

function runPhase(status: string): PersonalTask["phase"] {
  if (status === "done") return "completed";
  if (status === "running") return "in_progress";
  if (["waiting_user", "failed", "interrupted", "stalled"].includes(status)) return "needs_me";
  return "planned";
}

function runAttention(status: string, error?: string) {
  if (status === "waiting_user") return "等待你处理";
  if (status === "stalled") return "运行停滞";
  if (status === "failed" || status === "interrupted") return clip(error, 240) || "运行失败";
  return undefined;
}

function draftPreview(approval: AssistantApproval): DraftCard["preview"] {
  const tool = approval.tool;
  const normalized = tool.toLowerCase();
  let kind = "tool";
  let title = `批准 ${tool || "操作"}`;
  if (normalized === "create_workspace") {
    kind = "create_workspace";
    title = "创建工作区";
  } else if (normalized === "workspace_memory") {
    kind = "workspace_memory";
    title = "写入工作区记忆";
  } else if (normalized === "work_preferences") {
    kind = "work_preferences";
    title = "更新工作偏好";
  } else if (normalized.includes("shell") || normalized.includes("terminal")) {
    kind = "shell";
    title = "执行命令";
  } else if (/(edit|write|delete|patch)/.test(normalized)) {
    kind = "edit";
    title = "修改文件";
  }
  const summary = clip(approval.summary, 500) || "等待确认后执行";
  return {
    kind,
    title,
    summary,
    details: tool ? [`工具：${clip(tool, 80)}`] : undefined,
  };
}

function projectDrafts(approvals: AssistantApproval[]): DraftCard[] {
  return approvals.map((approval) => ({
    id: `draft:${approval.id}`,
    kind: "approval",
    status: "waiting_user",
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    preview: draftPreview(approval),
    sources: [source("approval", approval.id)],
    actions: [
      {
        label: "允许",
        op: "approval_answer",
        args: { chatId: approval.chatId, callId: approval.callId, allow: true },
      },
      {
        label: "拒绝",
        op: "approval_answer",
        args: { chatId: approval.chatId, callId: approval.callId, allow: false },
      },
    ],
  }));
}

function linkedRun(delegation: Delegation, runs: ProjectionRun[]) {
  return runs.find(
    (run) =>
      run.origin === "delegate" &&
      ((run.chatId && run.chatId === delegation.childChatId) ||
        (run.label === delegation.title && Math.abs(run.startedAt - delegation.createdAt) < DAY_MS)),
  );
}

function projectTasks(input: TaskProjectionInput, now: number): PersonalTask[] {
  const linkedRunIds = new Set<string>();
  const tasks: PersonalTask[] = [];

  for (const todo of input.todos) {
    const at = dueAt(todo.due);
    const overdue = !todo.done && at !== undefined && at < now;
    tasks.push({
      id: `todo:${todo.id}`,
      kind: "todo",
      title: clip(todo.text, 300),
      phase: todo.done ? "completed" : overdue ? "needs_me" : "planned",
      status: todo.done ? "done" : overdue ? "overdue" : "open",
      priority: overdue ? "high" : todo.done ? "low" : "normal",
      attention: overdue ? "已逾期" : undefined,
      detail: clip(todo.quote, 240) || undefined,
      due: todo.due,
      dueAt: at,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt ?? todo.doneAt,
      sources: [source("todo", todo.id)],
      receipt: todo.done ? receipt(`receipt:todo:${todo.id}`, "done", todo.doneAt, todo.text) : undefined,
      actions: [
        {
          label: todo.done ? "重新打开" : "完成",
          op: todo.done ? "todo_undo" : "todo_done",
          args: { id: todo.id },
        },
      ],
    });
  }

  for (const schedule of input.schedules) {
    const failed = Boolean(
      schedule.pausedReason ||
      schedule.failCount > 0 ||
      (schedule.lastStatus && ["failed", "interrupted"].includes(schedule.lastStatus)),
    );
    const phase = failed ? "needs_me" : "planned";
    tasks.push({
      id: `schedule:${schedule.id}`,
      kind: "schedule",
      title: clip(schedule.title, 160),
      phase,
      status: schedule.enabled ? (schedule.lastStatus ?? "scheduled") : "paused",
      priority: failed ? "high" : "normal",
      attention: failed ? clip(schedule.pausedReason, 240) || "最近运行失败" : undefined,
      detail: clip(schedule.prompt, 300) || schedule.cron,
      dueAt: schedule.nextAt ?? undefined,
      createdAt: schedule.createdAt,
      updatedAt: schedule.lastCompletedAt,
      sources: [source("schedule", schedule.id)],
      receipt:
        schedule.lastCompletedAt && schedule.lastStatus
          ? receipt(
              `receipt:schedule:${schedule.id}:${schedule.lastCompletedAt}`,
              schedule.lastStatus,
              schedule.lastCompletedAt,
              schedule.title,
            )
          : undefined,
      actions: [
        {
          label: schedule.enabled ? "暂停" : "启用",
          op: "schedule_set",
          args: { id: schedule.id, enabled: !schedule.enabled },
        },
      ],
    });
  }

  for (const delegation of input.delegations) {
    const run = linkedRun(delegation, input.runs);
    if (run) linkedRunIds.add(run.runId);
    const approval = input.approvals.find(
      (item) => item.delegationId === delegation.id || item.chatId === delegation.childChatId,
    );
    const needsMe = delegation.status === "awaiting" || Boolean(approval);
    const failed = delegation.status === "failed";
    const phase =
      needsMe || failed
        ? "needs_me"
        : delegation.status === "running"
          ? "in_progress"
          : delegation.status === "done"
            ? "completed"
            : "planned";
    const sources = [source("delegation", delegation.id)];
    if (run) sources.push(source("run", run.runId));
    tasks.push({
      id: `delegation:${delegation.id}`,
      kind: "delegation",
      title: clip(delegation.title, 160),
      phase,
      status: needsMe ? "waiting_user" : delegation.status,
      priority: needsMe || failed ? "high" : delegation.status === "done" ? "low" : "normal",
      attention: needsMe ? "等待你批准" : failed ? clip(delegation.result, 240) || "委派失败" : undefined,
      detail: clip(delegation.result || delegation.task, 500) || undefined,
      createdAt: delegation.createdAt,
      updatedAt: delegation.endedAt,
      sources,
      receipt:
        delegation.status === "done" || delegation.status === "failed"
          ? receipt(`receipt:delegation:${delegation.id}`, delegation.status, delegation.endedAt, delegation.result)
          : undefined,
      actions:
        delegation.status === "running" || delegation.status === "awaiting"
          ? [{ label: "取消", op: "delegation_cancel", args: { delegationId: delegation.id } }]
          : undefined,
    });
  }

  for (const run of input.runs) {
    if (linkedRunIds.has(run.runId)) continue;
    const phase = runPhase(run.status);
    const attention = runAttention(run.status, run.error);
    tasks.push({
      id: `run:${run.runId}`,
      kind: "background_run",
      title: clip(run.label, 160),
      phase,
      status: run.status,
      priority: attention ? "high" : phase === "completed" ? "low" : "normal",
      attention,
      detail: clip(run.summary || run.error, 500) || undefined,
      createdAt: run.startedAt,
      updatedAt: run.endedAt,
      sources: [source("run", run.runId)],
      receipt:
        run.status !== "running"
          ? receipt(`receipt:run:${run.runId}`, run.status, run.endedAt, run.summary || run.error)
          : undefined,
    });
  }

  return tasks.sort(
    (a, b) =>
      PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] ||
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

function projectDayThread(
  input: TaskProjectionInput,
  tasks: PersonalTask[],
  drafts: DraftCard[],
  now: number,
  day: string,
): DayThreadEvent[] {
  const events: Array<DayThreadEvent & { dedupe: string }> = [];
  if (input.brief?.day === day && input.brief.text.trim()) {
    events.push({
      id: `brief:${day}`,
      dedupe: `brief:${day}`,
      kind: "brief",
      title: "今日简报",
      body: clip(input.brief.text, 2000),
      at: now,
      priority: "normal",
      sources: [source("brief", day)],
    });
  }

  for (const draft of drafts) {
    const approval = input.approvals.find((item) => `draft:${item.id}` === draft.id);
    events.push({
      id: `event:${draft.id}`,
      dedupe: `approval:${approval?.delegationId || approval?.chatId || draft.id}`,
      kind: "draft",
      title: draft.preview.title,
      body: draft.preview.summary,
      at: draft.createdAt,
      priority: "high",
      draftCardId: draft.id,
      taskId: approval?.delegationId ? `delegation:${approval.delegationId}` : undefined,
      sources: draft.sources,
    });
  }

  const draftDedupe = new Set(events.filter((event) => event.kind === "draft").map((event) => event.dedupe));
  const highInboxKinds = new Set(["approval", "delegation", "reminder"]);
  for (const item of input.inbox) {
    if (item.read || !highInboxKinds.has(item.kind)) continue;
    const dedupe =
      item.kind === "approval"
        ? `approval:${item.delegationId || item.chatId || item.id}`
        : item.delegationId
          ? `delegation:${item.delegationId}:${item.kind}`
          : `inbox:${item.id}`;
    if (draftDedupe.has(dedupe)) continue;
    events.push({
      id: `inbox:${item.id}`,
      dedupe,
      kind: "inbox",
      title: clip(item.title, 160),
      body: clip(item.body, 1000) || undefined,
      at: item.createdAt,
      priority: "high",
      taskId: item.delegationId ? `delegation:${item.delegationId}` : undefined,
      sources: [source("inbox", item.id)],
    });
  }

  for (const task of tasks) {
    if (!task.receipt || !timestampDay(task.receipt.at, day)) continue;
    events.push({
      id: `event:${task.receipt.id}`,
      dedupe: task.receipt.id,
      kind: "receipt",
      title: task.receipt.status === "done" ? `已完成：${task.title}` : task.title,
      body: task.receipt.summary,
      at: task.receipt.at,
      priority: task.receipt.status === "failed" ? "high" : "low",
      taskId: task.id,
      sources: task.sources,
      receipt: task.receipt,
    });
  }

  events.sort(
    (a, b) =>
      b.at - a.at ||
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  return events
    .filter((event) => {
      if (seen.has(event.dedupe)) return false;
      seen.add(event.dedupe);
      return true;
    })
    .map(({ dedupe: _, ...event }) => event);
}

/** 从现有事实源构建只读投影；不读取文件、不写状态，方便测试和后续替换事实源。 */
export function buildTaskProjection(input: TaskProjectionInput, options: TaskProjectionOptions = {}): Projection {
  const now = options.now ?? Date.now();
  const day = options.day ?? dayFor(now);
  const limits = { ...DEFAULT_PROJECTION_LIMITS, ...options.limits };
  const drafts = projectDrafts(input.approvals)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, limits.drafts);
  const allTasks = projectTasks(input, now);
  const tasks = allTasks.slice(0, limits.tasks);
  const dayThread = projectDayThread(input, allTasks, drafts, now, day).slice(0, limits.events);
  return {
    personalTasks: tasks,
    draftCards: drafts,
    dayThread,
    projectionVersion: TASK_PROJECTION_VERSION,
    snapshotAt: now,
  };
}
