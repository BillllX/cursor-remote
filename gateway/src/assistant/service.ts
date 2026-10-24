import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SDKCustomTool } from "@cursor/sdk";
import type {
  AssistantOp,
  AssistantState,
  DeviceApproval,
  DeviceOp,
  DeviceResult,
  JSONValue,
  ServerMessage,
} from "../../../shared/protocol.ts";
import { BACKGROUND_MODEL, modelAvailable, runBackground } from "./background.ts";
import { dropChatFromIndex, indexTurn, scrubChatIndex } from "./chatIndex.ts";
import { describeLocal } from "./cron.ts";
import { listApprovals, recoverApprovals, type PendingApproval } from "./approvals.ts";
import { listDelegations, recoverDelegations, type Delegation } from "./delegations.ts";
import { executeSchedule, latestBrief, runEpisodes, runIntegrator, runMaintenance, type JobRunner } from "./jobs.ts";
import { listInbox, markInboxRead, onInbox, postInbox, PUSH_KINDS } from "./inbox.ts";
import {
  CORE_FIELDS,
  CORE_TOKEN_BUDGET,
  editMemory,
  forgetMemory,
  invalidateMemory,
  listMemory,
  markChatDeleted,
  purgeAll,
  purgeMemory,
  readCore,
  readSettings,
  renderMemoryBlock,
  restoreMemory,
  saveMemory,
  sensitiveLabels,
  setCore,
  writeSettings,
  type CoreField,
  type MemoryEntry,
} from "./memory.ts";
import { addSubscription, listApnsSubscriptions, listSubscriptions, removeSubscription, retryFailedPushes, sendPush, subscribeApnsDevice, unsubscribeApnsDevice, vapidKeys, type PushSubscription } from "./push.ts";
import { apnsReady, sendApns, type BadgeParts } from "./apns.ts";
import { assistantBadgeCached, BADGE_WAIT_MS, STATE_INBOX_LIMIT, within } from "./badge.ts";
import { listRuns, recoverRuns } from "./runs.ts";
import { DEFAULT_TZ, listSchedules, recoverSchedules, removeSchedule, seedDefaults, setSchedule, tickSchedules, type ScheduleKind } from "./schedules.ts";
import { assistantDir, estimateTokens, writeJson, type TenantRef } from "./store.ts";
import { addTodo, listTodos, removeTodo, setTodoDone, takeDueReminders, updateTodo } from "./todos.ts";
import { buildIcs, calendarInfo, findByToken, noteFetch, setCalendar } from "./calendar.ts";
import { buildTaskProjection } from "./taskProjection.ts";
import { buildArtifactProjection } from "./artifactProjection.ts";
import { assistantTools, workspaceSessionTools, type ToolHost, type ToolRole } from "./tools.ts";
import { assistantNameFor } from "./name.ts";
import { errText, log } from "../log.ts";
import { workspaceUnread } from "../workspace/agents.ts";
import { getTenant } from "../tenants.ts";
import { migrateMemory } from "./migrate.ts";
import {
  answerCard,
  cancelFlush,
  dropWorkspaceThread,
  expireCards,
  flushChat,
  memoryNeedsConfirm,
  markWorkspaceMemoryUsed,
  noteWorkspaceThread,
  proposeWorkspaceMemory,
  readWorkspaceMemory,
  restoreCards,
  scheduleFlush,
  searchWorkspaceMemory,
  scrubWorkspaceIndex,
  workspaceContext,
} from "./workspaceMemory.ts";
import { memoryCenterActivity } from "./memoryCenterActivity.ts";
import { memoryCenterGet, memoryCenterSearch } from "./memoryCenter.ts";
import { memoryCenterMutate, parseMemoryCenterMutateArgs } from "./memoryCenterMutate.ts";
import { memoryCenterRestore } from "./memoryCenterRestore.ts";
import { memoryCenterExport } from "./memoryCenterExport.ts";
import { memoryCenterImportPreview } from "./memoryCenterImportPreview.ts";
import { memoryCenterImportApply } from "./memoryCenterImportApply.ts";
import { memoryCenterImportRollback } from "./memoryCenterImportRollback.ts";
import { recoverPendingMemoryCenterImports } from "./memoryCenterImportRecover.ts";
import { sweepExpiredPlans } from "./memoryCenterImportPlanStore.ts";
import {
  memoryCenterSuggestionAnswer,
  memoryCenterSuggestionsGet,
  maybeRunDailySuggestionScan,
} from "./memoryCenterSuggestions.ts";

export type AssistantTenant = TenantRef & { name: string; workspaceRoot: string };

export type DelegateRequest = {
  tenant: AssistantTenant;
  workspace: string;
  task: string;
  title?: string;
  parentChatId?: string;
  background: boolean;
};

export type CreateWorkspaceRequest = {
  tenant: AssistantTenant;
  name: string;
  reason: string;
  parentChatId?: string;
};

export type AssistantDeps = {
  tenants: () => AssistantTenant[];
  publish: (tenantId: string, message: ServerMessage) => void;
  globalStateDir: string;
  delegate: (req: DelegateRequest) => Promise<string>;
  workspaces: (tenant: AssistantTenant) => string[];
  createWorkspace: (req: CreateWorkspaceRequest) => Promise<string>;
  /** 推送点开后跳转的页面地址前缀，如 https://host/cursor-remote/ */
  appUrl: () => string;
  /** 该租户聊天（IM）未读合计：APNs 角标分量的 IM 部分 */
  imBadge?: (tenantId: string) => Promise<number>;
  deviceInvoke?: (
    tenant: AssistantTenant,
    input: {
      op: DeviceOp;
      params: JSONValue;
      actor: string;
      idempotencyKey?: string;
      approval?: DeviceApproval;
    },
  ) => Promise<DeviceResult>;
};

let deps: AssistantDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastSlowTick = 0;

const refOf = (tenant: AssistantTenant): TenantRef => ({ id: tenant.id, stateDir: tenant.stateDir });

function vapid() {
  return vapidKeys(deps!.globalStateDir);
}

export function assistantName(tenant: AssistantTenant) {
  return assistantNameFor(tenant.workspaceRoot);
}

function tenantById(id: string) {
  return deps?.tenants().find((tenant) => tenant.id === id);
}

function delegationStatusText(ref: TenantRef, id?: string) {
  const rows = listDelegations(ref, 10).filter((row) => !id || row.id === id || row.childChatId === id);
  if (!rows.length) return id ? `没有这个委派：${id}` : "还没有委派。";
  return JSON.stringify(
    rows.map((row) => ({ id: row.id, workspace: row.workspace, title: row.title, status: row.status, result: row.result })),
  );
}

function toolHost(tenant: AssistantTenant, role: ToolRole, chatId?: string): ToolHost {
  const ref = refOf(tenant);
  return {
    ref,
    role,
    chatId,
    onMemoryWritten: (entry: MemoryEntry) => deps?.publish(tenant.id, { type: "memory_written", chatId, entry }),
    onChanged: () => publishState(tenant),
    delegate:
      role === "chat" || role === "schedule"
        ? (args) => deps!.delegate({ tenant, ...args, parentChatId: chatId, background: role === "schedule" })
        : undefined,
    createWorkspace:
      role === "chat" && chatId
        ? (args) => deps!.createWorkspace({ tenant, ...args, parentChatId: chatId })
        : undefined,
    delegationStatus: (id) => delegationStatusText(ref, id),
    workspaces: () => deps?.workspaces(tenant) ?? [],
    workspaceMemory: role === "chat" ? (workspace, query) => readWorkspaceMemory(tenant, workspace, query) : undefined,
    deviceInvoke:
      role === "chat" && deps?.deviceInvoke
        ? async (input) => {
            try {
              return await deps!.deviceInvoke!(tenant, {
                ...input,
                actor: chatId ? `chat:${chatId}` : "chat",
              });
            } catch (err) {
              const code =
                err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "error";
              if (code === "no_device") {
                postInbox(ref, {
                  kind: "info",
                  title: "Apple 设备未连接",
                  body: "打开并连接 iPhone 或 iPad 后，再试一次日历、提醒事项或通讯录操作。",
                  key: `device:no-device:${chatId ?? "assistant"}`,
                  chatId,
                });
                return { status: "no_device", error: "没有在线且已授权的 Apple 设备。" };
              }
              return { status: code, error: err instanceof Error ? err.message : "设备操作失败。" };
            }
          }
        : undefined,
  };
}

/** 子工作区会话（含委派子会话）挂的工具：提议、检索，以及真正采用检索结果后的续期 */
export function workspaceToolsFor(tenant: AssistantTenant, chatId: string, cwd: string): Record<string, SDKCustomTool> {
  return workspaceSessionTools({
    propose: (args) => proposeWorkspaceMemory(tenant, { chatId, cwd, ...args }, { confirm: memoryNeedsConfirm() }),
    search: ({ query }) => searchWorkspaceMemory(tenant, cwd, query),
    markUsed: ({ id }) => markWorkspaceMemoryUsed(tenant, cwd, id),
  });
}

/** W0 工作偏好 + 从 cwd 往上的各层规则；所有会话都用这一份 */
export function workspaceContextFor(tenant: AssistantTenant, cwd: string, query = "") {
  return workspaceContext(tenant, cwd, query);
}

/** 子工作区会话一轮开始：线程又活跃了，先不出确认卡 */
export function noteWorkspaceTurnStart(tenant: AssistantTenant, chatId: string) {
  cancelFlush(refOf(tenant), chatId);
}

/** 子工作区会话一轮结束：更新线程摘要；攒了提议的话等线程空闲再出确认卡 */
export function noteWorkspaceTurnEnd(
  tenant: AssistantTenant,
  row: { chatId: string; cwd: string; title: string; user: string; assistant: string },
) {
  try {
    noteWorkspaceThread(tenant, row);
  } catch (err) {
    log.error("workspace thread index", err);
  }
  scheduleFlush(refOf(tenant), row.chatId, () => void publishState(tenant));
}

/** 委派结束：子会话不会再有新回合，攒的提议马上出卡 */
export function flushWorkspaceProposals(tenant: AssistantTenant, chatId: string) {
  const ref = refOf(tenant);
  cancelFlush(ref, chatId);
  if (flushChat(ref, chatId)) void publishState(tenant);
}

/** 作答工作区记忆 / 工作偏好确认卡；不是这类卡返回 null */
export function answerMemoryCard(tenant: AssistantTenant, chatId: string, callId: string, allow: boolean) {
  const result = answerCard(tenant, chatId, callId, allow);
  if (result) void publishState(tenant);
  return result;
}

/** USER 前台会话挂的助理工具（SDK customTools） */
export function foregroundTools(tenant: AssistantTenant, chatId: string): Record<string, SDKCustomTool> {
  return assistantTools(toolHost(tenant, "chat", chatId));
}

/** 自研 Agent 路径用的 ToolHost（与 foregroundTools 同一套回调） */
export function chatToolHost(tenant: AssistantTenant, chatId: string): ToolHost {
  return toolHost(tenant, "chat", chatId);
}

/** 用户那边的时钟：时区取客户端系统时区，skew 是客户端时间减网关时间（排队后才跑的轮次也按跑的那一刻算） */
export type ClientClock = { tz: string; skew: number };

export function parseClientClock(raw: unknown, now = Date.now()): ClientClock | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { tz, now: at } = raw as { tz?: unknown; now?: unknown };
  if (typeof tz !== "string" || !tz || tz.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return undefined;
  }
  // 客户端时钟差太多（比如手动改过时间）就不信它的钟，只用它的时区
  const skew = typeof at === "number" && Number.isFinite(at) && Math.abs(at - now) < 86_400_000 ? at - now : 0;
  return { tz, skew };
}

/**
 * 每轮放进用户消息（不放 system，免得每轮都让提示缓存失效）。
 * 模型不知道现在几点，换算“明天下午三点”“下周三”全靠这一行；没收到客户端时钟就按网关默认时区
 */
export function clockLine(clock?: ClientClock, now = Date.now()) {
  const tz = clock?.tz || DEFAULT_TZ;
  const at = new Date(now + (clock?.skew ?? 0));
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const offset = get("timeZoneName").replace(/^GMT/, "") || "+00:00";
  const utc = offset === "+00:00" || offset === "" ? "UTC" : `UTC${offset}`;
  return `[用户这边现在是 ${get("year")}-${get("month")}-${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")}，时区 ${tz}（${utc}）。记待办、设提醒按这个时区换算；带钟点的 due 写成 ${offset === "+00:00" ? "Z" : offset} 结尾，定时任务的 tz 填 ${tz}。]`;
}

/** USER 会话每轮前置：名字 + 记忆数据块。子工作区会话不调用 */
export function userRootPreamble(tenant: AssistantTenant) {
  const name = assistantName(tenant);
  const block = renderMemoryBlock(refOf(tenant));
  return [
    `你是用户的个人助理，名字是「${name}」。这里是${name}的工作区（用户根目录）。`,
    "你有一组助理工具：memory_*（个人记忆）、work_preference_*（工作偏好）、chat_search（历史会话）、workspace_memory_read（只读查看子工作区的约定和进展）、todo_*（待办）、schedule_*（定时任务和提醒）、calendar_*（Apple 日历）、reminders_*（Apple 提醒事项）、contacts_search（Apple 通讯录）、inbox_post（收件箱）、delegate（交给子工作区去做）、create_workspace（新建子工作区，需用户确认）。Apple 写操作必须等 iOS 屏幕确认，设备未回成功前不得声称完成。",
    "用户亲口定下对所有项目都适用的工作习惯（如“以后都用中文回复”）时用 work_preference_add；只关于某个项目的约定不要记进个人记忆，委派时让子会话自己提议写进工作区记忆。",
    "用户让你在某个项目里干活时，不要自己改文件：用 delegate 交给对应的子工作区，并用 delegation_status 跟进。同一个工作区一次只能有一项委派。",
    "没有合适的工作区时，先用 create_workspace 申请新建（会弹确认卡问用户，被拒绝就不要再建），建好了再 delegate。",
    "委派完成后用一两句话告诉用户结果；做不了或失败了就说清原因，不要假装完成。",
    "用户说“记住…”时调用 memory_save（basis=user_said）。用户说“提醒我…”时用 schedule_set 或带时间的 todo_add。",
    [
      "对话里出现能落到确切日期的、用户自己要做的事（“下周三交报告”“明天下午三点和老王开会”），不用问，直接 todo_add：text 写成一句话的事，due 按用户消息开头那行的时间和时区换算成具体日期（有钟点就写带时区偏移的时间），quote 填用户原话。",
      "记下后在回复里一句话带过，如“记下了：周三 交报告”，不要另起话题。返回 duplicate=true 就别再说一遍。",
      "别人的事、已经过去的事、只是闲聊提到的日期、说不准哪天的（“改天”“过阵子”）都不记。用户说记错了，用 todo_update 改或 todo_done 划掉。",
    ].join(""),
    block,
  ]
    .filter(Boolean)
    .join("\n");
}

function runnerFor(tenant: AssistantTenant): JobRunner {
  return ({ role, label, prompt, origin }) =>
    runBackground(refOf(tenant), {
      origin,
      label,
      cwd: tenant.workspaceRoot,
      prompt,
      customTools: assistantTools(toolHost(tenant, role)),
      inboxOnFailure: origin !== "integrator",
    });
}

/** Loop 没人在线时走后台策略：只读工具 + inbox_post，模型固定 grok-4.7 */
export async function runLoopInBackground(tenant: AssistantTenant, input: { chatId: string; cwd: string; text: string; label: string }) {
  const context = workspaceContext(tenant, input.cwd, input.text);
  return runBackground(refOf(tenant), {
    origin: "loop",
    label: input.label,
    cwd: input.cwd,
    chatId: input.chatId,
    prompt: context ? `工作区规则（照着做）：\n${context}\n\n${input.text}` : input.text,
    customTools: assistantTools(toolHost(tenant, "loop", input.chatId)),
  });
}

/** 后台委派：子工作区里只读分析，产出改动方案；没有记忆工具 */
export async function runDelegateInBackground(tenant: AssistantTenant, input: { chatId: string; cwd: string; task: string; label: string }) {
  const context = workspaceContext(tenant, input.cwd, input.task);
  return runBackground(refOf(tenant), {
    origin: "delegate",
    label: input.label,
    cwd: input.cwd,
    chatId: input.chatId,
    prompt: `${context ? `工作区规则（照着做）：\n${context}\n\n` : ""}${input.task}\n\n这是后台委派：只能读和分析。需要改动时写出具体的改动方案（文件、改什么、为什么），作为最终回复。需要查完整工作区记忆时用 workspace_memory_search；只有确实采用结果时才用 workspace_memory_mark_used。读代码时发现以后还用得上的约定、命令、坑，可以用 workspace_memory_propose 提议。`,
    customTools: { ...assistantTools(toolHost(tenant, "loop", input.chatId)), ...workspaceToolsFor(tenant, input.chatId, input.cwd) },
  });
}

export function noteUserTurn(tenant: AssistantTenant, row: { chatId: string; turn: number; title: string; user: string; assistant: string }) {
  if (!row.user.trim()) return;
  indexTurn(refOf(tenant), row);
}

export function noteChatDeleted(tenant: AssistantTenant, chatId: string) {
  const ref = refOf(tenant);
  if (!existsSync(assistantDir(ref))) return;
  dropChatFromIndex(ref, chatId);
  dropWorkspaceThread(ref, chatId);
  cancelFlush(ref, chatId);
  markChatDeleted(ref, chatId);
}

export async function buildState(tenant: AssistantTenant, opts: { memory?: boolean } = {}): Promise<AssistantState> {
  const ref = refOf(tenant);
  const model = await modelAvailable().catch(() => ({ ok: false, reason: "模型目录读取失败" }));
  const snapshotAt = Date.now();
  const day = describeLocal(snapshotAt, DEFAULT_TZ).slice(0, 10);
  const inbox = listInbox(ref, STATE_INBOX_LIMIT);
  const todos = listTodos(ref, { includeDone: true });
  const schedules = listSchedules(ref);
  const delegations = listDelegations(ref, 20);
  const approvals = listApprovals(ref);
  const runs = listRuns(ref, 20);
  const brief = latestBrief(ref, day);
  const artifacts = buildArtifactProjection({
    chats: getTenant(tenant.id)?.disk.chats ?? [],
    delegations: listDelegations(ref, 200),
    inbox: listInbox(ref, 300),
  });
  const projection = buildTaskProjection(
    { inbox, todos, schedules, delegations, approvals, runs, brief },
    { now: snapshotAt, day },
  );
  const state: AssistantState = {
    name: assistantName(tenant),
    background: { model: BACKGROUND_MODEL, ok: model.ok, reason: model.reason },
    pushKey: vapid().publicKey,
    pushApns: apnsReady(),
    inbox,
    todos,
    schedules,
    delegations,
    approvals,
    runs,
    brief,
    artifacts,
    calendar: calendarInfo(ref),
    ...projection,
  };
  if (opts.memory) {
    const memory = listMemory(ref);
    const core = readCore(ref);
    state.memory = {
      rev: memory.rev,
      core,
      entries: memory.entries,
      settings: readSettings(ref),
      sensitive: sensitiveLabels(),
      coreTokens: estimateTokens(CORE_FIELDS.map((key) => core.fields[key]).join("\n")),
      coreBudget: CORE_TOKEN_BUDGET,
    };
  }
  return state;
}

const memoryWatchers = new Set<string>();

/** 日历来拉订阅：口令对上就返回 .ics。第一次被拉时推一次状态，App 立刻显示「已订阅」 */
export function calendarFeed(tenants: AssistantTenant[], token: string): string | null {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const tenant = findByToken(tenants, token);
  if (!tenant) return null;
  const ref = refOf(tenant);
  if (noteFetch(ref)) void publishState(tenant);
  return buildIcs(ref, assistantName(tenant));
}

export async function publishState(tenant: AssistantTenant) {
  if (!deps) return;
  const state = await buildState(tenant, { memory: memoryWatchers.has(tenant.id) });
  deps.publish(tenant.id, { type: "assistant_state", state });
}

/** 委派状态变化：先发单条 delegation_state，再推整份状态让列表和角标对齐 */
export function publishDelegation(tenant: AssistantTenant, delegation: Delegation, approval?: PendingApproval) {
  deps?.publish(tenant.id, { type: "delegation_state", delegation, approval });
  void publishState(tenant);
}

/** 客户端打开过记忆页后，状态推送带上记忆全量 */
export function watchMemory(tenantId: string, on: boolean) {
  if (on) memoryWatchers.add(tenantId);
}

export function onTenantHello(tenant: AssistantTenant) {
  seedDefaults(refOf(tenant));
  runMigration(tenant);
}

function runMigration(tenant: AssistantTenant) {
  try {
    const report = migrateMemory(tenant);
    if (report) log.info(`memory migrate v2 tenant=${tenant.id} ${JSON.stringify(report)}`);
  } catch (err) {
    log.error("memory migrate", tenant.id, err);
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export async function handleOp(
  tenant: AssistantTenant,
  op: AssistantOp,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const ref = refOf(tenant);
  const fail = (error: string) => ({ ok: false, error });
  switch (op) {
    case "inbox_read": {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : "all";
      return { ok: true, data: { changed: markInboxRead(ref, ids) } };
    }
    case "todo_add": {
      const result = addTodo(ref, { text: str(args.text), due: str(args.due) || undefined, source: "user" });
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
    case "todo_update": {
      const result = updateTodo(ref, str(args.id), {
        text: typeof args.text === "string" ? args.text : undefined,
        due: typeof args.due === "string" ? args.due : undefined,
      });
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
    case "calendar_set":
      return {
        ok: true,
        data: setCalendar(ref, {
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
          rotate: args.rotate === true,
        }),
      };
    case "todo_done":
    case "todo_undo": {
      const result = setTodoDone(ref, str(args.id), op === "todo_done");
      return result.ok ? { ok: true } : fail(result.error);
    }
    case "todo_remove":
      return removeTodo(ref, str(args.id)) ? { ok: true } : fail("没有这条待办。");
    case "schedule_set": {
      const result = setSchedule(ref, {
        id: str(args.id) || undefined,
        title: str(args.title) || undefined,
        kind: (str(args.kind) || undefined) as ScheduleKind | undefined,
        cron: str(args.cron) || undefined,
        tz: str(args.tz) || undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
        misfire: args.misfire === "skip" ? "skip" : args.misfire === "runOnce" ? "runOnce" : undefined,
      });
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
    case "schedule_remove":
      return removeSchedule(ref, str(args.id)) ? { ok: true } : fail("没有这个日程。");
    case "memory_save": {
      const result = saveMemory(
        ref,
        { topic: str(args.topic), text: str(args.text), kind: str(args.kind) || undefined, basis: "user_said", validUntil: str(args.validUntil) || undefined },
        "page",
      );
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
    case "memory_edit": {
      const patch: Record<string, string> = {};
      for (const key of ["topic", "text", "kind", "validFrom", "validUntil"]) if (typeof args[key] === "string") patch[key] = args[key] as string;
      const result = editMemory(ref, str(args.id), typeof args.rev === "number" ? args.rev : -1, patch);
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
    case "memory_invalidate": {
      const result = invalidateMemory(ref, str(args.id), str(args.reason) || "在记忆页标失效", "page");
      return result.ok ? { ok: true } : fail(result.error);
    }
    case "memory_restore": {
      const result = restoreMemory(ref, str(args.id));
      return result.ok ? { ok: true } : fail(result.error);
    }
    case "memory_forget": {
      const result = forgetMemory(ref, str(args.id), "page");
      return result.ok ? { ok: true } : fail(result.error);
    }
    case "memory_purge": {
      const result = purgeMemory(ref, str(args.id), { scrubChatIndex: (needles) => scrubChatIndex(ref, needles) + scrubWorkspaceIndex(ref, needles) });
      return result.ok ? { ok: true, data: { scrubbed: result.value.scrubbed, sourceChatId: result.value.sourceChatId } } : fail(result.error);
    }
    case "memory_purge_all": {
      if (args.confirm !== true) return fail("要带 confirm: true。");
      const count = purgeAll(ref, { scrubChatIndex: (needles) => scrubChatIndex(ref, needles) + scrubWorkspaceIndex(ref, needles) });
      return { ok: true, data: { count } };
    }
    case "memory_core": {
      const fields: Partial<Record<CoreField, string>> = {};
      const raw = (args.fields && typeof args.fields === "object" ? args.fields : {}) as Record<string, unknown>;
      for (const key of CORE_FIELDS) if (typeof raw[key] === "string") fields[key] = raw[key] as string;
      const result = setCore(ref, fields, "page", typeof args.rev === "number" ? args.rev : undefined);
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
    case "memory_settings": {
      const next: Parameters<typeof writeSettings>[1] = {};
      if (typeof args.paused === "boolean") next.paused = args.paused;
      if (args.allowSensitive && typeof args.allowSensitive === "object") {
        const allow: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(args.allowSensitive as Record<string, unknown>)) {
          if (key in sensitiveLabels() && typeof value === "boolean") allow[key] = value;
        }
        next.allowSensitive = allow;
      }
      return { ok: true, data: writeSettings(ref, next) };
    }
    case "memory_export": {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = resolve(tenant.workspaceRoot, ".jiebo", "memory-export", `memory-${stamp}.json`);
      writeJson(file, { exportedAt: new Date().toISOString(), note: "只读快照。权威数据在网关，这里改了不会生效。", core: readCore(ref), entries: listMemory(ref).entries });
      return { ok: true, data: { path: `.jiebo/memory-export/memory-${stamp}.json` } };
    }
    case "memory_center_get": {
      const scope = typeof args.scope === "string" ? args.scope : undefined;
      const workspaces = deps?.workspaces(tenant) ?? [];
      return { ok: true, data: memoryCenterGet(tenant, workspaces, scope) };
    }
    case "memory_center_search": {
      const query = str(args.query);
      const scope = typeof args.scope === "string" ? args.scope : undefined;
      const kind = typeof args.kind === "string" ? args.kind : undefined;
      const state = typeof args.state === "string" ? args.state : undefined;
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterSearch(tenant, workspaces, { query, scope, kind, state });
      return result.ok ? { ok: true, data: result.data } : fail(result.error);
    }
    case "memory_center_mutate": {
      try {
        const parsed = parseMemoryCenterMutateArgs(args);
        if (!parsed.ok) {
          return { ok: false, error: parsed.message, data: { code: parsed.code } };
        }
        const workspaces = deps?.workspaces(tenant) ?? [];
        const result = memoryCenterMutate(tenant, workspaces, parsed.value);
        if (!result.ok) {
          return { ok: false, error: result.message, data: { code: result.code, detail: result.detail } };
        }
        return { ok: true, data: result.data };
      } catch (err) {
        log.error("memory_center_mutate", errText(err));
        return { ok: false, error: "记忆写入失败。", data: { code: "write_failed" } };
      }
    }
    case "memory_center_activity": {
      const workspaces = deps?.workspaces(tenant) ?? [];
      const scope = typeof args.scope === "string" ? args.scope : undefined;
      const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const actionRaw = typeof args.action === "string" ? args.action : undefined;
      const action =
        actionRaw === "create" ||
        actionRaw === "update" ||
        actionRaw === "set_state" ||
        actionRaw === "set_pinned" ||
        actionRaw === "delete" ||
        actionRaw === "restore" ||
        actionRaw === "import"
          ? actionRaw
          : undefined;
      return {
        ok: true,
        data: memoryCenterActivity(tenant, workspaces, { scope, cursor, limit, action }),
      };
    }
    case "memory_center_restore": {
      const scope = str(args.scope);
      const auditId = str(args.auditId);
      if (!scope || !auditId) return fail("scope 与 auditId 必填。");
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterRestore(tenant, workspaces, { scope, auditId });
      if (!result.ok) {
        return { ok: false, error: result.message, data: { code: result.code, detail: result.detail } };
      }
      return { ok: true, data: result.data };
    }
    case "memory_center_suggestions_get": {
      const scope = typeof args.scope === "string" ? args.scope : undefined;
      return { ok: true, data: memoryCenterSuggestionsGet(refOf(tenant), scope) };
    }
    case "memory_center_suggestion_answer": {
      const scope = str(args.scope);
      const id = str(args.id);
      const accept = args.accept === true;
      if (!scope || !id) return fail("scope 与 id 必填。");
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterSuggestionAnswer(tenant, workspaces, refOf(tenant), { scope, id, accept });
      if (!result.ok) {
        return { ok: false, error: result.message, data: { code: result.code, detail: result.detail } };
      }
      return { ok: true, data: result.data };
    }
    case "memory_center_export": {
      const scopes = Array.isArray(args.scopes)
        ? args.scopes.filter((s): s is string => typeof s === "string")
        : undefined;
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterExport(tenant, workspaces, scopes);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, data: { code: result.code } };
    }
    case "memory_center_import_preview": {
      const path = str(args.path);
      if (!path) return fail("path 必填。");
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterImportPreview(tenant, workspaces, path);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, data: { code: result.code } };
    }
    case "memory_center_import_apply": {
      const planId = str(args.planId);
      if (!planId) return fail("planId 必填。");
      const resolutionsRaw = Array.isArray(args.resolutions) ? args.resolutions : [];
      const resolutions: { changeId: string; resolution: "keep_current" | "use_snapshot" | "duplicate" }[] = [];
      for (const row of resolutionsRaw) {
        if (!row || typeof row !== "object") continue;
        const changeId = str((row as Record<string, unknown>).changeId);
        const resolution = str((row as Record<string, unknown>).resolution);
        if (!changeId || !resolution) continue;
        if (resolution !== "keep_current" && resolution !== "use_snapshot" && resolution !== "duplicate") continue;
        resolutions.push({ changeId, resolution });
      }
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterImportApply(tenant, workspaces, planId, resolutions);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, data: { code: result.code } };
    }
    case "memory_center_import_rollback": {
      const importId = str(args.importId);
      if (!importId) return fail("importId 必填。");
      const workspaces = deps?.workspaces(tenant) ?? [];
      const result = memoryCenterImportRollback(tenant, workspaces, importId);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, data: { code: result.code } };
    }
    case "push_subscribe": {
      if (args.kind === "apns") {
        // 写本租户 + 从其他租户摘掉都做完才回成功（按 token 串行）
        const refs = (deps?.tenants() ?? []).map(refOf);
        const input = {
          token: args.token,
          bundleId: args.bundleId,
          environment: args.environment,
          ua: args.ua,
          im: args.im,
          imGroup: args.imGroup,
          assistant: args.assistant,
          workspace: args.workspace,
        };
        const result = await subscribeApnsDevice(ref, input, refs);
        if (!result.ok) return fail(result.error);
        if (result.released.length) log.info(`apns token 转绑到 ${tenant.id}，已从 ${result.released.join("、")} 摘掉`);
        return { ok: true, data: { count: result.count, ready: apnsReady() } };
      }
      if (args.kind !== undefined && args.kind !== "web") return fail("kind 只能是 web 或 apns。");
      const result = addSubscription(ref, args.subscription as PushSubscription);
      return result.ok ? { ok: true, data: { count: result.count } } : fail(result.error);
    }
    case "push_unsubscribe":
      if (args.kind === "apns") return { ok: true, data: { removed: await unsubscribeApnsDevice(ref, str(args.token)) } };
      return { ok: true, data: { removed: removeSubscription(ref, str(args.endpoint)) } };
    case "push_test": {
      const { item } = postInbox(ref, { kind: "reminder", title: "测试通知", body: "这是一条测试通知，看到就说明推送通了。" });
      // 走 onInbox → pushItem，Web 和 APNs 各发一遍；这里只回报有多少订阅会收到
      return { ok: true, data: { itemId: item.id, web: listSubscriptions(ref).length, apns: apnsReady() ? listApnsSubscriptions(ref).length : 0 } };
    }
    default:
      return fail(`不认识的操作：${String(op)}`);
  }
}

async function pushItem(tenant: AssistantTenant, item: { id: string; kind: string; title: string; chatId?: string; delegationId?: string }) {
  const titles: Record<string, string> = {
    approval: "有一项待你批准",
    delegation: "委派有结果了",
    reminder: "提醒",
    brief: "今日简报",
  };
  const base = deps?.appUrl() || "";
  const ref = refOf(tenant);
  const label = titles[item.kind] ?? "助理";
  // 推送正文不带记忆或收件箱正文：只有类型、条目标题和 id
  await Promise.all([
    sendPush(ref, vapid(), {
      itemId: item.id,
      kind: item.kind,
      title: `${label}：${item.title}`.slice(0, 80),
      url: `${base}?inbox=${encodeURIComponent(item.id)}`,
    }).catch((err) => log.error("push", err)),
    pushBadge(tenant)
      .then((badgeParts) =>
        sendApns(ref, {
          itemId: item.id,
          kind: item.kind,
          title: label,
          body: item.title.slice(0, 80),
          chatId: item.chatId,
          delegationId: item.delegationId,
          badgeParts,
        }),
      )
      .catch((err) => log.error("apns", err)),
  ]);
}

/** APNs 角标分部：助理待处理数 + 聊天未读合计（和 IM 推送带的是同一份）。
 *  设备按自己订阅的类别合计（见 apns.ts 的 apnsBadgeFor）：只订阅聊天的 iPad 不算助理待处理，
 *  因为助理变化不会推给它。哪个分量超时拿不到就是 undefined——助理那份有短缓存顶着（badge.ts） */
export async function pushBadge(tenant: AssistantTenant): Promise<BadgeParts> {
  const imBadge = deps?.imBadge;
  const fullTenant = getTenant(tenant.id);
  return {
    assistant: await assistantBadgeCached(refOf(tenant)),
    im: imBadge ? await within(imBadge(tenant.id).catch(() => undefined), BADGE_WAIT_MS) : undefined,
    workspace: fullTenant ? workspaceUnread(fullTenant) : undefined,
  };
}

async function slowTick(tenant: AssistantTenant) {
  const runner = runnerFor(tenant);
  const ref = refOf(tenant);
  try {
    if (expireCards(ref)) void publishState(tenant);
  } catch (err) {
    log.error("expire memory cards", err);
  }
  await runMaintenance(ref, runner).catch((err) => log.error("maintenance", err));
  await runEpisodes(ref, runner).catch((err) => log.error("episodes", err));
  await runIntegrator(ref, runner).catch((err) => log.error("integrator", err));
  try {
    const workspaces = deps?.workspaces(tenant) ?? [];
    maybeRunDailySuggestionScan(tenant, workspaces, ref);
  } catch (err) {
    log.error("memory center suggestions", err);
  }
}

function tick() {
  if (!deps) return;
  const now = Date.now();
  const slow = now - lastSlowTick > 10 * 60_000;
  if (slow) lastSlowTick = now;
  for (const tenant of deps.tenants()) {
    const ref = refOf(tenant);
    if (!existsSync(assistantDir(ref))) continue;
    for (const todo of takeDueReminders(ref, now)) {
      postInbox(ref, { kind: "reminder", title: todo.text, body: `待办到点了${todo.due ? `（${todo.due}）` : ""}。`, key: `todo:${todo.id}` });
    }
    const runner = runnerFor(tenant);
    tickSchedules(ref, (r, schedule, occ) => executeSchedule(r, schedule, occ, runner), now);
    if (slow) void slowTick(tenant);
  }
}

export function startAssistant(next: AssistantDeps) {
  deps = next;
  onInbox((ref, item) => {
    const tenant = tenantById(ref.id);
    if (!tenant) return;
    deps?.publish(ref.id, { type: "inbox_item", item });
    void publishState(tenant);
    if (PUSH_KINDS.includes(item.kind) || item.actionPrompt) void pushItem(tenant, item);
  });
  for (const tenant of next.tenants()) {
    const ref = refOf(tenant);
    if (!existsSync(assistantDir(ref))) continue;
    recoverRuns(ref);
    recoverSchedules(ref);
    // 挂起审批跟着运行一起丢了；对应的委派下面会记为中断并进收件箱
    recoverApprovals(ref);
    runMigration(tenant);
    try {
      const workspaces = next.workspaces(tenant);
      recoverPendingMemoryCenterImports(ref, tenant, workspaces);
      sweepExpiredPlans(ref);
    } catch (err) {
      log.error("recover memory import journals", err);
    }
    // 记忆确认卡不挂在运行上，重启后挂回去
    try {
      restoreCards(ref);
    } catch (err) {
      log.error("restore memory cards", err);
    }
    for (const item of recoverDelegations(ref)) {
      postInbox(ref, {
        kind: "delegation",
        title: `委派被中断：${item.title}`,
        body: "网关重启时这个委派还没完成，可以到子会话里继续。",
        key: `interrupted:${item.id}`,
        delegationId: item.id,
        chatId: item.childChatId,
      });
    }
    void retryFailedPushes(ref, vapid()).catch((err) => log.warn("启动时重试失败推送出错", tenant.id, errText(err)));
  }
  // 首轮慢任务等启动稳定后再跑
  lastSlowTick = Date.now() - 9 * 60_000;
  timer = setInterval(tick, 30_000);
  timer.unref?.();
}

export function stopAssistant() {
  if (timer) clearInterval(timer);
  timer = null;
}