// 回答正文的 Markdown 渲染：@ 引用变成可点按钮、查找高亮、代码块引用跳转
import { Children, cloneElement, isValidElement, memo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isCanvasPath } from "../../lib/canvas/path";
import { escapeRe, isFileMention, parseCite, splitCiteParts } from "../../lib/chat/mentions";
import CodeBlock from "../CodeBlock";

export function Highlight({ text, query }: { text: string; query?: string }) {
  const q = query?.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, "ig"));
  const needle = q.toLowerCase();
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle ? (
          <mark key={index} className="find-mark">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

export function CiteText({
  text,
  onOpen,
  query,
}: {
  text: string;
  onOpen: (path: string, line?: number) => void;
  query?: string;
}) {
  return (
    <>
      {splitCiteParts(text).map((part, index) =>
        part.path ? (
          <button key={index} type="button" className="cite-ref" onClick={() => onOpen(part.path!, part.line)}>
            <Highlight text={part.value} query={query} />
          </button>
        ) : (
          <Highlight key={index} text={part.value} query={query} />
        ),
      )}
    </>
  );
}

function wrapCites(children: ReactNode, onOpen: (path: string, line?: number) => void, query?: string): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return <CiteText text={child} onOpen={onOpen} query={query} />;
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    const tag = child.type;
    if (typeof tag === "string" && ["strong", "em", "b", "i", "span"].includes(tag) && child.props.children) {
      return cloneElement(child, undefined, wrapCites(child.props.children, onOpen, query));
    }
    return child;
  });
}

export const REMARK_PLUGINS = [remarkGfm];

export const MemoMarkdown = memo(Markdown);

export function markdownComponents(openFile: (path: string, line?: number) => void, findQuery?: string): Components {
  const wrap = (children: ReactNode) => wrapCites(children, openFile, findQuery);
  return {
    table({ children }) {
      return (
        <div className="md-table">
          <table>{children}</table>
        </div>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    p({ children }) {
      return <p>{wrap(children)}</p>;
    },
    li({ children }) {
      return <li>{wrap(children)}</li>;
    },
    td({ children }) {
      return <td>{wrap(children)}</td>;
    },
    a({ href, children }) {
      const raw = (href || "").trim();
      const local = raw && !/^[a-z]+:/i.test(raw) && !raw.startsWith("#") && (isCanvasPath(raw) || isFileMention(raw));
      if (local) {
        return (
          <button type="button" className="cite-ref" onClick={() => openFile(raw.replace(/^\.\//, ""))}>
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    code({ className, children }) {
      const text = String(children).replace(/\n$/, "");
      const language = (className || "").replace(/^language-/, "");
      const cite = parseCite(language);
      if (cite) {
        return (
          <div>
            <button type="button" className="cite-jump" onClick={() => openFile(cite.path, cite.line)}>
              {cite.path}:{cite.line}
            </button>
            <CodeBlock code={text} language={cite.path.split(".").pop()} highlight={cite.line} lineNumbers />
          </div>
        );
      }
      if (!language && !text.includes("\n")) {
        return <code>{text}</code>;
      }
      return <CodeBlock code={text} language={language} />;
    },
  };
}
