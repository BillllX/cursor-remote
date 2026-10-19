import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseMemoryCenterExportData,
  parseMemoryCenterImportApplyData,
  parseMemoryCenterImportPreviewData,
  parseMemoryCenterImportRollbackData,
} from "./memoryCenterImportParse.ts";

describe("memoryCenterImportParse", () => {
  test("export success shape", () => {
    const ok = parseMemoryCenterExportData({
      relativePath: ".jiebo/memory-export/x.json",
      sha256: "a".repeat(64),
      bytes: 100,
      summary: { scopes: ["personal"], personalEntries: 0, workspaceScopes: 0, rulesInventory: 0 },
    });
    assert.ok(ok);
  });

  test("export rejects malformed", () => {
    assert.equal(parseMemoryCenterExportData(null), null);
    assert.equal(parseMemoryCenterExportData({ relativePath: 1 }), null);
  });

  test("preview success shape", () => {
    assert.ok(
      parseMemoryCenterImportPreviewData({
        planId: "plan1",
        expiresAt: "2026-10-18T12:00:00.000Z",
        snapshotSummary: { exportedAt: "x", schemaVersion: 1, scopeCount: 0, personalEntryCount: 0, rulesCount: 0, bytes: 1, checksum: "c" },
        changes: [],
        warnings: [],
      }),
    );
  });

  test("preview rejects malformed", () => {
    assert.equal(parseMemoryCenterImportPreviewData({ planId: "p" }), null);
  });

  test("apply success and failure shapes", () => {
    assert.ok(
      parseMemoryCenterImportApplyData({
        importId: "mcimp1",
        canRollback: true,
        summary: { applied: 1, skipped: 0, conflictsResolved: 0 },
      }),
    );
    assert.equal(parseMemoryCenterImportApplyData({ importId: "x", canRollback: false }), null);
  });

  test("rollback success and failure shapes", () => {
    assert.ok(parseMemoryCenterImportRollbackData({ importId: "mcimp1", status: "rolled_back" }));
    assert.ok(parseMemoryCenterImportRollbackData({ importId: "mcimp1", status: "already_rolled_back" }));
    assert.equal(parseMemoryCenterImportRollbackData({ importId: "x", status: "nope" }), null);
  });
});
