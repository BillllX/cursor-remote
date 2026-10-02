"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AssistantDelegation, AssistantMemoryEntry, AssistantOp, AssistantState, ClientMessage } from "../lib/protocol";
import { closeInboxNotification, registerAssistantPush } from "../lib/assistantPush";

type Tab = "today" | "inbox" | "memory" | "notify";

export const DELEGATION_STATUS: Record<AssistantDelegation["status"], string> = {
  running: "进行中",
  awaiting: "待批",
  done: "完成",
  failed: "失败",
};

type Props = {
  open: boolean;
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

export default function AssistantPanel({
  open,
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
    if (!window.confirm(`彻底删除「${entry.topic}」？摘要、简报、收件箱和会话索引里的相关片段也会一起抹掉，不能恢复。`)) return;
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
    <div className="search-overlay open" onClick={onClose}>
      <div className="search-box assistant-box" onClick={(event) => event.stopPropagation()} role="dialog" aria-label={`${name} · 助理`}>
        <div className="assistant-head">
          <div>
            <div className="loop-title">{name}</div>
            <div className="assistant-sub">
              后台 {state?.background.model || "grok-4.7"} · {backgroundOk ? "就绪" : state?.background.reason || "未就绪"}
            </div>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>
        <div className="assistant-tabs" role="tablist">
          {(
            [
              ["today", "今日"],
              ["inbox", unread ? `收件箱 (${unread})` : "收件箱"],
              ["memory", "记忆"],
              ["notify", "通知"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`assistant-tab${tab === id ? " on" : ""}`}
              onClick={() => {
                setTab(id);
                if (id === "memory") setMemoryLoaded(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {notice ? <p className="assistant-notice">{notice}</p> : null}

        {tab === "today" ? (
          <div className="assistant-pane">
            {approvals.length ? (
              <section className="assistant-section">
                <h3>待批 ({approvals.length})</h3>
                <ul className="assistant-list">
                  {approvals.map((item) => {
                    const owner = state?.delegations.find((row) => row.id === item.delegationId);
                    return (
                      <li key={item.id}>
                        <strong>{owner?.title || "委派"}</strong>
                        <span className="assistant-tag">{item.tool === "shell" ? "跑命令" : "改文件"}</span>
                        <p>{item.summary || item.tool}</p>
                        <div className="assistant-row-actions">
                          <button type="button" className="primary" onClick={() => op("approval_answer", { chatId: item.chatId, callId: item.callId, allow: true })}>
                            批准
                          </button>
                          <button type="button" className="ghost-btn" onClick={() => op("approval_answer", { chatId: item.chatId, callId: item.callId, allow: false })}>
                            拒绝
                          </button>
                          <button type="button" className="ghost-btn" onClick={() => onOpenChat(item.chatId)}>
                            看子会话
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            {brief ? (
              <section className="assistant-section">
                <h3>简报</h3>
                <pre className="assistant-pre">{brief}</pre>
              </section>
            ) : (
              <p className="assistant-muted">今天还没有简报。定时任务会在设定时刻生成。</p>
            )}
            <section className="assistant-section">
              <h3>待办</h3>
              <form
                className="assistant-row-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = todoDraft.trim();
                  if (!text) return;
                  op("todo_add", { text });
                  setTodoDraft("");
                }}
              >
                <input className="side-input" value={todoDraft} onChange={(e) => setTodoDraft(e.target.value)} placeholder="加一条待办" />
                <button type="submit" className="primary">
                  添加
                </button>
              </form>
              {todosOpen.length ? (
                <ul className="assistant-list">
                  {todosOpen.map((todo) => (
                    <li key={todo.id}>
                      <span>{todo.text}</span>
                      {todo.due ? <span className="assistant-tag">{todo.due}</span> : null}
                      <button type="button" className="ghost-btn" onClick={() => op("todo_done", { id: todo.id })}>
                        完成
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="assistant-muted">没有未完成的待办。</p>
              )}
            </section>
            {state?.schedules?.length ? (
              <section className="assistant-section">
                <h3>日程</h3>
                <ul className="assistant-list compact">
                  {state.schedules.map((row) => (
                    <li key={row.id}>
                      <strong>{row.title}</strong>
                      <span className="assistant-muted">
                        {row.cron} · {row.enabled ? "启用" : "暂停"}
                        {row.pausedReason ? ` · ${row.pausedReason}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {state?.delegations?.length ? (
              <section className="assistant-section">
                <h3>委派</h3>
                <ul className="assistant-list compact">
                  {state.delegations.slice(0, 8).map((row) => (
                    <li key={row.id}>
                      <button type="button" className="assistant-inbox-btn" onClick={() => onOpenChat(row.childChatId)}>
                        <span className="assistant-inbox-title">
                          {row.title} · {DELEGATION_STATUS[row.status] ?? row.status} · {row.workspace}
                        </span>
                        {row.result ? <span className="assistant-inbox-body">{row.result.slice(0, 200)}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === "inbox" ? (
          <div className="assistant-pane">
            {!state?.inbox.length ? <p className="assistant-muted">收件箱是空的。</p> : null}
            <ul className="assistant-inbox">
              {state?.inbox.map((item) => (
                <li key={item.id} className={item.read ? "read" : "unread"}>
                  <button
                    type="button"
                    className="assistant-inbox-btn"
                    onClick={() => {
                      if (!item.read) {
                        op("inbox_read", { ids: [item.id] });
                        void closeInboxNotification(item.id);
                      }
                      onOpenInboxItem(item);
                    }}
                  >
                    <span className="assistant-inbox-title">{item.title}</span>
                    <span className="assistant-muted">{new Date(item.createdAt).toLocaleString()}</span>
                    <span className="assistant-inbox-body">{item.body.slice(0, 240)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {tab === "memory" ? (
          <div className="assistant-pane">
            {!state?.memory ? <p className="assistant-muted">正在加载记忆…</p> : null}
            {state?.memory ? (
              <>
                <section className="assistant-section">
                  <h3>核心档案</h3>
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
                        <label key={key} className="assistant-col-form">
                          <strong>{key}</strong>
                          <textarea
                            className="loop-goal"
                            rows={3}
                            value={coreDraft[key] ?? ""}
                            onChange={(e) => setCoreDraft({ ...coreDraft, [key]: e.target.value })}
                          />
                        </label>
                      ))}
                      <div className="assistant-row-actions">
                        <button type="submit" className="primary">
                          保存档案
                        </button>
                        <button type="button" className="ghost-btn" onClick={() => setCoreDraft(null)}>
                          取消
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="assistant-core">
                        {Object.entries(state.memory.core.fields).map(([key, value]) =>
                          value.trim() ? (
                            <div key={key}>
                              <strong>{key}</strong>
                              <p>{value}</p>
                            </div>
                          ) : null,
                        )}
                      </div>
                      <div className="assistant-row-actions">
                        <button type="button" className="ghost-btn" onClick={() => setCoreDraft({ ...state.memory!.core.fields })}>
                          编辑档案
                        </button>
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => op("memory_settings", { paused: !state.memory!.settings.paused })}
                        >
                          {state.memory.settings.paused ? "恢复记忆" : "暂停记忆"}
                        </button>
                      </div>
                    </>
                  )}
                  <p className="assistant-muted">
                    约 {state.memory.coreTokens}/{state.memory.coreBudget} token
                    {state.memory.settings.paused ? " · 记忆已暂停：模型不写新记忆，对话里也不注入" : ""}
                  </p>
                </section>
                <section className="assistant-section">
                  <h3>新增</h3>
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
                    <input className="side-input" value={memTopic} onChange={(e) => setMemTopic(e.target.value)} placeholder="主题" />
                    <textarea className="loop-goal" rows={3} value={memText} onChange={(e) => setMemText(e.target.value)} placeholder="要记住的内容" />
                    <button type="submit" className="primary">
                      保存
                    </button>
                  </form>
                </section>
                <section className="assistant-section">
                  <h3>条目 ({validEntries.length})</h3>
                  <ul className="assistant-list">
                    {validEntries.slice(0, 200).map((entry) =>
                      editing?.id === entry.id ? (
                        <li key={entry.id}>
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
                            <div className="assistant-row-actions">
                              <button type="submit" className="primary">
                                保存
                              </button>
                              <button type="button" className="ghost-btn" onClick={() => setEditing(null)}>
                                取消
                              </button>
                            </div>
                          </form>
                        </li>
                      ) : (
                        <li key={entry.id}>
                          <strong>{entry.topic}</strong>
                          <span className="assistant-tag">{entry.basis === "inferred" ? "推断" : "你说的"}</span>
                          {entry.validUntil ? <span className="assistant-tag">到 {entry.validUntil}</span> : null}
                          <p>{entry.text.slice(0, 300)}</p>
                          <div className="assistant-row-actions">
                            <button
                              type="button"
                              className="ghost-btn"
                              onClick={() => setEditing({ id: entry.id, rev: entry.rev, topic: entry.topic, text: entry.text })}
                            >
                              编辑
                            </button>
                            <button type="button" className="ghost-btn" onClick={() => op("memory_invalidate", { id: entry.id })}>
                              标失效
                            </button>
                            <button type="button" className="ghost-btn" onClick={() => op("memory_forget", { id: entry.id })}>
                              遗忘
                            </button>
                            <button type="button" className="ghost-btn" onClick={() => purge(entry)}>
                              彻底删除
                            </button>
                          </div>
                        </li>
                      ),
                    )}
                  </ul>
                  {invalidEntries.length ? (
                    <button type="button" className="ghost-btn" onClick={() => setShowInvalid(!showInvalid)}>
                      {showInvalid ? "收起已失效" : `已失效 (${invalidEntries.length})`}
                    </button>
                  ) : null}
                  {showInvalid ? (
                    <ul className="assistant-list compact">
                      {invalidEntries.slice(0, 100).map((entry) => (
                        <li key={entry.id}>
                          <strong>{entry.topic}</strong>
                          <span className="assistant-muted">{entry.invalidReason || "已失效"}</span>
                          <p>{entry.text.slice(0, 200)}</p>
                          <div className="assistant-row-actions">
                            <button type="button" className="ghost-btn" onClick={() => op("memory_restore", { id: entry.id })}>
                              恢复
                            </button>
                            <button type="button" className="ghost-btn" onClick={() => purge(entry)}>
                              彻底删除
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button type="button" className="ghost-btn" onClick={() => op("memory_export")}>
                    导出只读快照到 .jiebo/memory-export/
                  </button>
                </section>
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "notify" ? (
          <div className="assistant-pane">
            <p className="assistant-muted">推送待批、委派结果、提醒和每日简报。记忆写入和普通进度不推。</p>
            <div className="assistant-row-actions">
              <button type="button" className="primary" disabled={busy === "push"} onClick={() => void enablePush()}>
                开启浏览器通知
              </button>
              <button type="button" className="ghost-btn" onClick={() => op("push_test")}>
                发测试
              </button>
            </div>
            {typeof window !== "undefined" && !(window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone) ? (
              <p className="assistant-muted">iPhone 上把网页「添加到主屏幕」后，后台推送更可靠。</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
