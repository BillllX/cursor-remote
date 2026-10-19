import { withFileLockSync } from "../fsAtomic.ts";
import { assistantPath, type TenantRef } from "./store.ts";

export function personalMemoryLockPath(ref: TenantRef) {
  return assistantPath(ref, "memory", ".state.lock");
}

export function withPersonalMemoryLockSync<T>(ref: TenantRef, fn: () => T): T {
  return withFileLockSync(personalMemoryLockPath(ref), fn, { timeoutMs: 5_000 });
}
