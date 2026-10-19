import { readFileSync } from "node:fs";
import type { MemoryCenterActivityAction, MemoryCenterActivityData } from "../../../shared/protocol.ts";
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  auditFilePath,
  encodeActivityCursor,
  readAuditRecords,
  startIndexAfterActivityCursor,
  toActivityEntry,
} from "./memoryCenterAudit.ts";
import { listWorkspaceScopeIds, resolveWorkspaceScope } from "./memoryCenterScope.ts";
import { parseMemoryFile, safeMemoryPaths, type WorkspaceRoot } from "./workspaceMemory.ts";

type ScopeAuditBundle = {
  scopeId: string;
  records: ReturnType<typeof readAuditRecords>["records"];
  corrupt: number;
  truncated: boolean;
  memoryLines: ReturnType<typeof parseMemoryFile>;
};

function loadScopeAudit(tenant: WorkspaceRoot, workspaceNames: string[], scopeId: string): ScopeAuditBundle | null {
  const resolved = resolveWorkspaceScope(tenant, workspaceNames, scopeId);
  if (!resolved.ok) return null;
  let paths;
  try {
    paths = safeMemoryPaths(resolved.absDir, resolved.root);
  } catch {
    return null;
  }
  const file = auditFilePath(paths);
  const read = readAuditRecords(file);
  let memoryLines: ReturnType<typeof parseMemoryFile> = [];
  try {
    memoryLines = parseMemoryFile(readFileSync(paths.memory, "utf8"));
  } catch {
    memoryLines = [];
  }
  return {
    scopeId,
    records: read.records.map((row) => ({ ...row, scope: scopeId })),
    corrupt: read.corruptLines,
    truncated: read.truncated,
    memoryLines,
  };
}

function mergeActivityEntries(bundles: ScopeAuditBundle[], actionFilter?: MemoryCenterActivityAction) {
  const merged: Array<{ at: string; scope: string; entry: ReturnType<typeof toActivityEntry> }> = [];
  let degraded = false;
  let truncatedRead = false;
  for (const bundle of bundles) {
    if (bundle.corrupt > 0) degraded = true;
    if (bundle.truncated) truncatedRead = true;
    for (const record of bundle.records) {
      if (actionFilter && record.action !== actionFilter) continue;
      merged.push({
        at: record.at,
        scope: bundle.scopeId,
        entry: toActivityEntry(record, bundle.memoryLines, bundle.records, bundle.corrupt > 0),
      });
    }
  }
  merged.sort((a, b) => {
    if (a.at !== b.at) return b.at.localeCompare(a.at);
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return b.entry.auditId.localeCompare(a.entry.auditId);
  });
  return { merged, degraded, truncatedRead };
}

export function memoryCenterActivity(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  input: { scope?: string; cursor?: string; limit?: number; action?: MemoryCenterActivityAction },
): MemoryCenterActivityData {
  const limit = Math.min(Math.max(input.limit ?? ACTIVITY_DEFAULT_LIMIT, 1), ACTIVITY_MAX_LIMIT);
  const actionFilter = input.action;
  const scopes = input.scope?.trim()
    ? [input.scope.trim()]
    : listWorkspaceScopeIds(tenant, workspaceNames);
  const bundles: ScopeAuditBundle[] = [];
  for (const scopeId of scopes) {
    const bundle = loadScopeAudit(tenant, workspaceNames, scopeId);
    if (bundle) bundles.push(bundle);
  }
  const { merged, degraded, truncatedRead } = mergeActivityEntries(bundles, actionFilter);
  const start = startIndexAfterActivityCursor(merged, input.cursor);
  const slice = merged.slice(start, start + limit);
  const lastInPage = slice[slice.length - 1];
  const hasMore = start + limit < merged.length;
  return {
    entries: slice.map((row) => row.entry),
    nextCursor:
      hasMore && lastInPage
        ? encodeActivityCursor(lastInPage.scope, lastInPage.entry.auditId, lastInPage.at)
        : undefined,
    truncated: truncatedRead || start + limit < merged.length,
    degraded: degraded || undefined,
  };
}

/** 测试：分页遍历应覆盖 filter 后全集且无重复。 */
export function collectAllActivityEntries(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  input: { scope?: string; action?: MemoryCenterActivityAction; pageSize?: number },
) {
  const pageSize = input.pageSize ?? 5;
  const all: ReturnType<typeof toActivityEntry>[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = memoryCenterActivity(tenant, workspaceNames, {
      scope: input.scope,
      action: input.action,
      cursor,
      limit: pageSize,
    });
    for (const entry of page.entries) {
      if (all.some((row) => row.auditId === entry.auditId && row.scope === entry.scope)) {
        throw new Error(`duplicate activity entry ${entry.scope}:${entry.auditId}`);
      }
      all.push(entry);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}
