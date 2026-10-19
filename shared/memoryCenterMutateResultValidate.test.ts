import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMemoryCenterMutationResult } from "./memoryCenterMutationResult.ts";
import {
  validateMemoryCenterMutateFailureData,
  validateMemoryCenterMutateSuccessData,
  validateMemoryCenterScopeDetail,
} from "./memoryCenterMutateResultValidate.ts";

function minimalDetail() {
  return {
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
  };
}

function minimalDiagnostics(overrides: Record<string, unknown> = {}) {
  return {
    total: 0,
    selected: 0,
    skippedBudget: 0,
    hotSelected: 0,
    coldRecalled: 0,
    terminalSkipped: 0,
    pinnedSelected: 0,
    relevantSelected: 0,
    strategy: "default",
    selectedIds: [],
    ...overrides,
  };
}

describe("memoryCenterMutateResultValidate", () => {
  test("failure 仅允许 code 与 detail", () => {
    assert.equal(validateMemoryCenterMutateFailureData({ code: "conflict" }), true);
    assert.equal(validateMemoryCenterMutateFailureData({ code: "conflict", detail: 1 }), false);
    assert.equal(validateMemoryCenterMutateFailureData({ code: "nope" }), false);
    assert.equal(validateMemoryCenterMutateFailureData({ code: "conflict", extra: true }), false);
  });

  test("success 拒绝 detail 嵌套畸形", () => {
    assert.equal(
      validateMemoryCenterMutateSuccessData({
        scope: "ws",
        action: "create",
        detail: { ...minimalDetail(), items: [{ id: 1 }] },
      }),
      false,
    );
  });

  test("InjectionDiagnostics selectedIds/skippedReasons 严格", () => {
    const base = { ...minimalDetail(), diagnostics: minimalDiagnostics() };
    assert.equal(validateMemoryCenterScopeDetail(base), true);

    assert.equal(
      validateMemoryCenterScopeDetail({
        ...minimalDetail(),
        diagnostics: minimalDiagnostics({ selectedIds: [null] }),
      }),
      false,
    );
    assert.equal(
      validateMemoryCenterScopeDetail({
        ...minimalDetail(),
        diagnostics: minimalDiagnostics({ skippedReasons: "bad" }),
      }),
      false,
    );
    assert.equal(
      validateMemoryCenterScopeDetail({
        ...minimalDetail(),
        diagnostics: minimalDiagnostics({
          selectedIds: [{ id: "wm_1", reason: "not_a_reason" }],
        }),
      }),
      false,
    );
    assert.equal(
      validateMemoryCenterScopeDetail({
        ...minimalDetail(),
        diagnostics: minimalDiagnostics({
          selectedIds: [{ id: "wm_1", reason: "pinned", extra: true }],
        }),
      }),
      false,
    );
    assert.equal(
      validateMemoryCenterScopeDetail({
        ...minimalDetail(),
        diagnostics: minimalDiagnostics({
          selectedIds: [{ id: null, reason: "rotation" }],
          skippedReasons: [{ id: null, reason: "budget" }],
        }),
      }),
      true,
    );
  });

  test("parse 对 failure code 外值返回 null", () => {
    const parsed = parseMemoryCenterMutationResult({
      op: "memory_center_mutate",
      ok: false,
      error: "x",
      data: { code: "conflict", detail: 42 },
    });
    assert.equal(parsed, null);
  });
});
