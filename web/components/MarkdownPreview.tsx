"use client";

import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "./CodeBlock";
import { mediaSrc, resolveAssetPath } from "../lib/preview";
import type { MediaTicket } from "../lib/protocol";

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
  const components = useMemo<Components>(
    () => ({
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
        const local = resolveAssetPath(path, raw);
        if (local && onOpen && !/^[a-z]+:/i.test(raw)) {
          return (
            <button type="button" className="cite-ref" onClick={() => onOpen(local)}>
              {children}
            </button>
          );
        }
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
        if (!language && !text.includes("\n")) return <code>{text}</code>;
        return <CodeBlock code={text} language={language} />;
      },
      table({ children }) {
        return (
          <div className="md-table">
            <table>{children}</table>
          </div>
        );
      },
    }),
    [path, chatId, media, onOpen],
  );

  return (
    <div className="markdown preview-md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
