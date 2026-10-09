import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

type Node = { name: string; path: string; children?: Node[] };

export type GitStatusMap = Record<string, string>;

export const GIT_LABEL: Record<string, string> = {
  M: "已修改",
  A: "新文件",
  D: "已删除",
  U: "未跟踪",
  R: "已重命名",
};

function toTree(paths: string[]): Node[] {
  const root: Node[] = [];
  for (const path of paths.slice(0, 8000)) {
    const parts = path.split("/").filter(Boolean);
    let level = root;
    let acc = "";
    parts.forEach((part, index) => {
      acc = acc ? `${acc}/${part}` : part;
      let node = level.find((item) => item.name === part);
      if (!node) {
        node = { name: part, path: acc, children: index < parts.length - 1 ? [] : undefined };
        level.push(node);
      }
      if (node.children) level = node.children;
    });
  }
  return root;
}

function dirtyLetter(path: string, status: GitStatusMap): string | undefined {
  return status[path];
}

function dirDirty(node: Node, status: GitStatusMap): boolean {
  if (!node.children) return Boolean(status[node.path]);
  return node.children.some((child) => dirDirty(child, status));
}

function GitMark({ letter }: { letter?: string }) {
  if (!letter) return null;
  return (
    <span className={`git-mark ${letter}`} title={GIT_LABEL[letter] || letter}>
      {letter}
    </span>
  );
}

function glyphKind(path: string, dir?: boolean) {
  if (dir) return "dir";
  const base = path.replace(/\\/g, "/").split("/").pop() || "";
  if (/\.canvas\.tsx$/i.test(base)) return "canvas";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "ts";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["md", "mdx", "markdown"].includes(ext)) return "md";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["html", "htm"].includes(ext)) return "html";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["py", "pyi"].includes(ext)) return "py";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (["yml", "yaml", "toml", "ini", "env"].includes(ext) || base.startsWith(".env")) return "config";
  if (["sh", "bash", "zsh"].includes(ext)) return "sh";
  if (["rs", "go", "java", "kt", "swift", "c", "h", "cpp", "cc", "rb", "php"].includes(ext)) return "code";
  return "file";
}

function GlyphShape({ kind, open }: { kind: string; open?: boolean }) {
  if (kind === "dir") {
    if (open) {
      return (
        <>
          <path d="M2 3.4h4.1l1.2 1.4H8.6V4.2h5.2c.6 0 1 .4 1 1v1.2H2.4L2 12.4V4.4c0-.6.4-1 1-1Z" fill="currentColor" opacity="0.38" />
          <path d="M1.7 6.4h12.6l-1.3 6.4H3L1.7 6.4Z" fill="currentColor" />
        </>
      );
    }
    return <path d="M2 3.8h4.2l1.2 1.4H14v7.2c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V3.8Z" fill="currentColor" />;
  }
  if (kind === "image") {
    return (
      <>
        <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="6" cy="6.6" r="1.05" fill="currentColor" />
        <path d="m3.6 11.4 2.7-2.9 2.1 2.1 1.5-1.6 2.7 2.4" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      </>
    );
  }
  if (kind === "audio") {
    return (
      <>
        <path d="M4 6.2v3.6h2.2L9.2 13V3.1L6.2 6.2H4Z" fill="currentColor" />
        <path d="M10.7 6a2.6 2.6 0 0 1 0 4M12.4 4.4a4.6 4.6 0 0 1 0 7.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </>
    );
  }
  if (kind === "video") {
    return (
      <>
        <rect x="2.2" y="3.6" width="8.4" height="8.8" rx="1.3" stroke="currentColor" strokeWidth="1.25" />
        <path d="m11.2 6.2 2.6-1.3v6.2l-2.6-1.3V6.2Z" fill="currentColor" />
      </>
    );
  }
  if (kind === "pdf") {
    return (
      <>
        <path d="M3.6 2.4h5.4L12.6 6v7.6H3.6V2.4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="M9 2.6v3.4h3.4" stroke="currentColor" strokeWidth="1.25" />
        <path d="M5.4 10.2h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>
    );
  }
  if (kind === "md") {
    return (
      <>
        <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
        <path d="M5 6.2h6.2M5 8.2h6.2M5 10.2h3.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </>
    );
  }
  if (kind === "canvas") {
    return (
      <>
        <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
        <path d="M2.6 7.2h10.8M8 2.6v10.8" stroke="currentColor" strokeWidth="1.2" />
      </>
    );
  }
  if (kind === "html") {
    return (
      <path
        d="M5.6 4.6 2.6 8l3 3.4M10.4 4.6l3 3.4-3 3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (kind === "code") {
    return (
      <>
        <path d="M6 4.8 3 8l3 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 4.8 13 8l-3 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  }
  if (kind === "sh") {
    return (
      <>
        <rect x="2.4" y="3" width="11.2" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
        <path d="M5 6.2 6.8 8 5 9.8M8.2 10.2h3.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  }
  if (kind === "json") {
    return (
      <path
        d="M6.2 3.6c-1.6 0-2.2.8-2.2 2.2v.8c0 .7-.6 1.2-1.2 1.4.6.2 1.2.7 1.2 1.4v.8c0 1.4.6 2.2 2.2 2.2M9.8 3.6c1.6 0 2.2.8 2.2 2.2v.8c0 .7.6 1.2 1.2 1.4-.6.2-1.2.7-1.2 1.4v.8c0 1.4-.6 2.2-2.2 2.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    );
  }
  if (kind === "css") {
    return (
      <path
        d="M6.4 3.2 5.2 12.8M11.2 3.2 10 12.8M3.4 6.2h9.4M3.2 9.8h9.4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    );
  }
  if (kind === "ts") {
    return (
      <>
        <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2" fill="currentColor" opacity="0.16" />
        <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5 7.4h6.2M8.1 7.4v5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </>
    );
  }
  if (kind === "js") {
    return (
      <>
        <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2.4" fill="currentColor" opacity="0.16" />
        <rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2.4" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6.6 6.6v4.2c0 1.1.5 1.6 1.5 1.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        <path d="M9.4 8.4c.7-.6 2.4-.7 2.4.8 0 1.6-2.4 1.3-2.4 2.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </>
    );
  }
  if (kind === "py") {
    return (
      <>
        <path d="M8.6 3.4h2.2c1.4 0 2 .6 2 2v2.2H8.8c-1.2 0-1.8-.6-1.8-1.8V5c0-.9.6-1.6 1.6-1.6Z" fill="currentColor" />
        <path d="M7.4 12.6H5.2c-1.4 0-2-.6-2-2V8.2h4c1.2 0 1.8.6 1.8 1.8V11c0 .9-.6 1.6-1.6 1.6Z" fill="currentColor" opacity="0.55" />
        <circle cx="11.4" cy="4.6" r="0.7" fill="var(--bg-panel, #fff)" />
        <circle cx="4.6" cy="11.4" r="0.7" fill="var(--bg-panel, #fff)" />
      </>
    );
  }
  if (kind === "config") {
    return (
      <>
        <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.25" />
        <path
          d="M8 2.6v1.6M8 11.8v1.6M2.6 8h1.6M11.8 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M11.9 4.1l-1.1 1.1M5.2 10.8l-1.1 1.1"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </>
    );
  }
  return (
    <>
      <path d="M4 2.4h5.2L12.4 5.6v8H4V2.4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M9.1 2.6v3h3.1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M6 9.4h4M6 11.3h2.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </>
  );
}

export function FileGlyph({
  path,
  dir,
  open,
}: {
  path: string;
  dir?: boolean;
  open?: boolean;
}) {
  const kind = glyphKind(path, dir);
  return (
    <svg
      className={`tree-glyph ${kind}${open ? " open" : ""}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <GlyphShape kind={kind} open={open} />
    </svg>
  );
}

function rowPad(depth: number) {
  return 14 + depth * 16;
}

function TreeChevron() {
  return (
    <svg className="tree-chevron" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.2 1.6 6.8 5 3.2 8.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function parentPath(path: string) {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

function joinPath(dir: string, name: string) {
  const clean = name.replace(/[\\/]+/g, "/").replace(/^\.?\//, "").replace(/\.\./g, "").trim();
  if (!clean) return "";
  return dir ? `${dir}/${clean}` : clean;
}

export default function FileTree({
  paths,
  truncated = false,
  status = {},
  query = "",
  variant = "panel",
  onPick,
  onOpen,
  onCopyPath,
  onDownload,
  onCreate,
  onRename,
  onDelete,
}: {
  paths: string[];
  truncated?: boolean;
  status?: GitStatusMap;
  query?: string;
  variant?: "panel" | "browser";
  onPick: (path: string) => void;
  onOpen?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  onDownload?: (path: string) => void;
  onCreate?: (path: string, kind: "file" | "dir") => void;
  onRename?: (from: string, to: string) => void;
  onDelete?: (path: string, dir: boolean) => void;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return paths;
    return paths.filter((path) => path.toLowerCase().includes(q));
  }, [paths, query]);
  const tree = useMemo(() => toTree(filtered), [filtered]);
  const expandAll = Boolean(query.trim());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  function isDirOpen(node: Node, depth: number) {
    if (expandAll) return true;
    if (openDirs[node.path] != null) return openDirs[node.path];
    return depth < 1;
  }

  const rows = useMemo(() => {
    const acc: { node: Node; depth: number; dir: boolean }[] = [];
    const walk = (nodes: Node[], depth: number) => {
      for (const node of nodes) {
        const dir = Boolean(node.children);
        acc.push({ node, depth, dir });
        const opened = dir && (expandAll || (openDirs[node.path] != null ? openDirs[node.path] : depth < 1));
        if (dir && opened && node.children) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return acc;
  }, [tree, openDirs, expandAll]);

  useEffect(() => {
    if (!rows.length) {
      setCursor("");
      return;
    }
    if (!rows.some((row) => row.node.path === cursor)) setCursor(rows[0].node.path);
  }, [rows, cursor]);

  useEffect(() => {
    if (!cursor || !rootRef.current) return;
    const row = rootRef.current.querySelector(`[data-tree-path="${CSS.escape(cursor)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  useEffect(() => {
    function close() {
      setMenu(null);
    }
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  function toggleDir(path: string, depth: number, next?: boolean) {
    setOpenDirs((prev) => {
      const current = prev[path] != null ? prev[path] : depth < 1;
      return { ...prev, [path]: next ?? !current };
    });
  }

  function activate(row: { node: Node; depth: number; dir: boolean }) {
    setCursor(row.node.path);
    if (row.dir) toggleDir(row.node.path, row.depth);
    else if (onOpen) onOpen(row.node.path);
    else onPick(row.node.path);
  }

  function startCreate(dir: string, kind: "file" | "dir") {
    setMenu(null);
    setRenaming(null);
    setCreating({ dir, kind });
    setNameDraft("");
    if (dir) setOpenDirs((prev) => ({ ...prev, [dir]: true }));
  }

  function commitCreate() {
    if (!creating || !onCreate) {
      setCreating(null);
      return;
    }
    const path = joinPath(creating.dir, nameDraft);
    setCreating(null);
    setNameDraft("");
    if (path) onCreate(path, creating.kind);
  }

  function startRename(path: string) {
    setMenu(null);
    setCreating(null);
    setRenaming(path);
    setNameDraft(path.split("/").pop() || path);
  }

  function commitRename() {
    if (!renaming || !onRename) {
      setRenaming(null);
      return;
    }
    const next = joinPath(parentPath(renaming), nameDraft);
    const from = renaming;
    setRenaming(null);
    setNameDraft("");
    if (next && next !== from) onRename(from, next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (creating || renaming) return;
    if (!rows.length) return;
    const index = Math.max(
      0,
      rows.findIndex((row) => row.node.path === cursor),
    );
    const row = rows[index];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
      setCursor(rows[next].node.path);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setCursor(rows[0].node.path);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setCursor(rows[rows.length - 1].node.path);
      return;
    }
    if (event.key === "ArrowRight" && row) {
      event.preventDefault();
      if (row.dir) toggleDir(row.node.path, row.depth, true);
      else if (onOpen) onOpen(row.node.path);
      return;
    }
    if (event.key === "ArrowLeft" && row) {
      event.preventDefault();
      if (row.dir && isDirOpen(row.node, row.depth)) {
        toggleDir(row.node.path, row.depth, false);
        return;
      }
      const parent = parentPath(row.node.path);
      if (parent && rows.some((item) => item.node.path === parent)) setCursor(parent);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && row) {
      event.preventDefault();
      if (row.dir) toggleDir(row.node.path, row.depth);
      else if (event.key === "Enter" && event.shiftKey) onPick(row.node.path);
      else activate(row);
    }
    if (event.key === "F2" && row && onRename) {
      event.preventDefault();
      startRename(row.node.path);
    }
    if ((event.key === "Delete" || event.key === "Backspace") && row && onDelete && event.metaKey) {
      event.preventDefault();
      onDelete(row.node.path, row.dir);
    }
  }

  function openMenu(event: MouseEvent, path: string, dir: boolean) {
    event.preventDefault();
    event.stopPropagation();
    setCursor(path);
    setMenu({ x: event.clientX, y: event.clientY, path, dir });
  }

  if (!tree.length && !creating) {
    return (
      <div className="tree-empty">
        <div className="tree-empty-copy">{query.trim() ? "没有匹配的文件" : "没有文件列表"}</div>
        {onCreate && !query.trim() ? (
          <button type="button" className="tree-empty-add" onClick={() => startCreate("", "file")}>
            新建文件
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`file-tree${variant === "browser" ? " file-tree-browser" : ""}`} ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} role="tree">
      {onCreate ? (
        <div className="tree-actions">
          <button type="button" className="tree-action" onClick={() => startCreate("", "file")}>
            新建文件
          </button>
          <button type="button" className="tree-action" onClick={() => startCreate("", "dir")}>
            新建目录
          </button>
        </div>
      ) : null}
      {creating && creating.dir === "" ? (
        <NameInput
          kind={creating.kind}
          value={nameDraft}
          onChange={setNameDraft}
          onCommit={commitCreate}
          onCancel={() => setCreating(null)}
        />
      ) : null}
      {tree.map((node) => (
        <Branch
          key={node.path}
          node={node}
          depth={0}
          status={status}
          cursor={cursor}
          openDirs={openDirs}
          expandAll={expandAll}
          variant={variant}
          creating={creating}
          renaming={renaming}
          nameDraft={nameDraft}
          onNameDraft={setNameDraft}
          onCommitCreate={commitCreate}
          onCancelCreate={() => setCreating(null)}
          onCommitRename={commitRename}
          onCancelRename={() => setRenaming(null)}
          onCursor={(path) => {
            setCursor(path);
            rootRef.current?.focus();
          }}
          onToggle={toggleDir}
          onPick={onPick}
          onOpen={onOpen}
          onMenu={openMenu}
        />
      ))}
      {menu ? (
        <div
          className="tree-menu"
          style={{
            left: Math.max(4, Math.min(menu.x, window.innerWidth - 168)),
            top: Math.max(4, Math.min(menu.y, window.innerHeight - 270)),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {menu.dir ? null : (
            <button
              type="button"
              onClick={() => {
                const path = menu.path;
                setMenu(null);
                onPick(path);
              }}
            >
              引用到草稿
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const path = menu.path;
              setMenu(null);
              onCopyPath?.(path);
            }}
          >
            复制路径
          </button>
          {onDownload && !menu.dir ? (
            <button
              type="button"
              onClick={() => {
                const path = menu.path;
                setMenu(null);
                onDownload(path);
              }}
            >
              下载
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => startCreate(menu.dir ? menu.path : parentPath(menu.path), "file")}
          >
            新建文件
          </button>
          <button
            type="button"
            onClick={() => startCreate(menu.dir ? menu.path : parentPath(menu.path), "dir")}
          >
            新建目录
          </button>
          {onRename ? (
            <button type="button" onClick={() => startRename(menu.path)}>
              重命名
            </button>
          ) : null}
          {onDelete ? (
            <button type="button" onClick={() => {
              setMenu(null);
              onDelete(menu.path, menu.dir);
            }}>
              删除
            </button>
          ) : null}
        </div>
      ) : null}
      {truncated ? (
        <div className="tree-truncated">工作区文件太多，清单被截断了，用搜索缩小范围。</div>
      ) : null}
    </div>
  );
}

function NameInput({
  kind,
  value,
  onChange,
  onCommit,
  onCancel,
  pad,
}: {
  kind: "file" | "dir" | "rename";
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  pad?: number;
}) {
  return (
    <input
      className="tree-rename"
      style={pad != null ? { marginLeft: pad } : undefined}
      autoFocus
      placeholder={kind === "dir" ? "文件夹名" : kind === "file" ? "文件名" : ""}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCommit}
    />
  );
}

function Branch({
  node,
  depth,
  status,
  cursor,
  openDirs,
  expandAll,
  variant,
  creating,
  renaming,
  nameDraft,
  onNameDraft,
  onCommitCreate,
  onCancelCreate,
  onCommitRename,
  onCancelRename,
  onCursor,
  onToggle,
  onPick,
  onOpen,
  onMenu,
}: {
  node: Node;
  depth: number;
  status: GitStatusMap;
  cursor: string;
  openDirs: Record<string, boolean>;
  expandAll: boolean;
  variant: "panel" | "browser";
  creating: { dir: string; kind: "file" | "dir" } | null;
  renaming: string | null;
  nameDraft: string;
  onNameDraft: (value: string) => void;
  onCommitCreate: () => void;
  onCancelCreate: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onCursor: (path: string) => void;
  onToggle: (path: string, depth: number, next?: boolean) => void;
  onPick: (path: string) => void;
  onOpen?: (path: string) => void;
  onMenu: (event: MouseEvent, path: string, dir: boolean) => void;
}) {
  const opened = expandAll || (openDirs[node.path] != null ? openDirs[node.path] : depth < 1);
  const on = cursor === node.path;
  const parent = parentPath(node.path);
  if (node.children) {
    return (
      <details className={`tree-dir${on ? " on" : ""}`} open={opened}>
        <summary
          data-tree-path={node.path}
          tabIndex={-1}
          style={{ paddingLeft: rowPad(depth) }}
          onClick={(event) => {
            event.preventDefault();
            onCursor(node.path);
            onToggle(node.path, depth);
          }}
          onContextMenu={(event) => onMenu(event, node.path, true)}
        >
          {renaming === node.path ? (
            <NameInput
              kind="rename"
              value={nameDraft}
              onChange={onNameDraft}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
          ) : (
            <>
              <FileGlyph path={node.path} dir open={opened} />
              <span className="tree-file-name">{node.name}</span>
            </>
          )}
          {dirDirty(node, status) ? <span className="git-mark dir" title="目录里有改动">•</span> : null}
          <TreeChevron />
        </summary>
        {opened ? (
          <>
            {creating?.dir === node.path ? (
              <NameInput
                kind={creating.kind}
                value={nameDraft}
                onChange={onNameDraft}
                onCommit={onCommitCreate}
                onCancel={onCancelCreate}
                pad={rowPad(depth + 1)}
              />
            ) : null}
            {node.children.map((child) => (
              <Branch
                key={child.path}
                node={child}
                depth={depth + 1}
                status={status}
                cursor={cursor}
                openDirs={openDirs}
                expandAll={expandAll}
                variant={variant}
                creating={creating}
                renaming={renaming}
                nameDraft={nameDraft}
                onNameDraft={onNameDraft}
                onCommitCreate={onCommitCreate}
                onCancelCreate={onCancelCreate}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                onCursor={onCursor}
                onToggle={onToggle}
                onPick={onPick}
                onOpen={onOpen}
                onMenu={onMenu}
              />
            ))}
          </>
        ) : null}
      </details>
    );
  }
  if (renaming === node.path) {
    return (
      <div
        data-tree-path={node.path}
        className={`tree-file${on ? " on" : ""}`}
        style={{ paddingLeft: rowPad(depth) }}
      >
        <NameInput
          kind="rename"
          value={nameDraft}
          onChange={onNameDraft}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      data-tree-path={node.path}
      tabIndex={-1}
      className={`tree-file${on ? " on" : ""}`}
      style={{ paddingLeft: rowPad(depth) }}
      onClick={() => {
        onCursor(node.path);
        onOpen ? onOpen(node.path) : onPick(node.path);
      }}
      onDoubleClick={() => onPick(node.path)}
      onContextMenu={(event) => onMenu(event, node.path, false)}
    >
      <FileGlyph path={node.path} />
      <span className="tree-file-copy">
        <span className="tree-file-name">{node.name}</span>
        {variant === "browser" && parent ? <span className="tree-file-path">{parent}</span> : null}
      </span>
      <GitMark letter={dirtyLetter(node.path, status)} />
    </button>
  );
}
