import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import CodeBlock from "./CodeBlock";
import CanvasHost from "./CanvasHost";
import HtmlPreview from "./HtmlPreview";
import MarkdownPreview, { MarkdownDiffPreview } from "./MarkdownPreview";
import MediaPreview from "./MediaPreview";
import DataPreview from "./DataPreview";
import { isCanvasPath } from "../lib/canvas/path";
import { canvasFrameHtml, exportCanvasFrame } from "../lib/canvas/exportHtml";
import type { CanvasAction } from "../lib/canvas/host";
import type { CanvasVersion, MediaTicket, PreviewKind } from "@shared/protocol";
import { isLiveKind, previewSrc, tabKind } from "../lib/preview";
import {
  IconClose,
  IconCode,
  IconCollapse,
  IconDiff,
  IconExitFullscreen,
  IconExport,
  IconFullscreen,
  IconLive,
  IconQuote,
} from "./chromeIcons";

export const PREVIEW_SAVE_LIMIT = 500_000;

export type PreviewTab = {
  path: string;
  content?: string;
  error?: string;
  line?: number;
  diff?: boolean;
  kind?: PreviewKind | "file";
  mime?: string;
  size?: number;
  url?: string;
  headUrl?: string;
  media?: MediaTicket;
  pinned?: boolean;
  sha?: string;
  sourceChatId?: string;
};

function diffRowToFileLine(diff: string, row: number): number | undefined {
  const lines = diff.split("\n");
  const index = row - 1;
  if (index < 0 || index >= lines.length) return undefined;
  let newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]) - 1;
      if (i === index) return undefined;
      continue;
    }
    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("\\") ||
      line === "new file"
    ) {
      if (i === index) return undefined;
      continue;
    }
    if (line.startsWith("-")) {
      if (i === index) return undefined;
      continue;
    }
    newLine += 1;
    if (i === index) return newLine;
  }
  return undefined;
}

function sameTab(a: string, b: string) {
  const n = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  return n(a) === n(b);
}

function LoadingPreview({ onRetry }: { onRetry?: () => void }) {
  // 刚开始读不用急着给重试；读了几秒还没出来再显示
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 4000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="skeleton file-skeleton" role="status" aria-live="polite">
      <span className="sr-only">正在读取文件…</span>
      <div className="skel-block">
        {["38%", "82%", "66%", "74%", "48%", "78%", "56%"].map((width, index) => (
          <div key={index} className="skel-line" style={{ width }} />
        ))}
      </div>
      {onRetry && slow ? (
        <button type="button" className="pill" onClick={onRetry}>
          读取较慢，重试
        </button>
      ) : null}
    </div>
  );
}

function liveLabel(kind: PreviewKind) {
  if (kind === "canvas") return "Canvas";
  if (kind === "markdown") return "Markdown";
  if (kind === "html") return "HTML";
  if (kind === "svg") return "SVG";
  return "预览";
}

export default function FilePreview({
  tabs,
  activePath,
  onSelect,
  onCloseTab,
  onCloseAll,
  expanded,
  onToggleExpand,
  onCite,
  onAskRange,
  onToggleDiff,
  onRevert,
  onKeep,
  onRejectHunk,
  onSave,
  drafts,
  onDraft,
  canRevert,
  chatId,
  onCanvasAction,
  onOpenFile,
  onPinTab,
  onComposerInsert,
  canvasVersions,
  onCanvasVersions,
  onCanvasSaveVersion,
  onCanvasPublish,
  onCanvasRestore,
  sheetRef,
}: {
  tabs: PreviewTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseAll: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onCite: (path: string, line?: number) => void;
  onAskRange?: (path: string, start: number, end: number, text: string) => void;
  onToggleDiff?: (path: string, diff: boolean) => void;
  onRevert?: (path: string) => void;
  onKeep?: (path: string) => void;
  onRejectHunk?: (path: string, hunk: string) => void;
  onSave?: (path: string, content: string) => void;
  drafts?: Record<string, string>;
  onDraft?: (path: string, value: string | null) => void;
  canRevert?: boolean;
  chatId?: string;
  onCanvasAction?: (action: CanvasAction, path: string) => void;
  onOpenFile?: (path: string) => void;
  onPinTab?: (path: string) => void;
  onComposerInsert?: (text: string) => void;
  canvasVersions?: CanvasVersion[];
  onCanvasVersions?: (path: string) => void;
  onCanvasSaveVersion?: (path: string, sourceSha: string | undefined, html: string) => void;
  onCanvasPublish?: (path: string, sha: string) => void;
  onCanvasRestore?: (path: string, sha: string) => void;
  sheetRef?: Ref<HTMLElement | null>;
}) {
  const active = tabs.find((tab) => sameTab(tab.path, activePath)) ?? tabs[0];
  const rootRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [editingLocal, setEditingLocal] = useState(false);
  const [editDraftLocal, setEditDraftLocal] = useState("");
  const externalDrafts = Boolean(onDraft);
  const editing = externalDrafts
    ? Object.prototype.hasOwnProperty.call(drafts || {}, active?.path || "")
    : editingLocal;
  const editDraft = externalDrafts
    ? active && drafts
      ? (drafts[active.path] ?? "")
      : ""
    : editDraftLocal;
  const [askSel, setAskSel] = useState<{ start: number; end: number; text: string } | null>(null);
  const [viewMode, setViewMode] = useState<"live" | "source">("live");
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [full, setFull] = useState(false);
  const nativeFullRef = useRef(false);

  const hits = useMemo(() => {
    if (!query.trim() || !active?.content) return [];
    const needle = query.trim().toLowerCase();
    return active.content
      .split("\n")
      .map((line, index) => (line.toLowerCase().includes(needle) ? index + 1 : 0))
      .filter(Boolean);
  }, [query, active?.content]);

  useEffect(() => {
    setQuery("");
    setHit(0);
    setAskSel(null);
    setViewMode("live");
    setCanvasError(null);
    setVersionsOpen(false);
    if (!onDraft) {
      setEditingLocal(false);
      setEditDraftLocal("");
    }
  }, [activePath, onDraft]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      const root = rootRef.current;
      const target = event.target as Node | null;
      const focused = document.activeElement;
      const inside =
        Boolean(root) &&
        ((target && root!.contains(target)) || (focused && root!.contains(focused)));
      if (!inside) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 全屏：优先用浏览器原生全屏（iframe 不会重载）；不支持时（如 iPhone Safari）退回铺满视口的样式全屏
  const exitFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (root && document.fullscreenElement === root) {
      void document.exitFullscreen().catch(() => {});
    }
    nativeFullRef.current = false;
    setFull(false);
  }, []);

  const enterFullscreen = useCallback(() => {
    setFull(true);
    const root = rootRef.current;
    if (!root || typeof root.requestFullscreen !== "function") return;
    root
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => {
        nativeFullRef.current = true;
      })
      .catch(() => {
        // 被拒绝就保留样式全屏
      });
  }, []);

  useEffect(() => {
    function onChange() {
      // 用户按 Esc 退出原生全屏时，同步状态
      if (!document.fullscreenElement && nativeFullRef.current) {
        nativeFullRef.current = false;
        setFull(false);
      }
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (nativeFullRef.current && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    if (!full) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 编辑框里的 Esc 是「取消编辑」，不抢
      if ((event.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
      exitFullscreen();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, exitFullscreen]);

  const focusLine = hits.length ? hits[hit % hits.length] : active?.diff ? undefined : active?.line;
  const citeLine =
    active?.diff && active.content && hits.length && focusLine
      ? diffRowToFileLine(active.content, focusLine)
      : active?.diff
        ? undefined
        : focusLine;

  useEffect(() => {
    if (!focusLine || !bodyRef.current) return;
    const row = bodyRef.current.querySelector(`[data-line="${focusLine}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [focusLine, active?.content, active?.path]);

  if (!active) return null;
  const language = active.path.split(".").pop() || "";
  const kind = tabKind(active.path, active.kind);
  const dataKind = !active.diff && /\.(csv|json|ipynb)$/i.test(active.path);
  const liveable = (isLiveKind(kind) || dataKind) && !active.diff;
  const live = liveable && viewMode === "live" && !editing;
  const canvasVisible = Boolean(live && kind === "canvas" && !active.error && active.content != null);
  const canvasKeep = canvasVisible
    ? active
    : tabs.find(
        (tab) => tabKind(tab.path, tab.kind) === "canvas" && tab.content != null && !tab.error,
      );
  const mediaKind = kind === "image" || kind === "svg" || kind === "pdf" || kind === "audio" || kind === "video";
  const showSource = !live && !(mediaKind && kind !== "svg");
  const savedText = active.content ?? "";
  const draftDirty = editing && editDraft !== savedText;
  const oversized =
    !active.diff &&
    (kind === "text" || kind === "markdown") &&
    savedText.length > PREVIEW_SAVE_LIMIT &&
    !draftDirty;
  const downloadHref = previewSrc(active.url);
  const bodyClass = [
    "file-preview-body",
    live && (kind === "canvas" || kind === "html") ? "canvas-live" : "",
    (kind === "pdf" ||
      kind === "audio" ||
      kind === "video" ||
      kind === "image" ||
      (kind === "svg" && (live || Boolean(active.diff)))) &&
    !editing
      ? "media-live"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  function step(delta: number) {
    if (!hits.length) return;
    setHit((index) => (index + delta + hits.length) % hits.length);
  }

  return (
    <aside
      className={`file-preview${full ? " is-fullscreen" : ""}`}
      ref={(node) => {
        rootRef.current = node;
        if (typeof sheetRef === "function") sheetRef(node);
        else if (sheetRef) sheetRef.current = node;
      }}
    >
      <div className="file-preview-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`file-preview-tab${sameTab(tab.path, active.path) ? " on" : ""}${tab.diff ? " diff" : ""}${tab.pinned ? " pinned" : " preview"}${tabKind(tab.path, tab.kind) === "canvas" || isCanvasPath(tab.path) ? " canvas" : ""}${drafts && Object.prototype.hasOwnProperty.call(drafts, tab.path) && drafts[tab.path] !== (tab.content ?? "") ? " dirty" : ""}`}
            onDoubleClick={() => onPinTab?.(tab.path)}
          >
            <button
              type="button"
              className="file-preview-tab-name"
              title={tab.path}
              onClick={() => onSelect(tab.path)}
            >
              {tab.path.split("/").pop()}
            </button>
            <button
              type="button"
              className="file-preview-x"
              aria-label={`关闭 ${tab.path.split("/").pop()}`}
              onClick={() => onCloseTab(tab.path)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="file-preview-bar">
        <span className="file-preview-path" title={active.path}>
          {active.path}
          {liveable
            ? viewMode === "live"
              ? ` · ${liveLabel(kind)}`
              : " · 源码"
            : active.diff
              ? " · 改动"
              : kind !== "text"
                ? ` · ${kind}`
                : ""}
          {(active.diff ? citeLine : focusLine) ? `:${active.diff ? citeLine : focusLine}` : ""}
          {active.sha ? " · 历史快照" : ""}
        </span>
        {liveable ? (
          <button
            type="button"
            className={`pill${viewMode === "live" ? " on" : ""}`}
            title={viewMode === "live" ? "源码" : "活视图"}
            onClick={() => setViewMode(viewMode === "live" ? "source" : "live")}
          >
            {viewMode === "live" ? <IconCode /> : <IconLive />}
            <span className="pill-label">{viewMode === "live" ? "源码" : "活视图"}</span>
          </button>
        ) : onToggleDiff && (kind === "text" || kind === "image" || kind === "svg" || kind === "markdown" || kind === "html") ? (
          <button
            type="button"
            className={`pill${active.diff ? " on" : ""}`}
            title={active.diff ? "原文" : "改动"}
            onClick={() => onToggleDiff(active.path, !active.diff)}
          >
            <IconDiff />
            <span className="pill-label">{active.diff ? "原文" : "改动"}</span>
          </button>
        ) : null}
        {!active.sha && !live && onKeep && active.diff ? (
          <button type="button" className="pill pill-text" title="留下这些改动" onClick={() => onKeep(active.path)}>
            保留
          </button>
        ) : null}
        {!active.sha && !live && onRevert && canRevert ? (
          <button
            type="button"
            className="pill pill-text"
            title="把这个文件还原到 HEAD / 删掉未跟踪文件"
            onClick={() => onRevert(active.path)}
          >
            还原
          </button>
        ) : null}
        {oversized ? (
          <span className="preview-save-state dirty">超过 500KB，这里只能看，不能保存</span>
        ) : null}
        {!active.sha && !live && onSave && !active.diff && active.content != null && !oversized ? (
          editing ? (
            <>
              <span className={`preview-save-state${draftDirty ? " dirty" : ""}`}>
                {draftDirty ? "未保存" : "已保存"}
              </span>
              <button
                type="button"
                className="pill pill-text on"
                disabled={editDraft === (active.content ?? "")}
                onClick={() => onSave?.(active.path, editDraft)}
              >
                保存
              </button>
              <button
                type="button"
                className="pill pill-text"
                onClick={() => {
                  if (
                    editDraft !== (active.content ?? "") &&
                    !window.confirm(`放弃 ${active.path.split("/").pop()} 里未保存的修改？`)
                  ) {
                    return;
                  }
                  if (onDraft) onDraft(active.path, null);
                  else setEditingLocal(false);
                }}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="pill pill-text"
              onClick={() => {
                const next = active.content || "";
                if (onDraft) onDraft(active.path, next);
                else {
                  setEditDraftLocal(next);
                  setEditingLocal(true);
                }
                onPinTab?.(active.path);
              }}
            >
              编辑
            </button>
          )
        ) : null}
        {editing || live || (mediaKind && !active.diff && kind !== "svg") ? null : (
          <>
            <input
              ref={searchRef}
              className="preview-search"
              placeholder="在文件中找"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHit(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") {
                  setQuery("");
                  setHit(0);
                }
              }}
            />
            {query.trim() ? (
              <span className="preview-hits">
                {hits.length ? `${(hit % hits.length) + 1}/${hits.length}` : "无"}
              </span>
            ) : null}
          </>
        )}
        {canvasError && live && kind === "canvas" ? (
          <span className="preview-hits" title={canvasError}>
            出错
          </span>
        ) : null}
        {downloadHref ? (
          <a className="pill pill-text" href={downloadHref} download={active.path.split("/").pop()}>
            下载
          </a>
        ) : null}
        {canvasVisible && !canvasError ? (
          <button
            type="button"
            className="pill"
            title="导出 HTML"
            onClick={() => {
              const frame = bodyRef.current?.querySelector<HTMLIFrameElement>(
                ".canvas-host-keep:not(.is-idle) iframe.canvas-frame",
              );
              if (!exportCanvasFrame(frame ?? null, active.path)) {
                window.alert("画布还没渲染完，请稍等一下再导出。");
              }
            }}
          >
            <IconExport />
            <span className="pill-label">导出 HTML</span>
          </button>
        ) : null}
        {canvasVisible && onCanvasSaveVersion ? (
          <button type="button" className="pill pill-text" onClick={() => {
            const frame = bodyRef.current?.querySelector<HTMLIFrameElement>(".canvas-host-keep:not(.is-idle) iframe.canvas-frame");
            const html = canvasFrameHtml(frame ?? null, active.path);
            if (html) onCanvasSaveVersion(active.path, active.sha, html);
          }}>存版本</button>
        ) : null}
        {canvasVisible && onCanvasVersions ? (
          <button
            type="button"
            className={`pill pill-text${versionsOpen ? " on" : ""}`}
            aria-pressed={versionsOpen}
            onClick={() => {
              const next = !versionsOpen;
              setVersionsOpen(next);
              if (next) onCanvasVersions(active.path);
            }}
          >
            版本
          </button>
        ) : null}
        <button
          type="button"
          className={`pill preview-fullscreen${full ? " on" : ""}`}
          title={full ? "退出全屏" : "全屏预览"}
          aria-pressed={full}
          onClick={full ? exitFullscreen : enterFullscreen}
        >
          {full ? <IconExitFullscreen /> : <IconFullscreen />}
          <span className="pill-label">{full ? "退出全屏" : "全屏"}</span>
        </button>
        {onToggleExpand ? (
          <button type="button" className={`pill preview-expand${expanded ? " on" : ""}`} title="收起" onClick={onToggleExpand}>
            <IconCollapse />
            <span className="pill-label">收起</span>
          </button>
        ) : null}
        <button type="button" className="pill" title="引用" onClick={() => onCite(active.path, citeLine)}>
          <IconQuote />
          <span className="pill-label">引用</span>
        </button>
        <button type="button" className="pill" title="关闭" onClick={onCloseAll}>
          <IconClose />
          <span className="pill-label">关闭</span>
        </button>
      </div>
      <div className={bodyClass} ref={bodyRef}>
        {active.error ? (
          <div className="tree-empty">
            {active.error}
            {downloadHref ? (
              <>
                {" "}
                <a href={downloadHref} download={active.path.split("/").pop()}>
                  下载
                </a>
              </>
            ) : null}
          </div>
        ) : (
          <>
            {canvasKeep ? (
              <div className={`canvas-host-keep${canvasVisible ? "" : " is-idle"}`}>
                <CanvasHost
                  source={canvasVisible ? active.content || "" : canvasKeep.content || ""}
                  path={canvasVisible ? active.path : canvasKeep.path}
                  chatId={chatId || ""}
                  onAction={(action) =>
                    onCanvasAction?.(action, canvasVisible ? active.path : canvasKeep.path)
                  }
                  onError={setCanvasError}
                />
              </div>
            ) : null}
            {canvasVisible && versionsOpen && canvasVersions?.length ? (
              <details className="canvas-versions" open>
                <summary>版本历史 · {canvasVersions.length}</summary>
                {canvasVersions.map((version) => (
                  <div key={version.sha}>
                    <span>{new Date(version.createdAt).toLocaleString()} · {version.sha.slice(0, 8)}</span>
                    {version.shareUrl ? <a href={version.shareUrl} target="_blank" rel="noreferrer">打开分享</a> : onCanvasPublish ? <button type="button" onClick={() => onCanvasPublish(active.path, version.sha)}>分享</button> : null}
                    {onCanvasRestore ? <button type="button" onClick={() => onCanvasRestore(active.path, version.sha)}>恢复</button> : null}
                  </div>
                ))}
              </details>
            ) : null}
            {canvasVisible ? null : live && kind === "canvas" ? (
          <LoadingPreview key={active.path} onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
        ) : live && kind === "markdown" ? (
          active.content != null ? (
            <MarkdownPreview
              path={active.path}
              content={active.content}
              chatId={chatId}
              media={active.media}
              onOpen={onOpenFile}
            />
          ) : (
            <LoadingPreview key={active.path} onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
          )
        ) : active.diff && kind === "markdown" && active.content != null ? (
          <MarkdownDiffPreview path={active.path} content={active.content} chatId={chatId} media={active.media} onOpen={onOpenFile} />
        ) : live && kind === "html" ? (
          active.content != null ? (
            <HtmlPreview path={active.path} content={active.content} chatId={chatId} media={active.media} onElementSelect={onComposerInsert} />
          ) : (
            <LoadingPreview key={active.path} onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
          )
        ) : (kind === "image" || kind === "svg" || kind === "pdf" || kind === "audio" || kind === "video") &&
          (kind !== "svg" || live || active.diff) &&
          !editing ? (
          active.url ? (
            <MediaPreview
              kind={kind}
              path={active.path}
              url={active.url}
              headUrl={active.headUrl}
              diff={active.diff}
              size={active.size}
              mime={active.mime}
            />
          ) : (
            <LoadingPreview key={active.path} onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
          )
        ) : editing ? (
          <textarea
            className="file-preview-edit"
            value={editDraft}
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => {
              if (onDraft && active) onDraft(active.path, event.target.value);
              else setEditDraftLocal(event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (onSave && editDraft !== (active.content ?? "")) onSave(active.path, editDraft);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                if (
                  editDraft !== (active.content ?? "") &&
                  !window.confirm(`放弃 ${active.path.split("/").pop()} 里未保存的修改？`)
                ) {
                  return;
                }
                if (onDraft && active) onDraft(active.path, null);
                else setEditingLocal(false);
              }
            }}
          />
        ) : active.content != null && dataKind && live ? (
          <DataPreview path={active.path} content={active.content} />
        ) : active.content != null && showSource ? (
          <>
            <CodeBlock
              code={active.content}
              language={active.diff ? "diff" : language}
              highlight={focusLine}
              lineNumbers
              query={query.trim()}
              diff={active.diff}
              onRejectHunk={
                active.diff && onRejectHunk
                  ? (hunk) => onRejectHunk(active.path, hunk)
                  : undefined
              }
              onSelectRange={
                !active.diff && !editing && onAskRange
                  ? (start, end, text) => setAskSel({ start, end, text })
                  : undefined
              }
              onLineClick={(row) =>
                onCite(
                  active.path,
                  active.diff ? diffRowToFileLine(active.content || "", row) : row,
                )
              }
            />
            {askSel && onAskRange && !active.diff ? (
              <div className="preview-ask">
                <span>
                  {askSel.start === askSel.end
                    ? `L${askSel.start}`
                    : `L${askSel.start}–${askSel.end}`}
                </span>
                <button
                  type="button"
                  className="pill on"
                  onClick={() => {
                    onAskRange(active.path, askSel.start, askSel.end, askSel.text);
                    setAskSel(null);
                    window.getSelection()?.removeAllRanges();
                  }}
                >
                  提问
                </button>
                <button type="button" className="pill" onClick={() => setAskSel(null)}>
                  取消
                </button>
              </div>
            ) : null}
          </>
        ) : active.url && mediaKind ? (
          <MediaPreview
            kind={kind === "svg" ? "svg" : kind}
            path={active.path}
            url={active.url}
            headUrl={active.headUrl}
            diff={active.diff}
            size={active.size}
            mime={active.mime}
          />
        ) : (
          <LoadingPreview key={active.path} onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
        )}
          </>
        )}
      </div>
    </aside>
  );
}
