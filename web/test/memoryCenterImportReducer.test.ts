import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  initialMemoryCenterImportUiState,
  reduceMemoryCenterImportResult,
} from "../components/assistant/memoryCenterImportReducer.ts";

describe("memoryCenterImportReducer", () => {
  test("stale reqId ignored", () => {
    const next = reduceMemoryCenterImportResult(
      { ...initialMemoryCenterImportUiState, busy: true },
      {
        type: "assistant_result",
        op: "memory_center_export",
        ok: true,
        reqId: "a",
        data: {
          relativePath: ".jiebo/memory-export/x.json",
          sha256: "ab".repeat(32),
          bytes: 1,
          summary: { scopes: [], personalEntries: 0, workspaceScopes: 0, rulesInventory: 0 },
        },
      },
      "a",
      "b",
    );
    assert.equal(next.busy, true);
    assert.equal(next.exportResult, null);
  });

  test("no pending ignores any import result", () => {
    const next = reduceMemoryCenterImportResult(
      initialMemoryCenterImportUiState,
      {
        type: "assistant_result",
        op: "memory_center_export",
        ok: true,
        reqId: "r1",
        data: {
          relativePath: ".jiebo/memory-export/x.json",
          sha256: "ab".repeat(32),
          bytes: 1,
          summary: { scopes: [], personalEntries: 0, workspaceScopes: 0, rulesInventory: 0 },
        },
      },
      "r1",
      undefined,
    );
    assert.equal(next.exportResult, null);
    assert.equal(next.busy, false);
  });

  test("cleared pending ignores late result", () => {
    const next = reduceMemoryCenterImportResult(
      { ...initialMemoryCenterImportUiState, exportResult: { relativePath: "keep", sha256: "c".repeat(64), bytes: 9 } },
      {
        type: "assistant_result",
        op: "memory_center_export",
        ok: true,
        reqId: "new",
        data: {
          relativePath: ".jiebo/memory-export/y.json",
          sha256: "d".repeat(64),
          bytes: 2,
          summary: { scopes: [], personalEntries: 0, workspaceScopes: 0, rulesInventory: 0 },
        },
      },
      "new",
      undefined,
    );
    assert.equal(next.exportResult?.relativePath, "keep");
  });

  test("malformed export data no throw", () => {
    const next = reduceMemoryCenterImportResult(
      initialMemoryCenterImportUiState,
      { type: "assistant_result", op: "memory_center_export", ok: true, data: { bad: true } },
      "r1",
      "r1",
    );
    assert.match(next.error ?? "", /无效/);
  });
});
