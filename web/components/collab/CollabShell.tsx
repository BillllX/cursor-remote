"use client";

import { useMemo, useState } from "react";
import type { CollabRunState, TurnFile } from "@shared/protocol";
import type { CollabAction, CollabDraft, CollabUiState } from "./collabState";
import { CollabComposer } from "./CollabComposer";
import { CollabInspector } from "./CollabInspector";
import { CollabSidebar } from "./CollabSidebar";
import { CollabThread } from "./CollabThread";
import { latestRunForRoom } from "./collabView";
import styles from "./collab.module.css";

export function CollabShell({
  state,
  dispatch,
  selectRoom,
  selectTask,
  updateDraft,
  sendMessage,
  operate,
  createGroup,
  updateGroup,
  onOpenFile,
  onOpenAssistant,
  onOpenWorkspace,
}: {
  state: CollabUiState;
  dispatch: (action: CollabAction) => void;
  selectRoom: (convId: string) => void;
  selectTask: (runId?: string, taskId?: string) => void;
  updateDraft: (convId: string, draft: CollabDraft) => void;
  sendMessage: (convId: string) => void;
  operate: (
    convId: string,
    op: "cancel_run" | "cancel_task" | "retry_task" | "retry_publish" | "answer_approval",
    runId?: string,
    taskId?: string,
    allow?: boolean,
  ) => void;
  createGroup: (title: string, actorIds: string[]) => void;
  updateGroup: (convId: string, patch: { title?: string; actorIds?: string[]; archived?: boolean }) => void;
  onOpenFile: (file: TurnFile) => void;
  onOpenAssistant: () => void;
  onOpenWorkspace: () => void;
}) {
  const [mobileList, setMobileList] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(state.selectedTaskId));
  const rooms = state.roomOrder.map((id) => state.rooms[id]).filter(Boolean);
  const room = state.selectedConvId ? state.rooms[state.selectedConvId] : undefined;
  const messages = state.selectedConvId ? (state.messages[state.selectedConvId] ?? []) : [];
  const runs = useMemo(
    () =>
      state.selectedConvId
        ? (state.runOrder[state.selectedConvId] ?? [])
            .map((id) => state.runs[id])
            .filter((run): run is CollabRunState => Boolean(run))
        : [],
    [state.runOrder, state.runs, state.selectedConvId],
  );
  const latestRun = latestRunForRoom(runs);
  const latestWave = latestRun?.tasks.reduce((max, task) => Math.max(max, task.wave ?? 1), 1);
  // 恢复 wave 已替代之前的执行，旧失败仍可在详情中审计，但不再占用全局操作条。
  const actionable = latestRun
    ? latestRun.tasks
        .filter(
          (task) =>
            (task.wave ?? 1) === latestWave && ["awaiting", "failed", "running", "publishing"].includes(task.status),
        )
        .map((task) => ({ run: latestRun, task }))
    : [];
  const roomRuns = (convId: string) =>
    (state.runOrder[convId] ?? []).map((id) => state.runs[id]).filter((run): run is CollabRunState => Boolean(run));
  const availableActors = useMemo(
    () => [...new Map(rooms.flatMap((item) => item.actors).map((actor) => [actor.actorId, actor])).values()],
    [rooms],
  );

  const roomOperate = (
    op: "cancel_run" | "cancel_task" | "retry_task" | "retry_publish" | "answer_approval",
    runId?: string,
    taskId?: string,
    allow?: boolean,
  ) => {
    if (!room) return;
    if (
      (op === "cancel_run" || op === "cancel_task") &&
      !window.confirm("停止只会终止运行，不会回滚已经产生的文件改动。确定停止吗？")
    ) {
      return;
    }
    operate(room.convId, op, runId, taskId, allow);
  };

  return (
    <div
      className={`${styles.shell}${mobileList ? ` ${styles.showList}` : ""}${inspectorOpen ? ` ${styles.showInspector}` : ""}`}
    >
      <nav className={styles.mobileDomains} aria-label="一级导航">
        <button type="button" onClick={onOpenAssistant}>
          助理
        </button>
        <button type="button" className={styles.selected} aria-current="page">
          协作
        </button>
        <button type="button" onClick={onOpenWorkspace}>
          工作区
        </button>
      </nav>
      <CollabSidebar
        rooms={rooms}
        selectedConvId={state.selectedConvId}
        runsForRoom={roomRuns}
        onSelect={(convId) => {
          selectRoom(convId);
          setMobileList(false);
        }}
        onCreate={() => {
          const title = window.prompt("项目协作群名称");
          if (title?.trim()) {
            createGroup(
              title.trim(),
              availableActors.filter((actor) => actor.kind === "assistant").map((actor) => actor.actorId),
            );
          }
        }}
      />
      {room ? (
        <div className={styles.center}>
          {state.connection !== "online" ? (
            <div className={styles.connectionBar} role="status">
              已离线，正在重连；历史仍可查看，草稿会保留
            </div>
          ) : state.lastSyncAt ? (
            <div className={styles.syncStatus} aria-live="polite">
              状态已同步
            </div>
          ) : null}
          <CollabThread
            title={room.title}
            actors={room.actors}
            messages={messages}
            runs={runs}
            loading={Boolean(state.historyLoading[room.convId])}
            selectedTaskId={state.selectedTaskId}
            onBack={() => setMobileList(true)}
            onShowDetails={() => setInspectorOpen(true)}
            onSelectTask={(runId, taskId) => {
              selectTask(runId, taskId);
              setInspectorOpen(true);
            }}
            onOpenFile={onOpenFile}
            onOperate={roomOperate}
          />
          {actionable.length ? (
            <div className={styles.actionDock} aria-label="运行操作" role="region" aria-live="polite">
              <strong>{actionable.length} 项进行中或需要处理</strong>
              <div>
                {actionable.slice(0, 3).map(({ run, task }) =>
                  task.status === "awaiting" ? (
                    <button
                      type="button"
                      key={task.taskId}
                      onClick={() => roomOperate("answer_approval", run.runId, task.taskId, true)}
                      disabled={Boolean(task.approval && task.approval.expiresAt <= Date.now())}
                    >
                      {task.approval && task.approval.expiresAt <= Date.now() ? "审批已过期" : "批准"}
                    </button>
                  ) : task.status === "failed" ? (
                    <button
                      type="button"
                      key={task.taskId}
                      onClick={() =>
                        roomOperate(
                          task.error?.code === "publish_failed" ? "retry_publish" : "retry_task",
                          run.runId,
                          task.taskId,
                        )
                      }
                    >
                      {task.error?.code === "publish_failed" ? "重试发送结果" : "重试"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      key={task.taskId}
                      onClick={() => roomOperate("cancel_task", run.runId, task.taskId)}
                    >
                      {task.status === "publishing" ? "重试投影前先停止" : "停止"}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  onClick={() => {
                    const first = actionable[0];
                    selectTask(first.run.runId, first.task.taskId);
                    setInspectorOpen(true);
                  }}
                >
                  查看详情
                </button>
              </div>
            </div>
          ) : null}
          <CollabComposer
            convId={room.convId}
            actors={room.actors}
            draft={state.drafts[room.convId]}
            online={state.connection === "online"}
            onChange={(draft) => updateDraft(room.convId, draft)}
            onSend={() => sendMessage(room.convId)}
          />
        </div>
      ) : (
        <main className={styles.noRoom}>
          <strong>正在准备协作群…</strong>
          <p>连接后会创建“小驳协作群”。</p>
        </main>
      )}
      {room ? (
        <>
          <button
            type="button"
            className={styles.inspectorScrim}
            aria-label="关闭协作详情"
            onClick={() => {
              setInspectorOpen(false);
              selectTask();
            }}
          />
          <CollabInspector
            view={state.inspector}
            actors={room.actors}
            runs={runs}
            messages={messages}
            selectedRunId={state.selectedRunId}
            selectedTaskId={state.selectedTaskId}
            onView={(inspector) => dispatch({ type: "inspector", inspector })}
            onClose={() => {
              setInspectorOpen(false);
              selectTask();
            }}
            onSelectTask={(runId, taskId) => {
              selectTask(runId, taskId);
              setInspectorOpen(true);
            }}
            onOpenFile={onOpenFile}
            onOperate={roomOperate}
            availableActors={availableActors}
            onUpdateGroup={(patch) => updateGroup(room.convId, patch)}
          />
        </>
      ) : null}
      {state.error ? (
        <div className={styles.toast} role="alert">
          {state.error}
          <button type="button" onClick={() => dispatch({ type: "error" })}>
            关闭
          </button>
        </div>
      ) : null}
    </div>
  );
}
