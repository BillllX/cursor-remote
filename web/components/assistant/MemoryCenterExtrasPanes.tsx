"use client";

import type {
  MemoryCenterActivityAction,
  MemoryCenterActivityEntry,
  MemoryCenterSuggestionEntry,
} from "@shared/protocol";
import styles from "./memoryCenter.module.css";
import { MEMORY_CENTER_CSS } from "./memoryCenterLabels";
import type { MemoryCenterActivityState } from "./memoryCenterActivityReducer";

const ACTION_LABEL: Record<string, string> = {
  create: "创建",
  update: "更新",
  set_state: "改状态",
  set_pinned: "置顶",
  delete: "删除",
  restore: "恢复",
};

const KIND_LABEL: Record<string, string> = {
  missing_ref: "缺引用",
  stale_hot: "冷归档",
  duplicate: "重复",
  budget_pressure: "预算压力",
  stale_ongoing: "进行中过期",
};

type ActivityProps = {
  state: MemoryCenterActivityState;
  scopeFilter: string;
  onScopeFilter: (value: string) => void;
  onActionFilter: (value: MemoryCenterActivityAction | "") => void;
  actionFilter: MemoryCenterActivityAction | "";
  onLoad: (append?: boolean) => void;
  onRestore: (entry: MemoryCenterActivityEntry) => void;
  onOpenScope: (scopeId: string) => void;
};

export function MemoryCenterActivityPane({
  state,
  scopeFilter,
  onScopeFilter,
  onActionFilter,
  actionFilter,
  onLoad,
  onRestore,
  onOpenScope,
}: ActivityProps) {
  const entries = state.activity?.entries ?? [];
  return (
    <div className={styles.extrasPane}>
      <div className={styles.extrasFilters}>
        <label className="loop-meta">
          作用域
          <input
            className={styles.filterInput}
            value={scopeFilter}
            placeholder="全部"
            onChange={(e) => onScopeFilter(e.target.value)}
          />
        </label>
        <label className="loop-meta">
          动作
          <select
            className={styles.filterInput}
            value={actionFilter}
            onChange={(e) => {
              const v = e.target.value;
              onActionFilter(v === "" || v in ACTION_LABEL ? (v as MemoryCenterActivityAction | "") : "");
            }}
          >
            <option value="">全部</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="pill" onClick={() => onLoad(false)} disabled={state.loadingActivity}>
          刷新
        </button>
      </div>
      {state.activityError ? <div className={MEMORY_CENTER_CSS.statusError}>{state.activityError}</div> : null}
      {state.activity?.degraded ? <div className="loop-meta">审计文件部分损坏，已跳过坏行。</div> : null}
      {state.loadingActivity && !entries.length ? <div className={MEMORY_CENTER_CSS.statusLoading}>加载中…</div> : null}
      <ul className="assistant-list">
        {entries.map((entry) => (
          <li key={`${entry.scope}:${entry.auditId}`}>
            <div className={`assistant-item ${MEMORY_CENTER_CSS.rowBtn}`}>
              <div className="assistant-item-head">
                <span className="assistant-item-title">
                  {ACTION_LABEL[entry.action] ?? entry.action} · {entry.scope}
                </span>
                <span className="chat-mark">{entry.actor}</span>
              </div>
              <div className="assistant-item-body">
                {entry.before ? (
                  <span>
                    {entry.before.text} → {entry.after?.text ?? "（已删除）"}
                  </span>
                ) : (
                  <span>{entry.after?.text ?? entry.itemId}</span>
                )}
              </div>
              <div className={styles.rowMeta}>
                <span className="loop-meta">{new Date(entry.at).toLocaleString()}</span>
                {!entry.canRestore && entry.restoreBlockedReason ? (
                  <span className="loop-meta">{entry.restoreBlockedReason}</span>
                ) : null}
              </div>
              <div className={styles.extrasActions}>
                <button type="button" className="pill" onClick={() => onOpenScope(entry.scope)}>
                  查看作用域
                </button>
                {entry.canRestore ? (
                  <button
                    type="button"
                    className="pill"
                    disabled={state.restoreBusyByAuditId[entry.auditId]}
                    onClick={() => {
                      if (window.confirm("确认按此审计记录回滚？将恢复 before 快照。")) onRestore(entry);
                    }}
                  >
                    {state.restoreBusyByAuditId[entry.auditId] ? "恢复中…" : "恢复"}
                  </button>
                ) : null}
              </div>
              {state.restoreErrorByAuditId[entry.auditId] ? (
                <div className={MEMORY_CENTER_CSS.statusError}>{state.restoreErrorByAuditId[entry.auditId]}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {state.activityCursor ? (
        <button type="button" className="pill" onClick={() => onLoad(true)} disabled={state.loadingActivity}>
          加载更多
        </button>
      ) : null}
    </div>
  );
}

type SuggestionsProps = {
  state: MemoryCenterActivityState;
  onRefresh: () => void;
  onAnswer: (entry: MemoryCenterSuggestionEntry, accept: boolean) => void;
  onAcceptAllLowRisk: () => void;
};

export function MemoryCenterSuggestionsPane({ state, onRefresh, onAnswer, onAcceptAllLowRisk }: SuggestionsProps) {
  const entries: MemoryCenterSuggestionEntry[] = state.suggestions?.entries ?? [];
  return (
    <div className={styles.extrasPane}>
      <div className={styles.extrasFilters}>
        <button type="button" className="pill" onClick={onRefresh} disabled={state.loadingSuggestions}>
          刷新建议
        </button>
        <button type="button" className="pill" onClick={onAcceptAllLowRisk} disabled={!entries.some((e) => e.risk === "low" && e.kind !== "missing_ref")}>
          逐条接受全部低风险
        </button>
      </div>
      {state.suggestionsError ? <div className={MEMORY_CENTER_CSS.statusError}>{state.suggestionsError}</div> : null}
      {state.suggestionBatchSummary ? (
        <div className="loop-meta">
          批量处理：成功 {state.suggestionBatchSummary.succeeded}，失败 {state.suggestionBatchSummary.failed}
          {state.suggestionBatchSummary.reasons.length
            ? `（${state.suggestionBatchSummary.reasons.slice(0, 3).join("；")}）`
            : ""}
        </div>
      ) : null}
      {state.loadingSuggestions && !entries.length ? <div className={MEMORY_CENTER_CSS.statusLoading}>加载中…</div> : null}
      <ul className="assistant-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className={`assistant-item ${MEMORY_CENTER_CSS.rowBtn}`}>
              <div className="assistant-item-head">
                <span className="assistant-item-title">
                  {KIND_LABEL[entry.kind] ?? entry.kind} · {entry.scope}
                </span>
                <span className={`chat-mark ${entry.risk === "medium" ? "warn" : ""}`}>{entry.risk}</span>
              </div>
              <div className="assistant-item-body">{entry.summary}</div>
              <div className="loop-meta">{entry.reason}</div>
              <div className={styles.extrasActions}>
                {entry.kind === "missing_ref" ? (
                  <>
                    <button
                      type="button"
                      className="pill"
                      disabled={state.suggestionById[entry.id]?.busy}
                      onClick={() => onAnswer(entry, true)}
                    >
                      已处理
                    </button>
                    <button
                      type="button"
                      className="pill"
                      disabled={state.suggestionById[entry.id]?.busy}
                      onClick={() => onAnswer(entry, false)}
                    >
                      忽略
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="pill"
                      disabled={state.suggestionById[entry.id]?.busy}
                      onClick={() => onAnswer(entry, true)}
                    >
                      接受
                    </button>
                    <button
                      type="button"
                      className="pill"
                      disabled={state.suggestionById[entry.id]?.busy}
                      onClick={() => onAnswer(entry, false)}
                    >
                      忽略
                    </button>
                  </>
                )}
              </div>
              {state.suggestionById[entry.id]?.error ? (
                <div className={MEMORY_CENTER_CSS.statusError}>{state.suggestionById[entry.id]?.error}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {!entries.length && !state.loadingSuggestions ? <div className="loop-meta">暂无待处理建议。</div> : null}
    </div>
  );
}
