// 左侧对话列表侧栏
import type { Dispatch, JSX, RefObject, SetStateAction } from "react";
import { showsUnread } from "../../lib/chat/sessions";
import type { Chat } from "../../lib/chat/types";
import { workspaceLabel } from "../../lib/chat/workspace";
import type { AppearanceId, PaletteId } from "../../lib/theme";
import { IconRail } from "../chromeIcons";
import { JieboMark as Mark } from "../JieboMark";
import { ChatList } from "./sidebar/ChatList";
import { SideActions } from "./sidebar/SideActions";
import { SideFoot } from "./sidebar/SideFoot";
import styles from "./Sidebar.module.css";

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
      <div className={styles.brand}>
        <Mark />
        <div>
          <div className={styles.brandTitle}>接驳</div>
          <div className={styles.brandSub} title={cwd || workspaceRoot}>
            {workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName)}
          </div>
        </div>
      </div>
      {assistantChatId ? (
        <button
          type="button"
          className={`chat-item assistant-pin${assistantActive ? " active" : ""}${showsUnread(assistantChat, activeId) ? " unread" : ""}`}
          title={`${assistantName} · 助理`}
          onClick={openAssistantChat}
        >
          <span className="assistant-pin-icon">
            <IconRail name="assistant" size={14} />
            {assistantBadge > 0 ? <span className="loop-live" /> : null}
          </span>
          <span className={styles.pinCopy}>
            <span className={styles.pinName}>{assistantName}</span>
            <span className={styles.pinPreview}>{assistantPreview}</span>
          </span>
          {assistantChat?.turns.some((turn) => turn.running) ? (
            <span className="chat-mark run">跑</span>
          ) : showsUnread(assistantChat, activeId) ? (
            <span className="chat-mark unread">新</span>
          ) : null}
        </button>
      ) : null}
      <div className={`${styles.workspacePicker}${workspaceMenuOpen ? " open" : ""}`}>
        <SideActions
          workspaceMenuOpen={workspaceMenuOpen}
          newChat={newChat}
          wideIDE={wideIDE}
          sidePane={sidePane}
          grepOpen={grepOpen}
          terminalOpen={terminalOpen}
          loopOpen={loopOpen}
          filesOpen={filesOpen}
          chooseSide={chooseSide}
          loopLive={loopLive}
        />
      </div>
      <ChatList
        sidebarGroups={sidebarGroups}
        moreGroups={moreGroups}
        activeId={activeId}
        expandedGroups={expandedGroups}
        groupMenu={groupMenu}
        startChatIn={startChatIn}
        setExpandedGroups={setExpandedGroups}
        duplicateGroupNames={duplicateGroupNames}
        workspaceRoot={workspaceRoot}
        setGroupMenu={setGroupMenu}
        groupMenuNode={groupMenuNode}
        renameId={renameId}
        renameDraft={renameDraft}
        setRenameDraft={setRenameDraft}
        commitRename={commitRename}
        renameSkipRef={renameSkipRef}
        setRenameId={setRenameId}
        selectChat={selectChat}
        startRename={startRename}
        deleteChat={deleteChat}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        openNewChatMenu={openNewChatMenu}
      />
      <button type="button" className="side-files-btn" onClick={openFilesBrowser}>
        <span>文件</span>
        <span className={styles.filesMeta}>
          {Object.keys(gitStatus).length
            ? `${Object.keys(gitStatus).length} 处改动`
            : treePaths.length
              ? `${treePaths.length}`
              : "浏览"}
        </span>
      </button>
      <SideFoot
        isAdmin={isAdmin}
        openAdminStats={openAdminStats}
        setSettingsOpen={setSettingsOpen}
        cwd={cwd}
        connected={connected}
        unlocked={unlocked}
        busy={busy}
        workspaceRoot={workspaceRoot}
        assistantName={assistantName}
        settingsOpen={settingsOpen}
        themeChoice={themeChoice}
        setThemeChoice={setThemeChoice}
        logout={logout}
      />
    </aside>
  );
}
