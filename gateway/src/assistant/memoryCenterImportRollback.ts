import type { MemoryCenterImportRollbackData } from "../../../shared/memoryCenterImportTypes.ts";
import {
  captureFileStep,
  compensateJournalSteps,
  importJournalAbsPath,
  latestCommittedImport,
  readJournal,
  refreshStepAfterSha,
  restoreFileStep,
  sha256FileContent,
  writeJournalDurable,
  type ImportJournal,
} from "./memoryCenterImportJournal.ts";
import { appendPersonalMemoryAuditDurable, personalMemoryAuditPath } from "./memoryCenterImportPersonalAudit.ts";
import { rollbackHookMaybeFailPersonalAudit } from "./memoryCenterImportRollbackHooks.ts";
import { collectImportLockTargets, pathForImportTarget, withImportLocksInOrder } from "./memoryCenterImportLocks.ts";
import { type TenantRef } from "./store.ts";
import type { WorkspaceRoot } from "./workspaceMemory.ts";

function currentHash(path: string) {
  return sha256FileContent(path);
}

export function memoryCenterImportRollback(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  importId: string,
): { ok: true; data: MemoryCenterImportRollbackData } | { ok: false; error: string; code: string } {
  const ref: TenantRef = { id: tenant.id, stateDir: tenant.stateDir };
  const journalPeek = readJournal(ref, importId);
  if (!journalPeek || !journalPeek.committed) return { ok: false, error: "找不到可回滚的导入。", code: "not_found" };
  if (journalPeek.rolledBack) return { ok: true, data: { importId, status: "already_rolled_back" } };

  const lockTargets =
    journalPeek.lockTargets?.length > 0
      ? journalPeek.lockTargets
      : collectImportLockTargets(ref, tenant, workspaceNames, undefined);

  return withImportLocksInOrder(lockTargets, () => {
    const journal = readJournal(ref, importId);
    if (!journal || !journal.committed) return { ok: false, error: "找不到可回滚的导入。", code: "not_found" };
    if (journal.rolledBack) return { ok: true, data: { importId, status: "already_rolled_back" } };
    const latest = latestCommittedImport(ref);
    if (!latest || latest.importId !== importId) {
      return { ok: false, error: "只能回滚最近一次未回滚的导入。", code: "not_latest" };
    }

    for (const step of journal.steps) {
      const path = step.path || pathForImportTarget(ref, tenant, workspaceNames, step.target);
      if (!path) continue;
      step.path = path;
      const post = journal.postImportHashes?.[step.target] ?? step.afterSha;
      if (currentHash(path) !== post) {
        return {
          ok: false,
          error: `当前文件与导入后状态不一致，无法安全回滚（${step.target}）。`,
          code: "hash_conflict",
        };
      }
    }

    const journalFlagsBackup = { rolledBack: journal.rolledBack, phase: journal.phase, committed: journal.committed };
    const journalFileStep = captureFileStep(`import-journal:${importId}`, importJournalAbsPath(ref, importId));
    const personalAuditStep = captureFileStep("rollback:personal:audit", personalMemoryAuditPath(ref));

    const rollbackJournal: ImportJournal = {
      importId: `${importId}-rb`,
      planId: journal.planId,
      startedAt: new Date().toISOString(),
      lockTargets,
      steps: [
        journalFileStep,
        personalAuditStep,
        ...journal.steps.map((s) => {
          const path = s.path || pathForImportTarget(ref, tenant, workspaceNames, s.target);
          return captureFileStep(`rollback:${s.target}`, path);
        }),
      ],
      phase: "rollback",
      compensation: "none",
    };

    try {
      writeJournalDurable(ref, rollbackJournal);
      for (const step of [...journal.steps].reverse()) {
        const path = step.path || pathForImportTarget(ref, tenant, workspaceNames, step.target);
        if (!path) continue;
        step.path = path;
        restoreFileStep(step);
      }

      rollbackHookMaybeFailPersonalAudit();
      appendPersonalMemoryAuditDurable(ref, { id: importId, op: "import_rollback", actor: "page" });
      refreshStepAfterSha(personalAuditStep);

      journal.rolledBack = true;
      journal.phase = "rolled_back";
      writeJournalDurable(ref, journal);
      rollbackJournal.committed = true;
      rollbackJournal.compensation = "none";
      writeJournalDurable(ref, rollbackJournal);

      return { ok: true as const, data: { importId, status: "rolled_back" } };
    } catch (err) {
      const comp = compensateJournalSteps(rollbackJournal, [...rollbackJournal.steps]);
      journal.rolledBack = journalFlagsBackup.rolledBack;
      journal.phase = journalFlagsBackup.phase;
      journal.committed = journalFlagsBackup.committed;
      rollbackJournal.committed = false;
      rollbackJournal.compensation = comp.ok ? "complete" : "failed";
      if (!comp.ok) rollbackJournal.compensationError = comp.error;
      try {
        writeJournalDurable(ref, rollbackJournal, { skipTestHook: true });
      } catch {
        // 尽力持久化 failed 状态供 recover
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : comp.ok ? "回滚失败。" : comp.error,
        code: "write_failed",
      };
    }
  });
}
