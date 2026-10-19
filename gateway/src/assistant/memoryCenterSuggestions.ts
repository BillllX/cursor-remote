import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  MemoryCenterMutateArgs,
  MemoryCenterSuggestionAnswerData,
  MemoryCenterSuggestionAnswerErrorCode,
  MemoryCenterSuggestionEntry,
  MemoryCenterSuggestionKind,
  MemoryCenterSuggestionsData,
} from "../../../shared/protocol.ts";
import { describeLocal, isoWeekKey, localParts } from "./cron.ts";
import { postInbox } from "./inbox.ts";
import { memoryCenterGet } from "./memoryCenter.ts";
import { memoryCenterMutate } from "./memoryCenterMutate.ts";
import { listWorkspaceScopeIds, resolveWorkspaceScope } from "./memoryCenterScope.ts";
import { stableSuggestionId } from "./memoryCenterAudit.ts";
import { memoryLineRevision } from "./memoryRevision.ts";
import { assistantPath, readJson, writeJson, type TenantRef } from "./store.ts";
import {
  effectiveMemoryState,
  normalizeMemoryText,
  planMemoryInjection,
  parseMemoryFile,
  safeMemoryPaths,
  type MemoryLine,
  type WorkspaceRoot,
} from "./workspaceMemory.ts";

export const SUGGESTION_TZ = "Asia/Shanghai";
const STATE_FILE = "memory-center-suggestions.json";
const MAX_ACTIVE_SUGGESTIONS = 200;
const STALE_HOT_DAYS = 90;
const STALE_ONGOING_DAYS = 60;
const BUDGET_PRESSURE_RATIO = 0.8;
const DECISION_TTL_DAYS = 90;
const MAX_DECISIONS = 1000;

export type SuggestionDecisionStatus = "accepted" | "dismissed" | "handled";

export type SuggestionDecision = {
  id: string;
  scope: string;
  kind: MemoryCenterSuggestionKind;
  status: SuggestionDecisionStatus;
  decidedAt: string;
  revisions?: string[];
};

export type SuggestionStateFile = {
  generatedAt: string;
  lastRunAt?: string;
  lastLocalDay?: string;
  lastInboxWeek?: string;
  tz?: string;
  active: MemoryCenterSuggestionEntry[];
  decisions: SuggestionDecision[];
  /** @deprecated 迁移用 */
  suggestions?: Array<MemoryCenterSuggestionEntry & { status?: string; decidedAt?: string }>;
};

function statePath(ref: TenantRef) {
  return assistantPath(ref, STATE_FILE);
}

function pruneDecisions(decisions: SuggestionDecision[], day: string) {
  const cutoff = new Date(Date.parse(`${day}T12:00:00Z`) - DECISION_TTL_DAYS * 86_400_000).toISOString();
  const kept = decisions.filter((row) => row.decidedAt >= cutoff);
  return kept.slice(-MAX_DECISIONS);
}

function readState(ref: TenantRef): SuggestionStateFile {
  const raw = readJson<SuggestionStateFile>(statePath(ref), { generatedAt: "", active: [], decisions: [] });
  if (raw.suggestions?.length && !raw.active.length) {
    const active: MemoryCenterSuggestionEntry[] = [];
    const decisions: SuggestionDecision[] = [...(raw.decisions ?? [])];
    for (const row of raw.suggestions) {
      const status = row.status;
      if (status === "accepted" || status === "dismissed") {
        decisions.push({
          id: row.id,
          scope: row.scope,
          kind: row.kind,
          status: status === "accepted" ? "accepted" : "dismissed",
          decidedAt: row.decidedAt ?? new Date().toISOString(),
          revisions: row.revisions,
        });
      } else if (status === "active" || !status) {
        active.push(row);
      }
    }
    return { ...raw, active, decisions, suggestions: undefined };
  }
  return { ...raw, active: raw.active ?? [], decisions: raw.decisions ?? [] };
}

function writeState(ref: TenantRef, state: SuggestionStateFile) {
  writeJson(statePath(ref), state);
}

function daysBefore(day: string, days: number) {
  const t = Date.parse(`${day}T12:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function lastActivityDay(line: MemoryLine) {
  return line.used || line.at || "";
}

function decisionBlocks(decisions: SuggestionDecision[], id: string) {
  return decisions.some((row) => row.id === id);
}

function scanScope(scopeId: string, scopeDir: string, allowedRoot: string, tokenBudget: number): MemoryCenterSuggestionEntry[] {
  const paths = safeMemoryPaths(scopeDir, allowedRoot);
  let text = "";
  try {
    text = readFileSync(paths.memory, "utf8");
  } catch {
    return [];
  }
  const lines = parseMemoryFile(text);
  const out: MemoryCenterSuggestionEntry[] = [];
  const day = new Date().toISOString().slice(0, 10);

  for (const line of lines) {
    if (!line.id) continue;
    const missing = line.refs.filter((ref) => !existsSync(resolve(scopeDir, ref)));
    if (missing.length) {
      const rev = memoryLineRevision(line);
      out.push({
        id: stableSuggestionId({ scope: scopeId, kind: "missing_ref", id: line.id, rev }),
        scope: scopeId,
        kind: "missing_ref",
        summary: `条目引用缺失：${missing.join("、")}`,
        reason: "引用的文件不在工作区，请核实或更新引用。",
        risk: "low",
        itemIds: [line.id],
        revisions: [rev],
        proposedAction: { kind: "mark_handled" },
      });
    }
  }

  for (const line of lines) {
    if (!line.id || line.pinned) continue;
    const eff = effectiveMemoryState(line);
    if (eff === "done" || eff === "expired") continue;
    const last = lastActivityDay(line);
    if (last && last < daysBefore(day, STALE_HOT_DAYS) && (line.state === "hot" || eff === "hot")) {
      const rev = memoryLineRevision(line);
      out.push({
        id: stableSuggestionId({ scope: scopeId, kind: "stale_hot", id: line.id, rev }),
        scope: scopeId,
        kind: "stale_hot",
        summary: `长期未使用的 hot 条目：${line.text.slice(0, 48)}`,
        reason: `至少 ${STALE_HOT_DAYS} 天无活动，建议标为 cold。`,
        risk: "low",
        itemIds: [line.id],
        revisions: [rev],
        proposedAction: { kind: "set_state", state: "cold", targetId: line.id },
      });
    }
  }

  for (const line of lines) {
    if (!line.id || line.section !== "进行中") continue;
    const last = lastActivityDay(line);
    if (last && last < daysBefore(day, STALE_ONGOING_DAYS)) {
      const rev = memoryLineRevision(line);
      out.push({
        id: stableSuggestionId({ scope: scopeId, kind: "stale_ongoing", id: line.id, rev }),
        scope: scopeId,
        kind: "stale_ongoing",
        summary: `进行中超 60 天：${line.text.slice(0, 48)}`,
        reason: "建议标为 done（接受前仍会 CAS 校验）。",
        risk: "medium",
        itemIds: [line.id],
        revisions: [rev],
        proposedAction: { kind: "mark_done", targetId: line.id },
      });
    }
  }

  const byNorm = new Map<string, MemoryLine[]>();
  for (const line of lines) {
    if (!line.id) continue;
    const key = normalizeMemoryText(line.text);
    if (!key) continue;
    const list = byNorm.get(key) ?? [];
    list.push(line);
    byNorm.set(key, list);
  }
  for (const group of byNorm.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const ua = a.uses ?? 0;
      const ub = b.uses ?? 0;
      if (ub !== ua) return ub - ua;
      return (b.used || b.at || "").localeCompare(a.used || a.at || "");
    });
    const keep = sorted[0];
    for (const drop of sorted.slice(1)) {
      if (!drop.id || !keep.id) continue;
      out.push({
        id: stableSuggestionId({
          scope: scopeId,
          kind: "duplicate",
          keep: keep.id,
          drop: drop.id,
          revKeep: memoryLineRevision(keep),
          revDrop: memoryLineRevision(drop),
        }),
        scope: scopeId,
        kind: "duplicate",
        summary: `重复正文：保留较新/较多使用的一条`,
        reason: `与 ${keep.id} 正文相同，建议将 ${drop.id} 标为 done。`,
        risk: "medium",
        itemIds: [keep.id, drop.id],
        revisions: [memoryLineRevision(keep), memoryLineRevision(drop)],
        proposedAction: { kind: "mark_done", targetId: drop.id, keepId: keep.id },
      });
    }
  }

  const plan = planMemoryInjection(scopeDir, tokenBudget, "", allowedRoot);
  if (plan?.diagnostics) {
    const budget = tokenBudget;
    const used = plan.selected.reduce((sum, row) => sum + row.cost, 0);
    if (budget > 0 && used / budget >= BUDGET_PRESSURE_RATIO) {
      const coldCandidates = lines
        .filter((line) => line.id && !line.pinned && effectiveMemoryState(line) === "hot")
        .sort((a, b) => (a.uses ?? 0) - (b.uses ?? 0));
      const seen = new Set<string>();
      for (const line of coldCandidates) {
        if (!line.id || seen.has(line.id)) continue;
        seen.add(line.id);
        const rev = memoryLineRevision(line);
        const sid = stableSuggestionId({ scope: scopeId, kind: "budget_pressure", id: line.id, rev });
        if (out.some((row) => row.id === sid)) continue;
        out.push({
          id: sid,
          scope: scopeId,
          kind: "budget_pressure",
          summary: `注入预算紧张，低使用 hot 可转 cold`,
          reason: `已选 token 约 ${Math.round((used / budget) * 100)}%，建议低使用非 pinned 条目转 cold。`,
          risk: "low",
          itemIds: [line.id],
          revisions: [rev],
          proposedAction: { kind: "set_state", state: "cold", targetId: line.id },
        });
        if (seen.size >= 5) break;
      }
    }
  }

  return out;
}

export function runMemoryCenterSuggestionScan(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  ref: TenantRef,
  prev = readState(ref),
): SuggestionStateFile {
  const generatedAt = new Date().toISOString();
  const day = describeLocal(Date.now(), prev.tz ?? SUGGESTION_TZ).slice(0, 10);
  const decisions = pruneDecisions(prev.decisions, day);
  const scanned: MemoryCenterSuggestionEntry[] = [];
  for (const scopeId of listWorkspaceScopeIds(tenant, workspaceNames)) {
    const resolved = resolveWorkspaceScope(tenant, workspaceNames, scopeId);
    if (!resolved.ok) continue;
    if (resolved.record.layer === "L0" || resolved.record.layer === "L1") continue;
    const layerBudget = resolved.record.tokenBudget;
    if (layerBudget <= 0) continue;
    scanned.push(...scanScope(scopeId, resolved.absDir, resolved.root, layerBudget));
  }
  const active: MemoryCenterSuggestionEntry[] = [];
  for (const row of scanned) {
    if (decisionBlocks(decisions, row.id)) continue;
    active.push(row);
    if (active.length >= MAX_ACTIVE_SUGGESTIONS) break;
  }
  const next: SuggestionStateFile = {
    ...prev,
    generatedAt,
    lastRunAt: generatedAt,
    tz: prev.tz ?? SUGGESTION_TZ,
    active,
    decisions,
  };
  writeState(ref, next);
  return next;
}

export function maybeRunDailySuggestionScan(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  ref: TenantRef,
  now = Date.now(),
  tz = SUGGESTION_TZ,
) {
  const local = localParts(now, tz);
  const day = describeLocal(now, tz).slice(0, 10);
  const prev = readState(ref);
  if (local.hour < 4 || prev.lastLocalDay === day) return { ran: false as const };
  let next: SuggestionStateFile;
  try {
    next = runMemoryCenterSuggestionScan(tenant, workspaceNames, ref, { ...prev, tz });
  } catch {
    writeState(ref, { ...prev, lastLocalDay: day, tz });
    return { ran: true as const, count: 0, scanError: true as const };
  }
  const weekKey = isoWeekKey(now, tz);
  const withDay: SuggestionStateFile = { ...next, lastLocalDay: day, tz };
  writeState(ref, withDay);
  if (withDay.active.length && prev.lastInboxWeek !== weekKey) {
    postInbox(ref, {
      kind: "reminder",
      title: "工作区记忆整理建议",
      body: `共 ${withDay.active.length} 条建议（低/中风险需你确认）。打开记忆中心查看。`,
      key: `mc-suggestions:${weekKey}`,
    });
    writeState(ref, { ...withDay, lastInboxWeek: weekKey });
  }
  return { ran: true as const, count: withDay.active.length };
}

export function memoryCenterSuggestionsGet(
  ref: TenantRef,
  scopeFilter?: string,
): MemoryCenterSuggestionsData {
  const state = readState(ref);
  let entries = state.active;
  if (scopeFilter?.trim()) entries = entries.filter((row) => row.scope === scopeFilter.trim());
  return {
    generatedAt: state.generatedAt || new Date(0).toISOString(),
    lastRunAt: state.lastRunAt,
    entries: entries.slice(0, MAX_ACTIVE_SUGGESTIONS),
    truncated: entries.length > MAX_ACTIVE_SUGGESTIONS,
  };
}

function findSuggestion(ref: TenantRef, scope: string, id: string) {
  const state = readState(ref);
  const hit = state.active.find((row) => row.id === id && row.scope === scope);
  return { state, hit };
}

function recordDecision(state: SuggestionStateFile, hit: MemoryCenterSuggestionEntry, status: SuggestionDecisionStatus) {
  const day = describeLocal(Date.now(), state.tz ?? SUGGESTION_TZ).slice(0, 10);
  const decisions = pruneDecisions(
    [
      ...state.decisions.filter((row) => row.id !== hit.id),
      {
        id: hit.id,
        scope: hit.scope,
        kind: hit.kind,
        status,
        decidedAt: new Date().toISOString(),
        revisions: hit.revisions,
      },
    ],
    day,
  );
  const active = state.active.filter((row) => row.id !== hit.id);
  return { ...state, active, decisions };
}

function currentRevision(tenant: WorkspaceRoot, workspaceNames: string[], scope: string, itemId: string) {
  const got = memoryCenterGet(tenant, workspaceNames, scope);
  if (got.mode !== "detail") return null;
  const item = got.detail.items.find((row) => row.id === itemId);
  return item?.revision ?? null;
}

export function memoryCenterSuggestionAnswer(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  ref: TenantRef,
  input: { scope: string; id: string; accept: boolean },
):
  | { ok: true; data: MemoryCenterSuggestionAnswerData }
  | { ok: false; code: MemoryCenterSuggestionAnswerErrorCode; message: string; detail?: string } {
  const { state, hit } = findSuggestion(ref, input.scope, input.id);
  if (!hit) return { ok: false, code: "not_found", message: "找不到该建议。" };
  if (state.decisions.some((row) => row.id === hit.id)) {
    return { ok: false, code: "not_found", message: "该建议已处理。" };
  }

  if (!input.accept) {
    writeState(ref, recordDecision(state, hit, "dismissed"));
    return { ok: true, data: { id: hit.id, status: "dismissed" } };
  }

  if (hit.proposedAction.kind === "mark_handled") {
    writeState(ref, recordDecision(state, hit, "handled"));
    return { ok: true, data: { id: hit.id, status: "accepted", detail: "已标记处理（未改 memory）。" } };
  }

  for (let i = 0; i < hit.revisions.length; i += 1) {
    const itemId = hit.itemIds[i];
    const expected = hit.revisions[i];
    const live = currentRevision(tenant, workspaceNames, input.scope, itemId);
    if (live !== expected) {
      writeState(ref, recordDecision(state, hit, "dismissed"));
      return {
        ok: false,
        code: "stale",
        message: "条目已变化，建议已过期。",
        detail: `期望 revision ${expected}，当前 ${live ?? "缺失"}`,
      };
    }
  }

  const action = hit.proposedAction;
  let mutateArgs: MemoryCenterMutateArgs | null = null;
  if (action.kind === "set_state" && action.targetId && action.state) {
    mutateArgs = {
      scope: input.scope,
      mutation: {
        action: "set_state",
        id: action.targetId,
        revision: hit.revisions[hit.itemIds.indexOf(action.targetId)] ?? hit.revisions[0],
        state: action.state,
      },
    };
  } else if (action.kind === "mark_done" && action.targetId) {
    mutateArgs = {
      scope: input.scope,
      mutation: {
        action: "set_state",
        id: action.targetId,
        revision: hit.revisions[hit.itemIds.indexOf(action.targetId)] ?? hit.revisions[0],
        state: "done",
      },
    };
  }
  if (!mutateArgs) return { ok: false, code: "invalid_scope", message: "无法接受此建议。" };

  const result = memoryCenterMutate(tenant, workspaceNames, mutateArgs);
  if (!result.ok) {
    return {
      ok: false,
      code: result.code === "conflict" ? "conflict" : "write_failed",
      message: result.message,
      detail: result.code,
    };
  }

  writeState(ref, recordDecision(state, hit, "accepted"));
  return { ok: true, data: { id: hit.id, status: "accepted" } };
}
