"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { buildAssistantOpMessage } from "@shared/assistantOp";
import type {
  AssistantResultMessage,
  ClientMessage,
  MemoryCenterActivityAction,
  MemoryCenterActivityEntry,
  MemoryCenterMutateArgs,
  MemoryCenterState,
  MemoryCenterSuggestionEntry,
} from "@shared/protocol";
import {
  applyActivityResult,
  initialActivityState,
  registerActivityPending,
} from "./memoryCenterActivityReducer";
import type { SearchableMemoryCenterKind } from "./memoryCenterLabels";
import { createSearchDebouncer, searchDebounceKey, searchDebounceShouldRun } from "./memoryCenterSearchDebounce";
import {
  applyMemoryCenterResult,
  initialMemoryCenterData,
  initialMemoryCenterUi,
  registerPending,
  scopeIdForNav,
  type McNavId,
  type MemoryCenterUiState,
} from "./memoryCenterReducer";

const SEARCH_DEBOUNCE_MS = 300;

type UiAction =
  | { type: "set_nav"; navId: McNavId }
  | { type: "set_mobile"; pane: MemoryCenterUiState["mobilePane"] }
  | { type: "set_tab"; tab: MemoryCenterUiState["middleTab"] }
  | { type: "set_state_filter"; filter: MemoryCenterState | "all" }
  | { type: "select"; key: string | null }
  | { type: "set_search_input"; value: string }
  | { type: "set_search_scope"; value: string | "all" }
  | { type: "set_search_kind"; value: SearchableMemoryCenterKind | "all" }
  | { type: "set_search_state"; value: MemoryCenterState | "all" }
  | { type: "clear_search" };

function uiReducer(state: MemoryCenterUiState, action: UiAction): MemoryCenterUiState {
  switch (action.type) {
    case "set_nav":
      return {
        ...state,
        navId: action.navId,
        mobilePane: "middle",
        selectedKey: null,
        searchActive: false,
      };
    case "set_mobile":
      return { ...state, mobilePane: action.pane };
    case "set_tab":
      return { ...state, middleTab: action.tab, selectedKey: null };
    case "set_state_filter":
      return { ...state, stateFilter: action.filter, selectedKey: null };
    case "select":
      return { ...state, selectedKey: action.key, mobilePane: action.key ? "detail" : state.mobilePane };
    case "set_search_input": {
      const active = action.value.trim().length > 0;
      return {
        ...state,
        searchInput: action.value,
        searchActive: active,
        selectedKey: active ? null : state.selectedKey,
        mobilePane: active ? "middle" : state.mobilePane,
      };
    }
    case "set_search_scope":
      return { ...state, searchScopeFilter: action.value };
    case "set_search_kind":
      return { ...state, searchKindFilter: action.value };
    case "set_search_state":
      return { ...state, searchStateFilter: action.value };
    case "clear_search":
      return {
        ...state,
        searchActive: false,
        searchInput: "",
        searchScopeFilter: "all",
        searchKindFilter: "all",
        searchStateFilter: "all",
        mobilePane: "middle",
        selectedKey: null,
      };
    default:
      return state;
  }
}

type DataAction =
  | { type: "reset" }
  | {
      type: "register";
      reqId: string;
      kind: "overview" | "scope" | "search" | "mutation";
      scopeId?: string;
      query?: string;
    }
  | { type: "result"; message: AssistantResultMessage };

function dataReducer(state: ReturnType<typeof initialMemoryCenterData>, action: DataAction) {
  switch (action.type) {
    case "reset":
      return initialMemoryCenterData();
    case "register":
      return registerPending(
        state,
        {
          reqId: action.reqId,
          kind: action.kind,
          scopeId: action.scopeId,
          query: action.query,
        },
        { replaceSameKind: true },
      );
    case "result": {
      const applied = applyMemoryCenterResult(state, action.message);
      return applied ?? state;
    }
    default:
      return state;
  }
}

type Options = {
  active: boolean;
  send: (message: ClientMessage) => void;
  lastResult: AssistantResultMessage | null;
  resultTick: number;
};

export function useMemoryCenter({ active, send, lastResult, resultTick }: Options) {
  const [ui, dispatchUi] = useReducer(uiReducer, undefined, initialMemoryCenterUi);
  const [data, dispatchData] = useReducer(dataReducer, undefined, initialMemoryCenterData);
  const [activity, setActivity] = useReducer(
    (state: ReturnType<typeof initialActivityState>, action: { type: "reset" } | { type: "patch"; fn: (s: typeof state) => typeof state }) => {
      if (action.type === "reset") return initialActivityState();
      return action.fn(state);
    },
    undefined,
    initialActivityState,
  );
  const [activityScopeFilter, setActivityScopeFilter] = useState("");
  const [activityActionFilter, setActivityActionFilter] = useState<MemoryCenterActivityAction | "">("");
  const mountedRef = useRef(true);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const searchDebouncerRef = useRef<ReturnType<typeof createSearchDebouncer> | null>(null);

  if (!searchDebouncerRef.current) {
    searchDebouncerRef.current = createSearchDebouncer(
      (key) => {
        const current = uiRef.current;
        const expected = searchDebounceKey({
          query: current.searchInput,
          scope: current.searchScopeFilter,
          kind: current.searchKindFilter,
          state: current.searchStateFilter,
        });
        if (key !== expected) return;
        const trimmed = current.searchInput.trim();
        if (!trimmed) return;
        const args: {
          query: string;
          scope?: string;
          kind?: SearchableMemoryCenterKind;
          state?: MemoryCenterState;
        } = { query: trimmed };
        if (current.searchScopeFilter !== "all") args.scope = current.searchScopeFilter;
        if (current.searchKindFilter !== "all") args.kind = current.searchKindFilter;
        if (current.searchStateFilter !== "all") args.state = current.searchStateFilter;
        const msg = buildAssistantOpMessage("memory_center_search", args);
        dispatchData({ type: "register", reqId: msg.reqId!, kind: "search", query: trimmed });
        send(msg);
      },
      SEARCH_DEBOUNCE_MS,
      {
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (id) => {
          if (id != null) globalThis.clearTimeout(id as ReturnType<typeof setTimeout>);
        },
      },
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      searchDebouncerRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!active) {
      dispatchData({ type: "reset" });
      setActivity({ type: "reset" });
    }
  }, [active]);

  useEffect(() => {
    if (!active || !lastResult) return;
    if (!mountedRef.current) return;
    dispatchData({ type: "result", message: lastResult });
    const activityOps = new Set([
      "memory_center_activity",
      "memory_center_restore",
      "memory_center_suggestions_get",
      "memory_center_suggestion_answer",
    ]);
    if (activityOps.has(lastResult.op)) {
      setActivity({
        type: "patch",
        fn: (state) =>
          applyActivityResult(state, lastResult, {
            appendActivity: activityAppendRef.current,
            activityGeneration: state.activityGeneration,
            suggestionsGeneration: state.suggestionsGeneration,
            activityCursor: activityAppendRef.current ? state.activityCursor : null,
          }) ?? state,
      });
      if (lastResult.op === "memory_center_restore" && lastResult.ok && lastResult.data?.scope) {
        sendGet(lastResult.data.scope);
        loadActivity(false);
      }
    }
  }, [active, lastResult, resultTick]);

  const sendMutate = useCallback(
    (args: MemoryCenterMutateArgs) => {
      const msg = buildAssistantOpMessage("memory_center_mutate", args);
      dispatchData({
        type: "register",
        reqId: msg.reqId!,
        kind: "mutation",
        scopeId: args.scope,
      });
      send(msg);
    },
    [send],
  );

  const sendGet = useCallback(
    (scopeId?: string) => {
      const msg = scopeId
        ? buildAssistantOpMessage("memory_center_get", { scope: scopeId })
        : buildAssistantOpMessage("memory_center_get");
      dispatchData({
        type: "register",
        reqId: msg.reqId!,
        kind: scopeId ? "scope" : "overview",
        scopeId,
      });
      send(msg);
    },
    [send],
  );

  const retryOverview = useCallback(() => sendGet(), [sendGet]);

  const retryScope = useCallback((scopeId: string) => sendGet(scopeId), [sendGet]);

  const refreshCurrent = useCallback(() => {
    const current = uiRef.current;
    if (current.searchActive && current.searchInput.trim()) {
      const key = searchDebounceKey({
        query: current.searchInput,
        scope: current.searchScopeFilter,
        kind: current.searchKindFilter,
        state: current.searchStateFilter,
      });
      searchDebouncerRef.current?.flush(key);
      return;
    }
    const scope = scopeIdForNav(current.navId);
    if (current.navId === "overview" || !scope) sendGet();
    else sendGet(scope);
  }, [sendGet]);

  useEffect(() => {
    if (!active) return;
    const current = uiRef.current;
    if (current.searchActive) return;
    if (current.navId === "overview") {
      if (!data.overview && !data.loadingOverview) sendGet();
      return;
    }
    const scope = scopeIdForNav(current.navId);
    if (!scope) return;
    const detailOk = data.detail?.scope.id === scope;
    if (!detailOk && !data.loadingScope) sendGet(scope);
  }, [
    active,
    ui.navId,
    ui.searchActive,
    data.overview,
    data.detail?.scope.id,
    data.loadingOverview,
    data.loadingScope,
    sendGet,
  ]);

  useEffect(() => {
    const debouncer = searchDebouncerRef.current!;
    if (!active) {
      debouncer.cancel();
      return;
    }
    if (!searchDebounceShouldRun(ui.searchActive, ui.searchInput)) {
      debouncer.cancel();
      return;
    }
    const key = searchDebounceKey({
      query: ui.searchInput,
      scope: ui.searchScopeFilter,
      kind: ui.searchKindFilter,
      state: ui.searchStateFilter,
    });
    debouncer.schedule(key);
    return () => debouncer.cancel();
  }, [active, ui.searchInput, ui.searchScopeFilter, ui.searchKindFilter, ui.searchStateFilter, ui.searchActive]);

  const scheduleSearch = useCallback((query: string) => {
    dispatchUi({ type: "set_search_input", value: query });
    if (!query.trim()) dispatchUi({ type: "clear_search" });
  }, []);

  const submitSearch = useCallback((query: string) => {
    dispatchUi({ type: "set_search_input", value: query });
    if (!query.trim()) {
      searchDebouncerRef.current?.cancel();
      dispatchUi({ type: "clear_search" });
      return;
    }
    const key = searchDebounceKey({
      query,
      scope: uiRef.current.searchScopeFilter,
      kind: uiRef.current.searchKindFilter,
      state: uiRef.current.searchStateFilter,
    });
    searchDebouncerRef.current?.flush(key);
  }, []);

  const onSearchScopeChange = useCallback((value: string | "all") => {
    dispatchUi({ type: "set_search_scope", value });
  }, []);

  const onSearchKindChange = useCallback((value: SearchableMemoryCenterKind | "all") => {
    dispatchUi({ type: "set_search_kind", value });
  }, []);

  const onSearchStateChange = useCallback((value: MemoryCenterState | "all") => {
    dispatchUi({ type: "set_search_state", value });
  }, []);

  const activityAppendRef = useRef(false);

  const loadActivity = useCallback(
    (append?: boolean) => {
      activityAppendRef.current = Boolean(append);
      const args: import("@shared/protocol").AssistantOpArgsMap["memory_center_activity"] = { limit: 40 };
      const scope = activityScopeFilter.trim();
      if (scope) args.scope = scope;
      if (activityActionFilter) args.action = activityActionFilter as MemoryCenterActivityAction;
      if (append && activityRef.current.activityCursor) args.cursor = activityRef.current.activityCursor;
      const msg = buildAssistantOpMessage("memory_center_activity", args);
      setActivity({
        type: "patch",
        fn: (s) =>
          registerActivityPending(s, { reqId: msg.reqId!, kind: "activity" }, { refreshActivity: !append, appendActivity: append }),
      });
      send(msg);
    },
    [send, activityScopeFilter, activityActionFilter],
  );

  const loadSuggestions = useCallback((refresh = true) => {
    const msg = buildAssistantOpMessage("memory_center_suggestions_get");
    setActivity({
      type: "patch",
      fn: (s) => registerActivityPending(s, { reqId: msg.reqId!, kind: "suggestions" }, { refreshSuggestions: refresh }),
    });
    send(msg);
  }, [send]);

  const restoreActivity = useCallback(
    (entry: MemoryCenterActivityEntry) => {
      const msg = buildAssistantOpMessage("memory_center_restore", { scope: entry.scope, auditId: entry.auditId });
      setActivity({
        type: "patch",
        fn: (s) =>
          registerActivityPending(s, {
            reqId: msg.reqId!,
            kind: "restore",
            auditId: entry.auditId,
          }),
      });
      send(msg);
    },
    [send],
  );

  const answerSuggestion = useCallback(
    (entry: MemoryCenterSuggestionEntry, accept: boolean) => {
      const msg = buildAssistantOpMessage("memory_center_suggestion_answer", {
        scope: entry.scope,
        id: entry.id,
        accept,
      });
      setActivity({
        type: "patch",
        fn: (s) =>
          registerActivityPending(s, {
            reqId: msg.reqId!,
            kind: "suggestion_answer",
            targetId: entry.id,
          }),
      });
      send(msg);
    },
    [send],
  );

  const acceptAllLowRisk = useCallback(async () => {
    const list = activityRef.current.suggestions?.entries.filter((e) => e.risk === "low" && e.kind !== "missing_ref") ?? [];
    for (const entry of list) {
      answerSuggestion(entry, true);
    }
  }, [answerSuggestion]);

  useEffect(() => {
    if (!active) return;
    if (ui.navId === "activity" && !activity.loadingActivity && !activity.activity) loadActivity(false);
    if (ui.navId === "suggestions" && !activity.loadingSuggestions && !activity.suggestions) loadSuggestions();
  }, [active, ui.navId, activity.loadingActivity, activity.activity, activity.loadingSuggestions, activity.suggestions, loadActivity, loadSuggestions]);

  return {
    ui,
    data,
    activity,
    activityScopeFilter,
    setActivityScopeFilter,
    activityActionFilter,
    setActivityActionFilter,
    loadActivity,
    loadSuggestions,
    restoreActivity,
    answerSuggestion,
    acceptAllLowRisk,
    dispatchUi,
    sendGet,
    sendMutate,
    scheduleSearch,
    submitSearch,
    refreshCurrent,
    retryOverview,
    retryScope,
    clearSearch: () => {
      searchDebouncerRef.current?.cancel();
      dispatchUi({ type: "clear_search" });
    },
    onSearchScopeChange,
    onSearchKindChange,
    onSearchStateChange,
  };
}
