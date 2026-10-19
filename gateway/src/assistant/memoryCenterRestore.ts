import { existsSync, readFileSync, rmSync } from "node:fs";
import type {
  MemoryCenterRestoreData,
  MemoryCenterRestoreErrorCode,
  MemoryCenterScopeDetail,
} from "../../../shared/protocol.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import {
  appendAuditRecord,
  applyRollbackToLines,
  auditFilePath,
  canRestoreAudit,
  findAuditRecord,
  findIndexedRow,
  lineToAuditSnapshot,
  readAuditRecords,
  validateAuditSnapshotShape,
} from "./memoryCenterAudit.ts";
import { memoryCenterGet } from "./memoryCenter.ts";
import { indexMemoryRowsFromLines, parseMemoryFileLines, writeMemoryView } from "./memoryCenterMutateShared.ts";
import { resolveWorkspaceScope } from "./memoryCenterScope.ts";
import { ensureMemoryJieboGitignore, parseMemoryFile, type WorkspaceRoot } from "./workspaceMemory.ts";

const EMPTY_MEMORY_HEAD =
  "# 工作区记忆\n\n<!-- 接驳维护：每条一行，可以手改或删。行尾注释是来源和引用的路径，引用的文件没了会标“待核实”。这里不放个人信息。 -->\n";

export type RestoreFail = {
  ok: false;
  code: MemoryCenterRestoreErrorCode;
  message: string;
  detail?: MemoryCenterScopeDetail;
};

export type RestoreOk = { ok: true; data: MemoryCenterRestoreData };

function fail(code: MemoryCenterRestoreErrorCode, message: string, detail?: MemoryCenterScopeDetail): RestoreFail {
  return { ok: false, code, message, detail };
}

function scopeDetailAfter(tenant: WorkspaceRoot, workspaceNames: string[], scopeId: string) {
  const got = memoryCenterGet(tenant, workspaceNames, scopeId);
  if (got.mode !== "detail") return undefined;
  return got.detail;
}

function rollbackMemoryBytes(paths: { memory: string }, memoryExisted: boolean, rollbackBytes: string) {
  try {
    if (memoryExisted) atomicWriteFileSync(paths.memory, rollbackBytes, { mkdir: true });
    else rmSync(paths.memory, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function memoryCenterRestore(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  input: { scope: string; auditId: string },
): RestoreOk | RestoreFail {
  const resolved = resolveWorkspaceScope(tenant, workspaceNames, input.scope);
  if (!resolved.ok) return fail("invalid_scope", resolved.message);

  const { scopeId, paths, absDir, root } = resolved;

  return withFileLockSync(paths.lockTarget, () => {
    const auditFile = auditFilePath(paths);
    const all = readAuditRecords(auditFile);
    const record = findAuditRecord(paths, scopeId, input.auditId);
    if (!record) return fail("not_found", "找不到该审计记录。");
    if (record.scope !== scopeId) return fail("invalid_scope", "审计记录不属于此 scope。");
    const shape = validateAuditSnapshotShape(record);
    if (!shape.ok) return fail("corrupt_audit", shape.reason);

    const memoryExisted = existsSync(paths.memory);
    let rawText = "";
    try {
      rawText = readFileSync(paths.memory, "utf8");
    } catch {
      rawText = "";
    }
    const rollbackBytes = rawText;
    let view = rawText.length ? parseMemoryFileLines(rawText) : parseMemoryFileLines(EMPTY_MEMORY_HEAD);
    const lines = view.lines;
    const memoryLines = parseMemoryFile(rawText.length ? rawText : EMPTY_MEMORY_HEAD);
    const gate = canRestoreAudit(record, all.records, memoryLines);
    if (!gate.ok) {
      const detail = scopeDetailAfter(tenant, workspaceNames, scopeId);
      return fail("conflict", gate.reason, detail);
    }

    const itemId = record.itemId;
    const currentRow = findIndexedRow(lines, itemId);
    const beforeSnap = currentRow
      ? lineToAuditSnapshot(currentRow.line, lines[currentRow.row], currentRow.row)
      : undefined;

    let deletedId: string | undefined;
    try {
      const applied = applyRollbackToLines(lines, record, memoryLines);
      deletedId = applied.deletedId;
    } catch {
      return fail("conflict", "无法应用回滚。");
    }

    view = { ...view, lines };
    try {
      ensureMemoryJieboGitignore(resolved.absDir, resolved.root);
      writeMemoryView(paths, view);
    } catch (err) {
      return fail("write_failed", `写入失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const afterLines = parseMemoryFile(serializeLinesForParse(lines));
    const afterRow = findIndexedRow(lines, itemId);
    const afterSnap = afterRow ? lineToAuditSnapshot(afterRow.line, lines[afterRow.row], afterRow.row) : undefined;

    try {
      appendAuditRecord(paths, {
        scope: scopeId,
        itemId,
        action: "restore",
        actor: "user",
        at: new Date().toISOString(),
        before: beforeSnap,
        after: afterSnap,
      });
    } catch {
      const ok = rollbackMemoryBytes(paths, memoryExisted, rollbackBytes);
      if (!ok) {
        return fail("write_failed", "审计失败且记忆回滚失败，请人工检查 memory.md。");
      }
      return fail("write_failed", "审计写入失败，已回滚记忆。");
    }

    const detail = scopeDetailAfter(tenant, workspaceNames, scopeId);
    if (!detail) return fail("write_failed", "恢复成功但无法生成详情。");
    const hit = afterRow ? detail.items.find((row) => row.id === itemId) : undefined;
    void afterLines;
    return {
      ok: true,
      data: {
        scope: scopeId,
        auditId: input.auditId,
        item: hit,
        deletedId,
        detail,
      },
    };
  });
}

function serializeLinesForParse(lines: string[]) {
  return lines.join("\n") + (lines.length ? "\n" : "");
}
