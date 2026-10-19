import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildMemoryCenterSnapshotV1, finalizeSnapshotChecksums } from "../src/assistant/memoryCenterExport.ts";
import { setMemoryCenterExportScopeReaderForTest } from "../src/assistant/memoryCenterExportScopeReader.ts";
import * as scopedRead from "../src/assistant/scopedRead.ts";
import { buildImportPreviewFromSnapshot } from "../src/assistant/memoryCenterImportPreview.ts";
import { memoryCenterImportApply } from "../src/assistant/memoryCenterImportApply.ts";
import { listJournals, readJournal } from "../src/assistant/memoryCenterImportJournal.ts";
import { setMemoryCenterImportJournalHooksForTest } from "../src/assistant/memoryCenterImportHooks.ts";
import { recoverPendingMemoryCenterImports } from "../src/assistant/memoryCenterImportRecover.ts";
import { atomicWriteFileSync } from "../src/fsAtomic.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mc-fail-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tenant(id: string, workspaceRoot: string) {
  const stateDir = join(root, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "assistant", "memory"), { recursive: true });
  return { id, stateDir, workspaceRoot };
}

describe("memory center import failure matrix", () => {
  test("failAfterFileWrite aborts apply and keeps workspace bytes", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "fail-file");
    const ws = join(base, "notes");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    const before = "## 约定\n- a <!-- id=wm_f1 -->\n";
    writeFileSync(join(ws, ".jiebo/memory.md"), before);
    const t = tenant("fail-file", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, ["notes"], ["notes"]);
    snap.workspaces[0].memoryRaw = "## 约定\n- b <!-- id=wm_f1 -->\n";
    const finalized = finalizeSnapshotChecksums(snap);
    const preview = buildImportPreviewFromSnapshot(t, ["notes"], finalized, Buffer.from(JSON.stringify(finalized)));
    const conflicts = preview.changes.filter((c) => c.action === "conflict");
    setMemoryCenterImportJournalHooksForTest({ failAfterFileWrite: 4 });
    const applied = memoryCenterImportApply(
      t,
      ["notes"],
      preview.planId,
      conflicts.map((c) => ({ changeId: c.changeId, resolution: "use_snapshot" as const })),
    );
    setMemoryCenterImportJournalHooksForTest(null);
    assert.equal(applied.ok, false, applied.ok ? "expected apply failure" : applied.error);
    assert.equal(readFileSync(join(ws, ".jiebo/memory.md"), "utf8"), before);
  });

  test("failAfterJournalWrite on commit prevents committed flag", () => {
    if (!scopedRead.scopedReadSupported()) return;
    const base = join(root, "fail-journal");
    mkdirSync(join(base, ".jiebo", "memory-export"), { recursive: true });
    const t = tenant("fail-journal", base);
    setMemoryCenterExportScopeReaderForTest(scopedRead.readFileAtScope);
    const snap = buildMemoryCenterSnapshotV1(t, [], ["personal"]);
    const finalized = finalizeSnapshotChecksums(snap);
    const rel = ".jiebo/memory-export/snap.json";
    atomicWriteFileSync(join(base, rel), `${JSON.stringify(finalized, null, 1)}\n`, { mode: 0o600 });
    const preview = buildImportPreviewFromSnapshot(t, [], finalized, Buffer.from(JSON.stringify(finalized)));
    const coreConflict = preview.changes.find((c) => c.layer === "personal_core" && c.action === "conflict");
    if (!coreConflict) return;
    setMemoryCenterImportJournalHooksForTest({ failAfterJournalWrite: 0 });
    const applied = memoryCenterImportApply(t, [], preview.planId, [
      { changeId: coreConflict.changeId, resolution: "use_snapshot" },
    ]);
    setMemoryCenterImportJournalHooksForTest(null);
    assert.equal(applied.ok, false);
    const ref = { id: t.id, stateDir: t.stateDir };
    const j = listJournals(ref).find((x) => x.planId === preview.planId);
    assert.ok(j);
    assert.notEqual(j!.committed, true);
  });
});
