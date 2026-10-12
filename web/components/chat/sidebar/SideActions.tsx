// 侧栏顶部：新对话与工具栏（文件、搜索、Git、终端、Loop）
import { IconRail } from "../../chromeIcons";

type SideActionsProps = {
  workspaceMenuOpen: boolean;
  newChat: () => void;
  wideIDE: boolean;
  sidePane: "files" | "search" | "git" | "terminal" | "loop" | "chats" | "assistant";
  grepOpen: boolean;
  terminalOpen: boolean;
  loopOpen: boolean;
  filesOpen: boolean;
  chooseSide: (pane: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant") => void;
  loopLive: boolean;
};

export function SideActions({
  workspaceMenuOpen,
  newChat,
  wideIDE,
  sidePane,
  grepOpen,
  terminalOpen,
  loopOpen,
  filesOpen,
  chooseSide,
  loopLive,
}: SideActionsProps) {
  return (
    <div className="side-actions">
      <button className={`new-chat primary${workspaceMenuOpen ? " open" : ""}`} type="button" onClick={newChat}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
        新对话
      </button>
      <div className="side-tools" role="toolbar" aria-label="工具">
        {(
          [
            ["files", "文件"],
            ["search", "搜索"],
            ["git", "Git"],
            ["terminal", "终端"],
            ["loop", "Loop"],
          ] as const
        ).map(([pane, label]) => {
          const on = wideIDE
            ? sidePane === pane
            : pane === "search"
              ? grepOpen
              : pane === "terminal"
                ? terminalOpen
                : pane === "loop"
                  ? loopOpen
                  : pane === "git"
                    ? false
                    : filesOpen;
          return (
            <button
              key={pane}
              type="button"
              className={`side-tool${on ? " on" : ""}`}
              aria-label={label}
              aria-pressed={on}
              onClick={() => chooseSide(pane)}
            >
              <span className="side-tool-icon">
                <IconRail name={pane} size={14} />
                {pane === "loop" && loopLive ? <span className="loop-live" /> : null}
              </span>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
