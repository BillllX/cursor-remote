import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  MemoryCenterImportChange,
  MemoryCenterImportPreviewData,
  MemoryCenterImportResolution,
  MemoryCenterImportWarning,
  StoredImportPlan,
} from "../../../shared/memoryCenterImportTypes.ts";
import { validateMemoryCenterSnapshotV1, type MemoryCenterSnapshotV1 } from "../../../shared/memoryCenterSnapshot.ts";
import { validatePlanChangeIds } from "./memoryCenterImportResolutions.ts";
import { CORE_FIELDS, listMemory, readCore, readSettings, WORK_PREF_FIELD } from "./memory.ts";
import { discoverScopesForTest } from "./memoryCenter.ts";
import { listWorkspaceScopeIds } from "./memoryCenterScope.ts";
import { readSnapshotJsonFromUserRoot } from "./memoryCenterImportPath.ts";
import { sha256FileContent } from "./memoryCenterImportJournal.ts";
import {
  isPlanExpired,
  loadImportPlan,
  newPlanId,
  planExpiresAt,
  saveImportPlan,
} from "./memoryCenterImportPlanStore.ts";
import { assistantPath, hashText, type TenantRef } from "./store.ts";
import { parseMemoryFile, type WorkspaceRoot } from "./workspaceMemory.ts";
import { memoryLineRevision } from "./memoryRevision.ts";

function previewText(text: string, max = 120) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function entryResolutions(allowDuplicate: boolean): MemoryCenterImportResolution[] {
  return allowDuplicate ? ["keep_current", "use_snapshot", "duplicate"] : ["keep_current", "use_snapshot"];
}

function coreFieldsNoW0(fields: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const key of CORE_FIELDS) {
    if (key === WORK_PREF_FIELD) continue;
    out[key] = fields[key] ?? "";
  }
  return out;
}

function buildPersonalSettingsChange(ref: TenantRef, incoming: MemoryCenterSnapshotV1): MemoryCenterImportChange {
  const cur = readSettings(ref);
  const inc = incoming.personal.settings;
  const curChecksum = hashText(JSON.stringify(cur));
  const incChecksum = hashText(JSON.stringify(inc));
  if (curChecksum === incChecksum) {
    return {
      changeId: "personal:settings",
      layer: "personal_settings",
      action: "unchanged",
      scope: "personal",
      allowedResolutions: entryResolutions(false),
      current: { textPreview: "当前设置", checksum: curChecksum },
      incoming: { textPreview: "快照设置", checksum: incChecksum },
    };
  }
  return {
    changeId: "personal:settings",
    layer: "personal_settings",
    action: "conflict",
    scope: "personal",
    reason: "个人记忆设置不同。",
    allowedResolutions: entryResolutions(false),
    current: { textPreview: previewText(JSON.stringify(cur)), checksum: curChecksum },
    incoming: { textPreview: previewText(JSON.stringify(inc)), checksum: incChecksum },
  };
}

function buildPersonalCoreChange(currentRev: number, currentFields: Record<string, string>, incoming: MemoryCenterSnapshotV1): MemoryCenterImportChange | null {
  const inc = incoming.personal.core;
  const curCore = coreFieldsNoW0(currentFields);
  const incCore = coreFieldsNoW0(inc.fields);
  const curChecksum = hashText(JSON.stringify({ rev: currentRev, fields: curCore }));
  const incChecksum = hashText(JSON.stringify({ rev: inc.rev, fields: incCore }));
  if (curChecksum === incChecksum) {
    return {
      changeId: "personal:core",
      layer: "personal_core",
      action: "unchanged",
      scope: "personal",
      allowedResolutions: entryResolutions(false),
      current: { textPreview: "当前核心档案", revision: String(currentRev), checksum: curChecksum },
      incoming: { textPreview: "快照核心档案", revision: String(inc.rev), checksum: incChecksum },
    };
  }
  return {
    changeId: "personal:core",
    layer: "personal_core",
    action: "conflict",
    scope: "personal",
    reason: "核心档案内容不同。",
    allowedResolutions: entryResolutions(false),
    current: { textPreview: previewText(CORE_FIELDS.filter((k) => k !== WORK_PREF_FIELD).map((k) => currentFields[k]).join("\n")), revision: String(currentRev), checksum: curChecksum },
    incoming: { textPreview: previewText(CORE_FIELDS.filter((k) => k !== WORK_PREF_FIELD).map((k) => inc.fields[k]).join("\n")), revision: String(inc.rev), checksum: incChecksum },
  };
}

function buildWorkPrefChange(currentText: string, incoming: MemoryCenterSnapshotV1): MemoryCenterImportChange {
  const incText = incoming.workPreferences.text;
  if (currentText === incText) {
    return {
      changeId: "work_preference:all",
      layer: "work_preference",
      action: "unchanged",
      scope: "work_preference",
      allowedResolutions: entryResolutions(false),
      current: { textPreview: previewText(currentText), checksum: hashText(currentText) },
      incoming: { textPreview: previewText(incText), checksum: incoming.workPreferences.checksum },
    };
  }
  return {
    changeId: "work_preference:all",
    layer: "work_preference",
    action: "conflict",
    scope: "work_preference",
    reason: "工作偏好文本不同。",
    allowedResolutions: entryResolutions(false),
    current: { textPreview: previewText(currentText), checksum: hashText(currentText) },
    incoming: { textPreview: previewText(incText), checksum: incoming.workPreferences.checksum },
  };
}

function buildPersonalEntryChanges(ref: TenantRef, incoming: MemoryCenterSnapshotV1): MemoryCenterImportChange[] {
  const current = new Map(listMemory(ref).entries.map((e) => [e.id, e]));
  const changes: MemoryCenterImportChange[] = [];
  const seen = new Set<string>();
  for (const inc of incoming.personal.entries) {
    seen.add(inc.id);
    const cur = current.get(inc.id);
    if (!cur) {
      changes.push({
        changeId: `personal:entry:${inc.id}`,
        layer: "personal_entries",
        action: "add",
        scope: "personal",
        id: inc.id,
        allowedResolutions: ["use_snapshot"],
        incoming: { id: inc.id, textPreview: previewText(inc.text), revision: String(inc.rev) },
      });
      continue;
    }
    const same = cur.rev === inc.rev && cur.text === inc.text && cur.topic === inc.topic;
    changes.push({
      changeId: `personal:entry:${inc.id}`,
      layer: "personal_entries",
      action: same ? "unchanged" : "conflict",
      scope: "personal",
      id: inc.id,
      reason: same ? undefined : "条目内容或版本不同。",
      allowedResolutions: entryResolutions(true),
      current: { id: cur.id, textPreview: previewText(cur.text), revision: String(cur.rev) },
      incoming: { id: inc.id, textPreview: previewText(inc.text), revision: String(inc.rev) },
    });
  }
  for (const [id, cur] of current) {
    if (seen.has(id)) continue;
    changes.push({
      changeId: `personal:entry:${id}`,
      layer: "personal_entries",
      action: "skip",
      scope: "personal",
      id,
      reason: "快照中无此条目，导入不会删除。",
      allowedResolutions: ["keep_current"],
      current: { id, textPreview: previewText(cur.text), revision: String(cur.rev) },
    });
  }
  return changes.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
}

function buildWorkspaceChanges(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  incoming: MemoryCenterSnapshotV1,
  warnings: MemoryCenterImportWarning[],
): MemoryCenterImportChange[] {
  const known = new Set(listWorkspaceScopeIds(tenant, workspaceNames));
  const changes: MemoryCenterImportChange[] = [];
  for (const ws of incoming.workspaces) {
    if (!known.has(ws.scopeId)) {
      warnings.push({ code: "unknown_scope", message: `未知工作区 scope：${ws.scopeId}，不会自动创建。`, scope: ws.scopeId });
      continue;
    }
    const discovered = discoverScopesForTest(tenant, workspaceNames);
    const record = discovered.scopes.get(ws.scopeId);
    if (!record?.absDir) continue;
    let currentRaw = "";
    try {
      currentRaw = existsSync(record.absDir + "/.jiebo/memory.md") ? readFileSync(record.absDir + "/.jiebo/memory.md", "utf8") : "";
    } catch {
      currentRaw = "";
    }
    const curSha = createHash("sha256").update(currentRaw, "utf8").digest("hex");
    if (curSha !== ws.memoryChecksum) {
      changes.push({
        changeId: `ws:${ws.scopeId}:structure`,
        layer: "workspace_structure",
        action: "conflict",
        scope: ws.scopeId,
        reason: "工作区 memory.md 整体结构或注释与快照不同。",
        allowedResolutions: entryResolutions(false),
        current: { textPreview: previewText(currentRaw), checksum: curSha },
        incoming: { textPreview: previewText(ws.memoryRaw), checksum: ws.memoryChecksum },
      });
    } else {
      changes.push({
        changeId: `ws:${ws.scopeId}:structure`,
        layer: "workspace_structure",
        action: "unchanged",
        scope: ws.scopeId,
        allowedResolutions: entryResolutions(false),
        current: { textPreview: "结构一致", checksum: curSha },
        incoming: { textPreview: "结构一致", checksum: ws.memoryChecksum },
      });
    }
    const curLines = parseMemoryFile(currentRaw.length ? currentRaw : "## 约定\n");
    const incLines = parseMemoryFile(ws.memoryRaw.length ? ws.memoryRaw : "## 约定\n");
    const curById = new Map(curLines.filter((l) => l.id).map((l) => [l.id!, l]));
    const incById = new Map(incLines.filter((l) => l.id).map((l) => [l.id!, l]));
    for (const line of incLines) {
      if (!line.id) continue;
      const cur = curById.get(line.id);
      const rev = memoryLineRevision(line);
      if (!cur) {
        changes.push({
          changeId: `ws:${ws.scopeId}:${line.id}`,
          layer: "workspace_entries",
          action: "add",
          scope: ws.scopeId,
          id: line.id,
          allowedResolutions: ["use_snapshot"],
          incoming: { id: line.id, section: line.section, textPreview: previewText(line.text), revision: rev },
        });
        continue;
      }
      const curRev = memoryLineRevision(cur);
      const same = curRev === rev && cur.text === line.text;
      changes.push({
        changeId: `ws:${ws.scopeId}:${line.id}`,
        layer: "workspace_entries",
        action: same ? "unchanged" : "conflict",
        scope: ws.scopeId,
        id: line.id,
        reason: same ? undefined : "工作区记忆行不同。",
        allowedResolutions: entryResolutions(true),
        current: { id: line.id, section: cur.section, textPreview: previewText(cur.text), revision: curRev },
        incoming: { id: line.id, section: line.section, textPreview: previewText(line.text), revision: rev },
      });
      if (line.refs.length) {
        warnings.push({ code: "missing_refs", message: `scope ${ws.scopeId} 条目 ${line.id} 含引用，导入后可能待核实。`, scope: ws.scopeId });
      }
    }
    for (const [id] of curById) {
      if (incById.has(id)) continue;
      changes.push({
        changeId: `ws:${ws.scopeId}:${id}`,
        layer: "workspace_entries",
        action: "skip",
        scope: ws.scopeId,
        id,
        reason: "快照中无此行，导入不会删除。",
        allowedResolutions: ["keep_current"],
      });
    }
  }
  return changes.sort((a, b) => `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`));
}

function rulesWarnings(incoming: MemoryCenterSnapshotV1, warnings: MemoryCenterImportWarning[]) {
  if (incoming.rulesInventory.length) {
    warnings.push({
      code: "rules_changed",
      message: `快照含 ${incoming.rulesInventory.length} 条规则清单；规则只读，导入不会写入规则文件。`,
    });
  }
}

function collectCasHashes(
  ref: TenantRef,
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  included: MemoryCenterSnapshotV1["manifest"]["includedScopes"],
): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (included.personal) {
    hashes["personal:core"] = sha256FileContent(assistantPath(ref, "memory", "core.json"));
    hashes["personal:entries"] = sha256FileContent(assistantPath(ref, "memory", "entries.json"));
  }
  if (included.personalSettings) {
    hashes["personal:settings"] = sha256FileContent(assistantPath(ref, "memory", "settings.json"));
  }
  const wsSet = new Set(included.workspaceIds);
  for (const scopeId of listWorkspaceScopeIds(tenant, workspaceNames)) {
    if (!wsSet.has(scopeId)) continue;
    const discovered = discoverScopesForTest(tenant, workspaceNames);
    const record = discovered.scopes.get(scopeId);
    if (!record?.absDir) continue;
    hashes[`ws:${scopeId}:memory`] = sha256FileContent(record.absDir + "/.jiebo/memory.md");
  }
  return hashes;
}

export function buildImportPreviewFromSnapshot(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  snapshot: MemoryCenterSnapshotV1,
  snapshotBytes: Buffer,
): MemoryCenterImportPreviewData {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const warnings: MemoryCenterImportWarning[] = [];
  rulesWarnings(snapshot, warnings);
  const core = readCore(ref);
  const inc = snapshot.manifest.includedScopes;
  const changes: MemoryCenterImportChange[] = [];
  if (inc.personal) {
    const cc = buildPersonalCoreChange(core.rev, core.fields, snapshot);
    if (cc) changes.push(cc);
    changes.push(...buildPersonalEntryChanges(ref, snapshot));
  }
  if (inc.personalSettings) {
    changes.push(buildPersonalSettingsChange(ref, snapshot));
  }
  if (inc.workPreference) {
    changes.push(buildWorkPrefChange(core.fields[WORK_PREF_FIELD] ?? "", snapshot));
  }
  const wsFiltered: MemoryCenterSnapshotV1 = {
    ...snapshot,
    workspaces: snapshot.workspaces.filter((w) => inc.workspaceIds.includes(w.scopeId)),
  };
  changes.push(...buildWorkspaceChanges(tenant, workspaceNames, wsFiltered, warnings));
  const planId = newPlanId();
  const expiresAt = planExpiresAt();
  const snapshotSummary = {
    exportedAt: snapshot.exportedAt,
    schemaVersion: snapshot.schemaVersion,
    scopeCount: snapshot.workspaces.length,
    personalEntryCount: snapshot.personal.entries.length,
    rulesCount: snapshot.rulesInventory.length,
    bytes: snapshotBytes.length,
    checksum: snapshot.manifest.checksum,
  };
  const plan: StoredImportPlan = {
    planId,
    createdAt: new Date().toISOString(),
    expiresAt,
    snapshotBytes: snapshotBytes.toString("utf8"),
    snapshotSha256: createHash("sha256").update(snapshotBytes).digest("hex"),
    casHashes: collectCasHashes(ref, tenant, workspaceNames, inc),
    changes,
    warnings,
    snapshotSummary,
  };
  if (!validatePlanChangeIds(changes)) {
    throw new Error("预演 changeId 重复。");
  }
  saveImportPlan(ref, plan);
  return { planId, expiresAt, snapshotSummary, changes, warnings };
}

export function memoryCenterImportPreview(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  pathInput: string,
): { ok: true; data: MemoryCenterImportPreviewData } | { ok: false; error: string; code: string } {
  const read = readSnapshotJsonFromUserRoot(tenant.workspaceRoot, pathInput);
  if (!read.ok) return { ok: false, error: read.message, code: read.code };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return { ok: false, error: "JSON 解析失败。", code: "malformed_snapshot" };
  }
  const validated = validateMemoryCenterSnapshotV1(parsed, { maxBytes: read.bytes.length });
  if (!validated.ok) return { ok: false, error: validated.errors.join(" "), code: "malformed_snapshot" };
  const data = buildImportPreviewFromSnapshot(tenant, workspaceNames, validated.snapshot, read.bytes);
  return {
    ok: true,
    data: {
      ...data,
      warnings: [
        ...data.warnings,
        ...validated.warnings.map((message) => ({ code: "snapshot_warning" as const, message })),
      ],
    },
  };
}

export function reloadPlanForApply(ref: TenantRef, planId: string): StoredImportPlan | null {
  const plan = loadImportPlan(ref, planId);
  if (!plan) return null;
  if (isPlanExpired(plan)) return null;
  return plan;
}
