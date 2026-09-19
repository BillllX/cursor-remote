"use client";

import { useState } from "react";
import { formatBytes, previewSrc } from "../lib/preview";
import type { PreviewKind } from "../lib/protocol";

export default function MediaPreview({
  kind,
  path,
  url,
  headUrl,
  diff,
  size,
  mime,
}: {
  kind: PreviewKind;
  path: string;
  url?: string;
  headUrl?: string;
  diff?: boolean;
  size?: number;
  mime?: string;
}) {
  const src = previewSrc(url);
  const head = previewSrc(headUrl);
  const name = path.split("/").pop() || path;
  const [zoom, setZoom] = useState(false);

  if (!src) {
    return <div className="tree-empty">没有可预览的内容</div>;
  }

  if (kind === "audio") {
    return (
      <div className="media-pane">
        <div className="media-meta">
          {name}
          {size != null ? ` · ${formatBytes(size)}` : ""}
        </div>
        <audio className="media-audio" controls src={src} />
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
          {head ? <img src={head} alt={`${name} HEAD`} /> : <div className="tree-empty">新文件</div>}
        </figure>
        <figure>
          <figcaption>当前{size != null ? ` · ${formatBytes(size)}` : ""}</figcaption>
          <img src={src} alt={name} />
        </figure>
      </div>
    );
  }

  if (kind === "image" || kind === "svg") {
    return (
      <div className={`media-pane${zoom ? " zoom" : ""}`}>
        <button type="button" className="media-shot" onClick={() => setZoom((on) => !on)} title="点击缩放">
          <img src={src} alt={name} />
        </button>
        <div className="media-meta">
          {name}
          {mime ? ` · ${mime}` : ""}
          {size != null ? ` · ${formatBytes(size)}` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className="tree-empty">这类文件还不能预览，请下载查看。</div>
  );
}
