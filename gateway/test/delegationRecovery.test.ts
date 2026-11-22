import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deliverDelegationReceipt } from "../src/assistant/delegationReceipts.ts";
import { createDelegation, getDelegation, publicDelegation, recoverDelegations, updateDelegation } from "../src/assistant/delegations.ts";
import { listInbox } from "../src/assistant/inbox.ts";
import { recoverRuns, startRunRecord } from "../src/assistant/runs.ts";

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "delegation-recovery-"));
  const ref = { id: "test", stateDir };
  let n = 0;
  return {
    ref,
    add: (fields: Partial<Parameters<typeof createDelegation>[1]> = {}) => createDelegation(ref, {
      childChatId: `child-${++n}`, workspace: "业务", title: "复核月报", task: "核对统计", mode: "foreground", ...fields,
    }),
    clean: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

test("重启只重试新版只读委派一次；前台、旧记录及等待审批的委派交回用户", (t) => {
  const { ref, add, clean } = fixture();
  t.after(clean);
  const readonly = add({ mode: "background", backgroundRestarts: 0, activeTask: "核对统计" });
  const foreground = add({ activeTask: "保存报表" });
  const awaiting = add();
  updateDelegation(ref, awaiting.id, { status: "awaiting" });
  const legacy = add({ mode: "background" });
  const files = add({ mode: "background", backgroundRestarts: 0, activeTask: "导出", expectedFiles: ["report.md"] });
  const collab = add({ notifyPolicy: "collab_only" });
  startRunRecord(ref, { origin: "delegate", label: readonly.title, chatId: readonly.childChatId, cwd: ref.stateDir, model: "test" });
  recoverRuns(ref);
  assert.equal(listInbox(ref).length, 0);
  const retries: string[] = [];
  const stale = recoverDelegations(ref, (item) => {
    retries.push(item.id);
    assert.equal(getDelegation(ref, item.id)?.backgroundRestarts, 1);
    assert.equal("activeTask" in publicDelegation(item), false);
  });
  assert.deepEqual(retries, [readonly.id]);
  assert.deepEqual(stale.map((row) => row.id), [foreground.id, awaiting.id, legacy.id, files.id]);
  assert.match(getDelegation(ref, awaiting.id)?.result ?? "", /审批已失效/);
  assert.equal(getDelegation(ref, collab.id)?.status, "running");
  assert.equal(getDelegation(ref, readonly.id)?.status, "running");
  assert.deepEqual(recoverDelegations(ref, (item) => retries.push(item.id)).map((item) => item.id), [readonly.id]);
  assert.deepEqual(retries, [readonly.id]);
  assert.equal(getDelegation(ref, readonly.id)?.interrupted, true);
});

test("中断回执写入后即使没清理待发送标记，重启也不重复投递", (t) => {
  const { ref, add, clean } = fixture();
  t.after(clean);
  const record = add({ attempt: 2 });
  const [interrupted] = recoverDelegations(ref);
  assert.equal(interrupted?.receiptPending, true);
  deliverDelegationReceipt(ref, interrupted!);
  const [first] = listInbox(ref);
  assert.equal(first?.key, `delegation:${record.id}:2`);
  assert.match(first?.title ?? "", /被中断/);
  const pendingAgain = updateDelegation(ref, record.id, { receiptPending: true })!;
  deliverDelegationReceipt(ref, pendingAgain);
  assert.deepEqual(listInbox(ref).map((item) => item.id), [first?.id]);
  assert.equal(getDelegation(ref, record.id)?.receiptPending, false);
});

test("找回交付后在原位置更新本轮中断回执", (t) => {
  const { ref, add, clean } = fixture();
  t.after(clean);
  const record = add({ attempt: 2 });
  const [interrupted] = recoverDelegations(ref);
  deliverDelegationReceipt(ref, interrupted!);
  const [first] = listInbox(ref);
  const files = [{ path: "月报.md", op: "added", kind: "markdown", sha: "snapshot" }] as const;
  const done = updateDelegation(ref, record.id, {
    status: "done", result: "已找回月报", deliveredFiles: [...files], receiptPending: true,
  })!;
  deliverDelegationReceipt(ref, done);
  const results = listInbox(ref);
  assert.deepEqual(results.map((row) => row.id), [first?.id]);
  assert.deepEqual(results[0]?.delegationReceipt, { status: "done", attempt: 2, files });
});
