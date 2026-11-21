"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildAssistantOpMessage } from "@shared/assistantOp";
import type { AssistantResultMessage, AssistantState, ClientMessage, KbWorkspaceStatusData } from "@shared/protocol";
import { WorkspaceScheduleSection } from "../chat/WorkspaceScheduleSection";

type Props = {
  initialWorkspaceKey?: string;
  highlightedScheduleId?: string | null;
  state: AssistantState | null;
  results: AssistantResultMessage[];
  send: (message: ClientMessage) => void;
  onOpenArtifact: (workspaceKey: string, path: string) => void;
};

const personalStatuses: Record<string, string> = {
  running: "正在执行",
  done: "已完成",
  failed: "失败",
  interrupted: "已中断",
  skipped: "已跳过",
};

export function AssistantAutomationSection({
  initialWorkspaceKey,
  highlightedScheduleId,
  state,
  results,
  send,
  onOpenArtifact,
}: Props) {
  const [filter, setFilter] = useState(
    highlightedScheduleId ? "personal" : initialWorkspaceKey ? "workspace:" + initialWorkspaceKey : "all",
  );
  const [editingReminder, setEditingReminder] = useState<{ id: string; text: string; localTime: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ kind: "schedule" | "reminder"; id: string } | null>(null);
  const [data, setData] = useState<KbWorkspaceStatusData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<KbWorkspaceStatusData["workspaceBackfill"]>();
  const [saved, setSaved] = useState<{
    workspace: string;
    result: NonNullable<KbWorkspaceStatusData["workspaceScheduleResult"]>;
  }>();
  const readId = useRef<string | undefined>(undefined);
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [readError, setReadError] = useState("");
  const mutation = useRef<{ id: string; workspace?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(
    (force = false) => {
      if (readId.current && !force) return;
      clearTimeout(readTimer.current);
      const message = buildAssistantOpMessage("kb_workspace_status", { workspace: "__all__", automationOnly: true });
      readId.current = message.reqId;
      readTimer.current = setTimeout(() => {
        readId.current = undefined;
        setReadError("读取自动化超时，请刷新重试。");
      }, 15000);
      send(message);
    },
    [send],
  );

  useEffect(() => {
    refresh();
    return () => {
      clearTimeout(timer.current);
      clearTimeout(readTimer.current);
      readId.current = undefined;
    };
  }, [refresh]);

  useEffect(() => {
    for (const result of results) {
      if (result.reqId && result.reqId === readId.current) {
        clearTimeout(readTimer.current);
        readId.current = undefined;
        if (!result.ok) setReadError(result.error || "无法读取自动化，请重试。");
        else if (result.op === "kb_workspace_status") {
          if (!result.data?.automationWorkspaces) setReadError("当前网关版本暂不支持工作区汇总。");
          else {
            setReadError("");
            setData(result.data);
          }
        }
      } else if (result.reqId && result.reqId === mutation.current?.id) {
        const workspace = mutation.current.workspace;
        mutation.current = null;
        clearTimeout(timer.current);
        setBusy(false);
        if (!result.ok) {
          setError(result.error || "操作未完成。");
        } else {
          const update = result.op === "drop_token_update" ? result.data?.workspaceScheduleResult : undefined;
          if (workspace && update) setSaved({ workspace, result: update });
          const report = result.op === "drop_token_update" ? result.data?.workspaceBackfill : undefined;
          if (report) setPreview(report);
          if (result.op === "todo_update") setEditingReminder(null);
          if (!report) setNotice(update?.message || "已更新定时与提醒");
        }
        refresh(true);
        send({ type: "assistant_get" });
      }
    }
  }, [results, refresh, send]);

  const running = data?.workspaceSchedules?.some((rule) => rule.state !== "idle");
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [running, refresh]);

  function update(message: ClientMessage, workspace?: string) {
    if (message.type !== "assistant_op" || !message.reqId || mutation.current) return;
    mutation.current = { id: message.reqId, workspace };
    setPreview(undefined);
    setBusy(true);
    setError("");
    setNotice("");
    timer.current = setTimeout(() => {
      mutation.current = null;
      setBusy(false);
      setError("暂未收到回执，已刷新列表，请先核对状态。");
      refresh(true);
      send({ type: "assistant_get" });
    }, 18000);
    send(message);
  }

  const workspaces = data?.automationWorkspaces ?? [];
  const schedules = data?.workspaceSchedules ?? [];
  const runs = data?.workspaceScheduleRuns ?? [];
  const selected = workspaces.find(({ key }) => "workspace:" + key === filter);
  const visibleWorkspaces = workspaces.filter(({ key }) =>
    filter === "all"
      ? schedules.some((row) => row.workspaceKey === key) || runs.some((row) => row.workspaceKey === key)
      : key === selected?.key,
  );

  const reminders = (state?.todos ?? []).filter(
    (item) => !item.done && item.due?.includes("T") && Date.parse(item.due) > Date.now(),
  );

  const calendarEvents = (state?.personalTasks ?? []).filter(
    (item) => item.kind === "calendar_event" && item.phase !== "completed",
  );

  function editReminder(id: string, text: string, due: string) {
    const date = new Date(due);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    setEditingReminder({ id, text, localTime: local.toISOString().slice(0, 16) });
    setConfirmRemove(null);
  }

  function saveReminder() {
    if (!editingReminder) return;
    const text = editingReminder.text.trim();
    const date = new Date(editingReminder.localTime);
    if (!text || !(date.getTime() > Date.now())) {
      setError("请填写提醒内容及将来的提醒时间。");
      return;
    }
    update(buildAssistantOpMessage("todo_update", { id: editingReminder.id, text, due: date.toISOString() }));
  }

  function remove(kind: "schedule" | "reminder", id: string) {
    update(
      kind === "schedule"
        ? buildAssistantOpMessage("schedule_remove", { id })
        : buildAssistantOpMessage("todo_done", { id }),
    );
    setConfirmRemove(null);
  }

  function removalControls(kind: "schedule" | "reminder", id: string) {
    const matches = confirmRemove?.kind === kind && confirmRemove.id === id;
    return matches ? (
      <div role="group" aria-label="确认停止" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" className="new-chat danger-btn" disabled={busy} onClick={() => remove(kind, id)}>
          确认{kind === "schedule" ? "删除" : "取消提醒"}
        </button>
        <button type="button" className="new-chat" onClick={() => setConfirmRemove(null)}>
          返回
        </button>
      </div>
    ) : (
      <button
        type="button"
        className="new-chat danger-btn"
        disabled={busy}
        onClick={() => setConfirmRemove({ kind, id })}
      >
        {kind === "schedule" ? "删除" : "取消提醒"}
      </button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <label>
          按归属筛选{" "}
          <select
            className="search-input"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setConfirmRemove(null);
              setEditingReminder(null);
              setError("");
            }}
          >
            <option value="all">全部</option>
            <option value="personal">小驳</option>
            {filter.startsWith("workspace:") && !selected && (
              <option value={filter}>{filter.slice("workspace:".length)}</option>
            )}
            {workspaces.map(({ id, key }) => (
              <option key={id} value={"workspace:" + key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <button
          className="new-chat"
          type="button"
          disabled={busy}
          onClick={() => {
            setError("");
            setReadError("");
            refresh(true);
            send({ type: "assistant_get" });
          }}
        >
          刷新
        </button>
      </div>
      {error && (
        <div role="alert" className="loop-meta">
          {error}
        </div>
      )}
      {readError && filter !== "personal" && (
        <div role="alert" className="loop-meta">
          {readError}
        </div>
      )}
      {notice && (
        <div role="status" className="loop-meta">
          {notice}
        </div>
      )}
      {(filter === "all" || filter === "personal") && (
        <section aria-label="小驳的定时">
          <h3>小驳</h3>
          {!state ? (
            <p>正在读取小驳的定时…</p>
          ) : !state.schedules.length && !reminders.length && !calendarEvents.length ? (
            <p>小驳还没有定时任务。</p>
          ) : null}
          {state?.schedules.map((item) => (
            <article
              key={item.id}
              className={`approval-row${highlightedScheduleId === item.id ? " unread" : ""}`}
              style={{ display: "grid", gap: 6 }}
            >
              <strong>{item.title}</strong>
              <span>
                {item.enabled ? "已启用" : "已暂停"}
                {item.lastStatus ? " · 上次" + (personalStatuses[item.lastStatus] ?? "状态待更新") : ""}
              </span>
              {item.enabled && item.nextAt != null && (
                <span>
                  下次运行 {new Date(item.nextAt).toLocaleString("zh-CN", { timeZone: item.tz })}（{item.tz}）
                </span>
              )}
              {item.pausedReason && <span>{item.pausedReason}</span>}
              <div>
                <button
                  type="button"
                  className="new-chat"
                  disabled={busy}
                  onClick={() =>
                    update(buildAssistantOpMessage("schedule_set", { id: item.id, enabled: !item.enabled }))
                  }
                >
                  {item.enabled ? "暂停" : "启用"}
                </button>
                {removalControls("schedule", item.id)}
              </div>
            </article>
          ))}
          {reminders.map((item) => (
            <article key={item.id} className="approval-row" style={{ display: "grid", gap: 6 }}>
              <strong>{item.text}</strong>
              <span>一次提醒 · {new Date(item.due!).toLocaleString("zh-CN")}</span>
              {editingReminder?.id === item.id ? (
                <form
                  style={{ display: "grid", gap: 8 }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveReminder();
                  }}
                >
                  <label>
                    提醒内容{" "}
                    <input
                      className="search-input"
                      required
                      value={editingReminder.text}
                      onChange={(event) => setEditingReminder({ ...editingReminder, text: event.target.value })}
                    />
                  </label>
                  <label>
                    提醒时间（当前时区）{" "}
                    <input
                      className="search-input"
                      type="datetime-local"
                      required
                      value={editingReminder.localTime}
                      onChange={(event) => setEditingReminder({ ...editingReminder, localTime: event.target.value })}
                    />
                  </label>
                  <div>
                    <button type="submit" className="new-chat primary" disabled={busy}>
                      保存提醒
                    </button>
                    <button type="button" className="new-chat" disabled={busy} onClick={() => setEditingReminder(null)}>
                      返回
                    </button>
                  </div>
                </form>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    className="new-chat"
                    disabled={busy}
                    onClick={() => editReminder(item.id, item.text, item.due!)}
                  >
                    编辑提醒
                  </button>
                  {removalControls("reminder", item.id)}
                </div>
              )}
            </article>
          ))}
          {calendarEvents.map((item) => (
            <article key={item.id} className="approval-row" style={{ display: "grid", gap: 6 }}>
              <strong>{item.title}</strong>
              <span>日历事件{item.dueAt != null ? " · " + new Date(item.dueAt).toLocaleString("zh-CN") : ""}</span>
            </article>
          ))}
        </section>
      )}
      {filter !== "personal" && !data && !readError && <p role="status">正在读取工作区自动化…</p>}
      {filter === "all" && data && !visibleWorkspaces.length && <p>各工作区还没有自动化。筛选一个工作区即可新建。</p>}
      {filter.startsWith("workspace:") && data && !selected && <p>该工作区当前不可用，请选择其他归属。</p>}
      {visibleWorkspaces.map(({ id, key }) => (
        <WorkspaceScheduleSection
          key={id}
          workspaceKey={id}
          heading={key}
          summaryOnly
          showCreate={filter !== "all"}
          schedules={schedules.filter((rule) => rule.workspaceId === id)}
          runs={runs.filter((run) => run.workspaceId === id)}
          loading={busy}
          backfillPreview={preview}
          lastScheduleResult={saved?.workspace === id ? saved.result : undefined}
          sendKbOperation={(message) => update(message, id)}
          onOpenBoard={(path) => onOpenArtifact(key, path)}
          setErrorText={setError}
        />
      ))}
    </div>
  );
}
