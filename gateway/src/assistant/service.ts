import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SDKCustomTool } from "@cursor/sdk";
import type { AssistantOp, AssistantState, ServerMessage } from "../../../shared/protocol.ts";
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
import { addApnsSubscription, addSubscription, listApnsSubscriptions, listSubscriptions, removeApnsSubscription, removeSubscription, retryFailedPushes, sendPush, vapidKeys, type PushSubscription } from "./push.ts";
import { apnsReady, sendApns } from "./apns.ts";
import { listRuns, recoverRuns } from "./runs.ts";
import { DEFAULT_TZ, listSchedules, recoverSchedules, removeSchedule, seedDefaults, setSchedule, tickSchedules, type ScheduleKind } from "./schedules.ts";
import { assistantDir, estimateTokens, writeJson, assistantPath, type TenantRef } from "./store.ts";
import { addTodo, listTodos, removeTodo, setTodoDone, takeDueReminders } from "./todos.ts";
import { assistantTools, workspaceSessionTools, type ToolHost, type ToolRole } from "./tools.ts";
import { assistantNameFor } from "./name.ts";
import { migrateMemory } from "./migrate.ts";
import {
  answerCard,
  cancelFlush,
  dropWorkspaceThread,
  expireCards,
  flushChat,
  noteWorkspaceThread,
  proposeWorkspaceMemory,
  readWorkspaceMemory,
  restoreCards,
  scheduleFlush,
  scrubWorkspaceIndex,
  workspaceContext,
} from "./workspaceMemory.ts";

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
  };
}

/** 子工作区会话（含委派子会话）挂的工具：只能提议写工作区记忆 */
export function workspaceToolsFor(tenant: AssistantTenant, chatId: string, cwd: string): Record<string, SDKCustomTool> {
  return workspaceSessionTools({ propose: (args) => proposeWorkspaceMemory(tenant, { chatId, cwd, ...args }) });
}

/** W0 工作偏好 + 从 cwd 往上的各层规则；所有会话都用这一份 */
export function workspaceContextFor(tenant: AssistantTenant, cwd: string) {
  return workspaceContext(tenant, cwd);
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
    console.error("workspace thread index", err);
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

/** USER 会话每轮前置：名字 + 记忆数据块。子工作区会话不调用 */
export function userRootPreamble(tenant: AssistantTenant) {
  const name = assistantName(tenant);
  const block = renderMemoryBlock(refOf(tenant));
  return [
    `你是用户的个人助理，名字是「${name}」。这里是${name}的工作区（用户根目录）。`,
    "你有一组助理工具：memory_*（个人记忆）、work_preference_*（工作偏好）、chat_search（历史会话）、workspace_memory_read（只读查看子工作区的约定和进展）、todo_*（待办）、schedule_*（定时任务和提醒）、inbox_post（收件箱）、delegate（交给子工作区去做）、create_workspace（新建子工作区，需用户确认）。",
    "用户亲口定下对所有项目都适用的工作习惯（如“以后都用中文回复”）时用 work_preference_add；只关于某个项目的约定不要记进个人记忆，委派时让子会话自己提议写进工作区记忆。",
    "用户让你在某个项目里干活时，不要自己改文件：用 delegate 交给对应的子工作区，并用 delegation_status 跟进。同一个工作区一次只能有一项委派。",
    "没有合适的工作区时，先用 create_workspace 申请新建（会弹确认卡问用户，被拒绝就不要再建），建好了再 delegate。",
    "委派完成后用一两句话告诉用户结果；做不了或失败了就说清原因，不要假装完成。",
    "用户说“记住…”时调用 memory_save（basis=user_said）。用户说“提醒我…”时用 schedule_set 或带时间的 todo_add。",
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
  const context = workspaceContext(tenant, input.cwd);
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
  const context = workspaceContext(tenant, input.cwd);
  return runBackground(refOf(tenant), {
    origin: "delegate",
    label: input.label,
    cwd: input.cwd,
    chatId: input.chatId,
    prompt: `${context ? `工作区规则（照着做）：\n${context}\n\n` : ""}${input.task}\n\n这是后台委派：只能读和分析。需要改动时写出具体的改动方案（文件、改什么、为什么），作为最终回复。`,
    customTools: assistantTools(toolHost(tenant, "loop", input.chatId)),
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
  const day = describeLocal(Date.now(), DEFAULT_TZ).slice(0, 10);
  const state: AssistantState = {
    name: assistantName(tenant),
    background: { model: BACKGROUND_MODEL, ok: model.ok, reason: model.reason },
    pushKey: vapid().publicKey,
    pushApns: apnsReady(),
    inbox: listInbox(ref, 60),
    todos: listTodos(ref, { includeDone: true }),
    schedules: listSchedules(ref),
    delegations: listDelegations(ref, 20),
    approvals: listApprovals(ref),
    runs: listRuns(ref, 20),
    brief: latestBrief(ref, day),
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
    if (report) console.log(`memory migrate v2 tenant=${tenant.id} ${JSON.stringify(report)}`);
  } catch (err) {
    console.error("memory migrate", tenant.id, err);
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
      const result = addTodo(ref, { text: str(args.text), due: str(args.due) || undefined });
      return result.ok ? { ok: true, data: result.value } : fail(result.error);
    }
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
    case "push_subscribe": {
      if (args.kind === "apns") {
        const result = addApnsSubscription(ref, { token: args.token, bundleId: args.bundleId, environment: args.environment, ua: args.ua });
        return result.ok ? { ok: true, data: { count: result.count, ready: apnsReady() } } : fail(result.error);
      }
      if (args.kind !== undefined && args.kind !== "web") return fail("kind 只能是 web 或 apns。");
      const result = addSubscription(ref, args.subscription as PushSubscription);
      return result.ok ? { ok: true, data: { count: result.count } } : fail(result.error);
    }
    case "push_unsubscribe":
      if (args.kind === "apns") return { ok: true, data: { removed: removeApnsSubscription(ref, str(args.token)) } };
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
    }).catch((err) => console.error("push", err)),
    sendApns(ref, {
      itemId: item.id,
      kind: item.kind,
      title: label,
      body: item.title.slice(0, 80),
      chatId: item.chatId,
      delegationId: item.delegationId,
    }).catch((err) => console.error("apns", err)),
  ]);
}

async function slowTick(tenant: AssistantTenant) {
  const runner = runnerFor(tenant);
  const ref = refOf(tenant);
  try {
    if (expireCards(ref)) void publishState(tenant);
  } catch (err) {
    console.error("expire memory cards", err);
  }
  await runMaintenance(ref, runner).catch((err) => console.error("maintenance", err));
  await runEpisodes(ref, runner).catch((err) => console.error("episodes", err));
  await runIntegrator(ref, runner).catch((err) => console.error("integrator", err));
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
    if (PUSH_KINDS.includes(item.kind)) void pushItem(tenant, item);
  });
  for (const tenant of next.tenants()) {
    const ref = refOf(tenant);
    if (!existsSync(assistantDir(ref))) continue;
    recoverRuns(ref);
    recoverSchedules(ref);
    // 挂起审批跟着运行一起丢了；对应的委派下面会记为中断并进收件箱
    recoverApprovals(ref);
    runMigration(tenant);
    // 记忆确认卡不挂在运行上，重启后挂回去
    try {
      restoreCards(ref);
    } catch (err) {
      console.error("restore memory cards", err);
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
    void retryFailedPushes(ref, vapid()).catch(() => undefined);
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