"use client";

import { useEffect, useRef, useState } from "react";
import type { CanvasAction } from "../lib/canvas/host";

export default function CanvasHost({
  source,
  path,
  chatId,
  onAction,
  onError,
}: {
  source: string;
  path: string;
  chatId: string;
  onAction?: (action: CanvasAction) => void;
  onError?: (message: string | null) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const loadedRef = useRef(false);
  const seqRef = useRef(0);
  const expectRef = useRef(0);
  const retriesRef = useRef(0);
  const onActionRef = useRef(onAction);
  const onErrorRef = useRef(onError);
  const payloadRef = useRef({ source, path, chatId });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [boot, setBoot] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  onActionRef.current = onAction;
  onErrorRef.current = onError;
  payloadRef.current = { source, path, chatId };

  const sendRef = useRef(() => {});
  sendRef.current = () => {
    const win = frameRef.current?.contentWindow;
    if (!win || !readyRef.current) return;
    if (!payloadRef.current.source.trim()) return;
    const seq = ++seqRef.current;
    expectRef.current = seq;
    win.postMessage({ type: "canvas:load", seq, ...payloadRef.current }, "*");
  };

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as
        | { type: string; message?: string | null; action?: CanvasAction; seq?: number }
        | undefined;
      if (!data || typeof data.type !== "string" || !data.type.startsWith("canvas:")) return;
      if (data.type === "canvas:ready") {
        readyRef.current = true;
        sendRef.current();
      }
      if (data.type === "canvas:loaded") {
        if (typeof data.seq === "number" && data.seq !== expectRef.current) return;
        loadedRef.current = true;
        retriesRef.current = 0;
        setStatus("ready");
        setErrorText(null);
        onErrorRef.current?.(null);
      }
      if (data.type === "canvas:error") onErrorRef.current?.(data.message ?? null);
      if (data.type === "canvas:action" && data.action) onActionRef.current?.(data.action);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    readyRef.current = false;
    loadedRef.current = false;
    setStatus("loading");
  }, [boot]);

  useEffect(() => {
    loadedRef.current = false;
    setStatus((prev) => (prev === "ready" ? "loading" : prev));
    setErrorText(null);
    sendRef.current();

    const retry = window.setInterval(() => {
      if (loadedRef.current) {
        window.clearInterval(retry);
        return;
      }
      sendRef.current();
    }, 250);

    const timeout = window.setTimeout(() => {
      if (loadedRef.current) return;
      if (!readyRef.current && retriesRef.current < 1) {
        retriesRef.current += 1;
        setBoot((n) => n + 1);
        return;
      }
      const text = "画布打开超时。关掉预览再点一次，或切到源码看看。";
      setStatus("error");
      setErrorText(text);
      onErrorRef.current?.(text);
    }, readyRef.current ? 8000 : 15000);

    return () => {
      window.clearInterval(retry);
      window.clearTimeout(timeout);
    };
  }, [source, path, chatId, boot]);

  const src = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/canvas-runtime`;

  return (
    <div className="canvas-host">
      {status !== "ready" ? (
        <div className="canvas-host-status">
          {status === "error" ? errorText : "正在打开画布…"}
        </div>
      ) : null}
      <iframe
        key={boot}
        ref={frameRef}
        className="canvas-frame"
        title={path}
        src={src}
        sandbox="allow-scripts allow-same-origin"
        onLoad={() => {
          const win = frameRef.current?.contentWindow;
          if (!win) return;
          try {
            if (win.location.href === "about:blank") return;
          } catch {
            // cross-origin during navigation
          }
          readyRef.current = true;
          if (!loadedRef.current) setStatus("loading");
          sendRef.current();
        }}
      />
    </div>
  );
}
