import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

function canonicalLockPath(path: string) {
  try {
    if (existsSync(path)) return realpathSync(path);
  } catch {
    // fall through
  }
  return resolve(path);
}
import { withFileLockSync } from "../fsAtomic.ts";
import { personalMemoryLockPath } from "./personalMemoryLock.ts";
import { resolveWorkspaceScope } from "./memoryCenterScope.ts";
import { assistantPath, type TenantRef } from "./store.ts";
import type { StoredImportPlan } from "../../../shared/memoryCenterImportTypes.ts";
import type { WorkspaceRoot } from "./workspaceMemory.ts";

/** personal state 锁 + 涉及 workspace 的 lockTarget，按规范 realpath 字典序嵌套持有。 */
export function collectImportLockTargets(
  ref: TenantRef,
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  plan?: StoredImportPlan,
): string[] {
  const paths = new Set<string>();
  paths.add(canonicalLockPath(personalMemoryLockPath(ref)));
  const scopes = new Set<string>();
  if (plan) {
    for (const ch of plan.changes) {
      if (ch.scope && ch.scope !== "personal" && ch.scope !== "work_preference") scopes.add(ch.scope);
    }
    for (const key of Object.keys(plan.casHashes)) {
      if (key.startsWith("ws:")) scopes.add(key.split(":")[1]);
    }
  }
  for (const scopeId of [...scopes].sort()) {
    const r = resolveWorkspaceScope(tenant, workspaceNames, scopeId);
    if (r.ok) paths.add(canonicalLockPath(r.paths.lockTarget));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function withImportLocksInOrder<T>(lockTargets: string[], fn: () => T): T {
  if (!lockTargets.length) return fn();
  const [head, ...rest] = lockTargets;
  return withFileLockSync(head, () => withImportLocksInOrder(rest, fn), { timeoutMs: 15_000 });
}

export function pathForImportTarget(
  ref: TenantRef,
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  target: string,
): string {
  if (target === "personal:core") return assistantPath(ref, "memory", "core.json");
  if (target === "personal:entries") return assistantPath(ref, "memory", "entries.json");
  if (target === "personal:settings") return assistantPath(ref, "memory", "settings.json");
  if (target === "personal:audit") return assistantPath(ref, "memory-audit.jsonl");
  if (target.startsWith("ws:")) {
    const parts = target.split(":");
    const scopeId = parts[1];
    const kind = parts[2];
    const r = resolveWorkspaceScope(tenant, workspaceNames, scopeId);
    if (!r.ok) return "";
    if (kind === "memory") return r.paths.memory;
    if (kind === "audit") return resolve(r.paths.jiebo, "memory-audit.jsonl");
    if (kind === "gitignore") return resolve(r.paths.jiebo, ".gitignore");
  }
  return "";
}
