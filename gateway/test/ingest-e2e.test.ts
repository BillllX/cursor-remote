import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BACKGROUND_MODEL } from "../src/assistant/background.ts";
import { listInbox, PUSH_KINDS } from "../src/assistant/inbox.ts";
import { initKbWorkspaceConfig, KB_INGEST_LOG_REL_PATH } from "../src/ingest/contract.ts";
import { buildDropTenantHost } from "../src/ingest/http.ts";
import { getKbWorkspaceStatusForUi } from "../src/ingest/hub.ts";
import { appendWorkspaceIngestLog, startIngestRuntime, stopIngestQaSweepTimer } from "../src/ingest/notify.ts";
import {
  bindIngestBatchWorker,
  commitDropBatchAndEnqueue,
  drainWorkspaceIngestQueue,
  forceQueueEntryStateForTest,
} from "../src/ingest/queue.ts";
import { bindIngestRunner } from "../src/ingest/runner.ts";
import { createDropBatch, stageFileIntoBatch } from "../src/ingest/staging.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  verifyDropPasscodeAndCreateSession,
} from "../src/ingest/tokens.ts";
import { createPublishController, type PublishTenant } from "../src/publish.ts";
import type { Tenant } from "../src/tenants.ts";
import { readWorkspaceAgentFile } from "../src/workspace/agents.ts";

const tempDirs: string[] = [];
const activeServers: Server[] = [];

async function makeE2eEnv() {
  const base = join(tmpdir(), `ingest-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(base, "state");
  const workspaceRoot = join(base, "workspaces");
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsPath, { recursive: true });
  tempDirs.push(base);

  writeFileSync(
    join(wsPath, "归档说明.md"),
    "# Fintopia 集团工作区归档说明\n一级目录：资金、资产、牌照。按主体与内容性质分类归档，并同步更新同名 .html 知识库。\n",
    "utf8",
  );
  mkdirSync(join(wsPath, ".jiebo"), { recursive: true });
  writeFileSync(join(wsPath, ".jiebo", "memory.md"), "# 工作区记忆\n保持纯净不被摘要污染\n", "utf8");

  const initRes = initKbWorkspaceConfig(wsPath, {
    title: "Fintopia 集团知识库",
    allowedCategories: ["资金", "资产", "牌照"],
  });
  if (!initRes.ok) throw new Error(initRes.error);

  writeFileSync(
    join(wsPath, "资产", "资产.html"),
    "<!DOCTYPE html><html><head><title>资产总览</title><style>body{font-family:sans-serif}</style></head><body><h1>Fintopia 资产看板（旧）</h1></body></html>",
    "utf8",
  );

  const tenant: PublishTenant = {
    id: "default",
    stateDir,
    workspaceRoot,
    name: "BillXu",
  };

  // 初始化工作区映射并写入真实的 UUID mainChatId
  const agentFile = readWorkspaceAgentFile({
    id: tenant.id,
    stateDir: tenant.stateDir,
    workspaceRoot: tenant.workspaceRoot,
  } as Tenant);
  const expectedMainChatId = randomUUID();
  agentFile.items["Fintopia集团"].mainChatId = expectedMainChatId;
  writeFileSync(join(stateDir, "workspace-agent-chats.json"), JSON.stringify(agentFile), "utf8");

  const host = buildDropTenantHost(tenant);
  const tokRes = createDropToken(host, {
    workspace: "Fintopia集团",
    passcode: "fintopia-2026",
    label: "Fintopia业务线投递码",
  });
  assert.equal(tokRes.ok, true);

  // 在调用 startIngestRuntime 之前，先预置一个因上次网关重启中断在 processing (attempts=1) 状态的残留批次，验证 startIngestRuntime 的启动恢复能力
  bindIngestBatchWorker(null);
  const preSessionRes = verifyDropPasscodeAndCreateSession(host, {
    passcode: "fintopia-2026",
    submitterName: "王工-启动前残留批次",
    clientIp: "10.0.0.5",
  });
  assert.equal(preSessionRes.ok, true);
  if (!preSessionRes.ok) throw new Error("pre auth failed");
  const preBatch = createDropBatch(host, preSessionRes.session);
  if (!preBatch.ok) throw new Error("pre batch failed");
  stageFileIntoBatch(host, preSessionRes.session, {
    batchId: preBatch.batchId,
    fileName: "重启恢复测试台账.xlsx",
    data: Buffer.from("recovered-xlsx-data"),
  });
  commitDropBatchAndEnqueue(host, preSessionRes.session, {
    batchId: preBatch.batchId,
    note: "网关重启前中断的批次",
  });
  forceQueueEntryStateForTest(host, preBatch.batchId, { status: "processing", attempts: 1 });

  // 启动归档运行时（会自动恢复并消费 preBatch.batchId）
  const recoveredWorkspaces = startIngestRuntime({
    tenants: () => [tenant],
    runnerOverrides: {
      apiKey: () => "e2e-test-key",
      listModels: async () => [BACKGROUND_MODEL],
      sandbox: () => true,
      prompt: async (_promptText, options) => {
        const custom = options.local?.customTools ?? {};
        const rawInfo = await custom.ingest_batch_info.execute({}, { toolCallId: "e2e_1" });
        const info = JSON.parse(String(rawInfo)) as {
          batchId: string;
          files: Array<{ relPath: string; originalName: string }>;
        };

        for (const f of info.files) {
          await custom.ingest_move_file.execute(
            {
              fromRelPath: f.relPath,
              toRelPath: `资产/洋钱罐（锋泰、瓴岳）/${f.originalName}`,
            },
            { toolCallId: "e2e_2" },
          );
        }

        await custom.ingest_update_html.execute(
          {
            htmlRelPath: "资产/洋钱罐（锋泰、瓴岳）/洋钱罐（锋泰、瓴岳）.html",
            htmlContent:
              "<!DOCTYPE html><html><head><style>body{margin:16px}</style></head><body><h1>洋钱罐风险预估看板</h1><p>2026年11月在贷余额与Vintage风险指标已更新。</p></body></html>",
          },
          { toolCallId: "e2e_3" },
        );

        await custom.ingest_update_html.execute(
          {
            htmlRelPath: "资产/资产.html",
            htmlContent:
              "<!DOCTYPE html><html><head><style>body{margin:16px}</style></head><body><h1>Fintopia 资产看板（已同步11月洋钱罐）</h1></body></html>",
          },
          { toolCallId: "e2e_4" },
        );

        return {
          id: "run_e2e_1",
          status: "finished",
          result: "已将投递文档归档至洋钱罐目录，核心结论：11月Vintage风险平稳，已同步更新两级 HTML 看板。",
          messages: [],
        };
      },
    },
  });
  assert.equal(recoveredWorkspaces.length, 1);

  const publish = createPublishController({
    tenants: () => [tenant],
    sweepMs: 0,
  });

  const server = createServer((req, res) => {
    if (!publish.handleHttp(req, res)) {
      res.writeHead(404).end("not handled");
    }
  });
  activeServers.push(server);

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    base,
    stateDir,
    workspaceRoot,
    wsPath,
    tenant,
    host,
    baseUrl,
    expectedMainChatId,
    preBatchId: preBatch.batchId,
  };
}

afterEach(async () => {
  stopIngestQaSweepTimer();
  bindIngestBatchWorker(null);
  bindIngestRunner(null);
  resetDropAuthMemoryStateForTest();
  while (activeServers.length) {
    const srv = activeServers.pop()!;
    await new Promise<void>((r) => srv.close(() => r()));
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Step 6: 收件箱 brief 推送、ingest-log.jsonl 与 Fintopia 端到端全链路验收 (notify.ts + E2E)", () => {
  test("startIngestRuntime 启动恢复中断批次 + 同事 /p/default/drop 盲投 -> 多 chunk 流式落盘 -> 物理归档与更新 HTML -> 写 ingest-log.jsonl -> 推收件箱 brief 卡片（绑定真实 mainChatId）", async () => {
    const { baseUrl, host, wsPath, expectedMainChatId } = await makeE2eEnv();

    // 1. 同事打开 /p/default/drop 页面获取内嵌 pageTicket
    const pageRes = await fetch(`${baseUrl}/p/default/drop`);
    assert.equal(pageRes.status, 200);
    const pageHtml = await pageRes.text();
    const ticketMatch = /const PAGE_TICKET = "(pt_[0-9a-f]+)"/.exec(pageHtml);
    assert.equal(Boolean(ticketMatch?.[1]), true);
    const pageTicket = ticketMatch![1];

    // 2. 同事在沙箱页面（Origin: null）凭口令与 pageTicket 调用 /api/auth
    const authRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: {
        origin: "null",
        "content-type": "application/json",
        "x-drop-page-ticket": pageTicket,
      },
      body: JSON.stringify({
        passcode: "fintopia-2026",
        submitterName: "张工-风控部",
      }),
    });
    assert.equal(authRes.status, 200);
    const authData = (await authRes.json()) as {
      ok: boolean;
      dropSessionToken: string;
      batchId: string;
      receiptToken: string;
    };
    assert.equal(authData.ok, true);

    // 3. 同事通过多 chunk ReadableStream 流式上传《20261102_洋钱罐风险预估.xlsx》
    const multiChunkBody = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("real-fintopia-"));
        controller.enqueue(Buffer.from("vintage-xlsx-"));
        controller.enqueue(Buffer.from("payload"));
        controller.close();
      },
    });
    const uploadInit: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: {
        origin: "null",
        authorization: `Bearer ${authData.dropSessionToken}`,
        "x-drop-page-ticket": pageTicket,
        "content-type": "application/octet-stream",
      },
      body: multiChunkBody,
      duplex: "half",
    };
    const uploadRes = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(authData.batchId)}&fileName=${encodeURIComponent("20261102_洋钱罐风险预估.xlsx")}`,
      uploadInit,
    );
    assert.equal(uploadRes.status, 200);

    // 4. 同事点击提交批次
    const commitRes = await fetch(`${baseUrl}/p/default/drop/api/commit`, {
      method: "POST",
      headers: {
        origin: "null",
        authorization: `Bearer ${authData.dropSessionToken}`,
        "x-drop-page-ticket": pageTicket,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        batchId: authData.batchId,
        note: "11月最新洋钱罐Vintage风险预估表",
      }),
    });
    assert.equal(commitRes.status, 200);

    // 5. 等待工作区归档队列（含启动恢复的 preBatch 与新提交的 batchId）全部执行完毕
    const wsRef = host.resolveWorkspace("Fintopia集团")!;
    await drainWorkspaceIngestQueue(host, wsRef.workspaceId);

    // 6. 验证启动恢复批次的文件与新上传批次的文件均已物理归档落盘
    const recoveredAbs = join(wsPath, "资产", "洋钱罐（锋泰、瓴岳）", "重启恢复测试台账.xlsx");
    const archivedAbs = join(wsPath, "资产", "洋钱罐（锋泰、瓴岳）", "20261102_洋钱罐风险预估.xlsx");
    assert.equal(existsSync(recoveredAbs), true);
    assert.equal(existsSync(archivedAbs), true);
    assert.equal(readFileSync(archivedAbs, "utf8"), "real-fintopia-vintage-xlsx-payload");

    // 7. 验证两级同名 HTML 看板均已更新且带有 JIEBO_KB_META 水位线注释
    const subHtml = readFileSync(join(wsPath, "资产", "洋钱罐（锋泰、瓴岳）", "洋钱罐（锋泰、瓴岳）.html"), "utf8");
    const topHtml = readFileSync(join(wsPath, "资产", "资产.html"), "utf8");
    assert.equal(subHtml.startsWith("<!-- JIEBO_KB_META:"), true);
    assert.equal(topHtml.startsWith("<!-- JIEBO_KB_META:"), true);
    assert.equal(topHtml.includes("已同步11月洋钱罐"), true);

    // 8. 验证入库台账写入 .jiebo/ingest-log.jsonl（共 2 条：恢复批次 + 新投递批次），且 .jiebo/memory.md 未被污染
    const logLines = readFileSync(join(wsPath, KB_INGEST_LOG_REL_PATH), "utf8").trim().split("\n");
    assert.equal(logLines.length, 2);
    const logEntry = JSON.parse(logLines[1]) as {
      batchId: string;
      status: string;
      submitterName: string;
      movedFiles: Array<{ to: string }>;
    };
    assert.equal(logEntry.batchId, authData.batchId);
    assert.equal(logEntry.status, "completed");
    assert.equal(logEntry.submitterName, "张工-风控部");
    assert.deepEqual(
      logEntry.movedFiles.map((m) => m.to),
      ["资产/洋钱罐（锋泰、瓴岳）/20261102_洋钱罐风险预估.xlsx"],
    );
    assert.equal(readFileSync(join(wsPath, ".jiebo", "memory.md"), "utf8"), "# 工作区记忆\n保持纯净不被摘要污染\n");

    // 9. 验证收件箱收到 kind: "brief" 推送卡片（绑定真实 UUID mainChatId、带 @相对路径）
    const inboxItems = listInbox(host, 10);
    assert.equal(inboxItems.length, 2);
    const card = inboxItems.find((i) => i.key === `ingest:${authData.batchId}`)!;
    assert.equal(Boolean(card), true);
    assert.equal(card.kind, "brief");
    assert.equal(PUSH_KINDS.includes(card.kind), true);
    assert.equal(card.chatId, expectedMainChatId);
    assert.equal(card.title.includes("Fintopia 集团知识库"), true);
    assert.equal(card.title.includes("张工-风控部"), true);
    assert.equal(card.body.includes("@资产/资产.html"), true);
    assert.equal(card.body.includes("@资产/洋钱罐（锋泰、瓴岳）/洋钱罐（锋泰、瓴岳）.html"), true);
    assert.equal(card.body.includes("@资产/洋钱罐（锋泰、瓴岳）/20261102_洋钱罐风险预估.xlsx"), true);

    // 10. 同事在网页端轮询 /api/status 看到 completed 状态
    const statusRes = await fetch(
      `${baseUrl}/p/default/drop/api/status?batchId=${encodeURIComponent(authData.batchId)}`,
      {
        headers: {
          origin: "null",
          "x-drop-page-ticket": pageTicket,
          "x-drop-receipt": authData.receiptToken,
        },
      },
    );
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as { status: { status: string } };
    assert.equal(statusData.status.status, "completed");

    // 10b. 验证同事凭上传会话调用 /api/boards 与 /api/board 在线浏览知识库 HTML 看板（且禁止读取非同名 HTML 或原始 .xlsx 底表）
    const boardsRes = await fetch(`${baseUrl}/p/default/drop/api/boards`, {
      headers: {
        origin: "null",
        authorization: `Bearer ${authData.dropSessionToken}`,
        "x-drop-page-ticket": pageTicket,
      },
    });
    assert.equal(boardsRes.status, 200);
    const boardsData = (await boardsRes.json()) as {
      ok: boolean;
      boards: Array<{ relPath: string; level: string }>;
    };
    assert.equal(boardsData.ok, true);
    assert.equal(
      boardsData.boards.some((b) => b.relPath === "资产/资产.html" && b.level === "category"),
      true,
    );
    assert.equal(
      boardsData.boards.some(
        (b) => b.relPath === "资产/洋钱罐（锋泰、瓴岳）/洋钱罐（锋泰、瓴岳）.html" && b.level === "subject",
      ),
      true,
    );

    const viewBoardRes = await fetch(
      `${baseUrl}/p/default/drop/api/board?path=${encodeURIComponent("资产/资产.html")}`,
      {
        headers: {
          origin: "null",
          authorization: `Bearer ${authData.dropSessionToken}`,
          "x-drop-page-ticket": pageTicket,
        },
      },
    );
    assert.equal(viewBoardRes.status, 200);
    const viewBoardData = (await viewBoardRes.json()) as { ok: boolean; htmlContent: string };
    assert.equal(viewBoardData.ok, true);
    assert.equal(viewBoardData.htmlContent.includes("已同步11月洋钱罐"), true);

    // 尝试通过 /api/board 下载底层原始 .xlsx 底表或 .jiebo/memory.md -> 403 拒绝
    const forbiddenRawFile = await fetch(
      `${baseUrl}/p/default/drop/api/board?path=${encodeURIComponent("资产/洋钱罐（锋泰、瓴岳）/20261102_洋钱罐风险预估.xlsx")}`,
      {
        headers: {
          origin: "null",
          authorization: `Bearer ${authData.dropSessionToken}`,
          "x-drop-page-ticket": pageTicket,
        },
      },
    );
    assert.equal(forbiddenRawFile.status, 403);

    // 10c. 验证 getKbWorkspaceStatusForUi 返回完整的知识库状态、HTML 看板与口令列表
    const uiStatus = getKbWorkspaceStatusForUi(host, "Fintopia集团");
    assert.equal(uiStatus.ok, true);
    if (uiStatus.ok) {
      assert.equal(uiStatus.data.isKnowledgeBase, true);
      assert.equal(uiStatus.data.boards.length, 2);
      assert.equal(uiStatus.data.tokens.length, 1);
    }

    // 11. 验证 appendWorkspaceIngestLog 在追加后总大小严格受控（≤ 1MB）且保留最新记录
    const bigSummary = "x".repeat(450 * 1024);
    appendWorkspaceIngestLog(wsPath, {
      batchId: "b_big1",
      timestamp: Date.now(),
      status: "completed",
      submitterName: "测试",
      note: "",
      movedFiles: [],
      updatedHtmls: [],
      summary: bigSummary,
    });
    appendWorkspaceIngestLog(wsPath, {
      batchId: "b_big2",
      timestamp: Date.now(),
      status: "completed",
      submitterName: "测试",
      note: "",
      movedFiles: [],
      updatedHtmls: [],
      summary: bigSummary,
    });
    appendWorkspaceIngestLog(wsPath, {
      batchId: "b_big3",
      timestamp: Date.now(),
      status: "completed",
      submitterName: "测试",
      note: "",
      movedFiles: [],
      updatedHtmls: [],
      summary: bigSummary,
    });
    const afterTrimContent = readFileSync(join(wsPath, KB_INGEST_LOG_REL_PATH), "utf8");
    assert.equal(Buffer.byteLength(afterTrimContent, "utf8") <= 1024 * 1024, true);
    const afterTrimLines = afterTrimContent.trim().split("\n");
    assert.equal(afterTrimLines.length, 2);
    assert.equal(afterTrimLines[0].includes("b_big2"), true);
    assert.equal(afterTrimLines[1].includes("b_big3"), true);
  });
});
