import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMemoryCenterMutationResult } from "@shared/memoryCenterMutationResult";
import { MEMORY_CENTER_CSS } from "../components/assistant/memoryCenterLabels";

describe("parseMemoryCenterMutationResult", () => {
  test("success 分支", () => {
    const parsed = parseMemoryCenterMutationResult({
      op: "memory_center_mutate",
      ok: true,
      data: {
        scope: "ws",
        action: "update",
        detail: {
          scope: {
            id: "ws",
            label: "ws",
            kind: "workspace_memory",
            layer: "L2",
            memoryCount: 0,
            hot: 0,
            cold: 0,
            done: 0,
            expired: 0,
            pinned: 0,
            missingRefs: 0,
            ruleFileCount: 0,
            tokenBudget: 0,
            injectionSelected: 0,
            injectionSkipped: 0,
            pendingCount: 0,
          },
          items: [],
          rules: [],
          diagnostics: null,
        },
      },
    });
    assert.ok(parsed?.ok);
  });

  test("畸形 success detail 返回 null", () => {
    const parsed = parseMemoryCenterMutationResult({
      op: "memory_center_mutate",
      ok: true,
      data: {
        scope: "ws",
        action: "update",
        detail: { scope: 1, items: [], rules: [], diagnostics: null },
      },
    });
    assert.equal(parsed, null);
  });

  test("failure 分支带 code", () => {
    const parsed = parseMemoryCenterMutationResult({
      op: "memory_center_mutate",
      ok: false,
      error: "冲突",
      data: { code: "conflict" },
    });
    assert.equal(parsed?.ok, false);
    if (parsed?.ok) return;
    assert.equal(parsed.data.code, "conflict");
  });
});

describe("memory center create entry contract", () => {
  test("新增入口 class 稳定", () => {
    assert.equal(MEMORY_CENTER_CSS.createEntry, "mc-create-entry");
  });
});
