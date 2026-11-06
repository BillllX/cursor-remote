// 文件与源代码管理浮窗
import { useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { sameFile, workspaceLabel } from "../../lib/chat/workspace";
import { extractKbBoardShortcuts } from "../../lib/kbWorkspace";
import FileTree, { FileGlyph, GIT_LABEL } from "../FileTree";
import styles from "./FilesOverlay.module.css";

type FilesOverlayProps = {
  filesOpen: boolean;
  filesDocked?: boolean;
  closeFiles: () => void;
  filesTrap: RefObject<HTMLDivElement | null>;
  sidePane: "search" | "chats" | "files" | "git" | "terminal" | "loop";
  wideIDE?: boolean;
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
  onSwitchMode?: (mode: "files" | "git") => void;
  onRefresh?: () => void;
};

type GitFilter = "all" | "modified" | "added" | "deleted";

function classifyGitLetter(letter: string): "modified" | "added" | "deleted" {
  if (letter === "D") return "deleted";
  if (letter === "A" || letter === "U" || letter === "?") return "added";
  return "modified";
}

export function FilesOverlay({
  filesOpen,
  closeFiles,
  filesTrap,
  sidePane,
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
  onSwitchMode,
  onRefresh,
}: FilesOverlayProps) {
  const isGitMode = sidePane === "git";
  const [gitFilter, setGitFilter] = useState<GitFilter>("all");
  const workspaceName = workspaceLabel(cwd || workspaceRoot, workspaceRoot, assistantName);

  const kbBoards = useMemo(() => extractKbBoardShortcuts(treePaths, filesQuery), [treePaths, filesQuery]);

  const gitEntries = useMemo(
    () => Object.entries(gitStatus).sort(([a], [b]) => a.localeCompare(b)),
    [gitStatus],
  );

  const gitCounts = useMemo(() => {
    let modified = 0;
    let added = 0;
    let deleted = 0;
    for (const [, letter] of gitEntries) {
      const cat = classifyGitLetter(letter);
      if (cat === "modified") modified += 1;
      else if (cat === "added") added += 1;
      else deleted += 1;
    }
    return { total: gitEntries.length, modified, added, deleted };
  }, [gitEntries]);

  const filteredGitEntries = useMemo(() => {
    const q = filesQuery.trim().toLowerCase();
    return gitEntries.filter(([path, letter]) => {
      if (gitFilter !== "all" && classifyGitLetter(letter) !== gitFilter) return false;
      if (q && !path.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [gitEntries, gitFilter, filesQuery]);

  function copyPathText(path: string) {
    const clip = navigator.clipboard;
    if (!clip?.writeText) {
      setNotice("复制失败");
      return;
    }
    clip.writeText(path).then(
      () => setNotice(`已复制路径：${path}`),
      () => setNotice("复制失败"),
    );
  }

  return (
    <div
      className={`files-overlay${filesOpen ? " open" : ""}`}
      onClick={() => closeFiles()}
    >
      <div
        ref={filesTrap}
        className="files-browser workspace-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label={isGitMode ? "源代码管理" : "文件浏览器"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="files-browser-head workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">
                {isGitMode ? "源代码管理" : "文件"}
              </span>
              <span className="workspace-modal-badge">
                {isGitMode ? `${gitCounts.total} 项改动` : `${treePaths.length}${treeTruncated ? "+" : ""} 个文件`}
              </span>
            </div>
            <div className="workspace-modal-sub" title={cwd || workspaceRoot}>
              {workspaceName}
            </div>
          </div>

          <div className="workspace-modal-actions">
            {onSwitchMode ? (
              <button
                type="button"
                className="workspace-modal-btn"
                onClick={() => onSwitchMode(isGitMode ? "files" : "git")}
              >
                {isGitMode ? "浏览全部文件" : `源代码管理 (${gitCounts.total})`}
              </button>
            ) : null}
            {onRefresh ? (
              <button type="button" className="workspace-modal-btn" onClick={onRefresh}>
                刷新
              </button>
            ) : null}
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label={isGitMode ? "关闭源代码管理" : "关闭文件浏览器"}
              title="关闭 (Esc)"
              onClick={closeFiles}
            >
              ×
            </button>
          </div>
        </div>

        {isGitMode ? (
          <div className={styles.gitToolbar}>
            <div className={styles.gitFilterGroup} role="group" aria-label="改动状态筛选">
              {(
                [
                  ["all", `全部 (${gitCounts.total})`],
                  ["modified", `已修改 (${gitCounts.modified})`],
                  ["added", `新增 / 未跟踪 (${gitCounts.added})`],
                  ["deleted", `已删除 (${gitCounts.deleted})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${styles.gitFilterPill}${gitFilter === id ? ` ${styles.gitFilterPillOn}` : ""}`}
                  aria-pressed={gitFilter === id}
                  onClick={() => setGitFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <input
          autoFocus={filesOpen}
          className="files-browser-search"
          placeholder={isGitMode ? "筛选改动的文件名或路径…" : "搜索文件名或路径…"}
          value={filesQuery}
          onChange={(event) => setFilesQuery(event.target.value)}
        />

        {isGitMode ? (
          <div className={`files-browser-body ${styles.gitBody}`}>
            {filteredGitEntries.length > 0 ? (
              <div className={styles.gitList}>
                {filteredGitEntries.map(([path, letter]) => {
                  const fileName = path.split("/").pop() || path;
                  const dirPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
                  return (
                    <div
                      key={path}
                      className={`${styles.gitRow}${sameFile(previewPath, path) ? ` ${styles.gitRowActive}` : ""}`}
                    >
                      <button
                        type="button"
                        className={styles.gitRowMain}
                        title={`点击查看改动对比：${path}`}
                        onClick={() => {
                          openFile(path, undefined, true);
                          closeFiles();
                        }}
                      >
                        <FileGlyph path={path} />
                        <span className={styles.gitFileCopy}>
                          <span className={styles.gitFileName}>{fileName}</span>
                          <span className={styles.gitFilePath}>{dirPath === "." ? path : `${dirPath} · ${path}`}</span>
                        </span>
                        <span className={`git-mark ${letter} ${styles.gitStatusTag}`} title={GIT_LABEL[letter] || letter}>
                          {letter} · {GIT_LABEL[letter] || letter}
                        </span>
                      </button>

                      <div className={styles.gitRowActions}>
                        <button
                          type="button"
                          className={styles.gitActionBtn}
                          onClick={() => {
                            openFile(path, undefined, true);
                            closeFiles();
                          }}
                        >
                          查看 Diff
                        </button>
                        <button
                          type="button"
                          className={styles.gitActionBtn}
                          onClick={() => {
                            openFile(path, undefined, false);
                            closeFiles();
                          }}
                        >
                          打开文件
                        </button>
                        <button
                          type="button"
                          className={styles.gitActionBtn}
                          onClick={() => {
                            handlePickFile(path);
                            closeFiles();
                          }}
                        >
                          @引用
                        </button>
                        <button
                          type="button"
                          className={styles.gitActionBtn}
                          onClick={() => copyPathText(path)}
                        >
                          复制路径
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : gitCounts.total > 0 ? (
              <div className={styles.gitEmpty}>
                <div className={styles.gitEmptyTitle}>没有匹配筛选条件的改动文件</div>
                <div className="loop-meta">可尝试切换上方状态筛选或清空搜索词。</div>
                <div>
                  <button
                    type="button"
                    className="workspace-modal-btn"
                    onClick={() => {
                      setGitFilter("all");
                      setFilesQuery("");
                    }}
                  >
                    重置筛选
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.gitEmpty}>
                <div className={styles.gitEmptyTitle}>当前工作区干净，没有未提交的改动</div>
                <div className="loop-meta">当工作区文件被修改、新增或删除时，会在这里实时列出并支持对比 Diff。</div>
                {onSwitchMode ? (
                  <div>
                    <button
                      type="button"
                      className="new-chat primary"
                      onClick={() => onSwitchMode("files")}
                    >
                      浏览工作区全部文件
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          <div className="files-browser-body">
            {kbBoards.length > 0 ? (
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
                        closeFiles();
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
            {gitEntries.length > 0 ? (
              <div className="changes-list files-browser-changes">
                <div className="side-label">改动 · {gitEntries.length}</div>
                {gitEntries.map(([path, letter]) => (
                  <button
                    key={path}
                    type="button"
                    className={`tree-file${sameFile(previewPath, path) ? " on" : ""}`}
                    title={path}
                    onClick={() => {
                      openFile(path, undefined, true);
                      closeFiles();
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
                closeFiles();
              }}
              onOpen={(path) => {
                openFile(path);
                closeFiles();
              }}
              onCopyPath={copyPathText}
              onDownload={downloadWorkspaceFile}
              onCreate={handleTreeCreate}
              onRename={handleTreeRename}
              onDelete={handleTreeDelete}
            />
          </div>
        )}
      </div>
    </div>
  );
}
