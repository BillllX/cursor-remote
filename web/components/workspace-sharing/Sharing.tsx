"use client";

import { useEffect, useRef, useState } from "react";
import type {
  SharedFileEntry,
  SharedWorkspace,
  SharedWorkspaceTurn,
  SharedWorkspaceAnswer,
  SharedWorkspaceApplied,
  SharePerson,
  WorkspaceShareRequest,
} from "@shared/workspaceShare";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { FileGlyph } from "../FileTree";
import { IconClose, IconRail } from "../chromeIcons";
import { Composer } from "../chat/Composer";
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
  const [reload, setReload] = useState(0);
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
  }, [path, call, reload]);
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
  const search = query.trim().toLowerCase();
  const filtered = data?.people.filter((person) =>
    [person.name, person.id].some((value) => value.toLowerCase().includes(search)),
  );
  const names = new Map<string, number>();
  for (const { name } of data?.people ?? []) names.set(name, (names.get(name) ?? 0) + 1);
  const changed = Boolean(
    data && (selected.length !== data.memberIds.length || selected.some((id) => !data.memberIds.includes(id))),
  );
  function reloadPeople() {
    setData(undefined);
    setError("");
    setReload((version) => version + 1);
  }
  return (
    <div className="search-overlay workspace-modal-overlay open" onClick={busy ? undefined : close}>
      <div
        ref={dialog}
        className={`search-box workspace-modal-box ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-share-title"
        aria-describedby="workspace-share-description"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <header className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <h2 className="workspace-modal-title" id="workspace-share-title">
              共享工作区
            </h2>
            <div className="workspace-modal-sub">{name}</div>
          </div>
          <button
            type="button"
            className="files-browser-close workspace-modal-close"
            aria-label="关闭"
            onClick={close}
            disabled={busy}
          >
            <IconClose size={16} />
          </button>
        </header>
        <div className={`workspace-modal-body ${styles.shareBody}`} aria-busy={!data && !error}>
          <p className="workspace-modal-sub" id="workspace-share-description">
            所选同事可在工作区列表打开此目录，并使用 Agent 处理共享文件。
          </p>
          <label className={styles.search}>
            <IconRail name="search" />
            <input
              className="search-input"
              type="search"
              aria-label="搜索同事"
              placeholder="按姓名搜索"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {filtered?.length ? (
            <div className={styles.people} role="group" aria-label="同事">
              {filtered.map((person) => (
                <label className={styles.person} key={person.id}>
                  <IconRail name="account" />
                  <span>
                    {person.name}
                    {(names.get(person.name) ?? 0) > 1 && <small>{person.id}</small>}
                  </span>
                  <input
                    type="checkbox"
                    checked={selected.includes(person.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked ? [...previous, person.id] : previous.filter((id) => id !== person.id),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          ) : (
            !error && (
              <p className={styles.muted} role="status">
                {!data ? "正在读取同事名单…" : data.people.length ? "没有匹配的同事" : "没有可共享的同事"}
              </p>
            )
          )}
          {error && (
            <div className={styles.shareError}>
              <p role="alert">{error}</p>
              <button className="workspace-modal-btn" type="button" onClick={reloadPeople}>
                重新读取名单
              </button>
            </div>
          )}
        </div>
        <footer className={styles.dialogFooter}>
          <span className={styles.muted} role="status">
            {data ? `已选 ${selected.length} 位同事` : ""}
          </span>
          <div className="workspace-modal-actions">
            <button type="button" className="workspace-modal-btn" onClick={close} disabled={busy}>
              取消
            </button>
            <button type="button" className="new-chat primary" disabled={!changed || busy} onClick={() => void save()}>
              {busy ? "正在保存…" : "保存"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SharedWorkspaceQuestions({
  workspace,
  filePath,
  call,
  onUnavailable,
  canEdit,
  models,
  defaultModel,
  connected,
  refreshFiles,
}: {
  workspace: SharedWorkspace;
  filePath?: string;
  call: ShareCall;
  onUnavailable: () => void;
  canEdit: boolean;
  models: string[];
  defaultModel: string;
  connected: boolean;
  refreshFiles: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<(SharedWorkspaceTurn & SharedWorkspaceAnswer)[]>([]);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [pickedModel, setModel] = useState("");
  const [confirmWrites, setConfirmWrites] = useState(true);
  const [applying, setApplying] = useState(false);
  const mounted = useRef(true);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns, pending]);
  const cursorModels = models.filter((model) => !model.includes(":"));
  const model = cursorModels.includes(pickedModel)
    ? pickedModel
    : cursorModels.includes(defaultModel)
      ? defaultModel
      : cursorModels[0] || "";
  function fail(failure: unknown) {
    const err = failure as Error & { code?: string };
    if (err.code === "UNAVAILABLE") onUnavailable();
    else setError(err.message);
  }
  async function ask(raw?: string) {
    const text = (raw ?? question).trim();
    if (!text || pending || !connected) return;
    setPending(text);
    setQuestion("");
    setError("");
    try {
      const answer = await call<SharedWorkspaceAnswer>({
        action: "ask",
        workspace: workspace.id,
        path: filePath,
        question: text,
        model,
        confirmWrites: canEdit ? confirmWrites : undefined,
        history: turns.slice(-4).map(({ question, answer }) => ({ question, answer })),
      });
      if (!mounted.current) return;
      setTurns((previous) => [...previous, { question: text, ...answer }]);
      if (answer.changes?.applied.length) refreshFiles();
    } catch (failure) {
      if (!mounted.current) return;
      fail(failure);
      setQuestion((current) => current || text);
    } finally {
      if (mounted.current) setPending("");
    }
  }
  function updateTurn(index: number, changes?: SharedWorkspaceApplied) {
    setTurns((previous) => previous.map((turn, i) => (i === index ? { ...turn, pending: undefined, changes } : turn)));
  }
  async function apply(index: number, changeId: string, discard = false) {
    setApplying(true);
    setError("");
    try {
      const changes = await call<SharedWorkspaceApplied>({
        action: "apply",
        workspace: workspace.id,
        changeId,
        discard,
      });
      if (!mounted.current) return;
      updateTurn(index, discard ? undefined : changes);
      if (changes.applied.length) refreshFiles();
    } catch (failure) {
      if (mounted.current) fail(failure);
    } finally {
      if (mounted.current) setApplying(false);
    }
  }
  return (
    <section className={styles.questions} aria-label="工作区 Agent">
      <div className="thread" role="log" aria-live="polite">
        <div className="thread-inner">
          {!turns.length && !pending && <p className={styles.empty}>交代 Agent 查阅资料或修改文件</p>}
          {turns.map((turn, index) => (
            <article className="turn" key={index}>
              <div className="turn-user">
                <div className="user-bubble">{turn.question}</div>
              </div>
              <div className="assistant">
                <p className={styles.answer}>{turn.answer}</p>
                {turn.sources.length > 0 && <small>读取了 {turn.sources.join("、")}</small>}
                {turn.pending && (
                  <div className="approval-row">
                    <div>
                      {turn.pending.changes.map((change) => (
                        <details key={change.path}>
                          <summary>
                            {change.kind === "write" ? "修改" : "新建"} {change.path}
                          </summary>
                          {change.preview && <pre>{change.preview}</pre>}
                        </details>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="pill"
                      disabled={applying}
                      onClick={() => void apply(index, turn.pending!.id)}
                    >
                      批准写入
                    </button>
                    <button
                      type="button"
                      className="pill"
                      disabled={applying}
                      onClick={() => void apply(index, turn.pending!.id, true)}
                    >
                      拒绝
                    </button>
                  </div>
                )}
                {turn.changes && (
                  <div role="status">
                    {turn.changes.applied.length > 0 && <p>已写入 {turn.changes.applied.join("、")}</p>}
                    {turn.changes.failed.map(({ path, error }) => (
                      <p key={path}>
                        {path} · {error}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
          {pending && (
            <article className="turn">
              <div className="turn-user">
                <div className="user-bubble">{pending}</div>
              </div>
              <p>Agent 正在处理…</p>
            </article>
          )}
          {error && <p role="alert">{error}</p>}
          <div ref={bottom} />
        </div>
      </div>
      <div className="composer-dock">
        <div className="composer-wrap">
          <Composer
            sharedScope={{ editable: canEdit }}
            draft={question}
            epoch={0}
            images={[]}
            model={model}
            models={cursorModels}
            setModel={setModel}
            confirmWrites={confirmWrites}
            setConfirmWrites={setConfirmWrites}
            policy="baseline"
            setPolicy={() => {}}
            busy={Boolean(pending)}
            connected={connected}
            onSubmit={(raw) => void ask(raw)}
            onStop={() => void call({ action: "cancel", workspace: workspace.id }).catch(fail)}
            onUndo={() => {}}
            onRestore={() => {}}
            checkpoints={[]}
            onAddImages={() => {}}
            onRemoveImage={() => {}}
            fileHits={[]}
            mentionQuery={null}
            onDraftChange={setQuestion}
            onPickFile={() => {}}
            onOpenFile={() => {}}
            onRemoveMention={() => {}}
            onDismissMention={() => {}}
          />
        </div>
      </div>
    </section>
  );
}

type OpenFile = { path: string; content: string; revision: string };
export function SharedWorkspaceFiles({
  workspace,
  call,
  canAsk,
  canEdit,
  models,
  defaultModel,
  connected,
  onSwitch,
  onUnavailable,
}: {
  workspace: SharedWorkspace;
  call: ShareCall;
  canAsk: boolean;
  canEdit: boolean;
  models: string[];
  defaultModel: string;
  connected: boolean;
  onSwitch: () => void;
  onUnavailable: () => void;
}) {
  const [dir, setDir] = useState("");
  const [filesOpen, setFilesOpen] = useState(!canAsk);
  const [filesRevision, refreshFiles] = useState(0);
  const [entries, setEntries] = useState<SharedFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [directoryState, setDirectoryState] = useState<"loading" | "ready" | "failed">("loading");
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
          setDirectoryState("ready");
        }
      })
      .catch((error) => {
        if (current) {
          setDirectoryState("failed");
          fail(error);
        }
      });
    return () => {
      current = false;
    };
    // 项目和目录变化时重新读取，当前文件编辑状态由独立操作维护。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, dir, call, filesRevision]);
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
  function openDirectory(path: string) {
    setDirectoryState("loading");
    setEntries([]);
    setTruncated(false);
    setDir(path);
  }
  const filePath = (name: string) => (dir ? dir + "/" + name : name);
  return (
    <main className={`main ${styles.workbench}`} aria-label="工作区">
      <header className={styles.workbenchHeader}>
        <div className={styles.workspaceIdentity}>
          <IconRail name="workspace" size={18} />
          <div>
            <h1>{workspace.name}</h1>
            <span>来自 {workspace.ownerName}</span>
          </div>
        </div>
        <div className={styles.workbenchActions}>
          <button
            className="workspace-modal-btn"
            type="button"
            onClick={() => {
              if (!dirty || confirm("当前文件有未保存的修改。确认切换工作区？")) onSwitch();
            }}
          >
            切换工作区
          </button>
          {canAsk && (
            <button
              type="button"
              className={`pill${filesOpen ? " on" : ""}`}
              aria-pressed={filesOpen}
              onClick={() => setFilesOpen(!filesOpen)}
            >
              <IconRail name="files" size={14} /> 文件
            </button>
          )}
        </div>
      </header>
      {canAsk && (
        <div className={styles.conversation} hidden={filesOpen}>
          <SharedWorkspaceQuestions
            workspace={workspace}
            filePath={file?.path}
            call={call}
            onUnavailable={onUnavailable}
            canEdit={canEdit}
            models={models}
            defaultModel={defaultModel}
            connected={connected}
            refreshFiles={() => refreshFiles((version) => version + 1)}
          />
        </div>
      )}
      <div className={styles.columns} hidden={!filesOpen}>
        <nav aria-label="文件">
          <h2>{dir ? dir.split("/").at(-1) : "文件"}</h2>
          {dir && (
            <button
              className="tree-file"
              type="button"
              onClick={() => openDirectory(dir.split("/").slice(0, -1).join("/"))}
            >
              返回上一级
            </button>
          )}
          {entries.map((e) => (
            <button
              key={e.name}
              className={`tree-file${file?.path === filePath(e.name) ? ` ${styles.selectedFile}` : ""}`}
              type="button"
              disabled={busy}
              aria-current={file?.path === filePath(e.name) ? "true" : undefined}
              title={e.name}
              onClick={() => (e.directory ? openDirectory(filePath(e.name)) : void open(filePath(e.name)))}
            >
              <FileGlyph path={e.name} dir={e.directory} />
              <span className="tree-file-name">{e.name}</span>
            </button>
          ))}
          {truncated && <p className={styles.muted}>这个文件夹只显示前 400 项。</p>}
          {directoryState === "loading" && (
            <p className={styles.muted} role="status">
              正在读取文件…
            </p>
          )}
          {directoryState === "ready" && !entries.length && <p className={styles.muted}>这个文件夹暂无文件</p>}
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
              <button
                className="new-chat primary"
                type="button"
                disabled={busy || !dirty || !!comparison}
                onClick={() => void save()}
              >
                保存文件
              </button>
            </>
          ) : (
            <p className={styles.muted}>选择一个文本文件查看或编辑</p>
          )}
          {comparison && (
            <>
              <h3>最新保存的版本</h3>
              <textarea aria-label="最新保存的版本" value={comparison.content} readOnly />
              <button
                type="button"
                className="workspace-modal-btn"
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
