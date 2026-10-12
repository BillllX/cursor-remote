// 打开文件弹层
import type { Dispatch, RefObject, SetStateAction } from "react";
import styles from "./PaletteOverlay.module.css";

type PaletteOverlayProps = {
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  paletteTrap: RefObject<HTMLDivElement | null>;
  paletteQ: string;
  setPaletteQ: Dispatch<SetStateAction<string>>;
  setPaletteIndex: Dispatch<SetStateAction<number>>;
  paletteHits: string[];
  paletteHi: number;
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
};

export function PaletteOverlay({
  paletteOpen,
  setPaletteOpen,
  paletteTrap,
  paletteQ,
  setPaletteQ,
  setPaletteIndex,
  paletteHits,
  paletteHi,
  openFile,
}: PaletteOverlayProps) {
  return (
    <div className={`search-overlay${paletteOpen ? " open" : ""}`} onClick={() => setPaletteOpen(false)}>
      <div
        ref={paletteTrap}
        className="search-box"
        role="dialog"
        aria-modal="true"
        aria-label="打开文件"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus={paletteOpen}
          className="search-input"
          placeholder="打开文件"
          value={paletteQ}
          onChange={(event) => {
            setPaletteQ(event.target.value);
            setPaletteIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPaletteOpen(false);
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setPaletteIndex((index) => Math.min(index + 1, Math.max(0, paletteHits.length - 1)));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setPaletteIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Enter" && paletteHits[paletteHi]) {
              event.preventDefault();
              openFile(paletteHits[paletteHi]);
              setPaletteOpen(false);
            }
          }}
        />
        <div className="search-list">
          {paletteHits.length ? (
            paletteHits.map((path, index) => {
              const base = path.split("/").pop() || path;
              const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              const ext = (base.includes(".") ? base.split(".").pop() : "") || "file";
              return (
                <button
                  key={path}
                  type="button"
                  className={`search-item file-hit${index === paletteHi ? " active" : ""}`}
                  onClick={() => {
                    openFile(path);
                    setPaletteOpen(false);
                  }}
                >
                  <span className={styles.fileKind}>{ext.slice(0, 4)}</span>
                  <span className="search-item-name">{base}</span>
                  <span className="search-item-dir">{dir || "."}</span>
                </button>
              );
            })
          ) : (
            <div className="search-item">没有匹配的文件</div>
          )}
        </div>
      </div>
    </div>
  );
}
