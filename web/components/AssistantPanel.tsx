"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AssistantDelegation, AssistantMemoryEntry, AssistantOp, AssistantState, ClientMessage } from "../lib/protocol";
import { closeInboxNotification, registerAssistantPush } from "../lib/assistantPush";

type Tab = "today" | "inbox" | "memory" | "notify";

export const DELEGATION_STATUS: Record<AssistantDelegation["status"], string> = {
  running: "进行中",
  awaiting: "待批",
  done: "完成",
  failed: "失败",
};

/** 状态标签沿用侧栏会话的 chat-mark 小标，色调只用主题里的 run / ok / danger / warn */
const DELEGATION_TONE: Record<AssistantDelegation["status"], string> = {
  running: "run",
  awaiting: "warn",
  done: "ok",
  failed: "danger",
};

type Props = {
  open: boolean;
  /** 宽屏 IDE 下收在侧栏列里：点遮罩不关，标题栏不显示关闭 */
  docked: boolean;
  onClose: () => void;
  name: string;
  state: AssistantState | null;
  send: (message: ClientMessage) => void;
  onOpenInboxItem: (item: { chatId?: string; id: string }) => void;
  onOpenChat: (chatId: string) => void;
  initialInboxId?: string;
  basePath: string;
};

function uid() {
  return crypto.randomUUID();
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="assistant-section">
      <div className="side-label">{title}</div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="loop-meta">{children}</div>;
}

export default function AssistantPanel({
  open,
  docked,
  onClose,
  name,
  state,
  send,
  onOpenInboxItem,
  onOpenChat,
  initialInboxId,
  basePath,
}: Props) {
  const [editing, setEditing] = useState<{ id: string; rev: number; topic: string; text: string } | null>(null);
  const [coreDraft, setCoreDraft] = useState<Record<string, string> | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const [tab, setTab] = useState<Tab>("today");
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [todoDraft, setTodoDraft] = useState("");
  const [memTopic, setMemTopic] = useState("");
  const [memText, setMemText] = useState("");

  const unread = useMemo(() => state?.inbox.filter((item) => !item.read).length ?? 0, [state?.inbox]);

  const op = useCallback(
    (operation: AssistantOp, args?: Record<string, unknown>) => {
      send({ type: "assistant_op", op: operation, args, reqId: uid() });
    },
    [send],
  );

  useEffect(() => {
    if (!open) return;
    send({ type: "assistant_get", memory: memoryLoaded });
  }, [open, memoryLoaded, send]);

  useEffect(() => {
    if (!open || !initialInboxId || !state?.inbox.length) return;
    const item = state.inbox.find((row) => row.id === initialInboxId);
    if (item) {
      setTab("inbox");
      if (!item.read) op("inbox_read", { ids: [item.id] });
      void closeInboxNotification(item.id);
      onOpenInboxItem(item);
    }
  }, [open, initialInboxId, state?.inbox, op, onOpenInboxItem]);

  async function enablePush() {
    if (!state?.pushKey) {
      setNotice("服务器还没准备好推送密钥，稍后再试。");
      return;
    }
    setBusy("push");
    setNotice("");
    try {
      const subscription = await registerAssistantPush(state.pushKey, basePath);
      op("push_subscribe", { subscription });
      setNotice("已开启通知。");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "开启通知失败");
    } finally {
      setBusy("");
    }
  }

  if (!open) return null;

  function purge(entry: AssistantMemoryEntry) {
    if (!window.confirm(`彻底删除「${entry.topic}」？摘要、简报、收件箱和会话索引里的相关片段会一起抹掉，不能恢复。`)) return;
    op("memory_purge", { id: entry.id });
  }

  const approvals = state?.approvals || [];
  const memoryEntries = state?.memory?.entries || [];
  const validEntries = memoryEntries.filter((entry) => !entry.invalidAt);
  const invalidEntries = memoryEntries.filter((entry) => entry.invalidAt);
  const backgroundOk = state?.background.ok ?? false;
  const todosOpen = (state?.todos || []).filter((t) => !t.done);
  const brief = state?.brief?.text?.trim();

  return (
    <div className="search-overlay open assistant-overlay" onClick={docked ? undefined : onClose}>
      <div className="search-box assistant-box" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={`${name} · 助理`}>
        <div className="assistant-head">
          <div className="assistant-head-text">
            <div className="loop-title">{name} · 助理</div>
            <div className="loop-meta">
              后台 {state?.background.model || "grok-4.7"} · {backgroundOk ? "就绪" : state?.background.reason || "未就绪"}
            </div>
          </div>
          {docked ? null : (
            <button type="button" className="logout-btn" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
        <div className="assistant-tabs" role="tablist">
          {(
            [
              ["today", approvals.length ? `今日 · ${approvals.length}` : "今日"],
              ["inbox", unread ? `收件箱 · ${unread}` : "收件箱"],
              ["memory", "记忆"],
              ["notify", "通知"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`pill${tab === id ? " on" : ""}`}
              onClick={() => {
                setTab(id);
                if (id === "memory") setMemoryLoaded(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {notice ? <div className="loop-meta assistant-notice">{notice}</div> : null}

        <div className="assistant-body">
          {tab === "today" ? (
            <>
              {approvals.length ? (
                <Section title="待批">
                  {approvals.map((item) => {
                    const owner = state?.delegations.find((row) => row.id === item.delegationId);
                    return (
                      <div key={item.id} className="approval-row assistant-approval">
                        <span>
                          委派「{owner?.title || "未命名"}」要{item.tool === "shell" ? "跑命令" : "改文件"}
                          {item.summary ? `：${item.summary}` : ""}
                        </span>
                        <button type="button" className="pill" onClick={() => op("approval_answer", { chatId: item.chatId, callId: item.callId, allow: true })}>
                          批准
                        </button>
                        <button type="button" className="pill" onClick={() => op("approval_answer", { chatId: item.chatId, callId: item.callId, allow: false })}>
                          拒绝
                        </button>
                        <button type="button" className="pill" onClick={() => onOpenChat(item.chatId)}>
                          看子会话
                        </button>
                      </div>
                    );
                  })}
                </Section>
              ) : null}
              <Section title="简报">
                {brief ? <div className="assistant-pre">{brief}</div> : <Empty>今天还没有简报。每日简报的日程到点后会生成。</Empty>}
              </Section>
              <Section title="待办">
                <form
                  className="assistant-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = todoDraft.trim();
                    if (!text) return;
                    op("todo_add", { text });
                    setTodoDraft("");
                  }}
                >
                  <input className="side-input" value={todoDraft} onChange={(e) => setTodoDraft(e.target.value)} placeholder="加一条待办" />
                  <button type="submit" className="new-chat primary">
                    添加
                  </button>
                </form>
                {todosOpen.length ? (
                  <ul className="assistant-list">
                    {todosOpen.map((todo) => (
                      <li key={todo.id} className="assistant-item">
                        <div className="assistant-item-head">
                          <span className="assistant-item-title">{todo.text}</span>
                          {todo.due ? <span className="chat-mark">{todo.due}</span> : null}
                          <button type="button" className="pill" onClick={() => op("todo_done", { id: todo.id })}>
                            完成
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>没有未完成的待办。</Empty>
                )}
              </Section>
              <Section title="日程">
                {state?.schedules?.length ? (
                  <ul className="assistant-list">
                    {state.schedules.map((row) => (
                      <li key={row.id} className="assistant-item">
                        <div className="assistant-item-head">
                          <span className="assistant-item-title">{row.title}</span>
                          <span className={`chat-mark ${row.enabled ? "ok" : "warn"}`}>{row.enabled ? "启用" : "暂停"}</span>
                        </div>
                        <div className="loop-meta">
                          {row.cron}
                          {row.pausedReason ? ` · ${row.pausedReason}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>还没有日程。</Empty>
                )}
              </Section>
              <Section title="委派">
                {state?.delegations?.length ? (
                  <ul className="assistant-list">
                    {state.delegations.slice(0, 8).map((row) => (
                      <li key={row.id}>
                        <button type="button" className="assistant-item assistant-item-btn" onClick={() => onOpenChat(row.childChatId)}>
                          <div className="assistant-item-head">
                            <span className="assistant-item-title">{row.title}</span>
                            <span className={`chat-mark ${DELEGATION_TONE[row.status] ?? ""}`}>{DELEGATION_STATUS[row.status] ?? row.status}</span>
                          </div>
                          <div className="loop-meta">{row.workspace}</div>
                          {row.result ? <div className="assistant-item-body">{row.result.slice(0, 200)}</div> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>还没有委派。在助理会话里让{name}把事交给某个子工作区就会出现在这里。</Empty>
                )}
              </Section>
            </>
          ) : null}

          {tab === "inbox" ? (
            state?.inbox.length ? (
              <ul className="assistant-list">
                {state.inbox.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`assistant-item assistant-item-btn${item.read ? "" : " unread"}`}
                      onClick={() => {
                        if (!item.read) {
                          op("inbox_read", { ids: [item.id] });
                          void closeInboxNotification(item.id);
                        }
                        onOpenInboxItem(item);
                      }}
                    >
                      <div className="assistant-item-head">
                        {item.read ? null : <span className="chat-mark unread">未读</span>}
                        <span className="assistant-item-title">{item.title}</span>
                      </div>
                      <div className="loop-meta">{new Date(item.createdAt).toLocaleString()}</div>
                      <div className="assistant-item-body">{item.body.slice(0, 240)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>收件箱是空的。提醒、委派结果和待批会出现在这里。</Empty>
            )
          ) : null}

          {tab === "memory" ? (
            !state?.memory ? (
              <Empty>正在加载记忆…</Empty>
            ) : (
              <>
                <Section title="核心档案">
                  {coreDraft ? (
                    <form
                      className="assistant-col-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        op("memory_core", { fields: coreDraft, rev: state.memory?.core.rev });
                        setCoreDraft(null);
                      }}
                    >
                      {Object.keys(state.memory.core.fields).map((key) => (
                        <label key={key} className="loop-field">
                          {key}
                          <textarea className="loop-goal" rows={3} value={coreDraft[key] ?? ""} onChange={(e) => setCoreDraft({ ...coreDraft, [key]: e.target.value })} />
                        </label>
                      ))}
                      <div className="loop-actions">
                        <button type="submit" className="new-chat primary">
                          保存档案
                        </button>
                        <button type="button" className="new-chat" onClick={() => setCoreDraft(null)}>
                          取消
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      {Object.entries(state.memory.core.fields).some(([, value]) => value.trim()) ? (
                        <div className="assistant-core">
                          {Object.entries(state.memory.core.fields).map(([key, value]) =>
                            value.trim() ? (
                              <div key={key}>
                                <div className="loop-field">{key}</div>
                                <div className="assistant-item-body">{value}</div>
                              </div>
                            ) : null,
                          )}
                        </div>
                      ) : (
                        <Empty>核心档案还是空的。它会在每次对话开头注入。</Empty>
                      )}
                      <div className="loop-meta">
                        约 {state.memory.coreTokens}/{state.memory.coreBudget} token
                        {state.memory.settings.paused ? " · 记忆已暂停：模型不写新记忆，对话里也不注入" : ""}
                      </div>
                      <div className="assistant-row-actions">
                        <button type="button" className="pill" onClick={() => setCoreDraft({ ...state.memory!.core.fields })}>
                          编辑档案
                        </button>
                        <button type="button" className="pill" onClick={() => op("memory_settings", { paused: !state.memory!.settings.paused })}>
                          {state.memory.settings.paused ? "恢复记忆" : "暂停记忆"}
                        </button>
                      </div>
                    </>
                  )}
                </Section>
                <Section title="新增">
                  <form
                    className="assistant-col-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!memTopic.trim() || !memText.trim()) return;
                      op("memory_save", { topic: memTopic.trim(), text: memText.trim() });
                      setMemTopic("");
                      setMemText("");
                      setNotice("已保存。");
                    }}
                  >
                    <input className="side-input" value={memTopic} onChange={(e) => setMemTopic(e.target.value)} placeholder="主题，例如：饮食" />
                    <textarea className="loop-goal" rows={3} value={memText} onChange={(e) => setMemText(e.target.value)} placeholder="要记住的内容" />
                    <div className="loop-actions">
                      <button type="submit" className="new-chat primary">
                        保存
                      </button>
                    </div>
                  </form>
                </Section>
                <Section title={`条目 · ${validEntries.length}`}>
                  {validEntries.length ? (
                    <ul className="assistant-list">
                      {validEntries.slice(0, 200).map((entry) =>
                        editing?.id === entry.id ? (
                          <li key={entry.id} className="assistant-item">
                            <form
                              className="assistant-col-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                if (!editing.topic.trim() || !editing.text.trim()) return;
                                op("memory_edit", { id: entry.id, rev: editing.rev, topic: editing.topic.trim(), text: editing.text.trim() });
                                setEditing(null);
                              }}
                            >
                              <input className="side-input" value={editing.topic} onChange={(e) => setEditing({ ...editing, topic: e.target.value })} />
                              <textarea className="loop-goal" rows={3} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                              <div className="loop-actions">
                                <button type="submit" className="new-chat primary">
                                  保存
                                </button>
                                <button type="button" className="new-chat" onClick={() => setEditing(null)}>
                                  取消
                                </button>
                              </div>
                            </form>
                          </li>
                        ) : (
                          <li key={entry.id} className="assistant-item">
                            <div className="assistant-item-head">
                              <span className="assistant-item-title">{entry.topic}</span>
                              <span className={`chat-mark ${entry.basis === "inferred" ? "run" : "ok"}`}>{entry.basis === "inferred" ? "推断" : "你说的"}</span>
                              {entry.validUntil ? <span className="chat-mark">到 {entry.validUntil}</span> : null}
                            </div>
                            <div className="assistant-item-body">{entry.text.slice(0, 300)}</div>
                            <div className="assistant-row-actions">
                              <button type="button" className="pill" onClick={() => setEditing({ id: entry.id, rev: entry.rev, topic: entry.topic, text: entry.text })}>
                                编辑
                              </button>
                              <button type="button" className="pill" onClick={() => op("memory_invalidate", { id: entry.id })}>
                                标失效
                              </button>
                              <button type="button" className="pill" onClick={() => op("memory_forget", { id: entry.id })}>
                                遗忘
                              </button>
                              <button type="button" className="pill danger" onClick={() => purge(entry)}>
                                彻底删除
                              </button>
                            </div>
                          </li>
                        ),
                      )}
                    </ul>
                  ) : (
                    <Empty>还没有记忆。在对话里说“记住……”，或在上面手动加一条。</Empty>
                  )}
                  {invalidEntries.length ? (
                    <button type="button" className="pill" onClick={() => setShowInvalid(!showInvalid)}>
                      {showInvalid ? "收起已失效" : `已失效 · ${invalidEntries.length}`}
                    </button>
                  ) : null}
                  {showInvalid ? (
                    <ul className="assistant-list">
                      {invalidEntries.slice(0, 100).map((entry) => (
                        <li key={entry.id} className="assistant-item muted">
                          <div className="assistant-item-head">
                            <span className="assistant-item-title">{entry.topic}</span>
                            <span className="chat-mark">{entry.invalidReason || "已失效"}</span>
                          </div>
                          <div className="assistant-item-body">{entry.text.slice(0, 200)}</div>
                          <div className="assistant-row-actions">
                            <button type="button" className="pill" onClick={() => op("memory_restore", { id: entry.id })}>
                              恢复
                            </button>
                            <button type="button" className="pill danger" onClick={() => purge(entry)}>
                              彻底删除
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button type="button" className="new-chat" onClick={() => op("memory_export")}>
                    导出只读快照到 .jiebo/memory-export/
                  </button>
                </Section>
              </>
            )
          ) : null}

          {tab === "notify" ? (
            <Section title="浏览器通知">
              <Empty>推送待批、委派结果、提醒和每日简报。记忆写入和普通进度不推。</Empty>
              <div className="loop-actions">
                <button type="button" className="new-chat primary" disabled={busy === "push"} onClick={() => void enablePush()}>
                  开启浏览器通知
                </button>
                <button type="button" className="new-chat" onClick={() => op("push_test")}>
                  发测试
                </button>
              </div>
              {typeof window !== "undefined" && !(window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone) ? (
                <Empty>iPhone 上把网页「添加到主屏幕」后，后台推送更可靠。</Empty>
              ) : null}
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
