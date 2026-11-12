"use client";

import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { formatBytes, previewSrc } from "../lib/preview";
import type { PreviewKind } from "@shared/protocol";

export default function MediaPreview({
  kind,
  path,
  url,
  headUrl,
  diff,
  size,
  mime,
  onReload,
}: {
  kind: PreviewKind;
  path: string;
  url?: string;
  headUrl?: string;
  diff?: boolean;
  size?: number;
  mime?: string;
  onReload?: () => void;
}) {
  const rawSrc = previewSrc(url);
  const rawHead = previewSrc(headUrl);
  const name = path.split("/").pop() || path;
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);
  const [headError, setHeadError] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    setFit(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setLoadError(false);
    setHeadError(false);
    drag.current = null;
  }, [rawSrc, rawHead]);

  const withRetry = (href?: string) => {
    if (!href) return "";
    if (!retrySeq) return href;
    return `${href}${href.includes("?") ? "&" : "?"}_retry=${retrySeq}`;
  };
  const src = withRetry(rawSrc);
  const head = withRetry(rawHead);

  const handleReload = () => {
    setLoadError(false);
    setHeadError(false);
    setRetrySeq((n) => n + 1);
    onReload?.();
  };

  if (!src) {
    return (
      <div className="tree-empty">
        没有可预览的内容
        {onReload ? (
          <>
            {" "}
            <button type="button" className="pill" onClick={handleReload}>
              重新加载
            </button>
          </>
        ) : null}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="tree-empty" role="alert">
        <span>媒体加载失败（可能是网络中断或临时访问凭证已过期）</span>
        <div style={{ marginTop: 8 }}>
          <button type="button" className="pill" onClick={handleReload}>
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div className="media-pane">
        <div className="media-meta">
          {name}
          {size != null ? ` · ${formatBytes(size)}` : ""}
        </div>
        <audio className="media-audio" controls src={src} onError={() => setLoadError(true)} />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="media-pane">
        <video
          className="media-video"
          controls
          playsInline
          preload="metadata"
          src={src}
          onError={() => setLoadError(true)}
        />
        <div className="media-meta">{name}{mime ? ` · ${mime}` : ""}{size != null ? ` · ${formatBytes(size)}` : ""}</div>
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <iframe className="pdf-frame" title={name} src={src} />
    );
  }

  if ((kind === "image" || kind === "svg") && diff) {
    return (
      <div className="media-diff">
        <figure>
          <figcaption>HEAD{head ? "" : " · 没有旧版"}</figcaption>
          {head && !headError ? (
            <img src={head} alt={`${name} HEAD`} onError={() => setHeadError(true)} />
          ) : (
            <div className="tree-empty">{headError ? "旧版图片加载失败" : "新文件"}</div>
          )}
        </figure>
        <figure>
          <figcaption>当前{size != null ? ` · ${formatBytes(size)}` : ""}</figcaption>
          <img src={src} alt={name} onError={() => setLoadError(true)} />
        </figure>
      </div>
    );
  }

  if (kind === "image" || kind === "svg") {
    const zoomAt = (next: number) => {
      const clamped = Math.max(0.1, Math.min(8, next));
      setFit(false);
      setScale(clamped);
      if (clamped === 1) setOffset({ x: 0, y: 0 });
    };
    const move = (event: PointerEvent<HTMLDivElement>) => {
      if (!drag.current) return;
      setOffset({
        x: drag.current.ox + event.clientX - drag.current.x,
        y: drag.current.oy + event.clientY - drag.current.y,
      });
    };
    const wheel = (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      zoomAt(scale * (event.deltaY > 0 ? 0.9 : 1.1));
    };
    return (
      <div className="media-pane image-inspector">
        <div className="image-tools">
          <button type="button" onClick={() => zoomAt(scale / 1.25)} aria-label="缩小">−</button>
          <span>{fit ? "适合" : `${Math.round(scale * 100)}%`}</span>
          <button type="button" onClick={() => zoomAt(scale * 1.25)} aria-label="放大">＋</button>
          <button type="button" onClick={() => {
            setFit(true);
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}>适合</button>
          <button type="button" onClick={() => zoomAt(1)}>100%</button>
        </div>
        <div
          className={`media-shot${fit ? " fit" : " actual"}${!fit && scale > 1 ? " draggable" : ""}`}
          onWheel={wheel}
          onDoubleClick={() => zoomAt(!fit && scale === 1 ? 2 : 1)}
          onPointerDown={(event) => {
            if (scale <= 1) return;
            drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={move}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <img
            src={src}
            alt={name}
            draggable={false}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            onError={() => setLoadError(true)}
          />
        </div>
        <div className="media-meta">
          {name}
          {mime ? ` · ${mime}` : ""}
          {size != null ? ` · ${formatBytes(size)}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className="tree-empty">
      <div>
        {name}
        {mime && mime !== "application/octet-stream" ? ` · ${mime}` : ""}
        {size != null ? ` · ${formatBytes(size)}` : ""}
      </div>
      <div style={{ marginTop: 6 }}>这类文件不支持在线直接预览，请下载到本地用对应软件打开。</div>
      <div style={{ marginTop: 12 }}>
        <a className="pill on" href={src} download={name}>
          下载 {name}
        </a>
      </div>
    </div>
  );
}
