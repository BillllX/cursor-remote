// 工作区全文搜索浮窗
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SearchHit } from "@shared/protocol";
import styles from "./GrepOverlay.module.css";

type GrepOverlayProps = {
  grepOpen: boolean;
  wideIDE?: boolean;
  sidePane?: "search" | "chats" | "files" | "git" | "terminal" | "loop";
  setGrepOpen: Dispatch<SetStateAction<boolean>>;
  grepTrap: RefObject<HTMLDivElement | null>;
  grepQ: string;
  setGrepQ: Dispatch<SetStateAction<string>>;
  setGrepIndex: Dispatch<SetStateAction<number>>;
  grepNameHits: string[];
  grepHits: SearchHit[];
  grepHi: number;
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
  wideIDERef?: RefObject<boolean>;
  grepWait: boolean;
  workspaceName?: string;
};

export function GrepOverlay({
  grepOpen,
  setGrepOpen,
  grepTrap,
  grepQ,
  setGrepQ,
  setGrepIndex,
  grepNameHits,
  grepHits,
  grepHi,
  openFile,
  grepWait,
  workspaceName = "工作区",
}: GrepOverlayProps) {
  const totalHits = grepNameHits.length + grepHits.length;

  return (
    <div
      className={`search-overlay workspace-modal-overlay${grepOpen ? " open" : ""}`}
      onClick={() => setGrepOpen(false)}
    >
      <div
        ref={grepTrap}
        className="search-box grep-box workspace-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="全文搜索"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">工作区搜索</span>
              {grepQ.trim() ? (
                <span className="workspace-modal-badge">{grepWait ? "搜索中…" : `${totalHits} 条结果`}</span>
              ) : null}
            </div>
            <div className="workspace-modal-sub">{workspaceName} · 搜索文件名或代码全文内容</div>
          </div>
          <div className="workspace-modal-actions">
            {grepQ ? (
              <button
                type="button"
                className="workspace-modal-btn"
                onClick={() => {
                  setGrepQ("");
                  setGrepIndex(0);
                }}
              >
                清空
              </button>
            ) : null}
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label="关闭工作区搜索"
              title="关闭 (Esc)"
              onClick={() => setGrepOpen(false)}
            >
              ×
            </button>
          </div>
        </div>

        <input
          autoFocus={grepOpen}
          className="search-input"
          placeholder="搜文件名或代码内容（↑↓ 选择，Enter 打开）"
          value={grepQ}
          onChange={(event) => {
            setGrepQ(event.target.value);
            setGrepIndex(0);
          }}
          onKeyDown={(event) => {
            // Escape 由 ChatApp 的全局捕获按层处理，避免上面还有一层时把搜索也关掉
            const total = grepNameHits.length + grepHits.length;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setGrepIndex((index) => Math.min(index + 1, Math.max(0, total - 1)));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setGrepIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Enter" && total) {
              event.preventDefault();
              if (grepHi < grepNameHits.length) {
                openFile(grepNameHits[grepHi]);
              } else {
                const hit = grepHits[grepHi - grepNameHits.length];
                if (hit) openFile(hit.path, hit.line, false);
              }
              setGrepOpen(false);
            }
          }}
        />

        <div className="search-list">
          {grepQ.trim() ? (
            !grepNameHits.length && !grepHits.length ? (
              grepWait ? (
                <div className="search-item">正在搜索…</div>
              ) : (
                <div className="search-item">文件名和内容里都没有「{grepQ.trim()}」</div>
              )
            ) : (
              <>
                {grepNameHits.length > 0 ? (
                  <div className="side-label" style={{ padding: "8px 14px 4px" }}>
                    文件名匹配 · {grepNameHits.length}
                  </div>
                ) : null}
                {grepNameHits.map((path, index) => (
                  <button
                    key={`name:${path}`}
                    type="button"
                    className={`search-item file-hit${index === grepHi ? " active" : ""}`}
                    onClick={() => {
                      openFile(path);
                      setGrepOpen(false);
                    }}
                  >
                    <span className="search-item-name">{path.split("/").pop()}</span>
                    <span className="search-item-dir">{path}</span>
                  </button>
                ))}
                {grepHits.length > 0 ? (
                  <div className="side-label" style={{ padding: "8px 14px 4px" }}>
                    文件内容匹配 · {grepHits.length}
                  </div>
                ) : null}
                {grepHits.map((hit, index) => {
                  const at = grepNameHits.length + index;
                  return (
                    <button
                      key={`${hit.path}:${hit.line}:${index}`}
                      type="button"
                      className={`search-item file-hit${at === grepHi ? " active" : ""}`}
                      onClick={() => {
                        openFile(hit.path, hit.line, false);
                        setGrepOpen(false);
                      }}
                    >
                      <span className="search-item-name">
                        {hit.path.split("/").pop()}
                        <span className={styles.line}>:{hit.line}</span>
                      </span>
                      <span className={styles.snip}>{hit.text}</span>
                      <span className="search-item-dir">
                        {hit.path.includes("/") ? hit.path.slice(0, hit.path.lastIndexOf("/")) : "."}
                      </span>
                    </button>
                  );
                })}
                {grepWait ? <div className="search-item">正在搜索内容…</div> : null}
              </>
            )
          ) : (
            <div className="search-item">输入关键字即可同时搜索工作区文件名与文件内容</div>
          )}
        </div>
      </div>
    </div>
  );
}
