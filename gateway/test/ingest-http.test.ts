import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { initKbWorkspaceConfig } from "../src/ingest/contract.ts";
import { buildDropTenantHost } from "../src/ingest/http.ts";
import { bindIngestBatchWorker, drainWorkspaceIngestQueue } from "../src/ingest/queue.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  revokeDropToken,
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
    assert.equal(
      optRes.headers.get("access-control-allow-headers")?.includes("x-drop-page-ticket"),
      true,
    );

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
    assert.equal(remainingFiles.some((f) => f.endsWith(".part") || f.startsWith(".tmp-")), false);

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
});
