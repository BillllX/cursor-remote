import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { saveMemory } from "../src/assistant/memory.ts";
import { buildMemoryCenterSnapshotV1, finalizeSnapshotChecksums, memoryCenterExport } from "../src/assistant/memoryCenterExport.ts";
import { setMemoryCenterExportScopeReaderForTest } from "../src/assistant/memoryCenterExportScopeReader.ts";
import * as scopedRead from "../src/assistant/scopedRead.ts";
import { memoryCenterImportPreview, buildImportPreviewFromSnapshot } from "../src/assistant/memoryCenterImportPreview.ts";
import { memoryCenterImportApply } from "../src/assistant/memoryCenterImportApply.ts";
import { memoryCenterImportRollback } from "../src/assistant/memoryCenterImportRollback.ts";
import { stableSnapshotStringify, validateMemoryCenterSnapshotV1 } from "../../shared/memoryCenterSnapshot.ts";
import { atomicWriteFileSync } from "../src/fsAtomic.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mc-import-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tenant(id: string, workspaceRoot: string) {
  const stateDir = join(root, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "assistant", "memory"), { recursive: true });
  return { id, stateDir, workspaceRoot: resolve(workspaceRoot) };
}

describe("memory center import/export", () => {
  test("export snapshot roundtrip validate", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "exp");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    writeFileSync(
      join(ws, ".jiebo/memory.md"),
      "## 约定\n- hello <!-- id=wm_test1 -->\n",
    );
    const t = tenant("exp", base);
    saveMemory(t, { topic: "测试", text: "导出条目", basis: "user_said" }, "page");
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["personal", "work_preference", "notes"]);
    const v = validateMemoryCenterSnapshotV1(snap);
    assert.equal(v.ok, true);
    const out = memoryCenterExport(t, ["notes"], ["personal", "notes"]);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.match(out.data.relativePath, /^\.jiebo\/memory-export\//);
  });

  test("preview does not write authoritative files", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "prev");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    writeFileSync(join(ws, ".jiebo/memory.md"), "## 约定\n- old <!-- id=wm_a -->\n");
    const t = tenant("prev", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
    snap.workspaces[0].memoryRaw = "## 约定\n- new <!-- id=wm_a -->\n";
    const finalized = finalizeSnapshotChecksums(snap);
    const bytes = Buffer.from(JSON.stringify(finalized));
    const before = readFileSync(join(ws, ".jiebo/memory.md"), "utf8");
    buildImportPreviewFromSnapshot(t, ["notes"], snap, bytes);
    const after = readFileSync(join(ws, ".jiebo/memory.md"), "utf8");
    assert.equal(before, after);
  });

  test("apply and rollback", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "apply");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    writeFileSync(join(ws, ".jiebo/memory.md"), "## 约定\n- before <!-- id=wm_rb -->\n");
    const t = tenant("apply", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
    snap.workspaces[0].memoryRaw = "## 约定\n- after <!-- id=wm_rb -->\n";
    const finalized = finalizeSnapshotChecksums(snap);
    const exportDir = join(base, ".jiebo", "memory-export");
    mkdirSync(exportDir, { recursive: true });
    const rel = ".jiebo/memory-export/test-snap.json";
    const onDisk = JSON.parse(stableSnapshotStringify(finalized));
    atomicWriteFileSync(join(base, rel), `${JSON.stringify(onDisk, null, 1)}\n`, { mode: 0o600 });
    const preview = memoryCenterImportPreview(t, ["notes"], rel);
    assert.equal(preview.ok, true, !preview.ok ? `${preview.code}: ${preview.error}` : "");
    if (!preview.ok) return;
    const conflicts = preview.data.changes.filter((c) => c.action === "conflict" && c.scope === "notes");
    assert.ok(conflicts.length);
    const applied = memoryCenterImportApply(
      t,
      ["notes"],
      preview.data.planId,
      conflicts.map((c) => ({ changeId: c.changeId, resolution: "use_snapshot" as const })),
    );
    assert.equal(applied.ok, true, !applied.ok ? `${applied.code}: ${applied.error}` : "");
    if (!applied.ok) return;
    assert.match(readFileSync(join(ws, ".jiebo/memory.md"), "utf8"), /after/);
    const rolled = memoryCenterImportRollback(t, ["notes"], applied.data.importId);
    assert.equal(rolled.ok, true, !rolled.ok ? `${rolled.code}: ${rolled.error}` : "");
    assert.match(readFileSync(join(ws, ".jiebo/memory.md"), "utf8"), /before/);
  });

  test("rejects path outside allowlist", () => {
    const t = tenant("path", join(root, "path"));
    const r = memoryCenterImportPreview(t, [], "../etc/passwd");
    assert.equal(r.ok, false);
  });

  test("preview respects includedScopes personal only (no W0)", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "inc-personal");
    mkdirSync(join(base, ".jiebo", "memory-export"), { recursive: true });
    const t = tenant("inc-personal", base);
    saveMemory(t, { topic: "t", text: "x", basis: "user_said" }, "page");
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, [], ["personal"]);
    assert.equal(snap.manifest.includedScopes.workPreference, false);
    assert.equal(snap.manifest.includedScopes.personal, true);
    const finalized = finalizeSnapshotChecksums(snap);
    const bytes = Buffer.from(JSON.stringify(finalized));
    const data = buildImportPreviewFromSnapshot(t, [], finalized, bytes);
    assert.ok(data.changes.some((c) => c.layer === "personal_core" || c.layer === "personal_entries"));
    assert.ok(!data.changes.some((c) => c.layer === "work_preference"));
  });

  test("preview respects includedScopes work_preference only", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "inc-w0");
    const t = tenant("inc-w0", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, [], ["work_preference"]);
    assert.equal(snap.manifest.includedScopes.personal, false);
    const finalized = finalizeSnapshotChecksums(snap);
    const data = buildImportPreviewFromSnapshot(t, [], finalized, Buffer.from(JSON.stringify(finalized)));
    assert.ok(data.changes.every((c) => c.layer === "work_preference"));
  });

  test("export rejects symlink export directory", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "symlink-exp");
    const t = tenant("symlink-exp", base);
    const realExport = join(base, ".jiebo", "memory-export-real");
    mkdirSync(realExport, { recursive: true });
    const link = join(base, ".jiebo", "memory-export");
    mkdirSync(join(base, ".jiebo"), { recursive: true });
    try {
      const { symlinkSync } = require("node:fs");
      symlinkSync(realExport, link);
    } catch {
      return;
    }
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const out = memoryCenterExport(t, [], ["personal"]);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, "security");
  });
});
