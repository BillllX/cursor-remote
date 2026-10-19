import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  prepareSecureMemoryExportDir,
  snapshotExportDirStat,
  verifyExportWriteParent,
} from "./memoryCenterExportPathSecurity.ts";
import { readScopeFileBytes, bufferToMemoryRawUtf8 } from "./memoryCenterScopeBytesRead.ts";
import { authorityDurableWrite } from "./memoryCenterImportAuthorityWrite.ts";
import {
  exportIncludesPersonal,
  exportIncludesPersonalSettings,
  exportIncludesWorkPreference,
} from "./memoryCenterExportScopes.ts";
import type { MemoryCenterExportData } from "../../../shared/memoryCenterImportTypes.ts";
import {
  detectSnapshotSecret,
  MEMORY_CENTER_SNAPSHOT_MAX_BYTES,
  snapshotPayloadForChecksum,
  stableSnapshotStringify,
  validateMemoryCenterSnapshotV1,
  type MemoryCenterSnapshotV1,
} from "../../../shared/memoryCenterSnapshot.ts";
import { resolveExportScopes } from "./memoryCenterExportScopes.ts";
import {
  emptyCore,
  listMemory,
  readCore,
  readSettings,
  WORK_PREF_FIELD,
  type MemoryEntry,
} from "./memory.ts";
import { discoverScopesForTest } from "./memoryCenter.ts";
import { parseMemoryFile, type WorkspaceRoot } from "./workspaceMemory.ts";
import * as scopedRead from "./scopedRead.ts";


function sha256Hex(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sanitizeEntry(entry: MemoryEntry) {
  const { id, rev, topic, kind, text, basis, confidence, source, validFrom, validUntil, createdAt, updatedAt, lastUsedAt, invalidAt, invalidReason, supplements, seen } =
    entry;
  return { id, rev, topic, kind, text, basis, confidence, source, validFrom, validUntil, createdAt, updatedAt, lastUsedAt, invalidAt, invalidReason, supplements, seen };
}

function summarizeWorkspaceMemory(raw: string) {
  const lines = parseMemoryFile(raw);
  let hot = 0;
  let cold = 0;
  let done = 0;
  let pinned = 0;
  let missingRefs = 0;
  for (const line of lines) {
    const st = line.state ?? "hot";
    if (st === "hot") hot += 1;
    else if (st === "cold") cold += 1;
    else if (st === "done") done += 1;
    if (line.pinned) pinned += 1;
    // missingRefs 在导出摘要里按 refs 数量占位（详细校验在预演 warnings）
    if (line.refs.length) missingRefs += 0;
  }
  return { lineCount: lines.length, hot, cold, done, pinned, missingRefs };
}

function readScopeMemoryRaw(scopeDir: string, remaining: number) {
  const read = readScopeFileBytes(scopeDir, ".jiebo/memory.md", remaining);
  if (!read.ok) {
    if (read.code === "enoent") return { raw: "", bytes: 0 };
    throw new Error(read.message);
  }
  const decoded = bufferToMemoryRawUtf8(read.buf);
  if (!decoded.ok) throw new Error(decoded.message);
  return { raw: decoded.text, bytes: read.bytes };
}

function ruleInventoryForScope(scopeDir: string, scopeId: string, budget: number) {
  const out: MemoryCenterSnapshotV1["rulesInventory"] = [];
  let spent = 0;
  const take = (rel: string) => {
    const read = readScopeFileBytes(scopeDir, rel, budget - spent);
    if (!read.ok) return;
    spent += read.bytes;
    out.push({
      scope: scopeId,
      path: rel.replace(/\\/g, "/"),
      chars: read.bytes,
      checksum: read.sha256,
    });
  };
  take(".cursorrules");
  take("AGENTS.md");
  const rulesDir = resolve(scopeDir, ".cursor/rules");
  if (scopedRead.isSymlinkPath(rulesDir)) return out;
  try {
    for (const name of readdirSync(rulesDir).sort()) {
      if (!/\.(md|mdc)$/i.test(name)) continue;
      take(`.cursor/rules/${name}`);
    }
  } catch {
    // ignore
  }
  return out;
}

let exportNowIso: () => string = () => new Date().toISOString();

export function setMemoryCenterExportNowForTest(fn: (() => string) | null) {
  exportNowIso = fn ?? (() => new Date().toISOString());
}

function coreFieldsForExport(fields: Record<string, string>) {
  const out = { ...fields };
  delete out[WORK_PREF_FIELD];
  return out;
}

export function finalizeSnapshotChecksums(
  snapshot: Omit<MemoryCenterSnapshotV1, "manifest"> & { manifest?: MemoryCenterSnapshotV1["manifest"] },
): MemoryCenterSnapshotV1 {
  const wpText = snapshot.workPreferences.text;
  snapshot.workPreferences.checksum = sha256Hex(wpText);
  for (const ws of snapshot.workspaces) {
    ws.memoryChecksum = sha256Hex(ws.memoryRaw);
  }
  const includedScopes =
    snapshot.manifest?.includedScopes ??
    ({
      personal: true,
      workPreference: true,
      personalSettings: true,
      workspaceIds: snapshot.workspaces.map((w) => w.scopeId).sort(),
    } satisfies MemoryCenterSnapshotV1["manifest"]["includedScopes"]);
  const body = { ...snapshot, manifest: { checksum: "" as const, includedScopes } } as Omit<MemoryCenterSnapshotV1, "manifest"> & {
    manifest: { checksum: ""; includedScopes: MemoryCenterSnapshotV1["manifest"]["includedScopes"] };
  };
  const checksum = createHash("sha256").update(snapshotPayloadForChecksum(body)).digest("hex");
  return { ...(snapshot as MemoryCenterSnapshotV1), manifest: { checksum, includedScopes } };
}

export function buildMemoryCenterSnapshotV1(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  scopeFilter?: string[],
): MemoryCenterSnapshotV1 {
  const discovered = discoverScopesForTest(tenant, workspaceNames);
  const resolved = resolveExportScopes(tenant, workspaceNames, scopeFilter);
  if (!resolved.ok) throw new Error(resolved.error);
  const scopes = resolved.scopes;
  let totalBytes = 0;
  const core = readCore(discovered.ref);
  const settings = readSettings(discovered.ref);
  const allowSensitive: Record<string, boolean> = {};
  for (const [key, val] of Object.entries(settings.allowSensitive)) {
    if (typeof val === "boolean") allowSensitive[key] = val;
  }
  const wpText = core.fields[WORK_PREF_FIELD] ?? "";
  const workspaces: MemoryCenterSnapshotV1["workspaces"] = [];
  const rulesInventory: MemoryCenterSnapshotV1["rulesInventory"] = [];
  for (const scopeId of scopes) {
    if (scopeId === "personal" || scopeId === "work_preference" || scopeId === "personal_settings") continue;
    const record = discovered.scopes.get(scopeId);
    if (!record?.absDir) continue;
    const remaining = MEMORY_CENTER_SNAPSHOT_MAX_BYTES - totalBytes;
    const { raw, bytes } = readScopeMemoryRaw(record.absDir, remaining);
    totalBytes += bytes;
    if (totalBytes > MEMORY_CENTER_SNAPSHOT_MAX_BYTES) throw new Error("导出超过 20MB 总预算。");
    if (detectSnapshotSecret(raw)) throw new Error("工作区 memory 含疑似敏感内容。");
    workspaces.push({
      scopeId,
      memoryRaw: raw,
      memoryChecksum: sha256Hex(raw),
      summary: summarizeWorkspaceMemory(raw.length ? raw : "## 约定\n"),
    });
    let rulesRem = MEMORY_CENTER_SNAPSHOT_MAX_BYTES - totalBytes;
    const rules = ruleInventoryForScope(record.absDir, scopeId, rulesRem);
    for (const r of rules) totalBytes += r.chars;
    rulesInventory.push(...rules);
  }
  workspaces.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  rulesInventory.sort((a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
  const entries = listMemory(discovered.ref).entries.map(sanitizeEntry).sort((a, b) => a.id.localeCompare(b.id));
  const exportedAt = exportNowIso();
  const includePersonal = exportIncludesPersonal(scopes);
  const includeSettings = exportIncludesPersonalSettings(scopes);
  const includeWp = exportIncludesWorkPreference(scopes);
  const workspaceIds = workspaces.map((w) => w.scopeId).sort();
  const includedScopes = {
    personal: includePersonal,
    workPreference: includeWp,
    personalSettings: includeSettings,
    workspaceIds,
  };
  const body: Omit<MemoryCenterSnapshotV1, "manifest"> & { manifest: { checksum: ""; includedScopes: typeof includedScopes } } = {
    schemaVersion: 1,
    exportedAt,
    manifest: { checksum: "", includedScopes },
    personal: {
      core: {
        rev: includePersonal ? core.rev : 0,
        fields: includePersonal ? coreFieldsForExport(core.fields) : coreFieldsForExport(emptyCore().fields),
        updatedAt: includePersonal ? core.updatedAt : undefined,
      },
      settings: includeSettings ? { paused: settings.paused, allowSensitive } : { paused: false, allowSensitive: {} },
      entries: includePersonal ? entries : [],
    },
    workPreferences: {
      text: includeWp ? wpText : "",
      checksum: sha256Hex(includeWp ? wpText : ""),
    },
    workspaces,
    rulesInventory,
  };
  const checksum = createHash("sha256").update(snapshotPayloadForChecksum(body)).digest("hex");
  return { ...body, manifest: { checksum, includedScopes } };
}

export function memoryCenterExport(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  scopeFilter?: string[],
): { ok: true; data: MemoryCenterExportData } | { ok: false; error: string; code?: string } {
  if (!scopedRead.scopedReadSupported()) {
    return { ok: false, error: "当前平台不支持安全导出。", code: "unsupported" };
  }
  const scopeResolved = resolveExportScopes(tenant, workspaceNames, scopeFilter);
  if (!scopeResolved.ok) {
    return { ok: false, error: scopeResolved.error, code: scopeResolved.code };
  }
  let snapshot: MemoryCenterSnapshotV1;
  try {
    snapshot = buildMemoryCenterSnapshotV1(tenant, workspaceNames, scopeFilter);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "构建快照失败。";
    const code = msg.includes("20MB") ? "size_limit" : msg.includes("敏感") ? "security" : "build_failed";
    return { ok: false, error: msg, code };
  }
  const validated = validateMemoryCenterSnapshotV1(snapshot);
  if (!validated.ok) return { ok: false, error: validated.errors.join(" "), code: "malformed_snapshot" };
  const canonical = stableSnapshotStringify(snapshot);
  if (detectSnapshotSecret(canonical)) {
    return { ok: false, error: "快照含疑似敏感内容。", code: "security" };
  }
  const onDisk = JSON.parse(canonical) as MemoryCenterSnapshotV1;
  const json = `${JSON.stringify(onDisk, null, 1)}\n`;
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MEMORY_CENTER_SNAPSHOT_MAX_BYTES) {
    return { ok: false, error: "导出超过 20MB 上限。", code: "size_limit" };
  }
  const sha256 = createHash("sha256").update(json, "utf8").digest("hex");
  const stamp = snapshot.exportedAt.replace(/[:.]/g, "-");
  const hashShort = sha256.slice(0, 8);
  const relativePath = `.jiebo/memory-export/memory-center-${stamp}-${hashShort}.json`;
  const prepared = prepareSecureMemoryExportDir(tenant.workspaceRoot);
  if (!prepared.ok) return { ok: false, error: prepared.message, code: prepared.code };
  const exportDirSnap = snapshotExportDirStat(prepared.exportDir);
  const outAbs = resolve(prepared.rootReal, relativePath);
  const preParent = verifyExportWriteParent(outAbs, prepared.rootReal, exportDirSnap);
  if (preParent) return { ok: false, error: preParent.message, code: preParent.code };
  authorityDurableWrite(outAbs, json);
  const postParent = verifyExportWriteParent(outAbs, prepared.rootReal, exportDirSnap);
  if (postParent) return { ok: false, error: postParent.message, code: postParent.code };
  const scopes = scopeResolved.scopes;
  return {
    ok: true,
    data: {
      relativePath,
      sha256,
      bytes,
      summary: {
        scopes,
        personalEntries: snapshot.personal.entries.length,
        workspaceScopes: snapshot.workspaces.length,
        rulesInventory: snapshot.rulesInventory.length,
      },
    },
  };
}
