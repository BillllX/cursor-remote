"use client";

import { useEffect, useRef, useState } from "react";
import type { SharedFileEntry, SharedWorkspace, SharePerson, WorkspaceShareRequest } from "@shared/workspaceShare";
import { useFocusTrap } from "../../lib/useFocusTrap";
import styles from "./Sharing.module.css";

export type ShareCall = <T>(action: Omit<WorkspaceShareRequest, "type" | "requestId">) => Promise<T>;
type People = { people: SharePerson[]; memberIds: string[]; memberRevision: string };

export function ShareWorkspaceDialog({
  path,
  name,
  call,
  close,
}: {
  path: string;
  name: string;
  call: ShareCall;
  close: () => void;
}) {
  const [data, setData] = useState<People>();
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useFocusTrap<HTMLDivElement>(true);
  useEffect(() => {
    let active = true;
    void call<People>({ action: "people", workspace: path })
      .then((result) => {
        if (active) {
          setData(result);
          setSelected(result.memberIds);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, call]);
  async function save() {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    try {
      await call({ action: "set", workspace: path, memberIds: selected, memberRevision: data.memberRevision });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = data?.people.filter((p) =>
    [p.name, p.id].some((s) => s.toLowerCase().includes(query.trim().toLowerCase())),
  );
  return (
    <div className="search-overlay open" onClick={close}>
      <div
        ref={dialog}
        className={`search-box ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-share-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <h2 id="workspace-share-title">共享「{name}」</h2>
        <p>所选同事登录后可直接打开此工作区、查看和编辑普通文件。个人对话、记忆和凭证各自保留。</p>
        <input
          className="search-input"
          aria-label="搜索同事"
          placeholder="按姓名搜索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={styles.people}>
          {filtered?.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={selected.includes(p.id)}
                disabled={busy}
                onChange={(e) =>
                  setSelected((previous) =>
                    e.target.checked ? [...previous, p.id] : previous.filter((id) => id !== p.id),
                  )
                }
              />
              <span>
                {p.name} <small>{p.id}</small>
              </span>
            </label>
          ))}
          {data && !filtered?.length && <p>没有匹配的同事</p>}
        </div>
        <p role="status">{error || (!data ? "正在读取同事名单…" : `已选 ${selected.length} 位同事`)}</p>
        <footer>
          <button type="button" onClick={close}>
            取消
          </button>
          <button type="button" disabled={!data || busy} onClick={() => void save()}>
            {busy ? "正在保存…" : "保存共享名单"}
          </button>
        </footer>
      </div>
    </div>
  );
}

type OpenFile = { path: string; content: string; revision: string };
export function SharedWorkspaceFiles({
  workspace,
  call,
  onSwitch,
  onUnavailable,
}: {
  workspace: SharedWorkspace;
  call: ShareCall;
  onSwitch: () => void;
  onUnavailable: () => void;
}) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<SharedFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [file, setFile] = useState<OpenFile>();
  const [draft, setDraft] = useState("");
  const [comparison, setComparison] = useState<OpenFile>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const dirty = !!file && file.content !== draft;
  function fail(e: unknown) {
    if (!alive.current) return;
    const error = e as Error & { code?: string };
    if (error.code === "UNAVAILABLE") onUnavailable();
    else setStatus(error.message);
  }
  useEffect(() => {
    let current = true;
    void call<{ items: SharedFileEntry[]; truncated: boolean }>({ action: "files", workspace: workspace.id, path: dir })
      .then((result) => {
        if (current) {
          setEntries(result.items);
          setTruncated(result.truncated);
        }
      })
      .catch((error) => {
        if (current) fail(error);
      });
    return () => {
      current = false;
    };
    // 项目和目录变化时重新读取，当前文件编辑状态由独立操作维护。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, dir, call]);
  async function read(path: string) {
    const result = await call<Omit<OpenFile, "path">>({ action: "read", workspace: workspace.id, path });
    return { path, ...result };
  }
  async function open(path: string) {
    if (dirty && !confirm("当前文件有未保存的修改。确认切换？")) return;
    setBusy(true);
    setStatus("");
    setComparison(undefined);
    try {
      const opened = await read(path);
      if (alive.current) {
        setFile(opened);
        setDraft(opened.content);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!file || !dirty) return;
    setBusy(true);
    setStatus("");
    setComparison(undefined);
    try {
      const { revision } = await call<{ revision: string }>({
        action: "write",
        workspace: workspace.id,
        path: file.path,
        content: draft,
        revision: file.revision,
      });
      if (alive.current) {
        setFile({ ...file, revision, content: draft });
        setStatus("已保存");
      }
    } catch (e) {
      fail(e);
      if ((e as { code?: string }).code === "CONFLICT") {
        try {
          const latest = await read(file.path);
          if (alive.current) setComparison(latest);
        } catch (failure) {
          fail(failure);
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const filePath = (name: string) => (dir ? dir + "/" + name : name);
  return (
    <main className={`main ${styles.workbench}`} aria-label="工作区">
      <header>
        <div>
          <h1>{workspace.name}</h1>
          <span>来自 {workspace.ownerName}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!dirty || confirm("当前文件有未保存的修改。确认切换工作区？")) onSwitch();
          }}
        >
          切换工作区
        </button>
      </header>
      <div className={styles.columns}>
        <nav aria-label="文件">
          <h2>文件</h2>
          {dir && (
            <button type="button" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}>
              返回上一级
            </button>
          )}
          {entries.map((e) => (
            <button
              key={e.name}
              type="button"
              disabled={busy}
              onClick={() => (e.directory ? setDir(filePath(e.name)) : void open(filePath(e.name)))}
            >
              {e.directory ? "▸ " : ""}
              {e.name}
            </button>
          ))}
          {truncated && <p>这个文件夹只显示前 400 项。</p>}
        </nav>
        <section aria-label="文件内容">
          {file ? (
            <>
              <h2>{file.path}</h2>
              <textarea
                aria-label="文件内容"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                readOnly={busy}
              />
              <button type="button" disabled={busy || !dirty || !!comparison} onClick={() => void save()}>
                保存文件
              </button>
            </>
          ) : (
            <p>从文件列表打开一个文本文件。</p>
          )}
          {comparison && (
            <>
              <h3>最新保存的版本</h3>
              <textarea aria-label="最新保存的版本" value={comparison.content} readOnly />
              <button
                type="button"
                onClick={() => {
                  setFile(comparison);
                  setComparison(undefined);
                  setStatus("已更新保存基准，草稿已保留。");
                }}
              >
                保留草稿，基于新版继续编辑
              </button>
            </>
          )}
          <p role="status">{status}</p>
        </section>
      </div>
    </main>
  );
}
