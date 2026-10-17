"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { mediaSrc, rewriteHtml } from "../lib/preview";
import type { MediaTicket } from "@shared/protocol";

export default function HtmlPreview({
  path,
  content,
  chatId,
  media,
  onElementSelect,
}: {
  path: string;
  content: string;
  chatId?: string;
  media?: MediaTicket;
  onElementSelect?: (text: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const srcDoc = useMemo(() => {
    const bridge = `<script>(()=>{const send=(type,data={})=>parent.postMessage({type,...data},"*");const show=x=>{if(typeof x==="string")return x;try{return JSON.stringify(x)}catch{return String(x)}};const old=console.error;console.error=(...a)=>{send("html:console-error",{message:a.map(show).join(" ")});old.apply(console,a)};addEventListener("error",e=>send("html:console-error",{message:e.message||"Script error"}));addEventListener("unhandledrejection",e=>send("html:console-error",{message:"Unhandled promise rejection: "+show(e.reason)}));let pick=false;addEventListener("message",e=>{if(e.source===parent&&e.data?.type==="html:pick")pick=!!e.data.on});addEventListener("click",e=>{if(!pick)return;e.preventDefault();e.stopPropagation();const raw=e.target;const el=raw instanceof Element?raw:raw?.parentElement;if(!el)return;const tag=(el.tagName||"element").toLowerCase();const classes=el.classList?[...el.classList].map(x=>CSS.escape(x)).join("."):"";const selector=el.id?"#"+CSS.escape(el.id):tag+(classes?"."+classes:"");send("html:element",{selector,text:(el.textContent||el.getAttribute("aria-label")||"").trim().slice(0,300)});pick=false},true)})()</script>`;
    const html = rewriteHtml(content, path, (rel) => (chatId ? mediaSrc(rel, chatId, media) : ""));
    const bodyAt = html.toLowerCase().lastIndexOf("</body>");
    return bodyAt >= 0 ? `${html.slice(0, bodyAt)}${bridge}${html.slice(bodyAt)}` : `${html}${bridge}`;
  }, [content, path, chatId, media]);
  useEffect(() => {
    setErrors([]);
    setPicking(false);
  }, [srcDoc]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; message?: string; selector?: string; text?: string };
      if (data.type === "html:console-error" && data.message) setErrors((prev) => [...prev.slice(-19), data.message!]);
      if (data.type === "html:element" && data.selector) {
        setPicking(false);
        onElementSelect?.(`关于 HTML 元素 ${data.selector}${data.text ? `（${data.text}）` : ""}：`);
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onElementSelect]);

  return (
    <div className="html-preview">
      <div className="html-preview-tools">
        <button type="button" className={picking ? "on" : ""} aria-pressed={picking} onClick={() => {
          const on = !picking;
          setPicking(on);
          frameRef.current?.contentWindow?.postMessage({ type: "html:pick", on }, "*");
        }}>点选元素</button>
        {errors.length ? (
          <details>
            <summary>Console · {errors.length}</summary>
            <pre>{errors.join("\n")}</pre>
            <button
              type="button"
              onClick={() => onElementSelect?.(`请修复 ${path} 的预览错误：\n${errors.join("\n")}`)}
            >
              发给 Agent
            </button>
          </details>
        ) : <span>Console 无错误</span>}
      </div>
      <iframe
        ref={frameRef}
        className="html-frame"
        title={path}
        sandbox="allow-scripts allow-forms allow-modals"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
