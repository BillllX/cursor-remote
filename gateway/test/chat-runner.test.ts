import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import {
  ASSISTANT_ROLL_TURNS,
  buildPromptSeedKey,
  buildSdkContinuationPrompt,
  drainPending,
  handlePrompt,
  isTransientSdkError,
  MAX_SDK_TRANSIENT_RETRIES,
  promptModel,
  RUN_QUIET_AFTER_TURN_ENDED_MS,
  SDK_CONTINUATION_PROMPT,
  SDK_LARGE_WRITE_CONTINUATION_HINT,
  sdkRetryDelayMs,
  SESSION_ROLL_CONTEXT_CHARS,
  shouldArmRunWatchQuiet,
  shouldRollSdkSession,
  waitWithSlotCheck,
  WORKSPACE_ROLL_TURNS,
} from "../src/chat/runner.ts";
import {
  extractSafeCanvasRel,
  readWorkspaceFile,
  readWorkspaceFileAsync,
  resolveCanvasFallback,
} from "../src/workspace/files.ts";
import { diskChatContextStats } from "../src/chat/history.ts";
import {
  loadDynamicMemoryContext,
  loadStaticRulesFingerprint,
  loadWorkspaceRules,
  wrapFollowupPrompt,
  wrapPrompt,
} from "../src/chat/prompt.ts";
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
      assert.deepEqual(tenant.disk.slots.map((s) => s.chatId).sort(), ["explicit-keep", "queued-keep", "running-keep"]);
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
      {
        id: "chat-running-backoff",
        title: "运行中任务",
        turns: [{ id: "t-1", user: "继续构建", assistant: "正在执行…" }],
      },
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

describe("对话提速：第一步（子工作区按轮数/体积自动无感换壳）与第二步（同会话重复 Prompt 瘦身）", () => {
  test("shouldRollSdkSession 与 diskChatContextStats：子工作区满 15 轮或累计工具上下文达 800KB 即触发换壳，审批续跑期间不换壳", () => {
    assert.equal(ASSISTANT_ROLL_TURNS, 40);
    assert.equal(WORKSPACE_ROLL_TURNS, 15);
    assert.equal(SESSION_ROLL_CONTEXT_CHARS, 800_000);

    // 1. 子工作区未满 15 轮且体积未超 800KB 时不换壳
    assert.equal(
      shouldRollSdkSession({
        isAssistant: false,
        hasAgent: true,
        turns: 14,
        lastRolledTurn: 0,
        contextCharsSinceRoll: 120_000,
      }),
      false,
    );

    // 2. 子工作区满 15 轮自动换壳
    assert.equal(
      shouldRollSdkSession({
        isAssistant: false,
        hasAgent: true,
        turns: 15,
        lastRolledTurn: 0,
        contextCharsSinceRoll: 120_000,
      }),
      true,
    );

    // 3. 刚在 15 轮换过壳，第 15 轮不再重复换，到 30 轮再次换壳
    assert.equal(
      shouldRollSdkSession({
        isAssistant: false,
        hasAgent: true,
        turns: 15,
        lastRolledTurn: 15,
        contextCharsSinceRoll: 0,
      }),
      false,
    );
    assert.equal(
      shouldRollSdkSession({
        isAssistant: false,
        hasAgent: true,
        turns: 30,
        lastRolledTurn: 15,
        contextCharsSinceRoll: 50_000,
      }),
      true,
    );

    // 4. 轮数虽只有 3 轮，但单轮重度工具输出累计达 800KB 时提前换壳
    assert.equal(
      shouldRollSdkSession({
        isAssistant: false,
        hasAgent: true,
        turns: 3,
        lastRolledTurn: 0,
        contextCharsSinceRoll: 850_000,
      }),
      true,
    );

    // 5. autoApprove 或 keepTranscript 期间绝不打断换壳
    assert.equal(
      shouldRollSdkSession({
        isAssistant: false,
        hasAgent: true,
        autoApprove: true,
        turns: 20,
        lastRolledTurn: 0,
        contextCharsSinceRoll: 900_000,
      }),
      false,
    );

    // 6. diskChatContextStats 按 sinceTurn 精确统计增量轮数与工具体积
    const tenant = allTenants()[0];
    const bigToolOutput = "x".repeat(300_000);
    tenant.disk.chats = [
      {
        id: "chat-heavy",
        turns: [
          {
            id: "t1",
            user: "第一轮",
            assistant: "完成1",
            tools: [{ callId: "1", name: "read", result: bigToolOutput }],
          },
          {
            id: "t2",
            user: "第二轮",
            assistant: "完成2",
            tools: [{ callId: "2", name: "shell", result: bigToolOutput }],
          },
          {
            id: "t3",
            user: "第三轮",
            assistant: "完成3",
            tools: [{ callId: "3", name: "read", result: bigToolOutput }],
          },
        ],
      },
    ];
    try {
      const fromZero = diskChatContextStats(tenant, "chat-heavy", 0);
      assert.equal(fromZero.turns, 3);
      assert.equal(fromZero.turnsSinceRoll, 3);
      assert.equal(fromZero.toolCallsSinceRoll, 3);
      assert.ok(fromZero.contextCharsSinceRoll >= 900_000);

      const fromTwo = diskChatContextStats(tenant, "chat-heavy", 2);
      assert.equal(fromTwo.turns, 3);
      assert.equal(fromTwo.turnsSinceRoll, 1);
      assert.equal(fromTwo.toolCallsSinceRoll, 1);
      assert.ok(fromTwo.contextCharsSinceRoll >= 300_000 && fromTwo.contextCharsSinceRoll < 350_000);
    } finally {
      tenant.disk.chats = [];
    }
  });

  test("wrapFollowupPrompt 与 buildPromptSeedKey：同 agentId 后续轮次剔除重复静态 AGENTS.md 与固定长模板，体积缩减 >75%，规则或模式变更时指纹自动失效", () => {
    const tenant = allTenants()[0];
    const subWs = join(tenant.workspaceRoot, "proj-speed");
    mkdirSync(join(subWs, ".jiebo"), { recursive: true });
    writeFileSync(
      join(subWs, "AGENTS.md"),
      "# 项目硬约束\n" + "- 静态长规则条目，首轮已注入后无需每轮重复发送。\n".repeat(80),
      "utf8",
    );
    writeFileSync(
      join(subWs, ".jiebo", "memory.md"),
      "# 工作区记忆\n\n## 命令\n- 构建命令使用 npm run build <!-- id=wm1 at=2026-11-09 -->\n",
      "utf8",
    );

    const fullRules = loadWorkspaceRules(subWs, tenant, "构建命令");
    const fullPrompt = wrapPrompt("继续吧", "agent", undefined, fullRules, subWs, [], false, true);
    const dynMemory = loadDynamicMemoryContext(subWs, tenant, "构建命令");
    const compact = wrapFollowupPrompt("继续吧", "agent", undefined, dynMemory, subWs, true);

    assert.ok(fullPrompt.length > 2500, `完整 Prompt 应包含全部静态规则（实际 ${fullPrompt.length}）`);
    assert.ok(
      compact.length < fullPrompt.length * 0.25,
      `紧凑续接 Prompt 应缩减 75% 以上（实际 ${compact.length} vs ${fullPrompt.length}）`,
    );
    assert.ok(compact.includes("npm run build"), "紧凑续接 Prompt 仍须保留当前轮次动态匹配的 .jiebo/memory.md");
    assert.ok(compact.includes("继续吧"), "紧凑续接 Prompt 包含用户本轮输入");

    const hash1 = loadStaticRulesFingerprint(subWs, tenant);
    const key1 = buildPromptSeedKey({
      agentId: "agent-1",
      cwd: subWs,
      mode: "agent",
      staticRulesHash: hash1,
      assistantBlock: "",
      dialect: true,
      panelKey: "",
    });
    // 修改 AGENTS.md 后静态指纹立刻变化，触发重新发送完整 Prompt
    writeFileSync(join(subWs, "AGENTS.md"), "# 项目硬约束（已更新）\n- 新规则\n", "utf8");
    const hash2 = loadStaticRulesFingerprint(subWs, tenant);
    assert.notEqual(hash1, hash2, "AGENTS.md 变更后静态规则哈希必须立即更新");
    const key2 = buildPromptSeedKey({
      agentId: "agent-1",
      cwd: subWs,
      mode: "agent",
      staticRulesHash: hash2,
      assistantBlock: "",
      dialect: true,
      panelKey: "",
    });
    assert.notEqual(key1, key2);
  });

  test("大文件生成防呆守卫与自动续跑提示词：thinking 后未成功发出 tool_call 中断时自动追加小步/脚本生成提醒", () => {
    assert.equal(buildSdkContinuationPrompt(false), SDK_CONTINUATION_PROMPT);
    assert.equal(
      buildSdkContinuationPrompt(true),
      `${SDK_CONTINUATION_PROMPT}${SDK_LARGE_WRITE_CONTINUATION_HINT}`,
    );
    assert.ok(buildSdkContinuationPrompt(true).includes("若刚才因单次写入内容过大导致流中断"));

    const wrapped = wrapPrompt("生成三农信台账", "agent", undefined, "", "/tmp/ws/Fintopia集团", [], false, false);
    assert.ok(wrapped.includes("大文件生成防呆守卫"), "wrapPrompt 应包含大文件生成防呆守卫");
    assert.ok(wrapped.includes("15KB / 300 行"), "wrapPrompt 应指明 15KB / 300 行阈值");
    assert.ok(wrapped.includes("never prefix with ../"), "wrapPrompt 应明确禁止 ../ 前缀画布路径");
  });

  test("子工作区画布路径归一化与根工作区安全回退：支持 ../../.cursor-remote/canvases/ 与租户根回退，同时拒绝越界目录穿越", async () => {
    const tenant = allTenants()[0];
    const rootWs = tenant.workspaceRoot;
    const subWs = join(rootWs, "Fintopia集团");
    mkdirSync(join(rootWs, ".cursor-remote", "canvases"), { recursive: true });
    mkdirSync(subWs, { recursive: true });
    const rootCanvasAbs = join(rootWs, ".cursor-remote", "canvases", "sannongxin-demo.canvas.tsx");
    writeFileSync(rootCanvasAbs, "export default function Demo() { return null; }\n", "utf8");

    try {
      assert.equal(
        extractSafeCanvasRel("../../.cursor-remote/canvases/sannongxin-demo.canvas.tsx", rootWs),
        ".cursor-remote/canvases/sannongxin-demo.canvas.tsx",
      );
      assert.equal(
        extractSafeCanvasRel(`${rootWs}/.cursor-remote/canvases/sannongxin-demo.canvas.tsx`, rootWs),
        ".cursor-remote/canvases/sannongxin-demo.canvas.tsx",
      );
      // 严禁利用画布白名单穿透其他文件或子目录
      assert.equal(extractSafeCanvasRel("../../.cursor-remote/canvases/../secret.txt", rootWs), null);
      assert.equal(extractSafeCanvasRel("../../etc/passwd", rootWs), null);

      const resolved = resolveCanvasFallback(subWs, "../../.cursor-remote/canvases/sannongxin-demo.canvas.tsx", rootWs);
      assert.ok(resolved);
      assert.equal(resolved.path, ".cursor-remote/canvases/sannongxin-demo.canvas.tsx");
      assert.equal(resolved.abs, rootCanvasAbs);

      const syncRead = readWorkspaceFile(subWs, ".cursor-remote/canvases/sannongxin-demo.canvas.tsx");
      assert.equal(syncRead.error, undefined);
      assert.equal(syncRead.path, ".cursor-remote/canvases/sannongxin-demo.canvas.tsx");
      assert.ok(syncRead.content?.includes("export default function Demo"));

      const asyncRead = await readWorkspaceFileAsync(subWs, "../../.cursor-remote/canvases/sannongxin-demo.canvas.tsx");
      assert.equal(asyncRead.error, undefined);
      assert.equal(asyncRead.path, ".cursor-remote/canvases/sannongxin-demo.canvas.tsx");
      assert.ok(asyncRead.content?.includes("export default function Demo"));
    } finally {
      rmSync(rootCanvasAbs, { force: true });
    }
  });
});
