"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { buildAssistantOpMessage, type BuildAssistantOpMessage } from "@shared/assistantOp";
import type { AssistantDelegation, AssistantResultMessage, AssistantState, ClientMessage } from "@shared/protocol";
import { repairReplyText } from "@shared/replyText";
import MemoryCenterPanel from "./assistant/MemoryCenterPanel";
import {
  assistantMemoryEntryText,
  initialAssistantMemoryNavigation,
  openAssistantMemoryNavigation,
  revisitAssistantMemoryNavigation,
  type AssistantMemorySource,
} from "./assistant/assistantMemoryNavigation";
import { MemoMarkdown, REMARK_PLUGINS, SIMPLE_MD_COMPONENTS } from "./chat/markdown";
import { closeInboxNotification, registerAssistantPush } from "../lib/assistantPush";

export type AssistantView = "overview" | "inbox" | "memory" | "notify";

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
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialView?: AssistantView;
  initialMemoryScopeId?: string;
  initialMemorySource?: AssistantMemorySource;
  openRequest: number;
  onViewChange?: (view: AssistantView) => void;
  name: string;
  state: AssistantState | null;
  send: (message: ClientMessage) => void;
  onOpenInboxItem: (item: { chatId?: string; id: string }) => void;
  onOpenChat: (chatId: string) => void;
  onHandoffToAssistant?: (prompt: string) => void;
  initialInboxId?: string;
  initialDelegationId?: string;
  basePath: string;
  lastAssistantResult: AssistantResultMessage | null;
  assistantResultTick: number;
};

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
  onClose,
  dialogRef,
  initialView = "overview",
  initialMemoryScopeId,
  initialMemorySource = "assistant",
  openRequest,
  onViewChange,
  name,
  state,
  send,
  onOpenInboxItem,
  onOpenChat,
  onHandoffToAssistant,
  initialInboxId,
  initialDelegationId,
  basePath,
  lastAssistantResult,
  assistantResultTick,
}: Props) {
  const [tab, setTab] = useState<AssistantView>("overview");
  const [memoryNavigation, setMemoryNavigation] = useState(initialAssistantMemoryNavigation);
  const [appliedOpenRequest, setAppliedOpenRequest] = useState(-1);
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [todoDraft, setTodoDraft] = useState("");
  const [todoDueDraft, setTodoDueDraft] = useState("");
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editTodoText, setEditTodoText] = useState("");
  const [editTodoDue, setEditTodoDue] = useState("");
  const [selectedDelegationId, setSelectedDelegationId] = useState<string | null>(null);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);
  const [highlightedScheduleId, setHighlightedScheduleId] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const unread = useMemo(() => state?.inbox.filter((item) => !item.read).length ?? 0, [state?.inbox]);

  const op = useCallback((...params: Parameters<BuildAssistantOpMessage>) => {
    send(buildAssistantOpMessage(...params));
  }, [send]) as BuildAssistantOpMessage;

  useEffect(() => {
    if (!open) return;
    const current = stateRef.current;
    const memoryIsCurrent = Boolean(current?.memory);
    send({
      type: "assistant_get",
      memory: memoryLoaded,
      knownRevision: memoryLoaded && !memoryIsCurrent ? undefined : current?.revision,
    });
  }, [open, memoryLoaded, send]);

  useEffect(() => {
    if (!open || !memoryLoaded) return;
    return () => {
      send({ type: "assistant_get", memory: false });
    };
  }, [open, memoryLoaded, send]);

  useEffect(() => {
    if (!open) return;
    setTab(initialView);
    setMemoryNavigation((current) =>
      openAssistantMemoryNavigation(current, initialMemorySource, initialMemoryScopeId),
    );
    setAppliedOpenRequest(openRequest);
    if (initialDelegationId) {
      setSelectedDelegationId(initialDelegationId);
    }
    if (initialView === "memory") {
      setMemoryLoaded(true);
    }
  }, [initialDelegationId, initialMemoryScopeId, initialMemorySource, initialView, open, openRequest]);

  useEffect(() => {
    if (!open || !initialInboxId || !state?.inbox.length) return;
    const item = state.inbox.find((row) => row.id === initialInboxId);
    if (item) {
      setTab("inbox");
      setSelectedInboxId(item.id);
      onViewChange?.("inbox");
      if (!item.read) op("inbox_read", { ids: [item.id] });
      void closeInboxNotification(item.id);
      if (item.chatId) {
        onOpenInboxItem(item);
      }
    }
  }, [open, initialInboxId, state?.inbox, op, onOpenInboxItem, onViewChange]);

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

  function selectTab(next: AssistantView) {
    setTab(next);
    onViewChange?.(next);
    if (next === "memory") {
      setMemoryLoaded(true);
      setMemoryNavigation(revisitAssistantMemoryNavigation);
    }
  }

  if (!open) return null;

  const approvals = state?.approvals || [];
  const backgroundOk = state?.background.ok ?? false;
  const todosOpen = (state?.todos || []).filter((t) => !t.done);
  const todosDone = (state?.todos || []).filter((t) => t.done);
  const brief = state?.brief?.text?.trim();
  const memoryEntry = assistantMemoryEntryText(memoryNavigation);

  const isWorkspaceMemoryMode = memoryNavigation.source === "workspace" && tab === "memory";

  return (
    <div className="search-overlay workspace-modal-overlay open assistant-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`search-box assistant-box workspace-modal-box${tab === "memory" ? " memory-center-wide" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${name} · 助理`}
      >
        <div className="assistant-head workspace-modal-head">
          <div className="assistant-head-text workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <div className="loop-title workspace-modal-title">
                {isWorkspaceMemoryMode ? "记忆与规则" : `${name} · 助理`}
              </div>
              {isWorkspaceMemoryMode ? (
                <span className="workspace-modal-badge">
                  {memoryNavigation.target === "personal" ? "当前工作区" : memoryNavigation.target}
                </span>
              ) : null}
            </div>
            <div className="loop-meta workspace-modal-sub">
              {isWorkspaceMemoryMode
                ? `管理当前工作区记忆（.jiebo/memory.md）、规则（AGENTS.md / .cursor/rules）与个人偏好 · ${name}`
                : `后台 ${state?.background.model || "grok-4.7"} · ${backgroundOk ? "就绪" : state?.background.reason || "未就绪"}`}
            </div>
          </div>
          <div className="workspace-modal-actions">
            <button type="button" className="logout-btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div
          className="assistant-tabs"
          role="tablist"
          aria-label="助理功能"
          onKeyDown={(event) => {
            const tabs: AssistantView[] = ["overview", "inbox", "notify", "memory"];
            const index = tabs.indexOf(tab);
            let next = index;
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = tabs.length - 1;
            else return;
            event.preventDefault();
            const nextTab = tabs[next] ?? "overview";
            selectTab(nextTab);
            requestAnimationFrame(() => document.getElementById(`assistant-tab-${nextTab}`)?.focus());
          }}
        >
          {(
            [
              ["overview", approvals.length ? `总览 · ${approvals.length}` : "总览"],
              ["inbox", unread ? `收件箱 · ${unread}` : "收件箱"],
              ["notify", "通知"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              id={`assistant-tab-${id}`}
              role="tab"
              aria-controls="assistant-tabpanel"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              className={`pill${tab === id ? " on" : ""}`}
              onClick={() => selectTab(id)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            id="assistant-tab-memory"
            role="tab"
            aria-controls="assistant-tabpanel"
            aria-selected={tab === "memory"}
            tabIndex={tab === "memory" ? 0 : -1}
            className={`pill assistant-memory-entry${tab === "memory" ? " on" : ""}`}
            aria-label={memoryEntry.ariaLabel}
            onClick={() => selectTab("memory")}
          >
            {memoryEntry.label}
          </button>
        </div>
        {notice ? <div className="loop-meta assistant-notice">{notice}</div> : null}

        <div
          id="assistant-tabpanel"
          className="assistant-body"
          role="tabpanel"
          aria-labelledby={`assistant-tab-${tab}`}
        >
          {tab === "overview" ? (
            <>
              {approvals.length ? (
                <Section title="待批">
                  {approvals.map((item) => {
                    const owner = state?.delegations.find((row) => row.id === item.delegationId);
                    return (
                      <div key={item.id} className="approval-row assistant-approval">
                        <span>
                          {item.tool === "create_workspace" ? (
                            <>助理想新建工作区：{item.summary}</>
                          ) : item.tool === "workspace_memory" ? (
                            <>记进工作区记忆：{item.summary}</>
                          ) : item.tool === "work_preferences" ? (
                            <>记进工作偏好：{item.summary}</>
                          ) : (
                            <>
                              委派「{owner?.title || "未命名"}」要{item.tool === "shell" ? "跑命令" : "改文件"}
                              {item.summary ? `：${item.summary}` : ""}
                            </>
                          )}
                        </span>
                        <button type="button" className="pill" onClick={() => op("approval_answer", { chatId: item.chatId, callId: item.callId, allow: true })}>
                          批准
                        </button>
                        <button type="button" className="pill" onClick={() => op("approval_answer", { chatId: item.chatId, callId: item.callId, allow: false })}>
                          拒绝
                        </button>
                        {item.tool === "create_workspace" || item.tool === "work_preferences" ? null : (
                          <>
                            {item.delegationId ? (
                              <button
                                type="button"
                                className="pill"
                                onClick={() => {
                                  setSelectedDelegationId(item.delegationId!);
                                }}
                              >
                                看委派
                              </button>
                            ) : null}
                            <button type="button" className="pill" onClick={() => onOpenChat(item.chatId)}>
                              看子会话
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </Section>
              ) : null}
              <Section title="简报">
                {brief ? (
                  <div className="markdown assistant-markdown">
                    <MemoMarkdown remarkPlugins={REMARK_PLUGINS} components={SIMPLE_MD_COMPONENTS}>
                      {repairReplyText(brief)}
                    </MemoMarkdown>
                  </div>
                ) : (
                  <Empty>今天还没有简报。每日简报的日程到点后会生成。</Empty>
                )}
              </Section>
              <Section title="待办">
                <form
                  className="assistant-inline-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = todoDraft.trim();
                    if (!text) return;
                    const due = todoDueDraft.trim();
                    op("todo_add", due ? { text, due } : { text });
                    setTodoDraft("");
                    setTodoDueDraft("");
                  }}
                >
                  <input
                    className="side-input"
                    value={todoDraft}
                    onChange={(e) => setTodoDraft(e.target.value)}
                    placeholder="加一条待办"
                  />
                  <input
                    className="side-input"
                    style={{ maxWidth: 140 }}
                    value={todoDueDraft}
                    onChange={(e) => setTodoDueDraft(e.target.value)}
                    placeholder="截止时间（选填）"
                  />
                  <button type="submit" className="new-chat primary">
                    添加
                  </button>
                </form>
                {todosOpen.length ? (
                  <ul className="assistant-list">
                    {todosOpen.map((todo) => (
                      <li key={todo.id} className="assistant-item">
                        {editingTodoId === todo.id ? (
                          <form
                            className="assistant-inline-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const nextText = editTodoText.trim();
                              if (!nextText) return;
                              op("todo_update", {
                                id: todo.id,
                                text: nextText,
                                due: editTodoDue.trim(),
                              });
                              setEditingTodoId(null);
                            }}
                          >
                            <input
                              className="side-input"
                              value={editTodoText}
                              onChange={(e) => setEditTodoText(e.target.value)}
                              placeholder="待办内容"
                              autoFocus
                            />
                            <input
                              className="side-input"
                              style={{ maxWidth: 130 }}
                              value={editTodoDue}
                              onChange={(e) => setEditTodoDue(e.target.value)}
                              placeholder="截止时间（空则清除）"
                            />
                            <button type="submit" className="pill">
                              保存
                            </button>
                            <button type="button" className="pill" onClick={() => setEditingTodoId(null)}>
                              取消
                            </button>
                          </form>
                        ) : (
                          <>
                            <div className="assistant-item-head">
                              <span className="assistant-item-title">{todo.text}</span>
                              {todo.due ? <span className="chat-mark">{todo.due}</span> : null}
                              <button type="button" className="pill" onClick={() => op("todo_done", { id: todo.id })}>
                                完成
                              </button>
                              <button
                                type="button"
                                className="pill"
                                onClick={() => {
                                  setEditingTodoId(todo.id);
                                  setEditTodoText(todo.text);
                                  setEditTodoDue(todo.due || "");
                                }}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="pill"
                                onClick={() => op("todo_remove", { id: todo.id })}
                              >
                                删除
                              </button>
                            </div>
                            {todo.quote ? <div className="loop-meta">来源：{todo.quote}</div> : null}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>没有未完成的待办。</Empty>
                )}
                {todosDone.length ? (
                  <details className="assistant-done-todos" style={{ marginTop: 8 }}>
                    <summary className="loop-meta" style={{ cursor: "pointer", userSelect: "none" }}>
                      已完成 · {todosDone.length}
                    </summary>
                    <ul className="assistant-list" style={{ marginTop: 6 }}>
                      {todosDone.map((todo) => (
                        <li key={todo.id} className="assistant-item">
                          <div className="assistant-item-head">
                            <span className="assistant-item-title" style={{ textDecoration: "line-through", opacity: 0.72 }}>
                              {todo.text}
                            </span>
                            {todo.due ? <span className="chat-mark">{todo.due}</span> : null}
                            <button type="button" className="pill" onClick={() => op("todo_undo", { id: todo.id })}>
                              撤销完成
                            </button>
                            <button type="button" className="pill" onClick={() => op("todo_remove", { id: todo.id })}>
                              删除
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Section>
              <Section title="日程">
                {state?.schedules?.length ? (
                  <ul className="assistant-list">
                    {state.schedules.map((row) => (
                      <li
                        key={row.id}
                        className={`assistant-item${highlightedScheduleId === row.id ? " unread" : ""}`}
                      >
                        <div className="assistant-item-head">
                          <span className="assistant-item-title">{row.title}</span>
                          <span className={`chat-mark ${row.enabled ? "ok" : "warn"}`}>{row.enabled ? "启用" : "暂停"}</span>
                          <button
                            type="button"
                            className="pill"
                            onClick={() => op("schedule_set", { id: row.id, enabled: !row.enabled })}
                          >
                            {row.enabled ? "暂停" : "启用"}
                          </button>
                          <button
                            type="button"
                            className="pill"
                            onClick={() => {
                              if (window.confirm(`删除日程「${row.title}」？`)) {
                                op("schedule_remove", { id: row.id });
                              }
                            }}
                          >
                            删除
                          </button>
                        </div>
                        <div className="loop-meta">
                          {row.cron}
                          {row.pausedReason ? ` · ${row.pausedReason}` : ""}
                        </div>
                        {row.prompt ? <div className="assistant-item-body">{row.prompt}</div> : null}
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
                    {state.delegations.slice(0, 12).map((row) => {
                      const expanded = selectedDelegationId === row.id;
                      return (
                        <li key={row.id} className="assistant-item">
                          <div
                            className="assistant-item-head"
                            style={{ cursor: "pointer" }}
                            onClick={() => setSelectedDelegationId(expanded ? null : row.id)}
                          >
                            <span className="assistant-item-title">{row.title}</span>
                            <span className={`chat-mark ${DELEGATION_TONE[row.status] ?? ""}`}>
                              {DELEGATION_STATUS[row.status] ?? row.status}
                            </span>
                            <button
                              type="button"
                              className="pill"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedDelegationId(expanded ? null : row.id);
                              }}
                            >
                              {expanded ? "收起详情" : "详情"}
                            </button>
                            <button
                              type="button"
                              className="pill"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenChat(row.childChatId);
                              }}
                            >
                              打开子会话
                            </button>
                          </div>
                          <div className="loop-meta">
                            {row.workspace} · {new Date(row.createdAt).toLocaleString()}
                          </div>
                          {row.result ? (
                            expanded ? (
                              <div className="markdown assistant-markdown" style={{ marginTop: 8 }}>
                                <MemoMarkdown remarkPlugins={REMARK_PLUGINS} components={SIMPLE_MD_COMPONENTS}>
                                  {repairReplyText(row.result)}
                                </MemoMarkdown>
                              </div>
                            ) : (
                              <div className="assistant-item-body">{row.result.slice(0, 200)}</div>
                            )
                          ) : null}
                          {expanded ? (
                            <div className="loop-actions" style={{ marginTop: 8 }}>
                              <button type="button" className="pill" onClick={() => onOpenChat(row.childChatId)}>
                                打开子会话
                              </button>
                              {row.parentChatId ? (
                                <button type="button" className="pill" onClick={() => onOpenChat(row.parentChatId!)}>
                                  打开父会话
                                </button>
                              ) : null}
                              {onHandoffToAssistant ? (
                                <button
                                  type="button"
                                  className="pill"
                                  onClick={() =>
                                    onHandoffToAssistant(
                                      `请帮我跟进委派任务「${row.title}」（工作区：${row.workspace}，状态：${DELEGATION_STATUS[row.status] ?? row.status}）${row.result ? `：\n\n${row.result.slice(0, 1200)}` : ""}`,
                                    )
                                  }
                                >
                                  交给{name}处理
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <Empty>还没有委派。在助理会话里让{name}把事交给某个子工作区就会出现在这里。</Empty>
                )}
              </Section>
            </>
          ) : null}

          {tab === "inbox" ? (
            state?.inbox.length ? (
              <>
                {unread > 0 ? (
                  <div className="loop-actions" style={{ marginBottom: 8 }}>
                    <button
                      type="button"
                      className="pill"
                      onClick={() =>
                        op("inbox_read", {
                          ids: state.inbox.filter((item) => !item.read).map((item) => item.id),
                        })
                      }
                    >
                      全部标为已读（{unread}）
                    </button>
                  </div>
                ) : null}
                <ul className="assistant-list">
                  {state.inbox.map((item) => {
                    const expanded = selectedInboxId === item.id;
                    return (
                      <li
                        key={item.id}
                        className={`assistant-item${item.read ? "" : " unread"}`}
                        onClick={() => {
                          if (!item.read) {
                            op("inbox_read", { ids: [item.id] });
                            void closeInboxNotification(item.id);
                          }
                          setSelectedInboxId(expanded ? null : item.id);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        <div className="assistant-item-head">
                          {item.read ? null : <span className="chat-mark unread">未读</span>}
                          <span className="assistant-item-title">{item.title}</span>
                          <button
                            type="button"
                            className="pill"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!item.read) {
                                op("inbox_read", { ids: [item.id] });
                                void closeInboxNotification(item.id);
                              }
                              setSelectedInboxId(expanded ? null : item.id);
                            }}
                          >
                            {expanded ? "收起" : "展开"}
                          </button>
                        </div>
                        <div className="loop-meta">{new Date(item.createdAt).toLocaleString()}</div>
                        {expanded || item.body.length <= 240 ? (
                          <div className="markdown assistant-markdown" style={{ marginTop: 6 }}>
                            <MemoMarkdown remarkPlugins={REMARK_PLUGINS} components={SIMPLE_MD_COMPONENTS}>
                              {repairReplyText(item.body)}
                            </MemoMarkdown>
                          </div>
                        ) : (
                          <div className="assistant-item-body">{item.body.slice(0, 240)}…</div>
                        )}
                        <div className="loop-actions" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                          {onHandoffToAssistant ? (
                            <button
                              type="button"
                              className="pill"
                              onClick={() => {
                                if (!item.read) {
                                  op("inbox_read", { ids: [item.id] });
                                  void closeInboxNotification(item.id);
                                }
                                onHandoffToAssistant(
                                  item.actionPrompt?.trim() ||
                                    `请帮我处理这条通知：「${item.title}」\n\n${item.body}`,
                                );
                              }}
                            >
                              交给{name}处理
                            </button>
                          ) : null}
                          {item.chatId ? (
                            <button
                              type="button"
                              className="pill"
                              onClick={() => {
                                if (!item.read) {
                                  op("inbox_read", { ids: [item.id] });
                                  void closeInboxNotification(item.id);
                                }
                                onOpenInboxItem(item);
                              }}
                            >
                              打开会话
                            </button>
                          ) : null}
                          {item.delegationId ? (
                            <button
                              type="button"
                              className="pill"
                              onClick={() => {
                                setSelectedDelegationId(item.delegationId!);
                                selectTab("overview");
                              }}
                            >
                              查看委派
                            </button>
                          ) : null}
                          {item.scheduleId ? (
                            <button
                              type="button"
                              className="pill"
                              onClick={() => {
                                setHighlightedScheduleId(item.scheduleId!);
                                selectTab("overview");
                              }}
                            >
                              查看日程
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <Empty>收件箱是空的。提醒、委派结果和待批会出现在这里。</Empty>
            )
          ) : null}

          {tab === "memory" ? (
            !state?.memory || appliedOpenRequest !== openRequest ? (
              <Empty>正在加载记忆…</Empty>
            ) : (
              <MemoryCenterPanel
                active={memoryLoaded}
                initialScopeId={memoryNavigation.target}
                openRequest={memoryNavigation.request}
                name={name}
                state={state}
                send={send}
                op={op}
                lastResult={lastAssistantResult}
                resultTick={assistantResultTick}
                onNotice={setNotice}
              />
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
