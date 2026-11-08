import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { BACKGROUND_MODEL } from "../src/assistant/background.ts";
import { addCalendarEvent, listCalendarEvents } from "../src/assistant/calendarEvents.ts";
import {
  bindProposalOutboxDispatcher,
  createCalendarProposal,
  decideColleagueProposal,
  flushPendingWechatReceiptsForPeer,
} from "../src/assistant/proposals.ts";
import { initKbWorkspaceConfig } from "../src/ingest/contract.ts";
import { buildDropTenantHost } from "../src/ingest/http.ts";
import { bindQaRunner, resetQaRunnerMemoryForTest } from "../src/ingest/qaRunner.ts";
import { resetQaStorageMemoryForTest } from "../src/ingest/qaStorage.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  updateDropToken,
} from "../src/ingest/tokens.ts";
import { loadTenants } from "../src/tenants.ts";
import { readWorkspaceAgentFile } from "../src/workspace/agents.ts";
import {
  bindImSystemReplySender,
  bindOpenClawCliExecutorForTest,
  detectActiveWechatAccount,
  dispatchProposalReceiptOutbox,
  extractDmAssistantQuestion,
  generateRandomWechatUin,
  handleColleagueDmMention,
  resetWxPushGuardMemoryForTest,
  sendProactiveWechatMessage,
} from "../src/wx/pushGuard.ts";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.CURSOR_REMOTE_STATE_DIR;
  delete process.env.CURSOR_REMOTE_TENANTS_FILE;
  bindProposalOutboxDispatcher(null);
  bindImSystemReplySender(null);
  bindOpenClawCliExecutorForTest(null);
  bindQaRunner(null);
  resetWxPushGuardMemoryForTest();
  resetDropAuthMemoryStateForTest();
  resetQaRunnerMemoryForTest();
  resetQaStorageMemoryForTest();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Step 3: 平台原生 IM (@小驳) 融合与 wechat-push-skill 主动推送守卫 (pushGuard.ts)", () => {
  test("wechat-push-skill 机制移植：context-tokens.json 动态选号、防假成功双条件校验、errcode=-14 一小时冷却保护", async () => {
    const base = join(tmpdir(), `wx-pushguard-test-${Date.now()}`);
    const accountsDir = join(base, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    tempDirs.push(base);

    // 构造两个 bot：botA 和 botB 都包含目标 openid，但 botB 的 sync.json 更新
    writeFileSync(
      join(accountsDir, "botA-im-bot.context-tokens.json"),
      JSON.stringify({ "o9cq_wang@im.wechat": "ctx_old" }),
      "utf8",
    );
    writeFileSync(join(accountsDir, "botA-im-bot.sync.json"), "{}", "utf8");

    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(
      join(accountsDir, "botB-im-bot.context-tokens.json"),
      JSON.stringify({ "o9cq_wang@im.wechat": "ctx_fresh" }),
      "utf8",
    );
    writeFileSync(join(accountsDir, "botB-im-bot.sync.json"), "{}", "utf8");

    // 1. 动态选出持有 context_token 且 sync.json 最新的 botB-im-bot
    const detected = detectActiveWechatAccount("o9cq_wang@im.wechat", accountsDir);
    assert.equal(detected, "botB-im-bot");

    // 2. X-WECHAT-UIN 每次生成不同的 base64(uint32)
    const uin1 = generateRandomWechatUin();
    const uin2 = generateRandomWechatUin();
    assert.equal(typeof uin1, "string");
    assert.equal(uin1.length > 0 && uin2.length > 0, true);

    // 3. 防假成功校验：exit 0 但 stdout 不含 "Sent via" 时，严禁判定为成功
    bindOpenClawCliExecutorForTest(async () => ({
      code: 0,
      stdout: "HTTP 200 OK {}",
      stderr: "",
    }));
    const falseSuccessRes = await sendProactiveWechatMessage({
      targetOpenId: "o9cq_wang@im.wechat",
      message: "测试假成功拦截",
      accountsDir,
    });
    assert.equal(falseSuccessRes.ok, false);
    if (!falseSuccessRes.ok) {
      assert.equal(falseSuccessRes.reason, "false_success_blocked");
    }

    // 4. 真成功：exit 0 且含 "Sent via"
    bindOpenClawCliExecutorForTest(async (args) => ({
      code: 0,
      stdout: `Sent via openclaw-weixin (${args.join(" ")})`,
      stderr: "",
    }));
    const trueSuccessRes = await sendProactiveWechatMessage({
      targetOpenId: "o9cq_wang@im.wechat",
      message: "测试真送达",
      accountsDir,
    });
    assert.equal(trueSuccessRes.ok, true);
    if (trueSuccessRes.ok) {
      assert.equal(trueSuccessRes.account, "botB-im-bot");
    }

    // 5. 触发 errcode=-14 session timeout 时，botB 进入 1 小时冷却，自动切换到备用活跃 botA！
    bindOpenClawCliExecutorForTest(async () => ({
      code: 1,
      stdout: `{"errcode":-14,"errmsg":"session timeout"}`,
      stderr: "",
    }));
    const expiredRes = await sendProactiveWechatMessage({
      targetOpenId: "o9cq_wang@im.wechat",
      message: "触发-14",
      accountsDir,
    });
    assert.equal(expiredRes.ok, false);
    if (!expiredRes.ok) {
      assert.equal(expiredRes.reason, "session_expired");
    }

    // 此时再次探测，botB 因处于冷却被跳过，自动选出备用 botA-im-bot
    const fallbackBot = detectActiveWechatAccount("o9cq_wang@im.wechat", accountsDir);
    assert.equal(fallbackBot, "botA-im-bot");
  });

  test("站内 1v1 IM 单聊呼叫 @小驳 查知识库/查忙闲/提提案 + 微信超 24h 自动转站内 IM 必达兜底与待补投队列", async () => {
    const base = join(tmpdir(), `im-wx-fusion-test-${Date.now()}`);
    const tenantsFile = join(base, "tenants.json");
    const defaultStateDir = join(base, "tenants", "default");
    const wangStateDir = join(base, "tenants", "wangming");
    const defaultWsRoot = join(defaultStateDir, "workspace");
    const wangWsRoot = join(wangStateDir, "workspace");
    const fintopiaPath = join(defaultWsRoot, "Fintopia集团");

    mkdirSync(defaultStateDir, { recursive: true });
    mkdirSync(wangStateDir, { recursive: true });
    mkdirSync(fintopiaPath, { recursive: true });
    mkdirSync(wangWsRoot, { recursive: true });
    tempDirs.push(base);

    writeFileSync(
      tenantsFile,
      JSON.stringify({
        tenants: [
          { id: "default", name: "BillXu", token: "tok_default" },
          { id: "wangming", name: "王明", token: "tok_wang" },
        ],
      }),
      "utf8",
    );
    process.env.CURSOR_REMOTE_STATE_DIR = base;
    process.env.CURSOR_REMOTE_TENANTS_FILE = tenantsFile;
    loadTenants();

    writeFileSync(join(fintopiaPath, "归档说明.md"), "# 归档说明\n一级分类：资产。\n", "utf8");
    initKbWorkspaceConfig(fintopiaPath, {
      title: "Fintopia 集团知识库",
      allowedCategories: ["资产"],
    });
    mkdirSync(join(fintopiaPath, "资产"), { recursive: true });
    writeFileSync(
      join(fintopiaPath, "资产", "资产.html"),
      "<!DOCTYPE html><html><body><h1>Fintopia资产看板</h1><p>洋钱罐11月在贷余额为 42.5 亿元。</p></body></html>",
      "utf8",
    );

    const agentFile = readWorkspaceAgentFile({
      id: "default",
      stateDir: defaultStateDir,
      workspaceRoot: defaultWsRoot,
    } as never);
    writeFileSync(join(defaultStateDir, "workspace-agent-chats.json"), JSON.stringify(agentFile), "utf8");

    const host = buildDropTenantHost({
      id: "default",
      stateDir: defaultStateDir,
      workspaceRoot: defaultWsRoot,
      name: "BillXu",
    });

    // 主人添加一条周四 14:00~15:00 的私密日程
    addCalendarEvent(host, {
      title: "内部董事会（私密）",
      startIso: "2026-11-12T14:00:00+08:00",
      endIso: "2026-11-12T15:00:00+08:00",
      visibility: "private",
    });

    // 给王明创建通行口令，同时绑定站内 IM 账号 wangming 与微信 openId
    const tokRes = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "wang-pass-2026",
      label: "王明（风控中心）",
      imTenantId: "wangming",
    });
    assert.equal(tokRes.ok, true);
    if (!tokRes.ok) return;

    updateDropToken(host, {
      tokenId: tokRes.record.id,
      wxBinding: {
        status: "active",
        openId: "o9cq_wang@im.wechat",
        updatedAt: Date.now(),
      },
    });

    const imReplies: Array<{ from: string; to: string; convId: string; text: string }> = [];
    bindImSystemReplySender(async (msg) => {
      imReplies.push({
        from: msg.fromTenantId,
        to: msg.toTenantId,
        convId: msg.convId,
        text: msg.text,
      });
    });

    // 绑定受控 QA Runner：在单聊问答中依次调用只读知识库读取、脱敏忙闲查询与发起日历预约提案
    bindQaRunner({
      apiKey: () => "test-key",
      listModels: async () => [BACKGROUND_MODEL],
      sandbox: () => true,
      prompt: async (_promptText, options) => {
        const custom = options.local?.customTools ?? {};
        const boardRaw = await custom.kb_qa_read_file.execute(
          { relPath: "资产/资产.html" },
          { toolCallId: "im_qa_1" },
        );
        const board = JSON.parse(String(boardRaw)) as { ok: boolean; content: string };
        assert.equal(board.ok, true);

        const fbRaw = await custom.colleague_calendar_freebusy.execute(
          { fromIso: "2026-11-12T13:00:00+08:00", toIso: "2026-11-12T18:00:00+08:00" },
          { toolCallId: "im_qa_2" },
        );
        const fb = JSON.parse(String(fbRaw)) as {
          ok: boolean;
          busySlots: Array<{ summary: string; startIso: string; endIso: string }>;
        };
        assert.equal(fb.ok, true);
        assert.equal(fb.busySlots[0]?.summary, "忙碌"); // 私密日程标题被隐去

        const propRaw = await custom.colleague_propose_calendar_change.execute(
          {
            title: "过洋钱罐11月风控模型",
            startIso: "2026-11-12T15:30:00+08:00",
            endIso: "2026-11-12T16:30:00+08:00",
          },
          { toolCallId: "im_qa_3" },
        );
        const prop = JSON.parse(String(propRaw)) as { ok: boolean; proposalId: string };
        assert.equal(prop.ok, true);

        return {
          id: "run_im_dm",
          status: "finished",
          result: `洋钱罐11月在贷余额为 42.5 亿元。主人周四 14:00-15:00 忙碌，已为您提议预约 15:30-16:30（提案号：${prop.proposalId}）。`,
          messages: [],
        };
      },
    });

    // 1. 普通聊天不带 @小驳 时不触发分身
    assert.equal(extractDmAssistantQuestion("你好，在吗？"), null);
    assert.equal(extractDmAssistantQuestion("@小驳 洋钱罐在贷余额是多少？周四下午能约会吗？"), "洋钱罐在贷余额是多少？周四下午能约会吗？");

    // 2. 王明在站内单聊向 default 发送 @小驳 提问
    const dmRes = await handleColleagueDmMention({
      ownerTenantId: "default",
      senderTenantId: "wangming",
      convId: "dm~default~wangming",
      messageSeq: 1,
      messageText: "@小驳 洋钱罐在贷余额是多少？周四下午能约会吗？",
    });
    assert.equal(dmRes.handled, true);
    assert.equal(imReplies.length, 1);
    assert.equal(imReplies[0]!.text.includes("42.5 亿元"), true);
    assert.equal(imReplies[0]!.text.includes("资产/资产.html"), true);

    // 3. 验证微信提案审批后：若微信已超 24h 窗口（返 errcode=-14），dispatchProposalReceiptOutbox 自动通过站内 IM 给王明发必达通知，并将微信回执挂入 pending_wx_window
    bindProposalOutboxDispatcher(dispatchProposalReceiptOutbox);
    bindOpenClawCliExecutorForTest(async () => ({
      code: 1,
      stdout: `{"errcode":-14,"errmsg":"session timeout"}`,
      stderr: "",
    }));

    const wxProp = createCalendarProposal(host, {
      tokenId: tokRes.record.id,
      proposerName: "王明",
      sourceChannel: "wechat",
      sourcePeerId: "o9cq_wang@im.wechat",
      title: "微信发起的周五复盘会",
      startIso: "2026-11-13T10:00:00+08:00",
      endIso: "2026-11-13T11:00:00+08:00",
    });
    assert.equal(wxProp.ok, true);
    if (!wxProp.ok) return;

    const decided = await decideColleagueProposal(host, {
      proposalId: wxProp.proposal.id,
      approve: true,
    });
    assert.equal(decided.ok, true);
    if (!decided.ok) return;

    // 微信因 -14 进入 pending_wx_window，但站内 IM 已自动收到兜底回执！
    assert.equal(decided.proposal.receiptOutbox[0]?.status, "pending_wx_window");
    assert.equal(
      imReplies.some((r) => r.to === "wangming" && r.text.includes("微信超时自动转站内IM") && r.text.includes("微信发起的周五复盘会")),
      true,
    );
    assert.equal(listCalendarEvents(host).length, 2);

    // 当王明稍后在微信说话恢复窗口时，flushPendingWechatReceiptsForPeer 真实投递成功后才标为 delivered
    const deliveredToWx: string[] = [];
    const flushed = await flushPendingWechatReceiptsForPeer(
      host,
      "o9cq_wang@im.wechat",
      async (msg) => {
        deliveredToWx.push(msg);
        return true;
      },
    );
    assert.equal(flushed.length, 1);
    assert.equal(deliveredToWx.length, 1);

    // 4. 关闭王明的 kbAsk 权限后，再次在站内单聊 @小驳 将被拦截
    updateDropToken(host, {
      tokenId: tokRes.record.id,
      permissions: { kbAsk: false },
    });
    const deniedRes = await handleColleagueDmMention({
      ownerTenantId: "default",
      senderTenantId: "wangming",
      convId: "dm~default~wangming",
      messageSeq: 2,
      messageText: "@小驳 再查下数据",
    });
    assert.equal(deniedRes.handled, true);
    assert.equal(deniedRes.answer?.includes("未开启知识库与助理问答权限"), true);
  });
});
