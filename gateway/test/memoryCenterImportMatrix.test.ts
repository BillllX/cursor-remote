import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { buildMemoryCenterSnapshotV1, finalizeSnapshotChecksums, memoryCenterExport } from "../src/assistant/memoryCenterExport.ts";
import { setMemoryCenterExportScopeReaderForTest } from "../src/assistant/memoryCenterExportScopeReader.ts";
import * as scopedRead from "../src/assistant/scopedRead.ts";
import { buildImportPreviewFromSnapshot } from "../src/assistant/memoryCenterImportPreview.ts";
import { memoryCenterImportApply } from "../src/assistant/memoryCenterImportApply.ts";
import { memoryCenterImportRollback } from "../src/assistant/memoryCenterImportRollback.ts";
import { readJournal } from "../src/assistant/memoryCenterImportJournal.ts";
import { setMemoryCenterImportJournalHooksForTest } from "../src/assistant/memoryCenterImportHooks.ts";
import { setMemoryCenterImportRollbackHooksForTest } from "../src/assistant/memoryCenterImportRollbackHooks.ts";
import { recoverPendingMemoryCenterImports } from "../src/assistant/memoryCenterImportRecover.ts";
import { setMemoryCenterAuditWriterHooksForTest } from "../src/assistant/memoryCenterAudit.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mc-matrix-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tenant(id: string, workspaceRoot: string) {
  const stateDir = join(root, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "assistant", "memory"), { recursive: true });
  return { id, stateDir, workspaceRoot: resolve(workspaceRoot) };
}

function fileSnap(path: string) {
  if (!existsSync(path)) return { exists: false as const };
  const st = lstatSync(path);
  const buf = readFileSync(path);
  return {
    exists: true as const,
    mode: st.mode & 0o777,
    bytes: buf,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function entryOnlyFixture() {
  const base = join(root, `entry-${Date.now()}`);
  const ws = join(base, "notes");
  mkdirSync(join(ws, ".jiebo"), { recursive: true });
  const memPath = join(ws, ".jiebo/memory.md");
  const before = "## 约定\n- seed <!-- id=wm_e1 -->\n";
  writeFileSync(memPath, before);
  const t = tenant(`entry-${Date.now()}`, base);
  setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
  const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
  snap.workspaces[0].memoryRaw = "## 约定\n- seed <!-- id=wm_e1 -->\n- added <!-- id=wm_e2 -->\n";
  const finalized = finalizeSnapshotChecksums(snap);
  const preview = buildImportPreviewFromSnapshot(t, ["notes"], finalized, Buffer.from(JSON.stringify(finalized)));
  const resolutions = preview.changes
    .filter((c) => c.layer === "workspace_structure" || c.action === "add" || (c.layer === "workspace_entries" && c.action === "conflict"))
    .map((c) => ({
      changeId: c.changeId,
      resolution: c.layer === "workspace_structure" ? ("keep_current" as const) : ("use_snapshot" as const),
    }));
  return { t, base, ws, memPath, before, preview, resolutions };
}

describe("memory center import matrix C3", () => {
  test("export rejects .jiebo symlink outside workspace", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "jiebo-link");
    mkdirSync(base, { recursive: true });
    const t = tenant("jiebo-link", base);
    const outside = join(root, "outside-jiebo");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(base, ".jiebo"), { recursive: true });
    try {
      rmSync(join(base, ".jiebo"), { recursive: true, force: true });
      symlinkSync(outside, join(base, ".jiebo"));
    } catch {
      return;
    }
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const out = memoryCenterExport(t, [], ["personal"]);
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.code, "security");
  });

  test("entry-only failAfterFileWrite restores memory byte/mode/existence", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const { t, memPath, before, preview, resolutions } = entryOnlyFixture();
    const beforeSnap = fileSnap(memPath);
    setMemoryCenterImportJournalHooksForTest({ failAfterFileWrite: 4 });
    const applied = memoryCenterImportApply(t, ["notes"], preview.planId, resolutions);
    setMemoryCenterImportJournalHooksForTest(null);
    assert.equal(applied.ok, false);
    const afterSnap = fileSnap(memPath);
    assert.equal(afterSnap.exists, beforeSnap.exists);
    if (beforeSnap.exists && afterSnap.exists) {
      assert.equal(afterSnap.sha256, beforeSnap.sha256);
      assert.equal(afterSnap.mode, beforeSnap.mode);
    }
    assert.equal(readFileSync(memPath, "utf8"), before);
  });

  test("structure replace failAfterFileWrite keeps file", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "struct-fail");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    const memPath = join(ws, ".jiebo/memory.md");
    writeFileSync(memPath, "## 约定\n- old <!-- id=wm_s1 -->\n");
    const t = tenant("struct-fail", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
    snap.workspaces[0].memoryRaw = "## 约定\n- new <!-- id=wm_s1 -->\n";
    const finalized = finalizeSnapshotChecksums(snap);
    const preview = buildImportPreviewFromSnapshot(t, ["notes"], finalized, Buffer.from(JSON.stringify(finalized)));
    const struct = preview.changes.find((c) => c.layer === "workspace_structure" && c.action === "conflict");
    assert.ok(struct);
    const snapBefore = fileSnap(memPath);
    setMemoryCenterImportJournalHooksForTest({ failAfterFileWrite: 4 });
    const applied = memoryCenterImportApply(t, ["notes"], preview.planId, [
      { changeId: struct!.changeId, resolution: "use_snapshot" },
    ]);
    setMemoryCenterImportJournalHooksForTest(null);
    assert.equal(applied.ok, false);
    const snapAfter = fileSnap(memPath);
    assert.equal(snapAfter.sha256, snapBefore.sha256);
  });

  test("rollback audit failure leaves original journal committed not rolledBack", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "rb-audit");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    writeFileSync(join(ws, ".jiebo/memory.md"), "## 约定\n- x <!-- id=wm_ra -->\n");
    const t = tenant("rb-audit", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
    snap.workspaces[0].memoryRaw = "## 约定\n- y <!-- id=wm_ra -->\n";
    const finalized = finalizeSnapshotChecksums(snap);
    const preview = buildImportPreviewFromSnapshot(t, ["notes"], finalized, Buffer.from(JSON.stringify(finalized)));
    const conflict = preview.changes.find((c) => c.scope === "notes" && c.action === "conflict");
    assert.ok(conflict);
    const resolutions = preview.changes
      .filter((c) => c.action === "conflict" && c.scope === "notes")
      .map((c) => ({ changeId: c.changeId, resolution: "use_snapshot" as const }));
    const applied = memoryCenterImportApply(t, ["notes"], preview.planId, resolutions);
    assert.equal(applied.ok, true, !applied.ok ? `${applied.code}: ${applied.error}` : "");
    if (!applied.ok) return;
    setMemoryCenterImportRollbackHooksForTest({ failPersonalAudit: true });
    const rolled = memoryCenterImportRollback(t, ["notes"], applied.data.importId);
    setMemoryCenterImportRollbackHooksForTest(null);
    assert.equal(rolled.ok, false);
    const ref = { id: t.id, stateDir: t.stateDir };
    const j = readJournal(ref, applied.data.importId);
    assert.ok(j?.committed);
    assert.notEqual(j?.rolledBack, true);
    assert.match(readFileSync(join(ws, ".jiebo/memory.md"), "utf8"), /y/);
  });

  test("entry-only audit inject fail triggers compensation", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const { t, memPath, before, preview, resolutions } = entryOnlyFixture();
    setMemoryCenterAuditWriterHooksForTest({ failAppend: true });
    setMemoryCenterImportJournalHooksForTest(null);
    const applied = memoryCenterImportApply(t, ["notes"], preview.planId, resolutions);
    setMemoryCenterAuditWriterHooksForTest(null);
    assert.equal(applied.ok, false);
    assert.equal(readFileSync(memPath, "utf8"), before);
    recoverPendingMemoryCenterImports({ id: t.id, stateDir: t.stateDir }, t, ["notes"]);
    assert.equal(readFileSync(memPath, "utf8"), before);
  });
});
