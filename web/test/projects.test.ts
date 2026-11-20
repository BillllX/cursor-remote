import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectChannel } from "../lib/projects/channel";
test("共享项目并发 RPC 连续回包逐个送达，不被最后一帧覆盖", () => {
  const channel = new ProjectChannel(),
    pending = new Map([
      ["list", false],
      ["inbox", false],
      ["snapshot", false],
    ]);
  const off = channel.subscribe((frame) => {
    if (frame.type === "project_result") pending.set(frame.requestId, true);
  });
  for (const requestId of pending.keys())
    channel.publish({ type: "project_result", requestId, ok: true, data: { items: [] } });
  assert.deepEqual([...pending.values()], [true, true, true]);
  off();
});
test("共享页面卸载或换账号后不再向旧订阅派发消息", () => {
  const channel = new ProjectChannel();
  let count = 0;
  const off = channel.subscribe(() => count++);
  off();
  channel.publish({ type: "project_summary_changed", workspaceId: "old" });
  channel.subscribe(() => count++);
  channel.clear();
  channel.publish({ type: "project_access_revoked", workspaceId: "old" });
  assert.equal(count, 0);
});
