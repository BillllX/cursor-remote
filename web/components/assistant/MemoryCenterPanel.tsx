"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BuildAssistantOpMessage } from "@shared/assistantOp";
import type {
  AssistantMemoryEntry,
  AssistantResultMessage,
  AssistantState,
  ClientMessage,
  InjectionDiagnostics,
  MemoryCenterSearchHit,
  RuleFile,
  WorkspaceMemoryItem,
} from "@shared/protocol";
import styles from "./memoryCenter.module.css";
import {
  INJECTION_REASON_LABEL,
  MEMORY_CENTER_CSS,
  MEMORY_CENTER_FOCUS,
  SEARCHABLE_KIND_LABEL,
  SKIP_REASON_LABEL,
  STATE_LABEL,
  formatMemoryCenterSearchReasons,
  itemKey,
  type SearchableMemoryCenterKind,
} from "./memoryCenterLabels";
import {
  CORE_FIELD_ORDER,
  FOLDER_MENUS,
  MEMORY_DESTINATIONS,
  MORE_PAGES,
  basisLabel,
  diagnosticsSummary,
  filterFolderItems,
  firstConfirmKey,
  folderMenuLabel,
  listStatusWord,
  openingDestination,
  preferredFolderId,
  searchGroupLabel,
  searchSourceLabel,
  wasUsedLastRound,
  type FolderMenu,
  type MemoryDestination,
  type MorePage,
} from "./memoryCenterCopy";
import {
  buildScopeTreeRows,
  detailForScope,
  resolveScopeLabel,
  selectionReasonForItem,
  skipReasonForItem,
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

type Tier = "wide" | "mid" | "narrow";

function Mark({ tone, children }: { tone?: "ok" | "warn" | "danger" | "run"; children: ReactNode }) {
  return <span className={`chat-mark ${tone ?? ""} ${MEMORY_CENTER_CSS.badge}`}>{children}</span>;
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
  meta?: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        className={`assistant-item assistant-item-btn ${MEMORY_CENTER_CSS.rowBtn}${selected ? ` ${MEMORY_CENTER_CSS.rowSelected}` : ""}`}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        <div className="assistant-item-head">
          <span className="assistant-item-title">{title}</span>
        </div>
        {body ? <div className="assistant-item-body">{body}</div> : null}
        {meta ? <div className={styles.rowMeta}>{meta}</div> : null}
      </div>
    </li>
  );
}

function statusMark(item: { effectiveState: string; pinned?: boolean; missingRefs?: string[] }) {
  const word = listStatusWord(item);
  if (!word) return null;
  const tone = word === "待你确认" ? "warn" : undefined;
  return <Mark tone={tone}>{word}</Mark>;
}

function TidyControl({ busy, note, onTidy }: { busy: boolean; note: string | null; onTidy: () => void }) {
  return (
    <div className={styles.tidyBox}>
      <button type="button" className={styles.pineBtn} disabled={busy} onClick={onTidy}>
        {busy ? "正在梳理…" : "梳理一遍"}
      </button>
      <p className={styles.subline}>去掉重复，给新写的行补上今天，引用搬家了就改路径。不改你的原句。</p>
      {note ? <p className={styles.subline}>{note}</p> : null}
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
  const [tier, setTier] = useState<Tier>("wide");
  const [destination, setDestination] = useState<MemoryDestination>("me");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenu>("useful");
  const [morePage, setMorePage] = useState<MorePage | null>(null);
  const [switchingFolder, setSwitchingFolder] = useState(false);
  const [composer, setComposer] = useState<"create" | "edit" | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const scrollBeforeSearch = useRef(0);
  const autoSelectedFolder = useRef<string | null>(null);
  const rowKeys = useRef<string[]>([]);
  const [tidyBusy, setTidyBusy] = useState(false);
  const [tidyNote, setTidyNote] = useState<string | null>(null);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1200px)");
    const mid = window.matchMedia("(min-width: 960px)");
    const apply = () => setTier(wide.matches ? "wide" : mid.matches ? "mid" : "narrow");
    apply();
    wide.addEventListener("change", apply);
    mid.addEventListener("change", apply);
    return () => {
      wide.removeEventListener("change", apply);
      mid.removeEventListener("change", apply);
    };
  }, []);

  useEffect(() => {
    if (!lastResult || lastResult.op !== "memory_tidy") return;
    setTidyBusy(false);
    if (!lastResult.ok) {
      setTidyNote(lastResult.error || "梳理没完成");
      return;
    }
    setTidyNote(lastResult.data?.note || "梳理完了。");
    mc.refreshCurrent();
  }, [lastResult, resultTick]);

  useEffect(() => {
    if (!active) return;
    const opened = openingDestination(initialScopeId);
    setDestination(opened.destination);
    setFolderId(opened.folderId);
    setMorePage(null);
    setComposer(null);
    setSwitchingFolder(false);
    autoSelectedFolder.current = null;
    mc.loadSuggestions();
  }, [active, initialScopeId, openRequest]);

  useEffect(() => {
    if (!active || !mc.data.overview) return;
    setFolderId((current) => preferredFolderId(mc.data.overview?.scopes ?? [], current));
  }, [active, mc.data.overview]);

  const navForDestination = (): McNavId => {
    if (destination === "me") return "work_preference";
    if (destination === "folder") return folderId || "overview";
    if (destination === "review") return "suggestions";
    if (morePage === "activity") return "activity";
    if ((morePage === "diagnostics" || morePage === "rules") && folderId) return folderId;
    return "overview";
  };

  useEffect(() => {
    if (!active || mc.ui.searchActive) return;
    const nav = navForDestination();
    if (mc.ui.navId !== nav) mc.dispatchUi({ type: "set_nav", navId: nav });
  }, [active, destination, folderId, morePage, mc.ui.searchActive, mc.ui.navId]);

  const scopes = mc.data.overview?.scopes ?? [];
  const folders = useMemo(() => {
    const tree = buildScopeTreeRows(scopes);
    if (tree.length) return tree;
    return scopes
      .filter((scope) => scope.id !== "personal" && scope.id !== "work_preference")
      .map((scope) => ({ ...scope, depth: 0 }));
  }, [scopes]);
  const folder = folders.find((row) => row.id === folderId) ?? null;
  const folderDetail = detailForScope(mc.data.detail, folderId ?? undefined);
  const prefDetail = detailForScope(mc.data.detail, "work_preference");
  const memory = state?.memory ?? null;

  const folderItems = useMemo(() => {
    if (!folderDetail) return [];
    return filterFolderItems(folderDetail.items, folderMenu);
  }, [folderDetail, folderMenu]);

  useEffect(() => {
    if (destination !== "folder" || !folderId || !folderDetail || composer) return;
    if (autoSelectedFolder.current === folderId) return;
    autoSelectedFolder.current = folderId;
    const key = firstConfirmKey(folderDetail.items, itemKey);
    if (key) mc.dispatchUi({ type: "select", key });
  }, [destination, folderId, folderDetail, composer]);

  const reviewCount = mc.activity.suggestions?.entries.length ?? 0;

  function pickDestination(next: MemoryDestination) {
    mc.clearSearch();
    setComposer(null);
    setMorePage(null);
    setDestination(next);
  }

  function pickFolder(id: string) {
    setFolderId(id);
    setSwitchingFolder(false);
    setComposer(null);
    autoSelectedFolder.current = null;
    setDestination("folder");
  }

  function openDetail() {
    if (tier !== "wide") mc.dispatchUi({ type: "set_mobile", pane: "detail" });
  }

  function selectRow(key: string) {
    setComposer(null);
    mc.dispatchUi({ type: "select", key });
  }

  const searching = mc.ui.searchActive;
  const wantsDetail = Boolean(mc.ui.selectedKey) || composer != null;
  const showNav = tier !== "narrow";
  const showMiddle = tier !== "narrow" || mc.ui.mobilePane !== "detail";
  const showDetail = tier === "wide" || (tier === "mid" && wantsDetail) || (tier === "narrow" && mc.ui.mobilePane === "detail" && wantsDetail);

  const visibleKeys = useMemo(() => {
    if (searching && mc.data.search) return mc.data.search.hits.map((hit, index) => itemKey(hit, index));
    if (destination === "folder") return folderItems.map((item, index) => itemKey(item, index));
    if (destination === "me" && memory) {
      const fields = CORE_FIELD_ORDER.map((field) => `core:${field}`);
      const entries = memory.entries.filter((entry) => !entry.invalidAt).map((entry) => `entry:${entry.id}`);
      return [...fields, ...entries];
    }
    if (destination === "more" && !morePage) return MORE_PAGES.map((page) => `more:${page.id}`);
    return [];
  }, [searching, mc.data.search, destination, folderItems, memory, morePage]);
  rowKeys.current = visibleKeys;

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable),
      );
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !typing) {
        const keys = rowKeys.current;
        if (!keys.length) return;
        event.preventDefault();
        const current = mc.ui.selectedKey;
        const index = Math.max(0, keys.indexOf(current ?? ""));
        const next = keys[Math.min(keys.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))] ?? keys[0];
        if (next?.startsWith("more:")) {
          setMorePage(next.slice(5) as MorePage);
          return;
        }
        selectRow(next);
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        rootRef.current?.querySelector<HTMLButtonElement>("[data-mc-save]")?.click();
        return;
      }
      if (event.key === "Escape") {
        if (composer) {
          event.preventDefault();
          setComposer(null);
          return;
        }
        if (destination === "me" && mc.ui.selectedKey) {
          event.preventDefault();
          mc.dispatchUi({ type: "select", key: null });
          return;
        }
        if (mc.ui.searchActive) {
          event.preventDefault();
          mc.clearSearch();
          return;
        }
        if (tier !== "wide" && mc.ui.mobilePane === "detail") {
          event.preventDefault();
          mc.dispatchUi({ type: "set_mobile", pane: "middle" });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, composer, destination, mc.ui.searchActive, mc.ui.selectedKey, mc.ui.mobilePane, tier]);

  useEffect(() => {
    if (!searching) return;
    scrollBeforeSearch.current = middleRef.current?.scrollTop ?? 0;
    return () => {
      const top = scrollBeforeSearch.current;
      requestAnimationFrame(() => {
        if (middleRef.current) middleRef.current.scrollTop = top;
      });
    };
  }, [searching]);

  function renderSearch() {
    if (mc.data.loadingSearch && !mc.data.search) return <div className={MEMORY_CENTER_CSS.statusLoading}>正在找…</div>;
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
    if (!hits.length && !mc.data.loadingSearch) {
      return (
        <div>
          <div className={styles.paneTitle}>没找到</div>
          <p className={styles.subline}>换个词，或到筛选里放宽。</p>
        </div>
      );
    }
    const groups = new Map<string, MemoryCenterSearchHit[]>();
    for (const hit of hits) {
      const label = searchGroupLabel(hit.kind, resolveScopeLabel(hit.scopeId, scopes));
      const list = groups.get(label) ?? [];
      list.push(hit);
      groups.set(label, list);
    }
    return (
      <>
        {[...groups.entries()].map(([label, rows]) => (
          <div key={label}>
            <div className="side-label">{label}</div>
            <ul className="assistant-list">
              {rows.map((hit) => {
                const index = hits.indexOf(hit);
                const key = itemKey(hit, index);
                return (
                  <ItemRow
                    key={key}
                    title={`${searchSourceLabel(hit.kind, resolveScopeLabel(hit.scopeId, scopes))} · ${hit.section || hit.text.slice(0, 32)}`}
                    body={hit.text}
                    meta={statusMark(hit)}
                    selected={mc.ui.selectedKey === key}
                    onSelect={() => selectRow(key)}
                  />
                );
              })}
            </ul>
          </div>
        ))}
      </>
    );
  }

  function renderMe() {
    if (!memory) return <div className={MEMORY_CENTER_CSS.statusLoading}>正在加载记忆…</div>;
    const paused = memory.settings.paused
      ? "记忆已暂停"
      : "关于我和工作偏好每次都会带上。标了「不在这一轮」的句子还在，也能搜到。";
    const entries = memory.entries.filter((entry) => !entry.invalidAt);
    return (
      <>
        <div className={styles.headRow}>
          <h2 className={styles.paneTitle}>记得的我</h2>
          {composer || mc.ui.selectedKey?.startsWith("core:") || mc.ui.selectedKey?.startsWith("entry:") ? null : (
            <button type="button" className={styles.pineBtn} onClick={() => { setComposer("create"); openDetail(); }}>
              记一条
            </button>
          )}
        </div>
        <p className={styles.subline}>
          {name ? `${name} · ` : ""}
          {paused}
        </p>
        <ul className="assistant-list">
          {CORE_FIELD_ORDER.map((field) => {
            const value = memory.core.fields[field]?.trim() ?? "";
            return (
              <ItemRow
                key={field}
                title={field}
                body={value || "还没写"}
                selected={mc.ui.selectedKey === `core:${field}`}
                onSelect={() => selectRow(`core:${field}`)}
              />
            );
          })}
          {entries.map((entry) => (
            <ItemRow
              key={entry.id}
              title={entry.topic || "一条记忆"}
              body={entry.text}
              meta={
                <>
                  {basisLabel(entry.basis) ? <Mark>{basisLabel(entry.basis)}</Mark> : null}
                  {entry.resident === false ? <Mark>不在这一轮</Mark> : null}
                  <button
                    type="button"
                    className="pill"
                    onClick={(event) => {
                      event.stopPropagation();
                      selectRow(`entry:${entry.id}`);
                      setComposer("edit");
                    }}
                  >
                    改
                  </button>
                  <button
                    type="button"
                    className="pill"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (window.confirm(`删掉「${entry.topic || "这条记忆"}」？`)) op("memory_purge", { id: entry.id });
                    }}
                  >
                    删
                  </button>
                </>
              }
              selected={mc.ui.selectedKey === `entry:${entry.id}`}
              onSelect={() => selectRow(`entry:${entry.id}`)}
            />
          ))}
        </ul>
        {prefDetail?.items.length ? (
          <>
            <div className="side-label">工作偏好里的原话</div>
            <ul className="assistant-list">
              {prefDetail.items.map((item, index) => (
                <ItemRow
                  key={itemKey(item, index)}
                  title={item.text.slice(0, 42)}
                  body=""
                  meta={<span className={styles.subline}>只读</span>}
                  selected={mc.ui.selectedKey === itemKey(item, index)}
                  onSelect={() => selectRow(itemKey(item, index))}
                />
              ))}
            </ul>
          </>
        ) : null}
      </>
    );
  }

  function renderFolder() {
    const title = folder?.label || "这个文件夹";
    const items = folderDetail?.items ?? [];
    const emptyFile = items.length === 0 && !mc.data.loadingScope && !mc.data.scopeError;
    return (
      <>
        <div className={styles.headRow}>
          <h2 className={styles.paneTitle}>{emptyFile ? "这个文件夹还没有记忆" : title}</h2>
          <button type="button" className={styles.folderMenu} onClick={() => setSwitchingFolder((open) => !open)}>
            换文件夹
          </button>
        </div>
        {switchingFolder ? (
          <ul className="assistant-list">
            {folders.map((row) => (
              <ItemRow
                key={row.id}
                title={"　".repeat(row.depth) + row.label}
                body=""
                selected={row.id === folderId}
                onSelect={() => pickFolder(row.id)}
              />
            ))}
          </ul>
        ) : null}
        <div className={styles.headRow}>
          <p className={styles.subline}>
            {emptyFile ? "记一条，下次在这个文件夹里就会记得。" : `${folderMenuLabel(folderMenu)} ${folderItems.length} 条`}
          </p>
          <select
            className={styles.folderMenu}
            aria-label="列表范围"
            value={folderMenu}
            onChange={(event) => setFolderMenu(event.target.value as FolderMenu)}
          >
            {FOLDER_MENUS.map((menu) => (
              <option key={menu.id} value={menu.id}>
                {menu.label}
              </option>
            ))}
          </select>
          {composer || !folderId ? null : (
            <button type="button" className={styles.pineBtn} onClick={() => { setComposer("create"); openDetail(); }}>
              记一条
            </button>
          )}
        </div>
        {mc.data.scopeError && mc.data.activeScopeId === folderId ? (
          <div className={MEMORY_CENTER_CSS.statusError}>
            <p>{mc.data.scopeError}</p>
            <button type="button" className="pill" onClick={() => folderId && mc.retryScope(folderId)}>
              重试
            </button>
          </div>
        ) : null}
        {mc.data.loadingScope && !folderDetail ? <div className={MEMORY_CENTER_CSS.statusLoading}>正在加载…</div> : null}
        {!folder && !mc.data.loadingOverview ? <p className={styles.subline}>先打开一个文件夹。</p> : null}
        <ul className="assistant-list">
          {folderItems.map((item, index) => (
            <ItemRow
              key={itemKey(item, index)}
              title={item.section || item.text.slice(0, 32)}
              body={item.text}
              meta={statusMark(item)}
              selected={mc.ui.selectedKey === itemKey(item, index)}
              onSelect={() => selectRow(itemKey(item, index))}
            />
          ))}
        </ul>
        {!emptyFile && folderDetail && !folderItems.length ? <p className={styles.subline}>这个筛选里没有。换一个，或看全部。</p> : null}
      </>
    );
  }

  function renderMore() {
    if (!morePage) {
      return (
        <>
          <h2 className={styles.paneTitle}>更多</h2>
          <ul className="assistant-list">
            {MORE_PAGES.map((page) => (
              <ItemRow key={page.id} title={page.label} body="" selected={false} onSelect={() => setMorePage(page.id)} />
            ))}
          </ul>
        </>
      );
    }
    return (
      <>
        <button type="button" className={`pill ${styles.drillBack}`} onClick={() => setMorePage(null)}>
          返回
        </button>
        <h2 className={styles.paneTitle}>{MORE_PAGES.find((page) => page.id === morePage)?.label}</h2>
        {morePage === "activity" ? (
          <MemoryCenterActivityPane
            state={mc.activity}
            scopeFilter={mc.activityScopeFilter}
            onScopeFilter={mc.setActivityScopeFilter}
            actionFilter={mc.activityActionFilter}
            onActionFilter={mc.setActivityActionFilter}
            onLoad={mc.loadActivity}
            onRestore={mc.restoreActivity}
            onOpenScope={(scopeId) => {
              if (scopeId === "personal" || scopeId === "work_preference") {
                setDestination("me");
                selectRow(scopeId === "work_preference" ? "core:工作偏好" : "core:关于我");
                return;
              }
              pickFolder(scopeId);
            }}
          />
        ) : null}
        {morePage === "transfer" ? (
          <MemoryCenterImportPane
            op={op}
            lastResult={lastResult}
            resultTick={resultTick}
            onNotice={onNotice}
            overviewScopes={scopes}
          />
        ) : null}
        {morePage === "diagnostics" ? (
          <div>
            {diagnosticsSummary(folderDetail?.diagnostics ?? null).map((line) => (
              <p key={line} className="loop-meta">
                {line}
              </p>
            ))}
          </div>
        ) : null}
        {morePage === "rules" ? (
          <ul className="assistant-list">
            {(folderDetail?.rules ?? []).map((rule) => (
              <ItemRow
                key={rule.relPath}
                title={rule.relPath}
                body={rule.body.slice(0, 120)}
                selected={mc.ui.selectedKey === `rule:${rule.relPath}`}
                onSelect={() => selectRow(`rule:${rule.relPath}`)}
              />
            ))}
            {!folderDetail?.rules.length ? <li className={styles.subline}>这个文件夹没有规则。</li> : null}
          </ul>
        ) : null}
      </>
    );
  }

  function renderMiddle() {
    if (searching) return renderSearch();
    if (destination === "me") return renderMe();
    if (destination === "folder") return renderFolder();
    if (destination === "review") {
      return (
        <>
          <h2 className={styles.paneTitle}>要你看一眼</h2>
          <p className={styles.subline}>{reviewCount ? `${reviewCount} 条待看` : "都处理完了"}</p>
          <p className={styles.subline}>重复、日期和搬家后的文件，用「梳理一遍」处理。这里的卡片可以不点。</p>
          <MemoryCenterSuggestionsPane
            state={mc.activity}
            onRefresh={mc.loadSuggestions}
            onAnswer={mc.answerSuggestion}
            onAcceptAllLowRisk={mc.acceptAllLowRisk}
          />
        </>
      );
    }
    return renderMore();
  }

  function renderDetail() {
    if (searching && mc.ui.selectedKey && mc.data.search) {
      const hit = mc.data.search.hits.find((row, index) => itemKey(row, index) === mc.ui.selectedKey);
      if (hit) return <HitDetail hit={hit} scopeLabel={resolveScopeLabel(hit.scopeId, scopes)} />;
    }
    if (destination === "me") return renderMeDetail();
    if (destination === "more" && morePage === "rules" && mc.ui.selectedKey?.startsWith("rule:")) {
      const rel = mc.ui.selectedKey.slice(5);
      const rule = folderDetail?.rules.find((row) => row.relPath === rel);
      if (rule) return <RuleDetail rule={rule} />;
    }
    if (composer === "create" && destination === "folder" && folderId) {
      return (
        <MemoryCenterWorkspaceEditor
          scopeId={folderId}
          item={null}
          mode="create"
          busy={mc.data.mutating}
          error={mc.data.mutationError}
          conflict={mc.data.mutationErrorCode === "conflict"}
          onMutate={mc.sendMutate}
          onClearSelection={() => setComposer(null)}
          onCreated={() => {
            setComposer(null);
            mc.refreshCurrent();
          }}
          onCancel={() => setComposer(null)}
        />
      );
    }
    const item = folderItems.find((row, index) => itemKey(row, index) === mc.ui.selectedKey)
      ?? folderDetail?.items.find((row, index) => itemKey(row, index) === mc.ui.selectedKey);
    if (item && folderId && folderDetail) {
      if (composer === "edit") {
        return (
          <MemoryCenterWorkspaceEditor
            scopeId={folderId}
            item={item}
            mode="edit"
            busy={mc.data.mutating}
            error={mc.data.mutationError}
            conflict={mc.data.mutationErrorCode === "conflict"}
            onMutate={mc.sendMutate}
            onClearSelection={() => {
              setComposer(null);
              mc.dispatchUi({ type: "select", key: null });
            }}
            onCreated={() => mc.refreshCurrent()}
            onCancel={() => setComposer(null)}
          />
        );
      }
      return (
        <FolderReadDetail
          item={item}
          diagnostics={folderDetail.diagnostics}
          onEdit={() => setComposer("edit")}
        />
      );
    }
    return <p className={styles.subline}>选一条来看，或记一条新的。</p>;
  }

  function renderMeDetail() {
    if (!memory) return <p className={styles.subline}>正在加载记忆…</p>;
    const key = mc.ui.selectedKey;
    if (composer === "create") {
      return <PersonalCreate op={op} onDone={() => setComposer(null)} onNotice={onNotice} />;
    }
    if (key?.startsWith("core:")) {
      return <CoreFieldEditor field={key.slice(5)} memory={memory} op={op} />;
    }
    if (key?.startsWith("entry:")) {
      const entry = memory.entries.find((row) => row.id === key.slice(6));
      if (!entry) return <p className={styles.subline}>这条已经不在了。</p>;
      if (composer === "edit") return <PersonalEditor entry={entry} op={op} onDone={() => setComposer(null)} />;
      return (
        <div className={styles.detailBody}>
          <div className="assistant-item-body">{entry.text}</div>
          {basisLabel(entry.basis) ? <p className={styles.subline}>{basisLabel(entry.basis)}</p> : null}
          <button type="button" className="pill" onClick={() => setComposer("edit")}>
            改
          </button>
        </div>
      );
    }
    const pref = prefDetail?.items.find((row, index) => itemKey(row, index) === key);
    if (pref) {
      return (
        <div className={styles.detailBody}>
          <div className="assistant-item-body">{pref.text}</div>
          <p className={styles.subline}>这条是工作偏好里的原话，改动写在「工作偏好」那一栏。</p>
          <button type="button" className={styles.clayText} onClick={() => selectRow("core:工作偏好")}>
            去改档案
          </button>
        </div>
      );
    }
    const about = memory.core.fields["关于我"]?.trim();
    return <p className={styles.subline}>{about || "点一栏就能改。"}</p>;
  }

  const layoutClass = tier === "wide" ? styles.layoutThree : tier === "mid" ? styles.layoutMid : styles.layoutStack;

  return (
    <div ref={rootRef} className={`${styles.root} ${MEMORY_CENTER_CSS.root}`}>
      <form
        className={`${styles.searchBar} ${MEMORY_CENTER_CSS.searchBar}`}
        onSubmit={(event) => {
          event.preventDefault();
          mc.submitSearch(mc.ui.searchInput);
        }}
      >
        <input
          ref={searchRef}
          className="side-input"
          value={mc.ui.searchInput}
          aria-label="搜索记忆"
          placeholder="搜索记忆"
          onChange={(event) => mc.scheduleSearch(event.target.value)}
        />
        {searching ? (
          <button type="button" className="pill" onClick={() => mc.clearSearch()}>
            取消
          </button>
        ) : null}
      </form>
      {searching ? (
        <div>
          <button type="button" className="pill" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
            筛选
          </button>
          {filtersOpen ? (
            <div className={styles.searchFilters}>
              <label className="loop-meta">
                范围
                <select className="side-input" value={mc.ui.searchScopeFilter} onChange={(event) => mc.onSearchScopeChange(event.target.value)}>
                  <option value="all">全部</option>
                  <option value="personal">我</option>
                  <option value="work_preference">偏好</option>
                  {folders.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-meta">
                种类
                <select
                  className="side-input"
                  value={mc.ui.searchKindFilter}
                  onChange={(event) => mc.onSearchKindChange(event.target.value as SearchableMemoryCenterKind | "all")}
                >
                  <option value="all">全部</option>
                  {(Object.keys(SEARCHABLE_KIND_LABEL) as SearchableMemoryCenterKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {SEARCHABLE_KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="loop-meta">
                状态
                <select
                  className="side-input"
                  value={mc.ui.searchStateFilter}
                  onChange={(event) => mc.onSearchStateChange(event.target.value as typeof mc.ui.searchStateFilter)}
                >
                  <option value="all">全部</option>
                  {(Object.keys(STATE_LABEL) as Array<keyof typeof STATE_LABEL>).map((key) => (
                    <option key={key} value={key}>
                      {STATE_LABEL[key]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {tier === "narrow" && !searching ? (
        <>
        <TidyControl busy={tidyBusy} note={tidyNote} onTidy={() => { setTidyBusy(true); setTidyNote(null); op("memory_tidy"); }} />
        <div className={styles.destTabs} role="tablist" aria-label="记忆">
          {MEMORY_DESTINATIONS.map((dest) => (
            <button
              key={dest.id}
              type="button"
              role="tab"
              aria-selected={destination === dest.id}
              className={`${styles.destTab}${destination === dest.id ? ` ${styles.destTabOn}` : ""}`}
              onClick={() => pickDestination(dest.id)}
            >
              {dest.label}
              {dest.id === "review" && reviewCount ? <span className={styles.clayCount}> {reviewCount}</span> : null}
            </button>
          ))}
        </div>
        </>
      ) : null}

      <div className={`${styles.layout} ${MEMORY_CENTER_CSS.layout} ${layoutClass}`}>
        {showNav ? (
          <nav className={`${styles.nav} ${MEMORY_CENTER_CSS.nav}`} aria-label="记忆">
            <h2 className={`${styles.paneTitle} ${MEMORY_CENTER_FOCUS.navTitle}`}>记忆</h2>
            {MEMORY_DESTINATIONS.map((dest) => (
              <button
                key={dest.id}
                type="button"
                aria-current={destination === dest.id ? "page" : undefined}
                className={`${styles.navBtn}${destination === dest.id ? ` ${styles.navBtnOn} ${MEMORY_CENTER_FOCUS.navCurrent}` : ""}`}
                onClick={() => pickDestination(dest.id)}
              >
                <span className={styles.navLabel}>
                  {dest.label}
                  {dest.id === "folder" && folder ? <span className={styles.subline}> {folder.label}</span> : null}
                </span>
                {dest.id === "review" && reviewCount ? <span className={styles.clayCount}>{reviewCount}</span> : null}
              </button>
            ))}
            <TidyControl busy={tidyBusy} note={tidyNote} onTidy={() => { setTidyBusy(true); setTidyNote(null); op("memory_tidy"); }} />
          </nav>
        ) : null}

        {showMiddle ? (
          <div ref={middleRef} className={`${styles.middle} ${MEMORY_CENTER_CSS.middle}`}>
            {tier === "narrow" && mc.ui.mobilePane === "detail" ? null : renderMiddle()}
          </div>
        ) : null}

        {showDetail ? (
          <aside
            className={`${styles.detail} ${MEMORY_CENTER_CSS.detail}${tier === "mid" ? ` ${styles.detailCover}` : ""}`}
            aria-label="详情"
          >
            {tier !== "wide" ? (
              <button
                type="button"
                className={`pill ${MEMORY_CENTER_CSS.drillBack} ${MEMORY_CENTER_FOCUS.detailBack}`}
                onClick={() => {
                  setComposer(null);
                  mc.dispatchUi({ type: "set_mobile", pane: "middle" });
                }}
              >
                返回
              </button>
            ) : null}
            {renderDetail()}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function FolderReadDetail({
  item,
  diagnostics,
  onEdit,
}: {
  item: WorkspaceMemoryItem;
  diagnostics: InjectionDiagnostics | null;
  onEdit: () => void;
}) {
  const reason = selectionReasonForItem(item.id, diagnostics);
  const skip = skipReasonForItem(item.id, diagnostics);
  const word = listStatusWord(item);
  return (
    <div className={styles.detailBody}>
      {item.section ? <div className="side-label">{item.section}</div> : null}
      <div className="assistant-item-body">{item.text}</div>
      {word ? <p className={styles.subline}>{word}</p> : null}
      {wasUsedLastRound(item.id, diagnostics) ? <p className={styles.subline}>上一轮用到了</p> : null}
      {reason || skip ? (
        <div>
          <div className="side-label">上一轮为什么用到</div>
          {reason ? <p className="loop-meta">{INJECTION_REASON_LABEL[reason] ?? reason}</p> : null}
          {skip ? <p className="loop-meta">{SKIP_REASON_LABEL[skip as keyof typeof SKIP_REASON_LABEL] ?? skip}</p> : null}
        </div>
      ) : null}
      {item.refs.length ? <p className="loop-meta">引用的文件：{item.refs.join("、")}</p> : null}
      {item.missingRefs.length ? <p className={styles.clayText}>这些文件不在了：{item.missingRefs.join("、")}</p> : null}
      <button type="button" className="pill" onClick={onEdit}>
        改
      </button>
    </div>
  );
}

function HitDetail({ hit, scopeLabel }: { hit: MemoryCenterSearchHit; scopeLabel: string }) {
  return (
    <div className={styles.detailBody}>
      <div className="side-label">{searchSourceLabel(hit.kind, scopeLabel)}</div>
      <div className="assistant-item-body">{hit.text}</div>
      {hit.reasons.length ? <p className="loop-meta">{formatMemoryCenterSearchReasons(hit.reasons)}</p> : null}
    </div>
  );
}

function RuleDetail({ rule }: { rule: RuleFile }) {
  return (
    <div className={styles.detailBody}>
      <div className="side-label">{rule.relPath}</div>
      <pre className="assistant-pre">{rule.body}</pre>
    </div>
  );
}

function CoreFieldEditor({
  field,
  memory,
  op,
}: {
  field: string;
  memory: NonNullable<AssistantState["memory"]>;
  op: BuildAssistantOpMessage;
}) {
  const original = memory.core.fields[field] ?? "";
  const [draft, setDraft] = useState(original);
  useEffect(() => setDraft(original), [field, original, memory.core.rev]);
  const dirty = draft !== original;
  return (
    <form
      className={styles.detailBody}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) return;
        op("memory_core", { fields: { [field]: draft }, rev: memory.core.rev });
      }}
    >
      <div className="side-label">{field}</div>
      <textarea className="loop-goal" rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className={styles.pineBtn} data-mc-save disabled={!dirty}>
        保存
      </button>
    </form>
  );
}

function PersonalCreate({
  op,
  onDone,
  onNotice,
}: {
  op: BuildAssistantOpMessage;
  onDone: () => void;
  onNotice: (text: string) => void;
}) {
  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  return (
    <form
      className={styles.detailBody}
      onSubmit={(event) => {
        event.preventDefault();
        const body = text.trim();
        if (!body) return;
        op("memory_save", { topic: topic.trim() || body.slice(0, 12), text: body });
        onNotice("已记下。");
        onDone();
      }}
    >
      <div className="side-label">记一条</div>
      <input className="side-input" value={topic} placeholder="主题，可以空着" onChange={(event) => setTopic(event.target.value)} />
      <textarea className="loop-goal" rows={5} value={text} placeholder="要记住的话" onChange={(event) => setText(event.target.value)} />
      <button type="submit" className={styles.pineBtn} data-mc-save disabled={!text.trim()}>
        保存
      </button>
      <button type="button" className="pill" onClick={onDone}>
        取消
      </button>
    </form>
  );
}

function PersonalEditor({
  entry,
  op,
  onDone,
}: {
  entry: AssistantMemoryEntry;
  op: BuildAssistantOpMessage;
  onDone: () => void;
}) {
  const [topic, setTopic] = useState(entry.topic);
  const [text, setText] = useState(entry.text);
  const dirty = topic !== entry.topic || text !== entry.text;
  return (
    <form
      className={styles.detailBody}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || !text.trim()) return;
        op("memory_edit", { id: entry.id, rev: entry.rev, topic: topic.trim() || text.trim().slice(0, 12), text: text.trim() });
        onDone();
      }}
    >
      <input className="side-input" value={topic} onChange={(event) => setTopic(event.target.value)} />
      <textarea className="loop-goal" rows={5} value={text} onChange={(event) => setText(event.target.value)} />
      <button type="submit" className={styles.pineBtn} data-mc-save disabled={!dirty || !text.trim()}>
        保存
      </button>
      <button type="button" className="pill" onClick={onDone}>
        取消
      </button>
    </form>
  );
}
