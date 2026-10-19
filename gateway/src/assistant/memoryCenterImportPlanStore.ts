import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { StoredImportPlan } from "../../../shared/memoryCenterImportTypes.ts";
import { atomicWriteFileSync } from "../fsAtomic.ts";
import { assistantPath, newId, type TenantRef } from "./store.ts";

const PLAN_TTL_MS = 30 * 60_000;

function plansDir(ref: TenantRef) {
  return assistantPath(ref, "memory-import-plans");
}

function planPath(ref: TenantRef, planId: string) {
  return resolve(plansDir(ref), `${planId}.json`);
}

export function saveImportPlan(ref: TenantRef, plan: StoredImportPlan) {
  atomicWriteFileSync(planPath(ref, plan.planId), JSON.stringify(plan, null, 1), { mkdir: true, mode: 0o600 });
}

export function loadImportPlan(ref: TenantRef, planId: string): StoredImportPlan | null {
  sweepExpiredPlans(ref);
  try {
    if (!planId || planId.includes("/") || planId.includes("..")) return null;
    const raw = readFileSync(planPath(ref, planId), "utf8");
    return JSON.parse(raw) as StoredImportPlan;
  } catch {
    return null;
  }
}

export function isPlanExpired(plan: StoredImportPlan, now = Date.now()) {
  return Date.parse(plan.expiresAt) <= now;
}

export function sweepExpiredPlans(ref: TenantRef, now = Date.now()) {
  const dir = plansDir(ref);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = resolve(dir, name);
    try {
      const plan = JSON.parse(readFileSync(file, "utf8")) as StoredImportPlan;
      if (isPlanExpired(plan, now)) rmSync(file, { force: true });
    } catch {
      rmSync(file, { force: true });
    }
  }
}

export function newPlanId() {
  return newId("mcplan");
}

export function planExpiresAt(from = Date.now()) {
  return new Date(from + PLAN_TTL_MS).toISOString();
}

export function planFileAge(ref: TenantRef, planId: string) {
  try {
    return statSync(planPath(ref, planId)).mtimeMs;
  } catch {
    return 0;
  }
}
