import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { authorityDurableWrite } from "./memoryCenterImportAuthorityWrite.ts";
import { journalHookMaybeFail } from "./memoryCenterImportHooks.ts";
import { assistantPath, newId, type TenantRef } from "./store.ts";

export type ImportJournalStep = {
  target: string;
  path: string;
  beforeExisted: boolean;
  beforeBase64: string;
  beforeMode: number | null;
  beforeSha: string;
  afterSha: string;
};

export type ImportJournalCompensation = "none" | "pending" | "partial" | "complete" | "failed";

export type ImportJournal = {
  importId: string;
  planId: string;
  startedAt: string;
  lockTargets: string[];
  steps: ImportJournalStep[];
  phase: "capturing" | "writing" | "committed" | "rollback" | "rolled_back";
  compensation: ImportJournalCompensation;
  compensationError?: string;
  committed?: boolean;
  rolledBack?: boolean;
  postImportHashes?: Record<string, string>;
  authorityDurableComplete?: boolean;
};

const RETENTION_COUNT = 10;
const RETENTION_MS = 30 * 24 * 3_600_000;

function journalsDir(ref: TenantRef) {
  return assistantPath(ref, "memory-import-journals");
}

export function importJournalAbsPath(ref: TenantRef, importId: string) {
  return resolve(journalsDir(ref), `${importId}.json`);
}

function journalPath(ref: TenantRef, importId: string) {
  return importJournalAbsPath(ref, importId);
}

export function newImportId() {
  return newId("mcimp");
}

export function sha256Buffer(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256Bytes(text: string) {
  return sha256Buffer(Buffer.from(text, "utf8"));
}

export function sha256FileContent(path: string) {
  try {
    if (!existsSync(path)) return sha256Bytes("");
    return sha256Buffer(readFileSync(path));
  } catch {
    return sha256Bytes("");
  }
}

export function captureFileStep(target: string, path: string): ImportJournalStep {
  let beforeExisted = false;
  let beforeBase64 = "";
  let beforeMode: number | null = null;
  let buf = Buffer.alloc(0);
  try {
    if (existsSync(path)) {
      const st = lstatSync(path);
      if (st.isFile()) {
        beforeExisted = true;
        beforeMode = st.mode & 0o777;
        buf = readFileSync(path);
        beforeBase64 = buf.toString("base64");
      }
    }
  } catch {
    beforeExisted = false;
  }
  return {
    target,
    path,
    beforeExisted,
    beforeBase64,
    beforeMode,
    beforeSha: sha256Buffer(buf),
    afterSha: "",
  };
}

export function readStepBeforeBytes(step: ImportJournalStep): Buffer {
  if (!step.beforeExisted || !step.beforeBase64) return Buffer.alloc(0);
  return Buffer.from(step.beforeBase64, "base64");
}

export function restoreFileStep(step: ImportJournalStep) {
  const abs = step.path;
  if (step.beforeExisted) {
    const buf = readStepBeforeBytes(step);
    authorityDurableWrite(abs, buf, step.beforeMode ?? 0o600, { bypassTestHook: true });
  } else if (existsSync(abs)) {
    rmSync(abs, { force: true });
  }
}

export function refreshStepAfterSha(step: ImportJournalStep) {
  try {
    if (!existsSync(step.path)) {
      step.afterSha = sha256Bytes("");
      return;
    }
    step.afterSha = sha256Buffer(readFileSync(step.path));
  } catch {
    step.afterSha = sha256Bytes("");
  }
}

export function writeJournalDurable(ref: TenantRef, journal: ImportJournal, opts?: { skipTestHook?: boolean }) {
  if (!opts?.skipTestHook) journalHookMaybeFail("journal");
  authorityDurableWrite(journalPath(ref, journal.importId), JSON.stringify(journal, null, 1));
}

export function compensateJournalSteps(
  journal: ImportJournal,
  steps: ImportJournalStep[],
): { ok: true } | { ok: false; error: string } {
  journal.compensation = "pending";
  for (const step of [...steps].reverse()) {
    try {
      restoreFileStep(step);
    } catch (err) {
      journal.compensation = "failed";
      journal.compensationError = err instanceof Error ? err.message : "compensation failed";
      return { ok: false, error: journal.compensationError };
    }
  }
  journal.compensation = "complete";
  return { ok: true };
}

export function planHasCommittedImport(ref: TenantRef, planId: string) {
  return listJournals(ref).some((j) => j.planId === planId && j.committed && !j.rolledBack);
}

export function readJournal(ref: TenantRef, importId: string): ImportJournal | null {
  try {
    if (!importId || importId.includes("/")) return null;
    const raw = JSON.parse(readFileSync(journalPath(ref, importId), "utf8")) as ImportJournal;
    return migrateJournal(raw);
  } catch {
    return null;
  }
}

function migrateJournal(j: ImportJournal): ImportJournal {
  for (const step of j.steps) {
    const legacy = step as ImportJournalStep & { beforeBytes?: string; beforeChecksum?: string; afterChecksum?: string };
    if (legacy.beforeBytes !== undefined && !step.beforeBase64) {
      step.beforeBase64 = Buffer.from(legacy.beforeBytes, "utf8").toString("base64");
      step.beforeSha = legacy.beforeChecksum ?? sha256Bytes(legacy.beforeBytes);
      step.afterSha = legacy.afterChecksum ?? step.afterSha;
      step.path = step.path || "";
      step.beforeMode = step.beforeMode ?? 0o600;
    }
  }
  if (!j.lockTargets) j.lockTargets = [];
  if (!j.phase) j.phase = j.committed ? "committed" : "capturing";
  if (!j.compensation) j.compensation = j.committed ? "none" : "none";
  return j;
}

export function listJournals(ref: TenantRef): ImportJournal[] {
  const dir = journalsDir(ref);
  if (!existsSync(dir)) return [];
  const out: ImportJournal[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const j = readJournal(ref, name.replace(/\.json$/, ""));
    if (j) out.push(j);
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function latestCommittedImport(ref: TenantRef): ImportJournal | null {
  return listJournals(ref).find((j) => j.committed && !j.rolledBack) ?? null;
}

export function sweepImportJournals(ref: TenantRef, now = Date.now()) {
  const dir = journalsDir(ref);
  if (!existsSync(dir)) return;
  const journals = listJournals(ref);
  const pending = journals.some((j) => !j.committed && !j.rolledBack);
  if (pending) return;
  const committed = journals.filter((j) => j.committed);
  for (let i = RETENTION_COUNT; i < committed.length; i += 1) {
    const old = committed[i];
    if (now - Date.parse(old.startedAt) > RETENTION_MS) {
      rmSync(journalPath(ref, old.importId), { force: true });
    }
  }
}

export { setMemoryCenterImportJournalHooksForTest } from "./memoryCenterImportHooks.ts";
