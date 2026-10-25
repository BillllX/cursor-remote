"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { buildAssistantOpMessage, type BuildAssistantOpMessage } from "@shared/assistantOp";
import type { AssistantDelegation, AssistantResultMessage, AssistantState, ClientMessage } from "@shared/protocol";
import MemoryCenterPanel from "./assistant/MemoryCenterPanel";
import {
  assistantMemoryEntryText,
  initialAssistantMemoryNavigation,
  openAssistantMemoryNavigation,
  revisitAssistantMemoryNavigation,
  type AssistantMemorySource,
} from "./assistant/assistantMemoryNavigation";
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
  initialInboxId?: string;
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
  initialInboxId,
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
    if (initialView === "memory") {
      setMemoryLoaded(true);
    }
  }, [initialMemoryScopeId, initialMemorySource, initialView, open, openRequest]);

  useEffect(() => {
    if (!open || !initialInboxId || !state?.inbox.length) return;
    const item = state.inbox.find((row) => row.id === initialInboxId);
    if (item) {
      setTab("inbox");
      onViewChange?.("inbox");
      if (!item.read) op("inbox_read", { ids: [item.id] });
      void closeInboxNotification(item.id);
      onOpenInboxItem(item);
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
  const brief = state?.brief?.text?.trim();
  const memoryEntry = assistantMemoryEntryText(memoryNavigation);

  return (
    <div className="search-overlay open assistant-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`search-box assistant-box${tab === "memory" ? " memory-center-wide" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${name} · 助理`}
      >
        <div className="assistant-head">
          <div className="assistant-head-text">
            <div className="loop-title">{name} · 助理</div>
            <div className="loop-meta">
              后台 {state?.background.model || "grok-4.7"} · {backgroundOk ? "就绪" : state?.background.reason || "未就绪"}
            </div>
          </div>
          <button type="button" className="logout-btn" onClick={onClose}>
            关闭
          </button>
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
                          <button type="button" className="pill" onClick={() => onOpenChat(item.chatId)}>
                            看子会话
                          </button>
                        )}
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
