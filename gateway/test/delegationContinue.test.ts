import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { bindBackground } from "../src/assistant/background.ts";
import { createDelegation, getDelegation, listDelegations, recoverDelegations, updateDelegation } from "../src/assistant/delegations.ts";
import { listInbox } from "../src/assistant/inbox.ts";
import { cancelDelegation, reconcileDelegation, recoverDelegation, retargetDelegation, retryBackgroundDelegation, startDelegation } from "../src/bindings/delegations.ts";
import { claimOutputs, outputKeys, releaseOutputs } from "../src/outputClaims.ts";
import { storeArtifact } from "../src/turnFiles.ts";
import { assistantChatIdOf } from "../src/runtime/chats.ts";
import { slotOf } from "../src/runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../src/runtime/state.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";
import { allTenants, saveDiskNow } from "../src/tenants.ts";

test("小驳卡片续作重用原子会话、父回合和委派编号，每轮都送达", async () => {
  const root = mkdtempSync(join(tmpdir(), "delegation-continue-"));
  const workspaceRoot = join(root, "workspace");
  mkdirSync(join(workspaceRoot, "业务"), { recursive: true });
  process.env.CURSOR_REMOTE_TENANTS_FILE = join(root, "missing-tenants.json");
  process.env.CURSOR_REMOTE_TOKEN = "delegate-test-token";
  process.env.CURSOR_REMOTE_CWD = workspaceRoot;
  process.env.CURSOR_REMOTE_STATE_DIR = join(root, "state");
  process.env.CURSOR_REMOTE_MEDIA_SECRET = "delegate-test-secret";

  const tenant = allTenants()[0]!;
  const parentChatId = assistantChatIdOf(tenant);
  const ws = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
  const conn: Conn = {
    cwd: workspaceRoot,
    model: "test",
    authed: true,
    ip: "127.0.0.1",
    tenant,
    ws,
    slots: liveSlotsOf(tenant),
    maxMessageBytes: 0,
    caps: new Set(),
    policy: "baseline",
  };
  gatewayState.conns.set(ws, conn);
  gatewayState.wsTenant.set(ws, tenant.id);
  const parent = slotOf(conn, parentChatId);
  parent.transcript = { turnId: "origin", userText: "复核三农信投诉" } as Slot["transcript"];

  const slots: Slot[] = [];
  const prompts: string[] = [];
  const approvals: boolean[] = [];
  const run: NonNullable<Parameters<typeof startDelegation>[1]> = async (_ws, _conn, slot, prompt, _model, _mode, _files, _images, confirmWrites) => {
    approvals.push(Boolean(confirmWrites));
    slots.push(slot);
    prompts.push(prompt);
    slot.captureText?.(slots.length === 1 ? "第一版结论及来源" : "补充人行渠道及来源");
    slot.captureDone?.("completed");
  };

  try {
    const base = { tenant, workspace: "业务", parentChatId, background: false };
    const first = JSON.parse(
      await startDelegation({ ...base, task: "复核三农信投诉", deliverable: "三个渠道的增减及缺口" }, run),
    );
    assert.equal(first.ok, true);
    assert.equal(getDelegation(tenant, first.id)?.status, "done");

    parent.transcript = {
      turnId: "follow-up",
      userText: `继续委派（${first.id}）：补充人行渠道`,
    } as Slot["transcript"];
    const wrong = JSON.parse(await startDelegation({ ...base, task: "选错", delegationId: "d_wrong" }, run));
    assert.equal(wrong.ok, false);

    // 模型漏传编号时，仍通过卡片里的明确编号找到同一子会话。
    const second = JSON.parse(await startDelegation({ ...base, task: "补充人行渠道" }, run));
    assert.equal(second.id, first.id);
    assert.equal(second.childChatId, first.childChatId);
    assert.strictEqual(slots[0], slots[1]);
    assert.match(prompts[1]!, /同一项委派的续作/);
    assert.equal(listDelegations(tenant).length, 1);
    assert.equal(tenant.disk.chats.length, 1);
    const record = getDelegation(tenant, first.id);
    assert.equal(record?.parentTurnId, "origin");
    assert.equal(record?.attempt, 2);
    assert.equal(record?.deliverable, "三个渠道的增减及缺口");
    assert.equal(record?.result, "补充人行渠道及来源");
    assert.equal(listInbox(tenant).filter((item) => item.delegationId === first.id).length, 2);

    const foreign = JSON.parse(
      await startDelegation({ ...base, parentChatId: "other", task: "串到别的对话", delegationId: first.id }, run),
    );
    assert.equal(foreign.ok, false);
    assert.equal(slots.length, 2);

    updateDelegation(tenant, first.id, { status: "awaiting", activeTask: "补查人行去年同期" });
    assert.equal(recoverDelegations(tenant)[0]?.interrupted, true);
    parent.transcript = { turnId: "retry", userText: `恢复委派（${first.id}）` } as Slot["transcript"];
    const resumed = JSON.parse(await startDelegation({ ...base, workspace: "无效", task: "模型误补的要求", expectedFiles: ["../wrong"] }, run));
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.childChatId, first.childChatId);
    assert.strictEqual(slots[0], slots[2]);
    assert.match(prompts[2]!, /补查人行去年同期/);
    assert.match(prompts[2]!, /旧审批已失效/);
    assert.doesNotMatch(prompts[2]!, /模型误补的要求/);
    assert.deepEqual(approvals, [false, false, true]);
    assert.equal(getDelegation(tenant, first.id)?.interrupted, false);
    assert.equal(getDelegation(tenant, first.id)?.attempt, 3);
    const duplicate = JSON.parse(await startDelegation({ ...base, task: "重复恢复" }, run));
    assert.equal(duplicate.ok, false);
    assert.equal(slots.length, 3);
    assert.equal(listInbox(tenant).filter((item) => item.delegationId === first.id).length, 3);

    // 模拟网关恢复读取到的记录，用真实后台委派链路和替身 SDK 验证权限及回执。
    const background = createDelegation(tenant, {
      title: "只读复核", task: "核对月报", activeTask: "核对月报", mode: "background", backgroundRestarts: 0,
      childChatId: "background-child", workspace: "业务", parentChatId,
    });
    const cwd = join(workspaceRoot, "业务");
    tenant.disk.chats.push({ id: background.childChatId, cwd, delegationId: background.id, turns: [] });
    bindBackground({
      apiKey: () => "test",
      listModels: async () => ["claude-sonnet-4-6"],
      sandbox: () => true,
      prompt: async (message, options) => {
        assert.match(message, /核对月报/);
        assert.equal(options.local?.cwd, cwd);
        assert.deepEqual(options.tools, ["read", "grep", "glob", "ls", "mcp"]);
        assert.deepEqual(Object.keys(options.local?.customTools ?? {}), ["workspace_memory_search"]);
        return { id: "read-only", status: "finished", result: "复核完成，来源为月报。", messages: [] };
      },
    });
    const restarted: Array<Promise<void> | undefined> = [];
    recoverDelegations(tenant, (item) => { restarted.push(retryBackgroundDelegation(tenant, item)); });
    await Promise.all(restarted);
    assert.equal(restarted.length, 1);
    assert.equal(getDelegation(tenant, background.id)?.status, "done");
    assert.equal(getDelegation(tenant, background.id)?.result, "复核完成，来源为月报。");
    assert.equal(listInbox(tenant).filter((item) => item.delegationId === background.id).length, 1);

    // 恢复按钮不依赖父会话文字，两个设备点击同一轮时只执行一次。
    updateDelegation(tenant, first.id, { status: "failed", interrupted: true, activeTask: "直接恢复的原任务" });
    parent.transcript = { turnId: "unrelated", userText: "另一条对话" } as Slot["transcript"];
    const direct = { delegationId: first.id, attempt: 3 };
    const pair = await Promise.all([recoverDelegation(ws, tenant, direct, run), recoverDelegation(ws, tenant, direct, run)]);
    assert.ok(pair.every((reply) => reply.ok));
    assert.equal(slots.length, 4);
    assert.match(prompts[3]!, /直接恢复的原任务/);

    // 网关在最终回执前中断，能按确切回合与快照找回交付。
    const saved = getDelegation(tenant, first.id)!;
    const sha = storeArtifact(tenant.stateDir, Buffer.from("# 三农信投诉月报")).sha;
    const chat = tenant.disk.chats.find((raw) => (raw as { id: string }).id === saved.childChatId) as { turns: unknown[] };
    writeFileSync(join(cwd, "月报.md"), "# 三农信投诉月报");
    const inherited = { path: "月报.md", op: "added", kind: "markdown", sha } as const;
    chat.turns = [{ id: saved.activeTurnId, status: "completed", assistant: "已核对三类投诉数据", files: [] }];
    updateDelegation(tenant, saved.id, { status: "running", expectedFiles: ["月报.md"], inheritedFiles: [inherited], receiptPending: false });
    writeFileSync(join(cwd, "月报.md"), "# 被其他运行改动");
    assert.equal(reconcileDelegation(tenant, getDelegation(tenant, saved.id)!), undefined);
    writeFileSync(join(cwd, "月报.md"), "# 三农信投诉月报");
    recoverDelegations(tenant, undefined, (item) => reconcileDelegation(tenant, item));
    assert.equal(getDelegation(tenant, saved.id)?.status, "done");
    assert.equal(getDelegation(tenant, saved.id)?.result, "已核对三类投诉数据");
    assert.equal(getDelegation(tenant, saved.id)?.receiptPending, true);
    assert.deepEqual(getDelegation(tenant, saved.id)?.deliveredFiles, [inherited]);
    assert.equal(slots.length, 4);

    const keys = outputKeys(cwd, ["月报.md"]);
    assert.equal(claimOutputs(keys, "schedule"), true);
    const queued = JSON.parse(await startDelegation({ ...base, task: "生成月报", expectedFiles: ["月报.md"] }, run));
    assert.equal(getDelegation(tenant, queued.id)?.status, "queued");
    assert.match(getDelegation(tenant, queued.id)?.waitReason ?? "", /同一产物/);
    assert.equal(slots.length, 4);
    writeFileSync(join(cwd, "现有.md"), "已有");
    assert.equal(retargetDelegation(tenant, { delegationId: queued.id, attempt: 1, outputPath: "现有.md" }).ok, false);
    assert.equal(retargetDelegation(tenant, { delegationId: queued.id, attempt: 1, outputPath: "新版本.md" }).ok, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    assert.match(prompts[4]!, /本轮需交付的文件：新版本.md/);
    releaseOutputs(keys, "schedule");

    const bgRuns = ["locked-one", "locked-two"];
    const { startRunRecord, endRunRecord } = await import("../src/assistant/runs.ts");
    const busyRuns = bgRuns.map((label) => startRunRecord(tenant, { label, origin: "probe", cwd, model: "test" }));
    const parked = JSON.parse(await startDelegation({ ...base, task: "等待后台名额", background: true }, run));
    assert.equal(getDelegation(tenant, parked.id)?.status, "queued");
    assert.equal((await cancelDelegation(ws, tenant, { delegationId: parked.id, attempt: 1, queuedOnly: true })).ok, true);
    for (const busy of busyRuns) endRunRecord(tenant, busy.runId, { status: "done" });
    assert.equal(getDelegation(tenant, parked.id)?.status, "cancelled");



  } finally {
    saveDiskNow(tenant);
    gatewayState.conns.clear();
    gatewayState.liveByTenant.clear();
    rmSync(root, { recursive: true, force: true });
  }
});
