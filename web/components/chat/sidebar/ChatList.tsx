// 侧栏对话列表：按工作区分组，底部“更多工作区”
import type { Dispatch, JSX, RefObject, SetStateAction } from "react";
import { fmtAgo } from "../../../lib/chat/format";
import { showsUnread } from "../../../lib/chat/sessions";
import type { Chat } from "../../../lib/chat/types";
import { normPath, relToCwd, sameCwd } from "../../../lib/chat/workspace";
import { FolderMark } from "../FolderMark";
import { ChatMore } from "./ChatMore";
import styles from "./ChatList.module.css";

type ChatListProps = {
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
  workspaceRoot: string;
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
};

export function ChatList({
  sidebarGroups,
  moreGroups,
  activeId,
  expandedGroups,
  groupMenu,
  startChatIn,
  setExpandedGroups,
  duplicateGroupNames,
  workspaceRoot,
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
}: ChatListProps) {
  return (
    <div className="chats">
      {sidebarGroups.length ? null : (
        <div className={styles.empty}>
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
                  <span className={styles.groupLive} title="有对话在运行" />
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
                    className={`chat-item${chat.id === activeId ? " active" : ""}${chat.turns.some((turn) => turn.running) ? " busy" : ""}${showsUnread(chat, activeId) ? " unread" : ""}`}
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
                        ) : showsUnread(chat, activeId) ? (
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
        <ChatMore
          moreOpen={moreOpen}
          setMoreOpen={setMoreOpen}
          moreGroups={moreGroups}
          groupMenu={groupMenu}
          startChatIn={startChatIn}
          duplicateGroupNames={duplicateGroupNames}
          workspaceRoot={workspaceRoot}
          setGroupMenu={setGroupMenu}
          groupMenuNode={groupMenuNode}
          openNewChatMenu={openNewChatMenu}
        />
      ) : null}
    </div>
  );
}
