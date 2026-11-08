import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { initKbWorkspaceConfig } from "../src/ingest/contract.ts";
import { buildDropTenantHost } from "../src/ingest/http.ts";
import { bindIngestBatchWorker, drainWorkspaceIngestQueue } from "../src/ingest/queue.ts";
import { normalizeWebhookUrl, scanWatchFolderOnce } from "../src/ingest/watchFolder.ts";
import {
  createDropToken,
  listDropTokens,
  resetDropAuthMemoryStateForTest,
  revokeDropToken,
  updateDropToken,
} from "../src/ingest/tokens.ts";
import { createPublishController, type PublishTenant } from "../src/publish.ts";
import type { Tenant } from "../src/tenants.ts";
import { readWorkspaceAgentFile } from "../src/workspace/agents.ts";

const tempDirs: string[] = [];
const activeServers: Server[] = [];

async function makeHttpTestEnv(opts: { maxFileBytes?: number } = {}) {
  const base = join(tmpdir(), `ingest-http-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(base, "state");
  const workspaceRoot = join(base, "workspaces");
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsPath, { recursive: true });
  tempDirs.push(base);

  const tenant: PublishTenant = {
    id: "default",
    stateDir,
    workspaceRoot,
    name: "BillXu <script>alert(1)</script>",
  };

  // 初始化 workspace-agent-chats.json 映射
  readWorkspaceAgentFile({
    id: tenant.id,
    stateDir: tenant.stateDir,
    workspaceRoot: tenant.workspaceRoot,
  } as Tenant);

  const host = buildDropTenantHost(tenant);
  const initRes = initKbWorkspaceConfig(wsPath, {
    title: "Fintopia 集团知识库",
    allowedCategories: ["资金", "资产", "牌照"],
    ...(opts.maxFileBytes !== undefined ? { maxFileBytes: opts.maxFileBytes } : {}),
  });
  assert.equal(initRes.ok, true);

  const tokenRes = createDropToken(host, {
    workspace: "Fintopia集团",
    passcode: "fintopia-2026",
  });
  assert.equal(tokenRes.ok, true);

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

  return { base, stateDir, workspaceRoot, wsPath, tenant, host, baseUrl };
}

afterEach(async () => {
  bindIngestBatchWorker(null);
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

describe("Step 4: 网关内置 /p/<tenant>/drop 盲投页面与流式 API (http.ts + publish.ts)", () => {
  test("工作台未启动时 /p/default/drop 仍返回 200 内联投递页（含 CSP sandbox 不透明源隔离、HEAD 支持与 XSS 转义）", async () => {
    const { baseUrl } = await makeHttpTestEnv();

    const pageRes = await fetch(`${baseUrl}/p/default/drop`);
    assert.equal(pageRes.status, 200);
    assert.equal(pageRes.headers.get("content-type")?.includes("text/html"), true);
    const csp = pageRes.headers.get("content-security-policy") || "";
    assert.equal(csp.includes("sandbox allow-scripts"), true);
    assert.equal(csp.includes("connect-src *"), true);
    const html = await pageRes.text();
    assert.equal(html.includes("工作区资料投递箱"), true);
    assert.equal(html.includes("32 MB"), true);
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.equal(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);

    // 验证 CORS OPTIONS 预检返回 204 且放行沙箱 Origin: null 与 X-Drop-Page-Ticket
    const optRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "OPTIONS",
      headers: { origin: "null" },
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get("access-control-allow-origin"), "null");
    assert.equal(optRes.headers.get("access-control-allow-headers")?.includes("x-drop-page-ticket"), true);

    // 验证来自 Origin: null 但未携带有效 X-Drop-Page-Ticket 的请求被 403 拒绝
    const forgedSandboxReq = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: {
        origin: "null",
        "content-type": "application/json",
      },
      body: JSON.stringify({ passcode: "fintopia-2026", submitterName: "伪造沙箱" }),
    });
    assert.equal(forgedSandboxReq.status, 403);

    const headRes = await fetch(`${baseUrl}/p/default/drop`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), "");
  });

  test("完整 HTTP 闭环：auth -> 逐文件流式 upload -> commit -> 凭 X-Drop-Receipt 查状态，且严禁跨批次操作或超限上传", async () => {
    const { baseUrl, host, wsPath } = await makeHttpTestEnv({ maxFileBytes: 2048 });

    // 1. 未带 Bearer Token 直接调 upload 返回 401
    const unauthUpload = await fetch(`${baseUrl}/p/default/drop/api/upload?batchId=b_123456&fileName=a.pdf`, {
      method: "POST",
      body: Buffer.from("hello"),
    });
    assert.equal(unauthUpload.status, 401);

    // 2. 错误口令调 auth 返回 401
    const badAuth = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "wrong-pass", submitterName: "张工" }),
    });
    assert.equal(badAuth.status, 401);

    // 3. 创建两个真实批次 A 和 B
    const authARes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "fintopia-2026", submitterName: "张工-A批次" }),
    });
    const authBRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "fintopia-2026", submitterName: "李工-B批次" }),
    });
    assert.equal(authARes.status, 200);
    assert.equal(authBRes.status, 200);
    const batchA = (await authARes.json()) as {
      ok: boolean;
      dropSessionToken: string;
      batchId: string;
      receiptToken: string;
      workspaceTitle: string;
    };
    const batchB = (await authBRes.json()) as {
      ok: boolean;
      dropSessionToken: string;
      batchId: string;
      receiptToken: string;
    };

    // 4. 会话 A 尝试往批次 B 上传文件被 403 拦截（session 严格绑定 batchId）
    const crossBatchUpload = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(batchB.batchId)}&fileName=a.pdf`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${batchA.dropSessionToken}` },
        body: Buffer.from("cross-attempt"),
      },
    );
    assert.equal(crossBatchUpload.status, 403);

    // 5. 上传超过 maxFileBytes (2048 bytes) 的 chunked 流（不带 Content-Length 头）返回 413 JSON 且清理 .part 临时文件
    const chunkedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1500));
        controller.enqueue(new Uint8Array(1500));
        controller.close();
      },
    });
    const oversizedInit: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: { authorization: `Bearer ${batchA.dropSessionToken}` },
      body: chunkedStream,
      duplex: "half",
    };
    const oversizedUpload = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(batchA.batchId)}&fileName=big.pdf`,
      oversizedInit,
    );
    assert.equal(oversizedUpload.status, 413);
    const oversizedJson = (await oversizedUpload.json()) as { ok: boolean; error: string };
    assert.equal(oversizedJson.ok, false);
    // 验证批次目录中无残留 .part 临时文件
    const batchADir = join(wsPath, ".cursor-remote/uploads/inbox", batchA.batchId);
    const remainingFiles = readdirSync(batchADir);
    assert.equal(
      remainingFiles.some((f) => f.endsWith(".part") || f.startsWith(".tmp-")),
      false,
    );

    // 6. 上传危险脚本文件 (.sh) 被 400 拦截
    const badFileRes = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(batchA.batchId)}&fileName=hack.sh`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${batchA.dropSessionToken}` },
        body: Buffer.from("echo pwn"),
      },
    );
    assert.equal(badFileRes.status, 400);

    // 7. 逐个流式上传两个合法文件到批次 A
    const up1 = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(batchA.batchId)}&fileName=${encodeURIComponent("11月三农信代偿台账.xlsx")}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${batchA.dropSessionToken}` },
        body: Buffer.from("xlsx-bytes-1"),
      },
    );
    assert.equal(up1.status, 200);

    const up2 = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(batchA.batchId)}&fileName=${encodeURIComponent("洋钱罐风险预估.pdf")}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${batchA.dropSessionToken}` },
        body: Buffer.from("pdf-bytes-2"),
      },
    );
    assert.equal(up2.status, 200);
    const up2Data = (await up2.json()) as { fileCount: number };
    assert.equal(up2Data.fileCount, 2);

    // 绑定模拟归档 Worker
    bindIngestBatchWorker(async () => ({
      status: "completed",
      statusMessage: "已完成归档",
    }));

    // 8. 调用 commit 提交批次 A
    const commitRes = await fetch(`${baseUrl}/p/default/drop/api/commit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${batchA.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        batchId: batchA.batchId,
        note: "11月最新两份核心报表",
      }),
    });
    assert.equal(commitRes.status, 200);

    const wsRef = host.resolveWorkspace("Fintopia集团")!;
    await drainWorkspaceIngestQueue(host, wsRef.workspaceId);

    // 9. 凭批次 A 的 X-Drop-Receipt 请求头查询批次 A 状态 -> 200 completed
    const statusRes = await fetch(
      `${baseUrl}/p/default/drop/api/status?batchId=${encodeURIComponent(batchA.batchId)}`,
      {
        headers: { "x-drop-receipt": batchA.receiptToken },
      },
    );
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as {
      ok: boolean;
      status: { status: string; fileCount: number };
    };
    assert.equal(statusData.status.status, "completed");
    assert.equal(statusData.status.fileCount, 2);

    // 10. 拿批次 B 的真实 receiptToken 去查批次 A 的状态 -> 404 拒绝（A 批次与 B 批次严格隔离）
    const crossStatusRes = await fetch(
      `${baseUrl}/p/default/drop/api/status?batchId=${encodeURIComponent(batchA.batchId)}`,
      {
        headers: { "x-drop-receipt": batchB.receiptToken },
      },
    );
    assert.equal(crossStatusRes.status, 404);

    // 11. 吊销口令后，批次 B 尚未使用的 sessionToken 立即失效（返回 401）
    revokeDropToken(host, "Fintopia集团 投递码");
    const revokedUploadRes = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(batchB.batchId)}&fileName=after-revoke.pdf`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${batchB.dropSessionToken}` },
        body: Buffer.from("should-fail"),
      },
    );
    assert.equal(revokedUploadRes.status, 401);
  });

  test("单步 Webhook API (/p/default/drop/api/webhook) 与本地热文件夹同步：支持二进制流直传、JSON 多文件/邮件拆解及安全清理", async () => {
    const { baseUrl, host, wsPath, base } = await makeHttpTestEnv({ maxFileBytes: 4096 });

    bindIngestBatchWorker(async () => ({
      status: "completed",
      statusMessage: "已完成自动归档",
    }));

    // 1. 携带 Origin 头的浏览器跨域请求被 403 拒绝
    const browserWebhook = await fetch(`${baseUrl}/p/default/drop/api/webhook?fileName=a.csv`, {
      method: "POST",
      headers: {
        authorization: "Bearer fintopia-2026",
        origin: "https://evil.example",
      },
      body: "a,b\n1,2\n",
    });
    assert.equal(browserWebhook.status, 403);

    // 2. 错误口令返回 401
    const badPassRes = await fetch(`${baseUrl}/p/default/drop/api/webhook?fileName=a.csv`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-pass" },
      body: "a,b\n1,2\n",
    });
    assert.equal(badPassRes.status, 401);

    // 3. 模式 A：二进制流单步上传并入队（含 % 字符文件名验证不会二次 decodeURIComponent 破坏），立即可通过 receiptToken 查状态
    const streamRes = await fetch(
      `${baseUrl}/p/default/drop/api/webhook?fileName=${encodeURIComponent("每日资金日报_收益率15%30分析.csv")}&submitterName=${encodeURIComponent("BI每日跑批")}&note=${encodeURIComponent("自动推送%20正常")}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer fintopia-2026",
          "content-type": "text/csv",
        },
        body: "主体,余额\n三农信,12000\n",
      },
    );
    assert.equal(streamRes.status, 200);
    const streamJson = (await streamRes.json()) as {
      ok: boolean;
      batchId: string;
      receiptToken: string;
      fileCount: number;
      storedName: string;
    };
    assert.equal(streamJson.ok, true);
    assert.equal(streamJson.fileCount, 1);
    assert.equal(streamJson.storedName, "每日资金日报_收益率15%30分析.csv");

    const wsRef = host.resolveWorkspace("Fintopia集团")!;
    await drainWorkspaceIngestQueue(host, wsRef.workspaceId);

    const statusRes = await fetch(
      `${baseUrl}/p/default/drop/api/status?batchId=${encodeURIComponent(streamJson.batchId)}`,
      { headers: { "x-drop-receipt": streamJson.receiptToken } },
    );
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { status: { status: string } };
    assert.equal(statusJson.status.status, "completed");

    // 4. 模式 B：JSON 载荷一次提交邮件正文 (.md) + Base64 附件 (.xlsx)
    const jsonWebhookRes = await fetch(`${baseUrl}/p/default/drop/api/webhook`, {
      method: "POST",
      headers: {
        "x-drop-passcode": "fintopia-2026",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        submitterName: "邮件转发网关",
        note: "来自财务部的每日资金日报邮件",
        files: [
          {
            fileName: "邮件正文_1108资金简报.md",
            content: "# 11月8日资金简报\n\n今日资金回流正常。",
            encoding: "utf8",
          },
          {
            fileName: "附件_资金明细表.xlsx",
            content: Buffer.from("mock-xlsx-binary-content").toString("base64"),
            encoding: "base64",
          },
        ],
      }),
    });
    assert.equal(jsonWebhookRes.status, 200);
    const jsonWebhookData = (await jsonWebhookRes.json()) as {
      ok: boolean;
      batchId: string;
      fileCount: number;
    };
    assert.equal(jsonWebhookData.ok, true);
    assert.equal(jsonWebhookData.fileCount, 2);
    await drainWorkspaceIngestQueue(host, wsRef.workspaceId);

    // 5. 超限流式上传失败时，自动清理未提交的 staging 批次目录（工作区 inbox 不留孤儿批次）
    const inboxRoot = join(wsPath, ".cursor-remote/uploads/inbox");
    const batchesBeforeOversized = readdirSync(inboxRoot);
    const oversizedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(3000));
        controller.enqueue(new Uint8Array(3000));
        controller.close();
      },
    });
    const oversizedInit: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: { authorization: "Bearer fintopia-2026" },
      body: oversizedStream,
      duplex: "half",
    };
    const oversizedWebhook = await fetch(`${baseUrl}/p/default/drop/api/webhook?fileName=too-big.pdf`, oversizedInit);
    assert.equal(oversizedWebhook.status, 413);
    assert.deepEqual(
      readdirSync(inboxRoot),
      batchesBeforeOversized,
      "失败的单步 Webhook 不得在 inbox 中残留孤儿批次目录",
    );

    // 6. 本地热文件夹同步脚本 scanWatchFolderOnce 端到端测试（自动上传、去重、单文件报错隔离并移入 .archived / .failed）
    assert.throws(() => normalizeWebhookUrl("http://remote.example.com/p/default/drop/api/webhook"), /必须使用 https/);

    const watchDir = join(base, "watch-folder");
    mkdirSync(watchDir, { recursive: true });
    writeFileSync(join(watchDir, "01_超限报错文件.pdf"), Buffer.alloc(5000, 0x41));
    writeFileSync(join(watchDir, "02_本地保存的尽调报告.md"), "# 尽调报告\n核心指标良好", "utf8");
    writeFileSync(join(watchDir, "正在下载的临时文件.xlsx.part"), "partial", "utf8");

    const synced1 = await scanWatchFolderOnce({
      watchDir,
      webhookUrl: `${baseUrl}/p/default/drop`,
      passcode: "fintopia-2026",
      submitter: "Mac热文件夹",
      settleMs: 0,
      maxBytes: 4096,
    });
    // 排序在前的 01_超限报错文件.pdf 被隔离进 .failed，不会卡死后面的 02_本地保存的尽调报告.md
    assert.equal(synced1.failed.length, 1);
    assert.equal(synced1.failed[0].fileName, "01_超限报错文件.pdf");
    assert.equal(existsSync(join(watchDir, "01_超限报错文件.pdf")), false);
    assert.equal(Boolean(synced1.failed[0].failedPath && existsSync(synced1.failed[0].failedPath)), true);

    assert.equal(synced1.uploaded.length, 1);
    assert.equal(synced1.uploaded[0].fileName, "02_本地保存的尽调报告.md");
    assert.equal(existsSync(join(watchDir, "02_本地保存的尽调报告.md")), false);
    assert.equal(existsSync(synced1.uploaded[0].archivedPath), true);
    // .part 临时文件不会被误上传
    assert.equal(existsSync(join(watchDir, "正在下载的临时文件.xlsx.part")), true);

    // 再次放入相同内容文件，验证 SHA-256 账本去重直接移入 .archived
    writeFileSync(join(watchDir, "03_重复内容的尽调报告.md"), "# 尽调报告\n核心指标良好", "utf8");
    const synced2 = await scanWatchFolderOnce({
      watchDir,
      webhookUrl: `${baseUrl}/p/default/drop`,
      passcode: "fintopia-2026",
      submitter: "Mac热文件夹",
      settleMs: 0,
      maxBytes: 4096,
    });
    assert.equal(synced2.uploaded.length, 0);
    assert.deepEqual(synced2.duplicates, ["03_重复内容的尽调报告.md"]);
    assert.equal(existsSync(join(watchDir, "03_重复内容的尽调报告.md")), false);
  });

  test("记住上次登录状态（HttpOnly Cookie 预加载免登直入）+ 多知识库在线切换并自动清理旧未提交 batch", async () => {
    const { baseUrl, host, workspaceRoot, wsPath } = await makeHttpTestEnv();

    // 再初始化第二个知识库 sannongxin，并把它绑定到同一张口令上
    const sannongPath = join(workspaceRoot, "sannongxin");
    mkdirSync(sannongPath, { recursive: true });
    initKbWorkspaceConfig(sannongPath, {
      title: "三农鑫知识库",
      allowedCategories: ["资产", "客诉"],
    });
    const agentFile = readWorkspaceAgentFile({
      id: "default",
      stateDir: host.stateDir,
      workspaceRoot,
    } as Tenant);
    if (agentFile.items["sannongxin"]) {
      agentFile.items["sannongxin"].mainChatId = "chat-sannong";
    }
    writeFileSync(join(host.stateDir, "workspace-agent-chats.json"), JSON.stringify(agentFile), "utf8");

    const tokens = listDropTokens(host);
    assert.equal(tokens.length, 1);
    updateDropToken(host, {
      tokenId: tokens[0]!.id,
      addWorkspaces: ["sannongxin"],
    });

    // 1. 首次调用 /api/auth 登录，验证返回 Set-Cookie 且包含 2 个 authorizedWorkspaces
    const authRes = await fetch(`${baseUrl}/p/default/drop/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "fintopia-2026", submitterName: "王明-跨库" }),
    });
    assert.equal(authRes.status, 200);
    const setCookie = authRes.headers.get("set-cookie") || "";
    assert.equal(setCookie.includes("jiebo_drop_sess_default=ds_"), true);
    assert.equal(setCookie.includes("HttpOnly"), true);
    const cookiePair = setCookie.split(";")[0]!;

    const authJson = (await authRes.json()) as {
      dropSessionToken: string;
      batchId: string;
      authorizedWorkspaces: Array<{ workspaceKey: string }>;
    };
    assert.equal(authJson.authorizedWorkspaces.length, 2);

    // 2. 先在 Fintopia集团 上传一个文件但【不】点 commit（产生未提交 staging 批次）
    const upRes = await fetch(
      `${baseUrl}/p/default/drop/api/upload?batchId=${encodeURIComponent(authJson.batchId)}&fileName=temp.pdf`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${authJson.dropSessionToken}` },
        body: Buffer.from("staged-before-switch"),
      },
    );
    assert.equal(upRes.status, 200);
    const oldBatchDir = join(wsPath, ".cursor-remote/uploads/inbox", authJson.batchId);
    assert.equal(existsSync(oldBatchDir), true);

    // 3. 调用 /api/switch-workspace 切换到 sannongxin，验证旧未提交 batch 目录被自动清理，且返回新工作区信息
    const switchRes = await fetch(`${baseUrl}/p/default/drop/api/switch-workspace`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authJson.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspace: "sannongxin" }),
    });
    assert.equal(switchRes.status, 200);
    const switchJson = (await switchRes.json()) as {
      ok: boolean;
      workspaceKey: string;
      workspaceTitle: string;
      batchId: string;
    };
    assert.equal(switchJson.ok, true);
    assert.equal(switchJson.workspaceKey, "sannongxin");
    assert.equal(switchJson.workspaceTitle, "三农鑫知识库");
    assert.equal(existsSync(oldBatchDir), false, "切库时未提交的旧工作区暂存批次应自动清理防串库");

    // 4. 模拟网关重启清空内存，同事再次打开 GET /p/default/drop（带上次的 Cookie）-> 页面直接内嵌 PRELOADED_SESSION 免登进入
    resetDropAuthMemoryStateForTest();
    const revisitRes = await fetch(`${baseUrl}/p/default/drop`, {
      headers: { cookie: cookiePair },
    });
    assert.equal(revisitRes.status, 200);
    const revisitHtml = await revisitRes.text();
    assert.equal(revisitHtml.includes(`"submitterName":"王明-跨库"`), true);
    assert.equal(revisitHtml.includes(`"workspaceKey":"sannongxin"`), true);

    // 5. 点击退出登录 /api/logout -> 清除 Cookie 与持久化会话，再次访问恢复为未登录状态
    const logoutRes = await fetch(`${baseUrl}/p/default/drop/api/logout`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authJson.dropSessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(logoutRes.status, 200);
    assert.equal((logoutRes.headers.get("set-cookie") || "").includes("Max-Age=0"), true);

    const afterLogoutRes = await fetch(`${baseUrl}/p/default/drop`, {
      headers: { cookie: cookiePair },
    });
    const afterLogoutHtml = await afterLogoutRes.text();
    assert.equal(afterLogoutHtml.includes("const PRELOADED_SESSION = null;"), true);
  });
});
