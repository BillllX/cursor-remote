"use client";
import { ProjectChannel } from "../../lib/projects/channel";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage } from "@shared/protocol";
import type { ProjectAction, ProjectEntry, ProjectSummary } from "@shared/projectTypes";
import styles from "./ProjectPanel.module.css";
type Chat = { chatId: string; title: string };
type Member = { tenantId: string; role: string; revision: number };
export function ProjectPanel({
  send,
  channel,
  connected,
  token,
  onClose,
}: {
  send: (m: ClientMessage) => void;
  channel: ProjectChannel;
  connected: boolean;
  token: string;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [inbox, setInbox] = useState<{ inviteId: string; title: string; role: string }[]>([]),
    [selected, setSelected] = useState<ProjectSummary | null>(null);
  const [entries, setEntries] = useState<ProjectEntry[]>([]),
    [chats, setChats] = useState<Chat[]>([]),
    [chatId, setChatId] = useState(""),
    [messages, setMessages] = useState<{ seq: number; actor: string; text: string }[]>([]);
  const [runs, setRuns] = useState<{ runId: string; status: string; actor: string; baseRevision: number }[]>([]);
  const [modelId, setModelId] = useState("");
  const [members, setMembers] = useState<Member[]>([]),
    [path, setPath] = useState("docs/新文档.txt"),
    [text, setText] = useState(""),
    [dirty, setDirty] = useState(false),
    [draft, setDraft] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef(
    new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >(),
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const call = useCallback(
    <T,>(action: ProjectAction, payload: Record<string, unknown> = {}, id?: string): Promise<T> => {
      if (!connected) return Promise.reject(new Error("离线：尚未保存到项目"));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.current.delete(requestId);
          reject(new Error("请求超时，请刷新确认后重试"));
        }, 30000);
        pending.current.set(requestId, { resolve: (v) => resolve(v as T), reject, timer });
        send({ type: "project_request", protocol: 1, requestId, action, workspaceId: id, payload });
      });
    },
    [send, connected],
  );
  useEffect(() => {
    const queue = pending.current;
    return () => {
      for (const r of queue.values()) {
        clearTimeout(r.timer);
        r.reject(new Error("项目页已关闭"));
      }
      queue.clear();
    };
  }, []);
  const refresh = useCallback(async () => {
    const [list, invites] = await Promise.all([
      call<{ items: ProjectSummary[] }>("project_list"),
      call<{ items: typeof inbox }>("project_inbox"),
    ]);
    setProjects(list.items);
    setInbox(invites.items);
  }, [call]);
  const load = useCallback(
    async (id: string) => {
      const snapshot = await call<{
        summary: ProjectSummary;
        chatSummaries: Chat[];
        runs: typeof runs;
        eventSeq: number;
      }>("project_snapshot", {}, id);
      if (selectedRef.current && selectedRef.current.workspaceId !== id) return;
      setSelected(snapshot.summary);
      setChats(snapshot.chatSummaries);
      setRuns(snapshot.runs || []);
      const tree = await call<{ items: ProjectEntry[] }>("project_tree", {}, id);
      setEntries(tree.items);
      await call("project_subscribe", { afterEventSeq: snapshot.eventSeq }, id);
    },
    [call],
  );
  useEffect(() => {
    if (connected) {
      void refresh().catch((e) => setNotice(e.message));
    } else {
      setSelected(null);
      setEntries([]);
      setMessages([]);
      setMembers([]);
      setNotice("离线：共享内容已关闭，内存草稿尚未保存");
    }
  }, [connected, refresh]);
  useEffect(
    () =>
      channel.subscribe((lastMessage) => {
        if (lastMessage.type === "project_result") {
          const r = pending.current.get(lastMessage.requestId);
          if (!r) return;
          clearTimeout(r.timer);
          pending.current.delete(lastMessage.requestId);
          if (lastMessage.ok) r.resolve(lastMessage.data);
          else
            r.reject(
              new Error(
                lastMessage.error.code === "CONFLICT"
                  ? "版本冲突：草稿已保留，请比较最新版本后重新保存"
                  : lastMessage.error.message,
              ),
            );
        } else if (
          lastMessage.type === "project_access_revoked" &&
          lastMessage.workspaceId === selectedRef.current?.workspaceId
        ) {
          setSelected(null);
          setEntries([]);
          setMessages([]);
          setMembers([]);
          setText("");
          setDirty(false);
          setNotice("项目权限已变化，请刷新项目列表");
          void refresh().catch(() => {});
        } else if (
          lastMessage.type === "project_event" &&
          lastMessage.workspaceId === selectedRef.current?.workspaceId
        ) {
          if (lastMessage.kind === "files_changed")
            setNotice(dirty ? "其他成员更新了文件，当前草稿尚未保存；请比较后再提交" : "项目有新文件版本，请刷新");
          else if (lastMessage.kind === "message_added" && chatId)
            void call<{ items: typeof messages }>("project_chat_read", { chatId }, lastMessage.workspaceId)
              .then((r) => setMessages(r.items))
              .catch((e) => setNotice(e.message));
          else setNotice("项目状态已更新，请刷新");
        }
      }),
    [channel, call, chatId, dirty, refresh],
  );
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(p: ProjectSummary) {
    if (dirty && !confirm("有未保存草稿，切换将清除，继续吗？")) return;
    if (selected) void call("project_unsubscribe", {}, selected.workspaceId).catch(() => {});
    setSelected(p);
    selectedRef.current = p;
    setText("");
    setDirty(false);
    setMessages([]);
    setChatId("");
    await load(p.workspaceId);
  }
  async function upload(bytes: Blob) {
    if (!selected) throw new Error("请先选择项目");
    const url = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/projects/${selected.workspaceId}/upload`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Jiebo-Project-Protocol": "1" },
      body: bytes,
      cache: "no-store",
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error?.message || "上传失败");
    return result.data.uploadId as string;
  }
  const writable = !!selected && selected.state === "active" && selected.role !== "viewer";
  return (
    <section className={styles.backdrop} role="dialog" aria-modal="true" aria-label="共享项目">
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2>共享项目</h2>
          <button onClick={onClose}>关闭</button>
        </header>
        <p role="status">{notice || "项目文件与会话对当前成员可见全部历史；下载的副本无法通过撤权收回。"}</p>
        <div className={styles.toolbar}>
          <button disabled={busy || !connected} onClick={() => void act(refresh)}>
            刷新列表
          </button>
          <button
            disabled={busy || !connected}
            onClick={() =>
              void act(async () => {
                const title = prompt("新项目名称");
                if (!title) return;
                const p = await call<ProjectSummary>("project_create", { operationId: crypto.randomUUID(), title });
                await refresh();
                await open(p);
              })
            }
          >
            新建项目
          </button>
          {projects.map((p) => (
            <button
              key={p.workspaceId}
              aria-pressed={selected?.workspaceId === p.workspaceId}
              onClick={() => void act(() => open(p))}
            >
              {p.title} · {p.role}
            </button>
          ))}
        </div>
        {inbox.map((inv) => (
          <p key={inv.inviteId}>
            邀请：{inv.title} · {inv.role}{" "}
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await call("project_invite_accept", { operationId: crypto.randomUUID(), inviteId: inv.inviteId });
                  await refresh();
                })
              }
            >
              接受邀请（全部历史可见）
            </button>
          </p>
        ))}
        {selected && (
          <>
            <h3>
              {selected.title} · {selected.role} · v{selected.revision} · {selected.state}
            </h3>
            <div className={styles.toolbar}>
              <button disabled={busy} onClick={() => void act(() => load(selected.workspaceId))}>
                刷新项目
              </button>
              <button
                onClick={() =>
                  void act(async () => {
                    const r = await call<{ items: Member[] }>("project_members", {}, selected.workspaceId);
                    setMembers(r.items);
                  })
                }
              >
                查看成员
              </button>
              {["owner", "admin"].includes(selected.role) && (
                <button
                  onClick={() =>
                    void act(async () => {
                      const targetTenantId = prompt("输入完整站内账号 ID（门户口令不是账号）");
                      if (!targetTenantId) return;
                      const role = prompt(
                        "角色：viewer / editor" + (selected.role === "owner" ? " / admin" : ""),
                        "viewer",
                      );
                      if (!role) return;
                      await call(
                        "project_invite",
                        { operationId: crypto.randomUUID(), targetTenantId, role },
                        selected.workspaceId,
                      );
                      setNotice("邀请已写入对方项目收件箱");
                    })
                  }
                >
                  邀请站内账号
                </button>
              )}
              {selected.role === "owner" ? (
                <button
                  onClick={() =>
                    void act(async () => {
                      if (!confirm("确认更改项目归档状态？")) return;
                      await call(
                        selected.state === "active" ? "project_archive" : "project_restore",
                        { operationId: crypto.randomUUID() },
                        selected.workspaceId,
                      );
                      await load(selected.workspaceId);
                      await refresh();
                    })
                  }
                >
                  {selected.state === "active" ? "归档项目" : "恢复项目"}
                </button>
              ) : (
                <button
                  onClick={() =>
                    void act(async () => {
                      if (!confirm("确认退出项目？")) return;
                      await call("project_leave", { operationId: crypto.randomUUID() }, selected.workspaceId);
                      setSelected(null);
                      await refresh();
                    })
                  }
                >
                  退出项目
                </button>
              )}
            </div>
            {members.length > 0 && (
              <ul>
                {members.map((m) => (
                  <li key={m.tenantId}>
                    {m.tenantId} · {m.role}{" "}
                    {["owner", "admin"].includes(selected.role) && m.role !== "owner" && (
                      <button
                        onClick={() =>
                          void act(async () => {
                            await call(
                              "project_member_remove",
                              {
                                operationId: crypto.randomUUID(),
                                targetTenantId: m.tenantId,
                                expectedMemberRevision: m.revision,
                              },
                              selected.workspaceId,
                            );
                            setMembers([]);
                            setNotice("成员已移除，旧下载票据已失效");
                          })
                        }
                      >
                        移除
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.columns}>
              <div>
                <h3>文件</h3>
                <ul>
                  {entries.map((e) => (
                    <li key={e.path}>
                      <button
                        disabled={e.kind === "dir"}
                        onClick={() =>
                          void act(async () => {
                            if (dirty && !confirm("放弃当前未保存草稿？")) return;
                            const r = await call<{ text?: string; ticket?: string }>(
                              "project_file_read",
                              { path: e.path },
                              selected.workspaceId,
                            );
                            if (r.text === undefined) {
                              setNotice("该文件为二进制或较大文件，请使用受控下载");
                              return;
                            }
                            setPath(e.path);
                            setText(r.text);
                            setDirty(false);
                          })
                        }
                      >
                        {e.kind === "dir" ? "目录 " : ""}
                        {e.path}
                      </button>
                    </li>
                  ))}
                </ul>
                <label>
                  相对路径
                  <input
                    aria-label="相对路径"
                    value={path}
                    disabled={!writable}
                    onChange={(e) => {
                      setPath(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <label>
                  文件内容
                  <textarea
                    value={text}
                    readOnly={!writable}
                    onChange={(e) => {
                      setText(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <button
                  disabled={!writable || busy}
                  onClick={() =>
                    void act(async () => {
                      const uploadId = await upload(new Blob([text], { type: "text/plain" }));
                      const r = await call<{ revision: number }>(
                        "project_commit",
                        {
                          operationId: crypto.randomUUID(),
                          expectedRevision: selected.revision,
                          changes: [{ kind: "put", path, uploadId }],
                        },
                        selected.workspaceId,
                      );
                      setDirty(false);
                      setSelected({ ...selected, revision: r.revision });
                      await load(selected.workspaceId);
                      setNotice("已保存到共享项目");
                    })
                  }
                >
                  保存文件
                </button>
                <button
                  disabled={!writable || busy}
                  onClick={() =>
                    void act(async () => {
                      if (!confirm("确认删除 " + path + "？")) return;
                      await call(
                        "project_commit",
                        {
                          operationId: crypto.randomUUID(),
                          expectedRevision: selected.revision,
                          changes: [{ kind: "delete", path }],
                        },
                        selected.workspaceId,
                      );
                      setText("");
                      setDirty(false);
                      await load(selected.workspaceId);
                    })
                  }
                >
                  删除文件
                </button>
              </div>
              <div>
                <h3>共享对话</h3>
                <div className={styles.toolbar}>
                  {chats.map((c) => (
                    <button
                      key={c.chatId}
                      onClick={() =>
                        void act(async () => {
                          setChatId(c.chatId);
                          const r = await call<{ items: typeof messages }>(
                            "project_chat_read",
                            { chatId: c.chatId },
                            selected.workspaceId,
                          );
                          setMessages(r.items);
                        })
                      }
                    >
                      {c.title}
                    </button>
                  ))}
                </div>
                <button
                  disabled={!writable}
                  onClick={() =>
                    void act(async () => {
                      const title = prompt("对话标题");
                      if (!title) return;
                      const c = await call<Chat>(
                        "project_chat_create",
                        { operationId: crypto.randomUUID(), title },
                        selected.workspaceId,
                      );
                      setChatId(c.chatId);
                      setMessages([]);
                      await load(selected.workspaceId);
                    })
                  }
                >
                  新建共享对话
                </button>
                {selected.role === "owner" && (
                  <button
                    onClick={() =>
                      void act(async () => {
                        const model = prompt("已配置并验证计费上界的项目模型 ID");
                        if (!model) return;
                        const provider = prompt("此模型所属提供商 ID");
                        if (!provider) return;
                        const daily = Number(prompt("每日项目费用上限（整数 micro）", "1000000"));
                        const perRun = Number(prompt("单任务费用上限（整数 micro）", "100000"));
                        await call(
                          "project_config_set",
                          {
                            operationId: crypto.randomUUID(),
                            expectedConfigRevision: selected.configRevision,
                            patch: {
                              dailyBudgetMicros: daily,
                              maxRunCostMicros: perRun,
                              allowedModelIds: [model],
                              approvedProviderIds: [provider],
                            },
                          },
                          selected.workspaceId,
                        );
                        setModelId(model);
                        await load(selected.workspaceId);
                      })
                    }
                  >
                    设置模型与项目预算
                  </button>
                )}
                <label>
                  项目模型 ID
                  <input
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder="需由所有者批准并由服务端配置"
                  />
                </label>
                <button
                  disabled={!writable || !chatId || !draft.trim() || !modelId || busy}
                  onClick={() =>
                    void act(async () => {
                      await call(
                        "project_message_send",
                        { operationId: crypto.randomUUID(), chatId, text: draft, runAgent: true, modelId },
                        selected.workspaceId,
                      );
                      setDraft("");
                      await load(selected.workspaceId);
                      setNotice("项目任务已排队，修改只会先生成提案");
                    })
                  }
                >
                  发起项目 Agent
                </button>
                {runs.map((run) => (
                  <p key={run.runId}>
                    {run.actor} · {run.status}
                    {["proposed", "conflict"].includes(run.status) && (
                      <button
                        disabled={!writable}
                        onClick={() =>
                          void act(async () => {
                            if (!confirm("确认应用这个项目提案？旧版本冲突不会自动覆盖。")) return;
                            await call(
                              "project_run_apply",
                              {
                                operationId: crypto.randomUUID(),
                                runId: run.runId,
                                expectedRevision: run.baseRevision,
                              },
                              selected.workspaceId,
                            );
                            await load(selected.workspaceId);
                          })
                        }
                      >
                        确认应用提案
                      </button>
                    )}
                    {["queued", "running", "proposed", "conflict"].includes(run.status) && (
                      <button
                        disabled={!writable}
                        onClick={() =>
                          void act(async () => {
                            await call(
                              "project_run_cancel",
                              { operationId: crypto.randomUUID(), runId: run.runId },
                              selected.workspaceId,
                            );
                            await load(selected.workspaceId);
                          })
                        }
                      >
                        停止任务
                      </button>
                    )}
                  </p>
                ))}
                <ol>
                  {messages.map((m) => (
                    <li key={m.seq}>
                      <strong>{m.actor}：</strong>
                      <pre className={styles.message}>{m.text}</pre>
                    </li>
                  ))}
                </ol>
                <label>
                  发送后全体成员可见
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!writable || !chatId} />
                </label>
                <button
                  disabled={!writable || !chatId || !draft.trim() || busy}
                  onClick={() =>
                    void act(async () => {
                      await call(
                        "project_message_send",
                        { operationId: crypto.randomUUID(), chatId, text: draft, runAgent: false },
                        selected.workspaceId,
                      );
                      setDraft("");
                      const r = await call<{ items: typeof messages }>(
                        "project_chat_read",
                        { chatId },
                        selected.workspaceId,
                      );
                      setMessages(r.items);
                    })
                  }
                >
                  发送共享消息
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
