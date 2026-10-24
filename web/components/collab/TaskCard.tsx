import type { CollabRunState } from "@shared/protocol";
import { TASK_STATUS } from "./collabView";
import styles from "./collab.module.css";

export type CollabTask = CollabRunState["tasks"][number];

export function TaskCard({
  task,
  actorName,
  selected,
  onOpen,
  onCancel,
  onRetry,
  onApproval,
}: {
  task: CollabTask;
  actorName: string;
  selected?: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onApproval: (allow: boolean) => void;
}) {
  const status = TASK_STATUS[task.status];
  const expired = Boolean(task.approval && task.approval.expiresAt <= Date.now());
  const cancellable = ["pending", "queued", "running", "awaiting", "blocked", "publishing"].includes(task.status);
  return (
    <article
      id={`collab-task-${task.taskId}`}
      className={`${styles.taskCard} ${styles[`tone_${status.tone}`]}${selected ? ` ${styles.selected}` : ""}`}
      tabIndex={0}
      role="button"
      aria-label={`${actorName}，${status.label}，打开任务详情`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={styles.cardHead}>
        <strong>{actorName}</strong>
        <span className={styles.status} data-tone={status.tone}>
          {status.label}
        </span>
      </div>
      <p>{task.summary || (task.status === "queued" ? "等待工作区空闲后开始" : "查看任务当前进展")}</p>
      {task.approval ? (
        <div className={styles.approvalCard} role="group" aria-label={`${task.approval.tool} 审批`}>
          <strong>{expired ? "审批已过期" : `请求批准：${task.approval.tool}`}</strong>
          <p>{task.approval.summary}</p>
          <small>批准或拒绝都不会自动回滚已经产生的文件改动。</small>
        </div>
      ) : null}
      {task.error ? (
        <p role="alert">
          {task.error.message}
          {task.error.action ? ` ${task.error.action}` : ""}
        </p>
      ) : null}
      <div className={styles.cardActions}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          查看详情
        </button>
        {cancellable ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCancel();
            }}
          >
            停止
          </button>
        ) : null}
        {task.status === "failed" ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          >
            重试
          </button>
        ) : null}
        {task.status === "awaiting" ? (
          <>
            <button
              type="button"
              disabled={expired}
              onClick={(event) => {
                event.stopPropagation();
                onApproval(true);
              }}
            >
              {expired ? "已过期" : "批准"}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onApproval(false);
              }}
            >
              拒绝
            </button>
          </>
        ) : null}
      </div>
    </article>
  );
}
