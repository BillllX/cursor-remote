"use client";

import { useState } from "react";
import type {
  MemoryCenterActivityAction,
  MemoryCenterActivityEntry,
  MemoryCenterSuggestionEntry,
} from "@shared/protocol";
import styles from "./memoryCenter.module.css";
import { lowRiskBulk, suggestionOutcomeLabel } from "./memoryCenterCopy";
import { MEMORY_CENTER_CSS } from "./memoryCenterLabels";
import type { MemoryCenterActivityState } from "./memoryCenterActivityReducer";

const ACTION_LABEL: Record<string, string> = {
  create: "创建",
  update: "更新",
  set_state: "改状态",
  set_pinned: "始终带上",
  delete: "删除",
  restore: "恢复",
};

const ACTOR_LABEL: Record<string, string> = {
  user: "你",
  assistant: "小驳",
  agent: "Agent",
  system: "系统",
  tidy: "整理",
  import: "导入",
  page: "面板",
};

function formatScopeName(scope: string): string {
  if (scope === "personal") return "关于我";
  if (scope === "work_preference") return "工作偏好";
  return scope;
}

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
          文件夹
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
                  {ACTION_LABEL[entry.action] ?? entry.action} · {formatScopeName(entry.scope)}
                </span>
                <span className="chat-mark">{ACTOR_LABEL[entry.actor] ?? entry.actor}</span>
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
                  打开这条
                </button>
                {entry.canRestore ? (
                  <button
                    type="button"
                    className="pill"
                    disabled={state.restoreBusyByAuditId[entry.auditId]}
                    onClick={() => {
                      if (window.confirm("按这条记录，恢复到改之前？")) onRestore(entry);
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
  const bulk = lowRiskBulk(entries);
  const [confirmBulk, setConfirmBulk] = useState(false);
  if (confirmBulk) {
    return (
      <div className={styles.extrasPane}>
        <button type="button" className={`pill ${styles.drillBack}`} onClick={() => setConfirmBulk(false)}>
          返回
        </button>
        <p className="loop-meta">看完全文再确认。缺引用的不会进这里。</p>
        <ul className="assistant-list">
          {bulk.map((entry) => (
            <li key={entry.id} className="assistant-item">
              <div className="assistant-item-body">「{entry.summary}」</div>
              <div className="loop-meta">{entry.reason}</div>
              <div className={styles.clayText}>{suggestionOutcomeLabel(entry.kind)}</div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={styles.pineBtn}
          onClick={() => {
            onAcceptAllLowRisk();
            setConfirmBulk(false);
          }}
        >
          确认处理这些
        </button>
      </div>
    );
  }
  return (
    <div className={styles.extrasPane}>
      {state.suggestionsError ? <div className={MEMORY_CENTER_CSS.statusError}>{state.suggestionsError}</div> : null}
      {state.suggestionBatchSummary ? (
        <div className="loop-meta">
          处理完 {state.suggestionBatchSummary.succeeded} 条
          {state.suggestionBatchSummary.failed ? `，有 ${state.suggestionBatchSummary.failed} 条没成` : ""}
        </div>
      ) : null}
      {state.loadingSuggestions && !entries.length ? <div className={MEMORY_CENTER_CSS.statusLoading}>正在看有没有要你确认的…</div> : null}
      <ul className="assistant-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className={`assistant-item ${MEMORY_CENTER_CSS.rowBtn}`}>
              <div className="assistant-item-body">「{entry.summary}」</div>
              <div className="loop-meta">{entry.reason}</div>
              <div className={styles.extrasActions}>
                <button
                  type="button"
                  className={styles.pineBtn}
                  disabled={state.suggestionById[entry.id]?.busy}
                  onClick={() => onAnswer(entry, false)}
                >
                  先留着
                </button>
                <button
                  type="button"
                  className={styles.clayText}
                  disabled={state.suggestionById[entry.id]?.busy}
                  onClick={() => onAnswer(entry, true)}
                >
                  {suggestionOutcomeLabel(entry.kind)}
                </button>
              </div>
              {state.suggestionById[entry.id]?.error ? (
                <div className={MEMORY_CENTER_CSS.statusError}>{state.suggestionById[entry.id]?.error}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {!entries.length && !state.loadingSuggestions ? (
        <div className="loop-meta">都处理完了。</div>
      ) : null}
      {bulk.length ? (
        <button type="button" className="pill" onClick={() => setConfirmBulk(true)}>
          一次处理风险低的 {bulk.length} 条
        </button>
      ) : null}
      <button type="button" className="pill" onClick={onRefresh} disabled={state.loadingSuggestions}>
        再看一眼
      </button>
    </div>
  );
}
