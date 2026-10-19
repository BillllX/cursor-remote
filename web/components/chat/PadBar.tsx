// 窄屏顶栏：对话列表开关、标题、今日、打开文件、新对话
import type { Dispatch, SetStateAction } from "react";
import { shortPadTitle } from "../../lib/chat/sessions";
import type { Chat } from "../../lib/chat/types";

type PadBarProps = {
  navOpen: boolean;
  setNavOpen: Dispatch<SetStateAction<boolean>>;
  setPreviewMax: Dispatch<SetStateAction<boolean>>;
  assistantActive: boolean;
  assistantName: string;
  active: Chat;
  assistantOpen: boolean;
  chooseSide: (pane: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant") => void;
  assistantBadge: number;
  openFilesBrowser: () => void;
  newChat: () => void;
};

export function PadBar({
  navOpen,
  setNavOpen,
  setPreviewMax,
  assistantActive,
  assistantName,
  active,
  assistantOpen,
  chooseSide,
  assistantBadge,
  openFilesBrowser,
  newChat,
}: PadBarProps) {
  return (
    <div className="pad-bar">
      <button
        type="button"
        className="pad-bar-btn pad-bar-nav"
        aria-label={navOpen ? "关闭对话列表" : "打开对话列表"}
        onClick={() => {
          setNavOpen((open) => {
            const next = !open;
            if (next) setPreviewMax(false);
            return next;
          });
        }}
      >
        <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
        </svg>
      </button>
      <div className="pad-bar-title" title={assistantActive ? assistantName : active?.title || "新对话"}>
        {assistantActive ? assistantName : shortPadTitle(active?.title, active?.turns.find((turn) => turn.user)?.user)}
      </div>
      {assistantActive ? (
        <button
          type="button"
          className={`pill assistant-today${assistantOpen ? " on" : ""}`}
          aria-label={`打开助理总览、收件箱和通知${assistantBadge > 0 ? `，需要处理 ${assistantBadge}` : ""}`}
          onClick={() => chooseSide("assistant")}
        >
          助理
          {assistantBadge > 0 ? <span className="assistant-attention-badge" aria-hidden="true">{assistantBadge}</span> : null}
        </button>
      ) : null}
      <button type="button" className="pad-bar-btn" aria-label="打开文件" onClick={openFilesBrowser}>
        <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3.5 2.5h6l3 3v8h-9z" />
          <path d="M9.5 2.5v3h3" />
        </svg>
      </button>
      <button type="button" className="pad-bar-btn" aria-label="新对话" onClick={newChat}>
        +
      </button>
    </div>
  );
}
