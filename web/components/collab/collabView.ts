import type { CollabRunState, CollabTaskStatus } from "@shared/protocol";

export const TASK_STATUS: Record<
  CollabTaskStatus,
  { label: string; tone: "quiet" | "running" | "attention" | "success" | "danger" }
> = {
  pending: { label: "等待计划", tone: "quiet" },
  queued: { label: "排队中", tone: "running" },
  running: { label: "运行中", tone: "running" },
  awaiting: { label: "需要处理", tone: "attention" },
  blocked: { label: "等待依赖", tone: "attention" },
  publishing: { label: "结果发送中", tone: "running" },
  succeeded: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "quiet" },
};

export type RoomIndicators = { running: number; attention: number; failed: number };

export function latestRunForRoom(roomRuns: CollabRunState[]) {
  return roomRuns.reduce<CollabRunState | undefined>((latest, run) => {
    if (!latest) return run;
    const latestAt = latest.createdAt ?? Number.NEGATIVE_INFINITY;
    const runAt = run.createdAt ?? Number.NEGATIVE_INFINITY;
    // 旧缓存没有 createdAt 时保持服务端顺序；新版状态使用创建时间抵抗 snapshot 插入顺序变化。
    return runAt >= latestAt ? run : latest;
  }, undefined);
}

export function indicatorsForRoom(roomRuns: CollabRunState[]): RoomIndicators {
  const latestRun = latestRunForRoom(roomRuns);
  if (!latestRun) return { running: 0, attention: 0, failed: 0 };
  const latestWave = latestRun.tasks.reduce((max, task) => Math.max(max, task.wave ?? 1), 1);
  // 群列表表达当前进度；旧 wave 的失败只留在详情时间线，不能永久污染群角标。
  const tasks = latestRun.tasks.filter((task) => (task.wave ?? 1) === latestWave);
  return {
    running: tasks.filter((task) => ["pending", "queued", "running", "publishing", "blocked"].includes(task.status))
      .length,
    attention: tasks.filter((task) => task.status === "awaiting").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
}
