import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CollabRunState, CollabTaskStatus } from "@shared/protocol";
import { indicatorsForRoom, latestRunForRoom, TASK_STATUS } from "../components/collab/collabView";

const statuses: CollabTaskStatus[] = [
  "pending",
  "queued",
  "running",
  "awaiting",
  "blocked",
  "publishing",
  "succeeded",
  "failed",
  "cancelled",
];

describe("协作组件视图模型", () => {
  test("TaskCard 覆盖协议中的全部任务状态且不只依赖颜色", () => {
    assert.deepEqual(Object.keys(TASK_STATUS), statuses);
    for (const status of statuses) {
      assert.ok(TASK_STATUS[status].label);
      assert.ok(TASK_STATUS[status].tone);
    }
    assert.equal(TASK_STATUS.publishing.label, "结果发送中");
    assert.equal(TASK_STATUS.awaiting.label, "需要处理");
  });

  test("群行分别聚合运行、需处理和失败，不把运行计作未读", () => {
    const runs: CollabRunState[] = [
      {
        runId: "run-1",
        version: 1,
        status: "running",
        tasks: statuses.map((status, index) => ({
          taskId: `task-${index}`,
          version: 1,
          workspaceId: `workspace-${index}`,
          status,
        })),
      },
    ];
    assert.deepEqual(indicatorsForRoom(runs), {
      running: 5,
      attention: 1,
      failed: 1,
    });
  });

  test("群角标只展示最新 Run 的最终 wave，恢复前的失败保留历史但不告警", () => {
    const base = {
      version: 1,
      workspaceId: "workspace-1",
    };
    const runs = [
      {
        runId: "run-old",
        version: 1,
        status: "failed",
        tasks: [{ ...base, taskId: "old-run-failure", status: "failed", wave: 1 }],
      },
      {
        runId: "run-latest",
        version: 1,
        status: "completed",
        tasks: [
          { ...base, taskId: "old-wave-failure", status: "failed", wave: 1 },
          { ...base, taskId: "replacement", status: "succeeded", wave: 2 },
        ],
      },
    ] satisfies CollabRunState[];
    assert.deepEqual(indicatorsForRoom(runs), { running: 0, attention: 0, failed: 0 });
  });

  test("最新 Run 使用创建时间判断，不依赖 snapshot 插入顺序", () => {
    const newer = { runId: "newer", version: 1, status: "running", createdAt: 200, tasks: [] } satisfies CollabRunState;
    const older = { runId: "older", version: 1, status: "failed", createdAt: 100, tasks: [] } satisfies CollabRunState;
    assert.equal(latestRunForRoom([newer, older])?.runId, "newer");
  });
});
