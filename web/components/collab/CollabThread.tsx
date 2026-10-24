import { useEffect, useMemo, useRef } from "react";
import type { ActorRef, CollabAnchorBody, CollabRunState, ImMessage, TurnFile } from "@shared/protocol";
import type { CollabTimelineMessage } from "./collabState";
import { TaskCard } from "./TaskCard";
import styles from "./collab.module.css";

function anchorOf(message: ImMessage): CollabAnchorBody | undefined {
  if (message.kind !== "collab" || !message.body || !("schema" in message.body)) return undefined;
  return message.body;
}

function textOf(message: ImMessage) {
  return message.kind === "text" && message.body && "text" in message.body ? message.body.text : "";
}

export function CollabThread({
  title,
  actors,
  messages,
  runs,
  loading,
  selectedTaskId,
  onBack,
  onShowDetails,
  onSelectTask,
  onOpenFile,
  onOperate,
}: {
  title: string;
  actors: ActorRef[];
  messages: CollabTimelineMessage[];
  runs: CollabRunState[];
  loading: boolean;
  selectedTaskId?: string;
  onBack: () => void;
  onShowDetails: () => void;
  onSelectTask: (runId?: string, taskId?: string) => void;
  onOpenFile: (file: TurnFile) => void;
  onOperate: (
    op: "cancel_run" | "cancel_task" | "retry_task" | "retry_publish" | "answer_approval",
    runId?: string,
    taskId?: string,
    allow?: boolean,
  ) => void;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const actorById = useMemo(() => new Map(actors.map((actor) => [actor.actorId, actor])), [actors]);
  const runById = useMemo(() => new Map(runs.map((run) => [run.runId, run])), [runs]);
  const anchoredTasks = useMemo(
    () =>
      new Set(
        messages
          .map(anchorOf)
          .filter((body): body is CollabAnchorBody => body?.event === "task" && Boolean(body.taskId))
          .map((body) => body.taskId as string),
      ),
    [messages],
  );
  const orphanTasks = runs.flatMap((run) =>
    run.tasks.filter((task) => !anchoredTasks.has(task.taskId)).map((task) => ({ run, task })),
  );

  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!selectedTaskId) return;
    const node = document.getElementById(`collab-task-${selectedTaskId}`);
    const timeline = timelineRef.current;
    if (node && timeline) timeline.scrollTop = Math.max(0, node.offsetTop - timeline.clientHeight / 2);
    node?.focus({ preventScroll: true });
  }, [runs, selectedTaskId]);

  const renderTask = (run: CollabRunState, task: CollabRunState["tasks"][number]) => {
    const actor = actors.find(
      (candidate) => candidate.kind === "workspace_agent" && candidate.workspaceId === task.workspaceId,
    );
    return (
      <TaskCard
        key={task.taskId}
        task={task}
        actorName={actor?.displayName || "工作区 Agent"}
        selected={selectedTaskId === task.taskId}
        onOpen={() => onSelectTask(run.runId, task.taskId)}
        onCancel={() => onOperate("cancel_task", run.runId, task.taskId)}
        onRetry={() =>
          onOperate(task.error?.code === "publish_failed" ? "retry_publish" : "retry_task", run.runId, task.taskId)
        }
        onApproval={(allow) => onOperate("answer_approval", run.runId, task.taskId, allow)}
      />
    );
  };

  return (
    <section className={styles.threadPane} aria-label={`${title}消息`}>
      <header className={styles.threadHead}>
        <button type="button" className={styles.mobileBack} onClick={onBack} aria-label="返回协作群列表">
          ‹
        </button>
        <div>
          <h1>{title}</h1>
          <p>你、小驳、{actors.filter((actor) => actor.kind === "workspace_agent").length} 个工作区 Agent</p>
        </div>
        <button type="button" className={styles.detailsButton} onClick={onShowDetails}>
          协作详情
        </button>
      </header>
      <div className={styles.timeline} ref={timelineRef}>
        {loading ? <div className={styles.timelineHint}>正在加载群历史…</div> : null}
        {!loading && !messages.length && !orphanTasks.length ? (
          <div className={styles.welcome}>
            <span className={styles.welcomeMark} aria-hidden="true">
              协
            </span>
            <h2>把目标交给协作群</h2>
            <p>默认 @小驳 来拆分和协调，也可以移除它，直接选择一个工作区 Agent。</p>
            <ul>
              <li>检查项目并修复一个明确问题</li>
              <li>让不同工作区分别完成实现和验证</li>
              <li>汇总改动、测试结果和待办</li>
            </ul>
          </div>
        ) : null}
        {messages.map((message) => {
          const anchor = anchorOf(message);
          if (!anchor) {
            const text = textOf(message);
            if (!text) return null;
            const own = message.author?.kind === "tenant";
            const actor =
              message.author?.kind === "assistant" || message.author?.kind === "workspace_agent"
                ? actorById.get(message.author.actorId)
                : undefined;
            return (
              <article
                className={`${styles.message} ${own ? styles.ownMessage : styles.actorMessage}`}
                key={message.clientId}
              >
                <span className={styles.author}>{own ? "你" : actor?.displayName || "协作成员"}</span>
                <p>{text}</p>
                {message.pending ? <span className={styles.pending}>正在发送…</span> : null}
              </article>
            );
          }
          const run = runById.get(anchor.runId);
          if (anchor.event === "task" && anchor.taskId && run) {
            const task = run.tasks.find((row) => row.taskId === anchor.taskId);
            return task ? renderTask(run, task) : null;
          }
          return (
            <article className={`${styles.anchorCard} ${styles[`anchor_${anchor.event}`]}`} key={message.clientId}>
              <div className={styles.cardHead}>
                <strong>
                  {anchor.event === "plan" ? "小驳的执行计划" : anchor.event === "result" ? "Agent 结果" : "小驳汇总"}
                </strong>
                {run ? <span className={styles.status}>{run.status === "completed" ? "已完成" : "已开始"}</span> : null}
              </div>
              <p>{anchor.summary}</p>
              {anchor.event === "plan" && run ? (
                <ol className={styles.planTasks}>
                  {run.tasks
                    .filter((task) => anchor.wave === undefined || task.wave === anchor.wave)
                    .map((task) => (
                      <li key={task.taskId}>
                        <strong>{task.title || "协作任务"}</strong>
                        <span>
                          Wave {task.wave ?? 1}
                          {task.dependsOn?.length ? ` · 依赖 ${task.dependsOn.length} 项` : " · 可并行"}
                        </span>
                      </li>
                    ))}
                </ol>
              ) : null}
              {anchor.event === "summary" && run?.partial ? (
                <strong className={styles.partialNotice}>部分成功：未完成或失败项已保留在任务图中。</strong>
              ) : null}
              {anchor.files?.length ? (
                <div className={styles.fileList}>
                  {anchor.files.map((file) => (
                    <button type="button" key={`${message.clientId}:${file.path}`} onClick={() => onOpenFile(file)}>
                      <span>{file.path}</span>
                      <small>
                        {file.added || file.removed ? `+${file.added ?? 0} −${file.removed ?? 0}` : "查看文件"}
                      </small>
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
        {orphanTasks.length ? (
          <section className={styles.taskGrid} aria-label="本轮任务">
            {orphanTasks.map(({ run, task }) => renderTask(run, task))}
          </section>
        ) : null}
      </div>
    </section>
  );
}
