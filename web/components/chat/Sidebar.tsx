// 左侧对话列表侧栏
import type { Dispatch, JSX, RefObject, SetStateAction } from "react";
import { fmtAgo } from "../../lib/chat/format";
import type { Chat } from "../../lib/chat/types";
import { MORE_GROUPS_SHOWN, normPath, relToCwd, sameCwd, workspaceLabel } from "../../lib/chat/workspace";
import type { AppearanceId, PaletteId } from "../../lib/theme";
import { IconRail } from "../chromeIcons";
import { JieboMark as Mark } from "../JieboMark";
import { FolderMark } from "./FolderMark";
import { SettingsPanel } from "./SettingsPanel";

type SidebarProps = {
  navDrag: {
    ref: RefObject<HTMLElement | null>;
    scrimRef: RefObject<HTMLElement | null>;
  };
  cwd: string;
  workspaceRoot: string;
  assistantName: string;
  assistantChatId: string;
  assistantActive: boolean;
  assistantChat: Chat | undefined;
  openAssistantChat: () => boolean;
  assistantBadge: number;
  assistantPreview: string;
  workspaceMenuOpen: boolean;
  newChat: () => void;
  wideIDE: boolean;
  sidePane: "search" | "chats" | "files" | "git" | "terminal" | "loop" | "assistant";
  grepOpen: boolean;
  terminalOpen: boolean;
  loopOpen: boolean;
  filesOpen: boolean;
  chooseSide: (pane: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "assistant") => void;
  loopLive: boolean;
  sidebarGroups: {
    user: boolean;
    touched: number;
    name: string;
    chats: Chat[];
    path: string;
  }[];
  moreGroups: {
    user: boolean;
    touched: number;
    name: string;
    chats: Chat[];
    path: string;
  }[];
  activeId: string;
  expandedGroups: Set<string>;
  groupMenu: {
    path: string;
    name: string;
  } | null;
  startChatIn: (path: string) => void;
  setExpandedGroups: Dispatch<SetStateAction<Set<string>>>;
  duplicateGroupNames: Set<string>;
  setGroupMenu: Dispatch<
    SetStateAction<{
      path: string;
      name: string;
    } | null>
  >;
  groupMenuNode: (path: string, name: string, chatCount: number) => JSX.Element;
  renameId: string | null;
  renameDraft: string;
  setRenameDraft: Dispatch<SetStateAction<string>>;
  commitRename: () => void;
  renameSkipRef: RefObject<boolean>;
  setRenameId: Dispatch<SetStateAction<string | null>>;
  selectChat: (chat: Chat) => void;
  startRename: (chat: Chat) => void;
  deleteChat: (id: string) => void;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  openNewChatMenu: () => void;
  openFilesBrowser: () => void;
  gitStatus: Record<string, string>;
  treePaths: string[];
  isAdmin: boolean;
  openAdminStats: () => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  connected: boolean;
  unlocked: boolean;
  busy: boolean;
  settingsOpen: boolean;
  themeChoice: {
    palette: PaletteId;
    appearance: AppearanceId;
  } | null;
  setThemeChoice: Dispatch<
    SetStateAction<{
      palette: PaletteId;
      appearance: AppearanceId;
    } | null>
  >;
  logout: () => void;
};

export function Sidebar({
  navDrag,
  cwd,
  workspaceRoot,
  assistantName,
  assistantChatId,
  assistantActive,
  assistantChat,
  openAssistantChat,
  assistantBadge,
  assistantPreview,
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
  sidebarGroups,
  moreGroups,
  activeId,
  expandedGroups,
  groupMenu,
  startChatIn,
  setExpandedGroups,
  duplicateGroupNames,
  setGroupMenu,
  groupMenuNode,
  renameId,
  renameDraft,
  setRenameDraft,
  commitRename,
  renameSkipRef,
  setRenameId,
  selectChat,
  startRename,
  deleteChat,
  moreOpen,
  setMoreOpen,
  openNewChatMenu,
  openFilesBrowser,
  gitStatus,
  treePaths,
  isAdmin,
  openAdminStats,
  setSettingsOpen,
  connected,
  unlocked,
  busy,
  settingsOpen,
  themeChoice,
  setThemeChoice,
  logout,
}: SidebarProps) {
  return (
    <aside className="sidebar" ref={navDrag.ref}>
      <div className="brand">
        <Mark />
        <div>
          <div className="brand-title">接驳</div>
          <div className="brand-sub" title={cwd || workspaceRoot}>
            {workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName)}
          </div>
        </div>
      </div>
      {assistantChatId ? (
        <button
          type="button"
          className={`chat-item assistant-pin${assistantActive ? " active" : ""}${assistantChat?.unread && !assistantActive ? " unread" : ""}`}
          title={`${assistantName} · 助理`}
          onClick={openAssistantChat}
        >
          <span className="assistant-pin-icon">
            <IconRail name="assistant" size={14} />
            {assistantBadge > 0 ? <span className="loop-live" /> : null}
          </span>
          <span className="assistant-pin-copy">
            <span className="assistant-pin-name">{assistantName}</span>
            <span className="assistant-pin-preview">{assistantPreview}</span>
          </span>
          {assistantChat?.turns.some((turn) => turn.running) ? (
            <span className="chat-mark run">跑</span>
          ) : assistantChat?.unread && !assistantActive ? (
            <span className="chat-mark unread">新</span>
          ) : null}
        </button>
      ) : null}
      <div className={`workspace-picker${workspaceMenuOpen ? " open" : ""}`}>
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
      </div>
      <div className="chats">
        {sidebarGroups.length ? null : (
          <div className="chats-empty">
            {moreGroups.length
              ? "还没有对话。点“新对话”，或展开下面的“更多工作区”开始。"
              : "还没有对话。点“新对话”选一个工作区开始。"}
          </div>
        )}
        {sidebarGroups.map((group) => {
          const key = normPath(group.path);
          const holdsActive = group.chats.some((chat) => chat.id === activeId);
          const open = holdsActive || expandedGroups.has(key);
          return (
            <div key={group.path} className="chat-group">
              <div className={`chat-group-head${groupMenu && sameCwd(groupMenu.path, group.path) ? " menu-open" : ""}`}>
                <button
                  type="button"
                  className={`chat-group-label${open ? " open" : ""}${holdsActive ? " locked" : ""}`}
                  title={group.path}
                  aria-expanded={group.chats.length ? open : undefined}
                  onClick={() => {
                    if (!group.chats.length) {
                      startChatIn(group.path);
                      return;
                    }
                    if (holdsActive) return;
                    setExpandedGroups((prev) => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                >
                  {group.chats.length ? (
                    <span className="chat-group-chevron" aria-hidden="true" />
                  ) : (
                    <span className="chat-group-chevron spacer" aria-hidden="true" />
                  )}
                  <FolderMark className="chat-group-folder" />
                  <span className="chat-group-name">{group.name}</span>
                  {duplicateGroupNames.has(group.name) ? (
                    <span className="chat-group-path">{relToCwd(group.path, workspaceRoot) || group.path}</span>
                  ) : null}
                  {group.chats.some((chat) => chat.turns.some((turn) => turn.running)) ? (
                    <span className="chat-group-live" title="有对话在运行" />
                  ) : null}
                  <span className="chat-group-meta">
                    {group.touched ? <span className="chat-group-time">{fmtAgo(group.touched)}</span> : null}
                    {group.chats.length ? <span className="chat-group-count">{group.chats.length}</span> : null}
                  </span>
                </button>
                <div className="chat-group-actions">
                  <button
                    type="button"
                    className="chat-group-act"
                    title={`在「${group.name}」新建对话`}
                    aria-label={`在「${group.name}」新建对话`}
                    onClick={() => startChatIn(group.path)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="chat-group-act"
                    title="更多"
                    aria-label={`「${group.name}」的更多操作`}
                    aria-haspopup="menu"
                    data-group-trigger={group.path}
                    aria-expanded={Boolean(groupMenu && sameCwd(groupMenu.path, group.path))}
                    onClick={() =>
                      setGroupMenu((cur) =>
                        cur && sameCwd(cur.path, group.path) ? null : { path: group.path, name: group.name },
                      )
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                    </svg>
                  </button>
                </div>
                {groupMenu && sameCwd(groupMenu.path, group.path)
                  ? groupMenuNode(group.path, group.name, group.chats.length)
                  : null}
              </div>
              {open
                ? group.chats.map((chat) => (
                    <div
                      key={chat.id}
                      className={`chat-item${chat.id === activeId ? " active" : ""}${chat.turns.some((turn) => turn.running) ? " busy" : ""}${chat.unread && chat.id !== activeId ? " unread" : ""}`}
                    >
                      {renameId === chat.id ? (
                        <input
                          className="chat-rename"
                          value={renameDraft}
                          autoFocus
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitRename();
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              renameSkipRef.current = true;
                              setRenameId(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="chat-item-main"
                          title="单击打开，双击改名"
                          onClick={() => selectChat(chat)}
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            startRename(chat);
                          }}
                        >
                          <span className="chat-item-title">{chat.title}</span>
                          {chat.turns.some((turn) => turn.running) ? (
                            <span className="chat-mark run">跑</span>
                          ) : chat.unread ? (
                            <span className="chat-mark unread">新</span>
                          ) : null}
                          {chat.touchedAt ? <span className="chat-item-time">{fmtAgo(chat.touchedAt)}</span> : null}
                        </button>
                      )}
                      <button
                        type="button"
                        className="chat-item-x"
                        title="删除会话"
                        aria-label="删除会话"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteChat(chat.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))
                : null}
            </div>
          );
        })}
        {moreGroups.length ? (
          <div className="chat-more">
            <button
              type="button"
              className={`chat-more-toggle${moreOpen ? " open" : ""}`}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <span className="chat-group-chevron" aria-hidden="true" />
              <span className="chat-more-title">更多工作区</span>
              <span className="chat-group-count">{moreGroups.length}</span>
            </button>
            {moreOpen ? (
              <div className="chat-more-list">
                {moreGroups.slice(0, MORE_GROUPS_SHOWN).map((group) => (
                  <div
                    key={group.path}
                    className={`chat-group-head chat-more-row${groupMenu && sameCwd(groupMenu.path, group.path) ? " menu-open" : ""}`}
                  >
                    <button
                      type="button"
                      className="chat-more-item"
                      title={`${group.path}\n点一下在这里开始新对话`}
                      onClick={() => startChatIn(group.path)}
                    >
                      <FolderMark className="chat-group-folder" />
                      <span className="chat-group-name">{group.name}</span>
                      {duplicateGroupNames.has(group.name) ? (
                        <span className="chat-group-path">{relToCwd(group.path, workspaceRoot) || group.path}</span>
                      ) : null}
                    </button>
                    <div className="chat-group-actions">
                      <button
                        type="button"
                        className="chat-group-act"
                        title="更多"
                        aria-label={`「${group.name}」的更多操作`}
                        aria-haspopup="menu"
                        data-group-trigger={group.path}
                        aria-expanded={Boolean(groupMenu && sameCwd(groupMenu.path, group.path))}
                        onClick={() =>
                          setGroupMenu((cur) =>
                            cur && sameCwd(cur.path, group.path) ? null : { path: group.path, name: group.name },
                          )
                        }
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                          <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                        </svg>
                      </button>
                    </div>
                    {groupMenu && sameCwd(groupMenu.path, group.path) ? groupMenuNode(group.path, group.name, 0) : null}
                  </div>
                ))}
                {moreGroups.length > MORE_GROUPS_SHOWN ? (
                  <button type="button" className="chat-more-all" onClick={openNewChatMenu}>
                    查看全部 {moreGroups.length} 个…
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <button type="button" className="side-files-btn" onClick={openFilesBrowser}>
        <span>文件</span>
        <span className="side-files-meta">
          {Object.keys(gitStatus).length
            ? `${Object.keys(gitStatus).length} 处改动`
            : treePaths.length
              ? `${treePaths.length}`
              : "浏览"}
        </span>
      </button>
      <div className="side-foot">
        {isAdmin ? (
          <button type="button" className="side-foot-btn" onClick={openAdminStats}>
            查看使用统计
          </button>
        ) : null}
        <button
          type="button"
          className="side-foot-btn"
          onClick={() => setSettingsOpen((open) => !open)}
          title={cwd || "工作目录"}
        >
          <span className={`dot ${connected && unlocked ? (busy ? "busy" : "on") : "off"}`} />
          <span className="side-foot-cwd">
            {connected
              ? !unlocked
                ? "正在登录…"
                : busy
                  ? "服务器正在干活"
                  : workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName)
              : "没连上"}
          </span>
        </button>
        {settingsOpen ? (
          <SettingsPanel
            themeChoice={themeChoice}
            setThemeChoice={setThemeChoice}
            cwd={cwd}
            workspaceRoot={workspaceRoot}
            logout={logout}
          />
        ) : null}
      </div>
    </aside>
  );
}
