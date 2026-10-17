"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function colorize(code: string) {
  const slots: string[] = [];
  const hold = (html: string) => {
    const i = slots.length;
    slots.push(html);
    return `\u0000${i}\u0000`;
  };
  let out = escape(code);
  out = out.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g,
    (m) => hold(`<span class="tok-string">${m}</span>`),
  );
  out = out.replace(
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (m) => hold(`<span class="tok-comment">${m}</span>`),
  );
  out = out.replace(
    /\b(const|let|var|function|return|import|export|from|class|if|else|for|while|await|async|type|interface|new|try|catch|throw|def|and|or|not|in|True|False|None)\b/g,
    '<span class="tok-kw">$1</span>',
  );
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

export default function CodeBlock({
  code,
  language,
  highlight,
  lineNumbers,
  query,
  onLineClick,
  onSelectRange,
  diff,
  onRejectHunk,
}: {
  code: string;
  language?: string;
  highlight?: number;
  lineNumbers?: boolean;
  query?: string;
  onLineClick?: (line: number) => void;
  onSelectRange?: (start: number, end: number, text: string) => void;
  diff?: boolean;
  onRejectHunk?: (hunk: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [hunkIndex, setHunkIndex] = useState(0);
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!highlight || !bodyRef.current) return;
    const row = bodyRef.current.querySelector(`[data-line="${highlight}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [highlight, code]);

  useEffect(() => {
    setHunkIndex(0);
    setExpandedGaps(new Set());
  }, [code, diff]);

  const needle = query?.trim().toLowerCase() || "";
  const lines = lineNumbers ? code.split("\n") : null;
  const hunks = useMemo(
    () => (diff && lines ? lines.map((line, index) => (line.startsWith("@@") ? index + 1 : 0)).filter(Boolean) : []),
    [diff, lines],
  );
  const hidden = useMemo(() => {
    const result = new Map<number, { end: number; key: string }>();
    if (!diff || !lines) return result;
    const changed = lines
      .map((line, i) =>
        (/^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)) ||
        /^(?:@@|diff |index |--- |\+\+\+ )/.test(line)
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    for (let i = 0; i < changed.length - 1; i += 1) {
      const start = changed[i] + 4;
      const end = changed[i + 1] - 4;
      if (end - start >= 4) result.set(start, { end, key: `${start}-${end}` });
    }
    return result;
  }, [diff, lines]);

  function goHunk(delta: number) {
    if (!hunks.length || !bodyRef.current) return;
    const next = (hunkIndex + delta + hunks.length) % hunks.length;
    setHunkIndex(next);
    bodyRef.current.querySelector(`[data-line="${hunks[next]}"]`)?.scrollIntoView({ block: "center" });
  }

  function hunkAt(index: number) {
    if (!lines || !lines[index]?.startsWith("@@")) return "";
    const out = [lines[index]];
    for (let i = index + 1; i < lines.length; i++) {
      if (lines[i].startsWith("@@") || lines[i].startsWith("diff ")) break;
      out.push(lines[i]);
    }
    return out.join("\n");
  }

  return (
    <div className="code-block">
      <div className="code-bar">
        <span>
          {language || "code"}
          {highlight ? ` · L${highlight}` : ""}
        </span>
        <span className="code-bar-actions">
          {diff && hunks.length ? (
            <>
              <button type="button" className="copy-btn" onClick={() => goHunk(-1)}>↑ 改动</button>
              <button type="button" className="copy-btn" onClick={() => goHunk(1)}>↓ {hunkIndex + 1}/{hunks.length}</button>
            </>
          ) : null}
          <button
            type="button"
            className={`copy-btn${wrap ? " on" : ""}`}
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
          >
            折行
          </button>
        <button
          type="button"
          className="copy-btn"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
        </span>
      </div>
      {lines ? (
        <pre
          ref={bodyRef}
          className={`code-lines${wrap ? " wrap" : ""}`}
          onMouseUp={() => {
            if (!onSelectRange || !bodyRef.current) return;
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;
            if (!bodyRef.current.contains(sel.anchorNode) || !bodyRef.current.contains(sel.focusNode)) return;
            const lineOf = (node: Node | null) => {
              const el = node instanceof Element ? node : node?.parentElement;
              const n = el?.closest("[data-line]")?.getAttribute("data-line");
              return n ? Number(n) : 0;
            };
            const a = lineOf(sel.anchorNode);
            const b = lineOf(sel.focusNode);
            if (!a || !b) return;
            onSelectRange(Math.min(a, b), Math.max(a, b), sel.toString());
          }}
        >
          {lines.map((line, index) => {
            for (const [start, gap] of hidden) {
              if (index > start && index <= gap.end && !expandedGaps.has(gap.key)) return null;
            }
            const gap = hidden.get(index);
            if (gap && !expandedGaps.has(gap.key)) {
              return (
                <button
                  type="button"
                  key={`gap-${gap.key}`}
                  className="diff-gap"
                  onClick={() => setExpandedGaps((prev) => new Set(prev).add(gap.key))}
                >
                  展开 {gap.end - index + 1} 行未改动上下文
                </button>
              );
            }
            const n = index + 1;
            const hit = Boolean(needle && line.toLowerCase().includes(needle));
            const kind = diff
              ? line.startsWith("+++") || line.startsWith("---")
                ? "meta"
                : line.startsWith("+")
                  ? "add"
                  : line.startsWith("-")
                    ? "del"
                    : line.startsWith("@")
                      ? "hunk"
                      : ""
              : "";
            return (
              <div
                key={index}
                data-line={n}
                className={`code-line${highlight === n ? " on" : ""}${hit ? " hit" : ""}${onLineClick ? " click" : ""}${kind ? ` ${kind}` : ""}`}
                onClick={() => {
                  if (!onLineClick) return;
                  if (window.getSelection()?.toString()) return;
                  onLineClick(n);
                }}
              >
                <span className="ln">{n}</span>
                <code dangerouslySetInnerHTML={{ __html: diff ? escape(line) : colorize(line) }} />
                {diff && onRejectHunk && kind === "hunk" ? (
                  <button
                    type="button"
                    className="hunk-revert"
                    title="还原这一段"
                    onClick={(event) => {
                      event.stopPropagation();
                      const hunk = hunkAt(index);
                      if (hunk) onRejectHunk(hunk);
                    }}
                  >
                    还原此段
                  </button>
                ) : null}
              </div>
            );
          })}
        </pre>
      ) : (
        <pre>
          <code dangerouslySetInnerHTML={{ __html: colorize(code) }} />
        </pre>
      )}
    </div>
  );
}
