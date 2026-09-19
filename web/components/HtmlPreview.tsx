"use client";

import { useMemo } from "react";
import { mediaSrc, rewriteHtml } from "../lib/preview";
import type { MediaTicket } from "../lib/protocol";

export default function HtmlPreview({
  path,
  content,
  chatId,
  media,
}: {
  path: string;
  content: string;
  chatId?: string;
  media?: MediaTicket;
}) {
  const srcDoc = useMemo(
    () =>
      rewriteHtml(content, path, (rel) => (chatId ? mediaSrc(rel, chatId, media) : "")),
    [content, path, chatId, media],
  );

  return (
    <iframe
      className="html-frame"
      title={path}
      sandbox="allow-scripts allow-forms allow-modals"
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
    />
  );
}
