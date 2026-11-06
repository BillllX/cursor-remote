import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import {
  drainPending,
  handlePrompt,
  isTransientSdkError,
  MAX_SDK_TRANSIENT_RETRIES,
  promptModel,
  RUN_QUIET_AFTER_TURN_ENDED_MS,
  sdkRetryDelayMs,
  shouldArmRunWatchQuiet,
  waitWithSlotCheck,
} from "../src/chat/runner.ts";
import { retryable } from "../src/native/loop.ts";
import { isSlotActive, pruneDroppedSlots, runningChatIds } from "../src/runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../src/runtime/state.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";
import { allTenants } from "../src/tenants.ts";
import { onSyncState } from "../src/ws/handlers/state.ts";

// 租户名单是首次使用时才加载的：改成临时目录里的单租户，免得读到本机真实的 tenants.json
const dir = mkdtempSync(join(tmpdir(), "cr-runner-"));
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = "runner-test-token";
process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "test";
after(() => {
  gatewayState.conns.clear();
  rmSync(dir, { recursive: true, force: true });
});

const ws = {} as WebSocket;
const conn = {} as Conn;
const queued = () => ({ text: "下一条" }) as Slot["pending"][number];
function slotWith(fields: Partial<Slot>): Slot {
  return {
    chatId: "c",
    epoch: 1,
    pending: [queued()],
    finished: true,
    run: undefined,
    externalAbort: undefined,
    owner: null,
    ...fields,
  } as Slot;
}
const tick = () => new Promise((done) => setTimeout(done, 0));

describe("drainPending 排队守卫", () => {
  test("测试租户来自临时目录", () => {
    assert.deepEqual(
      allTenants().map((t) => t.workspaceRoot),
      [join(dir, "ws")],
    );
  });
  test("epoch 失配：过期栈不碰 pending", async () => {
    const slot = slotWith({ epoch: 2 });
    drainPending(ws, conn, slot, 1);
    await tick();
    assert.equal(slot.pending.length, 1);
  });
  test("还没收尾（finished=false）时消息留在队首", async () => {
    const slot = slotWith({ finished: false });
    drainPending(ws, conn, slot, 1);
    await tick();
    assert.equal(slot.pending.length, 1);
  });
  test("run 还在或第三方运行没结束时消息留在队首", async () => {
    const running = slotWith({ run: {} as Slot["run"] });
    const external = slotWith({ externalAbort: new AbortController() });
    drainPending(ws, conn, running, 1);
    drainPending(ws, conn, external);
    await tick();
    assert.equal(running.pending.length, 1);
    assert.equal(external.pending.length, 1);
  });
  test("本槽队列空时踢全局队列：没有 owner 或 owner 连接没开的槽位不出队", async () => {
    const tenant = allTenants()[0];
    const live = liveSlotsOf(tenant);
    const noOwner = slotWith({ chatId: "a" });
    const closedSock = { readyState: WebSocket.CLOSED } as WebSocket;
    const closedOwner = slotWith({ chatId: "b", owner: closedSock });
    gatewayState.conns.set(closedSock, { tenant } as Conn);
    live.set("a", noOwner);
    live.set("b", closedOwner);
    try {
      drainPending(ws, conn, slotWith({ pending: [] }), 1);
      await tick();
      assert.equal(noOwner.pending.length, 1);
      assert.equal(closedOwner.pending.length, 1);
    } finally {
      live.clear();
      gatewayState.conns.delete(closedSock);
    }
  });
});

describe("promptModel 本条消息用的模型", () => {
  test("排队时 slot.model 还是旧的，起标题要用这条消息选的模型", async () => {
    const slot = slotWith({
      run: {} as Slot["run"],
      pending: [],
      model: "cursor-old",
      openTools: new Map(),
    } as Partial<Slot>);
    const busyConn = { model: "conn-default", policy: undefined } as unknown as Conn;
    await handlePrompt(ws, busyConn, slot, "你好", "deepseek:deepseek-chat");
    assert.equal(slot.pending.length, 1);
    assert.equal(slot.model, "cursor-old");
    assert.equal(promptModel("deepseek:deepseek-chat", slot, busyConn), "deepseek:deepseek-chat");
  });
  test("消息没带模型时沿用会话，再退到连接的", () => {
    assert.equal(promptModel(" ", { model: "a" }, { model: "b" }), "a");
    assert.equal(promptModel(undefined, {}, { model: "b" }), "b");
  });
});

describe("任务防中断加固：瞬时错误识别、静默看门狗与活跃槽位保护", () => {
  test("isTransientSdkError 与 native retryable 识别 resource_exhausted、429、无进展恢复熔断与网络瞬断", () => {
    for (const sample of [
      new Error("[resource_exhausted] Error"),
      new Error("429 Too Many Requests"),
      new Error("rate_limit_exceeded"),
      new Error("Agent turn stopped after repeated resume attempts made no progress"),
      new Error("Service unavailable (503)"),
      new Error("read ECONNRESET"),
      "resource_exhausted",
    ]) {
      assert.equal(isTransientSdkError(sample), true, String(sample));
    }

    assert.equal(retryable(new Error("[resource_exhausted] Error")), true);
    assert.equal(retryable(new Error("rate_limit exceeded")), true);

    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    assert.equal(isTransientSdkError(abortErr), false);
    assert.equal(isTransientSdkError(new Error("语法错误：文件不存在")), false);
    assert.equal(isTransientSdkError(""), false);
  });

  test("shouldArmRunWatchQuiet：存在未完成工具或未收到 turn-ended 时绝不启动静默断流", () => {
    assert.equal(RUN_QUIET_AFTER_TURN_ENDED_MS, 20_000);
    assert.equal(MAX_SDK_TRANSIENT_RETRIES, 2);
    assert.equal(shouldArmRunWatchQuiet(false, 0), false);
    assert.equal(shouldArmRunWatchQuiet(true, 1), false);
    assert.equal(shouldArmRunWatchQuiet(true, 3), false);
    assert.equal(shouldArmRunWatchQuiet(true, 0), true);
  });

  test("waitWithSlotCheck：正常等待到期返回 true，中途取消或 epoch 变化立即中断返回 false", async () => {
    assert.equal(sdkRetryDelayMs(0, 100), 100);
    assert.equal(sdkRetryDelayMs(1, 100), 200);

    const activeSlot = { finished: false, epoch: 5 };
    const ok = await waitWithSlotCheck(activeSlot, 5, 30, 10);
    assert.equal(ok, true);

    const cancelSlot = { finished: false, epoch: 5 };
    setTimeout(() => {
      cancelSlot.finished = true;
    }, 15);
    const t0 = Date.now();
    const afterCancel = await waitWithSlotCheck(cancelSlot, 5, 500, 10);
    assert.equal(afterCancel, false);
    assert.ok(Date.now() - t0 < 250, "取消后应立即退出退避等待");
  });

  test("pruneDroppedSlots：保护正在运行、等待审批或有排队消息的活跃槽位不被跨端同步误杀", () => {
    const tenant = allTenants()[0];
    const live = liveSlotsOf(tenant);
    const idleDropped = slotWith({ chatId: "idle-drop", finished: true, pending: [] });
    const runningSlot = slotWith({ chatId: "running-keep", finished: false, pending: [] });
    const queuedSlot = slotWith({ chatId: "queued-keep", finished: true, pending: [queued()] });
    const keepSlot = slotWith({ chatId: "explicit-keep", finished: true, pending: [] });

    assert.equal(isSlotActive(idleDropped), false);
    assert.equal(isSlotActive(runningSlot), true);
    assert.equal(isSlotActive(queuedSlot), true);

    live.set("idle-drop", idleDropped);
    live.set("running-keep", runningSlot);
    live.set("queued-keep", queuedSlot);
    live.set("explicit-keep", keepSlot);
    tenant.disk.slots = [
      { chatId: "idle-drop", agentId: "a1", cwd: tenant.workspaceRoot, edited: [], checkpoints: [] },
      { chatId: "running-keep", agentId: "a2", cwd: tenant.workspaceRoot, edited: [], checkpoints: [] },
      { chatId: "queued-keep", agentId: "a3", cwd: tenant.workspaceRoot, edited: [], checkpoints: [] },
      { chatId: "explicit-keep", agentId: "a4", cwd: tenant.workspaceRoot, edited: [], checkpoints: [] },
    ];

    try {
      pruneDroppedSlots(tenant, new Set(["explicit-keep"]));
      assert.equal(live.has("idle-drop"), false, "空闲且不在 keepIds 中的槽位应被清理");
      assert.equal(live.has("running-keep"), true, "运行中的槽位必须保留");
      assert.equal(live.has("queued-keep"), true, "有排队消息的槽位必须保留");
      assert.equal(live.has("explicit-keep"), true);
      assert.deepEqual(
        tenant.disk.slots.map((s) => s.chatId).sort(),
        ["explicit-keep", "queued-keep", "running-keep"],
      );
    } finally {
      live.clear();
      tenant.disk.slots = [];
    }
  });

  test("onSyncState 与 runningChatIds：跨端旧快照漏带运行中会话时，不对其 tombstone，且退避重试窗口仍计入 runningChatIds", () => {
    const tenant = allTenants()[0];
    const live = liveSlotsOf(tenant);
    const backoffRunningSlot = slotWith({
      chatId: "chat-running-backoff",
      finished: false,
      run: null,
      pending: [],
      transcript: {
        turnId: "t-1",
        userText: "继续构建",
        assistant: "正在执行…",
        thinking: "",
        tools: [],
        phase: "running",
        epoch: 1,
        startedAt: Date.now(),
      },
    });
    const idleOldSlot = slotWith({
      chatId: "chat-idle-dropped",
      finished: true,
      run: null,
      pending: [],
    });

    live.set("chat-running-backoff", backoffRunningSlot);
    live.set("chat-idle-dropped", idleOldSlot);
    tenant.disk.rev = 1;
    tenant.disk.deletedIds = [];
    tenant.disk.chats = [
      { id: "chat-running-backoff", title: "运行中任务", turns: [{ id: "t-1", user: "继续构建", assistant: "正在执行…" }] },
      { id: "chat-idle-dropped", title: "旧空闲会话", turns: [] },
      { id: "chat-kept", title: "保留会话", turns: [] },
    ];

    try {
      assert.ok(
        runningChatIds(tenant).includes("chat-running-backoff"),
        "退避等待窗口（run=null 但 finished=false 且 transcript.phase=running）应计入 runningChatIds",
      );

      const mockWs = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
      const mockConn = { tenant, slots: live, ws: mockWs } as unknown as Conn;
      onSyncState(
        { ws: mockWs, conn: mockConn, state: gatewayState, tenant },
        {
          type: "sync_state",
          rev: 2,
          chats: [{ id: "chat-kept", title: "保留会话", turns: [] }],
        },
      );

      assert.equal(
        tenant.disk.deletedIds.includes("chat-running-backoff"),
        false,
        "运行中的会话绝不能被旧 sync_state 墓碑化",
      );
      assert.equal(
        tenant.disk.deletedIds.includes("chat-idle-dropped"),
        true,
        "已空闲且未上传的会话正常进入 deletedIds",
      );
      const remainingChatIds = tenant.disk.chats.map((c) => (c as { id: string }).id);
      assert.ok(remainingChatIds.includes("chat-running-backoff"), "运行中会话的磁盘记录必须保留");
      assert.ok(remainingChatIds.includes("chat-kept"));
    } finally {
      live.clear();
      tenant.disk.chats = [];
      tenant.disk.deletedIds = [];
      tenant.disk.slots = [];
    }
  });
});
