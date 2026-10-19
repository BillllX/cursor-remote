// 全文搜索弹层
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SearchHit } from "@shared/protocol";
import styles from "./GrepOverlay.module.css";

type GrepOverlayProps = {
  grepOpen: boolean;
  wideIDE: boolean;
  sidePane: "search" | "chats" | "files" | "git" | "terminal" | "loop";
  setGrepOpen: Dispatch<SetStateAction<boolean>>;
  grepTrap: RefObject<HTMLDivElement | null>;
  grepQ: string;
  setGrepQ: Dispatch<SetStateAction<string>>;
  setGrepIndex: Dispatch<SetStateAction<number>>;
  grepNameHits: string[];
  grepHits: SearchHit[];
  grepHi: number;
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
  wideIDERef: RefObject<boolean>;
  grepWait: boolean;
};

export function GrepOverlay({
  grepOpen,
  wideIDE,
  sidePane,
  setGrepOpen,
  grepTrap,
  grepQ,
  setGrepQ,
  setGrepIndex,
  grepNameHits,
  grepHits,
  grepHi,
  openFile,
  wideIDERef,
  grepWait,
}: GrepOverlayProps) {
  const docked = wideIDE && sidePane === "search";
  return (
    <div
      className={`search-overlay${grepOpen ? " open" : ""}`}
      onClick={() => {
        if (docked) return;
        setGrepOpen(false);
      }}
    >
      <div
        ref={grepTrap}
        className="search-box grep-box"
        role="dialog"
        aria-modal={docked ? undefined : true}
        aria-label="全文搜索"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus={grepOpen}
          className="search-input"
          placeholder="搜文件名或内容"
          value={grepQ}
          onChange={(event) => {
            setGrepQ(event.target.value);
            setGrepIndex(0);
          }}
          onKeyDown={(event) => {
            // Escape 由 ChatApp 的全局捕获按层处理（停靠时还要切回对话列表），这里再关会在上面还有一层时把搜索也关掉
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
              if (!wideIDERef.current) setGrepOpen(false);
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
                {grepNameHits.map((path, index) => (
                  <button
                    key={`name:${path}`}
                    type="button"
                    className={`search-item file-hit${index === grepHi ? " active" : ""}`}
                    onClick={() => {
                      openFile(path);
                      if (!wideIDERef.current) setGrepOpen(false);
                    }}
                  >
                    <span className="search-item-name">{path.split("/").pop()}</span>
                    <span className="search-item-dir">文件名</span>
                  </button>
                ))}
                {grepHits.map((hit, index) => {
                  const at = grepNameHits.length + index;
                  return (
                    <button
                      key={`${hit.path}:${hit.line}:${index}`}
                      type="button"
                      className={`search-item file-hit${at === grepHi ? " active" : ""}`}
                      onClick={() => {
                        openFile(hit.path, hit.line, false);
                        if (!wideIDERef.current) setGrepOpen(false);
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
            <div className="search-item">搜文件名或内容</div>
          )}
        </div>
      </div>
    </div>
  );
}
