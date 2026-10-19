import type { MemoryCenterMutateErrorCode, MemoryCenterScopeDetail } from "../../../shared/protocol.ts";
import { discoverScopesForTest } from "./memoryCenter.ts";
import { safeMemoryPaths, type WorkspaceRoot } from "./workspaceMemory.ts";

export type ScopeResolveFail = {
  ok: false;
  code: MemoryCenterMutateErrorCode;
  message: string;
  detail?: MemoryCenterScopeDetail;
};

type Discovered = ReturnType<typeof discoverScopesForTest>;
type ScopeRecord = Discovered["scopes"] extends Map<string, infer V> ? V : never;

export type ScopeResolveOk = {
  ok: true;
  discovered: Discovered;
  record: ScopeRecord;
  scopeId: string;
  absDir: string;
  root: string;
  ref: Discovered["ref"];
  paths: ReturnType<typeof safeMemoryPaths>;
};

export function resolveWorkspaceScope(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  scopeRaw: string,
): ScopeResolveOk | ScopeResolveFail {
  const discovered = discoverScopesForTest(tenant, workspaceNames);
  const scope = scopeRaw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!scope || scope.includes("..") || scope === ".") {
    return { ok: false, code: "invalid_scope", message: "scope 不合法。" };
  }
  if (scope === "personal" || scope === "work_preference") {
    return { ok: false, code: "invalid_scope", message: "个人与工作偏好不在此接口范围。" };
  }
  const record = discovered.scopes.get(scope);
  if (!record || record.kind !== "workspace_memory" || !record.absDir) {
    return { ok: false, code: "invalid_scope", message: "未知或未授权的工作区作用域。" };
  }
  try {
    const paths = safeMemoryPaths(record.absDir, discovered.root);
    return {
      ok: true,
      discovered,
      record,
      scopeId: scope,
      absDir: record.absDir,
      root: discovered.root,
      ref: discovered.ref,
      paths,
    };
  } catch {
    return { ok: false, code: "invalid_scope", message: "作用域路径不安全。" };
  }
}

export function listWorkspaceScopeIds(tenant: WorkspaceRoot, workspaceNames: string[]) {
  const discovered = discoverScopesForTest(tenant, workspaceNames);
  return [...discovered.scopes.values()]
    .filter((row) => row.kind === "workspace_memory" && row.absDir)
    .map((row) => row.id);
}
