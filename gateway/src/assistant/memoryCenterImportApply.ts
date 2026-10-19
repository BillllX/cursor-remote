import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MemoryCenterImportApplyData,
  MemoryCenterImportApplyResolution,
  MemoryCenterImportChange,
} from "../../../shared/memoryCenterImportTypes.ts";
import {
  audit,
  listMemory,
  readCore,
  WORK_PREF_FIELD,
  type CoreField,
} from "./memory.ts";
import { memoryCenterGet } from "./memoryCenter.ts";
import { appendAuditRecord, lineToAuditSnapshot } from "./memoryCenterAudit.ts";
import { discoverScopesForTest } from "./memoryCenter.ts";
import { resolveWorkspaceScope } from "./memoryCenterScope.ts";
import { isPlanExpired, loadImportPlan } from "./memoryCenterImportPlanStore.ts";
import {
  captureFileStep,
  compensateJournalSteps,
  newImportId,
  planHasCommittedImport,
  refreshStepAfterSha,
  restoreFileStep,
  sha256FileContent,
  sweepImportJournals,
  writeJournalDurable,
  type ImportJournal,
  type ImportJournalStep,
} from "./memoryCenterImportJournal.ts";
import {
  collectImportLockTargets,
  pathForImportTarget,
  withImportLocksInOrder,
} from "./memoryCenterImportLocks.ts";
import { validateApplyResolutions } from "./memoryCenterImportResolutions.ts";
import { authorityDurableWrite, authorityDurableWriteJson } from "./memoryCenterImportAuthorityWrite.ts";
import { importAuthorityWriter } from "./memoryCenterImportFileWriter.ts";
import { assistantPath, newId, type TenantRef } from "./store.ts";
import { validateMemoryCenterSnapshotV1 } from "../../../shared/memoryCenterSnapshot.ts";
import {
  formatMemoryLine,
  planMemoryJieboGitignore,
  type MemoryLine,
  parseMemoryFile,
  type WorkspaceRoot,
} from "./workspaceMemory.ts";
import { indexMemoryRowsFromLines, parseMemoryFileLines, writeMemoryView } from "./memoryCenterMutateShared.ts";

function verifyCas(plan: import("../../../shared/memoryCenterImportTypes.ts").StoredImportPlan, ref: TenantRef, tenant: WorkspaceRoot, workspaceNames: string[]) {
  const current: Record<string, string> = {};
  current["personal:core"] = sha256FileContent(assistantPath(ref, "memory", "core.json"));
  current["personal:entries"] = sha256FileContent(assistantPath(ref, "memory", "entries.json"));
  current["personal:settings"] = sha256FileContent(assistantPath(ref, "memory", "settings.json"));
  const discovered = discoverScopesForTest(tenant, workspaceNames);
  for (const [scopeId, record] of discovered.scopes) {
    if (!record.absDir || scopeId === "personal" || scopeId === "work_preference" || scopeId === "personal_settings") continue;
    current[`ws:${scopeId}:memory`] = sha256FileContent(resolve(record.absDir, ".jiebo/memory.md"));
  }
  for (const [key, hash] of Object.entries(plan.casHashes)) {
    if (current[key] !== hash) return false;
  }
  return true;
}

function defaultResolution(change: MemoryCenterImportChange) {
  if (change.action === "unchanged" || change.action === "skip") return "keep_current" as const;
  if (change.action === "add") return "use_snapshot" as const;
  return "keep_current" as const;
}

export function memoryCenterImportApply(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  planId: string,
  resolutions: MemoryCenterImportApplyResolution[],
): { ok: true; data: MemoryCenterImportApplyData } | { ok: false; error: string; code: string } {
  const ref: TenantRef = { id: tenant.id, stateDir: tenant.stateDir };
  const planPeek = loadImportPlan(ref, planId);
  if (!planPeek) return { ok: false, error: "计划不存在或已过期。", code: "plan_not_found" };
  const lockTargets = collectImportLockTargets(ref, tenant, workspaceNames, planPeek);

  return withImportLocksInOrder(lockTargets, () => {
    const plan = loadImportPlan(ref, planId);
    if (!plan || isPlanExpired(plan)) return { ok: false, error: "计划不存在或已过期。", code: "plan_not_found" };
    if (planHasCommittedImport(ref, planId)) {
      return { ok: false, error: "该计划已应用过。", code: "plan_already_applied" };
    }
    if (!verifyCas(plan, ref, tenant, workspaceNames)) {
      return { ok: false, error: "目标文件已变更，请重新预演。", code: "cas_conflict" };
    }
    const parsedRes = validateApplyResolutions(plan.changes, resolutions);
    if (!parsedRes.ok) return { ok: false, error: parsedRes.error, code: parsedRes.code };
    const resMap = parsedRes.map;

    const bytesHash = createHash("sha256").update(plan.snapshotBytes, "utf8").digest("hex");
    if (bytesHash !== plan.snapshotSha256) {
      return { ok: false, error: "计划内快照已被篡改。", code: "malformed_snapshot" };
    }
    let snapshotParsed: unknown;
    try {
      snapshotParsed = JSON.parse(plan.snapshotBytes);
    } catch {
      return { ok: false, error: "计划内快照 JSON 无效。", code: "malformed_snapshot" };
    }
    const validatedSnap = validateMemoryCenterSnapshotV1(snapshotParsed);
    if (!validatedSnap.ok) {
      return { ok: false, error: validatedSnap.errors.join(" "), code: "malformed_snapshot" };
    }
    const snapshot = validatedSnap.snapshot;
    const includedWs = new Set(snapshot.manifest.includedScopes.workspaceIds);

    const importId = newImportId();
    const journal: ImportJournal = {
      importId,
      planId,
      startedAt: new Date().toISOString(),
      lockTargets,
      steps: [],
      phase: "capturing",
      compensation: "none",
      postImportHashes: {},
      authorityDurableComplete: false,
    };

    let applied = 0;
    let skipped = 0;
    let conflictsResolved = 0;

    try {
      writeJournalDurable(ref, journal);

      const corePath = assistantPath(ref, "memory", "core.json");
      const entriesPath = assistantPath(ref, "memory", "entries.json");
      const settingsPath = assistantPath(ref, "memory", "settings.json");
      const personalAuditPath = assistantPath(ref, "memory-audit.jsonl");

      const willTouchCore = plan.changes.some(
        (c) => c.layer === "personal_core" && (resMap.get(c.changeId) ?? defaultResolution(c)) === "use_snapshot",
      );
      const willTouchEntries = plan.changes.some(
        (c) =>
          c.layer === "personal_entries" &&
          (resMap.get(c.changeId) ?? defaultResolution(c)) !== "keep_current" &&
          c.action !== "unchanged" &&
          c.action !== "skip",
      );
      const willTouchSettings = plan.changes.some(
        (c) => c.layer === "personal_settings" && (resMap.get(c.changeId) ?? defaultResolution(c)) === "use_snapshot",
      );
      const willTouchWp = plan.changes.some(
        (c) => c.layer === "work_preference" && (resMap.get(c.changeId) ?? defaultResolution(c)) === "use_snapshot",
      );

      if (willTouchCore) journal.steps.push(captureFileStep("personal:core", corePath));
      if (willTouchEntries) journal.steps.push(captureFileStep("personal:entries", entriesPath));
      if (willTouchSettings) journal.steps.push(captureFileStep("personal:settings", settingsPath));
      if (willTouchCore || willTouchEntries || willTouchSettings || willTouchWp) {
        journal.steps.push(captureFileStep("personal:audit", personalAuditPath));
      }
      writeJournalDurable(ref, journal);

      const core = readCore(ref);
      let entries = [...listMemory(ref).entries];
      const entriesRev = listMemory(ref).rev;
      let coreFields: Record<CoreField, string> = { ...core.fields };

      for (const change of plan.changes) {
        const resolution = resMap.get(change.changeId) ?? defaultResolution(change);
        if (change.action === "unchanged" || change.action === "skip" || resolution === "keep_current") {
          skipped += 1;
          continue;
        }
        if (change.action === "conflict") conflictsResolved += 1;
        applied += 1;

        if (change.layer === "personal_core" && resolution === "use_snapshot") {
          for (const [k, v] of Object.entries(snapshot.personal.core.fields)) {
            if (k !== WORK_PREF_FIELD) coreFields[k as CoreField] = v;
          }
        }
        if (change.layer === "work_preference" && resolution === "use_snapshot") {
          coreFields[WORK_PREF_FIELD] = snapshot.workPreferences.text;
        }
        if (change.layer === "personal_settings" && resolution === "use_snapshot") {
          authorityDurableWriteJson(settingsPath, snapshot.personal.settings);
        }
        if (change.layer === "personal_entries" && change.id) {
          const inc = snapshot.personal.entries.find((e) => e.id === change.id);
          if (!inc) continue;
          if (resolution === "use_snapshot") {
            const idx = entries.findIndex((e) => e.id === change.id);
            if (idx >= 0) entries[idx] = { ...inc };
            else entries.push({ ...inc });
            audit(ref, { id: inc.id, op: "import", actor: "page", text: planId });
          } else if (resolution === "duplicate") {
            const dup = { ...inc, id: newId("mem") };
            entries.push(dup);
            audit(ref, { id: dup.id, op: "import", actor: "page", text: planId });
          }
        }
      }

      if (willTouchCore || willTouchWp) {
        const nextCore = { ...core, rev: core.rev + 1, fields: coreFields, updatedAt: new Date().toISOString() };
        authorityDurableWriteJson(corePath, nextCore);
      }
      if (willTouchEntries) {
        authorityDurableWriteJson(entriesPath, { rev: entriesRev + 1, entries });
      }

      for (const ws of snapshot.workspaces.filter((w) => includedWs.has(w.scopeId))) {
        const resolved = resolveWorkspaceScope(tenant, workspaceNames, ws.scopeId);
        if (!resolved.ok) continue;
        const scopeChanges = plan.changes.filter((c) => c.scope === ws.scopeId);
        const structChange = scopeChanges.find((c) => c.layer === "workspace_structure");
        const structRes = structChange ? (resMap.get(structChange.changeId) ?? defaultResolution(structChange)) : "keep_current";
        const entryChanges = scopeChanges.filter((c) => c.layer === "workspace_entries");
        const hasEntryApply = entryChanges.some(
          (c) =>
            (resMap.get(c.changeId) ?? defaultResolution(c)) !== "keep_current" &&
            c.action !== "unchanged" &&
            c.action !== "skip",
        );
        if (structRes !== "use_snapshot" && !hasEntryApply) continue;

        journal.steps.push(captureFileStep(`ws:${ws.scopeId}:memory`, resolved.paths.memory));
        journal.steps.push(captureFileStep(`ws:${ws.scopeId}:audit`, resolve(resolved.paths.jiebo, "memory-audit.jsonl")));
        journal.steps.push(captureFileStep(`ws:${ws.scopeId}:gitignore`, resolve(resolved.paths.jiebo, ".gitignore")));
        writeJournalDurable(ref, journal);

        if (structRes === "use_snapshot") {
          authorityDurableWrite(resolved.paths.memory, ws.memoryRaw);
        } else if (hasEntryApply) {
          const writeAuth = importAuthorityWriter();
          const raw = existsSync(resolved.paths.memory) ? readFileSync(resolved.paths.memory, "utf8") : "";
          let view = raw.length ? parseMemoryFileLines(raw) : parseMemoryFileLines("## 约定\n");
          const linesArr = view.lines;
          const indexed = indexMemoryRowsFromLines(linesArr);
          const lineById = new Map(indexed.filter((r) => r.line.id).map((row) => [row.line.id!, row]));
          const incLines = parseMemoryFile(ws.memoryRaw);
          const auditRows: { itemId: string; line: MemoryLine; row: number; text: string }[] = [];
          for (const change of entryChanges) {
            const resolution = resMap.get(change.changeId) ?? defaultResolution(change);
            if (resolution === "keep_current" || change.action === "unchanged" || change.action === "skip") continue;
            const inc = incLines.find((l) => l.id === change.id);
            if (!inc) continue;
            if (resolution === "use_snapshot") {
              const hit = lineById.get(inc.id!);
              const formatted = formatMemoryLine(inc);
              if (hit) linesArr[hit.row] = formatted;
              else linesArr.push(formatted);
              const row = hit?.row ?? linesArr.length - 1;
              auditRows.push({ itemId: inc.id!, line: inc, row, text: formatted });
            } else if (resolution === "duplicate") {
              const dupId = newId("wm");
              const dupLine = { ...inc, id: dupId };
              const formatted = formatMemoryLine(dupLine);
              linesArr.push(formatted);
              auditRows.push({ itemId: dupId, line: dupLine, row: linesArr.length - 1, text: formatted });
            }
          }
          view = { ...view, lines: linesArr };
          writeMemoryView(resolved.paths, view, writeAuth);
          const gitPlan = planMemoryJieboGitignore(resolved.absDir, resolved.root);
          if (gitPlan) writeAuth(gitPlan.path, gitPlan.content);
          const importedAt = new Date().toISOString();
          for (const row of auditRows) {
            appendAuditRecord(
              resolved.paths,
              {
                scope: ws.scopeId,
                itemId: row.itemId,
                action: "import",
                actor: "user",
                at: importedAt,
                after: lineToAuditSnapshot(row.line, row.text, row.row),
              },
              writeAuth,
            );
          }
        }
      }

      journal.authorityDurableComplete = true;
      memoryCenterGet(tenant, workspaceNames);
      for (const step of journal.steps) {
        refreshStepAfterSha(step);
        journal.postImportHashes![step.target] = step.afterSha;
      }
      journal.phase = "committed";
      journal.committed = true;
      writeJournalDurable(ref, journal);
      sweepImportJournals(ref);

      return {
        ok: true as const,
        data: {
          importId,
          canRollback: true,
          summary: { applied, skipped, conflictsResolved },
        },
      };
    } catch (err) {
      const comp = compensateJournalSteps(journal, journal.steps);
      if (comp.ok) {
        journal.phase = "rolled_back";
        journal.rolledBack = true;
        journal.compensation = "complete";
      } else {
        journal.phase = "writing";
        journal.compensation = "failed";
        journal.compensationError = comp.error;
      }
      try {
        writeJournalDurable(ref, journal);
      } catch {
        // 补偿状态持久化尽力而为
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : comp.ok ? "写入失败。" : comp.error,
        code: "write_failed",
      };
    }
  });
}

export function recoverImportJournalStep(ref: TenantRef, tenant: WorkspaceRoot, workspaceNames: string[], step: ImportJournalStep) {
  if (!step.path) {
    step.path = pathForImportTarget(ref, tenant, workspaceNames, step.target);
  }
  if (step.path) restoreFileStep(step);
}
