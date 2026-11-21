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
import FileTree from "../FileTree";
import { WorkspaceNavigation } from "../chat/WorkspaceNavigation";
import { SharedWorkspaceManagement, type SharedSection } from "./Management";
import MarkdownPreview from "../MarkdownPreview";
import MediaPreview from "../MediaPreview";
import { kindFromPath, isByteKind } from "@shared/preview";
import type { WorkspaceNavId } from "../../lib/productNavigation";
import { IconClose, IconRail } from "../chromeIcons";
import { Composer } from "../chat/Composer";
import styles from "./Sharing.module.css";

export type ShareCall = <T>(action: Omit<WorkspaceShareRequest, "type" | "requestId">) => Promise<T>;
type People = { people: SharePerson[]; memberIds: string[]; managerIds?: string[]; memberRevision: string };

export function ShareWorkspaceDialog({
  path,
  name,
  canManageSharing,
  call,
  close,
}: {
  path: string;
  name: string;
  canManageSharing: boolean;
  call: ShareCall;
  close: () => void;
}) {
  const [data, setData] = useState<People>();
  const [selected, setSelected] = useState<string[]>([]);
  const [managers, setManagers] = useState<string[]>([]);
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
          setManagers(result.managerIds ?? []);
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
      await call({
        action: "set",
        workspace: path,
        memberIds: selected,
        managerIds: canManageSharing ? managers.filter((id) => selected.includes(id)) : undefined,
        memberRevision: data.memberRevision,
      });
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
    data &&
    (selected.length !== data.memberIds.length ||
      selected.some((id) => !data.memberIds.includes(id)) ||
      (canManageSharing &&
        (managers.length !== (data.managerIds?.length ?? 0) || managers.some((id) => !data.managerIds?.includes(id))))),
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
                <div className={styles.personRow} key={person.id}>
                  <label className={styles.person}>
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
                  {canManageSharing && selected.includes(person.id) && (
                    <label className={styles.manageMember}>
                      <input
                        type="checkbox"
                        aria-label={`允许 ${person.name} 管理工作区`}
                        checked={managers.includes(person.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setManagers((previous) =>
                            event.target.checked ? [...previous, person.id] : previous.filter((id) => id !== person.id),
                          )
                        }
                      />
                      允许管理
                    </label>
                  )}
                </div>
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

type OpenFile = {
  path: string;
  content: string;
  revision?: string;
  url?: string;
  kind: ReturnType<typeof kindFromPath>;
};
const SHARED_NAV = ["chats", "files", "skills", "schedules", "memory", "management"] as const;

export function SharedWorkspaceFiles({
  workspace,
  call,
  token,
  canManage,
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
  token: string;
  canManage: boolean;
  canAsk: boolean;
  canEdit: boolean;
  models: string[];
  defaultModel: string;
  connected: boolean;
  onSwitch: () => void;
  onUnavailable: () => void;
}) {
  const [section, setSection] = useState<WorkspaceNavId>(canAsk ? "chats" : "files");
  const [folders, setFolders] = useState<Record<string, { items: SharedFileEntry[]; truncated: boolean }>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [uploadDir, setUploadDir] = useState("");
  const [file, setFile] = useState<OpenFile>();
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [comparison, setComparison] = useState<OpenFile>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const objectUrl = useRef("");
  const pendingDirs = useRef(new Set<string>());
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  const dirty = Boolean(file?.revision && file.content !== draft);
  const visibleItems = SHARED_NAV.filter(
    (item) => item === "files" || (item === "chats" ? canAsk : canManage && workspace.canManage),
  );
  const paths = Object.entries(folders).flatMap(([parent, folder]) =>
    folder.items.map((entry) => `${parent ? parent + "/" : ""}${entry.name}${entry.directory ? "/" : ""}`),
  );
  const choose = (value: WorkspaceNavId) => {
    setSection(value);
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  function fail(error: unknown) {
    if (!active.current) return;
    const reason = error as Error & { code?: string };
    if (reason.code === "UNAVAILABLE") onUnavailable();
    else setStatus(reason.message);
  }
  async function loadFolder(path: string, force = false) {
    if (pendingDirs.current.has(path) || (!force && foldersRef.current[path])) return;
    pendingDirs.current.add(path);
    setLoading((previous) => ({ ...previous, [path]: true }));
    try {
      const data = await call<{ items: SharedFileEntry[]; truncated: boolean }>({
        action: "files",
        workspace: workspace.id,
        path,
      });
      if (active.current) setFolders((previous) => ({ ...previous, [path]: data }));
    } catch (error) {
      fail(error);
    } finally {
      pendingDirs.current.delete(path);
      if (active.current) setLoading((previous) => ({ ...previous, [path]: false }));
    }
  }
  useEffect(() => {
    if (section === "files") void loadFolder("");
    // 共享工作区切换时父组件会按工作区 ID 重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  function refreshFiles() {
    for (const path of new Set(["", ...Object.keys(foldersRef.current)])) void loadFolder(path, true);
  }
  async function requestFile(path: string, body?: File) {
    const query = new URLSearchParams({ shared: workspace.id, path });
    const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
    const response = await fetch(`${base}/api/media?${query}`, {
      method: body ? "POST" : "GET",
      body,
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (response.ok) return response;
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(result.error || `文件操作失败（${response.status}）`), {
      code: response.status === 403 ? "UNAVAILABLE" : undefined,
    });
  }
  async function readText(path: string): Promise<OpenFile> {
    const result = await call<{ content: string; revision: string }>({ action: "read", workspace: workspace.id, path });
    return { path, kind: kindFromPath(path), ...result };
  }
  async function open(path: string) {
    if (busy || (dirty && !confirm("当前文件有未保存的修改。确认切换？"))) return;
    setBusy(true);
    setStatus("");
    setComparison(undefined);
    try {
      const kind = kindFromPath(path);
      let opened: OpenFile;
      if (canManage && (isByteKind(kind) || kind === "svg")) {
        const blob = await (await requestFile(path)).blob();
        if (!active.current) return;
        opened = { path, kind, content: "", url: URL.createObjectURL(blob) };
      } else {
        try {
          opened = await readText(path);
        } catch (error) {
          if (!canManage || (error as { code?: string }).code === "UNAVAILABLE") throw error;
          opened = { path, kind, content: await (await requestFile(path)).text() };
        }
      }
      if (!active.current) return;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = opened.url || "";
      setFile(opened);
      setDraft(opened.content);
      setMode("preview");
      setSection("files");
    } catch (error) {
      fail(error);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save() {
    if (!file?.revision || !dirty) return;
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
      if (active.current) {
        setFile({ ...file, revision, content: draft });
        setStatus("已保存");
      }
    } catch (error) {
      fail(error);
      if ((error as { code?: string }).code === "CONFLICT") {
        try {
          const latest = await readText(file.path);
          if (active.current) setComparison(latest);
        } catch (failure) {
          fail(failure);
        }
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function upload(files: FileList) {
    if (busy || !files.length) return;
    setBusy(true);
    setStatus("");
    const uploaded: string[] = [];
    const errors: string[] = [];
    for (const item of Array.from(files)) {
      const path = uploadDir ? `${uploadDir}/${item.name}` : item.name;
      try {
        await requestFile(path, item);
        uploaded.push(item.name);
      } catch (error) {
        if ((error as { code?: string }).code === "UNAVAILABLE") {
          fail(error);
          break;
        }
        errors.push(`${item.name}：${(error as Error).message}`);
      }
    }
    if (!active.current) return;
    setBusy(false);
    if (uploaded.length) void loadFolder(uploadDir, true);
    setStatus([uploaded.length ? `已上传 ${uploaded.length} 个文件` : "", ...errors].filter(Boolean).join("；"));
  }
  function preview() {
    if (!file) return <p className={styles.muted}>从文件树选择文件</p>;
    if (file.kind === "html")
      return (
        <iframe
          className={styles.htmlPreview}
          title={file.path}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">${file.content}`}
        />
      );
    if (file.kind === "markdown")
      return <MarkdownPreview path={file.path} content={file.content} onOpen={(path) => void open(path)} />;
    if (file.url && (["image", "svg", "pdf", "audio", "video"] as string[]).includes(file.kind))
      return <MediaPreview kind={file.kind} path={file.path} url={file.url} onReload={() => void open(file.path)} />;
    if (file.url) return <p className={styles.muted}>可下载原文件后查看</p>;
    return <pre className={styles.fileText}>{file.content}</pre>;
  }

  return (
    <main className={`main ${styles.workbench}`} aria-label="工作区">
      <div className={styles.sharedLayout}>
        <aside className={styles.sharedNav}>
          <WorkspaceNavigation
            workspaceName={workspace.name}
            workspacePath={`来自 ${workspace.ownerName}`}
            active={section}
            loopLive={false}
            managementDisabled={false}
            managementHint=""
            onSwitchWorkspace={() => {
              if (!dirty || confirm("当前文件有未保存的修改。确认切换工作区？")) onSwitch();
            }}
            visibleItems={visibleItems}
            onNavigate={choose}
            onSessionTool={() => {}}
          />
        </aside>
        <div className={styles.sharedContent}>
          {canAsk && (
            <div className={styles.conversation} hidden={section !== "chats"}>
              <SharedWorkspaceQuestions
                workspace={workspace}
                filePath={file?.path}
                call={call}
                onUnavailable={onUnavailable}
                canEdit={canEdit}
                models={models}
                defaultModel={defaultModel}
                connected={connected}
                refreshFiles={refreshFiles}
              />
            </div>
          )}
          {section === "files" && (
            <div className={styles.columns}>
              <nav aria-label="文件树">
                <div className={styles.fileActions}>
                  <h2>文件树</h2>
                  {canManage && (
                    <label className="workspace-modal-btn">
                      上传文件
                      <input
                        type="file"
                        multiple
                        aria-label="上传文件"
                        disabled={busy}
                        onChange={(event) => {
                          if (event.target.files) void upload(event.target.files);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  )}
                  <button type="button" className="workspace-modal-btn" onClick={refreshFiles}>
                    刷新
                  </button>
                </div>
                {canManage && (
                  <p className={styles.muted}>
                    上传到 {uploadDir || "工作区根目录"}{" "}
                    {uploadDir && (
                      <button type="button" className="pill" onClick={() => setUploadDir("")}>
                        改为根目录
                      </button>
                    )}
                  </p>
                )}
                <FileTree
                  paths={paths}
                  variant="browser"
                  loadingDirs={loading}
                  truncated={folders[""]?.truncated}
                  truncatedDirs={Object.fromEntries(
                    Object.entries(folders).map(([path, value]) => [path, value.truncated]),
                  )}
                  onExpandDir={(path) => {
                    setUploadDir(path);
                    void loadFolder(path);
                  }}
                  onPick={(path) => void open(path)}
                />
              </nav>
              <section aria-label="文件内容">
                {file && (
                  <div className={styles.fileActions}>
                    <h2>{file.path}</h2>
                    {file.revision && (
                      <button
                        type="button"
                        className="pill"
                        aria-pressed={mode === "edit"}
                        onClick={() => setMode(mode === "edit" ? "preview" : "edit")}
                      >
                        {mode === "edit" ? "预览" : "编辑"}
                      </button>
                    )}
                    {file.url && (
                      <a className="pill" href={file.url} download={file.path.split("/").at(-1)}>
                        下载原件
                      </a>
                    )}
                  </div>
                )}
                {file && mode === "edit" ? (
                  <>
                    <textarea
                      aria-label="文件编辑"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
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
                  preview()
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
                      }}
                    >
                      基于新版保留草稿
                    </button>
                  </>
                )}
                <p role="status">{status}</p>
              </section>
            </div>
          )}
          {canManage && workspace.canManage && section !== "files" && section !== "chats" && (
            <SharedWorkspaceManagement
              key={section}
              section={section as SharedSection}
              workspace={workspace}
              call={call}
            />
          )}
        </div>
      </div>
    </main>
  );
}
