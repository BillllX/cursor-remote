import type { CollabTask } from "./types.ts";

export const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "cancelled", "blocked"] as const;

export function terminalTaskStatus(status: string) {
  return TERMINAL_TASK_STATUSES.includes(status as (typeof TERMINAL_TASK_STATUSES)[number]);
}

export function dependencyResolution(task: CollabTask, tasks: CollabTask[]): "waiting" | "queued" | "blocked" {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const dependencies = task.dependsOn.map((id) => byId.get(id)).filter(Boolean) as CollabTask[];
  if (dependencies.some((dependency) => ["failed", "cancelled", "blocked"].includes(dependency.status))) {
    return "blocked";
  }
  return dependencies.length === task.dependsOn.length &&
    dependencies.every((dependency) => dependency.status === "succeeded")
    ? "queued"
    : "waiting";
}

/** 数组顺序就是持久化创建顺序；每个 workspace 只返回最早的可运行项。 */
export function fifoQueuedTasks(tasks: CollabTask[]) {
  return tasks.filter(
    (item, index) =>
      item.status === "queued" &&
      !tasks
        .slice(0, index)
        .some((earlier) => earlier.workspaceId === item.workspaceId && !terminalTaskStatus(earlier.status)),
  );
}

export function nextFifoTask(tasks: CollabTask[]) {
  return fifoQueuedTasks(tasks)[0];
}

export function waveFinished(tasks: CollabTask[], wave: number) {
  const rows = tasks.filter((task) => task.wave === wave);
  return rows.length > 0 && rows.every((task) => terminalTaskStatus(task.status));
}
