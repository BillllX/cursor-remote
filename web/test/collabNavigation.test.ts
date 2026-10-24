import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readCollabRoute, writeCollabRoute } from "../components/collab/collabNavigation";

describe("协作 URL 深链", () => {
  test("读取 domain/conv/run/task/file", () => {
    assert.deepEqual(readCollabRoute("?domain=collab&conv=grp~1&run=run-1&task=task-1&file=src%2Fa.ts"), {
      active: true,
      convId: "grp~1",
      runId: "run-1",
      taskId: "task-1",
      file: "src/a.ts",
    });
  });

  test("写入协作参数时保留无关查询，退出域时只清理协作参数", () => {
    const opened = writeCollabRoute("https://example.test/app?theme=dark", {
      active: true,
      convId: "grp~1",
      runId: "run-1",
      taskId: "task-1",
      file: "src/a.ts",
    });
    assert.equal(
      opened,
      "https://example.test/app?theme=dark&domain=collab&conv=grp%7E1&run=run-1&task=task-1&file=src%2Fa.ts",
    );
    assert.equal(writeCollabRoute(opened, { active: false }), "https://example.test/app?theme=dark");
  });
});
