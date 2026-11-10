import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pickReviewPanel, wantsMultiModelReview } from "../../shared/crew.ts";
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

describe("multi-model review (review.ts & crew.ts)", () => {
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
});
