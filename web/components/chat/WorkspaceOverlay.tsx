// 新对话：选择工作区弹层
import { type Dispatch, Fragment, type RefObject, type SetStateAction } from "react";
import type { ClientMessage } from "@shared/protocol";
import { fmtAgo } from "../../lib/chat/format";
import { relToCwd, sameCwd } from "../../lib/chat/workspace";
import { FolderMark } from "./FolderMark";
import { Highlight } from "./markdown";

type WorkspaceOverlayProps = {
  workspaceMenuOpen: boolean;
  setWorkspaceMenuOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceCreating: Dispatch<SetStateAction<boolean>>;
  workspaceTrap: RefObject<HTMLDivElement | null>;
  otherMenuWorkspaces: {
    path: string;
    name: string;
    user?: boolean;
  }[];
  workspaceQuery: string;
  workspaceChoices: {
    recent: boolean;
    chats: number;
    touched: number;
    dup: boolean;
    path: string;
    name: string;
    user?: boolean;
  }[];
  workspacePick: number;
  setWorkspaceQuery: Dispatch<SetStateAction<string>>;
  setWorkspaceIndex: Dispatch<SetStateAction<number>>;
  startChatIn: (path: string) => void;
  send: (message: ClientMessage) => void;
  workspaceRoot: string;
  cwd: string;
  workspaceCreating: boolean;
  submitNewWorkspace: () => void;
  workspaceNameDraft: string;
  setWorkspaceNameDraft: Dispatch<SetStateAction<string>>;
  workspaceExact: boolean;
};

export function WorkspaceOverlay({
  workspaceMenuOpen,
  setWorkspaceMenuOpen,
  setWorkspaceCreating,
  workspaceTrap,
  otherMenuWorkspaces,
  workspaceQuery,
  workspaceChoices,
  workspacePick,
  setWorkspaceQuery,
  setWorkspaceIndex,
  startChatIn,
  send,
  workspaceRoot,
  cwd,
  workspaceCreating,
  submitNewWorkspace,
  workspaceNameDraft,
  setWorkspaceNameDraft,
  workspaceExact,
}: WorkspaceOverlayProps) {
  return (
    <div
      className={`search-overlay${workspaceMenuOpen ? " open" : ""}`}
      onClick={() => {
        setWorkspaceMenuOpen(false);
        setWorkspaceCreating(false);
      }}
    >
      <div
        ref={workspaceTrap}
        className="search-box workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新对话：选择工作区"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workspace-dialog-head">
          <div className="loop-title">新对话</div>
          <div className="workspace-dialog-sub">选一个工作区，对话里的读写都在这个目录下进行</div>
        </div>
        <input
          autoFocus={workspaceMenuOpen}
          className="search-input"
          placeholder={otherMenuWorkspaces.length > 6 ? `搜索 ${otherMenuWorkspaces.length} 个工作区` : "搜索工作区"}
          value={workspaceQuery}
          role="combobox"
          aria-expanded="true"
          aria-controls="workspace-choices"
          aria-activedescendant={workspaceChoices.length ? `workspace-choice-${workspacePick}` : undefined}
          onChange={(event) => {
            setWorkspaceQuery(event.target.value);
            setWorkspaceIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && workspaceChoices.length) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setWorkspaceIndex((workspacePick + step + workspaceChoices.length) % workspaceChoices.length);
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            const pick = workspaceChoices[workspacePick];
            if (pick) startChatIn(pick.path);
            else if (workspaceQuery.trim()) send({ type: "create_workspace", name: workspaceQuery.trim() });
          }}
        />
        <div className="search-list workspace-choices" id="workspace-choices" role="listbox" aria-label="工作区">
          {workspaceChoices.map((item, index) => (
            <Fragment key={item.path}>
              {index === 0 || item.recent !== workspaceChoices[index - 1].recent ? (
                <div className="workspace-choice-section" role="presentation">
                  {item.recent ? "最近用过" : "全部工作区"}
                </div>
              ) : null}
              <button
                id={`workspace-choice-${index}`}
                type="button"
                role="option"
                aria-selected={index === workspacePick}
                tabIndex={-1}
                className={`workspace-choice${index === workspacePick ? " active" : ""}`}
                onMouseMove={() => {
                  if (index !== workspacePick) setWorkspaceIndex(index);
                }}
                onClick={() => startChatIn(item.path)}
              >
                <FolderMark />
                <span className="workspace-choice-text">
                  <span className="workspace-choice-name">
                    <Highlight text={item.name} query={workspaceQuery} />
                  </span>
                  {item.dup || (relToCwd(item.path, workspaceRoot) || item.path) !== item.name ? (
                    <span className="workspace-choice-path">{relToCwd(item.path, workspaceRoot) || item.path}</span>
                  ) : null}
                </span>
                {sameCwd(item.path, cwd) ? <span className="workspace-choice-tag">当前</span> : null}
                {item.chats ? (
                  <span className="workspace-choice-count">
                    {item.chats} 个对话{item.touched ? ` · ${fmtAgo(item.touched, true)}` : ""}
                  </span>
                ) : null}
              </button>
            </Fragment>
          ))}
          {!workspaceChoices.length ? (
            <div className="workspace-choice-empty">
              {otherMenuWorkspaces.length ? "没有匹配的工作区" : "还没有工作区，先新建一个"}
            </div>
          ) : null}
        </div>
        <div className="workspace-dialog-foot">
          {workspaceCreating ? (
            <form
              className="workspace-create"
              onSubmit={(event) => {
                event.preventDefault();
                submitNewWorkspace();
              }}
            >
              <input
                className="side-input"
                autoFocus
                value={workspaceNameDraft}
                placeholder="新目录名"
                onChange={(event) => setWorkspaceNameDraft(event.target.value)}
              />
              <button type="submit" className="workspace-create-ok" disabled={!workspaceNameDraft.trim()}>
                创建
              </button>
            </form>
          ) : workspaceQuery.trim() && !workspaceExact ? (
            <button
              type="button"
              className="workspace-new"
              onClick={() => send({ type: "create_workspace", name: workspaceQuery.trim() })}
            >
              + 新建工作区「{workspaceQuery.trim()}」
            </button>
          ) : (
            <button
              type="button"
              className="workspace-new"
              onClick={() => {
                setWorkspaceNameDraft("");
                setWorkspaceCreating(true);
              }}
            >
              + 新建工作区
            </button>
          )}
          <span className="workspace-dialog-keys" aria-hidden="true">
            ↑↓ 选择 · Enter 打开 · Esc 关闭
          </span>
        </div>
      </div>
    </div>
  );
}
