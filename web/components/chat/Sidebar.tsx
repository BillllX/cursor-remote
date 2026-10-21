// 左侧对话列表侧栏
import type { Dispatch, JSX, RefObject, SetStateAction } from "react";
import type { Chat } from "../../lib/chat/types";
import { sameCwd, workspaceLabel } from "../../lib/chat/workspace";
import type { AppearanceId, PaletteId } from "../../lib/theme";
import type { WorkspaceNavId } from "../../lib/productNavigation";
import { IconRail } from "../chromeIcons";
import { JieboMark as Mark } from "../JieboMark";
import { ChatList } from "./sidebar/ChatList";
import { SideFoot } from "./sidebar/SideFoot";
import { WorkspaceNavigation } from "./WorkspaceNavigation";
import styles from "./Sidebar.module.css";

type SidebarProps = {
  navDrag: {
    ref: RefObject<HTMLElement | null>;
    scrimRef: RefObject<HTMLElement | null>;
  };
  cwd: string;
  workspaceRoot: string;
  assistantName: string;
  assistantActive: boolean;
  assistantOpen: boolean;
  openAssistantDomain: () => void;
  assistantBadge: number;
  workspaceMenuOpen: boolean;
  workspaceSection: WorkspaceNavId;
  openWorkspaceDomain: () => void;
  openWorkspaceSwitcher: () => void;
  openWorkspaceMemory: () => void;
  openWorkspaceManagement: () => void;
  newChat: () => void;
  terminalOpen: boolean;
  loopOpen: boolean;
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
  assistantActive,
  assistantOpen,
  openAssistantDomain,
  assistantBadge,
  workspaceMenuOpen,
  workspaceSection,
  openWorkspaceDomain,
  openWorkspaceSwitcher,
  openWorkspaceMemory,
  openWorkspaceManagement,
  newChat,
  chooseSide,
  terminalOpen,
  loopOpen,
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
  const currentGroup = sidebarGroups[0];
  const canManageWorkspace = Boolean(
    currentGroup && !currentGroup.user && !sameCwd(currentGroup.path, workspaceRoot),
  );
  const assistantSelected = assistantActive || assistantOpen;
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
      <div className="mobile-domain-nav" aria-label="一级导航">
        <button
          type="button"
          className={assistantSelected ? "on" : ""}
          aria-pressed={assistantSelected}
          aria-label={`助理${assistantBadge > 0 ? `，需要处理 ${assistantBadge}` : ""}`}
          onClick={openAssistantDomain}
        >
          <IconRail name="assistant" size={14} />
          助理
        </button>
        <button
          type="button"
          className={assistantSelected ? "" : "on"}
          aria-pressed={!assistantSelected}
          aria-label="工作区"
          onClick={openWorkspaceDomain}
        >
          <IconRail name="workspace" size={14} />
          工作区
        </button>
      </div>
      <WorkspaceNavigation
        workspaceName={sidebarGroups[0]?.name || workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName)}
        workspacePath={sidebarGroups[0]?.path || cwd || workspaceRoot}
        active={workspaceSection}
        loopLive={loopLive}
        activeSessionTool={loopOpen ? "loop" : terminalOpen ? "terminal" : undefined}
        managementDisabled={!canManageWorkspace}
        managementHint="当前没有可管理的子工作区；请先切换或新建工作区。"
        onSwitchWorkspace={openWorkspaceSwitcher}
        onNavigate={(id) => {
          if (id === "files") chooseSide("files");
          else if (id === "search") chooseSide("search");
          else if (id === "git") chooseSide("git");
          else if (id === "memory") openWorkspaceMemory();
          else if (id === "management") openWorkspaceManagement();
          else chooseSide("chats");
        }}
        onSessionTool={(id) => chooseSide(id)}
      />
      <button className={`new-chat primary${workspaceMenuOpen ? " open" : ""}`} type="button" onClick={newChat}>
        + 新对话
      </button>
      {workspaceSection === "management" ? (
        <section className="workspace-management" aria-label="工作区管理">
          <div className="side-label">工作区管理</div>
          {canManageWorkspace && currentGroup ? (
            <>
              <p className="loop-meta">管理「{currentGroup.name}」的名称或从列表移除。</p>
              <div className="workspace-management-menu">
                {groupMenuNode(currentGroup.path, currentGroup.name, currentGroup.chats.length)}
              </div>
            </>
          ) : (
            <p className="loop-meta">当前没有可管理的子工作区。USER 根目录不能在这里管理，请先切换或新建工作区。</p>
          )}
        </section>
      ) : <ChatList
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
      />}
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
