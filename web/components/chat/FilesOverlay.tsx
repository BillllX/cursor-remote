// 文件浏览器
import { useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { sameFile, workspaceLabel } from "../../lib/chat/workspace";
import { extractKbBoardShortcuts } from "../../lib/kbWorkspace";
import FileTree, { FileGlyph, GIT_LABEL } from "../FileTree";
import styles from "./FilesOverlay.module.css";

type FilesOverlayProps = {
  filesOpen: boolean;
  filesDocked: boolean;
  closeFiles: () => void;
  filesTrap: RefObject<HTMLDivElement | null>;
  sidePane: "search" | "chats" | "files" | "git" | "terminal" | "loop";
  wideIDE: boolean;
  cwd: string;
  workspaceRoot: string;
  assistantName: string;
  filesQuery: string;
  setFilesQuery: Dispatch<SetStateAction<string>>;
  gitStatus: Record<string, string>;
  previewPath: string;
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
  treePaths: string[];
  treeTruncated: boolean;
  loadingDirs?: Record<string, boolean>;
  truncatedDirs?: Record<string, boolean>;
  onExpandDir?: (dir: string) => void;
  handlePickFile: (path: string, line?: number, endLine?: number, snippet?: string) => void;
  setNotice: Dispatch<SetStateAction<string>>;
  downloadWorkspaceFile: (path: string) => void;
  handleTreeCreate: (path: string, kind: "file" | "dir") => void;
  handleTreeRename: (from: string, to: string) => void;
  handleTreeDelete: (path: string, dir: boolean) => void;
};

export function FilesOverlay({
  filesOpen,
  filesDocked,
  closeFiles,
  filesTrap,
  sidePane,
  wideIDE,
  cwd,
  workspaceRoot,
  assistantName,
  filesQuery,
  setFilesQuery,
  gitStatus,
  previewPath,
  openFile,
  treePaths,
  treeTruncated,
  loadingDirs,
  truncatedDirs,
  onExpandDir,
  handlePickFile,
  setNotice,
  downloadWorkspaceFile,
  handleTreeCreate,
  handleTreeRename,
  handleTreeDelete,
}: FilesOverlayProps) {
  const kbBoards = useMemo(() => extractKbBoardShortcuts(treePaths, filesQuery), [treePaths, filesQuery]);

  return (
    <div
      className={`files-overlay${filesOpen ? " open" : ""}`}
      onClick={() => {
        if (filesDocked) return;
        closeFiles();
      }}
    >
      <div
        ref={filesTrap}
        className="files-browser"
        role="dialog"
        aria-modal={filesDocked ? undefined : true}
        aria-label="文件浏览器"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="files-browser-head">
          <div className={styles.title}>
            <span>{sidePane === "git" && wideIDE ? "Git" : "文件"}</span>
            <span className={styles.cwd} title={cwd || workspaceRoot}>
              {workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName)}
            </span>
          </div>
          <button type="button" className="files-browser-close" aria-label="关闭文件浏览器" onClick={closeFiles}>
            ×
          </button>
        </div>
        <input
          autoFocus={filesOpen}
          className="files-browser-search"
          placeholder="搜索文件名或路径"
          value={filesQuery}
          onChange={(event) => setFilesQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeFiles();
          }}
        />
        <div className={`files-browser-body${wideIDE && sidePane === "git" ? " git-only" : ""}`}>
          {kbBoards.length > 0 && !(wideIDE && sidePane === "git") ? (
            <div className={styles.kbBoardsSection} aria-label="知识库 HTML 看板">
              <div className="side-label">知识库看板（HTML） · {kbBoards.length}</div>
              <div className={styles.kbBoardsList}>
                {kbBoards.map((board) => (
                  <button
                    key={board.path}
                    type="button"
                    className={`tree-file ${styles.kbBoardBtn}${sameFile(previewPath, board.path) ? " on" : ""}`}
                    title={`点击预览知识库看板：${board.path}`}
                    onClick={() => {
                      openFile(board.path);
                      if (!filesDocked) closeFiles();
                    }}
                  >
                    <FileGlyph path={board.path} />
                    <span className="tree-file-copy">
                      <span className="tree-file-name">{board.title}</span>
                      <span className="tree-file-path">{board.path}</span>
                    </span>
                    <span className={styles.kbBoardBadge}>{board.level === "category" ? "顶层" : board.category}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {Object.keys(gitStatus).length ? (
            <div className="changes-list files-browser-changes">
              <div className="side-label">改动 · {Object.keys(gitStatus).length}</div>
              {Object.entries(gitStatus)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([path, letter]) => (
                  <button
                    key={path}
                    type="button"
                    className={`tree-file${sameFile(previewPath, path) ? " on" : ""}`}
                    title={path}
                    onClick={() => {
                      openFile(path, undefined, true);
                      if (!filesDocked) closeFiles();
                    }}
                  >
                    <FileGlyph path={path} />
                    <span className="tree-file-copy">
                      <span className="tree-file-name">{path.split("/").pop() || path}</span>
                      <span className="tree-file-path">{path}</span>
                    </span>
                    <span className={`git-mark ${letter}`} title={GIT_LABEL[letter] || letter}>
                      {letter}
                    </span>
                  </button>
                ))}
            </div>
          ) : wideIDE && sidePane === "git" ? (
            <div className={styles.gitEmpty}>工作区干净</div>
          ) : null}
          <FileTree
            paths={treePaths}
            truncated={treeTruncated}
            status={gitStatus}
            query={filesQuery}
            variant="browser"
            loadingDirs={loadingDirs}
            truncatedDirs={truncatedDirs}
            onExpandDir={onExpandDir}
            onPick={(path) => {
              handlePickFile(path);
              if (!filesDocked) closeFiles();
            }}
            onOpen={(path) => {
              openFile(path);
              if (!filesDocked) closeFiles();
            }}
            onCopyPath={(path) => {
              const clip = navigator.clipboard;
              if (!clip?.writeText) {
                setNotice("复制失败");
                return;
              }
              clip.writeText(path).then(
                () => setNotice(`已复制路径：${path}`),
                () => setNotice("复制失败"),
              );
            }}
            onDownload={downloadWorkspaceFile}
            onCreate={handleTreeCreate}
            onRename={handleTreeRename}
            onDelete={handleTreeDelete}
          />
        </div>
      </div>
    </div>
  );
}
