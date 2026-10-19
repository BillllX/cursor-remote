import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyActivityResult,
  initialActivityState,
  registerActivityPending,
} from "../components/assistant/memoryCenterActivityReducer";

describe("memoryCenterActivityReducer", () => {
  test("reqId 不匹配时不应用", () => {
    let state = initialActivityState();
    state = registerActivityPending(state, { reqId: "a1", kind: "activity" });
    const applied = applyActivityResult(state, {
      type: "assistant_result",
      op: "memory_center_activity",
      reqId: "other",
      ok: true,
      data: { entries: [] },
    });
    assert.equal(applied, null);
  });

  test("并发 activity 仅最新 loadReqId 写入，旧响应忽略", () => {
    let state = initialActivityState();
    state = registerActivityPending(state, { reqId: "a1", kind: "activity" });
    state = registerActivityPending(state, { reqId: "a2", kind: "activity" });
    const applied1 = applyActivityResult(state, {
      type: "assistant_result",
      op: "memory_center_activity",
      reqId: "a2",
      ok: true,
      data: {
        entries: [
          {
            auditId: "x",
            scope: "s",
            itemId: "i",
            action: "create",
            actor: "user",
            at: "t",
            canRestore: false,
          },
        ],
      },
    });
    assert.equal(applied1!.activity!.entries[0].auditId, "x");
    const applied2 = applyActivityResult(applied1!, {
      type: "assistant_result",
      op: "memory_center_activity",
      reqId: "a1",
      ok: true,
      data: {
        entries: [
          {
            auditId: "y",
            scope: "s",
            itemId: "i",
            action: "update",
            actor: "user",
            at: "t2",
            canRestore: true,
          },
        ],
      },
    });
    assert.equal(applied2!.activity!.entries[0].auditId, "x");
    assert.equal(applied2!.pending.length, 0);
  });

  test("刷新后旧 generation activity 响应忽略", () => {
    let state = registerActivityPending(initialActivityState(), { reqId: "old", kind: "activity" }, { refreshActivity: true });
    state = registerActivityPending(state, { reqId: "new", kind: "activity" }, { refreshActivity: true });
    const stale = applyActivityResult(state, {
      type: "assistant_result",
      op: "memory_center_activity",
      reqId: "old",
      ok: true,
      data: {
        entries: [
          {
            auditId: "stale",
            scope: "s",
            itemId: "i",
            action: "create",
            actor: "user",
            at: "t",
            canRestore: false,
          },
        ],
      },
    }, { activityGeneration: 0 });
    assert.equal(stale?.activity, null);
  });

  test("malformed activity 整包 reject", () => {
    let state = initialActivityState();
    state = registerActivityPending(state, { reqId: "bad", kind: "activity" });
    const applied = applyActivityResult(state, {
      type: "assistant_result",
      op: "memory_center_activity",
      reqId: "bad",
      ok: true,
      data: { entries: [{ auditId: "x" }] },
    });
    assert.match(applied!.activityError, /格式/);
  });

  test("suggestion 部分失败互不影响且保留摘要", () => {
    let state = initialActivityState();
    state = {
      ...state,
      suggestions: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            id: "s1",
            scope: "ws",
            kind: "stale_hot",
            summary: "a",
            reason: "r",
            risk: "low",
            itemIds: ["wm1"],
            revisions: ["rev"],
            proposedAction: { kind: "set_state", state: "cold", targetId: "wm1" },
          },
          {
            id: "s2",
            scope: "ws",
            kind: "stale_hot",
            summary: "b",
            reason: "r",
            risk: "low",
            itemIds: ["wm2"],
            revisions: ["rev"],
            proposedAction: { kind: "set_state", state: "cold", targetId: "wm2" },
          },
        ],
      },
    };
    state = registerActivityPending(state, { reqId: "r1", kind: "suggestion_answer", targetId: "s1" });
    state = registerActivityPending(state, { reqId: "r2", kind: "suggestion_answer", targetId: "s2" });
    const okFirst = applyActivityResult(state, {
      type: "assistant_result",
      op: "memory_center_suggestion_answer",
      reqId: "r2",
      ok: true,
      data: { id: "s2", status: "accepted" },
    });
    assert.equal(okFirst!.suggestions!.entries.length, 1);
    assert.equal(okFirst!.suggestionById.s2.outcome, "accepted");
    const failSecond = applyActivityResult(okFirst!, {
      type: "assistant_result",
      op: "memory_center_suggestion_answer",
      reqId: "r1",
      ok: false,
      error: "冲突",
    });
    assert.equal(failSecond!.suggestions!.entries.length, 1);
    assert.equal(failSecond!.suggestionById.s1.error, "冲突");
    assert.ok(failSecond!.suggestionBatchSummary);
    assert.equal(failSecond!.suggestionBatchSummary!.failed, 1);
    assert.equal(failSecond!.suggestionBatchSummary!.succeeded, 1);
  });

  test("malformed restore failure 不抛错", () => {
    let state = initialActivityState();
    state = registerActivityPending(state, { reqId: "r1", kind: "restore", auditId: "aud1" });
    const applied = applyActivityResult(state, {
      type: "assistant_result",
      op: "memory_center_restore",
      reqId: "r1",
      ok: false,
      error: "冲突",
      data: { code: "conflict" },
    });
    assert.equal(applied?.restoreErrorByAuditId.aud1, "冲突");
  });
});
