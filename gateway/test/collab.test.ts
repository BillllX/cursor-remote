import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { RunResult } from "@cursor/sdk";
import type { ClientMessage } from "../../shared/protocol.ts";
import { createDelegationRecord, listDelegations } from "../src/assistant/delegations.ts";
import { createBodyStore } from "../src/chatBodies.ts";
import { CollabEngine, type CollabFaultPoint } from "../src/collab/engine.ts";
import {
  authorizeHeadlessTool,
  bindHeadlessRunHost,
  runHeadless,
  type HeadlessResult,
  type RunContext,
  type RunObserver,
} from "../src/collab/headless.ts";
import { runIdForTrigger, taskIdForTrigger } from "../src/collab/ids.ts";
import { CollabStore } from "../src/collab/store.ts";
import { parseCollabPlan, validateCollabPlan } from "../src/collab/coordinator.ts";
import { dependencyResolution, fifoQueuedTasks, nextFifoTask, waveFinished } from "../src/collab/scheduler.ts";
import type { CollabTask } from "../src/collab/types.ts";
import { workspaceActorId } from "../src/im/identity.ts";
import { ImService } from "../src/im/service.ts";
import { ImStore } from "../src/im/store.ts";
import type { Tenant } from "../src/tenants.ts";

const root = mkdtempSync(resolve(tmpdir(), "cr-collab-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const WORKSPACE_ID = "wsa_00000000-0000-4000-8000-000000000001";
const ACTOR_ID = workspaceActorId(WORKSPACE_ID);
const WORKSPACE_B_ID = "wsa_00000000-0000-4000-8000-000000000002";
type Send = Extract<ClientMessage, { type: "im_send" }>;

let serial = 0;

function schedulerTask(id: string, workspaceId: string, status: CollabTask["status"], dependsOn: string[] = []) {
  return {
    id,
    runId: "run-scheduler",
    version: 1,
    attempt: 1,
    actorId: workspaceActorId(workspaceId),
    workspaceId,
    status,
    title: id,
    brief: id,
    wave: 1,
    dependsOn,
    acceptance: [],
    required: true,
    attempts: [{ attempt: 1, status, startedAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
  } satisfies CollabTask;
}

test("Scheduler 跨 workspace 可并行、同 workspace FIFO、依赖失败阻塞并识别 wave 结束", () => {
  const first = schedulerTask("first", "workspace-a", "running");
  const sameWorkspace = schedulerTask("same", "workspace-a", "queued");
  const parallel = schedulerTask("parallel", "workspace-b", "queued");
  assert.equal(nextFifoTask([first, sameWorkspace, parallel])?.id, "parallel");
  assert.deepEqual(
    fifoQueuedTasks([first, sameWorkspace, parallel]).map((task) => task.id),
    ["parallel"],
  );
  first.status = "succeeded";
  assert.equal(nextFifoTask([first, sameWorkspace, parallel])?.id, "same");

  const failed = schedulerTask("failed", "workspace-a", "failed");
  const dependent = schedulerTask("dependent", "workspace-b", "pending", ["failed"]);
  assert.equal(dependencyResolution(dependent, [failed, dependent]), "blocked");
  dependent.status = "blocked";
  assert.equal(waveFinished([failed, dependent], 1), true);
});

test("CollabPlan 严格校验 actor 归属、循环依赖与 8 task 预算", () => {
  const actors = [
    {
      kind: "workspace_agent" as const,
      actorId: ACTOR_ID,
      ownerTenantId: "alice",
      workspaceId: WORKSPACE_ID,
      displayName: "Demo",
    },
  ];
  const valid = parseCollabPlan({
    tasks: [
      { workspaceId: WORKSPACE_ID, title: "实现", brief: "实现功能", dependsOn: [], acceptance: ["测试通过"] },
      { workspaceId: WORKSPACE_ID, title: "验证", brief: "运行测试", dependsOn: ["实现"], acceptance: ["无失败"] },
    ],
    explanation: "先实现再验证",
  });
  assert.deepEqual(validateCollabPlan(valid, { actors, wave: 1 })[1].dependsOn, ["new:0"]);
  assert.throws(
    () =>
      validateCollabPlan(
        {
          explanation: "循环",
          tasks: [
            { workspaceId: WORKSPACE_ID, title: "A", brief: "A", dependsOn: ["B"], acceptance: [] },
            { workspaceId: WORKSPACE_ID, title: "B", brief: "B", dependsOn: ["A"], acceptance: [] },
          ],
        },
        { actors, wave: 1 },
      ),
    /循环/,
  );
  assert.throws(
    () =>
      validateCollabPlan(
        {
          explanation: "过量",
          tasks: Array.from({ length: 9 }, (_, index) => ({
            workspaceId: WORKSPACE_ID,
            title: `T${index}`,
            brief: "x",
            dependsOn: [],
            acceptance: [],
          })),
        },
        { actors, wave: 1 },
      ),
    /8 个任务/,
  );
  assert.throws(
    () =>
      validateCollabPlan(
        {
          explanation: "越权",
          tasks: [{ workspaceId: "wsa_other", title: "X", brief: "x", dependsOn: [], acceptance: [] }],
        },
        { actors, wave: 1 },
      ),
    /不属于当前群/,
  );
  assert.throws(() => validateCollabPlan({ explanation: "空", tasks: [] }, { actors, wave: 1 }), /不能为空/);
});

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= until) assert.fail("等待协作状态超时");
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function setup(
  point?: CollabFaultPoint,
  executeOverride?: (context: RunContext, task: string, observer: RunObserver) => Promise<HeadlessResult>,
) {
  const dir = resolve(root, `case-${(serial += 1)}`);
  const workspaceRoot = resolve(dir, "workspaces");
  const workspace = resolve(workspaceRoot, "demo");
  const stateDir = resolve(dir, "tenant");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    resolve(stateDir, "workspace-agent-chats.json"),
    JSON.stringify({
      version: 2,
      items: {
        demo: {
          workspaceId: WORKSPACE_ID,
          path: workspace,
          lastReadSeq: 0,
          unread: 0,
          lastActivityAt: 0,
          lastFinishedSeq: 0,
        },
      },
    }),
  );
  const tenant = {
    id: "alice",
    name: "Alice",
    admin: false,
    sandbox: true,
    workspaceRoot,
    stateDir,
    stateFile: resolve(stateDir, "state.json"),
    disk: { chats: [], slots: [], rev: 0, deletedIds: [], chatRevs: {} },
    bodies: createBodyStore(stateDir, (turns) => turns),
    tokenHash: Buffer.alloc(32),
  } as unknown as Tenant;
  const imStore = new ImStore(dir, () => stateDir);
  const service = new ImService({
    store: imStore,
    tenants: () => [{ id: "alice", name: "Alice" }],
    secret: () => "secret",
    conns: () => [],
    push: () => undefined,
    actors: () => [
      {
        kind: "workspace_agent",
        actorId: ACTOR_ID,
        ownerTenantId: "alice",
        workspaceId: WORKSPACE_ID,
        displayName: "Demo",
      },
    ],
  });
  const created = await service.createGroup("alice", { type: "im_group_create", title: "协作" });
  const convId = created.conv.convId;
  await service.send(
    "alice",
    null,
    {
      type: "im_send",
      clientId: "trigger-1",
      convId,
      kind: "text",
      body: { text: "创建 done.txt" },
      mentions: [{ actorId: ACTOR_ID }],
    } satisfies Send,
    true,
  );
  let tripped = false;
  const execute =
    executeOverride ??
    (async (context: { cwd: string }, task: string) => {
      writeFileSync(resolve(context.cwd, "done.txt"), task);
      return { status: "completed" as const, text: "已创建 done.txt", files: [] };
    });
  const make = () =>
    new CollabEngine({
      tenant,
      imStore,
      imService: service,
      store: new CollabStore(stateDir),
      execute,
      fault: async (at) => {
        if (!tripped && at === point) {
          tripped = true;
          throw new Error(`kill:${at}`);
        }
      },
    });
  return { tenant, stateDir, workspace, imStore, service, convId, make };
}

describe("Collab Event Store", { concurrency: false }, () => {
  test("确定性 ID、CAS、effect 状态与终态 snapshot 可重放", async () => {
    const dir = resolve(root, `store-${(serial += 1)}`);
    const store = new CollabStore(dir);
    const eventKey = "mention:grp~one:1";
    const runId = runIdForTrigger(eventKey);
    const now = Date.now();
    const event = await store.append({
      eventKey,
      aggregate: { kind: "run", id: runId },
      expectedVersion: 0,
      type: "run.created",
      payload: {
        run: {
          id: runId,
          version: 0,
          convId: "grp~one",
          triggerSeq: 1,
          triggerEventKey: eventKey,
          ownerTenantId: "alice",
          coordinatorChatId: "chat",
          executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
          status: "running",
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    assert.equal((await store.append({ ...event, at: undefined } as never)).eventId, event.eventId);
    await assert.rejects(
      store.append({
        eventKey: "wrong-cas",
        aggregate: { kind: "run", id: runId },
        expectedVersion: 0,
        type: "run.failed",
      }),
      /CAS/,
    );
    await store.recordEffect({ key: "effect-1", status: "delivered", targetId: "grp~one:2", attempt: 1 });
    const loaded = new CollabStore(dir);
    await loaded.ready();
    assert.equal(loaded.run(runId)?.version, 1);
    assert.equal(loaded.effect("effect-1")?.status, "delivered");
    assert.equal(taskIdForTrigger(eventKey, ACTOR_ID), taskIdForTrigger(eventKey, ACTOR_ID));
  });

  test("终态 snapshot 后清理 30 天事件，dedupe 独立保留 180 天", async () => {
    const dir = resolve(root, `cleanup-${(serial += 1)}`);
    const store = new CollabStore(dir);
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60_000;
    const expired = now - 181 * 24 * 60 * 60_000;
    await store.append({
      eventKey: "mention:grp~cleanup:1",
      aggregate: { kind: "run", id: "run-cleanup" },
      expectedVersion: 0,
      type: "run.created",
      at: old,
      payload: {
        run: {
          id: "run-cleanup",
          version: 0,
          convId: "grp~cleanup",
          triggerSeq: 1,
          triggerEventKey: "mention:grp~cleanup:1",
          ownerTenantId: "alice",
          coordinatorChatId: "hidden",
          executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
          status: "completed",
          goal: "cleanup",
          wave: 1,
          maxWaves: 3,
          coordinated: false,
          createdAt: old,
          updatedAt: old,
        },
      },
    });
    await store.advanceCursor("grp~cleanup", 1);
    await store.writeSnapshot("run-cleanup");
    await store.recordEffect({ key: "keep", status: "delivered", attempt: 1, at: old });
    await store.recordEffect({ key: "expire", status: "delivered", attempt: 1, at: expired });
    const oldMonth = new Date(old).toISOString().slice(0, 7);
    const expiredMonth = new Date(expired).toISOString().slice(0, 7);
    const outcome = await store.cleanup(now);
    assert.ok(outcome.removedEvents.includes(`${oldMonth}.jsonl`));
    assert.ok(existsSync(resolve(dir, "collab", "snapshots", "run-cleanup.json")));
    assert.equal(store.effect("keep")?.status, "delivered");
    assert.ok(outcome.removedDedupe.includes(`${expiredMonth}.jsonl`));
    const restarted = new CollabStore(dir);
    await restarted.ready();
    assert.equal(restarted.run("run-cleanup")?.status, "completed");
    assert.equal(restarted.effect("keep")?.status, "delivered");
    assert.equal(restarted.effect("expire"), undefined);
  });

  test("跨月 run 只清理整组事件，有新月残留时保留旧月以保证重启可重放", async () => {
    const dir = resolve(root, `cross-month-${(serial += 1)}`);
    const store = new CollabStore(dir);
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60_000;
    const run = {
      id: "run-cross-month",
      version: 0,
      convId: "grp~cross-month",
      triggerSeq: 1,
      triggerEventKey: "mention:grp~cross-month:1",
      ownerTenantId: "alice",
      coordinatorChatId: "hidden",
      executionProfile: { model: "m", mode: "agent" as const, policy: "plane" as const, dialect: true },
      status: "running" as const,
      goal: "cross month",
      wave: 1,
      maxWaves: 3,
      coordinated: false,
      createdAt: old,
      updatedAt: old,
    };
    await store.append({
      eventKey: run.triggerEventKey,
      aggregate: { kind: "run", id: run.id },
      expectedVersion: 0,
      type: "run.created",
      payload: { run },
      at: old,
    });
    await store.append({
      eventKey: "run-cross-month:completed",
      aggregate: { kind: "run", id: run.id },
      expectedVersion: 1,
      type: "run.completed",
      payload: { patch: { status: "completed" } },
      at: now,
    });
    await store.advanceCursor(run.convId, 1);
    await store.writeSnapshot(run.id);
    const outcome = await store.cleanup(now);
    assert.deepEqual(outcome.removedEvents, []);
    const restarted = new CollabStore(dir);
    await restarted.ready();
    assert.equal(restarted.run(run.id)?.status, "completed");
    assert.equal(restarted.run(run.id)?.version, 2);
  });

  test("状态投影按创建时间排序，不依赖事件与 snapshot 的 Map 插入顺序", async () => {
    const dir = resolve(root, `run-order-${(serial += 1)}`);
    const store = new CollabStore(dir);
    const convId = "grp~ordered";
    for (const [id, createdAt] of [
      ["run-new", 200],
      ["run-old", 100],
    ] as const) {
      await store.append({
        eventKey: id,
        aggregate: { kind: "run", id },
        expectedVersion: 0,
        type: "run.created",
        at: createdAt,
        payload: {
          run: {
            id,
            version: 0,
            convId,
            triggerSeq: createdAt,
            triggerEventKey: id,
            ownerTenantId: "alice",
            coordinatorChatId: "hidden",
            executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
            status: "completed",
            goal: id,
            wave: 1,
            maxWaves: 3,
            coordinated: false,
            createdAt,
            updatedAt: createdAt,
          },
        },
      });
    }
    assert.deepEqual(
      store.state(convId).runs.map((run) => run.runId),
      ["run-old", "run-new"],
    );
  });
});

describe("D0d 七个故障窗口", { concurrency: false }, () => {
  for (const point of [
    "trigger_after_read",
    "trigger_after_run",
    "trigger_after_task",
    "dispatch_after_running",
    "publishing_after_event",
    "effect_after_message",
    "effect_after_delivered",
  ] satisfies CollabFaultPoint[]) {
    test(`${point} 重放不重复 Run/Task/Delegation/结果`, async () => {
      const env = await setup(point);
      const first = env.make();
      await first.tick().catch(() => undefined);
      if (
        point === "publishing_after_event" ||
        point === "effect_after_message" ||
        point === "effect_after_delivered"
      ) {
        await waitFor(() => {
          const status = first.store.allTasks()[0]?.status;
          if (!status || status === "queued") {
            void first.tick().catch(() => undefined);
            return false;
          }
          return true;
        });
      }
      if (point === "publishing_after_event") {
        await waitFor(() =>
          first.store.allTasks().some((task) => task.status === "publishing" || task.status === "succeeded"),
        );
        const task = first.store.allTasks()[0];
        if (task.status === "publishing") {
          assert.notEqual(task.status, "succeeded", "结果 effect 投影完成前 Task 不能提前成功");
        }
        await new Promise((done) => setTimeout(done, 30));
      } else if (point === "effect_after_message" || point === "effect_after_delivered") {
        await waitFor(() => {
          const task = first.store.allTasks()[0];
          if (!task) return false;
          const effect = first.store.effect(`collab:${task.id}:attempt:${task.attempt}:result`);
          return point === "effect_after_delivered"
            ? effect?.status === "delivered"
            : task.status === "publishing" && Boolean(effect);
        });
        await new Promise((done) => setTimeout(done, 30));
      }
      const recovered = env.make();
      await recovered.recover();
      await recovered.tick();
      await waitFor(() => {
        const complete =
          recovered.state(env.convId).runs[0]?.status === "completed" &&
          recovered.store.allTasks().some((task) => task.status === "succeeded");
        if (!complete) void recovered.tick();
        return complete;
      }).catch(() => {
        assert.fail(
          `恢复未完成：${JSON.stringify({
            state: recovered.state(env.convId),
            effects: recovered.store.allTasks().map((task) => ({
              task: task.status,
              result: recovered.store.effect(`collab:${task.id}:attempt:${task.attempt}:result`),
              summary: recovered.store.effect(`collab:${task.runId}:summary`),
            })),
          })}`,
        );
      });

      const state = recovered.state(env.convId);
      assert.equal(state.runs.length, 1);
      assert.equal(state.runs[0].tasks.length, 1);
      assert.equal(state.runs[0].status, "completed");
      assert.equal(listDelegations(env.tenant, 20).length, 1);
      const history = await env.service.history("alice", { type: "im_history", convId: env.convId, limit: 50 }, true);
      assert.equal(history.messages.filter((row) => row.kind === "collab").length, 2);
      assert.equal(readFileSync(resolve(env.workspace, "done.txt"), "utf8"), "创建 done.txt");
    });
  }
});

test("在途取消会 abort 执行且迟到完成不能覆盖 cancelled", async () => {
  let aborted = false;
  let release!: (value: HeadlessResult) => void;
  const result = new Promise<HeadlessResult>((resolve) => {
    release = resolve;
  });
  const env = await setup(undefined, async (context) => {
    context.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    return result;
  });
  const engine = env.make();
  await engine.tick();
  await waitFor(() => engine.store.allTasks()[0]?.status === "running");
  const task = engine.store.allTasks()[0];
  const outcome = await engine.operation({
    convId: env.convId,
    requestId: "cancel-race",
    op: "cancel_task",
    runId: task.runId,
    taskId: task.id,
  });
  assert.equal(outcome.ok, true);
  assert.equal(aborted, true);
  release({ status: "completed", text: "迟到结果", files: [] });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(engine.store.task(task.id)?.status, "cancelled");
  assert.match(engine.store.task(task.id)?.error?.message || "", /不会自动回滚/);
});

test("cancel_run 多任务竞态中抑制 wave 唤醒，并用最新 Run version 最终取消", async () => {
  let release!: (value: HeadlessResult) => void;
  const held = new Promise<HeadlessResult>((resolve) => {
    release = resolve;
  });
  const env = await setup(undefined, async () => held);
  const engine = env.make();
  await engine.tick();
  await waitFor(() => engine.store.allTasks()[0]?.status === "running");
  const first = engine.store.allTasks()[0];
  const second: CollabTask = {
    ...first,
    id: "task-cancel-second",
    version: 0,
    status: "queued",
    childChatId: undefined,
    delegationId: undefined,
    attempts: [{ attempt: 1, status: "queued", startedAt: Date.now() }],
  };
  await engine.store.append({
    eventKey: "task-cancel-second:create",
    aggregate: { kind: "task", id: second.id },
    expectedVersion: 0,
    type: "task.queued",
    payload: { task: second },
  });
  const result = await engine.operation({
    convId: env.convId,
    requestId: "cancel-all",
    op: "cancel_run",
    runId: first.runId,
  });
  assert.equal(result.ok, true);
  assert.equal(engine.store.run(first.runId)?.status, "cancelled");
  assert.deepEqual(
    engine.store.tasksForRun(first.runId).map((task) => task.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(
    engine.store.pendingEffects().some((effect) => effect.kind === "wake_coordinator"),
    false,
  );
  release({ status: "completed", text: "late", files: [] });
});

test("collab_op 强绑定 convId/runId/taskId，跨群或错配一律 forbidden", async () => {
  const env = await setup();
  const engine = env.make();
  await engine.tick();
  await waitFor(() => Boolean(engine.store.allTasks()[0]));
  const task = engine.store.allTasks()[0];
  const wrongConv = await engine.operation({
    convId: "grp~other",
    requestId: "cross-group",
    op: "cancel_task",
    runId: task.runId,
    taskId: task.id,
  });
  const wrongRun = await engine.operation({
    convId: env.convId,
    requestId: "cross-run",
    op: "cancel_task",
    runId: "run-other",
    taskId: task.id,
  });
  assert.equal(wrongConv.ok, false);
  assert.equal(wrongRun.ok, false);
  assert.equal(wrongConv.error, "forbidden");
  assert.equal(wrongRun.error, "forbidden");
});

test("createWave 在 workspace 全量校验失败时不写入任何部分 Task", async () => {
  const env = await setup();
  const engine = env.make();
  const now = Date.now();
  await engine.store.ready();
  await engine.store.append({
    eventKey: "manual-run",
    aggregate: { kind: "run", id: "manual-run" },
    expectedVersion: 0,
    type: "run.created",
    payload: {
      run: {
        id: "manual-run",
        version: 0,
        convId: env.convId,
        triggerSeq: 99,
        triggerEventKey: "manual-run",
        ownerTenantId: env.tenant.id,
        coordinatorChatId: "manual",
        executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
        status: "planning",
        goal: "atomic",
        wave: 1,
        maxWaves: 3,
        coordinated: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await assert.rejects(
    (
      engine as unknown as {
        createWave(runId: string, plan: ReturnType<typeof parseCollabPlan>, key: string): Promise<void>;
      }
    ).createWave(
      "manual-run",
      parseCollabPlan({
        explanation: "中途无效",
        tasks: [
          { workspaceId: WORKSPACE_ID, title: "valid", brief: "valid", dependsOn: [], acceptance: [] },
          { workspaceId: "wsa_missing", title: "invalid", brief: "invalid", dependsOn: [], acceptance: [] },
        ],
      }),
      "manual-wave",
    ),
    /不属于当前群|不存在/,
  );
  assert.deepEqual(engine.store.tasksForRun("manual-run"), []);
  assert.equal(engine.store.run("manual-run")?.version, 1);
});

test("下一 wave 的 Run 进度与任务在同一批事件中提交", async () => {
  const env = await setup();
  const engine = env.make();
  const runId = "atomic-next-wave";
  const now = Date.now();
  await engine.store.ready();
  await engine.store.append({
    eventKey: runId,
    aggregate: { kind: "run", id: runId },
    expectedVersion: 0,
    type: "run.created",
    payload: {
      run: {
        id: runId,
        version: 0,
        convId: env.convId,
        triggerSeq: 99,
        triggerEventKey: runId,
        ownerTenantId: env.tenant.id,
        coordinatorChatId: "manual",
        executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
        status: "aggregating",
        goal: "原子进入下一波",
        wave: 1,
        maxWaves: 3,
        coordinated: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await (
    engine as unknown as {
      createWave(id: string, plan: ReturnType<typeof parseCollabPlan>, key: string, targetWave?: number): Promise<void>;
    }
  ).createWave(
    runId,
    parseCollabPlan({
      explanation: "恢复执行",
      tasks: [{ workspaceId: WORKSPACE_ID, title: "替代任务", brief: "只读盘点", dependsOn: [], acceptance: [] }],
    }),
    `${runId}:wave:2`,
    2,
  );
  assert.equal(engine.store.run(runId)?.status, "running");
  assert.equal(engine.store.run(runId)?.wave, 2);
  assert.deepEqual(
    engine.store.tasksForRun(runId).map((task) => task.wave),
    [2],
  );
});

test("最终 wave 成功时旧 wave 的失败只标记 partial，不再把 Run 判成失败", async () => {
  const env = await setup();
  const engine = env.make();
  const runId = "recovered-run";
  const now = Date.now();
  await engine.store.ready();
  await engine.store.append({
    eventKey: runId,
    aggregate: { kind: "run", id: runId },
    expectedVersion: 0,
    type: "run.created",
    payload: {
      run: {
        id: runId,
        version: 0,
        convId: env.convId,
        triggerSeq: 99,
        triggerEventKey: runId,
        ownerTenantId: env.tenant.id,
        coordinatorChatId: "manual",
        executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
        status: "publishing",
        goal: "恢复执行",
        wave: 2,
        maxWaves: 3,
        coordinated: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  for (const task of [
    { ...schedulerTask("old-failure", WORKSPACE_ID, "failed"), runId, version: 0, wave: 1 },
    { ...schedulerTask("replacement", WORKSPACE_ID, "succeeded"), runId, version: 0, wave: 2 },
  ] satisfies CollabTask[]) {
    await engine.store.append({
      eventKey: `${task.id}:create`,
      aggregate: { kind: "task", id: task.id },
      expectedVersion: 0,
      type: "task.queued",
      payload: { task },
    });
  }
  const effectKey = `${runId}:summary`;
  await engine.store.recordEffect({ key: effectKey, status: "delivered", attempt: 1 });
  await (engine as unknown as { finalizeSummary(id: string, key: string): Promise<void> }).finalizeSummary(
    runId,
    effectKey,
  );
  assert.equal(engine.store.run(runId)?.status, "completed");
  assert.equal(engine.store.run(runId)?.partial, true);
});

test("协调计划 effect 使用合法 clientId 并投影到群消息", async () => {
  const env = await setup();
  const engine = env.make();
  const runId = "manual-coordinated-run";
  const now = Date.now();
  await engine.store.ready();
  await engine.store.append({
    eventKey: "mention:grp~contains-tilde:1",
    aggregate: { kind: "run", id: runId },
    expectedVersion: 0,
    type: "run.created",
    payload: {
      run: {
        id: runId,
        version: 0,
        convId: env.convId,
        triggerSeq: 99,
        triggerEventKey: "mention:grp~contains-tilde:1",
        ownerTenantId: env.tenant.id,
        coordinatorChatId: "manual",
        executionProfile: { model: "m", mode: "agent", policy: "plane", dialect: true },
        status: "planning",
        goal: "投影计划",
        wave: 1,
        maxWaves: 3,
        coordinated: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await (
    engine as unknown as {
      createWave(runId: string, plan: ReturnType<typeof parseCollabPlan>, key: string): Promise<void>;
    }
  ).createWave(
    runId,
    parseCollabPlan({
      explanation: "先实现再验证",
      tasks: [{ workspaceId: WORKSPACE_ID, title: "实现", brief: "完成实现", dependsOn: [], acceptance: [] }],
    }),
    "mention:grp~contains-tilde:1:wave:1",
  );
  const effect = engine.store.pendingEffects().find((item) => item.kind === "im_coordinator_message");
  assert.equal(effect?.key, `collab:${runId}:wave:1:plan`);
  await engine.projectEffects();
  const history = await env.service.history("alice", { type: "im_history", convId: env.convId, limit: 50 }, true);
  assert.equal(
    history.messages.some(
      (row) =>
        row.kind === "collab" &&
        row.body !== undefined &&
        "schema" in row.body &&
        row.body.schema === "jiebo.collab.v1" &&
        row.body.event === "plan" &&
        row.body.wave === 1,
    ),
    true,
  );
});

test("Scheduler 跳过忙碌 workspace A，继续执行 workspace B 且保持各自 FIFO", async () => {
  const env = await setup();
  const workspaceB = resolve(env.tenant.workspaceRoot, "demo-b");
  mkdirSync(workspaceB, { recursive: true });
  writeFileSync(
    resolve(env.stateDir, "workspace-agent-chats.json"),
    JSON.stringify({
      version: 2,
      items: {
        demo: {
          workspaceId: WORKSPACE_ID,
          lastReadSeq: 0,
          unread: 0,
          lastActivityAt: 0,
          lastFinishedSeq: 0,
        },
        "demo-b": {
          workspaceId: WORKSPACE_B_ID,
          lastReadSeq: 0,
          unread: 0,
          lastActivityAt: 0,
          lastFinishedSeq: 0,
        },
      },
    }),
  );
  const engine = env.make();
  await engine.scanTriggers();
  const first = engine.store.allTasks()[0];
  const second: CollabTask = {
    ...first,
    id: "task-workspace-b",
    version: 0,
    actorId: workspaceActorId(WORKSPACE_B_ID),
    workspaceId: WORKSPACE_B_ID,
    status: "queued",
    attempts: [{ attempt: 1, status: "queued", startedAt: Date.now() }],
  };
  await engine.store.append({
    eventKey: "task-workspace-b:create",
    aggregate: { kind: "task", id: second.id },
    expectedVersion: 0,
    type: "task.queued",
    payload: { task: second },
  });
  createDelegationRecord(env.tenant, {
    id: "busy-a",
    childChatId: "busy-a-chat",
    workspace: "demo",
    workspaceId: WORKSPACE_ID,
    title: "busy",
    task: "busy",
    mode: "background",
  });
  await engine.tick();
  await waitFor(() => engine.store.task(second.id)?.status === "publishing");
  assert.equal(engine.store.task(first.id)?.status, "queued");
  assert.equal(readFileSync(resolve(workspaceB, "done.txt"), "utf8"), "创建 done.txt");
});

test("Scheduler 不执行父 Run 非 running 的 queued Task", async () => {
  let executions = 0;
  const env = await setup(undefined, async () => {
    executions += 1;
    return { status: "completed", text: "不应执行", files: [] };
  });
  const engine = env.make();
  await engine.scanTriggers();
  const run = engine.store.allRuns()[0];
  await engine.store.append({
    eventKey: "run-needs-user:test",
    aggregate: { kind: "run", id: run.id },
    expectedVersion: run.version,
    type: "run.needs_user",
    payload: { patch: { status: "needs_user" } },
  });
  await engine.tick();
  assert.equal(executions, 0);
  assert.equal(engine.store.allTasks()[0]?.status, "queued");
});

test("群可改名、归档和管理成员，但运行中的 workspace actor 不可移除", async () => {
  const env = await setup();
  await assert.rejects(
    env.service.updateGroup(
      "alice",
      { type: "im_group_update", convId: env.convId, actorIds: [] },
      new Set([WORKSPACE_ID]),
    ),
    /运行中/,
  );
  const renamed = await env.service.updateGroup(
    "alice",
    { type: "im_group_update", convId: env.convId, title: "项目群", actorIds: [], archived: true },
    new Set(),
  );
  assert.equal(renamed.conv.title, "项目群");
  assert.equal(renamed.conv.archived, true);
  assert.equal(
    renamed.conv.actors.some((actor) => actor.kind === "workspace_agent"),
    false,
  );
  assert.equal(
    renamed.conv.actors.some((actor) => actor.kind === "assistant"),
    true,
  );
});

test("审批指纹进入下一 attempt 的真实策略链路，同一工具不重复询问", async () => {
  let calls = 0;
  const env = await setup(undefined, async (context) => {
    calls += 1;
    const args = { command: "touch approved.txt", working_directory: context.cwd };
    const decision = authorizeHeadlessTool(context, "shell", args);
    if (decision.action === "approval") {
      return {
        status: "awaiting",
        text: "",
        approval: {
          id: "approval-1",
          callId: "call-1",
          fingerprint: decision.fingerprint,
          summary: "运行受保护命令",
          tool: "shell",
          expiresAt: Date.now() + 60_000,
        },
        files: [],
      };
    }
    assert.equal(decision.action, "allow");
    writeFileSync(resolve(context.cwd, "approved.txt"), "ok");
    return {
      status: "completed",
      text: "第二次完成",
      files: [
        {
          path: "done.txt",
          kind: "text",
          op: "added",
          size: 2,
          sourceChatId: context.chatId,
          sourceTurnId: context.sourceTurnId,
        },
      ],
    };
  });
  const engine = env.make();
  await engine.tick();
  await waitFor(() => engine.store.allTasks()[0]?.status === "awaiting");
  const task = engine.store.allTasks()[0];
  assert.equal(
    (
      await engine.operation({
        convId: env.convId,
        requestId: "approve-1",
        op: "answer_approval",
        runId: task.runId,
        taskId: task.id,
        allow: true,
      })
    ).ok,
    true,
  );
  await engine.tick();
  await waitFor(() => engine.store.task(task.id)?.status === "succeeded");
  const finished = engine.store.task(task.id)!;
  assert.equal(finished.attempt, 2);
  assert.equal(finished.attempts[0].status, "awaiting");
  assert.equal(finished.attempts[1].status, "succeeded");
  assert.equal(calls, 2);
  assert.deepEqual(finished.approvedFingerprints, [
    authorizeHeadlessTool(
      {
        cwd: env.workspace,
        policy: "plane",
        approvalPolicy: "workspace_safe",
        approvedFingerprints: [],
      },
      "shell",
      { command: "touch approved.txt", working_directory: env.workspace },
    ).fingerprint,
  ]);
  assert.equal(finished.approvalDecisions?.[0]?.allow, true);
  assert.equal(finished.approvalDecisions?.[0]?.fingerprint, finished.approvedFingerprints?.[0]);
  assert.equal(finished.files?.[0]?.sourceChatId, finished.childChatId);
  assert.match(finished.summary || "", /第二次完成/);
});

test("审批拒绝使任务和 Run 失败，不会新建 attempt", async () => {
  const env = await setup(undefined, async (context) => {
    const decision = authorizeHeadlessTool(context, "shell", {
      command: "touch denied.txt",
      working_directory: context.cwd,
    });
    assert.equal(decision.action, "approval");
    return {
      status: "awaiting",
      text: "",
      approval: {
        id: "approval-deny",
        fingerprint: decision.fingerprint,
        summary: "需要审批",
        tool: "shell",
        expiresAt: Date.now() + 60_000,
      },
      files: [],
    };
  });
  const engine = env.make();
  await engine.tick();
  await waitFor(() => engine.store.allTasks()[0]?.status === "awaiting");
  const task = engine.store.allTasks()[0];
  const result = await engine.operation({
    convId: env.convId,
    requestId: "deny-1",
    op: "answer_approval",
    runId: task.runId,
    taskId: task.id,
    allow: false,
  });
  assert.equal(result.ok, true);
  assert.equal(engine.store.task(task.id)?.status, "failed");
  assert.equal(engine.store.task(task.id)?.attempt, 1);
  assert.equal(engine.store.run(task.runId)?.status, "failed");
});

test("Headless adapter 按租户启用 SDK 沙箱，并始终保留 confinedCwd/Auto-review/工具白名单", async () => {
  const env = await setup();
  let optionsSeen: Parameters<NonNullable<Parameters<typeof bindHeadlessRunHost>[0]["prompt"]>>[1] | undefined;
  bindHeadlessRunHost({
    apiKey: () => "cursor_test",
    prompt: async (_message, options) => {
      optionsSeen = options;
      writeFileSync(resolve(options.local?.cwd || "", "headless.txt"), "ok");
      return { status: "finished", result: "完成" } as RunResult;
    },
  });
  const result = await runHeadless(
    {
      tenant: env.tenant,
      chatId: "chat-headless",
      cwd: env.workspace,
      model: "test-model",
      mode: "agent",
      policy: "plane",
      dialect: true,
      clock: { now: Date.now(), tz: "UTC" },
      approvalPolicy: "workspace_safe",
    },
    "写文件",
    { onText() {}, onTool() {}, onApproval() {}, onFiles() {}, onDone() {} },
  );
  assert.equal(result.status, "completed");
  assert.equal(readFileSync(resolve(env.workspace, "headless.txt"), "utf8"), "ok");
  assert.equal(optionsSeen?.local?.autoReview, true);
  assert.equal(optionsSeen?.local?.sandboxOptions?.enabled, true);
  assert.ok(optionsSeen?.tools?.includes("edit"));
  assert.ok(!optionsSeen?.tools?.includes("task"));
  env.tenant.admin = true;
  env.tenant.sandbox = false;
  const trusted = await runHeadless(
    {
      tenant: env.tenant,
      chatId: "chat-headless-trusted",
      cwd: env.workspace,
      model: "test-model",
      mode: "agent",
      policy: "plane",
      dialect: true,
      clock: { now: Date.now(), tz: "UTC" },
      approvalPolicy: "workspace_safe",
    },
    "受信部署写文件",
    { onText() {}, onTool() {}, onApproval() {}, onFiles() {}, onDone() {} },
  );
  assert.equal(trusted.status, "completed");
  assert.equal(optionsSeen?.local?.sandboxOptions?.enabled, false);
  assert.ok(!optionsSeen?.tools?.includes("shell"));
  const escaped = await runHeadless(
    {
      tenant: env.tenant,
      chatId: "bad",
      cwd: root,
      model: "test-model",
      mode: "agent",
      policy: "plane",
      dialect: true,
      clock: { now: Date.now(), tz: "UTC" },
      approvalPolicy: "workspace_safe",
    },
    "越界",
    { onText() {}, onTool() {}, onApproval() {}, onFiles() {}, onDone() {} },
  );
  assert.equal(escaped.status, "failed");
});

test("Headless 工具授权不受 admin/sandbox:false 影响，拒绝越界读写、网络和危险命令", async () => {
  const cwd = resolve(root, "safe-workspace");
  mkdirSync(cwd, { recursive: true });
  const context = {
    cwd,
    policy: "plane" as const,
    approvalPolicy: "workspace_safe" as const,
    approvedFingerprints: [],
  };
  assert.equal(authorizeHeadlessTool(context, "read", { path: resolve(root, "secret") }).action, "deny");
  assert.equal(authorizeHeadlessTool(context, "edit", { path: "../escape", text: "x" }).action, "deny");
  assert.equal(
    authorizeHeadlessTool(context, "shell", { command: "cat /etc/passwd", working_directory: cwd }).action,
    "deny",
  );
  assert.equal(
    authorizeHeadlessTool(context, "shell", { command: "curl -X POST https://example.com", working_directory: cwd })
      .action,
    "deny",
  );
  assert.equal(
    authorizeHeadlessTool(context, "shell", { command: "sudo rm -rf /", working_directory: cwd }).action,
    "deny",
  );
  assert.equal(authorizeHeadlessTool(context, "shell", { command: "ls ..", working_directory: cwd }).action, "deny");
  assert.equal(
    authorizeHeadlessTool(context, "shell", { command: "git status --short", working_directory: cwd }).action,
    "deny",
  );
  assert.equal(
    authorizeHeadlessTool(context, "shell", { command: "git -C .. status", working_directory: cwd }).action,
    "deny",
  );
  const safeEdit = authorizeHeadlessTool(context, "edit", { path: resolve(cwd, "ok.txt"), text: "ok" });
  assert.equal(safeEdit.action, "allow");
});
