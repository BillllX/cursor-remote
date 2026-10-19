import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type {
  InjectionDiagnostics,
  MemoryCenterGetData,
  MemoryCenterKind,
  MemoryCenterLayer,
  MemoryCenterOverview,
  MemoryCenterScopeDetail,
  MemoryCenterScopeSummary,
  MemoryCenterSearchData,
  MemoryCenterSearchHit,
  MemoryCenterSearchMatchReason,
  MemoryCenterState,
  RuleFile,
  WorkspaceMemoryItem,
} from "../../../shared/protocol.ts";
import { isInside } from "../pathInside.ts";
import {
  CORE_FIELDS,
  CORE_TOKEN_BUDGET,
  detectSecret,
  isValid,
  listMemory,
  readCore,
  readSettings,
  splitTerms,
  WORK_PREF_FIELD,
  WORK_PREF_TOKEN_BUDGET,
} from "./memory.ts";
import { cachedIndex, fingerprint, retrieve } from "./retrieval.ts";
import * as scopedRead from "./scopedRead.ts";

type ScopeFileReader = typeof scopedRead.readFileAtScope;
let scopeFileReader: ScopeFileReader = scopedRead.readFileAtScope;

/** 单测注入 scope 读文件（模拟 EACCES 等），勿在生产调用。 */
export function setScopeFileReaderForTest(reader: ScopeFileReader | null) {
  scopeFileReader = reader ?? scopedRead.readFileAtScope;
}
import { memoryLineRevision, personalMemoryRevision, workPreferenceRevision } from "./memoryRevision.ts";
import { assistantPath, estimateTokens, type TenantRef } from "./store.ts";
import {
  effectiveMemoryState,
  LAYER_TOKEN_BUDGET,
  listProposals,
  MEMORY_FILE,
  parseMemoryFile,
  planMemoryInjection,
  safeMemoryPaths,
  type MemoryLine,
  type WorkspaceRoot,
} from "./workspaceMemory.ts";

export const MAX_SCOPES = 80;
export const MAX_SCOPE_ITEMS = 200;
export const MAX_SEARCH_HITS = 30;
export const MAX_RULE_FILE_CHARS = 8_000;
export const MAX_RULE_PAYLOAD_CHARS = 16_000;
export const MAX_NEST_DEPTH = 3;
export const MAX_NEST_PER_WORKSPACE = 24;
export const MAX_MEMORY_FILE_BYTES = 400_000;
export const MAX_ITEM_TEXT_CHARS = 4_000;
export const MAX_SCOPE_ITEM_TEXT_CHARS = 120_000;
export const MAX_RESPONSE_JSON_BYTES = 850_000;
export const MAX_VISITED_DIRS = 500;
export const MAX_VISITED_PER_WORKSPACE = 120;

export type DiscoverLimits = {
  maxVisitedDirs?: number;
  maxVisitedPerWorkspace?: number;
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "venv", "__pycache__"]);
const posix = (path: string) => path.split(sep).join("/");

type ScopeRecord = {
  id: string;
  label: string;
  kind: MemoryCenterKind;
  layer: MemoryCenterLayer;
  parentId: string | null;
  absDir: string | null;
  tokenBudget: number;
};

const needlesCache = new Map<string, { rev: number; needles: string[] }>();

function payloadBytes(data: unknown) {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function realOr(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(root: string, path: string) {
  return isInside(path, root);
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function layerForWorkspaceDepth(depth: number): MemoryCenterLayer {
  if (depth <= 0) return "L2";
  if (depth === 1) return "L3";
  return "L4";
}

function hasMemorySignals(scopeDir: string) {
  const check = (rel: string) => {
    const abs = resolve(scopeDir, rel);
    if (scopedRead.isSymlinkPath(abs)) return false;
    try {
      if (!existsSync(abs)) return false;
      if (rel === MEMORY_FILE) return statSync(abs).isFile() && statSync(abs).size > 0;
      return statSync(abs).isFile() || (rel.endsWith("/rules") && isDir(abs));
    } catch {
      return false;
    }
  };
  if (check("AGENTS.md") || check(".cursorrules")) return true;
  const rulesDir = resolve(scopeDir, ".cursor/rules");
  if (scopedRead.isSymlinkPath(rulesDir)) return false;
  if (isDir(rulesDir)) {
    try {
      return readdirSync(rulesDir).some(
        (name) => /\.(md|mdc)$/i.test(name) && !scopedRead.isSymlinkPath(resolve(rulesDir, name)),
      );
    } catch {
      return false;
    }
  }
  return check(MEMORY_FILE);
}

function normalizeScopeId(raw: string) {
  const trimmed = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed === "." || trimmed.includes("..")) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part.startsWith("."))) return null;
  return parts.join("/");
}

function personalNeedles(ref: TenantRef) {
  const data = listMemory(ref);
  const key = ref.stateDir;
  const hit = needlesCache.get(key);
  if (hit?.rev === data.rev) return hit.needles;
  const needles: string[] = [];
  for (const entry of data.entries) {
    if (!isValid(entry)) continue;
    needles.push(entry.text.replace(/^(用户|他|她)(的)?/, "").replace(/[。.!！]$/, ""));
  }
  const core = readCore(ref);
  for (const field of CORE_FIELDS) {
    if (field === WORK_PREF_FIELD) continue;
    needles.push(...core.fields[field].split(/[。\n；;]/));
  }
  const out = needles.map((item) => item.trim()).filter((needle) => needle.length >= 8);
  needlesCache.set(key, { rev: data.rev, needles: out });
  return out;
}

function leaksPersonal(ref: TenantRef, text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

type MemoryReadResult =
  | { ok: true; lines: MemoryLine[]; bytes: number; fileTruncated: boolean; invalidUtf8?: boolean }
  | { ok: false; error: string; lines?: MemoryLine[]; bytes?: number; fileTruncated?: boolean };

function readScopeMemory(scopeDir: string, allowedRoot: string): MemoryReadResult {
  if (!scopedRead.scopedReadSupported()) {
    return { ok: false, error: "当前平台不支持安全读取（O_NOFOLLOW）。" };
  }
  let paths;
  try {
    paths = safeMemoryPaths(scopeDir, allowedRoot);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "工作区记忆路径不安全。" };
  }
  const read = scopeFileReader(paths.dir, MEMORY_FILE, MAX_MEMORY_FILE_BYTES);
  if (!read.ok) {
    if (read.code === "enoent") return { ok: true, lines: [], bytes: 0, fileTruncated: false };
    return { ok: false, error: read.message };
  }
  if (read.truncated) {
    return {
      ok: false,
      error: `memory.md 超过 ${MAX_MEMORY_FILE_BYTES} 字节上限。`,
      lines: [],
      bytes: read.bytes,
      fileTruncated: true,
    };
  }
  if (read.invalidUtf8) return { ok: false, error: "memory.md 含无效 UTF-8。" };
  try {
    const lines = parseMemoryFile(read.text);
    return { ok: true, lines, bytes: read.bytes, fileTruncated: false, invalidUtf8: read.invalidUtf8 };
  } catch {
    return { ok: false, error: "memory.md 解析失败。" };
  }
}

function clipItemText(text: string, max = MAX_ITEM_TEXT_CHARS) {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function toWorkspaceItem(
  line: MemoryLine,
  scope: ScopeRecord,
  dir: string,
  forceText?: string,
  textTruncated?: boolean,
): WorkspaceMemoryItem {
  const missingRefs = line.refs.filter((ref) => !existsSync(resolve(dir, ref)));
  const clipped =
    forceText === undefined ? clipItemText(line.text) : { text: forceText, truncated: Boolean(textTruncated) };
  return {
    id: line.id ?? null,
    kind: scope.kind,
    layer: scope.layer,
    scopeId: scope.id,
    section: line.section,
    text: clipped.text,
    refs: line.refs,
    missingRefs,
    at: line.at ?? null,
    from: line.from ?? null,
    state: line.state ?? null,
    effectiveState: effectiveMemoryState(line),
    pinned: line.pinned,
    used: line.used ?? null,
    uses: line.uses,
    expires: line.expires ?? null,
    truncated: clipped.truncated,
    revision: memoryLineRevision(line),
  };
}

function readRuleFiles(scopeDir: string, scopeId: string, cap: { left: number }) {
  const rules: RuleFile[] = [];
  let readError: string | null = null;
  const take = (rel: string) => {
    if (cap.left <= 0) return;
    if (scopedRead.isSymlinkPath(resolve(scopeDir, rel))) return;
    const read = scopeFileReader(scopeDir, rel, Math.min(MAX_RULE_FILE_CHARS, cap.left));
    if (!read.ok) {
      if (read.code === "enoent") return;
      readError = read.message;
      return;
    }
    if (read.invalidUtf8) return;
    const body = read.text;
    const takeChars = Math.min(body.length, cap.left, MAX_RULE_FILE_CHARS);
    cap.left -= takeChars;
    rules.push({
      relPath: rel,
      appliesDir: scopeId,
      chars: read.bytes,
      body: body.slice(0, takeChars),
      truncated: read.truncated || takeChars < body.length,
    });
  };
  take(".cursorrules");
  take("AGENTS.md");
  const rulesDir = resolve(scopeDir, ".cursor/rules");
  if (scopedRead.isSymlinkPath(rulesDir)) return { rules, readError };
  if (isDir(rulesDir)) {
    try {
      for (const name of readdirSync(rulesDir).sort()) {
        if (!/\.(md|mdc)$/i.test(name)) continue;
        take(`.cursor/rules/${name}`);
      }
    } catch {
      // unreadable
    }
  }
  return { rules, readError };
}

function summarizeMemoryFile(scopeDir: string, allowedRoot: string, tokenBudget: number) {
  const read = readScopeMemory(scopeDir, allowedRoot);
  if (!read.ok) {
    return {
      error: read.error,
      memoryCount: 0,
      hot: 0,
      cold: 0,
      done: 0,
      expired: 0,
      pinned: 0,
      missingRefs: 0,
      diagnostics: null as InjectionDiagnostics | null,
    };
  }
  if (read.fileTruncated) {
    return {
      error: `memory.md 超过 ${MAX_MEMORY_FILE_BYTES} 字节上限，仅读取前缀。`,
      memoryCount: read.lines.length,
      hot: 0,
      cold: 0,
      done: 0,
      expired: 0,
      pinned: 0,
      missingRefs: 0,
      diagnostics: null,
    };
  }
  let hot = 0;
  let cold = 0;
  let done = 0;
  let expired = 0;
  let pinned = 0;
  let missingRefs = 0;
  for (const line of read.lines) {
    const effective = effectiveMemoryState(line);
    if (effective === "hot") hot += 1;
    else if (effective === "cold") cold += 1;
    else if (effective === "done") done += 1;
    else expired += 1;
    if (line.pinned) pinned += 1;
    missingRefs += line.refs.filter((ref) => !existsSync(resolve(scopeDir, ref))).length;
  }
  let diagnostics: InjectionDiagnostics | null = null;
  try {
    diagnostics = planMemoryInjection(scopeDir, tokenBudget, "", allowedRoot)?.diagnostics ?? null;
  } catch {
    diagnostics = null;
  }
  return {
    memoryCount: read.lines.length,
    hot,
    cold,
    done,
    expired,
    pinned,
    missingRefs,
    diagnostics,
    error: null as string | null,
  };
}

function pendingForScope(ref: TenantRef, scopeId: string) {
  return listProposals(ref).proposals.filter((row) => {
    if (scopeId === "work_preference") return row.kind === "work_pref";
    if (scopeId === "personal") return false;
    const dir = row.dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return dir === scopeId || dir.startsWith(`${scopeId}/`);
  }).length;
}

function buildScopeSummary(ref: TenantRef, scope: ScopeRecord, allowedRoot: string): MemoryCenterScopeSummary {
  if (scope.id === "personal") {
    const entries = listMemory(ref).entries;
    const day = new Date().toISOString().slice(0, 10);
    let valid = 0;
    let invalid = 0;
    for (const entry of entries) {
      if (isValid(entry, day)) valid += 1;
      else invalid += 1;
    }
    return {
      id: scope.id,
      label: scope.label,
      kind: scope.kind,
      layer: scope.layer,
      parentId: scope.parentId,
      memoryCount: entries.length,
      hot: valid,
      cold: 0,
      done: invalid,
      expired: 0,
      pinned: 0,
      missingRefs: 0,
      ruleFileCount: 0,
      tokenBudget: CORE_TOKEN_BUDGET,
      injectionSelected: 0,
      injectionSkipped: 0,
      pendingCount: 0,
      health: null,
      error: null,
    };
  }
  if (scope.id === "work_preference") {
    const lines = readCore(ref)
      .fields[WORK_PREF_FIELD].split("\n")
      .filter((line) => line.trim());
    return {
      id: scope.id,
      label: scope.label,
      kind: scope.kind,
      layer: scope.layer,
      parentId: scope.parentId,
      memoryCount: lines.length,
      hot: lines.length,
      cold: 0,
      done: 0,
      expired: 0,
      pinned: 0,
      missingRefs: 0,
      ruleFileCount: 0,
      tokenBudget: WORK_PREF_TOKEN_BUDGET,
      injectionSelected: lines.length,
      injectionSkipped: 0,
      pendingCount: pendingForScope(ref, scope.id),
      health: null,
      error: null,
    };
  }
  if (!scope.absDir) {
    return {
      id: scope.id,
      label: scope.label,
      kind: scope.kind,
      layer: scope.layer,
      parentId: scope.parentId,
      memoryCount: 0,
      hot: 0,
      cold: 0,
      done: 0,
      expired: 0,
      pinned: 0,
      missingRefs: 0,
      ruleFileCount: 0,
      tokenBudget: scope.tokenBudget,
      injectionSelected: 0,
      injectionSkipped: 0,
      pendingCount: pendingForScope(ref, scope.id),
      error: "作用域目录不可用",
      health: "error",
    };
  }
  let stats = summarizeMemoryFile(scope.absDir, allowedRoot, scope.tokenBudget);
  let ruleFileCount = 0;
  try {
    const ruleRead = readRuleFiles(scope.absDir, scope.id, { left: MAX_RULE_PAYLOAD_CHARS });
    ruleFileCount = ruleRead.rules.length;
    if (ruleRead.readError && !stats.error) stats = { ...stats, error: ruleRead.readError };
  } catch {
    ruleFileCount = 0;
  }
  return {
    id: scope.id,
    label: scope.label,
    kind: scope.kind,
    layer: scope.layer,
    parentId: scope.parentId,
    memoryCount: stats.memoryCount,
    hot: stats.hot,
    cold: stats.cold,
    done: stats.done,
    expired: stats.expired,
    pinned: stats.pinned,
    missingRefs: stats.missingRefs,
    ruleFileCount,
    tokenBudget: scope.tokenBudget,
    injectionSelected: stats.diagnostics?.selected ?? 0,
    injectionSkipped: (stats.diagnostics?.skippedBudget ?? 0) + (stats.diagnostics?.terminalSkipped ?? 0),
    pendingCount: pendingForScope(ref, scope.id),
    health: stats.error ? "degraded" : null,
    error: stats.error,
  };
}

function discoverScopes(tenant: WorkspaceRoot, workspaceNames: string[], limits: DiscoverLimits = {}) {
  const maxVisitedDirs = limits.maxVisitedDirs ?? MAX_VISITED_DIRS;
  const maxVisitedPerWorkspace = limits.maxVisitedPerWorkspace ?? MAX_VISITED_PER_WORKSPACE;
  const root = realOr(tenant.workspaceRoot);
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const scopes = new Map<string, ScopeRecord>();
  scopes.set("personal", {
    id: "personal",
    label: "关于我",
    kind: "personal",
    layer: "L0",
    parentId: null,
    absDir: null,
    tokenBudget: CORE_TOKEN_BUDGET,
  });
  scopes.set("work_preference", {
    id: "work_preference",
    label: "工作偏好",
    kind: "work_preference",
    layer: "L1",
    parentId: null,
    absDir: null,
    tokenBudget: WORK_PREF_TOKEN_BUDGET,
  });

  let truncated = false;
  let visitedDirs = 0;
  const perWorkspaceVisited = new Map<string, number>();

  const register = (id: string, absDir: string, depthFromWs: number, parentId: string | null) => {
    if (scopes.size >= MAX_SCOPES) {
      truncated = true;
      return;
    }
    const rel = posix(relative(root, absDir));
    if (!rel || rel === "." || rel.startsWith("..")) return;
    if (scopes.has(rel)) return;
    scopes.set(rel, {
      id: rel,
      label: rel,
      kind: "workspace_memory",
      layer: layerForWorkspaceDepth(depthFromWs),
      parentId,
      absDir,
      tokenBudget: depthFromWs <= 0 ? LAYER_TOKEN_BUDGET.workspace : LAYER_TOKEN_BUDGET.repo,
    });
  };

  const visitCapReached = (wsKey: string) =>
    visitedDirs >= maxVisitedDirs || (perWorkspaceVisited.get(wsKey) ?? 0) >= maxVisitedPerWorkspace;

  const consumeVisit = (wsKey: string) => {
    if (visitCapReached(wsKey)) {
      truncated = true;
      return false;
    }
    perWorkspaceVisited.set(wsKey, (perWorkspaceVisited.get(wsKey) ?? 0) + 1);
    visitedDirs += 1;
    return true;
  };

  const walkNested = (parentAbs: string, parentRel: string, depth: number, parentId: string, wsKey: string) => {
    if (depth > MAX_NEST_DEPTH) return;
    if (!consumeVisit(wsKey)) return;

    let nested = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(parentAbs).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (visitCapReached(wsKey) || scopes.size >= MAX_SCOPES) {
        truncated = true;
        break;
      }
      if (nested >= MAX_NEST_PER_WORKSPACE) {
        truncated = true;
        break;
      }
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      if (visitCapReached(wsKey)) {
        truncated = true;
        break;
      }
      const abs = resolve(parentAbs, name);
      if (scopedRead.isSymlinkPath(abs)) continue;
      if (!isDir(abs)) continue;
      const rel = parentRel ? `${parentRel}/${name}` : name;
      let realAbs: string;
      try {
        realAbs = realpathSync(abs);
      } catch {
        continue;
      }
      if (!within(root, realAbs)) continue;
      if (hasMemorySignals(realAbs)) {
        register(rel, realAbs, depth + 1, parentId);
        nested += 1;
        walkNested(realAbs, rel, depth + 1, rel, wsKey);
      } else {
        walkNested(realAbs, rel, depth + 1, parentId, wsKey);
      }
    }
  };

  for (const name of workspaceNames) {
    const normalized = normalizeScopeId(name);
    if (!normalized) continue;
    if (visitCapReached(normalized) || scopes.size >= MAX_SCOPES) {
      truncated = true;
      break;
    }
    const abs = resolve(root, normalized);
    if (scopedRead.isSymlinkPath(abs)) continue;
    let realAbs: string;
    try {
      realAbs = realpathSync(abs);
    } catch {
      continue;
    }
    if (!within(root, realAbs) || realAbs === root) continue;
    register(normalized, realAbs, 0, null);
    walkNested(realAbs, normalized, 0, normalized, normalized);
  }

  return { ref, root, scopes, truncated };
}

/** 测试用：带 visit 上限的作用域发现。 */
export function discoverScopesForTest(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  limits: DiscoverLimits = {},
) {
  return discoverScopes(tenant, workspaceNames, limits);
}

function resolveScopeArg(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  rawScope?: string,
):
  | { ok: true; scope: ScopeRecord; registry: Map<string, ScopeRecord>; root: string; ref: TenantRef }
  | { ok: false; error: string } {
  const discovered = discoverScopes(tenant, workspaceNames);
  if (!rawScope?.trim()) return { ok: false, error: "缺少 scope。" };
  const id = normalizeScopeId(rawScope);
  if (!id) return { ok: false, error: "scope 不合法。" };
  const scope = discovered.scopes.get(id);
  if (!scope) return { ok: false, error: "未知或未授权的作用域。" };
  if (scope.absDir) {
    try {
      const real = realpathSync(scope.absDir);
      if (!within(discovered.root, real)) return { ok: false, error: "作用域路径越界。" };
    } catch {
      return { ok: false, error: "无法解析作用域路径。" };
    }
  }
  return { ok: true, scope, registry: discovered.scopes, root: discovered.root, ref: discovered.ref };
}

function personalOverview(ref: TenantRef) {
  const entries = listMemory(ref).entries;
  const day = new Date().toISOString().slice(0, 10);
  let validEntries = 0;
  let invalidEntries = 0;
  for (const entry of entries) {
    if (isValid(entry, day)) validEntries += 1;
    else invalidEntries += 1;
  }
  const core = readCore(ref);
  const coreFieldLines = CORE_FIELDS.filter((key) => key !== WORK_PREF_FIELD)
    .map((key) => core.fields[key])
    .join("\n")
    .split("\n")
    .filter((line) => line.trim()).length;
  const workPreferenceLines = core.fields[WORK_PREF_FIELD].split("\n").filter((line) => line.trim()).length;
  return {
    validEntries,
    invalidEntries,
    coreFieldLines,
    workPreferenceLines,
    paused: readSettings(ref).paused,
    coreBudget: CORE_TOKEN_BUDGET,
    coreTokens: estimateTokens(
      CORE_FIELDS.filter((key) => key !== WORK_PREF_FIELD)
        .map((key) => core.fields[key])
        .join("\n"),
    ),
    workPreferenceBudget: WORK_PREF_TOKEN_BUDGET,
  };
}

function personalItems(ref: TenantRef): WorkspaceMemoryItem[] {
  return listMemory(ref)
    .entries.slice(0, MAX_SCOPE_ITEMS)
    .map((entry) => {
      const clipped = clipItemText(entry.text);
      return {
        id: entry.id,
        kind: "personal" as const,
        layer: "L0" as const,
        scopeId: "personal",
        section: entry.topic,
        text: clipped.text,
        truncated: clipped.truncated,
        refs: [],
        missingRefs: [],
        at: entry.updatedAt.slice(0, 10),
        from: entry.source?.chatId ?? null,
        state: entry.invalidAt ? "done" : "hot",
        effectiveState: isValid(entry) ? "hot" : "expired",
        pinned: entry.basis === "user_said",
        used: entry.lastUsedAt?.slice(0, 10) ?? null,
        uses: undefined,
        expires: entry.validUntil ?? null,
        revision: personalMemoryRevision({
          id: entry.id,
          rev: entry.rev,
          topic: entry.topic,
          text: entry.text,
        }),
      };
    });
}

function workPreferenceItems(ref: TenantRef): WorkspaceMemoryItem[] {
  const lines = readCore(ref)
    .fields[WORK_PREF_FIELD].split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  return lines.slice(0, MAX_SCOPE_ITEMS).map((text, index) => {
    const clipped = clipItemText(text);
    return {
      id: `wp-${index + 1}`,
      kind: "work_preference" as const,
      layer: "L1" as const,
      scopeId: "work_preference",
      text: clipped.text,
      truncated: clipped.truncated,
      refs: [],
      missingRefs: [],
      effectiveState: "hot" as const,
      state: "hot" as const,
      revision: workPreferenceRevision(text, index),
    };
  });
}

function workspaceDetail(ref: TenantRef, scope: ScopeRecord, root: string): MemoryCenterScopeDetail {
  const absDir = scope.absDir!;
  const read = readScopeMemory(absDir, root);
  let items: WorkspaceMemoryItem[] = [];
  let itemsTruncated = false;
  let diagnostics: InjectionDiagnostics | null = null;
  let scopeSummary = buildScopeSummary(ref, scope, root);
  if (!read.ok) {
    scopeSummary = { ...scopeSummary, error: read.error, health: "degraded" };
    return { scope: scopeSummary, items: [], rules: [], diagnostics: null };
  }
  if (read.fileTruncated) {
    scopeSummary = { ...scopeSummary, error: `memory.md 超过 ${MAX_MEMORY_FILE_BYTES} 字节上限`, health: "degraded" };
  }
  if (read.lines.length > MAX_SCOPE_ITEMS) itemsTruncated = true;
  let textBudget = MAX_SCOPE_ITEM_TEXT_CHARS;
  for (const line of read.lines.slice(0, MAX_SCOPE_ITEMS)) {
    const clipped = clipItemText(line.text, Math.min(MAX_ITEM_TEXT_CHARS, textBudget));
    textBudget -= clipped.text.length;
    items.push(toWorkspaceItem(line, scope, absDir, clipped.text, clipped.truncated));
    if (textBudget <= 0) {
      itemsTruncated = true;
      break;
    }
  }
  try {
    diagnostics = planMemoryInjection(absDir, scope.tokenBudget, "", root)?.diagnostics ?? null;
  } catch {
    diagnostics = null;
  }
  const cap = { left: MAX_RULE_PAYLOAD_CHARS };
  const ruleRead = readRuleFiles(absDir, scope.id, cap);
  if (ruleRead.readError) {
    scopeSummary = { ...scopeSummary, error: ruleRead.readError, health: "degraded" };
  }
  return {
    scope: scopeSummary,
    items,
    rules: ruleRead.rules,
    diagnostics,
    itemsTruncated,
    rulesPayloadTruncated: cap.left <= 0,
  };
}

function trimGetPayload(data: MemoryCenterGetData): MemoryCenterGetData {
  if (payloadBytes(data) <= MAX_RESPONSE_JSON_BYTES) return data;
  let payloadTruncated = true;
  if (data.mode === "detail") {
    let detail = { ...data.detail, rules: [...data.detail.rules], items: [...data.detail.items] };
    while (
      payloadBytes({ mode: "detail", detail, payloadTruncated }) > MAX_RESPONSE_JSON_BYTES &&
      detail.rules.length
    ) {
      detail.rules.pop();
    }
    while (
      payloadBytes({ mode: "detail", detail, payloadTruncated }) > MAX_RESPONSE_JSON_BYTES &&
      detail.items.length
    ) {
      detail.items.pop();
    }
    detail.items = detail.items.map((item) => {
      const clipped = clipItemText(item.text, 240);
      return { ...item, text: clipped.text, truncated: item.truncated || clipped.truncated };
    });
    if (detail.diagnostics) {
      detail = {
        ...detail,
        diagnostics: {
          ...detail.diagnostics,
          skippedReasons: detail.diagnostics.skippedReasons?.slice(0, 8),
          selectedIds: detail.diagnostics.selectedIds.slice(0, 8),
        },
      };
    }
    return { mode: "detail", detail, payloadTruncated };
  }
  let overview = { ...data.overview, scopes: [...data.overview.scopes] };
  while (
    payloadBytes({ mode: "overview", overview, payloadTruncated }) > MAX_RESPONSE_JSON_BYTES &&
    overview.scopes.length > 2
  ) {
    overview.scopes.pop();
  }
  return { mode: "overview", overview: { ...overview, scopesTruncated: true }, payloadTruncated };
}

function trimSearchPayload(data: MemoryCenterSearchData): MemoryCenterSearchData {
  if (payloadBytes(data) <= MAX_RESPONSE_JSON_BYTES) return data;
  let hits = [...data.hits];
  let payloadTruncated = true;
  while (payloadBytes({ hits, truncated: data.truncated, payloadTruncated }) > MAX_RESPONSE_JSON_BYTES && hits.length) {
    hits.pop();
  }
  hits = hits.map((hit) => {
    const clipped = clipItemText(hit.text, 240);
    return { ...hit, text: clipped.text };
  });
  return { hits, truncated: true, payloadTruncated };
}

export function memoryCenterGet(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  scopeArg?: string,
): MemoryCenterGetData {
  const discovered = discoverScopes(tenant, workspaceNames);
  if (!scopeArg?.trim()) {
    const scopes = [...discovered.scopes.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((scope) => {
        try {
          return buildScopeSummary(discovered.ref, scope, discovered.root);
        } catch (err) {
          return {
            id: scope.id,
            label: scope.label,
            kind: scope.kind,
            layer: scope.layer,
            parentId: scope.parentId,
            memoryCount: 0,
            hot: 0,
            cold: 0,
            done: 0,
            expired: 0,
            pinned: 0,
            missingRefs: 0,
            ruleFileCount: 0,
            tokenBudget: scope.tokenBudget,
            injectionSelected: 0,
            injectionSkipped: 0,
            pendingCount: 0,
            error: err instanceof Error ? err.message : "聚合失败",
            health: "error",
          };
        }
      });
    const overview: MemoryCenterOverview = {
      personal: personalOverview(discovered.ref),
      scopes,
      scopesTruncated: discovered.truncated,
    };
    return trimGetPayload({ mode: "overview", overview });
  }
  const resolved = resolveScopeArg(tenant, workspaceNames, scopeArg);
  if (!resolved.ok) {
    const fallbackScope: ScopeRecord = {
      id: normalizeScopeId(scopeArg) ?? scopeArg,
      label: scopeArg,
      kind: "workspace_memory",
      layer: "L2",
      parentId: null,
      absDir: null,
      tokenBudget: LAYER_TOKEN_BUDGET.workspace,
    };
    return trimGetPayload({
      mode: "detail",
      detail: {
        scope: {
          ...buildScopeSummary(discovered.ref, fallbackScope, discovered.root),
          error: resolved.error,
          health: "error",
        },
        items: [],
        rules: [],
        diagnostics: null,
      },
    });
  }
  if (resolved.scope.id === "personal") {
    return trimGetPayload({
      mode: "detail",
      detail: {
        scope: buildScopeSummary(resolved.ref, resolved.scope, resolved.root),
        items: personalItems(resolved.ref),
        rules: [],
        diagnostics: null,
        itemsTruncated: listMemory(resolved.ref).entries.length > MAX_SCOPE_ITEMS,
      },
    });
  }
  if (resolved.scope.id === "work_preference") {
    const lines = readCore(resolved.ref)
      .fields[WORK_PREF_FIELD].split("\n")
      .filter((line) => line.trim());
    return trimGetPayload({
      mode: "detail",
      detail: {
        scope: buildScopeSummary(resolved.ref, resolved.scope, resolved.root),
        items: workPreferenceItems(resolved.ref),
        rules: [],
        diagnostics: null,
        itemsTruncated: lines.length > MAX_SCOPE_ITEMS,
      },
    });
  }
  return trimGetPayload({ mode: "detail", detail: workspaceDetail(resolved.ref, resolved.scope, resolved.root) });
}

function searchReasonsForLine(
  line: MemoryLine,
  terms: string[],
  scopeId = "",
  stateFilter?: string,
): MemoryCenterSearchMatchReason[] {
  const reasons: MemoryCenterSearchMatchReason[] = [];
  const text = line.text.toLowerCase();
  const section = line.section.toLowerCase();
  const refs = line.refs.join(" ").toLowerCase();
  const scope = scopeId.toLowerCase();
  if (terms.some((term) => text.includes(term))) reasons.push("text");
  if (terms.some((term) => section.includes(term))) reasons.push("section");
  if (terms.some((term) => refs.includes(term))) reasons.push("ref");
  if (scopeId && terms.some((term) => scope.includes(term))) reasons.push("scope");
  const eff = effectiveMemoryState(line);
  if (stateFilter && (eff === stateFilter || line.state === stateFilter)) reasons.push("state");
  if (line.pinned && terms.some((term) => "置顶常驻pinned".includes(term))) reasons.push("pinned");
  if (reasons.length) return reasons;
  return terms.length ? (["related"] as MemoryCenterSearchMatchReason[]) : [];
}

function personalSearchHits(ref: TenantRef, query: string, candidateLimit: number, stateFilter?: string) {
  const data = listMemory(ref);
  const terms = splitTerms(query);
  const at = new Date().toISOString().slice(0, 10);
  const entriesPath = assistantPath(ref, "memory", "entries.json");
  const index = cachedIndex(
    entriesPath,
    `${data.rev}:${fingerprint(data.entries.map((e) => `${e.id}:${e.rev}`))}`,
    () =>
      data.entries.map((entry) => ({
        topic: entry.topic,
        text: `${entry.kind} ${entry.text} ${(entry.supplements ?? []).join(" ")}`,
      })),
  );
  const picked = retrieve(index, query, {
    limit: candidateLimit,
    filter: (i) => isValid(data.entries[i], at),
    prior: (i) => (data.entries[i].basis === "user_said" ? 0.5 : 0),
  });
  return picked
    .map((hit) => {
      const entry = data.entries[hit.index];
      const effectiveState = isValid(entry, at) ? "hot" : "expired";
      const display = entry.invalidAt ? "done" : effectiveState;
      if (stateFilter && display !== stateFilter && !(stateFilter === "hot" && effectiveState === "hot")) return null;
      const row: MemoryCenterSearchHit = {
        scopeId: "personal",
        kind: "personal",
        layer: "L0",
        id: entry.id,
        section: entry.topic,
        text: entry.text,
        refs: [],
        missingRefs: [],
        state: entry.invalidAt ? "done" : "hot",
        effectiveState,
        pinned: entry.basis === "user_said",
        reasons: searchReasonsForLine({ section: entry.topic, text: entry.text, refs: [] }, terms, "personal", stateFilter),
        score: hit.score,
      };
      return row;
    })
    .filter((row): row is MemoryCenterSearchHit => row !== null);
}

function workspaceSearchHits(
  tenant: WorkspaceRoot,
  scopes: Map<string, ScopeRecord>,
  root: string,
  query: string,
  needles: string[],
  scopeFilter?: string,
  stateFilter?: string,
) {
  const terms = splitTerms(query);
  if (!terms.length) return [] as MemoryCenterSearchHit[];
  const rows: MemoryCenterSearchHit[] = [];
  for (const scope of scopes.values()) {
    if (scope.kind !== "workspace_memory" || !scope.absDir) continue;
    if (scopeFilter && scope.id !== scopeFilter && !scope.id.startsWith(`${scopeFilter}/`)) continue;
    const read = readScopeMemory(scope.absDir, root);
    if (!read.ok) continue;
    for (const line of read.lines) {
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (line.text.toLowerCase().includes(term) ? 3 : 0) +
          (line.section.toLowerCase().includes(term) ? 2 : 0) +
          (line.refs.join(" ").toLowerCase().includes(term) ? 1 : 0),
        0,
      );
      if (
        score <= 0 ||
        detectSecret(line.text) ||
        leaksPersonal({ id: tenant.id, stateDir: tenant.stateDir }, line.text, needles)
      )
        continue;
      const effectiveState = effectiveMemoryState(line);
      const missing = line.refs.some((refPath) => !existsSync(resolve(scope.absDir!, refPath)));
      const display: MemoryCenterState = missing
        ? "待核实"
        : line.pinned
          ? "pinned"
          : effectiveState === "expired"
            ? "expired"
            : effectiveState === "done"
              ? "done"
              : effectiveState === "cold"
                ? "cold"
                : "hot";
      if (stateFilter && display !== stateFilter && effectiveState !== stateFilter) continue;
      rows.push({
        scopeId: scope.id,
        kind: "workspace_memory",
        layer: scope.layer,
        id: line.id ?? null,
        section: line.section,
        text: line.text,
        refs: line.refs,
        missingRefs: line.refs.filter((refPath) => !existsSync(resolve(scope.absDir!, refPath))),
        state: line.state ?? null,
        effectiveState,
        pinned: line.pinned,
        reasons: searchReasonsForLine(line, terms, scope.id, stateFilter),
        score,
      });
    }
  }
  return rows;
}

function workPreferenceSearchHits(ref: TenantRef, query: string, stateFilter?: string) {
  const terms = splitTerms(query);
  if (!terms.length) return [] as MemoryCenterSearchHit[];
  const hits: MemoryCenterSearchHit[] = [];
  const lines = readCore(ref)
    .fields[WORK_PREF_FIELD].split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  for (const [index, text] of lines.entries()) {
    const score = terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 3 : 0), 0);
    if (score <= 0) continue;
    if (stateFilter && stateFilter !== "hot") continue;
    hits.push({
      scopeId: "work_preference",
      kind: "work_preference",
      layer: "L1",
      id: `wp-${index + 1}`,
      text,
      refs: [],
      missingRefs: [],
      state: "hot",
      effectiveState: "hot",
      reasons: ["text"],
      score,
    });
  }
  return hits;
}

export function memoryCenterSearch(
  tenant: WorkspaceRoot,
  workspaceNames: string[],
  input: { query: string; scope?: string; kind?: string; state?: string },
): { ok: true; data: MemoryCenterSearchData } | { ok: false; error: string } {
  const query = input.query?.trim() ?? "";
  if (!query) return { ok: false, error: "query 不能为空。" };
  const discovered = discoverScopes(tenant, workspaceNames);
  const scopeFilter = input.scope?.trim() ? normalizeScopeId(input.scope) : undefined;
  if (input.scope?.trim() && !scopeFilter) return { ok: false, error: "scope 不合法。" };
  if (
    scopeFilter &&
    !discovered.scopes.has(scopeFilter) &&
    scopeFilter !== "personal" &&
    scopeFilter !== "work_preference"
  ) {
    return { ok: false, error: "未知或未授权的作用域。" };
  }
  const kind = input.kind?.trim() as MemoryCenterKind | undefined;
  const stateFilter = input.state?.trim() as MemoryCenterState | undefined;
  const limit = MAX_SEARCH_HITS;
  const candidateLimit = limit + 1;
  const needles = personalNeedles(discovered.ref);
  const pooled: MemoryCenterSearchHit[] = [];
  const include = (rows: MemoryCenterSearchHit[]) => {
    for (const row of rows) {
      if (kind && row.kind !== kind) continue;
      pooled.push(row);
    }
  };
  if (!kind || kind === "personal") {
    if (!scopeFilter || scopeFilter === "personal")
      include(personalSearchHits(discovered.ref, query, candidateLimit, stateFilter));
  }
  if (!kind || kind === "work_preference") {
    if (!scopeFilter || scopeFilter === "work_preference")
      include(workPreferenceSearchHits(discovered.ref, query, stateFilter));
  }
  if (!kind || kind === "workspace_memory") {
    include(
      workspaceSearchHits(
        tenant,
        discovered.scopes,
        discovered.root,
        query,
        needles,
        scopeFilter && scopeFilter !== "personal" && scopeFilter !== "work_preference" ? scopeFilter : undefined,
        stateFilter,
      ),
    );
  }
  pooled.sort((a, b) => b.score - a.score);
  const truncated = pooled.length > limit;
  return { ok: true, data: trimSearchPayload({ hits: pooled.slice(0, limit), truncated }) };
}
