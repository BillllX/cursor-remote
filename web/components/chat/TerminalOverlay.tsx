// 终端输出弹层
import type { Dispatch, RefObject, SetStateAction } from "react";
import styles from "./TerminalOverlay.module.css";

type TerminalOverlayProps = {
  terminalOpen: boolean;
  wideIDE: boolean;
  sidePane: "search" | "chats" | "files" | "git" | "terminal" | "loop";
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  terminalTrap: RefObject<HTMLDivElement | null>;
  shellEntries: {
    id: string;
    command: string;
    output: string;
    running: boolean;
  }[];
  terminalLogRef: RefObject<HTMLDivElement | null>;
};

export function TerminalOverlay({
  terminalOpen,
  wideIDE,
  sidePane,
  setTerminalOpen,
  terminalTrap,
  shellEntries,
  terminalLogRef,
}: TerminalOverlayProps) {
  const docked = wideIDE && sidePane === "terminal";
  return (
    <div
      className={`search-overlay${terminalOpen ? " open" : ""}`}
      onClick={() => {
        if (docked) return;
        setTerminalOpen(false);
      }}
    >
      <div
        ref={terminalTrap}
        className="search-box terminal-box"
        role="dialog"
        aria-modal={docked ? undefined : true}
        aria-label="终端"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="loop-title">终端 · 当前对话</div>
        {shellEntries.length ? (
          <div className="terminal-log" ref={terminalLogRef}>
            {shellEntries.map((row) => (
              <div key={row.id} className="terminal-row">
                <div className={styles.cmd}>$ {row.command}</div>
                <pre className={`terminal-out${row.output ? "" : " muted"}`}>
                  {row.output || (row.running ? "正在跑…" : "没有输出")}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <div className="terminal-empty">
            <div>这个会话还没有 shell 输出</div>
            <div className="loop-meta">让 Agent 跑一条命令，输出会出现在这里。</div>
          </div>
        )}
      </div>
    </div>
  );
}
