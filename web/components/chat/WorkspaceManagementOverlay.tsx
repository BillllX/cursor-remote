// 工作区管理浮窗（管理当前工作区基础操作、知识库配置、HTML 看板与外部投递口令）
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AssistantResultMessage, ClientMessage } from "@shared/protocol";
import type { Chat } from "../../lib/chat/types";
import { relToCwd } from "../../lib/chat/workspace";
import { WorkspaceKbPanel } from "./WorkspaceKbPanel";

type WorkspaceManagementOverlayProps = {
  managementOpen: boolean;
  setManagementOpen: Dispatch<SetStateAction<boolean>>;
  managementTrap: RefObject<HTMLDivElement | null>;
  currentGroup?: {
    user: boolean;
    touched: number;
    name: string;
    chats: Chat[];
    path: string;
  };
  workspaceRoot: string;
  canManageWorkspace: boolean;
  isTopLevelWorkspace: (path: string) => boolean;
  startChatIn: (path: string) => void;
  openWorkspaceSwitcher: () => void;
  renameWorkspacePrompt: (path: string, name: string) => void;
  copyPath: (path: string) => void;
  clearWorkspaceChats: (path: string, name: string) => void;
  deleteWorkspaceConfirm: (path: string, name: string) => void;
  send: (message: ClientMessage) => void;
  assistantResults: AssistantResultMessage[];
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
  setNotice: Dispatch<SetStateAction<string>>;
};

export function WorkspaceManagementOverlay({
  managementOpen,
  setManagementOpen,
  managementTrap,
  currentGroup,
  workspaceRoot,
  canManageWorkspace,
  isTopLevelWorkspace,
  startChatIn,
  openWorkspaceSwitcher,
  renameWorkspacePrompt,
  copyPath,
  clearWorkspaceChats,
  deleteWorkspaceConfirm,
  send,
  assistantResults,
  openFile,
  setNotice,
}: WorkspaceManagementOverlayProps) {
  const relPath = currentGroup ? relToCwd(currentGroup.path, workspaceRoot) || currentGroup.name : "";
  const chatCount = currentGroup?.chats.length ?? 0;
  const topLevel = currentGroup ? isTopLevelWorkspace(currentGroup.path) : false;

  return (
    <div
      className={`search-overlay workspace-modal-overlay${managementOpen ? " open" : ""}`}
      onClick={() => setManagementOpen(false)}
    >
      <div
        ref={managementTrap}
        className="search-box management-box workspace-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="工作区管理"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">工作区管理</span>
              {currentGroup ? <span className="workspace-modal-badge">{currentGroup.name}</span> : null}
            </div>
            <div className="workspace-modal-sub" title={currentGroup?.path || workspaceRoot}>
              {canManageWorkspace && currentGroup
                ? `目录：${relPath} · 共 ${chatCount} 个对话`
                : "管理子工作区名称、会话、知识库分类与外部投递口令"}
            </div>
          </div>
          <div className="workspace-modal-actions">
            <button
              type="button"
              className="workspace-modal-btn"
              onClick={() => {
                setManagementOpen(false);
                openWorkspaceSwitcher();
              }}
            >
              切换工作区
            </button>
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label="关闭工作区管理"
              title="关闭 (Esc)"
              onClick={() => setManagementOpen(false)}
            >
              ×
            </button>
          </div>
        </div>

        <div className="workspace-modal-body">
          {canManageWorkspace && currentGroup ? (
            <>
              <section className="workspace-modal-section" aria-label="工作区常规操作">
                <div className="side-label">常规操作</div>
                <div className="workspace-manage-actions">
                  <button
                    type="button"
                    className="new-chat primary"
                    onClick={() => {
                      setManagementOpen(false);
                      startChatIn(currentGroup.path);
                    }}
                  >
                    + 新建对话
                  </button>
                  {topLevel ? (
                    <button
                      type="button"
                      className="new-chat"
                      onClick={() => renameWorkspacePrompt(currentGroup.path, currentGroup.name)}
                    >
                      重命名工作区…
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="new-chat"
                    onClick={() => copyPath(currentGroup.path)}
                  >
                    复制路径
                  </button>
                  <button
                    type="button"
                    className="new-chat danger-btn"
                    disabled={!chatCount}
                    onClick={() => clearWorkspaceChats(currentGroup.path, currentGroup.name)}
                  >
                    清空对话{chatCount ? `（${chatCount}）` : ""}
                  </button>
                  {topLevel ? (
                    <button
                      type="button"
                      className="new-chat danger-btn"
                      disabled={chatCount > 0}
                      title={chatCount > 0 ? "里面还有对话，请先清空对话" : "空目录直接删除，有文件的只从列表隐藏"}
                      onClick={() => {
                        setManagementOpen(false);
                        deleteWorkspaceConfirm(currentGroup.path, currentGroup.name);
                      }}
                    >
                      删除工作区…
                    </button>
                  ) : null}
                </div>
                {chatCount > 0 && topLevel ? (
                  <div className="loop-meta">
                    提示：如需移除该工作区，请先清空其中的 {chatCount} 个对话（磁盘上的文件不会被删除）。
                  </div>
                ) : null}
              </section>

              <WorkspaceKbPanel
                workspaceKey={relPath}
                workspaceName={currentGroup.name}
                workspacePath={currentGroup.path}
                send={send}
                assistantResults={assistantResults}
                onOpenBoard={(boardRelPath) => {
                  openFile(boardRelPath);
                  setManagementOpen(false);
                }}
                setNotice={(msg) => setNotice(msg)}
              />
            </>
          ) : (
            <div className="terminal-empty" style={{ padding: "32px 16px", textAlign: "center" }}>
              <div>当前处于根工作区，无可管理的子工作区</div>
              <div className="loop-meta">
                USER 根目录不能重命名、移除或配置为独立知识库；请先切换或新建一个子工作区。
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="new-chat primary"
                  onClick={() => {
                    setManagementOpen(false);
                    openWorkspaceSwitcher();
                  }}
                >
                  切换或新建工作区
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
