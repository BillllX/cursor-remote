import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  pickReviewPanel,
  rankModelsByFreshness,
  scoreModelFreshness,
  wantsMultiModelReview,
} from "../../shared/crew.ts";
import {
  bindBackground,
  modelAvailable,
  resolveBackgroundModelChain,
  resolvePreferredBackgroundModel,
  runBackground,
} from "../src/assistant/background.ts";
import { writeSettings } from "../src/assistant/memory.ts";
import {
  clearModelHealth,
  isModelHealthy,
  listUnhealthyModels,
  MODEL_BLOCKED_TTL_MS,
  MODEL_COOLDOWN_TTL_MS,
  recordModelFailure,
  recordModelSuccess,
} from "../src/chat/modelHealth.ts";
import { listModels } from "../src/chat/models.ts";
import { buildReviewSource, REVIEW_TIMEOUT_MS, runReviewPanel } from "../src/chat/review.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";

const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

describe("listModels", () => {
  test("列表先返回时清掉超时定时器，不留挂着的 Timeout", async () => {
    const before = timeouts();
    const ids = await listModels("key", async () => [{ id: "m1" }, { id: "" }, { id: "m2" }], 60_000);
    assert.deepEqual(ids, ["m1", "m2"]);
    assert.equal(timeouts(), before);
  });
});

describe("multi-model review & freshness ranking (review.ts & crew.ts)", () => {
  test("默认评审超时已调整为 10 分钟", () => {
    assert.equal(REVIEW_TIMEOUT_MS, 10 * 60_000);
  });

  test("wantsMultiModelReview 同时识别中文与带空格英文触发词", () => {
    assert.equal(wantsMultiModelReview("多模型再评审下这个方案"), true);
    assert.equal(wantsMultiModelReview("请用多个模型审一下"), true);
    assert.equal(wantsMultiModelReview("Please review this plan with multiple models"), true);
    assert.equal(wantsMultiModelReview("Use different models to review"), true);
    assert.equal(wantsMultiModelReview("帮我改一下这个文件"), false);
  });

  test("scoreModelFreshness 与 rankModelsByFreshness 优先选择同厂商代数最新、非 lite 的旗舰模型", () => {
    assert.ok(scoreModelFreshness("claude-opus-5-6") > scoreModelFreshness("claude-opus-5-5"));
    assert.ok(scoreModelFreshness("claude-opus-5-5") > scoreModelFreshness("claude-sonnet-4-6"));
    assert.ok(scoreModelFreshness("gpt-6.1-sol") > scoreModelFreshness("gpt-6-sol"));
    assert.ok(scoreModelFreshness("gpt-6-sol") > scoreModelFreshness("gpt-5.6-sol"));
    assert.ok(scoreModelFreshness("grok-4.7") > scoreModelFreshness("grok-4"));
    assert.ok(scoreModelFreshness("claude-4-opus") > scoreModelFreshness("claude-4-haiku-fast"));

    const rankedAnthropic = rankModelsByFreshness([
      "claude-3-5-sonnet-20241022",
      "claude-sonnet-4-6",
      "claude-opus-5-5",
      "claude-opus-5-6",
      "claude-haiku-4-5-fast",
    ]);
    assert.equal(rankedAnthropic[0], "claude-opus-5-6");
  });

  test("pickReviewPanel 优先挑各厂商最新旗舰模型，并自动跳过健康表标记为不健康的模型", () => {
    const catalog = [
      "claude-sonnet-4-5",
      "claude-opus-5-5",
      "claude-opus-5-6",
      "gpt-5.4",
      "gpt-5.6-sol",
      "gpt-6.1-sol",
      "grok-4",
      "grok-4.7",
      "glm-4.5",
      "glm-5.2",
    ];
    const panelAllHealthy = pickReviewPanel("composer-2.5", catalog);
    assert.deepEqual(
      panelAllHealthy.map((r) => r.modelId),
      ["claude-opus-5-6", "gpt-6.1-sol", "grok-4.7", "glm-5.2"],
    );

    // 当 claude-opus-5-6 被禁用时，自动退到同厂商次新的 claude-opus-5-5
    const panelBlocked = pickReviewPanel("composer-2.5", catalog, {
      isHealthy: (id) => id !== "claude-opus-5-6",
    });
    assert.deepEqual(
      panelBlocked.map((r) => r.modelId),
      ["claude-opus-5-5", "gpt-6.1-sol", "grok-4.7", "glm-5.2"],
    );
  });

  test("pickReviewPanel 兜底优先选择非 lite 模型", () => {
    const panel = pickReviewPanel("claude-4-sonnet", ["claude-4-haiku-fast", "claude-4-opus"]);
    assert.equal(panel[0]?.modelId, "claude-4-opus");
  });

  test("buildReviewSource 自动附带近期对话上下文与关联文件路径", () => {
    const src = buildReviewSource("多模型再评审下这个方案", {
      files: [".cursor-remote/canvases/drop-tokens-unified-schema-plan.canvas.tsx"],
      recentTurns: [
        {
          user: "因为方案里面是希望共用这个文件作为同事的配置文件, 所以是否我们应该一并整合设计一下这里",
          assistant:
            "👉 [drop-tokens.json 统一升级方案](.cursor-remote/canvases/drop-tokens-unified-schema-plan.canvas.tsx)",
        },
      ],
    });
    assert.match(src, /drop-tokens-unified-schema-plan\.canvas\.tsx/);
    assert.match(src, /当前会话近期上下文/);
    assert.match(src, /本轮评审请求：\n多模型再评审下这个方案/);
  });

  test("runReviewPanel 正常返回后立即清理 10 分钟超时定时器，不留挂着的 Timeout", async () => {
    clearModelHealth();
    const before = timeouts();
    const fakeWs = { readyState: 1, send: () => undefined } as unknown as Parameters<typeof runReviewPanel>[0];
    const fakeConn = { tenant: null } as unknown as Conn;
    const fakeSlot = {
      chatId: "chat-test",
      tenantId: "default",
      finished: false,
      epoch: 1,
      openTools: new Map(),
      runStats: { toolStarts: 0, intercepts: 0, approvals: 0, replays: 0 },
    } as unknown as Slot;

    const capturedPrompts: string[] = [];
    const summary = await runReviewPanel(
      fakeWs,
      fakeConn,
      fakeSlot,
      [
        { name: "reviewer", modelId: "gpt-5.6-sol" },
        { name: "review-2", modelId: "glm-5.2" },
      ],
      "多模型再评审下这个方案",
      "/tmp",
      "fake-key",
      1,
      {
        timeoutMs: 10 * 60_000,
        catalog: ["gpt-5.6-sol", "glm-5.2"],
        recentTurns: [
          {
            user: "整合 drop-tokens.json",
            assistant: "已生成 .cursor-remote/canvases/drop-tokens-unified-schema-plan.canvas.tsx",
          },
        ],
        promptFn: async (msg) => {
          capturedPrompts.push(msg);
          return { status: "finished", result: "评审通过：结构可行。" } as never;
        },
      },
    );

    assert.equal(capturedPrompts.length, 2);
    assert.match(capturedPrompts[0]!, /drop-tokens-unified-schema-plan\.canvas\.tsx/);
    assert.match(summary, /## reviewer（gpt-5\.6-sol）/);
    assert.match(summary, /## review-2（glm-5\.2）/);
    assert.equal(timeouts(), before);
  });

  test("runReviewPanel 遇到 Model Blocked 时自动记入健康表并当场切换替补模型完成评审", async () => {
    clearModelHealth();
    const fakeWs = { readyState: 1, send: () => undefined } as unknown as Parameters<typeof runReviewPanel>[0];
    const fakeConn = { tenant: null } as unknown as Conn;
    const fakeSlot = {
      chatId: "chat-fallback",
      tenantId: "default",
      finished: false,
      epoch: 1,
      reviewRoster: [
        { name: "reviewer", modelId: "claude-opus-5-5" },
        { name: "review-2", modelId: "gpt-5.6-sol" },
      ],
      openTools: new Map(),
      runStats: { toolStarts: 0, intercepts: 0, approvals: 0, replays: 0 },
    } as unknown as Slot;

    const calledModels: string[] = [];
    const summary = await runReviewPanel(
      fakeWs,
      fakeConn,
      fakeSlot,
      [...fakeSlot.reviewRoster!],
      "多模型评审",
      "/tmp",
      "fake-key",
      1,
      {
        catalog: ["claude-opus-5-5", "claude-sonnet-4-6", "gpt-5.6-sol", "grok-4.7"],
        leadModel: "composer-2.5",
        promptFn: async (_msg, opts) => {
          const mid = opts?.model && typeof opts.model === "object" ? opts.model.id : String(opts?.model ?? "");
          calledModels.push(mid);
          if (mid === "claude-opus-5-5") {
            throw new Error("Model Blocked: claude-opus-5-5 is disabled by your team admin settings");
          }
          return { status: "finished", result: `${mid} 评审结论：通过。` } as never;
        },
      },
    );

    assert.equal(isModelHealthy("claude-opus-5-5"), false);
    assert.ok(calledModels.includes("claude-opus-5-5"));
    assert.ok(calledModels.includes("claude-sonnet-4-6"));
    assert.match(summary, /## reviewer（claude-sonnet-4-6）\nclaude-sonnet-4-6 评审结论：通过。/);
    assert.equal(fakeSlot.reviewRoster?.[0]?.modelId, "claude-sonnet-4-6");
    clearModelHealth();
  });
});

describe("modelHealth & background model fallback (modelHealth.ts & background.ts)", () => {
  test("recordModelFailure 正确区分 admin blocked (24h) 与 429 cooldown (10m)，并忽略超时/取消", () => {
    clearModelHealth();
    const now = 1_700_000_000_000;

    // 取消和超时不拉黑
    assert.equal(recordModelFailure("grok-4.7", new Error("评审超时"), now), null);
    assert.equal(recordModelFailure("grok-4.7", new Error("评审已取消"), now), null);
    assert.equal(isModelHealthy("grok-4.7", now), true);

    // 管理员禁用 -> blocked 24h
    const blocked = recordModelFailure("claude-opus-5-5", new Error("Model Blocked by your team admin"), now);
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.until, now + MODEL_BLOCKED_TTL_MS);
    assert.equal(isModelHealthy("claude-opus-5-5", now + 1000), false);

    // 429 限流 -> cooldown 10m
    const cooldown = recordModelFailure("gpt-5.6-sol", new Error("429 resource_exhausted"), now);
    assert.equal(cooldown?.status, "cooldown");
    assert.equal(cooldown?.until, now + MODEL_COOLDOWN_TTL_MS);
    assert.equal(isModelHealthy("gpt-5.6-sol", now + 1000), false);

    // 调用成功后立即恢复健康
    recordModelSuccess("gpt-5.6-sol", now + 2000);
    assert.equal(isModelHealthy("gpt-5.6-sol", now + 2000), true);
    assert.deepEqual(listUnhealthyModels(now + 2000), {
      "claude-opus-5-5": blocked!,
    });

    // 超过 24h TTL 后自动恢复健康
    assert.equal(isModelHealthy("claude-opus-5-5", now + MODEL_BLOCKED_TTL_MS + 1), true);
    assert.deepEqual(listUnhealthyModels(now + MODEL_BLOCKED_TTL_MS + 1), {});
    clearModelHealth();
  });

  test("后台任务支持租户级/环境变量配置首选模型，并在首选模型不可用或报错时自动兜底", async () => {
    clearModelHealth();
    const stateDir = mkdtempSync(join(tmpdir(), "bg-model-test-"));
    const ref = { id: "t-bg", stateDir };
    try {
      // 1. 租户 settings.json 自定义首选后台模型
      writeSettings(ref, { backgroundModel: "claude-opus-5-5" });
      assert.equal(resolvePreferredBackgroundModel(ref), "claude-opus-5-5");

      // 2. 目录中存在 claude-opus-5-5 与 grok-4.7、gpt-5.6-sol
      const catalog = ["claude-opus-5-5", "grok-4.7", "gpt-5.6-sol"];
      const chain1 = resolveBackgroundModelChain(catalog, { ref });
      assert.deepEqual(chain1, ["claude-opus-5-5", "grok-4.7", "gpt-5.6-sol"]);

      // 3. 运行 runBackground：第一次调用 claude-opus-5-5 报 Model Blocked，自动回退到 grok-4.7 成功完成
      const attemptedModels: string[] = [];
      bindBackground({
        apiKey: () => "fake-key",
        listModels: async () => catalog,
        sandbox: () => false,
        prompt: async (_msg, opts) => {
          const mid = typeof opts.model === "object" ? opts.model.id : String(opts.model);
          attemptedModels.push(mid);
          if (mid === "claude-opus-5-5") {
            throw new Error("Model Blocked by your team admin");
          }
          return { status: "finished", result: `由 ${mid} 完成后台整理` } as never;
        },
      });

      const res = await runBackground(ref, {
        origin: "integrator",
        label: "夜间记忆整理",
        cwd: stateDir,
        prompt: "整理今日记忆",
        customTools: {},
        inboxOnFailure: false,
      });

      assert.equal(res.ok, true);
      if (res.ok) {
        assert.match(res.text, /由 grok-4\.7 完成后台整理/);
      }
      assert.deepEqual(attemptedModels, ["claude-opus-5-5", "grok-4.7"]);
      assert.equal(isModelHealthy("claude-opus-5-5"), false);

      // 4. 此时再调 modelAvailable(ref)，会自动告知已兜底切换为 grok-4.7 且状态 ok: true
      const avail = await modelAvailable(ref);
      assert.equal(avail.ok, true);
      assert.equal(avail.model, "grok-4.7");
      assert.equal(avail.fallbackFrom, "claude-opus-5-5");
    } finally {
      clearModelHealth();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
