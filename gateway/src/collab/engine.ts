import type { CollabRunState, ImAuthor, TurnFile } from "../../../shared/protocol.ts";
import {
  activeDelegationFor,
  createDelegationRecord,
  getDelegation,
  updateDelegation,
} from "../assistant/delegations.ts";
import { log } from "../log.ts";
import { chatIdOf } from "../runtime/chats.ts";
import { globalRunningCount, maxRunning, persistTenant } from "../runtime/slots.ts";
import type { Tenant } from "../tenants.ts";
import { saveDiskNow } from "../tenants.ts";
import { workspaceAgentById } from "../workspace/agents.ts";
import { mergeTurnFiles } from "../delegationFiles.ts";
import type { ImService } from "../im/service.ts";
import type { ImStore, StoredMessage } from "../im/store.ts";
import {
  childChatIdForTask,
  coordinatorChatIdForRun,
  delegationIdForTask,
  runIdForTrigger,
  taskIdForTrigger,
} from "./ids.ts";
import { runHeadless, type HeadlessResult, type RunContext, type RunObserver } from "./headless.ts";
import { readCollabSettings } from "./settings.ts";
import { CollabStore } from "./store.ts";
import type { CollabRun, CollabTask } from "./types.ts";
import type { CollabError } from "../../../shared/protocol.ts";
import { assistantActorId } from "../im/identity.ts";
import {
  COLLAB_LIMITS,
  runCoordinator,
  validateCollabPlan,
  type CoordinatorDecision,
  type CollabPlan,
} from "./coordinator.ts";
import { dependencyResolution, fifoQueuedTasks, terminalTaskStatus, waveFinished } from "./scheduler.ts";

export type CollabFaultPoint =
  | "trigger_after_read"
  | "trigger_after_run"
  | "trigger_after_task"
  | "dispatch_after_running"
  | "publishing_after_event"
  | "effect_after_message"
  | "effect_after_delivered";

export type CollabEngineDeps = {
  tenant: Tenant;
  imStore: ImStore;
  imService: ImService;
  store?: CollabStore;
  execute?: (context: RunContext, task: string, observer: RunObserver) => Promise<HeadlessResult>;
  coordinate?: (input: Parameters<typeof runCoordinator>[0]) => Promise<CoordinatorDecision>;
  publishState?: (convId: string, runs: CollabRunState[], snapshotSeq: number) => void;
  now?: () => number;
  fault?: (point: CollabFaultPoint) => void | Promise<void>;
};

let collabRunning = 0;
const waitingEngines = new Set<CollabEngine>();

function textOf(row: StoredMessage) {
  if (row.kind !== "text" || !row.body || !("text" in row.body)) return "";
  return String(row.body.text).trim();
}

function terminal(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class CollabEngine {
  readonly tenant: Tenant;
  readonly store: CollabStore;
  private readonly deps: CollabEngineDeps;
  private ticking = false;
  private readonly active = new Map<string, AbortController>();
  private coordinating = new Set<string>();
  private cancellingRuns = new Set<string>();

  constructor(deps: CollabEngineDeps) {
    this.deps = deps;
    this.tenant = deps.tenant;
    this.store = deps.store ?? new CollabStore(deps.tenant.stateDir);
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async fault(point: CollabFaultPoint) {
    await this.deps.fault?.(point);
  }

  async scanTriggers() {
    await this.store.ready();
    for (const convId of await this.deps.imStore.groupConvIdsOf(this.tenant.id)) {
      let cursor = this.store.cursor(convId);
      while (true) {
        const { rows, maxSeq } = await this.deps.imStore.groupRowsAfter(this.tenant.id, convId, cursor, 100);
        if (!rows.length) break;
        for (const row of rows) {
          await this.fault("trigger_after_read");
          await this.ensureTrigger(convId, row);
          await this.store.advanceCursor(convId, row.seq);
          cursor = row.seq;
        }
        if (cursor >= maxSeq) break;
      }
    }
  }

  private async ensureTrigger(convId: string, row: StoredMessage) {
    if (!row.trigger) return;
    const mentions = row.trigger.mentions.map(({ actorId }) => actorId);
    const coordinatorMentioned = mentions.includes(assistantActorId(this.tenant.id));
    const workspaceActors = mentions.filter((actorId) => actorId.startsWith("actor:workspace:"));
    if (!coordinatorMentioned && !workspaceActors.length) return;
    const runId = runIdForTrigger(row.trigger.eventKey);
    const at = this.now();
    if (!this.store.run(runId)) {
      const settings = readCollabSettings(this.tenant);
      const run: CollabRun = {
        id: runId,
        version: 0,
        convId,
        triggerSeq: row.seq,
        triggerEventKey: row.trigger.eventKey,
        ownerTenantId: this.tenant.id,
        coordinatorChatId: coordinatorChatIdForRun(runId),
        executionProfile: settings,
        status: coordinatorMentioned ? "planning" : "running",
        goal: textOf(row) || "请处理这条协作消息。",
        wave: 1,
        maxWaves: COLLAB_LIMITS.maxWaves,
        coordinated: coordinatorMentioned,
        createdAt: at,
        updatedAt: at,
      };
      await this.store.append({
        eventKey: row.trigger.eventKey,
        aggregate: { kind: "run", id: runId },
        expectedVersion: 0,
        type: "run.created",
        payload: { run },
      });
      await this.fault("trigger_after_run");
    }
    if (coordinatorMentioned) {
      if (!this.store.tasksForRun(runId).length && this.store.run(runId)?.status === "planning") {
        await this.planRun(runId);
      }
    } else {
      const plan: CollabPlan = {
        explanation: "按用户明确 @ 的工作区并行执行。",
        tasks: workspaceActors.map((actorId) => ({
          workspaceId: actorId.slice("actor:workspace:".length),
          title: textOf(row).slice(0, 80) || "直接派工",
          brief: textOf(row) || "请处理这条协作消息。",
          dependsOn: [],
          acceptance: [],
        })),
      };
      await this.createWave(runId, plan, row.trigger.eventKey);
    }
    this.publish(convId);
  }

  private async groupActors(convId: string) {
    const conv = await this.deps.imStore.open(convId);
    return conv?.meta.kind === "group" ? conv.meta.actors : [];
  }

  private async planRun(runId: string) {
    if (this.coordinating.has(runId)) return;
    const run = this.store.run(runId);
    if (!run || terminal(run.status)) return;
    this.coordinating.add(runId);
    try {
      const actors = await this.groupActors(run.convId);
      const coordinate = this.deps.coordinate ?? runCoordinator;
      const decision = await coordinate({
        goal: run.goal,
        wave: run.wave,
        actors,
        tasks: this.store.tasksForRun(run.id),
        profile: run.executionProfile,
        coordinatorChatId: run.coordinatorChatId,
      });
      if (decision.action === "needs_user") {
        await this.patchRun(run.id, "run.needs_user", { status: "needs_user", explanation: decision.reason });
        return;
      }
      if (decision.action === "finish") {
        await this.publishSummary(run.id, decision.summary, decision.partial);
        return;
      }
      let targetWave = run.wave;
      if (decision.action === "next_wave") {
        if (run.wave >= run.maxWaves) {
          await this.patchRun(run.id, "run.needs_user", {
            status: "needs_user",
            explanation: "协调器请求的下一波超过 3 waves 预算。",
          });
          return;
        }
        targetWave = run.wave + 1;
      }
      await this.createWave(run.id, decision.plan, `${run.triggerEventKey}:wave:${targetWave}`, targetWave);
    } catch (error) {
      log.error(`collab coordinator failed tenant=${this.tenant.id} run=${run.id}`, error);
      await this.patchRun(run.id, "run.needs_user", {
        status: "needs_user",
        explanation: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.coordinating.delete(runId);
      this.publishRun(runId);
    }
  }

  private async createWave(runId: string, plan: CollabPlan, key: string, targetWave?: number) {
    const run = this.store.run(runId);
    if (!run || terminal(run.status)) return;
    const wave = targetWave ?? run.wave;
    const actors = await this.groupActors(run.convId);
    const existing = this.store.tasksForRun(run.id);
    const tasks = validateCollabPlan(plan, { actors, existingTasks: existing, wave });
    // 所有外部引用和整张 DAG 先校验完，不能留下半波任务。
    for (const input of tasks) {
      if (!workspaceAgentById(this.tenant, input.workspaceId)) {
        throw new Error(`工作区不存在：${input.workspaceId}`);
      }
    }
    const at = this.now();
    const inputs: Parameters<CollabStore["appendBatch"]>[0] = [];
    const taskIds = tasks.map((input, index) => taskIdForTrigger(key, `actor:workspace:${input.workspaceId}:${index}`));
    for (const [index, input] of tasks.entries()) {
      const actorId = `actor:workspace:${input.workspaceId}`;
      const taskId = taskIds[index];
      if (this.store.task(taskId)) continue;
      const task: CollabTask = {
        id: taskId,
        runId,
        version: 0,
        attempt: 1,
        actorId,
        workspaceId: input.workspaceId,
        status: input.dependsOn.length ? "pending" : "queued",
        title: input.title,
        brief: input.brief,
        wave,
        dependsOn: input.dependsOn.map((dependency) => {
          const match = /^new:(\d+)$/.exec(dependency);
          return match ? (taskIds[Number(match[1])] ?? dependency) : dependency;
        }),
        acceptance: input.acceptance,
        required: true,
        attempts: [{ attempt: 1, status: input.dependsOn.length ? "pending" : "queued", startedAt: at }],
        createdAt: at,
        updatedAt: at,
      };
      inputs.push({
        eventKey: `${key}:task:${index}`,
        aggregate: { kind: "task", id: taskId },
        expectedVersion: 0,
        type: "task.queued",
        payload: { task },
        at,
      });
    }
    inputs.push({
      eventKey: `${key}:run`,
      aggregate: { kind: "run", id: run.id },
      expectedVersion: run.version,
      type: "run.running",
      payload: { patch: { wave, status: "running", explanation: plan.explanation } },
      effects: run.coordinated
        ? [
            {
              kind: "im_coordinator_message",
              // IM clientId 不允许群会话号里的 "~"，因此不能直接复用 mention eventKey。
              key: `collab:${run.id}:wave:${wave}:plan`,
              critical: true,
              payload: {
                convId: run.convId,
                actorId: assistantActorId(this.tenant.id),
                ownerTenantId: this.tenant.id,
                runId: run.id,
                event: "plan",
                wave,
                summary: plan.explanation,
              },
            },
          ]
        : [],
      at,
    });
    await this.store.appendBatch(inputs);
    await this.fault("trigger_after_task");
  }

  private async patchRun(runId: string, type: string, patch: Partial<CollabRun>) {
    const run = this.store.run(runId);
    if (!run || terminal(run.status)) return;
    await this.store.append({
      eventKey: `collab:${run.id}:${run.version + 1}:${type}`,
      aggregate: { kind: "run", id: run.id },
      expectedVersion: run.version,
      type,
      payload: { patch },
    });
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.scanTriggers();
      await this.projectEffects();
      await this.recoverPublishing();
      await this.expireApprovals();
      await this.reconcileDependencies();
      await this.reconcileFinishedWaves();
      for (let index = 0; index < COLLAB_LIMITS.maxParallelWorkspaces; index += 1) {
        if (!(await this.dispatchOne())) break;
      }
    } finally {
      this.ticking = false;
    }
  }

  private async reconcileDependencies() {
    for (const task of this.store.allTasks().filter((item) => item.status === "pending")) {
      const resolution = dependencyResolution(task, this.store.allTasks());
      if (resolution === "blocked") {
        await this.store.append({
          eventKey: `collab:${task.id}:${task.version + 1}:blocked`,
          aggregate: { kind: "task", id: task.id },
          expectedVersion: task.version,
          type: "task.blocked",
          payload: {
            patch: {
              status: "blocked",
              error: {
                code: "unknown",
                message: "依赖任务未成功，当前任务已阻塞。",
                retryable: false,
              },
            },
          },
        });
      } else if (resolution === "queued") {
        await this.store.append({
          eventKey: `collab:${task.id}:${task.version + 1}:queued`,
          aggregate: { kind: "task", id: task.id },
          expectedVersion: task.version,
          type: "task.queued",
          payload: { patch: { status: "queued" } },
        });
      }
      await this.maybeWakeWave(task.runId, task.wave);
    }
  }

  private async reconcileFinishedWaves() {
    for (const run of this.store.allRuns().filter((item) => item.status === "running")) {
      await this.maybeWakeWave(run.id, run.wave);
    }
  }

  private async maybeWakeWave(runId: string, wave: number) {
    if (this.cancellingRuns.has(runId)) return;
    const run = this.store.run(runId);
    if (!run || run.status !== "running") return;
    const allTasks = this.store.tasksForRun(runId);
    const tasks = allTasks.filter((task) => task.wave === wave);
    if (!waveFinished(allTasks, wave)) return;
    if (!run.coordinated) {
      const succeeded = tasks.filter((task) => task.status === "succeeded").length;
      const failed = tasks.length - succeeded;
      await this.publishSummary(
        run.id,
        failed ? `完成 ${succeeded} 项，${failed} 项失败或未执行。` : `${succeeded} 项任务均已完成。`,
        failed > 0,
      );
      return;
    }
    await this.store.append({
      eventKey: `collab:${run.id}:wave:${wave}:ended`,
      aggregate: { kind: "run", id: run.id },
      expectedVersion: run.version,
      type: "run.aggregating",
      payload: { patch: { status: "aggregating" } },
      effects: [
        {
          kind: "wake_coordinator",
          key: `collab:${run.id}:wave:${wave}:wake`,
          critical: false,
          payload: { runId: run.id, wave },
        },
      ],
    });
  }

  private async dispatchOne() {
    if (collabRunning >= COLLAB_LIMITS.maxParallelWorkspaces || collabRunning + globalRunningCount() >= maxRunning()) {
      waitingEngines.add(this);
      return false;
    }
    waitingEngines.delete(this);
    const tasks = this.store.allTasks();
    let task: CollabTask | undefined;
    let workspace: NonNullable<ReturnType<typeof workspaceAgentById>> | undefined;
    for (const candidate of fifoQueuedTasks(tasks)) {
      const run = this.store.run(candidate.runId);
      if (!run || run.status !== "running" || this.cancellingRuns.has(run.id)) continue;
      const candidateWorkspace = workspaceAgentById(this.tenant, candidate.workspaceId);
      if (!candidateWorkspace) {
        await this.failTask(candidate, this.classifyError("工作区已不存在"));
        return true;
      }
      // 忙 workspace 只跳过本 workspace，继续扫描其他 FIFO 队头。
      if (activeDelegationFor(this.tenant, candidateWorkspace.key)) continue;
      task = candidate;
      workspace = candidateWorkspace;
      break;
    }
    if (!task || !workspace) return false;
    const delegationId = delegationIdForTask(task.id, task.attempt);
    const childChatId = childChatIdForTask(task.id, task.attempt);
    await this.store.append({
      eventKey: `collab:${task.id}:${task.version + 1}:running`,
      aggregate: { kind: "task", id: task.id },
      expectedVersion: task.version,
      type: "task.running",
      payload: {
        patch: {
          status: "running",
          workspaceKeyAtDispatch: workspace.key,
          delegationId,
          childChatId,
        },
      },
    });
    this.publishRun(task.runId);
    await this.fault("dispatch_after_running");
    createDelegationRecord(this.tenant, {
      id: delegationId,
      childChatId,
      workspace: workspace.key,
      workspaceId: task.workspaceId,
      workspaceKeyAtDispatch: workspace.key,
      collabTaskId: task.id,
      title: task.brief.slice(0, 40),
      task: task.brief,
      mode: "background",
      notifyPolicy: "collab_only",
    });
    this.ensureChildChat(childChatId, workspace.path, delegationId, task.brief);
    const running = this.store.task(task.id);
    if (!running || running.status !== "running") return;
    collabRunning += 1;
    const abort = new AbortController();
    this.active.set(task.id, abort);
    const context: RunContext = {
      tenant: this.tenant,
      chatId: childChatId,
      cwd: workspace.path,
      model: this.store.run(task.runId)?.executionProfile.model || "auto",
      mode: "agent",
      policy: this.store.run(task.runId)?.executionProfile.policy || "plane",
      dialect: this.store.run(task.runId)?.executionProfile.dialect !== false,
      clock: {
        now: this.now(),
        tz: this.store.run(task.runId)?.executionProfile.timezone || "UTC",
      },
      approvalPolicy: "workspace_safe",
      approvedFingerprints: task.approvedFingerprints ?? [],
      approvalDecisions: task.approvalDecisions ?? [],
      signal: abort.signal,
      sourceTurnId: `${task.id}:attempt:${task.attempt}`,
    };
    const observer: RunObserver = {
      onText: () => undefined,
      onTool: () => undefined,
      onApproval: () => undefined,
      onFiles: () => undefined,
      onDone: () => undefined,
    };
    const execute = this.deps.execute ?? runHeadless;
    void execute(context, task.brief, observer)
      .then((result) => this.finishExecution(task.id, result))
      .catch((error) =>
        this.failTask(
          this.store.task(task.id),
          this.classifyError(error instanceof Error ? error.message : String(error)),
        ),
      )
      .finally(() => {
        if (this.active.get(task.id) === abort) this.active.delete(task.id);
        collabRunning = Math.max(0, collabRunning - 1);
        queueMicrotask(() => void this.tick());
        for (const waiting of waitingEngines) queueMicrotask(() => void waiting.tick());
      });
    return true;
  }

  private ensureChildChat(childChatId: string, cwd: string, delegationId: string, task: string) {
    if (this.tenant.disk.chats.some((chat) => chatIdOf(chat) === childChatId)) return;
    this.tenant.disk.chats = [
      ...this.tenant.disk.chats,
      { id: childChatId, title: `协作：${task.slice(0, 30)}`, turns: [], cwd, delegationId },
    ];
    this.tenant.disk.rev += 1;
    this.tenant.disk.chatRevs[childChatId] = this.tenant.disk.rev;
    saveDiskNow(this.tenant);
  }

  private persistHeadlessTurn(task: CollabTask, text: string, files: TurnFile[]) {
    const at = this.tenant.disk.chats.findIndex((chat) => chatIdOf(chat) === task.childChatId);
    if (at < 0) return;
    const chat = this.tenant.disk.chats[at] as Record<string, unknown>;
    const turns = Array.isArray(chat.turns) ? chat.turns : [];
    const turnId = `${task.id}:attempt:${task.attempt}`;
    if (turns.some((turn) => (turn as { id?: string }).id === turnId)) return;
    const chats = this.tenant.disk.chats.slice();
    chats[at] = {
      ...chat,
      turns: [
        ...turns,
        {
          id: turnId,
          user: task.brief,
          assistant: text,
          files,
        },
      ],
    };
    this.tenant.disk.chats = chats;
    this.tenant.disk.rev += 1;
    if (task.childChatId) this.tenant.disk.chatRevs[task.childChatId] = this.tenant.disk.rev;
    persistTenant(this.tenant);
  }

  private async finishExecution(taskId: string, result: HeadlessResult) {
    const task = this.store.task(taskId);
    if (!task || task.status !== "running") return;
    if (result.status === "awaiting") {
      await this.store.append({
        eventKey: `collab:${task.id}:${task.version + 1}:awaiting`,
        aggregate: { kind: "task", id: task.id },
        expectedVersion: task.version,
        type: "task.awaiting",
        payload: {
          patch: {
            status: "awaiting",
            approval: result.approval,
            files: result.files,
            summary: result.text || "等待审批",
            sourceTurnId: `${task.id}:attempt:${task.attempt}`,
          },
        },
      });
      if (task.delegationId) updateDelegation(this.tenant, task.delegationId, { status: "awaiting" });
      const run = this.store.run(task.runId);
      if (run && !terminal(run.status) && run.status !== "needs_user") {
        await this.store.append({
          eventKey: `collab:${run.id}:${run.version + 1}:needs-user`,
          aggregate: { kind: "run", id: run.id },
          expectedVersion: run.version,
          type: "run.needs_user",
          payload: { patch: { status: "needs_user" } },
        });
      }
      this.publishRun(task.runId);
      return;
    }
    if (result.status === "cancelled") {
      await this.cancelTask(task, "运行已停止；已产生的文件改动不会自动回滚。");
      return;
    }
    if (result.status === "failed") {
      await this.failTask(task, this.classifyError(result.error));
      return;
    }
    const files = mergeTurnFiles(
      task.attempts.flatMap((attempt) => attempt.files ?? []),
      result.files,
    );
    this.persistHeadlessTurn(task, result.text, files);
    const effectKey = `collab:${task.id}:attempt:${task.attempt}:result`;
    await this.store.append({
      eventKey: `collab:${task.id}:${task.version + 1}:publishing`,
      aggregate: { kind: "task", id: task.id },
      expectedVersion: task.version,
      type: "task.publishing",
      payload: {
        patch: {
          status: "publishing",
          summary: result.text,
          files,
          sourceTurnId: `${task.id}:attempt:${task.attempt}`,
          approval: undefined,
          error: undefined,
          suggestedNextActors: result.suggestedNextActors,
        },
      },
      effects: [
        {
          kind: "im_actor_message",
          key: effectKey,
          critical: true,
          payload: {
            convId: this.store.run(task.runId)!.convId,
            actorId: task.actorId,
            ownerTenantId: this.tenant.id,
            workspaceId: task.workspaceId,
            runId: task.runId,
            taskId: task.id,
            summary: result.text || "任务已完成。",
            files,
          },
        },
      ],
    });
    this.publishRun(task.runId);
    await this.fault("publishing_after_event");
    await this.projectEffects();
  }

  async projectEffects(includeDeferredRetries = false) {
    for (const effect of this.store.pendingEffects(this.now(), includeDeferredRetries)) {
      if (effect.kind === "collab_state") {
        await this.store.recordEffect({ key: effect.key, status: "delivered", attempt: 1 });
        continue;
      }
      if (effect.kind === "wake_coordinator") {
        const run = this.store.run(effect.payload.runId);
        // 新 wave 与 Run 状态在同一批事件中提交；若上次在提交后、确认 effect 前崩溃，
        // 恢复时只补记 delivered，不能再次提前唤醒协调器。
        if (run?.status === "aggregating" && run.wave <= effect.payload.wave) {
          await this.planRun(effect.payload.runId);
        }
        // Task 成功事件可能先于 Run aggregating 落盘；此时保留 pending，
        // 由 reconcileFinishedWaves 补齐状态后再次投影，不能吞掉唤醒。
        if (run?.status === "running" && run.wave <= effect.payload.wave) continue;
        await this.store.recordEffect({
          key: effect.key,
          status: "delivered",
          attempt: (this.store.effect(effect.key)?.attempt ?? 0) + 1,
        });
        continue;
      }
      try {
        const author: Exclude<ImAuthor, { kind: "tenant" }> =
          effect.kind === "im_actor_message"
            ? {
                kind: "workspace_agent",
                actorId: effect.payload.actorId,
                ownerTenantId: effect.payload.ownerTenantId,
                workspaceId: effect.payload.workspaceId,
              }
            : {
                kind: "assistant",
                actorId: effect.payload.actorId,
                ownerTenantId: effect.payload.ownerTenantId,
              };
        const row = await this.deps.imService.appendActorMessage({
          convId: effect.payload.convId,
          author,
          clientId: effect.key,
          body: {
            schema: "jiebo.collab.v1",
            event: effect.kind === "im_actor_message" ? "result" : effect.payload.event,
            runId: effect.payload.runId,
            ...(effect.kind === "im_actor_message" ? { taskId: effect.payload.taskId } : {}),
            ...(effect.kind === "im_coordinator_message" && effect.payload.event === "plan"
              ? { wave: effect.payload.wave }
              : {}),
            summary: effect.payload.summary.slice(0, 4000),
            ...(effect.kind === "im_actor_message" ? { files: effect.payload.files } : {}),
          },
        });
        await this.fault("effect_after_message");
        await this.store.recordEffect({
          key: effect.key,
          status: "delivered",
          targetId: `${effect.payload.convId}:${row.seq}`,
          attempt: (this.store.effect(effect.key)?.attempt ?? 0) + 1,
        });
        await this.fault("effect_after_delivered");
        if (effect.kind === "im_actor_message") await this.finalizePublished(effect.payload.taskId);
        else if (effect.payload.event === "summary") await this.finalizeSummary(effect.payload.runId, effect.key);
      } catch (error) {
        const attempt = (this.store.effect(effect.key)?.attempt ?? 0) + 1;
        const errorClass = error instanceof Error ? error.name : "Error";
        if (attempt >= 5) {
          await this.store.recordEffect({
            key: effect.key,
            status: "failed",
            attempt,
            errorClass,
          });
          if (effect.kind === "im_actor_message") {
            await this.failPublishingTask(effect.payload.taskId, "结果消息连续投影失败");
          } else {
            await this.failSummary(effect.payload.runId, "汇总消息连续投影失败");
          }
          continue;
        }
        await this.store.recordEffect({
          key: effect.key,
          status: "retry",
          attempt,
          nextAt: this.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)),
          errorClass,
        });
      }
    }
  }

  private async failPublishingTask(taskId: string, error: string) {
    const task = this.store.task(taskId);
    if (!task || task.status !== "publishing") return;
    await this.store.append({
      eventKey: `collab:${task.id}:${task.version + 1}:publish-failed`,
      aggregate: { kind: "task", id: task.id },
      expectedVersion: task.version,
      type: "task.failed",
      payload: {
        patch: {
          status: "failed",
          error: {
            code: "publish_failed",
            message: error,
            action: "检查网络后重试投影；不会重新执行文件操作。",
            retryable: true,
          },
        },
      },
    });
    if (task.delegationId) {
      updateDelegation(this.tenant, task.delegationId, {
        status: "failed",
        result: error,
        endedAt: this.now(),
      });
    }
    await this.reconcileDependencies();
    await this.maybeWakeWave(task.runId, task.wave);
    this.publishRun(task.runId);
  }

  private async finalizePublished(taskId: string) {
    const task = this.store.task(taskId);
    if (!task || task.status !== "publishing") return;
    if (this.store.effect(`collab:${task.id}:attempt:${task.attempt}:result`)?.status !== "delivered") return;
    const runBeforeSuccess = this.store.run(task.runId);
    const waveTasks = this.store.tasksForRun(task.runId).filter((item) => item.wave === task.wave);
    const waveEnds = waveTasks.every(
      (item) => item.id === task.id || ["succeeded", "failed", "cancelled", "blocked"].includes(item.status),
    );
    await this.store.append({
      eventKey: `collab:${task.id}:${task.version + 1}:succeeded`,
      aggregate: { kind: "task", id: task.id },
      expectedVersion: task.version,
      type: "task.succeeded",
      payload: { patch: { status: "succeeded" } },
      effects:
        waveEnds && runBeforeSuccess?.coordinated
          ? [
              {
                kind: "wake_coordinator",
                key: `collab:${task.runId}:wave:${task.wave}:wake`,
                critical: false,
                payload: { runId: task.runId, wave: task.wave },
              },
            ]
          : [],
    });
    if (task.delegationId) {
      updateDelegation(this.tenant, task.delegationId, {
        status: "done",
        result: task.summary || "任务已完成。",
        endedAt: this.now(),
      });
    }
    const run = this.store.run(task.runId);
    if (run && !terminal(run.status) && waveEnds) {
      if (run.coordinated) await this.patchRun(run.id, "run.aggregating", { status: "aggregating" });
      else await this.maybeWakeWave(run.id, task.wave);
    }
    this.publishRun(task.runId);
    if (waveEnds) await this.projectEffects();
  }

  private async publishSummary(runId: string, summary: string, partial: boolean) {
    const run = this.store.run(runId);
    if (!run || terminal(run.status)) return;
    const effectKey = `collab:${run.id}:summary`;
    await this.store.append({
      eventKey: `collab:${run.id}:${run.version + 1}:publishing`,
      aggregate: { kind: "run", id: run.id },
      expectedVersion: run.version,
      type: "run.publishing",
      payload: { patch: { status: "publishing", summary, partial } },
      effects: [
        {
          kind: "im_coordinator_message",
          key: effectKey,
          critical: true,
          payload: {
            convId: run.convId,
            actorId: assistantActorId(this.tenant.id),
            ownerTenantId: this.tenant.id,
            runId: run.id,
            event: "summary",
            summary,
          },
        },
      ],
    });
    await this.projectEffects();
  }

  private async finalizeSummary(runId: string, effectKey: string) {
    const run = this.store.run(runId);
    if (!run || run.status !== "publishing" || this.store.effect(effectKey)?.status !== "delivered") return;
    const tasks = this.store.tasksForRun(run.id);
    const latestWave = tasks.reduce((max, task) => Math.max(max, task.wave ?? 1), 1);
    // 协调器进入下一 wave 就表示接受上一 wave 的失败并以替代任务恢复；
    // 旧失败保留在历史中，但不能让成功的最终 wave 永久把 Run 判成失败。
    const requiredFailed = tasks
      .filter((task) => (task.wave ?? 1) === latestWave)
      .some((task) => (task.required ?? true) && ["failed", "cancelled", "blocked"].includes(task.status));
    const recoveredFromFailure = tasks.some(
      (task) =>
        (task.required ?? true) &&
        ["failed", "cancelled", "blocked"].includes(task.status) &&
        (task.wave ?? 1) < latestWave,
    );
    await this.store.append({
      eventKey: `collab:${run.id}:${run.version + 1}:${requiredFailed ? "failed" : "completed"}`,
      aggregate: { kind: "run", id: run.id },
      expectedVersion: run.version,
      type: requiredFailed ? "run.failed" : "run.completed",
      payload: {
        patch: {
          status: requiredFailed ? "failed" : "completed",
          partial: requiredFailed || recoveredFromFailure || run.partial,
        },
      },
    });
    await this.store.writeSnapshot(run.id);
    this.publishRun(run.id);
  }

  private async failSummary(runId: string, message: string) {
    const run = this.store.run(runId);
    if (!run || run.status !== "publishing") return;
    await this.patchRun(run.id, "run.failed", { status: "failed", summary: message, partial: true });
    await this.store.writeSnapshot(run.id);
  }

  private async recoverPublishing() {
    for (const task of this.store.allTasks().filter((item) => item.status === "publishing")) {
      if (this.store.effect(`collab:${task.id}:attempt:${task.attempt}:result`)?.status === "delivered") {
        await this.finalizePublished(task.id);
      }
    }
    for (const run of this.store.allRuns().filter((item) => item.status === "publishing")) {
      const effectKey = `collab:${run.id}:summary`;
      if (this.store.effect(effectKey)?.status === "delivered") await this.finalizeSummary(run.id, effectKey);
    }
  }

  private async expireApprovals() {
    for (const task of this.store
      .allTasks()
      .filter((item) => item.status === "awaiting" && item.approval && item.approval.expiresAt <= this.now())) {
      await this.failTask(task, {
        code: "approval_expired",
        message: "审批已过期，本次 attempt 已结束。",
        action: "请新建 attempt 重试；已产生的文件改动不会自动回滚。",
        retryable: true,
      });
    }
  }

  /** 启动恢复：publishing 只看 effect；running/awaiting 确认没有进程后才失败。 */
  async recover() {
    await this.store.ready();
    await this.projectEffects(true);
    await this.recoverPublishing();
    for (const task of this.store
      .allTasks()
      .filter((item) => item.status === "running" || item.status === "awaiting")) {
      const delegation = task.delegationId ? getDelegation(this.tenant, task.delegationId) : undefined;
      if (!delegation && task.status === "running") {
        // running 事件已提交、委派记录尚未 upsert 就崩溃：回 queued 后仍使用同一组确定性 id。
        await this.store.append({
          eventKey: `collab:${task.id}:${task.version + 1}:recover-queued`,
          aggregate: { kind: "task", id: task.id },
          expectedVersion: task.version,
          type: "task.queued",
          payload: { patch: { status: "queued" } },
        });
      } else if (!delegation || delegation.notifyPolicy === "collab_only") {
        await this.failTask(task, this.classifyError("网关重启，协作运行进程已丢失"));
      }
    }
  }

  private classifyError(message: string): CollabError {
    if (/工作区.*不存在|workspace.*missing/i.test(message)) {
      return { code: "workspace_missing", message, action: "恢复或重新绑定工作区后重试。", retryable: true };
    }
    return { code: "sdk_error", message, action: "查看详情后可新建 attempt 重试。", retryable: true };
  }

  private async failTask(task: CollabTask | undefined, error: CollabError) {
    if (!task || terminalTaskStatus(task.status) || task.status === "publishing") return;
    await this.store.append({
      eventKey: `collab:${task.id}:${task.version + 1}:failed`,
      aggregate: { kind: "task", id: task.id },
      expectedVersion: task.version,
      type: "task.failed",
      payload: { patch: { status: "failed", error } },
    });
    if (task.delegationId) {
      updateDelegation(this.tenant, task.delegationId, {
        status: "failed",
        result: error.message,
        endedAt: this.now(),
      });
    }
    await this.reconcileDependencies();
    await this.maybeWakeWave(task.runId, task.wave);
    this.publishRun(task.runId);
  }

  state(convId: string) {
    return this.store.state(convId);
  }

  private publishRun(runId: string) {
    const run = this.store.run(runId);
    if (run) this.publish(run.convId);
  }

  private publish(convId: string) {
    const state = this.store.state(convId);
    this.deps.publishState?.(convId, state.runs, state.snapshotSeq);
  }

  async sideEvent(
    taskId: string,
    type: "approval" | "approval_expired" | "memory_proposal",
    payload: Record<string, unknown>,
  ) {
    const task = this.store.task(taskId);
    if (!task || terminalTaskStatus(task.status)) return;
    if (type === "approval" && task.status === "running") {
      const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : this.now() + 24 * 60 * 60_000;
      await this.store.append({
        eventKey: `collab:${task.id}:${task.version + 1}:awaiting`,
        aggregate: { kind: "task", id: task.id },
        expectedVersion: task.version,
        type: "task.awaiting",
        payload: {
          patch: {
            status: "awaiting",
            approval: {
              id: String(payload.approvalId || ""),
              callId: String(payload.callId || ""),
              summary: String(payload.summary || "该操作需要批准"),
              tool: String(payload.tool || "受保护操作"),
              expiresAt,
            },
          },
        },
      });
    } else if (type === "approval_expired") {
      await this.failTask(task, {
        code: "approval_expired",
        message: "审批已过期，本次 attempt 已结束。",
        action: "请新建 attempt 重试；已产生的文件改动不会自动回滚。",
        retryable: true,
      });
      return;
    } else {
      const stableKey = String(payload.proposalKey || payload.callId || task.version + 1);
      await this.store.append({
        eventKey: `collab:${task.id}:${type}:${stableKey}`,
        aggregate: { kind: "task", id: task.id },
        expectedVersion: task.version,
        type: `task.${type}`,
        payload: { patch: {}, side: payload },
      });
      log.info("collab side event", type, taskId);
    }
    this.publishRun(task.runId);
  }

  async operation(input: {
    convId: string;
    requestId: string;
    op: "cancel_run" | "cancel_task" | "retry_task" | "retry_publish" | "answer_approval";
    runId?: string;
    taskId?: string;
    allow?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    await this.store.ready();
    if (input.op === "cancel_run") {
      const run = input.runId ? this.store.run(input.runId) : undefined;
      if (!run || run.ownerTenantId !== this.tenant.id || run.convId !== input.convId) {
        return { ok: false, error: "forbidden" };
      }
      if (terminal(run.status)) return { ok: true };
      this.cancellingRuns.add(run.id);
      try {
        for (const task of this.store.tasksForRun(run.id).filter((row) => !terminalTaskStatus(row.status))) {
          this.active.get(task.id)?.abort();
          await this.cancelTask(task, "你停止了本轮协作；已产生的文件改动不会自动回滚。", input.requestId, true);
          // 每次任务 CAS 后都丢弃旧 Run 引用，避免最终取消使用陈旧 version。
          if (!this.store.run(run.id)) return { ok: false, error: "Run 不存在" };
        }
        const latestRun = this.store.run(run.id);
        if (!latestRun || terminal(latestRun.status)) return { ok: true };
        await this.store.append({
          eventKey: `collab-op:${input.requestId}:${run.id}`,
          aggregate: { kind: "run", id: run.id },
          expectedVersion: latestRun.version,
          type: "run.cancelled",
          payload: { patch: { status: "cancelled" } },
        });
        await this.store.writeSnapshot(run.id);
      } finally {
        this.cancellingRuns.delete(run.id);
      }
      this.publish(run.convId);
      return { ok: true };
    }
    const task = input.taskId ? this.store.task(input.taskId) : undefined;
    if (!task) return { ok: false, error: "Task 不存在" };
    const run = this.store.run(task.runId);
    if (
      !run ||
      !input.runId ||
      task.runId !== input.runId ||
      run.id !== input.runId ||
      run.convId !== input.convId ||
      run.ownerTenantId !== this.tenant.id
    ) {
      return { ok: false, error: "forbidden" };
    }
    if (input.op === "retry_publish") {
      if (task.status !== "failed" || task.error?.code !== "publish_failed") {
        return { ok: false, error: "当前没有可重试的结果投影" };
      }
      const effectKey = `collab:${task.id}:attempt:${task.attempt}:result`;
      await this.store.recordEffect({ key: effectKey, status: "retry", attempt: 0, nextAt: this.now() });
      await this.store.append({
        eventKey: `collab-op:${input.requestId}:${task.id}:republish`,
        aggregate: { kind: "task", id: task.id },
        expectedVersion: task.version,
        type: "task.republish",
        payload: { patch: { status: "publishing", error: undefined } },
      });
      const latestRun = this.store.run(run.id);
      if (latestRun?.status === "failed") {
        await this.store.append({
          eventKey: `collab-op:${input.requestId}:${run.id}:republish`,
          aggregate: { kind: "run", id: run.id },
          expectedVersion: latestRun.version,
          type: "run.retry",
          payload: { patch: { status: "publishing" } },
        });
      }
      await this.projectEffects(true);
      return { ok: true };
    }
    if (input.op === "cancel_task" || (input.op === "answer_approval" && input.allow === false)) {
      if (terminalTaskStatus(task.status)) return { ok: true };
      this.active.get(task.id)?.abort();
      if (input.op === "answer_approval") {
        await this.failTask(task, {
          code: "cancelled",
          message: "审批已拒绝；已产生的文件改动不会自动回滚。",
          retryable: true,
        });
      } else {
        await this.cancelTask(task, "任务已停止；已产生的文件改动不会自动回滚。", input.requestId);
      }
      const latestRun = this.store.run(run.id);
      if (
        latestRun &&
        !terminal(latestRun.status) &&
        this.store.tasksForRun(run.id).every((row) => terminalTaskStatus(row.status))
      ) {
        await this.store.append({
          eventKey: `collab-op:${input.requestId}:${run.id}`,
          aggregate: { kind: "run", id: run.id },
          expectedVersion: latestRun.version,
          type: input.op === "answer_approval" ? "run.failed" : "run.cancelled",
          payload: { patch: { status: input.op === "answer_approval" ? "failed" : "cancelled" } },
        });
        await this.store.writeSnapshot(run.id);
      }
      this.publish(run.convId);
      return { ok: true };
    }
    if (input.op === "retry_task" || (input.op === "answer_approval" && input.allow === true)) {
      if (task.attempt >= COLLAB_LIMITS.maxAttempts) {
        return { ok: false, error: "每个任务最多 2 attempts" };
      }
      if (
        input.op === "answer_approval" ? task.status !== "awaiting" : !["failed", "cancelled"].includes(task.status)
      ) {
        return { ok: false, error: "Task 当前不能新建 attempt" };
      }
      if (input.op === "answer_approval" && task.approval && task.approval.expiresAt <= this.now()) {
        await this.failTask(task, {
          code: "approval_expired",
          message: "审批已过期，本次 attempt 已结束。",
          action: "请新建 attempt 重试。",
          retryable: true,
        });
        return { ok: false, error: "审批已过期，请重试任务" };
      }
      if (task.delegationId) {
        updateDelegation(this.tenant, task.delegationId, {
          status: "failed",
          result: input.op === "answer_approval" ? "审批后 SDK 无法原地恢复，已转入新 attempt。" : "已转入新 attempt。",
          endedAt: this.now(),
        });
      }
      await this.store.append({
        eventKey: `collab-op:${input.requestId}:${task.id}`,
        aggregate: { kind: "task", id: task.id },
        expectedVersion: task.version,
        type: "task.retry",
        payload: {
          patch: {
            status: "queued",
            attempt: task.attempt + 1,
            approval: undefined,
            approvedFingerprints:
              input.op === "answer_approval" && task.approval?.fingerprint
                ? [...new Set([...(task.approvedFingerprints ?? []), task.approval.fingerprint])]
                : task.approvedFingerprints,
            approvalDecisions:
              input.op === "answer_approval" && task.approval?.fingerprint
                ? [
                    ...(task.approvalDecisions ?? []),
                    { fingerprint: task.approval.fingerprint, allow: true as const, at: this.now() },
                  ]
                : task.approvalDecisions,
            error: undefined,
            summary:
              input.op === "answer_approval"
                ? "已批准。SDK 无法恢复已中止的运行，已创建新 attempt 继续，历史 attempt 保留。"
                : "已创建新 attempt，旧 attempt 保持不变。",
            files: undefined,
            childChatId: undefined,
            delegationId: undefined,
            sourceTurnId: undefined,
          },
        },
      });
      const latestRun = this.store.run(run.id);
      if (latestRun && latestRun.status !== "running") {
        await this.store.append({
          eventKey: `collab-op:${input.requestId}:${run.id}:retry`,
          aggregate: { kind: "run", id: run.id },
          expectedVersion: latestRun.version,
          type: "run.retry",
          payload: { patch: { status: "running" } },
        });
      }
      this.publish(run.convId);
      queueMicrotask(() => void this.tick());
      return { ok: true };
    }
    return { ok: false, error: "不支持的协作操作" };
  }

  private async cancelTask(task: CollabTask, message: string, requestId?: string, suppressWake = false) {
    const current = this.store.task(task.id);
    if (!current || terminalTaskStatus(current.status)) return;
    await this.store.append({
      eventKey: requestId
        ? `collab-op:${requestId}:${current.id}`
        : `collab:${current.id}:${current.version + 1}:cancelled`,
      aggregate: { kind: "task", id: current.id },
      expectedVersion: current.version,
      type: "task.cancelled",
      payload: {
        patch: {
          status: "cancelled",
          approval: undefined,
          error: { code: "cancelled", message, retryable: true },
        },
      },
    });
    if (current.delegationId) {
      updateDelegation(this.tenant, current.delegationId, {
        status: "failed",
        result: message,
        endedAt: this.now(),
      });
    }
    if (!suppressWake) {
      await this.reconcileDependencies();
      await this.maybeWakeWave(current.runId, current.wave);
    }
  }

  activeWorkspaceIds() {
    return new Set(
      this.store
        .allTasks()
        .filter((task) => ["pending", "queued", "running", "awaiting", "publishing"].includes(task.status))
        .map((task) => task.workspaceId),
    );
  }
}
