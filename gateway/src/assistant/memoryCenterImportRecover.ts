import {
  compensateJournalSteps,
  listJournals,
  readJournal,
  writeJournalDurable,
} from "./memoryCenterImportJournal.ts";
import { recoverImportJournalStep } from "./memoryCenterImportApply.ts";
import { withImportLocksInOrder } from "./memoryCenterImportLocks.ts";
import type { TenantRef } from "./store.ts";
import type { WorkspaceRoot } from "./workspaceMemory.ts";

export function recoverPendingMemoryCenterImports(ref: TenantRef, tenant: WorkspaceRoot, workspaceNames: string[]) {
  for (const peek of listJournals(ref)) {
    if (peek.committed && peek.rolledBack) continue;
    if (peek.committed && !peek.rolledBack) continue;
    const locks = peek.lockTargets?.length ? peek.lockTargets : [];
    withImportLocksInOrder(locks, () => {
      const journal = readJournal(ref, peek.importId);
      if (!journal || journal.committed || journal.rolledBack) return;
      if (journal.compensation === "failed" || journal.compensation === "pending" || journal.compensation === "partial") {
        const comp = compensateJournalSteps(journal, journal.steps);
        if (comp.ok) {
          journal.rolledBack = true;
          journal.phase = "rolled_back";
          journal.compensation = "complete";
        } else {
          journal.compensation = "failed";
          journal.compensationError = comp.error;
        }
        writeJournalDurable(ref, journal);
        return;
      }
      for (const step of [...journal.steps].reverse()) {
        recoverImportJournalStep(ref, tenant, workspaceNames, step);
      }
      journal.rolledBack = true;
      journal.phase = "rolled_back";
      journal.compensation = "complete";
      writeJournalDurable(ref, journal);
    });
  }
}
