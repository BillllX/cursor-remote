import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assistantToolSpecs } from "../src/assistant/tools.ts";
import { isMutatingTool, summarizeToolArgs } from "../src/chat/tools.ts";
import { getKbWorkspaceStatusForUi } from "../src/ingest/hub.ts";
import { appendWorkspaceIngestLog } from "../src/ingest/notify.ts";
import { listIngestQueue } from "../src/ingest/queue.ts";
import { setupKbWorkspaceForTenant, type DropTenantHost } from "../src/ingest/tokens.ts";
import {
  addOrUpdateWecomWatchItem,
  checkAndOptionallySyncWecomItems,
  getWecomAuthStatus,
  ingestWecomMailToKb,
  isValidWecomResourceId,
  listWecomWatchItems,
  readSafeDownloadedFileSync,
  removeWecomWatchItem,
  rollbackWecomWatchLedgerOnBatchFailed,
  sanitizeWecomCliPayload,
  searchWecomResources,
  setWecomCliRunnerForTest,
  WECOM_SYNC_MAX_FILES_PER_BATCH,
} from "../src/ingest/wecomSource.ts";

function makeTestEnv(): {
  dir: string;
  stateDir: string;
  workspaceRoot: string;
  wsPath: string;
  host: DropTenantHost;
} {
  const dir = join(tmpdir(), `wecom-source-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(dir, "state");
  const workspaceRoot = join(dir, "workspaces");
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsPath, { recursive: true });

  const host: DropTenantHost = {
    id: "default",
    stateDir,
    workspaceRoot,
    resolveWorkspace: (keyOrId: string) => {
      if (keyOrId === "Fintopia集团" || keyOrId === "wsa_fintopia") {
        return { workspaceId: "wsa_fintopia", key: "Fintopia集团", path: wsPath };
      }
      return null;
    },
  };
  setupKbWorkspaceForTenant(host, {
    workspace: "Fintopia集团",
    title: "Fintopia集团知识库",
    categories: ["资产", "资金", "风险"],
  });
  return { dir, stateDir, workspaceRoot, wsPath, host };
}

describe("企业微信 (WeCom CLI) 关注文件变动巡检、按需同步与邮件入库 (wecomSource.ts)", () => {
  test("sanitizeWecomCliPayload 递归剥离 extra_identity_context 与 security_notice（含字符串标签剥离）", () => {
    const raw = {
      security_notice: "<security_notice>...</security_notice>",
      extra_identity_context: "<extra_identity_context>...</extra_identity_context>",
      rawText: "<security_notice>warn</security_notice>正文内容<extra_identity_context>secret</extra_identity_context>",
      files: [
        {
          id: "f1",
          file_name: "保证金跟进",
          extra_identity_context: "nested",
        },
      ],
    };
    const cleaned = sanitizeWecomCliPayload(raw);
    assert.equal("security_notice" in cleaned, false);
    assert.equal("extra_identity_context" in cleaned, false);
    assert.equal("extra_identity_context" in cleaned.files[0], false);
    assert.equal(cleaned.files[0].file_name, "保证金跟进");
    assert.equal(cleaned.rawText, "正文内容");
  });

  test("安全边界：拦截前导 - 参数注入、越界 file_path 读取与微盘扩展名伪造", async () => {
    const { dir, host } = makeTestEnv();
    try {
      assert.equal(isValidWecomResourceId("--output-dir=/tmp"), false);
      assert.equal(isValidWecomResourceId("-h"), false);
      assert.equal(isValidWecomResourceId("e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y"), true);

      // 拒绝以 - 开头的 docId / fileId / mailId
      const badAdd = addOrUpdateWecomWatchItem(host, {
        workspace: "Fintopia集团",
        title: "恶意参数",
        sourceType: "sheet",
        docId: "--help",
      });
      assert.equal(badAdd.ok, false);

      const badMailSearch = await searchWecomResources(host, {
        scope: "mail_get",
        mailId: "--help",
      });
      assert.equal(badMailSearch.ok, false);

      // 验证 readSafeDownloadedFileSync 拦截越界路径
      const subTemp = join(dir, "dl-temp");
      const outsideFile = join(dir, "outside-secret.txt");
      mkdirSync(subTemp, { recursive: true });
      writeFileSync(outsideFile, "top-secret", "utf8");

      const escapeRead = readSafeDownloadedFileSync(subTemp, outsideFile, 1024 * 1024);
      assert.equal(escapeRead.ok, false);
      assert.equal(escapeRead.error.includes("拒绝读取受控下载目录之外"), true);

      // 验证 disk_file 下载时：即使标题伪装为 .pdf，但实际下载文件为 .sh 时，保留真实 .sh 扩展名并在入库阶段被白名单拦截
      setWecomCliRunnerForTest(async (args, opts) => {
        if (args[0] === "disk" && args[1] === "files" && args[2] === "download" && opts?.outputDir) {
          const f = join(opts.outputDir, "payload.sh");
          writeFileSync(f, "#!/bin/sh\necho pwn\n", "utf8");
          return { ok: true, exitCode: 0, stdout: "{}", stderr: "", parsed: { file_path: f } };
        }
        return { ok: true, exitCode: 0, stdout: "{}", stderr: "", parsed: {} };
      });

      const spoofAdd = addOrUpdateWecomWatchItem(host, {
        workspace: "Fintopia集团",
        title: "伪装报表.pdf",
        sourceType: "disk_file",
        fileId: "fi_spoof_123",
      });
      assert.equal(spoofAdd.ok, true);

      const spoofSync = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        idOrTitle: "伪装报表.pdf",
        syncIfChanged: true,
      });
      assert.equal(spoofSync.ok, true);
      assert.equal(spoofSync.syncedCount, 0);
      assert.equal(spoofSync.results[0].synced, false);
      assert.equal(Boolean(spoofSync.results[0].syncError), true);
    } finally {
      setWecomCliRunnerForTest(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("管理关注文件账本 (add / list / remove / 坐标修改重置基线) + 两段式变动检查 (check -> sync -> 幂等防重)", async () => {
    const { dir, host, wsPath } = makeTestEnv();
    let sheetCsvContent = "分类,资方,截止目前保证金\n已结束,青岛银行,26229578\n";
    let remoteModifyTime = "2026-11-09 15:52:20";

    setWecomCliRunnerForTest(async (args, opts) => {
      if (args[0] === "auth" && args[1] === "show") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "Status: authorized\nBot ID: aibUhZ7MzjX3iYylIc6YFi1-ybZ1zg15s2E",
          stderr: "",
        };
      }
      if (args[0] === "doc" && args[1] === "search") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          parsed: {
            docs: [
              {
                docid: "e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y",
                doc_name: "保证金跟进",
                modify_time: remoteModifyTime,
              },
            ],
          },
        };
      }
      if (args[0] === "sheet" && args[1] === "cells" && args[2] === "get") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          parsed: {
            csv_data: sheetCsvContent,
            actual_range: "A1:C2",
            errcode: 0,
          },
        };
      }
      if (args[0] === "mail" && args[1] === "get") {
        return {
          ok: true,
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          parsed: {
            mail_list: [
              {
                subject: "11月9日三农信资金回流日报",
                sender: { name: "财务部", email: "finance@fintopia.tech" },
                content: "今日三农信回流正常，累计保证金余额 2,622 万。",
                attachments: [
                  {
                    name: "20261109_回流明细.csv",
                    media_id: "med_123",
                    size: 128,
                  },
                  {
                    name: "恶意脚本.sh",
                    media_id: "med_bad",
                    size: 64,
                  },
                ],
              },
            ],
          },
        };
      }
      if (args[0] === "media" && args[1] === "download") {
        if (opts?.outputDir) {
          const outFile = join(opts.outputDir, "20261109_回流明细.csv");
          writeFileSync(outFile, "日期,金额\n2026-11-09,12000000\n", "utf8");
          return {
            ok: true,
            exitCode: 0,
            stdout: "{}",
            stderr: "",
            parsed: { file_path: outFile },
          };
        }
      }
      return { ok: true, exitCode: 0, stdout: "{}", stderr: "", parsed: {} };
    });

    try {
      const auth = await getWecomAuthStatus(host);
      assert.equal(auth.authorized, true);
      assert.equal(auth.botId, "aibUhZ7MzjX3iYylIc6YFi1-ybZ1zg15s2E");

      // 1. 绑定关注文件《保证金跟进》
      const added = addOrUpdateWecomWatchItem(host, {
        workspace: "Fintopia集团",
        title: "保证金跟进",
        sourceType: "sheet",
        docId: "e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y",
        note: "商务部每日保证金跟进在线表",
      });
      assert.equal(added.ok, true);
      if (!added.ok) return;
      assert.equal(added.created, true);

      // 2. 首次只读检查 (syncIfChanged: false)：检测到首次基线变动，但绝不自动入库
      const check1 = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: false,
      });
      assert.equal(check1.ok, true);
      assert.equal(check1.checkedCount, 1);
      assert.equal(check1.changedCount, 1);
      assert.equal(check1.syncedCount, 0);
      assert.equal(check1.results[0].hasChanged, true);
      assert.equal(check1.results[0].firstCheck, true);
      assert.equal(listIngestQueue(host).length, 0);

      // 3. 用户确认同步 (syncIfChanged: true)：此时正式推入归档队列，并记录 lastSyncedSha256
      const sync1 = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: true,
      });
      assert.equal(sync1.ok, true);
      assert.equal(sync1.syncedCount, 1);
      assert.equal(Boolean(sync1.results[0].batchId), true);
      assert.equal(listIngestQueue(host).length, 1);

      // 4. 远端表格未修改时再次调用 syncIfChanged: true -> hasChanged 为 false，不重复产生归档批次
      const sync2 = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: true,
      });
      assert.equal(sync2.ok, true);
      assert.equal(sync2.changedCount, 0);
      assert.equal(sync2.syncedCount, 0);
      assert.equal(listIngestQueue(host).length, 1);

      // 5. 同事在企微在线表格里新增了一行数据 -> 先 check 发现变动并给出新增行预览，再 sync 入库
      sheetCsvContent = "分类,资方,截止目前保证金\n已结束,青岛银行,26229578\n已结束,亿联银行,2682321\n";
      remoteModifyTime = "2026-11-09 17:10:00";

      const checkAfterEdit = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: false,
      });
      assert.equal(checkAfterEdit.changedCount, 1);
      assert.equal(checkAfterEdit.results[0].diffHint?.includes("亿联银行"), true);
      assert.equal(listIngestQueue(host).length, 1);

      const syncAfterEdit = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: true,
      });
      assert.equal(syncAfterEdit.syncedCount, 1);
      assert.equal(listIngestQueue(host).length, 2);

      // 6. 修改该关注项的 range 坐标，并支持直接传带 ?tab=xxx 的企微表格 URL 自动提取 docId 与 sheet
      const updatedCoords = addOrUpdateWecomWatchItem(host, {
        workspace: "Fintopia集团",
        title: "保证金跟进",
        sourceType: "sheet",
        docId:
          "https://doc.weixin.qq.com/sheet/e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y?scode=ANYA2wedAAYM8l03IKAYIABgY8AF0&tab=z4j6dz",
        range: "A1:C10",
      });
      assert.equal(updatedCoords.ok, true);
      if (updatedCoords.ok) {
        assert.equal(updatedCoords.created, false);
        assert.equal(updatedCoords.item.docId, "e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y");
        assert.equal(updatedCoords.item.sheet, "z4j6dz");
        assert.equal(updatedCoords.item.lastSyncedSha256, undefined);
      }

      // 7. 测试企业微信邮件（含正文 + media_id 附件 + 拦截非法后缀 .sh）归档入库
      const mailRes = await ingestWecomMailToKb(host, {
        workspace: "Fintopia集团",
        mailId: "CiCHen8Gxq5NtbFG5aHChFqh68XhVcyt907kNvUwXrpNshAB",
      });
      assert.equal(mailRes.ok, true);
      assert.equal(mailRes.fileCount, 2); // 邮件正文.md + 20261109_回流明细.csv
      assert.equal(mailRes.skippedAttachments?.length, 1);
      assert.equal(mailRes.skippedAttachments?.[0].includes("恶意脚本.sh"), true);
      assert.equal(listIngestQueue(host).length, 3);

      // 8. 验证 getKbWorkspaceStatusForUi 聚合返回关注文件状态（wecomWatchItems）与工作区更新记录（ingestLogs）
      appendWorkspaceIngestLog(wsPath, {
        batchId: "b_test_log_1",
        timestamp: 1794280000000,
        status: "completed",
        submitterName: "企业微信同步",
        note: "企业微信《保证金跟进》增量同步",
        movedFiles: [
          {
            from: ".cursor-remote/uploads/inbox/b_test_log_1/保证金跟进.csv",
            to: "资金/洋钱罐/保证金跟进.csv",
            category: "资金",
          },
        ],
        updatedHtmls: ["资金/资金.html"],
        summary: "已同步更新青岛银行、富民银行保证金退保进度。",
      });
      await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: false,
      });
      const uiStatus = getKbWorkspaceStatusForUi(host, "Fintopia集团");
      assert.equal(uiStatus.ok, true);
      if (uiStatus.ok) {
        assert.equal(uiStatus.data.wecomWatchItems?.length, 1);
        assert.equal(uiStatus.data.wecomWatchItems?.[0]?.title, "保证金跟进");
        assert.equal(uiStatus.data.wecomWatchItems?.[0]?.lastCheckHasChanged, true);
        assert.equal(Boolean(uiStatus.data.wecomWatchItems?.[0]?.lastCheckSummary?.includes("在线表格")), true);
        assert.equal((uiStatus.data.ingestLogs?.length ?? 0) >= 2, true);
        const completedLog = uiStatus.data.ingestLogs?.find((l) => l.batchId === "b_test_log_1");
        assert.equal(completedLog?.submitterName, "企业微信同步");
        assert.equal(completedLog?.summary.includes("青岛银行"), true);
        assert.deepEqual(completedLog?.updatedHtmls, ["资金/资金.html"]);
      }

      // 9. 移除关注项
      const rmRes = removeWecomWatchItem(host, added.item.id, "Fintopia集团");
      assert.equal(rmRes.ok, true);
      const afterRm = listWecomWatchItems(host, { workspace: "Fintopia集团" });
      assert.equal(afterRm.ok && afterRm.items.length === 0, true);
    } finally {
      setWecomCliRunnerForTest(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("工具权限分类与 summarizeToolArgs 参数保留", () => {
    const { dir, host } = makeTestEnv();
    try {
      const specs = assistantToolSpecs({
        ref: { id: "default", stateDir: host.stateDir },
        role: "chat",
        wecomSearch: (args) => searchWecomResources(host, args),
        wecomWatchCheck: (args) => checkAndOptionallySyncWecomItems(host, { ...args, syncIfChanged: false }),
        wecomWatchSync: (args) => checkAndOptionallySyncWecomItems(host, { ...args, syncIfChanged: true }),
        wecomWatchManage: () => ({ ok: true }),
      });

      const searchSpec = specs.find((s) => s.name === "wecom_search");
      const checkSpec = specs.find((s) => s.name === "wecom_watch_check");
      const syncSpec = specs.find((s) => s.name === "wecom_watch_sync");
      const manageSpec = specs.find((s) => s.name === "wecom_watch_manage");

      assert.equal(searchSpec?.category, "network");
      assert.equal(checkSpec?.category, "network");
      assert.equal(syncSpec?.category, "write");
      assert.equal(manageSpec?.category, "write");

      assert.equal(isMutatingTool("wecom_search", {}), false);
      assert.equal(isMutatingTool("wecom_watch_check", {}), false);
      assert.equal(isMutatingTool("wecom_watch_sync", {}), true);
      assert.equal(isMutatingTool("wecom_watch_manage", { action: "list" }), false);
      assert.equal(isMutatingTool("wecom_watch_manage", { action: "auth_status" }), false);
      assert.equal(isMutatingTool("wecom_watch_manage", { action: "add" }), true);
      assert.equal(isMutatingTool("wecom_watch_manage", { action: "remove" }), true);

      const summarized = summarizeToolArgs({
        workspace: "Fintopia集团",
        action: "add",
        title: "保证金跟进",
        sourceType: "sheet",
        docId: "e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y",
      }) as Record<string, unknown>;
      assert.equal(summarized.action, "add");
      assert.equal(summarized.sourceType, "sheet");
      assert.equal(summarized.docId, "e3_AYIABgY8AF0CNssDQp48cSWi9Ne2Y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("多关注项同步按工作区分组合并提交（每批最多 10 个文件）与后台归档失败回滚", async () => {
    const { dir, host } = makeTestEnv();
    setWecomCliRunnerForTest(async (args) => {
      if (args[0] === "sheet" && args[1] === "cells" && args[2] === "get") {
        const req = JSON.parse(args[4] || "{}") as { sheet?: string };
        return {
          ok: true,
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          parsed: {
            csv_data: `子表,状态\n${req.sheet || "default"},已更新\n`,
            actual_range: "A1:B2",
            errcode: 0,
          },
        };
      }
      return { ok: true, exitCode: 0, stdout: "{}", stderr: "", parsed: {} };
    });

    try {
      assert.equal(WECOM_SYNC_MAX_FILES_PER_BATCH, 10);
      // 连续注册 12 张子表
      for (let i = 1; i <= 12; i++) {
        const added = addOrUpdateWecomWatchItem(host, {
          workspace: "Fintopia集团",
          title: `三农信投诉台账-子表${i}`,
          sourceType: "sheet",
          docId: "e3_AQgAWAYPAOMCN2i2wXwCNQfumOxtv",
          sheet: `tab_${i}`,
          note: `三农信子表${i}`,
        });
        assert.equal(added.ok, true);
      }

      const syncRes = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: true,
      });
      assert.equal(syncRes.ok, true);
      assert.equal(syncRes.checkedCount, 12);
      assert.equal(syncRes.changedCount, 12);
      assert.equal(syncRes.syncedCount, 12);

      // 12 个文件按每批最多 10 个文件合并为 2 个归档批次（10 + 2），避免产生 12 个独立批次风暴
      const queueItems = listIngestQueue(host);
      assert.equal(queueItems.length, 2);
      assert.equal(queueItems[0].note.includes("企业微信关注表合并同步（共 10 份"), true);
      assert.equal(queueItems[1].note.includes("企业微信关注表合并同步（共 2 份"), true);

      const distinctBatchIds = new Set(syncRes.results.map((r) => r.batchId));
      assert.equal(distinctBatchIds.size, 2);

      // 模拟第 2 个批次（2 个关注项）在后台归档执行时失败，验证回滚后可重新触发同步
      const failedBatchId = queueItems[1].batchId;
      const rolled = rollbackWecomWatchLedgerOnBatchFailed(host, failedBatchId, "Sandboxing not supported");
      assert.equal(rolled, 2);

      const listedAfterRollback = listWecomWatchItems(host, { workspace: "Fintopia集团" });
      assert.equal(listedAfterRollback.ok, true);
      if (listedAfterRollback.ok) {
        const rolledItems = listedAfterRollback.items.filter((x) => x.lastBatchId === failedBatchId);
        assert.equal(rolledItems.length, 2);
        for (const ri of rolledItems) {
          assert.equal(ri.lastSyncedSha256, undefined);
          assert.equal(ri.lastCheckHasChanged, true);
          assert.equal(Boolean(ri.lastCheckError?.includes("Sandboxing not supported")), true);
        }
      }

      // 再次调用 syncIfChanged: true 时，仅刚才失败回滚的 2 个关注项会被重新合并入队
      const resync = await checkAndOptionallySyncWecomItems(host, {
        workspace: "Fintopia集团",
        syncIfChanged: true,
      });
      assert.equal(resync.ok, true);
      assert.equal(resync.changedCount, 2);
      assert.equal(resync.syncedCount, 2);
      assert.equal(listIngestQueue(host).length, 3);
    } finally {
      setWecomCliRunnerForTest(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
