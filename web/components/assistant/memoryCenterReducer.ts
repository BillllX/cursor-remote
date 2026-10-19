import type {
  AssistantResultMessage,
  InjectionDiagnostics,
  MemoryCenterGetData,
  MemoryCenterMutateFailureData,
  MemoryCenterOverview,
  MemoryCenterScopeDetail,
  MemoryCenterScopeSummary,
  MemoryCenterSearchData,
  MemoryCenterState,
  WorkspaceMemoryItem,
} from "@shared/protocol";
import { parseMemoryCenterMutationResult } from "@shared/memoryCenterMutationResult";

export type McNavId = "overview" | "personal" | "work_preference" | "activity" | "suggestions" | "settings" | string;

export type McMiddleTab = "pinned" | "injection" | "all" | "rules";

export type McMobilePane = "nav" | "middle" | "detail";

export type MemoryCenterRequestKind = "overview" | "scope" | "search" | "mutation";

export type PendingRequest = {
  reqId: string;
  kind: MemoryCenterRequestKind;
  scopeId?: string;
  query?: string;
};

export type MemoryCenterDataState = {
  overview: MemoryCenterOverview | null;
  overviewPayloadTruncated: boolean;
  detail: MemoryCenterScopeDetail | null;
  detailPayloadTruncated: boolean;
  search: MemoryCenterSearchData | null;
  pending: PendingRequest[];
  overviewError: string;
  scopeError: string;
  searchError: string;
  loadingOverview: boolean;
  loadingScope: boolean;
  loadingSearch: boolean;
  activeScopeId: string | null;
  activeScopeReqId: string | null;
  activeOverviewReqId: string | null;
  activeSearchReqId: string | null;
  activeMutationReqId: string | null;
  mutationScopeId: string | null;
  mutationError: string;
  mutationErrorCode: string;
  mutating: boolean;
  lastMutationOutcome:
    | { reqId: string; ok: true; action: string }
    | { reqId: string; ok: false; code: string; error: string; action?: string }
    | null;
};

export type MemoryCenterUiState = {
  navId: McNavId;
  mobilePane: McMobilePane;
  middleTab: McMiddleTab;
  stateFilter: MemoryCenterState | "all";
  selectedKey: string | null;
  searchInput: string;
  searchScopeFilter: string | "all";
  searchKindFilter: "personal" | "work_preference" | "workspace_memory" | "all";
  searchStateFilter: MemoryCenterState | "all";
  searchActive: boolean;
};

export const initialMemoryCenterData = (): MemoryCenterDataState => ({
  overview: null,
  overviewPayloadTruncated: false,
  detail: null,
  detailPayloadTruncated: false,
  search: null,
  pending: [],
  overviewError: "",
  scopeError: "",
  searchError: "",
  loadingOverview: false,
  loadingScope: false,
  loadingSearch: false,
  activeScopeId: null,
  activeScopeReqId: null,
  activeOverviewReqId: null,
  activeSearchReqId: null,
  activeMutationReqId: null,
  mutationScopeId: null,
  mutationError: "",
  mutationErrorCode: "",
  mutating: false,
  lastMutationOutcome: null,
});

export const initialMemoryCenterUi = (): MemoryCenterUiState => ({
  navId: "overview",
  mobilePane: "nav",
  middleTab: "pinned",
  stateFilter: "all",
  selectedKey: null,
  searchInput: "",
  searchScopeFilter: "all",
  searchKindFilter: "all",
  searchStateFilter: "all",
  searchActive: false,
});

function dropPendingOfKind(pending: PendingRequest[], kind: MemoryCenterRequestKind): PendingRequest[] {
  if (kind === "scope") return pending.filter((row) => row.kind !== "scope");
  if (kind === "mutation") return pending.filter((row) => row.kind !== "mutation");
  return pending.filter((row) => row.kind !== kind);
}

export function registerPending(
  data: MemoryCenterDataState,
  req: PendingRequest,
  opts?: { replaceSameKind?: boolean },
): MemoryCenterDataState {
  const pending = opts?.replaceSameKind ? dropPendingOfKind(data.pending, req.kind) : data.pending;
  const nextPending = [...pending, req];
  const base = { ...data, pending: nextPending };

  if (req.kind === "overview") {
    return {
      ...base,
      loadingOverview: true,
      activeOverviewReqId: req.reqId,
      overviewError: "",
    };
  }
  if (req.kind === "scope") {
    const scopeChanged = req.scopeId != null && data.detail?.scope.id !== req.scopeId;
    return {
      ...base,
      loadingScope: true,
      activeScopeId: req.scopeId ?? null,
      activeScopeReqId: req.reqId,
      detail: scopeChanged ? null : data.detail,
      detailPayloadTruncated: scopeChanged ? false : data.detailPayloadTruncated,
      scopeError: "",
    };
  }
  if (req.kind === "mutation") {
    return {
      ...base,
      mutating: true,
      activeMutationReqId: req.reqId,
      mutationScopeId: req.scopeId ?? null,
      mutationError: "",
      mutationErrorCode: "",
    };
  }
  return {
    ...base,
    loadingSearch: true,
    activeSearchReqId: req.reqId,
    searchError: "",
  };
}

export function dropPending(data: MemoryCenterDataState, reqId: string): MemoryCenterDataState {
  const pending = data.pending.filter((row) => row.reqId !== reqId);
  return {
    ...data,
    pending,
    loadingOverview: pending.some((p) => p.kind === "overview"),
    loadingScope: pending.some((p) => p.kind === "scope"),
    loadingSearch: pending.some((p) => p.kind === "search"),
    mutating: pending.some((p) => p.kind === "mutation"),
  };
}

export function findPending(data: MemoryCenterDataState, reqId: string | undefined): PendingRequest | undefined {
  if (!reqId) return undefined;
  return data.pending.find((row) => row.reqId === reqId);
}

export function applyMemoryCenterResult(
  data: MemoryCenterDataState,
  message: AssistantResultMessage,
): MemoryCenterDataState | null {
  if (
    message.op !== "memory_center_get" &&
    message.op !== "memory_center_search" &&
    message.op !== "memory_center_mutate"
  )
    return null;
  const pending = findPending(data, message.reqId);
  if (!pending) return null;

  const next = dropPending(data, pending.reqId);

  if (message.op === "memory_center_mutate") {
    return applyMutateResult(data, next, pending, message);
  }

  if (!message.ok) {
    const err = message.error || "请求失败";
    if (pending.kind === "search") {
      if (message.reqId !== data.activeSearchReqId) return next;
      return { ...next, searchError: err };
    }
    if (pending.kind === "overview") {
      if (message.reqId !== data.activeOverviewReqId) return next;
      return { ...next, overviewError: err };
    }
    if (message.reqId !== data.activeScopeReqId) return next;
    return { ...next, scopeError: err };
  }

  if (message.op === "memory_center_get" && message.data) {
    return applyGetResult(data, next, pending, message.data);
  }
  if (message.op === "memory_center_search" && message.data) {
    if (message.reqId !== data.activeSearchReqId) return next;
    return { ...next, search: message.data, searchError: "" };
  }
  return next;
}

function applyMutateResult(
  dataBefore: MemoryCenterDataState,
  data: MemoryCenterDataState,
  pending: PendingRequest,
  message: AssistantResultMessage,
): MemoryCenterDataState {
  if (pending.kind !== "mutation" || pending.reqId !== dataBefore.activeMutationReqId) return data;
  if (pending.scopeId && dataBefore.mutationScopeId && pending.scopeId !== dataBefore.mutationScopeId) return data;
  let parsed: ReturnType<typeof parseMemoryCenterMutationResult>;
  try {
    parsed = parseMemoryCenterMutationResult(message);
  } catch {
    return { ...data, mutationError: "mutation 响应无法解析。" };
  }
  if (!parsed) return { ...data, mutationError: "mutation 响应无法解析。" };
  if (!parsed.ok) {
    const failData: MemoryCenterMutateFailureData = parsed.data;
    let next: MemoryCenterDataState = {
      ...data,
      mutationError: parsed.error,
      mutationErrorCode: failData.code,
      lastMutationOutcome: {
        reqId: pending.reqId,
        ok: false,
        code: failData.code,
        error: parsed.error,
      },
    };
    if (failData.code === "conflict" && failData.detail) {
      if (
        dataBefore.activeScopeId &&
        failData.detail.scope.id === dataBefore.activeScopeId &&
        pending.scopeId === dataBefore.activeScopeId
      ) {
        next = { ...next, detail: failData.detail, scopeError: "" };
      }
    }
    return next;
  }
  const payload = parsed.data;
  if (pending.scopeId && payload.detail.scope.id !== pending.scopeId) return data;
  if (dataBefore.activeScopeId && payload.detail.scope.id !== dataBefore.activeScopeId) return data;
  return {
    ...data,
    detail: payload.detail,
    mutationError: "",
    mutationErrorCode: "",
    scopeError: "",
    lastMutationOutcome: { reqId: pending.reqId, ok: true, action: payload.action },
  };
}

function applyGetResult(
  dataBefore: MemoryCenterDataState,
  data: MemoryCenterDataState,
  pending: PendingRequest,
  payload: MemoryCenterGetData,
): MemoryCenterDataState {
  if (payload.mode === "overview") {
    if (pending.kind !== "overview" || pending.reqId !== dataBefore.activeOverviewReqId) return data;
    return {
      ...data,
      overview: payload.overview,
      overviewPayloadTruncated: Boolean(payload.payloadTruncated),
      overviewError: "",
    };
  }
  if (pending.kind !== "scope" || pending.reqId !== dataBefore.activeScopeReqId) return data;
  if (pending.scopeId && payload.detail.scope.id !== pending.scopeId) return data;
  if (dataBefore.activeScopeId && payload.detail.scope.id !== dataBefore.activeScopeId) return data;
  return {
    ...data,
    detail: payload.detail,
    detailPayloadTruncated: Boolean(payload.payloadTruncated),
    scopeError: "",
  };
}

export function detailForScope(
  detail: MemoryCenterScopeDetail | null,
  scopeId: string | undefined,
): MemoryCenterScopeDetail | null {
  if (!detail || !scopeId) return null;
  return detail.scope.id === scopeId ? detail : null;
}

export function resolveScopeLabel(scopeId: string, scopes: MemoryCenterScopeSummary[]): string {
  return scopes.find((row) => row.id === scopeId)?.label ?? scopeId;
}

export type ScopeTreeRow = MemoryCenterScopeSummary & { depth: number };

export function buildScopeTreeRows(scopes: MemoryCenterScopeSummary[]): ScopeTreeRow[] {
  const workspace = scopes.filter((s) => s.id !== "personal" && s.id !== "work_preference");
  const byParent = new Map<string | null, MemoryCenterScopeSummary[]>();
  for (const row of workspace) {
    const key = row.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(row);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label, "zh"));
  }
  const out: ScopeTreeRow[] = [];
  function walk(parentId: string | null, depth: number) {
    const kids = byParent.get(parentId) ?? [];
    for (const row of kids) {
      out.push({ ...row, depth });
      walk(row.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

export function overviewPendingTotal(scopes: MemoryCenterScopeSummary[]): number {
  return scopes.reduce((sum, row) => sum + (row.pendingCount || 0), 0);
}

export function workspaceScopesForOverview(scopes: MemoryCenterScopeSummary[]): MemoryCenterScopeSummary[] {
  return scopes.filter((s) => s.id !== "personal" && s.id !== "work_preference");
}

export function filterItemsByState(
  items: WorkspaceMemoryItem[],
  stateFilter: MemoryCenterState | "all",
): WorkspaceMemoryItem[] {
  if (stateFilter === "all") return items;
  return items.filter((row) => {
    const eff = row.effectiveState;
    const raw = row.state;
    if (stateFilter === "pinned") return row.pinned === true;
    if (stateFilter === "待核实") return row.missingRefs.length > 0;
    return eff === stateFilter || raw === stateFilter;
  });
}

export function pinnedOnlyItems(items: WorkspaceMemoryItem[]): WorkspaceMemoryItem[] {
  return items.filter((row) => row.pinned === true);
}

export function injectionRoundItems(
  items: WorkspaceMemoryItem[],
  diagnostics: InjectionDiagnostics | null,
): WorkspaceMemoryItem[] {
  const ids = new Set(
    (diagnostics?.selectedIds ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (ids.size === 0) return [];
  return items.filter((row) => row.id != null && ids.has(row.id));
}

export function selectionReasonForItem(
  id: string | null,
  diagnostics: InjectionDiagnostics | null,
): InjectionDiagnostics["selectedIds"][number]["reason"] | null {
  if (!id || !diagnostics?.selectedIds) return null;
  const hit = diagnostics.selectedIds.find((row) => row.id === id);
  return hit?.reason ?? null;
}

export function skipReasonForItem(id: string | null, diagnostics: InjectionDiagnostics | null): string | null {
  if (!id || !diagnostics?.skippedReasons) return null;
  const hit = diagnostics.skippedReasons.find((row) => row.id === id);
  return hit?.reason ?? null;
}

export function scopeIdForNav(navId: McNavId): string | undefined {
  if (navId === "overview" || navId === "activity" || navId === "suggestions" || navId === "settings") return undefined;
  return navId;
}

export function isPlaceholderNav(navId: McNavId): boolean {
  return navId === "settings";
}
