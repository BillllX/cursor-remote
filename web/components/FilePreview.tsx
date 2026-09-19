import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import CodeBlock from "./CodeBlock";
import CanvasHost from "./CanvasHost";
import HtmlPreview from "./HtmlPreview";
import MarkdownPreview from "./MarkdownPreview";
import MediaPreview from "./MediaPreview";
import { isCanvasPath } from "../lib/canvas/path";
import type { CanvasAction } from "../lib/canvas/host";
import type { MediaTicket, PreviewKind } from "../lib/protocol";
import { isLiveKind, previewSrc, tabKind } from "../lib/preview";
import {
  IconClose,
  IconCode,
  IconCollapse,
  IconDiff,
  IconLive,
  IconQuote,
} from "./chromeIcons";

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
  return (
    <div className="tree-empty">
      正在读取文件…
      {onRetry ? (
        <>
          {" "}
          <button type="button" className="pill" onClick={onRetry}>
            重试
          </button>
        </>
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
  canRevert,
  chatId,
  onCanvasAction,
  onOpenFile,
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
  canRevert?: boolean;
  chatId?: string;
  onCanvasAction?: (action: CanvasAction, path: string) => void;
  onOpenFile?: (path: string) => void;
  sheetRef?: Ref<HTMLElement | null>;
}) {
  const active = tabs.find((tab) => sameTab(tab.path, activePath)) ?? tabs[0];
  const rootRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [askSel, setAskSel] = useState<{ start: number; end: number; text: string } | null>(null);
  const [viewMode, setViewMode] = useState<"live" | "source">("live");
  const [canvasError, setCanvasError] = useState<string | null>(null);

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
    setEditing(false);
    setAskSel(null);
    setViewMode("live");
    setCanvasError(null);
  }, [activePath]);

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
  const liveable = isLiveKind(kind) && !active.diff;
  const live = liveable && viewMode === "live" && !editing;
  const canvasVisible = Boolean(live && kind === "canvas" && !active.error && active.content != null);
  const canvasKeep = canvasVisible
    ? active
    : tabs.find(
        (tab) => tabKind(tab.path, tab.kind) === "canvas" && tab.content != null && !tab.error,
      );
  const mediaKind = kind === "image" || kind === "svg" || kind === "pdf" || kind === "audio";
  const showSource = !live && !(mediaKind && kind !== "svg");
  const downloadHref = previewSrc(active.url);
  const bodyClass = [
    "file-preview-body",
    live && (kind === "canvas" || kind === "html") ? "canvas-live" : "",
    (kind === "pdf" ||
      kind === "audio" ||
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
      className="file-preview"
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
            className={`file-preview-tab${sameTab(tab.path, active.path) ? " on" : ""}${tab.diff ? " diff" : ""}${tabKind(tab.path, tab.kind) === "canvas" || isCanvasPath(tab.path) ? " canvas" : ""}`}
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
        {!live && onKeep && active.diff ? (
          <button type="button" className="pill" title="留下这些改动" onClick={() => onKeep(active.path)}>
            保留
          </button>
        ) : null}
        {!live && onRevert && canRevert ? (
          <button
            type="button"
            className="pill"
            title="把这个文件还原到 HEAD / 删掉未跟踪文件"
            onClick={() => onRevert(active.path)}
          >
            还原
          </button>
        ) : null}
        {!live && onSave && !active.diff && active.content != null ? (
          editing ? (
            <>
              <button
                type="button"
                className="pill on"
                disabled={editDraft === active.content}
                onClick={() => {
                  onSave(active.path, editDraft);
                  setEditing(false);
                }}
              >
                保存
              </button>
              <button type="button" className="pill" onClick={() => setEditing(false)}>
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="pill"
              onClick={() => {
                setEditDraft(active.content || "");
                setEditing(true);
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
          <a className="pill" href={downloadHref} download={active.path.split("/").pop()}>
            下载
          </a>
        ) : null}
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
            {canvasVisible ? null : live && kind === "canvas" ? (
          <LoadingPreview onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
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
            <LoadingPreview onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
          )
        ) : live && kind === "html" ? (
          active.content != null ? (
            <HtmlPreview path={active.path} content={active.content} chatId={chatId} media={active.media} />
          ) : (
            <LoadingPreview onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
          )
        ) : (kind === "image" || kind === "svg" || kind === "pdf" || kind === "audio") &&
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
            <LoadingPreview onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
          )
        ) : editing ? (
          <textarea
            className="file-preview-edit"
            value={editDraft}
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (onSave && editDraft !== active.content) onSave(active.path, editDraft);
                setEditing(false);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
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
          <LoadingPreview onRetry={onOpenFile ? () => onOpenFile(active.path) : undefined} />
        )}
          </>
        )}
      </div>
    </aside>
  );
}
