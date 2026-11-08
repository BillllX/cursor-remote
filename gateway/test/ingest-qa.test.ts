import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BACKGROUND_MODEL } from "../src/assistant/background.ts";
import { runningCount } from "../src/assistant/runs.ts";
import { initKbWorkspaceConfig, validateKbQaReadableRelPath } from "../src/ingest/contract.ts";
import { buildDropTenantHost } from "../src/ingest/http.ts";
import { startIngestRuntime, stopIngestQaSweepTimer } from "../src/ingest/notify.ts";
import { bindIngestBatchWorker } from "../src/ingest/queue.ts";
import { bindQaRunner, QA_AGENT_TOOLS, resetQaRunnerMemoryForTest } from "../src/ingest/qaRunner.ts";
import {
  ensureQaSessionStorageSync,
  resetQaStorageMemoryForTest,
  resolveSafeQaTenantRootSync,
  sweepTenantQaTempStorageSync,
  writeQaTempOutputFileSync,
} from "../src/ingest/qaStorage.ts";
import { bindIngestRunner } from "../src/ingest/runner.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  revokeDropToken,
  verifyDropPasscodeAndCreateSession,
} from "../src/ingest/tokens.ts";
import { createPublishController, type PublishTenant } from "../src/publish.ts";
import type { Tenant } from "../src/tenants.ts";
import { readWorkspaceAgentFile } from "../src/workspace/agents.ts";

const tempDirs: string[] = [];
const activeServers: Server[] = [];

async function makeQaTestEnv(opts: { overlapStateAndWorkspace?: boolean } = {}) {
  const base = join(tmpdir(), `ingest-qa-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const workspaceRoot = join(base, "workspaces");
  const stateDir = opts.overlapStateAndWorkspace ? workspaceRoot : join(base, "state");
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsPath, { recursive: true });
  tempDirs.push(base);

  writeFileSync(
    join(wsPath, "归档说明.md"),
    "# Fintopia 集团归档说明\n一级分类：资金、资产、牌照。\n",
    "utf8",
  );
  mkdirSync(join(wsPath, ".jiebo"), { recursive: true });
  writeFileSync(join(wsPath, ".jiebo", "memory.md"), "机密工作区记忆：严禁被外部访客问答读取\n", "utf8");
  writeFileSync(join(wsPath, "AGENTS.md"), "机密系统代理规则：严禁被外部访客问答读取\n", "utf8");

  mkdirSync(join(wsPath, ".cursor-remote", "uploads", "inbox", "b_secret999"), { recursive: true });
  writeFileSync(
    join(wsPath, ".cursor-remote", "uploads", "inbox", "b_secret999", "未归档绝密底表.csv"),
    "secret,1000\n",
    "utf8",
  );

  const initRes = initKbWorkspaceConfig(wsPath, {
    title: "Fintopia 集团知识库",
    allowedCategories: ["资金", "资产", "牌照"],
  });
  if (!initRes.ok) throw new Error(initRes.error);

  mkdirSync(join(wsPath, "资产", "洋钱罐"), { recursive: true });
  writeFileSync(
    join(wsPath, "资产", "资产.html"),
    "<!DOCTYPE html><html><head><style>.red{color:red}</style></head><body><h1>资产总览看板</h1><table><tr><th>主体</th><th>在贷余额(亿)</th><th>代偿率</th></tr><tr><td>洋钱罐</td><td>45.2</td><td>1.85%</td></tr><tr><td>三农信</td><td>12.8</td><td>2.10%</td></tr></table></body></html>",
    "utf8",
  );
  writeFileSync(
    join(wsPath, "资产", "洋钱罐", "202611_洋钱罐底表.xlsx"),
    "binary-xlsx-content",
    "utf8",
  );

  // 在分类目录内故意放一个隐藏目录，验证白名单能拦截分类内的隐藏段
  mkdirSync(join(wsPath, "资产", ".hidden_secret"), { recursive: true });
  writeFileSync(join(wsPath, "资产", ".hidden_secret", "leak.txt"), "leaked", "utf8");

  const tenant: PublishTenant = {
    id: "default",
    stateDir,
    workspaceRoot,
    name: "BillXu",
  };

  readWorkspaceAgentFile({
    id: tenant.id,
    stateDir: tenant.stateDir,
    workspaceRoot: tenant.workspaceRoot,
  } as Tenant);

  const host = buildDropTenantHost(tenant);
  const tokRes = createDropToken(host, {
    workspace: "Fintopia集团",
    passcode: "fintopia-qa-2026",
    label: "问答测试口令",
  });
  assert.equal(tokRes.ok, true);

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
    kbConfig: initRes.config,
  };
}

afterEach(async () => {
  stopIngestQaSweepTimer();
  bindIngestBatchWorker(null);
  bindIngestRunner(null);
  bindQaRunner(null);
  resetQaRunnerMemoryForTest();
  resetQaStorageMemoryForTest();
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

describe("知识库 Drop 页面只读问答对话框与临时目录隔离定期清理 (qaStorage / qaTools / qaRunner / http)", () => {
  test("纯白名单路径校验与临时目录物理隔离：拦截 .jiebo / .cursor-remote / AGENTS.md / 分类内隐藏目录，且 stateDir 与 workspaceRoot 重叠时自动回退至系统隔离目录", async () => {
    const { host, wsPath, kbConfig } = await makeQaTestEnv({ overlapStateAndWorkspace: true });

    // 1. 验证当 stateDir === workspaceRoot 重叠时，resolveSafeQaTenantRootSync 自动切换到 os.tmpdir() 隔离目录，绝不落在 workspaceRoot 内
    const rootRes = resolveSafeQaTenantRootSync(host);
    assert.equal(rootRes.ok, true);
    if (!rootRes.ok) return;
    assert.equal(rootRes.rootRealPath.startsWith(wsPath), false);
    tempDirs.push(rootRes.rootRealPath);

    // 2. 验证纯白名单 validateKbQaReadableRelPath
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, "归档说明.md", "file").ok, true);
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, "资产/资产.html", "file").ok, true);

    // 拦截隐藏目录、系统指令文件、未开放分类与路径穿越
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, ".jiebo/memory.md", "file").ok, false);
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, ".jiebo/kb.json", "file").ok, false);
    assert.equal(
      validateKbQaReadableRelPath(wsPath, kbConfig, ".cursor-remote/uploads/inbox/b_secret999/未归档绝密底表.csv", "file").ok,
      false,
    );
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, "AGENTS.md", "file").ok, false);
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, "资产/.hidden_secret/leak.txt", "file").ok, false);
    assert.equal(validateKbQaReadableRelPath(wsPath, kbConfig, "../state/assistant/drop-tokens.json", "file").ok, false);
  });

  test("完整 HTTP 问答与统计文件生成闭环：/api/auth 对工作区 0 写入 -> 上传临时比对附件 -> 询问并生成带 UTF-8 BOM 的 CSV 与安全静态 HTML 统计文件 -> 下载与预览 -> 主动清空", async () => {
    const { baseUrl, tenant, wsPath } = await makeQaTestEnv();

    let capturedTools: string[] | undefined;
    let capturedSettingSources: unknown;
    let capturedCwd = "";

    startIngestRuntime({
      tenants: () => [tenant],
      qaSweepIntervalMs: 0,
      qaRunnerOverrides: {
        apiKey: () => "qa-test-key",
        listModels: async () => [BACKGROUND_MODEL],
        sandbox: () => true,
        prompt: async (_promptText, options) => {
          capturedTools = options.tools ? [...options.tools] : undefined;
          capturedSettingSources = options.local?.settingSources;
          capturedCwd = options.local?.cwd || "";

          const custom = options.local?.customTools ?? {};

          // 1. 模型调用 kb_qa_list_files 查看知识库目录（验证不含 .jiebo 或 .hidden_secret）
          const listRaw = await custom.kb_qa_list_files.execute({}, { toolCallId: "qa_1" });
          const listed = JSON.parse(String(listRaw)) as {
            ok: boolean;
            files: Array<{ relPath: string }>;
          };
          assert.equal(listed.ok, true);
          assert.equal(
            listed.files.some((f) => f.relPath.includes(".jiebo") || f.relPath.includes(".hidden_secret") || f.relPath.includes("AGENTS.md")),
            false,
          );

          // 2. 模型尝试越权读取 .jiebo/memory.md -> 被工具层硬拦截
          const illegalReadRaw = await custom.kb_qa_read_file.execute(
            { relPath: ".jiebo/memory.md" },
            { toolCallId: "qa_2" },
          );
          const illegalRead = JSON.parse(String(illegalReadRaw)) as { ok: boolean };
          assert.equal(illegalRead.ok, false);

          // 3. 模型读取二进制 .xlsx 底表 -> 获得结构化提示去读同名 .html 看板
          const binReadRaw = await custom.kb_qa_read_file.execute(
            { relPath: "资产/洋钱罐/202611_洋钱罐底表.xlsx" },
            { toolCallId: "qa_3" },
          );
          const binRead = JSON.parse(String(binReadRaw)) as { ok: boolean; suggestedBoardPath?: string };
          assert.equal(binRead.ok, false);
          assert.equal(Boolean(binRead.suggestedBoardPath), true);

          // 4. 模型调用 kb_qa_search 搜索“洋钱罐”
          const searchRaw = await custom.kb_qa_search.execute(
            { query: "洋钱罐 代偿率" },
            { toolCallId: "qa_4" },
          );
          const searched = JSON.parse(String(searchRaw)) as {
            ok: boolean;
            matches: Array<{ relPath: string; snippet: string }>;
          };
          assert.equal(searched.ok, true);
          assert.equal(searched.matches.some((m) => m.relPath === "资产/资产.html"), true);

          // 5. 模型调用 kb_qa_read_file 读取 资产/资产.html
          const boardReadRaw = await custom.kb_qa_read_file.execute(
            { relPath: "资产/资产.html" },
            { toolCallId: "qa_5" },
          );
          const boardRead = JSON.parse(String(boardReadRaw)) as { ok: boolean; content: string };
          assert.equal(boardRead.ok, true);
          assert.equal(boardRead.content.includes("45.2"), true);

          // 6. 模型读取访客上传的临时比对附件
          const tempReadRaw = await custom.kb_qa_temp_read.execute(
            { scope: "uploads", fileName: "外部比对基准.csv" },
            { toolCallId: "qa_6" },
          );
          const tempRead = JSON.parse(String(tempReadRaw)) as { ok: boolean; content: string };
          assert.equal(tempRead.ok, true);
          assert.equal(tempRead.content.includes("外部基准"), true);

          // 7. 模型尝试向临时目录写入含 <script> 的恶意 HTML -> 被拦截
          const badHtmlWriteRaw = await custom.kb_qa_temp_write.execute(
            {
              fileName: "恶意看板.html",
              content: "<!DOCTYPE html><html><body><script>alert(1)</script></body></html>",
            },
            { toolCallId: "qa_7" },
          );
          const badHtmlWrite = JSON.parse(String(badHtmlWriteRaw)) as { ok: boolean };
          assert.equal(badHtmlWrite.ok, false);

          // 8. 模型调用 kb_qa_temp_write 生成 CSV 统计表（自动加 UTF-8 BOM）与安全静态 HTML 统计看板
          const csvWriteRaw = await custom.kb_qa_temp_write.execute(
            {
              fileName: "202611_知识库各主体核心指标统计.csv",
              content: "主体名称,在贷余额(亿),代偿率\n洋钱罐,45.2,1.85%\n三农信,12.8,2.10%\n",
            },
            { toolCallId: "qa_8" },
          );
          assert.equal((JSON.parse(String(csvWriteRaw)) as { ok: boolean }).ok, true);

          const htmlWriteRaw = await custom.kb_qa_temp_write.execute(
            {
              fileName: "202611_各主体风险对比看板.html",
              content:
                "<!DOCTYPE html><html><head><style>body{font-family:sans-serif;padding:16px}</style></head><body><h1>各主体风险对比统计看板</h1><p>在贷总余额：58.0 亿</p></body></html>",
            },
            { toolCallId: "qa_9" },
          );
          assert.equal((JSON.parse(String(htmlWriteRaw)) as { ok: boolean }).ok, true);

          return {
            id: "run_qa_1",
            status: "finished",
            result: "统计完成：当前知识库共 2 家主体，总在贷余额 58.0 亿。已为您生成 CSV 统计表与 HTML 对比看板，可直接在下方预览或下载。",
            messages: [],
          };
        },
      },
    });

    // 1. 打开 /p/default/drop 页面获取 pageTicket，验证 CSP 包含 allow-downloads 且 HTML 包含问答页签
    const pageRes = await fetch(`${baseUrl}/p/default/drop`);
    assert.equal(pageRes.status, 200);
    const csp = pageRes.headers.get("content-security-policy") || "";
    assert.equal(csp.includes("sandbox allow-scripts allow-downloads"), true);
    const pageHtml = await pageRes.text();
    assert.equal(pageHtml.includes("💬 知识库问答"), true);
    const ticketMatch = /const PAGE_TICKET = "(pt_[0-9a-f]+)"/.exec(pageHtml);
    assert.equal(Boolean(ticketMatch?.[1]), true);
    const pageTicket = ticketMatch![1];

    // 2. 调用 /api/auth 登录，验证此时知识库工作区 .cursor-remote/uploads/inbox/ 下没有新增任何批次目录（对工作区 100% 零写入）
    const inboxRoot = join(wsPath, ".cursor-remote", "uploads", "inbox");
    const inboxBeforeAuth = readdirSync(inboxRoot);

    const authRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: {
        origin: "null",
        "content-type": "application/json",
        "x-drop-page-ticket": pageTicket,
      },
      body: JSON.stringify({
        passcode: "fintopia-qa-2026",
        submitterName: "李工-数据分析",
      }),
    });
    assert.equal(authRes.status, 200);
    const authData = (await authRes.json()) as {
      ok: boolean;
      dropSessionToken: string;
      qaSessionId: string;
      batchId: string;
    };
    assert.equal(authData.ok, true);
    assert.equal(authData.qaSessionId.startsWith("qa_"), true);

    const inboxAfterAuth = readdirSync(inboxRoot);
    assert.deepEqual(inboxAfterAuth, inboxBeforeAuth, "仅登录口令或进行 QA 问答绝不能在工作区创建新 inbox 批次目录");

    // 3. 在问答框流式上传一份临时比对附件 `外部比对基准.csv`
    const qaUpRes = await fetch(
      `${baseUrl}/p/default/drop/api/qa/upload?fileName=${encodeURIComponent("外部比对基准.csv")}`,
      {
        method: "POST",
        headers: {
          origin: "null",
          authorization: `Bearer ${authData.dropSessionToken}`,
          "x-drop-page-ticket": pageTicket,
          "content-type": "application/octet-stream",
        },
        body: Buffer.from("主体,外部基准\n洋钱罐,1.90%\n"),
      },
    );
    assert.equal(qaUpRes.status, 200);

    // 4. 调用 /api/qa/ask 提问并请求生成统计文件
    const askRes = await fetch(`${baseUrl}/p/default/drop/api/qa/ask`, {
      method: "POST",
      headers: {
        origin: "null",
        authorization: `Bearer ${authData.dropSessionToken}`,
        "x-drop-page-ticket": pageTicket,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        question: "帮我统计知识库里各主体的在贷余额与代偿率，生成一个 CSV 统计表格和一个 HTML 看板给我下载",
        activeBoardPath: "资产/资产.html",
      }),
    });
    assert.equal(askRes.status, 200);
    const askData = (await askRes.json()) as {
      ok: boolean;
      answer: string;
      citedPaths: string[];
      generatedFiles: Array<{ name: string; ext: string }>;
      tempFiles: Array<{ name: string; scope: string }>;
    };
    assert.equal(askData.ok, true);
    assert.equal(askData.answer.includes("58.0 亿"), true);
    assert.deepEqual(askData.citedPaths, ["资产/资产.html"]);
    assert.equal(askData.generatedFiles.length, 2);

    // 验证 QA Runner 严格锁死 tools: ["mcp"] 且 settingSources: []，且 cwd 在工作区外独立临时目录，且未污染主人 runningCount
    assert.deepEqual(capturedTools, [...QA_AGENT_TOOLS]);
    assert.deepEqual(capturedSettingSources, []);
    assert.equal(capturedCwd.startsWith(wsPath), false);
    assert.equal(statSync(capturedCwd).mode & 0o777, 0o700);
    assert.equal(runningCount({ id: tenant.id, stateDir: tenant.stateDir }), 0);

    // 验证知识库工作区本身没有任何新增文件或修改
    assert.deepEqual(readdirSync(inboxRoot), inboxBeforeAuth);
    assert.equal(existsSync(join(wsPath, "202611_知识库各主体核心指标统计.csv")), false);

    // 5. 下载生成的中文名 CSV 统计文件，验证 RFC 5987 Content-Disposition、nosniff、CSP sandbox 以及 Excel UTF-8 BOM 头
    const dlCsvRes = await fetch(
      `${baseUrl}/p/default/drop/api/qa/file?name=${encodeURIComponent("202611_知识库各主体核心指标统计.csv")}`,
      {
        headers: {
          origin: "null",
          authorization: `Bearer ${authData.dropSessionToken}`,
          "x-drop-page-ticket": pageTicket,
        },
      },
    );
    assert.equal(dlCsvRes.status, 200);
    assert.equal(dlCsvRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(dlCsvRes.headers.get("content-security-policy")?.includes("sandbox"), true);
    assert.equal(
      dlCsvRes.headers.get("content-disposition")?.includes(encodeURIComponent("202611_知识库各主体核心指标统计.csv")),
      true,
    );
    const csvBuf = Buffer.from(await dlCsvRes.arrayBuffer());
    // 验证前 3 个字节为 UTF-8 BOM (0xEF, 0xBB, 0xBF)
    assert.equal(csvBuf[0], 0xef);
    assert.equal(csvBuf[1], 0xbb);
    assert.equal(csvBuf[2], 0xbf);
    assert.equal(csvBuf.toString("utf8").includes("洋钱罐,45.2,1.85%"), true);

    // 6. 尝试通过 /api/qa/file 路径穿越读取 session.json 或 ../drop-tokens.json -> 400 拒绝
    const pathTraversalDl = await fetch(
      `${baseUrl}/p/default/drop/api/qa/file?name=${encodeURIComponent("../session.json")}`,
      {
        headers: {
          origin: "null",
          authorization: `Bearer ${authData.dropSessionToken}`,
          "x-drop-page-ticket": pageTicket,
        },
      },
    );
    assert.equal(pathTraversalDl.status, 400);

    // 7. 调用 /api/qa/clear 主动清空，验证临时目录立即被物理销毁
    assert.equal(existsSync(capturedCwd), true);
    const clearRes = await fetch(`${baseUrl}/p/default/drop/api/qa/clear`, {
      method: "POST",
      headers: {
        origin: "null",
        authorization: `Bearer ${authData.dropSessionToken}`,
        "x-drop-page-ticket": pageTicket,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(clearRes.status, 200);
    assert.equal(existsSync(capturedCwd), false);
  });

  test("单飞锁、运行中吊销口令防目录复活（Tombstone Delete）、定期 Sweeper（空闲 30m / 绝对 2h / 孤儿目录 / 软链不跟随）", async () => {
    const { baseUrl, tenant, host } = await makeQaTestEnv();

    let unblockPrompt!: () => void;
    let toolCalledDuringRevoke = false;
    let lateWriteAttemptResult: unknown;

    startIngestRuntime({
      tenants: () => [tenant],
      qaSweepIntervalMs: 0,
      qaRunnerOverrides: {
        apiKey: () => "qa-test-key",
        listModels: async () => [BACKGROUND_MODEL],
        sandbox: () => true,
        prompt: async (_promptText, options) => {
          const custom = options.local?.customTools ?? {};
          await new Promise<void>((r) => {
            unblockPrompt = r;
          });
          // 当口令已被吊销后，模拟迟到的工具调用尝试继续写临时文件 -> 必须被 isClosed() 拒绝
          toolCalledDuringRevoke = true;
          lateWriteAttemptResult = await custom.kb_qa_temp_write.execute(
            { fileName: "死灰复燃.csv", content: "a,b\n1,2\n" },
            { toolCallId: "late_write" },
          );
          return {
            id: "run_revoke_race",
            status: "finished",
            result: "不应被写回的回答",
            messages: [],
          };
        },
      },
    });

    const authRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "fintopia-qa-2026", submitterName: "并发测试员" }),
    });
    const authData = (await authRes.json()) as { dropSessionToken: string; qaSessionId: string };

    // 1. 发起第一个提问（挂起在运行中）
    const ask1Promise = fetch(`${baseUrl}/p/default/drop/api/qa/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authData.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "第一个耗时问题" }),
    });

    // 等待第一个提问进入 prompt
    await new Promise((r) => setTimeout(r, 60));

    // 2. 同一会话并发发起第二个提问 -> 立即被单飞锁 409 拦截
    const ask2Res = await fetch(`${baseUrl}/p/default/drop/api/qa/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authData.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "第二个并发问题" }),
    });
    assert.equal(ask2Res.status, 409);

    // 3. 在第一个提问仍在运行期间，管理员吊销口令 -> 触发即时 abort 与墓碑删除，且迟到回调无法复活目录
    const rootRes = resolveSafeQaTenantRootSync(host);
    assert.equal(rootRes.ok, true);
    if (!rootRes.ok) return;
    const wsRef = host.resolveWorkspace("Fintopia集团")!;
    const expectedSessionDir = join(rootRes.rootRealPath, wsRef.workspaceId, authData.qaSessionId);
    assert.equal(existsSync(expectedSessionDir), true);

    revokeDropToken(host, "问答测试口令");
    unblockPrompt();

    const ask1Res = await ask1Promise;
    assert.equal(ask1Res.status === 401 || ask1Res.status === 403, true);
    assert.equal(toolCalledDuringRevoke, true);
    assert.equal((lateWriteAttemptResult as { isError?: boolean })?.isError, true);
    // 验证会话临时目录彻底不存在，没有因为迟到的写工具或 appendQaHistoryTurnSync 而死灰复燃
    assert.equal(existsSync(expectedSessionDir), false);

    // 4. 验证定期 Sweeper：创建新口令与会话，模拟空闲超时（> 30m）、无主孤儿目录与符号链接防穿透
    createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "fintopia-qa-new",
      label: "新口令",
    });
    const t0 = 1_750_000_000_000;
    const newSessionRes = verifyDropPasscodeAndCreateSession(
      host,
      {
        passcode: "fintopia-qa-new",
        submitterName: "清理测试员",
        clientIp: "10.0.0.8",
      },
      t0,
    );
    assert.equal(newSessionRes.ok, true);
    if (!newSessionRes.ok) return;

    const ensured = ensureQaSessionStorageSync(host, newSessionRes.session, t0);
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;

    const writeOut = writeQaTempOutputFileSync(
      host,
      newSessionRes.session,
      "待清理统计表.csv",
      "col1,col2\n1,2\n",
      t0,
    );
    assert.equal(writeOut.ok, true);
    assert.equal(existsSync(ensured.sessionDir), true);

    // 构造一个不在注册表中的孤儿目录 + 指向外部受害文件的符号链接
    const victimFile = join(tmpdir(), `qa-symlink-victim-${Date.now()}.txt`);
    writeFileSync(victimFile, "do-not-delete-me", "utf8");
    tempDirs.push(victimFile);

    const orphanDir = join(rootRes.rootRealPath, wsRef.workspaceId, "qa_orphan_000000000000000000000000");
    mkdirSync(orphanDir, { recursive: true });
    symlinkSync(victimFile, join(orphanDir, "sym.txt"));
    const oldDate = new Date((t0 - 10 * 60 * 1000));
    utimesSync(orphanDir, oldDate, oldDate);

    // 在 t0 + 10 分钟扫描：活跃会话未满 30m 保留，孤儿目录（mtime > 5m）被删除且不穿透删除外部 victimFile
    const sweep1 = sweepTenantQaTempStorageSync(host, { now: t0 + 10 * 60 * 1000 });
    assert.equal(sweep1.removedSessions, 0);
    assert.equal(sweep1.removedOrphans >= 1, true);
    assert.equal(existsSync(orphanDir), false);
    assert.equal(existsSync(victimFile), true);
    assert.equal(existsSync(ensured.sessionDir), true);

    // 在 t0 + 31 分钟扫描：空闲超过 30 分钟，会话临时目录被彻底删除
    const sweep2 = sweepTenantQaTempStorageSync(host, { now: t0 + 31 * 60 * 1000 });
    assert.equal(sweep2.removedSessions, 1);
    assert.equal(existsSync(ensured.sessionDir), false);
  });

  test("大于 64KB (120KB) 临时附件分页读取、清空对话重开 generation 竞态保护、以及超时后底层运行未结束前继续保持并发信号量", async () => {
    const { baseUrl, tenant } = await makeQaTestEnv();

    let unblockFirstAsk!: () => void;
    let mode: "large-file" | "clear-race" | "timeout-concurrency" = "large-file";

    startIngestRuntime({
      tenants: () => [tenant],
      qaSweepIntervalMs: 0,
      qaRunnerOverrides: {
        apiKey: () => "qa-test-key",
        listModels: async () => {
          if (mode === "clear-race") {
            await new Promise<void>((r) => {
              unblockFirstAsk = r;
            });
          }
          return [BACKGROUND_MODEL];
        },
        sandbox: () => true,
        prompt: async (_promptText, options) => {
          const custom = options.local?.customTools ?? {};
          if (mode === "large-file") {
            const readPage1Raw = await custom.kb_qa_temp_read.execute(
              { scope: "uploads", fileName: "120KB_大台账.csv", startLine: 1, maxLines: 500 },
              { toolCallId: "large_1" },
            );
            const page1 = JSON.parse(String(readPage1Raw)) as {
              ok: boolean;
              truncated: boolean;
              totalLines: number;
              content: string;
            };
            assert.equal(page1.ok, true);
            assert.equal(page1.truncated, true);
            assert.equal(page1.totalLines >= 2000, true);
            assert.equal(Buffer.byteLength(page1.content, "utf8") <= 66 * 1024, true);

            const readPage2Raw = await custom.kb_qa_temp_read.execute(
              { scope: "uploads", fileName: "120KB_大台账.csv", startLine: 1800, maxLines: 300 },
              { toolCallId: "large_2" },
            );
            const page2 = JSON.parse(String(readPage2Raw)) as { ok: boolean; content: string };
            assert.equal(page2.ok, true);
            assert.equal(page2.content.includes("ROW_1999"), true);
          } else if (mode === "timeout-concurrency") {
            await new Promise<void>((r) => {
              unblockFirstAsk = r;
            });
          }
          return {
            id: "run_edge",
            status: "finished",
            result: "边缘场景验证通过",
            messages: [],
          };
        },
      },
    });

    const authRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "fintopia-qa-2026", submitterName: "压力测试员" }),
    });
    const authData = (await authRes.json()) as { dropSessionToken: string };

    // 1. 上传一份 ~120KB 的 CSV 临时附件（超过 64KB 单次返回上限，但小于 4MB 单文件上限）
    const lines: string[] = ["id,name,amount,remark"];
    for (let i = 1; i <= 2000; i++) {
      lines.push(`ROW_${i},洋钱罐资产包_${i},100000.00,用于测试超过64KB的临时比对文件分页读取能力_${i}`);
    }
    const bigCsvBuf = Buffer.from(lines.join("\n"), "utf8");
    assert.equal(bigCsvBuf.length > 100 * 1024, true);

    const upBigRes = await fetch(
      `${baseUrl}/p/default/drop/api/qa/upload?fileName=${encodeURIComponent("120KB_大台账.csv")}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${authData.dropSessionToken}`,
          "content-type": "application/octet-stream",
        },
        body: bigCsvBuf,
      },
    );
    assert.equal(upBigRes.status, 200);

    const askLargeRes = await fetch(`${baseUrl}/p/default/drop/api/qa/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authData.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "读取 120KB_大台账.csv 的首尾数据" }),
    });
    assert.equal(askLargeRes.status, 200);

    // 2. 验证「在途 listModels 期间点击 /api/qa/clear 清空对话」后，旧请求的 finally 绝不会把当前会话锁死为 403
    mode = "clear-race";
    const inFlightAskPromise = fetch(`${baseUrl}/p/default/drop/api/qa/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authData.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "将被清空取消的在途提问" }),
    });

    await new Promise((r) => setTimeout(r, 40));

    // 用户点击清空对话
    const clearRes = await fetch(`${baseUrl}/p/default/drop/api/qa/clear`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authData.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(clearRes.status, 200);

    // 释放刚才卡在 listModels 的旧请求，等待其彻底走完 finally
    if (unblockFirstAsk) unblockFirstAsk();
    const cancelledAskRes = await inFlightAskPromise;
    assert.equal(cancelledAskRes.status, 403);

    // 清空后同一会话紧接着发起新提问 -> 必须 200 成功，绝不能因旧请求 finally 被误锁为 403
    mode = "large-file";
    const reUpRes = await fetch(
      `${baseUrl}/p/default/drop/api/qa/upload?fileName=${encodeURIComponent("120KB_大台账.csv")}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${authData.dropSessionToken}`,
          "content-type": "application/octet-stream",
        },
        body: bigCsvBuf,
      },
    );
    assert.equal(reUpRes.status, 200);

    const askAfterClearRes = await fetch(`${baseUrl}/p/default/drop/api/qa/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authData.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "清空重开后的新提问" }),
    });
    assert.equal(askAfterClearRes.status, 200);
  });
});
