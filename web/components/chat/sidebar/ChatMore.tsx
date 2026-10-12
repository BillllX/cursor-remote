// 侧栏“更多工作区”：还没有对话的工作区
import type { Dispatch, JSX, SetStateAction } from "react";
import type { Chat } from "../../../lib/chat/types";
import { MORE_GROUPS_SHOWN, relToCwd, sameCwd } from "../../../lib/chat/workspace";
import { FolderMark } from "../FolderMark";

type ChatMoreProps = {
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  moreGroups: {
    user: boolean;
    touched: number;
    name: string;
    chats: Chat[];
    path: string;
  }[];
  groupMenu: {
    path: string;
    name: string;
  } | null;
  startChatIn: (path: string) => void;
  duplicateGroupNames: Set<string>;
  workspaceRoot: string;
  setGroupMenu: Dispatch<
    SetStateAction<{
      path: string;
      name: string;
    } | null>
  >;
  groupMenuNode: (path: string, name: string, chatCount: number) => JSX.Element;
  openNewChatMenu: () => void;
};

export function ChatMore({
  moreOpen,
  setMoreOpen,
  moreGroups,
  groupMenu,
  startChatIn,
  duplicateGroupNames,
  workspaceRoot,
  setGroupMenu,
  groupMenuNode,
  openNewChatMenu,
}: ChatMoreProps) {
  return (
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
  );
}
