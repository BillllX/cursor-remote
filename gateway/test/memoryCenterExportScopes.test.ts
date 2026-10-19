import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { resolveExportScopes } from "../src/assistant/memoryCenterExportScopes.ts";
import {
  buildMemoryCenterSnapshotV1,
  finalizeSnapshotChecksums,
  setMemoryCenterExportNowForTest,
} from "../src/assistant/memoryCenterExport.ts";
import { stableSnapshotStringify, validateMemoryCenterSnapshotV1 } from "../../shared/memoryCenterSnapshot.ts";
import { setMemoryCenterExportScopeReaderForTest } from "../src/assistant/memoryCenterExportScopeReader.ts";
import * as scopedRead from "../src/assistant/scopedRead.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mc-scope-"));

describe("memory center export scopes", () => {
  test("empty scopes is invalid_input", () => {
    const t = { id: "t", stateDir: join(root, "st"), workspaceRoot: resolve(root, "ws") };
    mkdirSync(join(t.stateDir, "assistant/memory"), { recursive: true });
    mkdirSync(t.workspaceRoot, { recursive: true });
    const r = resolveExportScopes(t, [], []);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "invalid_input");
  });

  test("deterministic canonical json with fixed exportedAt", () => {
    if (!scopedRead.scopedReadSupported()) return;
    setMemoryCenterExportNowForTest(() => "2026-10-18T12:00:00.000Z");
    const base = join(root, "det");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    const t = { id: "det", stateDir: join(root, "st-det"), workspaceRoot: resolve(base) };
    mkdirSync(join(t.stateDir, "assistant/memory"), { recursive: true });
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const a = finalizeSnapshotChecksums(buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]));
    const b = finalizeSnapshotChecksums(buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]));
    assert.equal(stableSnapshotStringify(a), stableSnapshotStringify(b));
    setMemoryCenterExportNowForTest(null);
  });
});

process.on("exit", () => rmSync(root, { recursive: true, force: true }));
