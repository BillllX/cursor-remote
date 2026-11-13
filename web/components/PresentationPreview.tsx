"use client";

import { useEffect, useState } from "react";
import { presentationPreviewSrc } from "../lib/preview";

/** 转换文件先校验响应再嵌入，避免把转换错误当作空白 PDF 显示。 */
export default function PresentationPreview({
  src,
  name,
  onReload,
}: {
  src: string;
  name: string;
  onReload?: () => void;
}) {
  const [pdf, setPdf] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = "";
    setPdf("");
    setError("");
    void (async () => {
      try {
        const response = await fetch(presentationPreviewSrc(src), { signal: abort.signal, cache: "no-store" });
        if (!response.ok) {
          const message =
            response.status === 401 || response.status === 403
              ? "临时访问凭证已失效或没有权限，请重新加载"
              : await response.text();
          throw new Error(message || "PPT 预览失败，请重试");
        }
        if (!response.headers.get("content-type")?.includes("application/pdf")) {
          throw new Error("未能读取 PPT 预览，请重试");
        }
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPdf(objectUrl);
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "PPT 预览失败，请重试");
      }
    })();
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, attempt]);

  return (
    <div className="presentation-preview">
      <div className="media-meta presentation-tools">
        <span>{name} · PPT 预览</span>
        <a className="pill" href={src} download={name}>
          下载原文件
        </a>
      </div>
      {error ? (
        <div className="tree-empty" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="pill"
            onClick={() => {
              setAttempt((n) => n + 1);
              onReload?.();
            }}
          >
            重新加载
          </button>
        </div>
      ) : pdf ? (
        <iframe className="pdf-frame" title={`${name} 幻灯片预览`} src={pdf} />
      ) : (
        <div className="tree-empty" role="status" aria-live="polite">
          正在生成 PPT 预览，首次打开可能需要稍等片刻…
        </div>
      )}
    </div>
  );
}
