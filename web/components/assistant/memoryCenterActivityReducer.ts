import type {
  AssistantResultMessage,
  MemoryCenterActivityData,
  MemoryCenterSuggestionsData,
} from "@shared/protocol";
import {
  parseMemoryCenterActivityData,
  parseMemoryCenterRestoreFailureData,
  parseMemoryCenterSuggestionAnswerData,
  parseMemoryCenterSuggestionsData,
} from "@shared/memoryCenterParse";

export type ActivityPending = {
  reqId: string;
  kind: "activity" | "restore" | "suggestions" | "suggestion_answer";
  targetId?: string;
  auditId?: string;
};

export type SuggestionItemFlight = {
  reqId: string;
  busy: boolean;
  error: string;
  outcome?: "accepted" | "dismissed" | "stale";
};

export type SuggestionBatchSummary = {
  succeeded: number;
  failed: number;
  reasons: string[];
};

export type MemoryCenterActivityState = {
  activity: MemoryCenterActivityData | null;
  activityCursor: string | null;
  activityGeneration: number;
  activityLoadReqId: string | null;
  activityError: string;
  loadingActivity: boolean;
  restoringAuditId: string | null;
  restoreErrorByAuditId: Record<string, string>;
  restoreBusyByAuditId: Record<string, boolean>;
  suggestions: MemoryCenterSuggestionsData | null;
  suggestionsGeneration: number;
  suggestionsLoadReqId: string | null;
  suggestionsError: string;
  loadingSuggestions: boolean;
  suggestionById: Record<string, SuggestionItemFlight>;
  suggestionBatchSummary: SuggestionBatchSummary | null;
  pending: ActivityPending[];
};

export const initialActivityState = (): MemoryCenterActivityState => ({
  activity: null,
  activityCursor: null,
  activityGeneration: 0,
  activityLoadReqId: null,
  activityError: "",
  loadingActivity: false,
  restoringAuditId: null,
  restoreErrorByAuditId: {},
  restoreBusyByAuditId: {},
  suggestions: null,
  suggestionsGeneration: 0,
  suggestionsLoadReqId: null,
  suggestionsError: "",
  loadingSuggestions: false,
  suggestionById: {},
  suggestionBatchSummary: null,
  pending: [],
});

function dropPending(state: MemoryCenterActivityState, reqId: string) {
  const pending = state.pending.filter((row) => row.reqId !== reqId);
  return {
    ...state,
    pending,
    loadingActivity: pending.some((p) => p.kind === "activity"),
    loadingSuggestions: pending.some((p) => p.kind === "suggestions"),
  };
}

function recomputeSuggestionBatch(state: MemoryCenterActivityState): SuggestionBatchSummary | null {
  const flights = Object.values(state.suggestionById);
  if (!flights.length) return state.suggestionBatchSummary;
  const done = flights.filter((row) => !row.busy);
  if (!done.length) return state.suggestionBatchSummary;
  const succeeded = done.filter((row) => row.outcome && row.outcome !== "stale" && !row.error).length;
  const failed = done.filter((row) => row.error).length;
  const reasons = done.filter((row) => row.error).map((row) => row.error);
  if (succeeded === 0 && failed === 0) return state.suggestionBatchSummary;
  return { succeeded, failed, reasons };
}

export function registerActivityPending(
  state: MemoryCenterActivityState,
  req: ActivityPending,
  opts?: { refreshActivity?: boolean; refreshSuggestions?: boolean; appendActivity?: boolean },
): MemoryCenterActivityState {
  const pending = [...state.pending.filter((row) => row.reqId !== req.reqId), req];
  let next: MemoryCenterActivityState = {
    ...state,
    pending,
    loadingActivity: pending.some((p) => p.kind === "activity"),
    loadingSuggestions: pending.some((p) => p.kind === "suggestions"),
  };
  if (req.kind === "activity") {
    const generation = opts?.refreshActivity ? state.activityGeneration + 1 : state.activityGeneration;
    next = {
      ...next,
      activityGeneration: generation,
      activityLoadReqId: req.reqId,
      activityError: "",
      ...(opts?.refreshActivity && !opts.appendActivity ? { activity: null, activityCursor: null } : {}),
    };
  }
  if (req.kind === "suggestions") {
    next = {
      ...next,
      suggestionsGeneration: opts?.refreshSuggestions ? state.suggestionsGeneration + 1 : state.suggestionsGeneration,
      suggestionsLoadReqId: req.reqId,
      suggestionsError: "",
      ...(opts?.refreshSuggestions ? { suggestions: null } : {}),
    };
  }
  if (req.kind === "restore" && req.auditId) {
    next = {
      ...next,
      restoringAuditId: req.auditId,
      restoreBusyByAuditId: { ...next.restoreBusyByAuditId, [req.auditId]: true },
      restoreErrorByAuditId: { ...next.restoreErrorByAuditId, [req.auditId]: "" },
    };
  }
  if (req.kind === "suggestion_answer" && req.targetId) {
    next = {
      ...next,
      suggestionById: {
        ...next.suggestionById,
        [req.targetId!]: { reqId: req.reqId, busy: true, error: "" },
      },
      suggestionBatchSummary: null,
    };
  }
  return next;
}

export function applyActivityResult(
  state: MemoryCenterActivityState,
  message: AssistantResultMessage,
  opts?: {
    appendActivity?: boolean;
    activityGeneration?: number;
    suggestionsGeneration?: number;
    activityCursor?: string | null;
  },
): MemoryCenterActivityState | null {
  const reqId = message.reqId;
  if (!reqId) return null;
  const pending = state.pending.find((row) => row.reqId === reqId);
  if (!pending) return null;
  let next = dropPending(state, reqId);

  if (message.op === "memory_center_activity") {
    if (reqId !== state.activityLoadReqId) return next;
    if (opts?.activityGeneration !== undefined && opts.activityGeneration !== state.activityGeneration) return next;
    if (opts?.activityCursor !== undefined && opts.activityCursor !== state.activityCursor && opts.appendActivity) {
      return next;
    }
    if (!message.ok) {
      return { ...next, activityError: message.error || "加载活动失败" };
    }
    const data = parseMemoryCenterActivityData(message.data);
    if (!data) return { ...next, activityError: "活动数据格式错误" };
    const merged: MemoryCenterActivityData =
      opts?.appendActivity && state.activity
        ? { ...data, entries: [...state.activity.entries, ...data.entries] }
        : data;
    return {
      ...next,
      activity: merged,
      activityCursor: data.nextCursor ?? null,
      activityError: "",
    };
  }

  if (message.op === "memory_center_restore") {
    const auditId = pending.auditId ?? state.restoringAuditId;
    if (!auditId) return next;
    const restoreBusyByAuditId = { ...next.restoreBusyByAuditId, [auditId]: false };
    const restoreErrorByAuditId = { ...next.restoreErrorByAuditId };
    if (!message.ok) {
      const fail = parseMemoryCenterRestoreFailureData(message.data) ?? undefined;
      restoreErrorByAuditId[auditId] = message.error || fail?.code || "恢复失败";
    } else {
      restoreErrorByAuditId[auditId] = "";
    }
    return {
      ...next,
      restoreBusyByAuditId,
      restoreErrorByAuditId,
      restoringAuditId: Object.values(restoreBusyByAuditId).some(Boolean) ? next.restoringAuditId : null,
    };
  }

  if (message.op === "memory_center_suggestions_get") {
    if (reqId !== state.suggestionsLoadReqId) return next;
    if (opts?.suggestionsGeneration !== undefined && opts.suggestionsGeneration !== state.suggestionsGeneration) {
      return next;
    }
    if (!message.ok) return { ...next, suggestionsError: message.error || "加载建议失败" };
    const data = parseMemoryCenterSuggestionsData(message.data);
    if (!data) return { ...next, suggestionsError: "建议数据格式错误" };
    return { ...next, suggestions: data, suggestionsError: "" };
  }

  if (message.op === "memory_center_suggestion_answer") {
    const id = pending.targetId;
    if (!id) return next;
    const prev = next.suggestionById[id] ?? { reqId, busy: false, error: "" };
    if (prev.reqId !== reqId) return next;
    let flight: SuggestionItemFlight = { ...prev, busy: false };
    if (!message.ok) {
      const fail = parseMemoryCenterSuggestionAnswerData(message.data);
      flight = {
        ...flight,
        error: message.error || fail?.detail || "处理建议失败",
        outcome: fail?.status === "stale" ? "stale" : undefined,
      };
    } else {
      const payload = parseMemoryCenterSuggestionAnswerData(message.data);
      if (!payload) {
        flight = { ...flight, error: "建议答复格式错误" };
      } else {
        flight = { ...flight, error: "", outcome: payload.status };
        if (next.suggestions) {
          next = {
            ...next,
            suggestions: {
              ...next.suggestions,
              entries: next.suggestions.entries.filter((row) => row.id !== payload.id),
            },
          };
        }
      }
    }
    next = {
      ...next,
      suggestionById: { ...next.suggestionById, [id]: flight },
    };
    next.suggestionBatchSummary = recomputeSuggestionBatch(next);
    return next;
  }

  return next;
}
