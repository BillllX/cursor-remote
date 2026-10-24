import type { ActorRef, CollabAnchorBody, CollabRunState, ImMessage, TurnFile } from "@shared/protocol";
import type { CollabInspectorView } from "./collabState";
import { TASK_STATUS } from "./collabView";
import styles from "./collab.module.css";

function filesFrom(messages: ImMessage[], runs: CollabRunState[]) {
  const files: Array<{ file: TurnFile; runId: string; taskId?: string }> = [];
  for (const message of messages) {
    if (message.kind !== "collab" || !message.body || !("schema" in message.body)) continue;
    const body = message.body as CollabAnchorBody;
    for (const file of body.files ?? []) files.push({ file, runId: body.runId, taskId: body.taskId });
  }
  for (const run of runs) {
    for (const task of run.tasks) {
      for (const file of task.files ?? []) files.push({ file, runId: run.runId, taskId: task.taskId });
    }
  }
  const unique = new Map(files.map((row) => [`${row.runId}:${row.taskId ?? ""}:${row.file.path}`, row]));
  return [...unique.values()];
}

export function CollabInspector({
  view,
  actors,
  runs,
  messages,
  selectedRunId,
  selectedTaskId,
  onView,
  onClose,
  onSelectTask,
  onOpenFile,
  onOperate,
  availableActors,
  onUpdateGroup,
}: {
  view: CollabInspectorView;
  actors: ActorRef[];
  runs: CollabRunState[];
  messages: ImMessage[];
  selectedRunId?: string;
  selectedTaskId?: string;
  onView: (view: CollabInspectorView) => void;
  onClose: () => void;
  onSelectTask: (runId?: string, taskId?: string) => void;
  onOpenFile: (file: TurnFile) => void;
  onOperate: (
    op: "cancel_run" | "cancel_task" | "retry_task" | "retry_publish" | "answer_approval",
    runId?: string,
    taskId?: string,
    allow?: boolean,
  ) => void;
  availableActors: ActorRef[];
  onUpdateGroup: (patch: { title?: string; actorIds?: string[]; archived?: boolean }) => void;
}) {
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? runs.at(-1);
  const selectedTask = selectedRun?.tasks.find((task) => task.taskId === selectedTaskId);
  const files = filesFrom(messages, runs);
  const tasks = runs.flatMap((run) => run.tasks.map((task) => ({ run, task })));
  const done = tasks.filter(({ task }) => ["succeeded", "failed", "cancelled"].includes(task.status)).length;

  return (
    <aside className={styles.inspector} aria-label="当前协作详情">
      <header className={styles.inspectorHead}>
        <strong>{view === "task" ? "任务详情" : "当前协作"}</strong>
        <button type="button" onClick={onClose} aria-label="关闭协作详情">
          ×
        </button>
      </header>
      <div className={styles.inspectorTabs} role="tablist" aria-label="协作详情分类">
        {(["progress", "outputs", "members"] as const).map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === tab || (tab === "progress" && view === "task")}
            className={view === tab || (tab === "progress" && view === "task") ? styles.selected : ""}
            key={tab}
            onClick={() => onView(tab)}
          >
            {tab === "progress" ? "进展" : tab === "outputs" ? "产出" : "成员"}
          </button>
        ))}
      </div>
      <div className={styles.inspectorBody}>
        {view === "task" && selectedTask && selectedRun ? (
          <>
            <button type="button" className={styles.backDetail} onClick={() => onView("progress")}>
              ‹ 返回进展
            </button>
            <section className={styles.detailBlock}>
              <span className={styles.eyebrow}>任务</span>
              <h2>{selectedTask.summary || "协作任务"}</h2>
              <p>{TASK_STATUS[selectedTask.status].label}</p>
              <dl>
                <dt>工作区</dt>
                <dd>
                  {actors.find(
                    (actor) => actor.kind === "workspace_agent" && actor.workspaceId === selectedTask.workspaceId,
                  )?.displayName || selectedTask.workspaceId}
                </dd>
                <dt>任务版本</dt>
                <dd>{selectedTask.version}</dd>
                <dt>当前 attempt</dt>
                <dd>{selectedTask.attempt}</dd>
              </dl>
              {selectedTask.suggestedNextActors?.length ? (
                <p>建议下一步 Agent：{selectedTask.suggestedNextActors.join("、")}（仅供小驳规划）</p>
              ) : null}
            </section>
            <section className={styles.detailBlock} aria-label="Attempt 历史">
              <span className={styles.eyebrow}>Attempt 历史（不可变）</span>
              {selectedTask.attempts.map((attempt) => (
                <div key={attempt.attempt}>
                  <strong>#{attempt.attempt}</strong> · {TASK_STATUS[attempt.status].label}
                  {attempt.error ? <p>{attempt.error.message}</p> : null}
                  {attempt.files?.map((file) => (
                    <button type="button" key={file.path} onClick={() => onOpenFile(file)}>
                      {file.path}
                    </button>
                  ))}
                </div>
              ))}
            </section>
            <div className={styles.detailActions}>
              {["pending", "queued", "running", "awaiting", "blocked", "publishing"].includes(selectedTask.status) ? (
                <button type="button" onClick={() => onOperate("cancel_task", selectedRun.runId, selectedTask.taskId)}>
                  停止任务
                </button>
              ) : null}
              {selectedTask.status === "failed" ? (
                <button
                  type="button"
                  onClick={() =>
                    onOperate(
                      selectedTask.error?.code === "publish_failed" ? "retry_publish" : "retry_task",
                      selectedRun.runId,
                      selectedTask.taskId,
                    )
                  }
                >
                  {selectedTask.error?.code === "publish_failed" ? "重试发送结果" : "重试任务"}
                </button>
              ) : null}
              {selectedTask.status === "awaiting" ? (
                <>
                  <button
                    type="button"
                    onClick={() => onOperate("answer_approval", selectedRun.runId, selectedTask.taskId, true)}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    onClick={() => onOperate("answer_approval", selectedRun.runId, selectedTask.taskId, false)}
                  >
                    拒绝
                  </button>
                </>
              ) : null}
            </div>
          </>
        ) : view === "progress" ? (
          <>
            <section className={styles.progressSummary}>
              <strong>
                本轮进度 {done} / {tasks.length}
              </strong>
              <div className={styles.progressTrack} aria-label={`已完成 ${done}，共 ${tasks.length}`}>
                <span style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
              </div>
              <p>
                {tasks.some(({ task }) => task.status === "awaiting")
                  ? "有任务需要你处理"
                  : tasks.length
                    ? "状态会在这里实时对账"
                    : "发送目标后会显示执行进展"}
              </p>
            </section>
            <div className={styles.inspectorList}>
              {tasks.map(({ run, task }) => (
                <button type="button" key={task.taskId} onClick={() => onSelectTask(run.runId, task.taskId)}>
                  <span>
                    {actors.find((actor) => actor.kind === "workspace_agent" && actor.workspaceId === task.workspaceId)
                      ?.displayName || "工作区 Agent"}
                  </span>
                  <small>
                    Wave {task.wave ?? 1} · {TASK_STATUS[task.status].label}
                    {task.dependsOn?.length ? ` · 依赖 ${task.dependsOn.length}` : ""}
                  </small>
                </button>
              ))}
            </div>
            {selectedRun && !["completed", "failed", "cancelled"].includes(selectedRun.status) ? (
              <button
                type="button"
                className={styles.dangerAction}
                onClick={() => onOperate("cancel_run", selectedRun.runId)}
              >
                停止本轮协作
              </button>
            ) : null}
          </>
        ) : view === "outputs" ? (
          <>
            {selectedRun?.summary ? (
              <section className={styles.detailBlock}>
                <span className={styles.eyebrow}>{selectedRun.partial ? "部分成功汇总" : "最终汇总"}</span>
                <p>{selectedRun.summary}</p>
              </section>
            ) : null}
            <div className={styles.inspectorList}>
              {files.map(({ file, runId, taskId }) => (
                <button type="button" key={`${runId}:${taskId ?? ""}:${file.path}`} onClick={() => onOpenFile(file)}>
                  <span>{file.path}</span>
                  <small>{file.op === "added" ? "已新增" : "已修改"} · 打开预览</small>
                </button>
              ))}
              {!files.length ? <p className={styles.timelineHint}>任务结果文件会汇总到这里。</p> : null}
            </div>
          </>
        ) : (
          <div className={styles.memberList}>
            <div className={styles.groupActions}>
              <button
                type="button"
                onClick={() => {
                  const title = window.prompt("新的协作群名称");
                  if (title?.trim()) onUpdateGroup({ title: title.trim() });
                }}
              >
                改名
              </button>
              <button type="button" onClick={() => onUpdateGroup({ archived: true })}>
                归档群
              </button>
            </div>
            {actors.map((actor) => {
              const task =
                actor.kind === "workspace_agent"
                  ? tasks.find(({ task: row }) => row.workspaceId === actor.workspaceId)?.task
                  : undefined;
              return (
                <div key={actor.actorId}>
                  <span className={styles.roomAvatar}>{actor.displayName.slice(0, 1)}</span>
                  <span>
                    <strong>{actor.displayName}</strong>
                    <small>
                      {actor.kind === "assistant" ? "协调者" : task ? TASK_STATUS[task.status].label : "空闲"}
                    </small>
                  </span>
                  {actor.kind === "workspace_agent" ? (
                    <button
                      type="button"
                      disabled={Boolean(task && !["succeeded", "failed", "cancelled", "blocked"].includes(task.status))}
                      onClick={() =>
                        onUpdateGroup({
                          actorIds: actors.filter((row) => row.actorId !== actor.actorId).map((row) => row.actorId),
                        })
                      }
                    >
                      移除
                    </button>
                  ) : null}
                </div>
              );
            })}
            {availableActors
              .filter((actor) => !actors.some((current) => current.actorId === actor.actorId))
              .map((actor) => (
                <button
                  type="button"
                  key={actor.actorId}
                  onClick={() => onUpdateGroup({ actorIds: [...actors.map((row) => row.actorId), actor.actorId] })}
                >
                  ＋ 添加 {actor.displayName}
                </button>
              ))}
          </div>
        )}
      </div>
    </aside>
  );
}
