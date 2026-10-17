"use client";

import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "./CodeBlock";
import { mediaSrc, resolveAssetPath } from "../lib/preview";
import {
  markdownHeadingIdsByLine,
  markdownHeadings,
  slugHeading,
  splitFrontMatter,
  splitMarkdownDiff,
} from "../lib/previewFormats";
import type { MediaTicket } from "@shared/protocol";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function Mermaid({ source }: { source: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(280);
  const srcDoc = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;color-scheme:light dark}#m{display:flex;justify-content:center;min-height:40px}.error{font:13px system-ui;color:#c44;white-space:pre-wrap}</style><div id="m"></div><script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:matchMedia("(prefers-color-scheme:dark)").matches?"dark":"default"});try{const {svg}=await mermaid.render("diagram",${JSON.stringify(source).replace(/</g, "\\u003c")});document.querySelector("#m").innerHTML=svg;parent.postMessage({type:"markdown:mermaid-height",height:document.documentElement.scrollHeight},"*")}catch(e){document.querySelector("#m").className="error";document.querySelector("#m").textContent=String(e)}</script>`;
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow || event.data?.type !== "markdown:mermaid-height") return;
      const next = Number(event.data.height);
      if (Number.isFinite(next)) setHeight(Math.max(80, Math.min(4000, next + 8)));
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return (
    <iframe
      ref={frameRef}
      className="mermaid-frame"
      title="Mermaid 图表"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}

function TaskCheckbox({ checked = false }: { checked?: boolean }) {
  const [value, setValue] = useState(checked);
  useEffect(() => setValue(checked), [checked]);
  return <input type="checkbox" checked={value} onChange={(event) => setValue(event.currentTarget.checked)} />;
}

export default function MarkdownPreview({
  path,
  content,
  chatId,
  media,
  onOpen,
}: {
  path: string;
  content: string;
  chatId?: string;
  media?: MediaTicket;
  onOpen?: (path: string) => void;
}) {
  const parsed = useMemo(() => splitFrontMatter(content), [content]);
  const headings = useMemo(() => markdownHeadings(parsed.body), [parsed.body]);
  const headingIds = useMemo(() => markdownHeadingIdsByLine(parsed.body), [parsed.body]);
  const components = useMemo<Components>(() => {
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
      function Heading({
        children,
        node,
      }: {
        children?: ReactNode;
        node?: { position?: { start?: { line?: number } } };
      }) {
        const id = headingIds.get(node?.position?.start?.line || 0) || slugHeading(textOf(children));
        return (
          <Tag id={id} className="md-heading">
            <a className="md-anchor" href={`#${id}`} aria-label="链接到此标题">
              #
            </a>
            {children}
          </Tag>
        );
      };
    return {
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      h5: heading("h5"),
      h6: heading("h6"),
      img({ src, alt }) {
        const raw = typeof src === "string" ? src : "";
        const resolved = resolveAssetPath(path, raw);
        const href =
          /^https?:\/\//i.test(raw) || raw.startsWith("data:")
            ? raw
            : resolved && chatId
              ? mediaSrc(resolved, chatId, media)
              : "";
        if (!href) return <span>{alt || raw}</span>;
        return <img src={href} alt={alt || ""} />;
      },
      a({ href, children }) {
        const raw = (href || "").trim();
        const sameFileLine = /^#L(\d+)(?:-L?\d+)?$/i.exec(raw);
        if (sameFileLine && onOpen) {
          return (
            <button type="button" className="cite-ref" onClick={() => onOpen(`${path}#L${sameFileLine[1]}`)}>
              {children}
            </button>
          );
        }
        const [filePart, hash = ""] = raw.split("#", 2);
        const local = resolveAssetPath(path, filePart);
        if (local && onOpen && !/^[a-z]+:/i.test(raw)) {
          const line = /^L(\d+)(?:-L?\d+)?$/i.exec(hash)?.[1];
          return (
            <button type="button" className="cite-ref" onClick={() => onOpen(line ? `${local}#L${line}` : local)}>
              {children}
            </button>
          );
        }
        if (raw.startsWith("#")) return <a href={raw}>{children}</a>;
        if (!raw || /^javascript:/i.test(raw)) return <span>{children}</span>;
        return (
          <a href={raw} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      pre({ children }) {
        return <>{children}</>;
      },
      code({ className, children }) {
        const text = String(children).replace(/\n$/, "");
        const language = (className || "").replace(/^language-/, "");
        if (language.toLowerCase() === "mermaid") return <Mermaid source={text} />;
        if (!language && !text.includes("\n")) return <code>{text}</code>;
        return <CodeBlock code={text} language={language} />;
      },
      input({ type, checked }) {
        return type === "checkbox" ? <TaskCheckbox checked={checked} /> : <input type={type} />;
      },
      blockquote({ children }) {
        const raw = textOf(children).trim();
        const hit = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(raw);
        if (!hit) return <blockquote>{children}</blockquote>;
        const kind = hit[1].toLowerCase();
        return (
          <aside className={`md-callout ${kind}`}>
            <strong>{hit[1]}</strong>
            <div>
              {Children.map(children, (child, index) =>
                index === 0 && isValidElement<{ children?: ReactNode }>(child)
                  ? { ...child, props: { ...child.props, children: textOf(child.props.children).replace(hit[0], "") } }
                  : child,
              )}
            </div>
          </aside>
        );
      },
      table({ children }) {
        return (
          <div className="md-table">
            <table>{children}</table>
          </div>
        );
      },
    };
  }, [path, headingIds, chatId, media, onOpen]);

  return (
    <div className="markdown preview-md">
      {parsed.frontMatter.length ? (
        <details className="front-matter">
          <summary>Front matter</summary>
          <dl>
            {parsed.frontMatter.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      {headings.length > 1 ? (
        <nav className="md-toc" aria-label="目录">
          <details open>
            <summary>目录</summary>
            {headings.map((heading) => (
              <a key={heading.id} href={`#${heading.id}`} style={{ paddingLeft: `${(heading.depth - 1) * 12}px` }}>
                {heading.text}
              </a>
            ))}
          </details>
        </nav>
      ) : null}
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {parsed.body}
      </Markdown>
    </div>
  );
}

export function MarkdownDiffPreview(
  props: Omit<Parameters<typeof MarkdownPreview>[0], "content"> & { content: string },
) {
  const parts = useMemo(() => splitMarkdownDiff(props.content), [props.content]);
  return (
    <div className="markdown-diff-preview">
      <section>
        <header>修改前</header>
        <MarkdownPreview {...props} content={parts.before} />
      </section>
      <section>
        <header>修改后</header>
        <MarkdownPreview {...props} content={parts.after} />
      </section>
    </div>
  );
}
