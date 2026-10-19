import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseMemoryCenterActivityData,
  parseMemoryCenterRestoreFailureData,
  parseMemoryCenterSuggestionAnswerData,
  parseMemoryCenterSuggestionsData,
  tryParseMemoryCenterPayload,
} from "./memoryCenterParse.ts";

describe("memoryCenterParse", () => {
  test("activity 金样本 nullable 字段", () => {
    const parsed = parseMemoryCenterActivityData({
      entries: [
        {
          auditId: "aud1",
          scope: "notes",
          itemId: "wm1",
          action: "create",
          actor: "user",
          at: "2026-02-10T12:00:00.000Z",
          before: null,
          after: {
            id: "wm1",
            section: "约定",
            text: "x",
            revision: "rev1",
            state: null,
            pinned: false,
          },
          canRestore: true,
        },
      ],
      nextCursor: undefined,
      truncated: false,
      degraded: undefined,
    });
    assert.ok(parsed);
    assert.equal(parsed!.entries.length, 1);
  });

  test("activity malformed 整包 reject", () => {
    assert.equal(parseMemoryCenterActivityData(null), null);
    assert.equal(parseMemoryCenterActivityData({ entries: [{}] }), null);
    assert.equal(parseMemoryCenterActivityData({ entries: [], nextCursor: 1 }), null);
    assert.equal(
      tryParseMemoryCenterPayload("memory_center_activity", { entries: [{ auditId: "x", action: "nope" }] }),
      null,
    );
  });

  test("suggestions / answer / restore failure", () => {
    assert.ok(
      parseMemoryCenterSuggestionsData({
        generatedAt: "2026-02-10T08:00:00.000Z",
        entries: [
          {
            id: "s1",
            scope: "notes",
            kind: "missing_ref",
            summary: "s",
            reason: "r",
            risk: "low",
            itemIds: ["wm1"],
            revisions: ["rev"],
            proposedAction: { kind: "mark_handled" },
          },
        ],
      }),
    );
    assert.ok(parseMemoryCenterSuggestionAnswerData({ id: "s1", status: "dismissed" }));
    assert.ok(parseMemoryCenterRestoreFailureData({ code: "conflict" }));
    assert.equal(parseMemoryCenterRestoreFailureData({ code: "unknown" }), null);
    assert.equal(parseMemoryCenterSuggestionAnswerData({ id: "s1", status: "weird" }), null);
  });

  test("tryParse no-throw", () => {
    assert.doesNotThrow(() => tryParseMemoryCenterPayload("memory_center_activity", Symbol("x")));
    assert.equal(tryParseMemoryCenterPayload("memory_center_activity", Symbol("x")), null);
  });
});
