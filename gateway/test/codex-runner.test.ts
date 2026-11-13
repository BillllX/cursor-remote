import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { CodexOptions, Input, ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { WebSocket } from "ws";
import {
  buildCodexChildEnv,
  CODEX_MODEL_PREFIX,
  codexModelIds,
  codexRoute,
  type CodexClientLike,
  DEFAULT_CODEX_MODELS,
  formatCodexErrorMessage,
  hasCodexAuth,
  readCodexModelSlugs,
  runCodexChat,
} from "../src/chat/codexRunner.ts";
import { attachReseedContext } from "../src/chat/history.ts";
import { handlePrompt } from "../src/chat/runner.ts";
import { resolveApprovalWait } from "../src/runtime/approvals.ts";
import { persistTenant, slotOf } from "../src/runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../src/runtime/state.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";
import { allTenants, type Tenant } from "../src/tenants.ts";
import { usageSnapshot } from "../src/usage.ts";
import { onNewSession, onSetPolicy } from "../src/ws/handlers/sessions.ts";

const dir = mkdtempSync(join(tmpdir(), "cr-codex-test-"));
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = "codex-test-token";
process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "codex-test-secret";
process.env.CURSOR_REMOTE_SANDBOX = "0";

after(() => {
  gatewayState.conns.clear();
  rmSync(dir, { recursive: true, force: true });
});

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const res = fn();
    if (res && typeof (res as Promise<void>).then === "function") {
      return (res as Promise<void>).finally(restore);
    }
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}

function makeFakeWs() {
  const messages: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (raw: string) => {
      try {
        messages.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // ignore non-json frames
      }
    },
  } as unknown as WebSocket;
  return { ws, messages };
}

function makeConnAndSlot(
  chatId: string,
  tenantOverride?: Partial<Tenant>,
): {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  conn: Conn;
  slot: Slot;
  tenant: Tenant;
} {
  const baseTenant = allTenants()[0];
  const tenant: Tenant = tenantOverride ? { ...baseTenant, ...tenantOverride } : baseTenant;
  const { ws, messages } = makeFakeWs();
  gatewayState.wsTenant.set(ws, tenant.id);
  const conn: Conn = {
    cwd: tenant.workspaceRoot,
    model: "codex:gpt-6.1-sol",
    authed: true,
    ip: "127.0.0.1",
    tenant,
    slots: liveSlotsOf(tenant),
    ws,
    maxMessageBytes: 0,
    caps: new Set(),
    policy: "baseline",
  };
  gatewayState.conns.set(ws, conn);
  const slot = slotOf(conn, chatId);
  return { ws, messages, conn, slot, tenant };
}

describe("域 1：Codex 路由、认证检测、models_cache 解析与环境白名单隔离", () => {
  test("codexRoute 精确识别统一前缀 codex:<model>，拒绝空模型或非法字符", () => {
    assert.deepEqual(codexRoute("codex:gpt-6.1-sol"), {
      model: "gpt-6.1-sol",
      full: "codex:gpt-6.1-sol",
    });
    assert.deepEqual(codexRoute("  codex:gpt-5.6-sol  "), {
      model: "gpt-5.6-sol",
      full: "codex:gpt-5.6-sol",
    });
    assert.equal(codexRoute("codex:"), null);
    assert.equal(codexRoute("codex-cli:gpt-6.1-sol"), null);
    assert.equal(codexRoute("claude-opus-5-5"), null);
    assert.equal(codexRoute("minimax:MiniMax-M2"), null);
    assert.equal(codexRoute(null), null);
  });

  test("hasCodexAuth 与 codexModelIds：覆盖无凭证、损坏 auth.json、有效 auth.json、损坏/缺失 models_cache 回退及沙箱租户拦截", () => {
    const fakeHome = join(dir, "codex-home-test");
    mkdirSync(fakeHome, { recursive: true });

    // 1. 无 API Key 且无 auth.json -> 返回空数组
    withEnv({ CODEX_API_KEY: "", CODEX_HOME: fakeHome, CODEX_CLI_MODELS: "" }, () => {
      assert.equal(hasCodexAuth(), false);
      assert.deepEqual(codexModelIds({ sandbox: false, admin: true }), []);
    });

    // 2. auth.json 损坏（非法 JSON）-> 不抛错，返回 false
    writeFileSync(join(fakeHome, "auth.json"), "{bad-json", "utf8");
    withEnv({ CODEX_API_KEY: "", CODEX_HOME: fakeHome, CODEX_CLI_MODELS: "" }, () => {
      assert.equal(hasCodexAuth(), false);
      assert.deepEqual(codexModelIds({ sandbox: false, admin: true }), []);
    });

    // 3. 写入合法 ChatGPT OAuth auth.json（含 refresh_token），models_cache.json 缺失时回退 DEFAULT_CODEX_MODELS
    writeFileSync(
      join(fakeHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "acc-123", refresh_token: "ref-456" },
      }),
      "utf8",
    );
    withEnv({ CODEX_API_KEY: "", CODEX_HOME: fakeHome, CODEX_CLI_MODELS: "" }, () => {
      assert.equal(hasCodexAuth(), true);
      assert.deepEqual(
        codexModelIds({ sandbox: false, admin: true }),
        DEFAULT_CODEX_MODELS.map((m) => `${CODEX_MODEL_PREFIX}${m}`),
      );
      // 沙箱受限租户严禁暴露任何 codex 模型
      assert.deepEqual(codexModelIds({ sandbox: true, admin: false }), []);
    });

    // 4. 写入有效 models_cache.json（过滤 hide 模型与非法项）
    writeFileSync(
      join(fakeHome, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-6.1-sol", visibility: "list" },
          { slug: "gpt-6-astra", visibility: "list" },
          { slug: "hidden-internal", visibility: "hide" },
          { slug: "../bad/slug", visibility: "list" },
        ],
      }),
      "utf8",
    );
    withEnv({ CODEX_API_KEY: "", CODEX_HOME: fakeHome, CODEX_CLI_MODELS: "" }, () => {
      assert.deepEqual(readCodexModelSlugs(), ["gpt-6.1-sol", "gpt-6-astra"]);
      assert.deepEqual(codexModelIds({ sandbox: false, admin: true }), ["codex:gpt-6.1-sol", "codex:gpt-6-astra"]);
    });

    // 5. CODEX_CLI_MODELS 显式覆盖优先
    withEnv({ CODEX_API_KEY: "sk-test", CODEX_HOME: fakeHome, CODEX_CLI_MODELS: "gpt-6.1-terra, gpt-5.6-sol" }, () => {
      assert.deepEqual(codexModelIds({ sandbox: false, admin: true }), ["codex:gpt-6.1-terra", "codex:gpt-5.6-sol"]);
    });
  });

  test("buildCodexChildEnv 剥离网关敏感密钥并显式绑定 CODEX_HOME", () => {
    const fakeHome = join(dir, "codex-env-home");
    withEnv(
      {
        CODEX_HOME: fakeHome,
        CURSOR_API_KEY: "secret-cursor-key",
        APNS_PRIVATE_KEY: "secret-apns-key",
        CURSOR_REMOTE_MEDIA_SECRET: "secret-media",
      },
      () => {
        const childEnv = buildCodexChildEnv();
        assert.equal(childEnv.CODEX_HOME, resolve(fakeHome));
        assert.equal("CURSOR_API_KEY" in childEnv, false);
        assert.equal("APNS_PRIVATE_KEY" in childEnv, false);
        assert.equal("CURSOR_REMOTE_MEDIA_SECRET" in childEnv, false);
      },
    );
  });
});

describe("域 2：流式事件增量切片、工具映射、4 参数 Token 计量与防重复 captureText", () => {
  test("item.updated 累加全文切片为增量 delta，工具完成时计 1 次 noteToolCall，Loop captureText 不重复", async () => {
    const { ws, messages, conn, slot, tenant } = makeConnAndSlot("chat-codex-stream");
    const beforeUsage = usageSnapshot(tenant.id);

    let capturedLoopText = "";
    slot.captureText = (chunk) => {
      capturedLoopText += chunk;
    };

    let capturedThreadOpts: ThreadOptions | undefined;
    let capturedCodexOpts: CodexOptions | undefined;

    const fakeCodex: CodexClientLike = {
      startThread(opts) {
        capturedThreadOpts = opts;
        return {
          async runStreamed() {
            async function* gen(): AsyncGenerator<ThreadEvent> {
              yield { type: "thread.started", thread_id: "thread-codex-101" };
              yield { type: "turn.started" };
              yield {
                type: "item.started",
                item: { id: "r1", type: "reasoning", text: "先思考" },
              };
              yield {
                type: "item.updated",
                item: { id: "r1", type: "reasoning", text: "先思考一下架构" },
              };
              yield {
                type: "item.completed",
                item: { id: "r1", type: "reasoning", text: "先思考一下架构。" },
              };
              yield {
                type: "item.started",
                item: {
                  id: "cmd1",
                  type: "command_execution",
                  command: "echo hello",
                  aggregated_output: "",
                  status: "in_progress",
                },
              };
              yield {
                type: "item.updated",
                item: {
                  id: "cmd1",
                  type: "command_execution",
                  command: "echo hello",
                  aggregated_output: "hello\n",
                  status: "in_progress",
                },
              };
              yield {
                type: "item.completed",
                item: {
                  id: "cmd1",
                  type: "command_execution",
                  command: "echo hello",
                  aggregated_output: "hello\nworld\n",
                  exit_code: 0,
                  status: "completed",
                },
              };
              yield {
                type: "item.started",
                item: { id: "m1", type: "agent_message", text: "第一段" },
              };
              yield {
                type: "item.updated",
                item: { id: "m1", type: "agent_message", text: "第一段，第二段" },
              };
              yield {
                type: "item.completed",
                item: { id: "m1", type: "agent_message", text: "第一段，第二段，完毕。" },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 300,
                  cache_write_input_tokens: 0,
                  output_tokens: 80,
                  reasoning_output_tokens: 20,
                },
              };
            }
            return { events: gen() };
          },
        };
      },
      resumeThread() {
        throw new Error("首轮不应调用 resumeThread");
      },
    };

    const epoch = ++slot.epoch;
    slot.finished = false;
    slot.agentId = "cursor-agent-keep-alive";

    await runCodexChat(
      ws,
      conn,
      slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "测试流式输出",
        userText: "测试流式输出",
        images: [],
        history: [],
        epoch,
        cwd: tenant.workspaceRoot,
        mode: "agent",
        confirmWrites: false,
        autoApprove: false,
      },
      {
        createCodex: (opts) => {
          capturedCodexOpts = opts;
          return fakeCodex;
        },
      },
    );

    // 验证 ThreadOptions 包含 skipGitRepoCheck: true、danger-full-access 与 networkAccessEnabled: true（与 Cursor CLI 关闭沙箱一致）
    assert.equal(capturedThreadOpts?.skipGitRepoCheck, true);
    assert.equal(capturedThreadOpts?.sandboxMode, "danger-full-access");
    assert.equal(capturedThreadOpts?.networkAccessEnabled, true);
    assert.equal(capturedThreadOpts?.approvalPolicy, "never");
    assert.ok(capturedCodexOpts?.env?.CODEX_HOME);

    // 验证 text-delta 切片不重复，且 captureText 只被 send.ts 触发一次
    const textDeltas = messages.filter((m) => m.type === "text-delta").map((m) => m.text);
    assert.deepEqual(textDeltas, ["第一段", "，第二段", "，完毕。"]);
    assert.equal(capturedLoopText, "第一段，第二段，完毕。");

    // 验证 thinking-delta 切片不重复
    const thinkingDeltas = messages.filter((m) => m.type === "thinking-delta").map((m) => m.text);
    assert.deepEqual(thinkingDeltas, ["先思考", "一下架构", "。"]);

    // 验证 slot.agentId 未被覆盖，codexThreadId 已独立保存并持久化
    assert.equal(slot.agentId, "cursor-agent-keep-alive");
    assert.equal(slot.codexThreadId, "thread-codex-101");
    assert.equal(slot.lastEngine, "codex");

    // 验证 4 参数 Token 计量与工具调用次数（仅完成计 1 次）
    const afterUsage = usageSnapshot(tenant.id);
    assert.equal(afterUsage.modelInTokens - beforeUsage.modelInTokens, 1200);
    assert.equal(afterUsage.modelOutTokens - beforeUsage.modelOutTokens, 80);
    assert.equal(afterUsage.modelCacheTokens - beforeUsage.modelCacheTokens, 300);
    assert.equal(afterUsage.toolCalls - beforeUsage.toolCalls, 1);
  });
});

describe("域 3：跨引擎互切 Reseed（含 safeHistory 兜底）、同引擎续轮与 4 处重置清理", () => {
  test("attachReseedContext 在磁盘 turns 未落盘时自动回退使用客户端上行 history", () => {
    const tenant = allTenants()[0];
    const reseeded = attachReseedContext(tenant, "chat-unsynced", "现在切到 Codex 继续", "当前包装请求", [
      { role: "user", text: "第一轮在 Cursor 提问" },
      { role: "assistant", text: "第一轮 Cursor 回答了方案 A" },
    ]);
    assert.ok(reseeded.includes("第一轮在 Cursor 提问"));
    assert.ok(reseeded.includes("第一轮 Cursor 回答了方案 A"));
    assert.ok(reseeded.includes("当前包装请求"));
  });

  test("从 Cursor 切到 Codex 时清空旧 codexThreadId 并注入 Reseed；同引擎第 2 轮调用 resumeThread 并用 compactPrompt", async () => {
    const { ws, conn, slot, tenant } = makeConnAndSlot("chat-cross-engine");
    slot.lastEngine = "cursor";
    slot.codexThreadId = "stale-codex-thread";

    const calls: Array<{ method: "start" | "resume"; id?: string; input: Input }> = [];
    const fakeCodex: CodexClientLike = {
      startThread() {
        return {
          async runStreamed(input) {
            calls.push({ method: "start", input });
            async function* gen(): AsyncGenerator<ThreadEvent> {
              yield { type: "thread.started", thread_id: "fresh-codex-thread-202" };
              yield {
                type: "item.completed",
                item: { id: "m1", type: "agent_message", text: "第一轮 Codex 回复" },
              };
            }
            return { events: gen() };
          },
        };
      },
      resumeThread(id) {
        return {
          async runStreamed(input) {
            calls.push({ method: "resume", id, input });
            async function* gen(): AsyncGenerator<ThreadEvent> {
              yield {
                type: "item.completed",
                item: { id: "m2", type: "agent_message", text: "第二轮续跑回复" },
              };
            }
            return { events: gen() };
          },
        };
      },
    };

    // 第 1 轮：从 cursor 切到 codex -> 必须丢弃 stale-codex-thread 走 startThread，且包含 history 摘录
    const epoch1 = ++slot.epoch;
    slot.finished = false;
    await runCodexChat(
      ws,
      conn,
      slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "FULL_PROMPT_1",
        compactPrompt: "COMPACT_PROMPT_1",
        userText: "接着做",
        images: [],
        history: [
          { role: "user", text: "之前在 Cursor 聊的内容" },
          { role: "assistant", text: "Cursor 给出的结论" },
        ],
        epoch: epoch1,
        cwd: tenant.workspaceRoot,
        mode: "agent",
        confirmWrites: false,
        autoApprove: false,
      },
      { createCodex: () => fakeCodex },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "start");
    assert.ok(typeof calls[0].input === "string" && calls[0].input.includes("之前在 Cursor 聊的内容"));
    assert.equal(slot.codexThreadId, "fresh-codex-thread-202");
    assert.equal(slot.lastEngine, "codex");

    // 第 2 轮：同引擎续轮 -> 走 resumeThread("fresh-codex-thread-202") 且使用瘦身后的 COMPACT_PROMPT_2
    const epoch2 = ++slot.epoch;
    slot.finished = false;
    await runCodexChat(
      ws,
      conn,
      slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "FULL_PROMPT_2",
        compactPrompt: "COMPACT_PROMPT_2",
        userText: "继续下一句",
        images: [],
        history: [],
        epoch: epoch2,
        cwd: tenant.workspaceRoot,
        mode: "agent",
        confirmWrites: false,
        autoApprove: false,
      },
      { createCodex: () => fakeCodex },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "resume");
    assert.equal(calls[1].id, "fresh-codex-thread-202");
    assert.equal(calls[1].input, "COMPACT_PROMPT_2");

    // 验证持久化与 onNewSession / onSetPolicy 清空 codexThreadId
    persistTenant(tenant, conn.slots);
    const savedSlot = tenant.disk.slots.find((s) => s.chatId === "chat-cross-engine");
    assert.equal(savedSlot?.codexThreadId, "fresh-codex-thread-202");

    await onSetPolicy(
      { ws, conn, state: gatewayState, tenant },
      { type: "set_policy", chatId: slot.chatId, policy: "plane" },
    );
    assert.equal(slot.codexThreadId, null);

    slot.codexThreadId = "thread-before-new-session";
    await onNewSession({ ws, conn, state: gatewayState, tenant }, { type: "new_session", chatId: slot.chatId });
    assert.equal(slot.codexThreadId, null);
    assert.equal(slot.lastEngine, undefined);
  });
});

describe("域 4–6：关闭内置沙箱与 Cursor CLI 对齐、confirmWrites 事前审批卡、图片临时文件清理与异常/取消不死锁", () => {
  test("非沙箱管理员租户统一使用 danger-full-access 关闭内置沙箱并开启网络访问；受限沙箱租户直接拦截", async () => {
    const { ws, conn, slot, tenant } = makeConnAndSlot("chat-plan-readonly");
    let modeUsed: string | undefined;
    let netEnabled: boolean | undefined;
    const fakeCodex: CodexClientLike = {
      startThread(opts) {
        modeUsed = opts?.sandboxMode;
        netEnabled = opts?.networkAccessEnabled;
        return {
          async runStreamed() {
            async function* gen(): AsyncGenerator<ThreadEvent> {
              yield { type: "thread.started", thread_id: "t-plan" };
            }
            return { events: gen() };
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected");
      },
    };

    const epoch = ++slot.epoch;
    slot.finished = false;
    await runCodexChat(
      ws,
      conn,
      slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "出个计划",
        userText: "出个计划",
        images: [],
        history: [],
        epoch,
        cwd: tenant.workspaceRoot,
        mode: "plan",
        confirmWrites: false,
        autoApprove: false,
      },
      { createCodex: () => fakeCodex },
    );
    assert.equal(modeUsed, "danger-full-access");
    assert.equal(netEnabled, true);

    // 沙箱受限租户调用时拒绝启动 Codex
    const sandboxed = makeConnAndSlot("chat-sandboxed-block", { sandbox: true, admin: false });
    const sbEpoch = ++sandboxed.slot.epoch;
    sandboxed.slot.finished = false;
    let spawnedForSandbox = false;
    await runCodexChat(
      sandboxed.ws,
      sandboxed.conn,
      sandboxed.slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "尝试越权",
        userText: "尝试越权",
        images: [],
        history: [],
        epoch: sbEpoch,
        cwd: sandboxed.tenant.workspaceRoot,
        mode: "ask",
        confirmWrites: false,
        autoApprove: false,
      },
      {
        createCodex: () => {
          spawnedForSandbox = true;
          return fakeCodex;
        },
      },
    );
    assert.equal(spawnedForSandbox, false, "受限沙箱租户严禁拉起 Codex 子进程");
    assert.equal(sandboxed.slot.finished, true);
    assert.ok(sandboxed.messages.some((m) => m.type === "error"));
  });

  test("Agent 模式开启 confirmWrites 时先发含 callId/name 的标准 approval 卡，拒绝时不启动子进程", async () => {
    const { ws, messages, conn, slot, tenant } = makeConnAndSlot("chat-confirm-writes");
    let spawned = false;
    const fakeCodex: CodexClientLike = {
      startThread() {
        spawned = true;
        return {
          async runStreamed() {
            async function* gen(): AsyncGenerator<ThreadEvent> {}
            return { events: gen() };
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected");
      },
    };

    const epoch = ++slot.epoch;
    slot.finished = false;
    setTimeout(() => {
      resolveApprovalWait(slot, false);
    }, 20);

    await runCodexChat(
      ws,
      conn,
      slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "改文件",
        userText: "改文件",
        images: [],
        history: [],
        epoch,
        cwd: tenant.workspaceRoot,
        mode: "agent",
        confirmWrites: true,
        autoApprove: false,
      },
      { createCodex: () => fakeCodex },
    );

    const approvalMsg = messages.find((m) => m.type === "approval");
    assert.ok(approvalMsg, "应发出标准 approval 卡片");
    assert.equal(approvalMsg.callId, `codex-write-${epoch}`);
    assert.equal(approvalMsg.name, "codex_workspace_write");
    assert.equal(spawned, false, "用户拒绝写入后严禁启动 Codex 写子进程");
    assert.equal(slot.finished, true);
    assert.equal(slot.externalAbort, null);
  });

  test("图片附件落盘为 local_image 传给 SDK，流内抛错（含 401 提示）后 finally 自动清理临时图片且不死锁", async () => {
    const { ws, messages, conn, slot, tenant } = makeConnAndSlot("chat-image-error-cleanup");
    let receivedInput: Input | undefined;
    let receivedTurnOpts: TurnOptions | undefined;
    let fileExistedDuringRun = false;

    const fakeCodex: CodexClientLike = {
      startThread() {
        return {
          async runStreamed(input, turnOpts) {
            receivedInput = input;
            receivedTurnOpts = turnOpts;
            if (Array.isArray(input) && input[1]?.type === "local_image") {
              fileExistedDuringRun = existsSync(input[1].path);
            }
            async function* gen(): AsyncGenerator<ThreadEvent> {
              yield {
                type: "turn.failed",
                error: { message: "401 Unauthorized: token_expired" },
              };
            }
            return { events: gen() };
          },
        };
      },
      resumeThread() {
        throw new Error("unexpected");
      },
    };

    const epoch = ++slot.epoch;
    slot.finished = false;
    const tinyPngBase64 = Buffer.from("fake-png-bytes").toString("base64");

    await runCodexChat(
      ws,
      conn,
      slot,
      { model: "gpt-6.1-sol", full: "codex:gpt-6.1-sol" },
      {
        prompt: "看图说话",
        userText: "看图说话",
        images: [{ data: tinyPngBase64, mimeType: "image/png" }],
        history: [],
        epoch,
        cwd: tenant.workspaceRoot,
        mode: "ask",
        confirmWrites: false,
        autoApprove: false,
      },
      { createCodex: () => fakeCodex },
    );

    assert.equal(fileExistedDuringRun, true, "运行期间临时图片文件应存在于磁盘");
    assert.ok(receivedTurnOpts?.signal instanceof AbortSignal, "runStreamed 第二参应传入 { signal }");
    if (Array.isArray(receivedInput) && receivedInput[1]?.type === "local_image") {
      assert.equal(existsSync(receivedInput[1].path), false, "finally 应清理临时图片文件");
    }
    const tmpImgDir = join(tenant.stateDir, "codex-tmp-images");
    if (existsSync(tmpImgDir)) {
      assert.equal(readdirSync(tmpImgDir).length, 0);
    }

    assert.equal(slot.finished, true);
    assert.equal(slot.externalAbort, null);
    const errMsg = messages.find((m) => m.type === "error");
    assert.ok(errMsg && typeof errMsg.message === "string" && errMsg.message.includes("codex login"));
    assert.ok(formatCodexErrorMessage("401 unauthorized").includes("codex login"));
  });

  test("handlePrompt 完整集成：当 fresh=true 时清空 codexThreadId", async () => {
    const { ws, conn, slot } = makeConnAndSlot("chat-fresh-reset");
    slot.codexThreadId = "old-thread-999";
    slot.lastEngine = "codex";
    // 置为忙碌态使 handlePrompt 在完成 fresh 重置后进入排队并立即返回
    const fakeHome = join(dir, "no-auth-home");
    mkdirSync(fakeHome, { recursive: true });
    await withEnv({ CODEX_API_KEY: "", CODEX_HOME: fakeHome }, async () => {
      await handlePrompt(
        ws,
        conn,
        slot,
        "新对话首句",
        "codex:gpt-6.1-sol",
        "ask",
        undefined,
        undefined,
        false,
        false,
        true, // fresh = true
      );
    });
    assert.equal(slot.codexThreadId, null, "fresh=true 必须清空 codexThreadId");
    assert.equal(slot.finished, true);
  });
});
