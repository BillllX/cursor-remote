"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { BuildAssistantOpMessage } from "@shared/assistantOp";
import type {
  AssistantResultMessage,
  AssistantState,
  ClientMessage,
  InjectionDiagnostics,
  MemoryCenterSearchHit,
  MemoryCenterState,
  RuleFile,
  WorkspaceMemoryItem,
} from "@shared/protocol";
import styles from "./memoryCenter.module.css";
import {
  INJECTION_REASON_LABEL,
  KIND_LABEL,
  MEMORY_CENTER_CSS,
  MEMORY_CENTER_FOCUS,
  SEARCHABLE_KIND_LABEL,
  SKIP_REASON_LABEL,
  STATE_LABEL,
  effectiveStateLabel,
  formatMemoryCenterSearchReasons,
  itemKey,
  type SearchableMemoryCenterKind,
} from "./memoryCenterLabels";
import PersonalMemoryManage from "./PersonalMemoryManage";
import {
  buildScopeTreeRows,
  detailForScope,
  filterItemsByState,
  injectionRoundItems,
  isPlaceholderNav,
  overviewPendingTotal,
  pinnedOnlyItems,
  resolveScopeLabel,
  scopeIdForNav,
  selectionReasonForItem,
  skipReasonForItem,
  workspaceScopesForOverview,
  type McNavId,
} from "./memoryCenterReducer";
import MemoryCenterWorkspaceEditor from "./MemoryCenterWorkspaceEditor";
import { MemoryCenterActivityPane, MemoryCenterSuggestionsPane } from "./MemoryCenterExtrasPanes";
import MemoryCenterImportPane from "./MemoryCenterImportPane";
import { useMemoryCenter } from "./useMemoryCenter";

type Props = {
  active: boolean;
  initialScopeId?: string;
  openRequest: number;
  name: string;
  state: AssistantState | null;
  send: (message: ClientMessage) => void;
  op: BuildAssistantOpMessage;
  lastResult: AssistantResultMessage | null;
  resultTick: number;
  onNotice: (text: string) => void;
};

function Mark({ tone, children }: { tone?: "ok" | "warn" | "danger" | "run"; children: ReactNode }) {
  return <span className={`chat-mark ${tone ?? ""} ${MEMORY_CENTER_CSS.badge}`}>{children}</span>;
}

function TruncatedBanner({ show, label }: { show?: boolean; label: string }) {
  if (!show) return null;
  return <div className={`loop-meta ${MEMORY_CENTER_CSS.truncated}`}>{label}</div>;
}

function ScopeHealthDot({ health, error }: { health?: string | null; error?: string | null }) {
  if (error || health === "error")
    return (
      <span className={`${styles.healthDot} ${styles.healthError}`} title={error || "错误"} aria-label="作用域错误" />
    );
  if (health === "degraded")
    return (
      <span className={`${styles.healthDot} ${styles.healthWarn}`} title={error || "降级"} aria-label="作用域降级" />
    );
  return <span className={`${styles.healthDot} ${styles.healthOk}`} title="正常" aria-label="作用域正常" />;
}

function ItemRow({
  title,
  body,
  meta,
  selected,
  onSelect,
}: {
  title: string;
  body: string;
  meta: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`assistant-item assistant-item-btn ${MEMORY_CENTER_CSS.rowBtn}${selected ? ` ${MEMORY_CENTER_CSS.rowSelected}` : ""}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <div className="assistant-item-head">
          <span className="assistant-item-title">{title}</span>
        </div>
        <div className="assistant-item-body">{body}</div>
        <div className={styles.rowMeta}>{meta}</div>
      </button>
    </li>
  );
}

function itemMetaBadges(item: WorkspaceMemoryItem) {
  const parts: ReactNode[] = [];
  if (item.section) parts.push(<Mark key="sec">{item.section}</Mark>);
  parts.push(<Mark key="st">{effectiveStateLabel(item.effectiveState)}</Mark>);
  if (item.pinned)
    parts.push(
      <Mark key="pin" tone="ok">
        常驻
      </Mark>,
    );
  if (item.missingRefs.length)
    parts.push(
      <Mark key="miss" tone="warn">
        缺引用 {item.missingRefs.length}
      </Mark>,
    );
  if (item.truncated) parts.push(<Mark key="tr">已截断</Mark>);
  return parts;
}

function DiagnosticsBlock({ diagnostics }: { diagnostics: InjectionDiagnostics | null }) {
  if (!diagnostics) return <div className="loop-meta">暂无注入诊断。</div>;
  return (
    <div className={styles.diagnostics}>
      <div className="side-label">注入诊断</div>
      <ul className={styles.diagList}>
        <li>预算策略：{diagnostics.strategy}</li>
        <li>
          已选 {diagnostics.selected} / 共 {diagnostics.total} · 预算跳过 {diagnostics.skippedBudget}
        </li>
        <li>
          常驻 {diagnostics.pinnedSelected} · 锚点相关 {diagnostics.relevantSelected} · 冷召回{" "}
          {diagnostics.coldRecalled}
        </li>
        <li>
          终态跳过 {diagnostics.terminalSkipped}
          {diagnostics.coldUnrelatedSkipped != null ? ` · 冷无关跳过 ${diagnostics.coldUnrelatedSkipped}` : ""}
        </li>
      </ul>
      {diagnostics.selectedIdsTruncated ? <TruncatedBanner show label="选中条目列表已截断" /> : null}
      {diagnostics.skippedReasonsTruncated ? <TruncatedBanner show label="跳过原因列表已截断" /> : null}
      {diagnostics.truncated ? <TruncatedBanner show label="诊断 payload 已截断" /> : null}
    </div>
  );
}

function ItemDetail({
  item,
  diagnostics,
  scopeLabel,
  editableItem,
  editScopeId,
  mutating,
  mutationError,
  mutationConflict,
  onMutate,
  onOpenScopeForEdit,
  onClearSelection,
  onCreated,
}: {
  item: WorkspaceMemoryItem | MemoryCenterSearchHit;
  diagnostics: InjectionDiagnostics | null;
  scopeLabel: string;
  editableItem: WorkspaceMemoryItem | null;
  editScopeId: string | null;
  mutating: boolean;
  mutationError: string;
  mutationConflict: boolean;
  onMutate: (args: import("@shared/protocol").MemoryCenterMutateArgs) => void;
  onOpenScopeForEdit?: () => void;
  onClearSelection: () => void;
  onCreated: () => void;
}) {
  const id = item.id;
  const sel = selectionReasonForItem(id, diagnostics);
  const skip = skipReasonForItem(id, diagnostics);
  return (
    <div className={styles.detailBody}>
      <div className="assistant-item-body">{item.text}</div>
      {"truncated" in item && item.truncated ? (
        <TruncatedBanner show label="正文已在服务端截断，完整内容请打开源文件。" />
      ) : null}
      <dl className={styles.detailDl}>
        <div>
          <dt>层级</dt>
          <dd>{item.layer}</dd>
        </div>
        <div>
          <dt>种类</dt>
          <dd>{KIND_LABEL[item.kind]}</dd>
        </div>
        <div>
          <dt>作用域</dt>
          <dd>{scopeLabel}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{effectiveStateLabel(item.effectiveState)}</dd>
        </div>
        {"pinned" in item && item.pinned ? (
          <div>
            <dt>常驻</dt>
            <dd>是</dd>
          </div>
        ) : null}
        {item.section ? (
          <div>
            <dt>章节</dt>
            <dd>{item.section}</dd>
          </div>
        ) : null}
        {"at" in item && item.at ? (
          <div>
            <dt>日期</dt>
            <dd>{item.at}</dd>
          </div>
        ) : null}
        {"from" in item && item.from ? (
          <div>
            <dt>来源</dt>
            <dd>{item.from}</dd>
          </div>
        ) : null}
        {"used" in item && item.used ? (
          <div>
            <dt>最近采用</dt>
            <dd>
              {item.used}
              {item.uses != null ? ` · ${item.uses} 次` : ""}
            </dd>
          </div>
        ) : null}
        {id ? (
          <div>
            <dt>标识</dt>
            <dd>
              <code className={styles.mono}>{id}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>引用</dt>
          <dd>
            {item.refs.length ? item.refs.join(", ") : "无"}
            {item.missingRefs.length ? ` · 缺失：${item.missingRefs.join(", ")}` : ""}
          </dd>
        </div>
        {sel ? (
          <div>
            <dt>入选原因</dt>
            <dd>{INJECTION_REASON_LABEL[sel] ?? sel}</dd>
          </div>
        ) : null}
        {skip ? (
          <div>
            <dt>跳过原因</dt>
            <dd>{SKIP_REASON_LABEL[skip as keyof typeof SKIP_REASON_LABEL] ?? skip}</dd>
          </div>
        ) : null}
        {"reasons" in item && item.reasons.length ? (
          <div>
            <dt>搜索匹配</dt>
            <dd>
              {formatMemoryCenterSearchReasons(item.reasons)} · 搜索不续期
            </dd>
          </div>
        ) : null}
      </dl>
      {item.kind === "workspace_memory" && editScopeId && editableItem ? (
        <MemoryCenterWorkspaceEditor
          scopeId={editScopeId}
          item={editableItem}
          busy={mutating}
          error={mutationError}
          conflict={mutationConflict}
          onMutate={onMutate}
          onClearSelection={onClearSelection}
          onCreated={onCreated}
        />
      ) : null}
      {item.kind === "workspace_memory" && onOpenScopeForEdit ? (
        <button type="button" className="pill" onClick={onOpenScopeForEdit}>
          打开作用域并编辑（先加载 revision）
        </button>
      ) : null}
    </div>
  );
}

function RuleDetail({ rule }: { rule: RuleFile }) {
  return (
    <div className={styles.detailBody}>
      <dl className={styles.detailDl}>
        <div>
          <dt>来源</dt>
          <dd>{rule.relPath}</dd>
        </div>
        <div>
          <dt>作用目录</dt>
          <dd>{rule.appliesDir}</dd>
        </div>
        <div>
          <dt>字符数</dt>
          <dd>{rule.chars}</dd>
        </div>
      </dl>
      {rule.truncated ? <TruncatedBanner show label="规则正文已截断" /> : null}
      <pre className="assistant-pre">{rule.body}</pre>
    </div>
  );
}

export default function MemoryCenterPanel({
  active,
  initialScopeId,
  openRequest,
  name,
  state,
  send,
  op,
  lastResult,
  resultTick,
  onNotice,
}: Props) {
  const mc = useMemoryCenter({ active, send, lastResult, resultTick });
  const dispatchMemoryUi = mc.dispatchUi;
  const [wideThree, setWideThree] = useState(false);
  const middleTitleRef = useRef<HTMLHeadingElement>(null);
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const navTitleRef = useRef<HTMLHeadingElement>(null);
  const activeNavRef = useRef<HTMLButtonElement>(null);

  const currentScopeId = scopeIdForNav(mc.ui.navId);
  const detailForView = useMemo(() => detailForScope(mc.data.detail, currentScopeId), [mc.data.detail, currentScopeId]);
  const scopeLoadError =
    mc.data.scopeError && currentScopeId && mc.data.activeScopeId === currentScopeId && !mc.ui.searchActive;

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 960px)");
    const apply = () => setWideThree(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const layoutThree = wideThree;

  useEffect(() => {
    if (!active) return;
    dispatchMemoryUi({ type: "set_nav", navId: initialScopeId || "overview" });
  }, [active, dispatchMemoryUi, initialScopeId, openRequest]);

  useEffect(() => {
    if (!active || !initialScopeId || !mc.data.overview) return;
    if (!mc.data.overview.scopes.some((scope) => scope.id === initialScopeId)) {
      dispatchMemoryUi({ type: "set_nav", navId: "overview" });
    }
  }, [active, dispatchMemoryUi, initialScopeId, mc.data.overview, openRequest]);

  useEffect(() => {
    if (layoutThree) return;
    if (mc.ui.mobilePane === "nav") {
      activeNavRef.current?.focus();
      if (!activeNavRef.current) navTitleRef.current?.focus();
    }
    if (mc.ui.mobilePane === "middle") middleTitleRef.current?.focus();
    if (mc.ui.mobilePane === "detail") detailBackRef.current?.focus();
  }, [mc.ui.mobilePane, layoutThree, mc.ui.navId]);
  const showNav = layoutThree || mc.ui.mobilePane === "nav";
  const showMiddle = layoutThree || mc.ui.mobilePane === "middle";
  const showDetail = layoutThree || mc.ui.mobilePane === "detail";

  const treeRows = useMemo(() => buildScopeTreeRows(mc.data.overview?.scopes ?? []), [mc.data.overview?.scopes]);
  const workspaceCards = useMemo(
    () => workspaceScopesForOverview(mc.data.overview?.scopes ?? []),
    [mc.data.overview?.scopes],
  );

  const diagnostics = detailForView?.diagnostics ?? null;

  const listItems: WorkspaceMemoryItem[] = useMemo(() => {
    if (!detailForView) return [];
    if (mc.ui.middleTab === "rules") return [];
    let base = detailForView.items;
    if (mc.ui.middleTab === "pinned") base = pinnedOnlyItems(base);
    else if (mc.ui.middleTab === "injection") base = injectionRoundItems(base, diagnostics);
    return filterItemsByState(base, mc.ui.stateFilter);
  }, [detailForView, diagnostics, mc.ui.middleTab, mc.ui.stateFilter]);

  const selectedItem = useMemo(() => {
    if (!mc.ui.selectedKey) return null;
    if (mc.ui.searchActive && mc.data.search) {
      return mc.data.search.hits.find((hit, index) => itemKey(hit, index) === mc.ui.selectedKey) ?? null;
    }
    const idx = listItems.findIndex((row, index) => itemKey(row, index) === mc.ui.selectedKey);
    return idx >= 0 ? listItems[idx] : null;
  }, [listItems, mc.data.search, mc.ui.searchActive, mc.ui.selectedKey]);

  const selectedRule = useMemo(() => {
    if (mc.ui.middleTab !== "rules" || !detailForView || !mc.ui.selectedKey?.startsWith("rule:")) return null;
    const rel = mc.ui.selectedKey.slice("rule:".length);
    return detailForView.rules.find((r) => r.relPath === rel) ?? null;
  }, [detailForView, mc.ui.middleTab, mc.ui.selectedKey]);

  const overviewScopes = mc.data.overview?.scopes ?? [];

  function goNav(id: McNavId) {
    mc.clearSearch();
    mc.dispatchUi({ type: "set_nav", navId: id });
  }

  function renderOverviewMiddle() {
    const ov = mc.data.overview;
    if (mc.data.loadingOverview && !ov) return <div className={MEMORY_CENTER_CSS.statusLoading}>正在加载总览…</div>;
    if (mc.data.overviewError && !ov) {
      return (
        <div className={MEMORY_CENTER_CSS.statusError}>
          <p>{mc.data.overviewError}</p>
          <button type="button" className="pill" onClick={() => mc.retryOverview()}>
            重试总览
          </button>
        </div>
      );
    }
    if (!ov) return <div className="loop-meta">暂无总览数据。</div>;
    const pending = overviewPendingTotal(ov.scopes);
    return (
      <div className={styles.overview}>
        {mc.data.overviewError ? (
          <div className={MEMORY_CENTER_CSS.statusError}>
            <p>{mc.data.overviewError}</p>
            <button type="button" className="pill" onClick={() => mc.retryOverview()}>
              重试总览
            </button>
          </div>
        ) : null}
        <TruncatedBanner show={mc.data.overviewPayloadTruncated} label="总览 payload 已截断" />
        <TruncatedBanner show={ov.scopesTruncated} label="工作区列表已截断" />
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <div className="side-label">个人记忆</div>
            <div>
              有效 {ov.personal.validEntries} · 失效 {ov.personal.invalidEntries}
            </div>
            {ov.personal.paused ? <Mark tone="warn">已暂停写入</Mark> : null}
          </div>
          <div className={styles.statCard}>
            <div className="side-label">工作偏好</div>
            <div>{ov.personal.workPreferenceLines} 条</div>
          </div>
          <div className={styles.statCard}>
            <div className="side-label">工作区</div>
            <div>{workspaceCards.length} 个</div>
          </div>
          <div className={styles.statCard}>
            <div className="side-label">待处理</div>
            <div>{pending}</div>
          </div>
        </div>
        <div className="side-label">工作区健康</div>
        <ul className="assistant-list">
          {workspaceCards.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`assistant-item assistant-item-btn ${MEMORY_CENTER_CSS.rowBtn}`}
                onClick={() => goNav(row.id)}
              >
                <div className="assistant-item-head">
                  <ScopeHealthDot health={row.health} error={row.error} />
                  <span className="assistant-item-title">{row.label}</span>
                  {row.pendingCount ? <Mark tone="warn">待处理 {row.pendingCount}</Mark> : null}
                </div>
                <div className={styles.rowMeta}>
                  <Mark>{row.memoryCount} 条</Mark>
                  <Mark>热 {row.hot}</Mark>
                  <Mark>冷 {row.cold}</Mark>
                  <Mark>完成 {row.done}</Mark>
                  <Mark>常驻 {row.pinned}</Mark>
                  {row.missingRefs ? <Mark tone="warn">缺引用 {row.missingRefs}</Mark> : null}
                  <Mark>本轮注入 {row.injectionSelected} 条</Mark>
                  <Mark>预算 {row.tokenBudget} token</Mark>
                </div>
                {row.error ? <div className={`loop-meta ${styles.scopeError}`}>{row.error}</div> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  function renderScopeMiddle() {
    if (mc.ui.navId === "activity") {
      return (
        <MemoryCenterActivityPane
          state={mc.activity}
          scopeFilter={mc.activityScopeFilter}
          onScopeFilter={mc.setActivityScopeFilter}
          actionFilter={mc.activityActionFilter}
          onActionFilter={mc.setActivityActionFilter}
          onLoad={mc.loadActivity}
          onRestore={mc.restoreActivity}
          onOpenScope={(scopeId) => mc.dispatchUi({ type: "set_nav", navId: scopeId })}
        />
      );
    }
    if (mc.ui.navId === "suggestions") {
      return (
        <MemoryCenterSuggestionsPane
          state={mc.activity}
          onRefresh={mc.loadSuggestions}
          onAnswer={mc.answerSuggestion}
          onAcceptAllLowRisk={mc.acceptAllLowRisk}
        />
      );
    }
    if (isPlaceholderNav(mc.ui.navId)) {
      return <div className="loop-meta">记忆相关设置将集中在此，当前请使用「管理个人记忆」。</div>;
    }
    if (mc.ui.searchActive) return renderSearchMiddle();
    if (mc.data.loadingScope && currentScopeId && mc.data.activeScopeId === currentScopeId && !detailForView) {
      return <div className={MEMORY_CENTER_CSS.statusLoading}>正在加载…</div>;
    }
    if (scopeLoadError) {
      return (
        <div className={MEMORY_CENTER_CSS.statusError}>
          <p>{mc.data.scopeError}</p>
          <button
            type="button"
            className="pill"
            onClick={() => (currentScopeId ? mc.retryScope(currentScopeId) : mc.refreshCurrent())}
          >
            重试作用域
          </button>
        </div>
      );
    }
    if (!detailForView) return <div className="loop-meta">选择左侧作用域以查看条目。</div>;

    const detail = detailForView;

    if (mc.ui.navId === "personal" && state?.memory) {
      return (
        <>
          <div className="loop-meta">关于我：只读列表与核心摘要如下；完整 CRUD 在下方折叠区。</div>
          <TruncatedBanner show={mc.data.detailPayloadTruncated} label="作用域 payload 已截断" />
          <TruncatedBanner show={detail.itemsTruncated} label="条目列表已截断" />
          <ul className="assistant-list">
            {detail.items.map((item, index) => (
              <ItemRow
                key={itemKey(item, index)}
                title={item.section || "条目"}
                body={item.text}
                meta={itemMetaBadges(item)}
                selected={mc.ui.selectedKey === itemKey(item, index)}
                onSelect={() => mc.dispatchUi({ type: "select", key: itemKey(item, index) })}
              />
            ))}
          </ul>
          <MemoryCenterImportPane
            op={op}
            lastResult={lastResult}
            resultTick={resultTick}
            onNotice={onNotice}
            overviewScopes={mc.data.overview?.scopes ?? []}
          />
          <PersonalMemoryManage name={name} memory={state.memory} op={op} onNotice={onNotice} />
        </>
      );
    }

    if (mc.ui.navId === "work_preference") {
      return (
        <>
          <div className="loop-meta">工作偏好（L1）。编辑仍可通过下方「管理个人记忆」中的核心档案。</div>
          <ul className="assistant-list">
            {detail.items.map((item, index) => (
              <ItemRow
                key={itemKey(item, index)}
                title={`偏好 ${index + 1}`}
                body={item.text}
                meta={itemMetaBadges(item)}
                selected={mc.ui.selectedKey === itemKey(item, index)}
                onSelect={() => mc.dispatchUi({ type: "select", key: itemKey(item, index) })}
              />
            ))}
          </ul>
          {state?.memory ? (
            <>
              <MemoryCenterImportPane
            op={op}
            lastResult={lastResult}
            resultTick={resultTick}
            onNotice={onNotice}
            overviewScopes={mc.data.overview?.scopes ?? []}
          />
              <PersonalMemoryManage name={name} memory={state.memory} op={op} onNotice={onNotice} />
            </>
          ) : null}
        </>
      );
    }

    const tabs = (
      <div className={styles.midTabs} role="group" aria-label="工作区视图">
        {(
          [
            ["pinned", "常驻"],
            ["injection", "本轮注入"],
            ["all", "全部"],
            ["rules", "规则"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={mc.ui.middleTab === id}
            className={`pill${mc.ui.middleTab === id ? " on" : ""}`}
            onClick={() => mc.dispatchUi({ type: "set_tab", tab: id })}
          >
            {label}
          </button>
        ))}
      </div>
    );

    if (mc.ui.middleTab === "rules") {
      return (
        <>
          {tabs}
          <TruncatedBanner show={detail.rulesTruncated} label="规则列表已截断" />
          <TruncatedBanner show={detail.rulesPayloadTruncated} label="规则 payload 已截断" />
          <ul className="assistant-list">
            {detail.rules.map((rule) => (
              <ItemRow
                key={rule.relPath}
                title={rule.relPath}
                body={rule.body.slice(0, 160)}
                meta={
                  <>
                    <Mark>{rule.appliesDir}</Mark>
                    <Mark>{rule.chars} 字</Mark>
                    {rule.truncated ? <Mark tone="warn">已截断</Mark> : null}
                  </>
                }
                selected={mc.ui.selectedKey === `rule:${rule.relPath}`}
                onSelect={() => mc.dispatchUi({ type: "select", key: `rule:${rule.relPath}` })}
              />
            ))}
          </ul>
        </>
      );
    }

    const states: Array<MemoryCenterState | "all"> = ["all", "hot", "cold", "done", "pinned", "expired", "待核实"];
    const workspaceEditable = detail.scope.kind === "workspace_memory";
    return (
      <>
        {tabs}
        {workspaceEditable ? (
          <div className={MEMORY_CENTER_CSS.createEntry}>
            <MemoryCenterWorkspaceEditor
              scopeId={detail.scope.id}
              item={null}
              busy={mc.data.mutating}
              error={mc.data.mutationError}
              conflict={mc.data.mutationErrorCode === "conflict"}
              onMutate={mc.sendMutate}
              onClearSelection={() => mc.dispatchUi({ type: "select", key: null })}
              onCreated={() => mc.refreshCurrent()}
            />
          </div>
        ) : null}
        <TruncatedBanner show={detail.itemsTruncated} label="条目列表已截断" />
        <div className={styles.filters}>
          {states.map((st) => (
            <button
              key={st}
              type="button"
              className={`pill${mc.ui.stateFilter === st ? " on" : ""}`}
              aria-pressed={mc.ui.stateFilter === st}
              onClick={() => mc.dispatchUi({ type: "set_state_filter", filter: st })}
            >
              {st === "all" ? "全部状态" : STATE_LABEL[st]}
            </button>
          ))}
        </div>
        <ul className="assistant-list">
          {listItems.length ? (
            listItems.map((item, index) => (
              <ItemRow
                key={itemKey(item, index)}
                title={item.section || item.text.slice(0, 40)}
                body={item.text}
                meta={itemMetaBadges(item)}
                selected={mc.ui.selectedKey === itemKey(item, index)}
                onSelect={() => mc.dispatchUi({ type: "select", key: itemKey(item, index) })}
              />
            ))
          ) : (
            <li className="loop-meta">没有匹配的条目。</li>
          )}
        </ul>
        <DiagnosticsBlock diagnostics={diagnostics} />
      </>
    );
  }

  function renderSearchMiddle() {
    if (mc.data.loadingSearch && !mc.data.search)
      return <div className={MEMORY_CENTER_CSS.statusLoading}>正在搜索…</div>;
    if (mc.data.searchError) {
      return (
        <div className={MEMORY_CENTER_CSS.statusError}>
          <p>{mc.data.searchError}</p>
          <button type="button" className="pill" onClick={() => mc.submitSearch(mc.ui.searchInput)}>
            重试
          </button>
        </div>
      );
    }
    const hits = mc.data.search?.hits ?? [];
    return (
      <>
        <div className="loop-meta">搜索不会续期条目的 used/uses；仅浏览与定位。</div>
        <TruncatedBanner show={mc.data.search?.truncated} label="搜索结果条数已截断" />
        <TruncatedBanner show={mc.data.search?.payloadTruncated} label="搜索 payload 已截断" />
        <ul className="assistant-list">
          {hits.map((hit, index) => (
            <ItemRow
              key={itemKey(hit, index)}
              title={hit.section || hit.text.slice(0, 48)}
              body={hit.text}
              meta={
                <>
                  <Mark>{KIND_LABEL[hit.kind]}</Mark>
                  <Mark>{hit.scopeId}</Mark>
                  <Mark>{effectiveStateLabel(hit.effectiveState)}</Mark>
                  {hit.reasons.length ? (
                    <Mark tone="run">{formatMemoryCenterSearchReasons(hit.reasons)}</Mark>
                  ) : null}
                </>
              }
              selected={mc.ui.selectedKey === itemKey(hit, index)}
              onSelect={() => mc.dispatchUi({ type: "select", key: itemKey(hit, index) })}
            />
          ))}
        </ul>
        {!hits.length && !mc.data.loadingSearch ? <div className="loop-meta">没有匹配结果。</div> : null}
      </>
    );
  }

  function renderMiddle() {
    if (mc.ui.navId === "overview" && !mc.ui.searchActive) return renderOverviewMiddle();
    return renderScopeMiddle();
  }

  function renderDetail() {
    if (selectedRule) return <RuleDetail rule={selectedRule} />;
    if (selectedItem) {
      const scopeLabel =
        "scopeId" in selectedItem
          ? resolveScopeLabel(selectedItem.scopeId, overviewScopes)
          : (detailForView?.scope.label ?? resolveScopeLabel(String(mc.ui.navId), overviewScopes));
      const itemDiagnostics =
        mc.ui.searchActive || !detailForView || selectedItem.scopeId !== detailForView.scope.id ? null : diagnostics;
      const editScopeId =
        !mc.ui.searchActive && detailForView?.scope.kind === "workspace_memory" ? detailForView.scope.id : null;
      let editableItem: WorkspaceMemoryItem | null = null;
      if (editScopeId && detailForView && "revision" in selectedItem) {
        const sid = selectedItem.id;
        editableItem =
          detailForView.items.find((row) => (sid ? row.id === sid : row.text === selectedItem.text)) ?? null;
      }
      const needScopeLoad =
        mc.ui.searchActive &&
        selectedItem.kind === "workspace_memory" &&
        (!detailForView || detailForView.scope.id !== selectedItem.scopeId);
      return (
        <ItemDetail
          item={selectedItem}
          diagnostics={itemDiagnostics}
          scopeLabel={scopeLabel}
          editableItem={editableItem}
          editScopeId={editScopeId}
          mutating={mc.data.mutating}
          mutationError={mc.data.mutationError}
          mutationConflict={mc.data.mutationErrorCode === "conflict"}
          onMutate={mc.sendMutate}
          onClearSelection={() => mc.dispatchUi({ type: "select", key: null })}
          onCreated={() => mc.refreshCurrent()}
          onOpenScopeForEdit={
            needScopeLoad
              ? () => {
                  mc.clearSearch();
                  mc.dispatchUi({ type: "set_nav", navId: selectedItem.scopeId });
                  mc.sendGet(selectedItem.scopeId);
                }
              : undefined
          }
        />
      );
    }
    return <div className="loop-meta">选择一条目查看详情。</div>;
  }

  return (
    <div className={`${styles.root} ${MEMORY_CENTER_CSS.root}`}>
      <form
        className={`${styles.searchBar} ${MEMORY_CENTER_CSS.searchBar}`}
        onSubmit={(e) => {
          e.preventDefault();
          mc.submitSearch(mc.ui.searchInput);
        }}
      >
        <input
          className="side-input"
          value={mc.ui.searchInput}
          aria-label="搜索记忆"
          placeholder="搜索记忆…"
          onChange={(e) => mc.scheduleSearch(e.target.value)}
        />
        <button type="submit" className="pill">
          搜索
        </button>
        {mc.ui.searchActive ? (
          <button type="button" className="pill" onClick={() => mc.clearSearch()}>
            清空
          </button>
        ) : null}
      </form>
      <div className={styles.searchFilters}>
        <label className="loop-meta">
          作用域
          <select
            className="side-input"
            value={mc.ui.searchScopeFilter}
            onChange={(e) => mc.onSearchScopeChange(e.target.value === "all" ? "all" : e.target.value)}
          >
            <option value="all">全部</option>
            {treeRows.map((row) => (
              <option key={row.id} value={row.id}>
                {"—".repeat(row.depth)}
                {row.label}
              </option>
            ))}
            <option value="personal">关于我</option>
            <option value="work_preference">工作偏好</option>
          </select>
        </label>
        <label className="loop-meta">
          种类
          <select
            className="side-input"
            value={mc.ui.searchKindFilter}
            onChange={(e) => mc.onSearchKindChange(e.target.value as SearchableMemoryCenterKind | "all")}
          >
            <option value="all">全部</option>
            {(Object.keys(SEARCHABLE_KIND_LABEL) as SearchableMemoryCenterKind[]).map((k) => (
              <option key={k} value={k}>
                {SEARCHABLE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="loop-meta">
          状态
          <select
            className="side-input"
            value={mc.ui.searchStateFilter}
            onChange={(e) => mc.onSearchStateChange(e.target.value as typeof mc.ui.searchStateFilter)}
          >
            <option value="all">全部</option>
            {(Object.keys(STATE_LABEL) as Array<keyof typeof STATE_LABEL>).map((k) => (
              <option key={k} value={k}>
                {STATE_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className={`${styles.layout} ${MEMORY_CENTER_CSS.layout} ${layoutThree ? MEMORY_CENTER_CSS.layoutThree : MEMORY_CENTER_CSS.layoutStack}`}
      >
        {showNav ? (
          <nav className={`${styles.nav} ${MEMORY_CENTER_CSS.nav}`} aria-label="记忆中心导航">
            <h2 ref={navTitleRef} tabIndex={-1} className={`${styles.paneTitle} ${MEMORY_CENTER_FOCUS.navTitle}`}>
              范围导航
            </h2>
            <NavBtn
              id="overview"
              label="总览"
              selected={mc.ui.navId === "overview"}
              attention={0}
              onPick={goNav}
              buttonRef={mc.ui.navId === "overview" ? activeNavRef : undefined}
            />
            <NavBtn
              id="personal"
              label="关于我"
              selected={mc.ui.navId === "personal"}
              attention={0}
              onPick={goNav}
              buttonRef={mc.ui.navId === "personal" ? activeNavRef : undefined}
            />
            <NavBtn
              id="work_preference"
              label="工作偏好"
              selected={mc.ui.navId === "work_preference"}
              attention={0}
              onPick={goNav}
              buttonRef={mc.ui.navId === "work_preference" ? activeNavRef : undefined}
            />
            <div className="side-label">工作区</div>
            {treeRows.map((row) => (
              <NavBtn
                key={row.id}
                id={row.id}
                label={row.label}
                depth={row.depth}
                selected={mc.ui.navId === row.id}
                attention={row.pendingCount}
                health={row.health}
                error={row.error}
                onPick={goNav}
                buttonRef={mc.ui.navId === row.id ? activeNavRef : undefined}
              />
            ))}
            <NavBtn
              id="activity"
              label="活动"
              selected={mc.ui.navId === "activity"}
              attention={0}
              onPick={goNav}
              buttonRef={mc.ui.navId === "activity" ? activeNavRef : undefined}
            />
            <NavBtn
              id="suggestions"
              label="整理建议"
              selected={mc.ui.navId === "suggestions"}
              attention={0}
              onPick={goNav}
              buttonRef={mc.ui.navId === "suggestions" ? activeNavRef : undefined}
            />
            <NavBtn
              id="settings"
              label="设置"
              selected={mc.ui.navId === "settings"}
              attention={0}
              onPick={goNav}
              muted
              buttonRef={mc.ui.navId === "settings" ? activeNavRef : undefined}
            />
          </nav>
        ) : null}

        {showMiddle ? (
          <div className={`${styles.middle} ${MEMORY_CENTER_CSS.middle}`}>
            {!layoutThree && mc.ui.mobilePane !== "nav" ? (
              <button
                type="button"
                className={`pill ${MEMORY_CENTER_CSS.drillBack}`}
                onClick={() => mc.dispatchUi({ type: "set_mobile", pane: "nav" })}
              >
                ← 返回导航
              </button>
            ) : null}
            <h2
              ref={middleTitleRef}
              tabIndex={-1}
              className={`${styles.paneTitle} ${MEMORY_CENTER_FOCUS.middleTitle} ${mc.ui.mobilePane === "middle" && !layoutThree ? MEMORY_CENTER_FOCUS.middleFromDetail : ""}`}
            >
              {mc.ui.searchActive
                ? "搜索结果"
                : mc.ui.navId === "overview"
                  ? "总览"
                  : mc.ui.navId === "activity"
                    ? "活动"
                    : mc.ui.navId === "suggestions"
                      ? "整理建议"
                      : "条目列表"}
            </h2>
            {renderMiddle()}
          </div>
        ) : null}

        {showDetail ? (
          <aside className={`${styles.detail} ${MEMORY_CENTER_CSS.detail}`} aria-label="条目详情">
            {!layoutThree && mc.ui.mobilePane === "detail" ? (
              <button
                ref={detailBackRef}
                type="button"
                className={`pill ${MEMORY_CENTER_CSS.drillBack} ${MEMORY_CENTER_FOCUS.detailBack}`}
                onClick={() => mc.dispatchUi({ type: "set_mobile", pane: "middle" })}
              >
                ← 返回列表
              </button>
            ) : null}
            <h2 tabIndex={-1} className={styles.paneTitle}>
              条目详情
            </h2>
            {renderDetail()}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function NavBtn({
  id,
  label,
  depth = 0,
  selected,
  attention,
  health,
  error,
  muted,
  onPick,
  buttonRef,
}: {
  id: McNavId;
  label: string;
  depth?: number;
  selected: boolean;
  attention: number;
  health?: string | null;
  error?: string | null;
  muted?: boolean;
  onPick: (id: McNavId) => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-label={label}
      className={`${styles.navBtn}${selected ? ` ${styles.navBtnOn} ${MEMORY_CENTER_FOCUS.navCurrent}` : ""}${muted ? ` ${styles.navMuted}` : ""}`}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      onClick={() => onPick(id)}
    >
      <ScopeHealthDot health={health} error={error} />
      <span className={styles.navLabel}>{label}</span>
      {attention ? <span className={`chat-mark warn ${MEMORY_CENTER_CSS.badge}`}>待处理 {attention}</span> : null}
    </button>
  );
}
