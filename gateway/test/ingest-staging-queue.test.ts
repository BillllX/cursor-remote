import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  bindIngestBatchWorker,
  commitDropBatchAndEnqueue,
  drainWorkspaceIngestQueue,
  forceQueueEntryStateForTest,
  listIngestQueue,
  recoverInterruptedIngestQueue,
} from "../src/ingest/queue.ts";
import {
  batchDirRelPath,
  createDropBatch,
  getDropBatchPublicStatus,
  MAX_FILES_PER_BATCH,
  readBatchMetaSync,
  stageFileIntoBatch,
  validateBatchSourceFile,
} from "../src/ingest/staging.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  setupKbWorkspaceForTenant,
  verifyDropPasscodeAndCreateSession,
  type DropTenantHost,
  type DropWorkspaceRef,
} from "../src/ingest/tokens.ts";

const tempDirs: string[] = [];

function makeEnv() {
  const base = join(tmpdir(), `ingest-staging-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(base, "state");
  const workspaceRoot = join(base, "workspaces");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  tempDirs.push(base);

  const registry = new Map<string, DropWorkspaceRef>();
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(wsPath, { recursive: true });
  const wsRef: DropWorkspaceRef = {
    workspaceId: "wsa_11111111-2222-4333-8444-555555555555",
    key: "Fintopia集团",
    path: wsPath,
  };
  registry.set("Fintopia集团", wsRef);
  registry.set(wsRef.workspaceId, wsRef);

  const host: DropTenantHost = {
    id: "default",
    stateDir,
    workspaceRoot,
    resolveWorkspace: (keyOrId: string) => registry.get(keyOrId.trim()) ?? null,
  };

  setupKbWorkspaceForTenant(host, {
    workspace: "Fintopia集团",
    title: "Fintopia 集团知识库",
    categories: ["资金", "资产", "牌照"],
  });
  createDropToken(host, {
    workspace: "Fintopia集团",
    passcode: "fintopia-2026",
  });
  const authRes = verifyDropPasscodeAndCreateSession(host, {
    passcode: "fintopia-2026",
    submitterName: "张工-财务",
    clientIp: "10.0.0.1",
  });
  if (!authRes.ok) throw new Error("auth failed");

  return { base, stateDir, workspaceRoot, wsPath, host, session: authRes.session };
}

afterEach(() => {
  bindIngestBatchWorker(null);
  resetDropAuthMemoryStateForTest();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Step 3: Inbox 批次 Staging 与持久化任务队列 (staging.ts + queue.ts)", () => {
  test("多文件串行上传、磁盘孤儿同名去重、单批 20 文件上限、receiptToken 统一 404 防探测", () => {
    const { host, session, wsPath } = makeEnv();

    const batchRes = createDropBatch(host, session);
    assert.equal(batchRes.ok, true);
    if (!batchRes.ok) return;

    // 空批次禁止 commit
    const emptyCommit = commitDropBatchAndEnqueue(host, session, { batchId: batchRes.batchId });
    assert.equal(emptyCommit.ok, false);

    // 模拟磁盘上已经有一个未记入 meta.json 的孤儿同名文件 report.xlsx
    const orphanAbs = join(wsPath, batchDirRelPath(batchRes.batchId), "report.xlsx");
    writeFileSync(orphanAbs, "orphan-content");

    // 上传 report.xlsx 时应检测到磁盘已存在同名文件，自动命名为 report-2.xlsx，不覆盖孤儿文件
    const s1 = stageFileIntoBatch(host, session, {
      batchId: batchRes.batchId,
      fileName: "report.xlsx",
      data: Buffer.from("excel-content-1"),
    });
    const s2 = stageFileIntoBatch(host, session, {
      batchId: batchRes.batchId,
      fileName: "report.xlsx",
      data: Buffer.from("excel-content-2"),
    });
    assert.equal(s1.ok, true);
    assert.equal(s2.ok, true);
    if (!s1.ok || !s2.ok) return;
    assert.equal(s1.file.storedName, "report-2.xlsx");
    assert.equal(s2.file.storedName, "report-3.xlsx");

    // 加上磁盘上已有的 1 个孤儿文件，再补 18 个文件即达到磁盘 20 个文件上限，第 20 次上传（即第 21 个磁盘文件）应被拒绝
    for (let i = 3; i <= MAX_FILES_PER_BATCH - 1; i++) {
      const res = stageFileIntoBatch(host, session, {
        batchId: batchRes.batchId,
        fileName: `doc_${i}.pdf`,
        data: Buffer.from(`pdf-${i}`),
      });
      assert.equal(res.ok, true);
    }
    const overLimit = stageFileIntoBatch(host, session, {
      batchId: batchRes.batchId,
      fileName: "doc_21.pdf",
      data: Buffer.from("too-many"),
    });
    assert.equal(overLimit.ok, false);
    if (!overLimit.ok) assert.equal(overLimit.status, 400);

    // 校验源路径合法性检查
    assert.equal(validateBatchSourceFile(wsPath, batchRes.batchId, s1.file.relPath).ok, true);
    assert.equal(
      validateBatchSourceFile(wsPath, batchRes.batchId, `.cursor-remote/uploads/inbox/${batchRes.batchId}/meta.json`)
        .ok,
      false,
    );

    // 凭正确 receiptToken 查询公开状态
    const pubStatus = getDropBatchPublicStatus(host, {
      batchId: batchRes.batchId,
      receiptToken: batchRes.receiptToken,
    });
    assert.equal(pubStatus.ok, true);
    if (pubStatus.ok) {
      assert.equal(pubStatus.status.fileCount, 19);
      assert.equal(pubStatus.status.status, "staging");
    }

    // 凭错误 receiptToken 与不存在的 batchId 均返回完全一致的 404 状态与错误文案（防探测枚举）
    const wrongReceipt = getDropBatchPublicStatus(host, {
      batchId: batchRes.batchId,
      receiptToken: "rcpt_000000000000000000000000000000000000000000000000",
    });
    const nonExistentBatch = getDropBatchPublicStatus(host, {
      batchId: "b_nonexistent123456",
      receiptToken: "rcpt_000000000000000000000000000000000000000000000000",
    });
    assert.equal(wrongReceipt.ok, false);
    assert.equal(nonExistentBatch.ok, false);
    if (!wrongReceipt.ok && !nonExistentBatch.ok) {
      assert.equal(wrongReceipt.status, 404);
      assert.equal(nonExistentBatch.status, 404);
      assert.equal(wrongReceipt.error, nonExistentBatch.error);
    }
  });

  test("同一工作区多批次并发提交时严格串行执行（并发度=1），且公开状态文案强制脱敏", async () => {
    const { host, session } = makeEnv();
    const s2Res = verifyDropPasscodeAndCreateSession(host, {
      passcode: "fintopia-2026",
      submitterName: "李工-风控",
      clientIp: "10.0.0.2",
    });
    assert.equal(s2Res.ok, true);
    if (!s2Res.ok) return;
    const session2 = s2Res.session;

    const b1 = createDropBatch(host, session);
    const b2 = createDropBatch(host, session2);
    assert.equal(b1.ok, true);
    assert.equal(b2.ok, true);
    if (!b1.ok || !b2.ok) return;

    stageFileIntoBatch(host, session, { batchId: b1.batchId, fileName: "a.xlsx", data: Buffer.from("1") });
    stageFileIntoBatch(host, session2, { batchId: b2.batchId, fileName: "b.xlsx", data: Buffer.from("2") });

    let activeCount = 0;
    let maxConcurrent = 0;
    const executionOrder: string[] = [];

    bindIngestBatchWorker(async ({ entry }) => {
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      executionOrder.push(`start:${entry.batchId}`);
      await new Promise((r) => setTimeout(r, 20));
      executionOrder.push(`end:${entry.batchId}`);
      activeCount -= 1;
      return {
        status: "completed",
        // 故意返回包含敏感内部路径的文案，验证公开状态查询会被强制替换为脱敏文案
        statusMessage: "INTERNAL_SECRET_PATH:/var/lib/secret/资产.html",
        archivedPaths: ["资产/a.xlsx"],
      };
    });

    const c1 = commitDropBatchAndEnqueue(host, session, { batchId: b1.batchId, note: "批次1" });
    const c2 = commitDropBatchAndEnqueue(host, session2, { batchId: b2.batchId, note: "批次2" });
    assert.equal(c1.ok, true);
    assert.equal(c2.ok, true);

    await drainWorkspaceIngestQueue(host, session.workspaceId);

    // 验证严格串行（并发度最高为 1，且 b1 完全结束后 b2 才开始）
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(executionOrder, [
      `start:${b1.batchId}`,
      `end:${b1.batchId}`,
      `start:${b2.batchId}`,
      `end:${b2.batchId}`,
    ]);

    const finalStatus = getDropBatchPublicStatus(host, {
      batchId: b1.batchId,
      receiptToken: b1.receiptToken,
    });
    assert.equal(finalStatus.ok, true);
    if (finalStatus.ok) {
      assert.equal(finalStatus.status.status, "completed");
      assert.equal(finalStatus.status.statusMessage.includes("INTERNAL_SECRET_PATH"), false);
    }
  });

  test("网关重启恢复：processing (attempts=1) 重置为 queued 重跑；processing (attempts=2) 超限标记 failed 且保留原件", async () => {
    const { host, session, wsPath } = makeEnv();
    const s2Res = verifyDropPasscodeAndCreateSession(host, {
      passcode: "fintopia-2026",
      submitterName: "李工-风控",
      clientIp: "10.0.0.2",
    });
    assert.equal(s2Res.ok, true);
    if (!s2Res.ok) return;
    const session2 = s2Res.session;

    const bRetry = createDropBatch(host, session);
    const bDead = createDropBatch(host, session2);
    assert.equal(bRetry.ok, true);
    assert.equal(bDead.ok, true);
    if (!bRetry.ok || !bDead.ok) return;

    const sRetry = stageFileIntoBatch(host, session, {
      batchId: bRetry.batchId,
      fileName: "retry.xlsx",
      data: Buffer.from("retry-data"),
    });
    const sDead = stageFileIntoBatch(host, session2, {
      batchId: bDead.batchId,
      fileName: "dead.xlsx",
      data: Buffer.from("dead-data"),
    });
    assert.equal(sRetry.ok, true);
    assert.equal(sDead.ok, true);
    if (!sRetry.ok || !sDead.ok) return;

    // 先不绑定 worker，将两个批次入队
    bindIngestBatchWorker(null);
    commitDropBatchAndEnqueue(host, session, { batchId: bRetry.batchId });
    commitDropBatchAndEnqueue(host, session2, { batchId: bDead.batchId });

    // 真实修改持久化队列状态：
    // bRetry 模拟崩溃时处于 processing 且 attempts = 1（应恢复为 queued 并重跑）
    // bDead 模拟崩溃时处于 processing 且 attempts = 2（已达上限，应直接标记 failed 且保留 inbox 原件）
    forceQueueEntryStateForTest(host, bRetry.batchId, { status: "processing", attempts: 1 });
    forceQueueEntryStateForTest(host, bDead.batchId, { status: "processing", attempts: 2 });

    const ranAfterRecover: string[] = [];
    bindIngestBatchWorker(async ({ entry }) => {
      ranAfterRecover.push(`${entry.batchId}:attempt=${entry.attempts}`);
      return {
        status: "completed",
        statusMessage: "恢复成功",
      };
    });

    const drainedWs = recoverInterruptedIngestQueue(host);
    assert.equal(drainedWs.includes(session.workspaceId), true);
    await drainWorkspaceIngestQueue(host, session.workspaceId);

    // 只有 bRetry 被重新执行（且本次是第 2 次尝试）
    assert.deepEqual(ranAfterRecover, [`${bRetry.batchId}:attempt=2`]);

    const metaRetry = readBatchMetaSync(wsPath, bRetry.batchId);
    const metaDead = readBatchMetaSync(wsPath, bDead.batchId);
    assert.equal(metaRetry.ok, true);
    assert.equal(metaDead.ok, true);
    if (metaRetry.ok && metaDead.ok) {
      assert.equal(metaRetry.meta.status, "completed");
      assert.equal(metaDead.meta.status, "failed");
      assert.equal(Boolean(metaDead.meta.errorReason), true);
    }

    // 确认失败批次的原文件仍然完好保留在 inbox 批次目录中
    assert.equal(existsSync(join(wsPath, sDead.file.relPath)), true);
  });
});
