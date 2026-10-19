export type ImportRollbackTestHooks = { failPersonalAudit?: boolean };

let hooks: ImportRollbackTestHooks = {};

export function setMemoryCenterImportRollbackHooksForTest(next: ImportRollbackTestHooks | null) {
  hooks = next ?? {};
}

export function rollbackHookMaybeFailPersonalAudit() {
  if (hooks.failPersonalAudit) throw new Error("injected rollback personal audit failure");
}
