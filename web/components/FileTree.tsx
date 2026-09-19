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
  onPick,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  paths: string[];
  truncated?: boolean;
  status?: GitStatusMap;
  onPick: (path: string) => void;
  onOpen?: (path: string) => void;
  onCreate?: (path: string, kind: "file" | "dir") => void;
  onRename?: (from: string, to: string) => void;
  onDelete?: (path: string, dir: boolean) => void;
}) {
  const tree = useMemo(() => toTree(paths), [paths]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [cursor, setCursor] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  function isDirOpen(node: Node, depth: number) {
    if (openDirs[node.path] != null) return openDirs[node.path];
    return depth < 1;
  }

  const rows = useMemo(() => {
    const acc: { node: Node; depth: number; dir: boolean }[] = [];
    const walk = (nodes: Node[], depth: number) => {
      for (const node of nodes) {
        const dir = Boolean(node.children);
        acc.push({ node, depth, dir });
        const opened = dir && (openDirs[node.path] != null ? openDirs[node.path] : depth < 1);
        if (dir && opened && node.children) walk(node.children, depth + 1);
      }
    };
    walk(tree, 0);
    return acc;
  }, [tree, openDirs]);

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
        没有文件列表
        {onCreate ? (
          <button type="button" className="tree-empty-add" onClick={() => startCreate("", "file")}>
            新建文件
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="file-tree" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} role="tree">
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
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
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
        <div className="tree-truncated">文件很多，只列出一部分。用搜索或 @ 打开其余的。</div>
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
  const opened = openDirs[node.path] != null ? openDirs[node.path] : depth < 1;
  const on = cursor === node.path;
  if (node.children) {
    return (
      <details className={`tree-dir${on ? " on" : ""}`} open={opened}>
        <summary
          data-tree-path={node.path}
          tabIndex={-1}
          style={{ paddingLeft: 8 + depth * 10 }}
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
            <span>{node.name}</span>
          )}
          {dirDirty(node, status) ? <span className="git-mark dir" title="目录里有改动">•</span> : null}
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
                pad={18 + (depth + 1) * 10}
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
        style={{ paddingLeft: 18 + depth * 10 }}
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
      style={{ paddingLeft: 18 + depth * 10 }}
      onClick={() => {
        onCursor(node.path);
        onOpen ? onOpen(node.path) : onPick(node.path);
      }}
      onDoubleClick={() => onPick(node.path)}
      onContextMenu={(event) => onMenu(event, node.path, false)}
    >
      <span className="tree-file-name">{node.name}</span>
      <GitMark letter={dirtyLetter(node.path, status)} />
    </button>
  );
}
