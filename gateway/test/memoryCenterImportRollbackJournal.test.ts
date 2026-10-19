import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { buildMemoryCenterSnapshotV1, finalizeSnapshotChecksums } from "../src/assistant/memoryCenterExport.ts";
import { setMemoryCenterExportScopeReaderForTest } from "../src/assistant/memoryCenterExportScopeReader.ts";
import * as scopedRead from "../src/assistant/scopedRead.ts";
import { buildImportPreviewFromSnapshot } from "../src/assistant/memoryCenterImportPreview.ts";
import { memoryCenterImportApply } from "../src/assistant/memoryCenterImportApply.ts";
import { memoryCenterImportRollback } from "../src/assistant/memoryCenterImportRollback.ts";
import { listJournals, readJournal } from "../src/assistant/memoryCenterImportJournal.ts";
import { setMemoryCenterImportJournalHooksForTest } from "../src/assistant/memoryCenterImportHooks.ts";
import { personalMemoryAuditPath } from "../src/assistant/memoryCenterImportPersonalAudit.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mc-rb-journal-"));
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
    sha256: createHash("sha256").update(buf).digest("hex"),
    text: buf.toString("utf8"),
  };
}

function workspaceOnlyApply() {
  const base = join(root, `ws-${Date.now()}`);
  const ws = join(base, "notes");
  mkdirSync(join(ws, ".jiebo"), { recursive: true });
  const memPath = join(ws, ".jiebo/memory.md");
  writeFileSync(memPath, "## 约定\n- pre <!-- id=wm_rb -->\n");
  const t = tenant(`ws-${Date.now()}`, base);
  setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
  const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
  snap.workspaces[0].memoryRaw = "## 约定\n- post <!-- id=wm_rb -->\n";
  const finalized = finalizeSnapshotChecksums(snap);
  const preview = buildImportPreviewFromSnapshot(t, ["notes"], finalized, Buffer.from(JSON.stringify(finalized)));
  const resolutions = preview.changes
    .filter((c) => c.action === "conflict" && c.scope === "notes")
    .map((c) => ({ changeId: c.changeId, resolution: "use_snapshot" as const }));
  const applied = memoryCenterImportApply(t, ["notes"], preview.planId, resolutions);
  assert.equal(applied.ok, true, !applied.ok ? applied.error : "");
  if (!applied.ok) throw new Error("apply failed");
  return { t, memPath, importId: applied.data.importId, ref: { id: t.id, stateDir: t.stateDir } };
}

describe("rollback journal personal audit + journal failure matrix", () => {
  test("rollback journal always captures personal audit step (workspace-only import)", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const { t, importId, ref } = workspaceOnlyApply();
    const auditBefore = fileSnap(personalMemoryAuditPath(ref));
    const rolled = memoryCenterImportRollback(t, ["notes"], importId);
    assert.equal(rolled.ok, true);
    const rb = readJournal(ref, `${importId}-rb`);
    assert.ok(rb?.steps.some((s) => s.target === "rollback:personal:audit"));
    const auditAfter = fileSnap(personalMemoryAuditPath(ref));
    if (auditBefore.exists && auditAfter.exists) {
      assert.notEqual(auditBefore.sha256, auditAfter.sha256);
    } else {
      assert.ok(auditAfter.exists);
    }
  });

  for (const hookValue of [0, 1, 2] as const) {
    test(`failAfterJournalWrite ${hookValue} restores post-import consistent state`, () => {
      if (!scopedRead.scopedReadSupported()) return;
      const { t, memPath, importId, ref } = workspaceOnlyApply();
      const postImportMem = fileSnap(memPath);
      const postImportAudit = fileSnap(personalMemoryAuditPath(ref));
      const origJournal = readJournal(ref, importId);
      assert.ok(origJournal?.committed && !origJournal.rolledBack);

      setMemoryCenterImportJournalHooksForTest({ failAfterJournalWrite: hookValue });
      const rolled = memoryCenterImportRollback(t, ["notes"], importId);
      setMemoryCenterImportJournalHooksForTest(null);
      assert.equal(rolled.ok, false);

      const memAfter = fileSnap(memPath);
      const auditAfter = fileSnap(personalMemoryAuditPath(ref));
      const jAfter = readJournal(ref, importId);
      const rbAfter = readJournal(ref, `${importId}-rb`);

      assert.equal(memAfter.exists, postImportMem.exists);
      if (postImportMem.exists && memAfter.exists) assert.equal(memAfter.sha256, postImportMem.sha256);
      assert.equal(auditAfter.exists, postImportAudit.exists);
      if (postImportAudit.exists && auditAfter.exists) assert.equal(auditAfter.sha256, postImportAudit.sha256);
      assert.equal(jAfter?.committed, true);
      assert.notEqual(jAfter?.rolledBack, true);
      if (rbAfter) {
        assert.notEqual(rbAfter.committed, true);
        assert.ok(rbAfter.compensation === "failed" || rbAfter.compensation === "complete");
      }
    });
  }

  test("after audit append, journal commit failure restores audit and data", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const { t, memPath, importId, ref } = workspaceOnlyApply();
    const postImportMem = fileSnap(memPath);
    const postImportAudit = fileSnap(personalMemoryAuditPath(ref));
    writeFileSync(personalMemoryAuditPath(ref), '{"at":"2026-01-01T00:00:00.000Z","id":"seed","op":"test","actor":"page"}\n', {
      flag: "a",
    });
    const auditWithSeed = fileSnap(personalMemoryAuditPath(ref));

    setMemoryCenterImportJournalHooksForTest({ failAfterJournalWrite: 1 });
    const rolled = memoryCenterImportRollback(t, ["notes"], importId);
    setMemoryCenterImportJournalHooksForTest(null);
    assert.equal(rolled.ok, false);

    assert.equal(fileSnap(memPath).sha256, postImportMem.sha256);
    assert.equal(fileSnap(personalMemoryAuditPath(ref)).sha256, auditWithSeed.sha256);
    assert.notEqual(readJournal(ref, importId)?.rolledBack, true);
  });
});
