"use client";

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { compileCanvas, loadCanvasModule } from "../lib/canvas/compile";
import { CanvasRuntimeProvider, buildHostTheme, type CanvasAction } from "../lib/canvas/host";
import { useHostTheme } from "../lib/canvas/host";
import { SAMPLE_CANVAS_SOURCE } from "../lib/canvas/sample";

type LoadMessage = {
  type: "canvas:load";
  seq?: number;
  source?: string;
  path?: string;
  chatId?: string;
};

class CanvasBoundary extends Component<
  { reset: string; children: ReactNode; onError: (message: string) => void },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || String(error) };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error.message || String(error));
  }

  componentDidUpdate(prev: { reset: string }) {
    if (prev.reset !== this.props.reset && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error) return <CanvasError message={this.state.error} />;
    return this.props.children;
  }
}

function CanvasError({ message }: { message: string }) {
  const theme = useHostTheme();
  return (
    <pre
      style={{
        margin: 0,
        padding: 16,
        whiteSpace: "pre-wrap",
        color: theme.category.red,
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      {message}
    </pre>
  );
}

export default function CanvasRuntime() {
  const [source, setSource] = useState("");
  const [path, setPath] = useState("");
  const [chatId, setChatId] = useState("");
  const [seq, setSeq] = useState<number | undefined>();
  const [load, setLoad] = useState(0);
  const theme = useMemo(() => buildHostTheme("dark"), []);

  const post = useCallback((payload: Record<string, unknown>) => {
    window.parent.postMessage(payload, "*");
  }, []);

  useEffect(() => {
    let gotLoad = false;
    let applied = "";
    function onMessage(event: MessageEvent) {
      const data = event.data as LoadMessage | undefined;
      if (!data || data.type !== "canvas:load") return;
      apply(data);
    }
    function apply(data: LoadMessage) {
      const next = data.source || "";
      if (!next.trim()) return;
      gotLoad = true;
      if (typeof data.seq === "number") setSeq(data.seq);
      const identity = `${data.path || ""}\0${data.chatId || ""}\0${next}`;
      if (applied === identity) {
        post({ type: "canvas:loaded", seq: data.seq });
        return;
      }
      applied = identity;
      setSource(next);
      setPath(data.path || "");
      setChatId(data.chatId || "");
      setLoad((n) => n + 1);
    }
    const boot = (window as unknown as { __CANVAS_BOOT?: { q: LoadMessage[] } }).__CANVAS_BOOT;
    for (const item of boot?.q || []) apply(item);
    window.addEventListener("message", onMessage);
    const ping = window.setInterval(() => {
      if (gotLoad) {
        window.clearInterval(ping);
        return;
      }
      post({ type: "canvas:ready" });
    }, 120);
    post({ type: "canvas:ready" });
    if (new URLSearchParams(window.location.search).get("demo") === "1") {
      gotLoad = true;
      setSource(SAMPLE_CANVAS_SOURCE);
      setPath(".cursor-remote/canvases/repo-overview.canvas.tsx");
      setLoad((n) => n + 1);
    }
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(ping);
    };
  }, [post]);

  const compiled = useMemo(() => {
    if (!source.trim()) {
      if (!load) return { Component: null as ComponentType | null, error: null as string | null };
      return { Component: null as ComponentType | null, error: "Canvas 源码是空的" };
    }
    try {
      return { Component: loadCanvasModule(compileCanvas(source)), error: null as string | null };
    } catch (err) {
      return { Component: null as ComponentType | null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [source, load]);

  useEffect(() => {
    post({ type: "canvas:error", message: compiled.error });
    if (compiled.Component || compiled.error) post({ type: "canvas:loaded", seq });
  }, [compiled.Component, compiled.error, post, seq]);

  const dispatch = useCallback(
    (action: CanvasAction) => {
      post({ type: "canvas:action", action, path });
    },
    [path, post],
  );

  const resetKey = `${path}:${load}:${compiled.error || "ok"}`;
  const Component = compiled.Component;

  return (
    <div
      className="canvas-runtime-page"
      style={{
        height: "100%",
        overflow: "auto",
        background: theme.bg.editor,
        color: theme.text.primary,
        fontFamily: '"SF Pro Text", "Segoe UI", "PingFang SC", sans-serif',
      }}
    >
      <CanvasRuntimeProvider theme={theme} storagePrefix={`${chatId}:${path}`} dispatch={dispatch}>
        {compiled.error ? (
          <CanvasError message={compiled.error} />
        ) : Component ? (
          <CanvasBoundary reset={resetKey} onError={(message) => post({ type: "canvas:error", message })}>
            <div style={{ padding: 16 }}>
              <Component />
            </div>
          </CanvasBoundary>
        ) : (
          <div className="tree-empty" style={{ padding: 24, color: theme.text.secondary }}>
            正在打开画布…
          </div>
        )}
      </CanvasRuntimeProvider>
    </div>
  );
}
