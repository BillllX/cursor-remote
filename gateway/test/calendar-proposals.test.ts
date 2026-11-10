import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { buildIcs } from "../src/assistant/calendar.ts";
import {
  addCalendarEvent,
  checkCalendarConflicts,
  listCalendarEvents,
  queryColleagueFreeBusy,
  takeDueCalendarEventReminders,
  updateCalendarEvent,
} from "../src/assistant/calendarEvents.ts";
import { listInbox } from "../src/assistant/inbox.ts";
import {
  bindProposalOutboxDispatcher,
  createCalendarProposal,
  createKnowledgeUpdateProposal,
  decideColleagueProposal,
  listColleagueProposals,
  takePendingWechatReceiptsForPeer,
} from "../src/assistant/proposals.ts";
import { addTodo } from "../src/assistant/todos.ts";
import { initKbWorkspaceConfig } from "../src/ingest/contract.ts";
import { listIngestQueue } from "../src/ingest/queue.ts";
import {
  createDropToken,
  resetDropAuthMemoryStateForTest,
  type DropTenantHost,
  type DropWorkspaceRef,
} from "../src/ingest/tokens.ts";

const tempDirs: string[] = [];

function makeEnv() {
  const base = join(tmpdir(), `cal-proposals-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(base, "state");
  const workspaceRoot = join(base, "workspaces");
  const wsPath = join(workspaceRoot, "Fintopia集团");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(wsPath, { recursive: true });
  tempDirs.push(base);

  writeFileSync(join(wsPath, "归档说明.md"), "# 归档说明\n按资产、资金分类。\n", "utf8");
  initKbWorkspaceConfig(wsPath, {
    title: "Fintopia 集团知识库",
    allowedCategories: ["资产", "资金"],
  });

  const wsRef: DropWorkspaceRef = {
    workspaceId: "wsa_fintopia_test",
    key: "Fintopia集团",
    path: wsPath,
  };

  const host: DropTenantHost = {
    id: "default",
    stateDir,
    workspaceRoot,
    resolveWorkspace: (k) => (k === "Fintopia集团" || k === "wsa_fintopia_test" ? wsRef : null),
  };

  return { base, stateDir, workspaceRoot, wsPath, host };
}

afterEach(() => {
  bindProposalOutboxDispatcher(null);
  resetDropAuthMemoryStateForTest();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Step 2: 双轨日历引擎 (calendarEvents.ts + calendar.ts) 与提案授权状态机 (proposals.ts)", () => {
  test("双轨日历：时段事件 CRUD、冲突检查、单次提醒（不按年重复）、脱敏忙闲查询与 .ics 合并输出", () => {
    const { host } = makeEnv();
    const now = Date.parse("2026-11-12T08:00:00+08:00");

    // 1. 新增一条私密日程（14:00~15:00）与一条公开日程（16:00~17:00）
    const evPrivate = addCalendarEvent(
      host,
      {
        title: "私人牙医预约",
        startIso: "2026-11-12T14:00:00+08:00",
        endIso: "2026-11-12T15:00:00+08:00",
        location: "口腔医院",
        visibility: "private",
        remindMinutesBefore: 30,
      },
      now,
    );
    assert.equal(evPrivate.ok, true);

    const evPublic = addCalendarEvent(
      host,
      {
        title: "风控周例会",
        startIso: "2026-11-12T16:00:00+08:00",
        endIso: "2026-11-12T17:00:00+08:00",
        location: "302会议室",
        visibility: "public",
      },
      now,
    );
    assert.equal(evPublic.ok, true);

    // 2. 在重叠时段（14:30~15:30）默认拒绝创建并提示冲突
    const conflictAttempt = addCalendarEvent(
      host,
      {
        title: "重叠会议",
        startIso: "2026-11-12T14:30:00+08:00",
        endIso: "2026-11-12T15:30:00+08:00",
      },
      now,
    );
    assert.equal(conflictAttempt.ok, false);
    if (!conflictAttempt.ok) {
      assert.equal((conflictAttempt.conflicts?.length ?? 0) >= 1, true);
    }

    // 3. 同时加一条带提醒时刻的 Todo（10:00）
    addTodo(host, {
      text: "打款审批待办",
      due: "2026-11-12T10:00:00+08:00",
    });

    // 4. 同事调用脱敏忙闲查询（09:00~18:00）：私密日程与个人待办均脱敏为「忙碌」，公开日程显示「风控周例会」
    const fb = queryColleagueFreeBusy(host, {
      fromIso: "2026-11-12T09:00:00+08:00",
      toIso: "2026-11-12T18:00:00+08:00",
    });
    assert.equal(fb.ok, true);
    if (!fb.ok) return;
    assert.equal(fb.busySlots.length, 3);
    assert.equal(fb.busySlots[0]!.summary, "忙碌"); // 10:00 待办脱敏
    assert.equal(fb.busySlots[1]!.summary, "忙碌"); // 14:00 私人牙医脱敏
    assert.equal(fb.busySlots[1]!.location, undefined);
    assert.equal(fb.busySlots[2]!.summary, "风控周例会"); // 16:00 公开会议显示标题
    assert.equal(fb.busySlots[2]!.location, "302会议室");

    // 5. 验证单次提醒：在 13:35（距 14:00 提前 30 分钟以内）触发一次后标记 reminded=true，再次调用不再重复触发
    const due1 = takeDueCalendarEventReminders(host, Date.parse("2026-11-12T13:35:00+08:00"));
    assert.equal(due1.length, 1);
    assert.equal(due1[0]!.title, "私人牙医预约");
    const due2 = takeDueCalendarEventReminders(host, Date.parse("2026-11-12T13:40:00+08:00"));
    assert.equal(due2.length, 0, "提醒只响一次，不得重复触发");

    // 6. 验证 .ics 输出同时包含时段日程与待办，且绝不含 RRULE 按年重复
    const ics = buildIcs(host, "Bill", now);
    assert.equal(ics.includes("SUMMARY:私人牙医预约"), true);
    assert.equal(ics.includes("SUMMARY:风控周例会"), true);
    assert.equal(ics.includes("SUMMARY:打款审批待办"), true);
    assert.equal(ics.includes("RRULE"), false, ".ics 严禁包含按年重复规则");
  });

  test("提案授权闭环：同事提议约会 & 提议更新知识库（未批前 0 副作用）-> 主人一键批准 -> 写入日历/入队归档 + Outbox 回执投递与微信超时挂起补投", async () => {
    const { host } = makeEnv();
    const tok = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "wang-pass-2026",
      label: "王明",
    });
    assert.equal(tok.ok, true);
    if (!tok.ok) return;

    // 1. 王明在微信发起一条周四下午 15:00~16:00 的约会提案
    const calPropRes = createCalendarProposal(host, {
      tokenId: tok.record.id,
      proposerName: "王明",
      sourceChannel: "wechat",
      sourcePeerId: "o9cq809L_wang@im.wechat",
      title: "与王明过三农鑫风控方案",
      startIso: "2026-11-12T15:00:00+08:00",
      endIso: "2026-11-12T16:00:00+08:00",
      location: "腾讯会议",
    });
    assert.equal(calPropRes.ok, true);
    if (!calPropRes.ok) return;

    // 未批准前，日历事件表为空（零未授权写入）
    assert.equal(listCalendarEvents(host).length, 0);
    assert.equal(
      checkCalendarConflicts(host, Date.parse("2026-11-12T15:00:00+08:00"), Date.parse("2026-11-12T16:00:00+08:00"))
        .length,
      0,
    );

    // 主人收件箱已收到 approval 卡片
    const inbox = listInbox(host, 10);
    assert.equal(
      inbox.some((i) => i.key === `proposal:${calPropRes.proposal.id}` && i.kind === "approval"),
      true,
    );

    // 模拟微信此时处于超过 24 小时窗口（Outbox Dispatcher 返回 pending_wx_window）
    bindProposalOutboxDispatcher(async () => ({
      status: "pending_wx_window",
      error: "errcode=-14 session timeout (已挂起至待补投队列)",
    }));

    // 2. 主人批准该日历提案
    const decideCal = await decideColleagueProposal(host, {
      proposalId: calPropRes.proposal.id,
      approve: true,
      decisionNote: "准时参加",
    });
    assert.equal(decideCal.ok, true);
    if (!decideCal.ok) return;
    assert.equal(decideCal.proposal.status, "approved");
    assert.equal(Boolean(decideCal.proposal.appliedResult?.calendarEventId), true);
    assert.equal(decideCal.proposal.receiptOutbox[0]?.status, "pending_wx_window");

    // 批准后日历已正式写入该事件
    const eventsAfter = listCalendarEvents(host);
    assert.equal(eventsAfter.length, 1);
    assert.equal(eventsAfter[0]!.title, "与王明过三农鑫风控方案");

    // 3. 王明下次在微信发消息时，自动取出挂起的审批回执补投
    const pendingReceipts = takePendingWechatReceiptsForPeer(host, "o9cq809L_wang@im.wechat");
    assert.equal(pendingReceipts.length, 1);
    assert.equal(pendingReceipts[0]!.includes("主人已确认您的日程预约"), true);
    // 再取一次已为空（幂等不重发）
    assert.equal(takePendingWechatReceiptsForPeer(host, "o9cq809L_wang@im.wechat").length, 0);

    // 4. 王明在站内 IM 发起一条知识库更新提案
    const kbPropRes = createKnowledgeUpdateProposal(host, {
      tokenId: tok.record.id,
      proposerName: "王明",
      sourceChannel: "im_dm",
      sourcePeerId: "dm~default~wangming",
      workspaceKeyOrId: "Fintopia集团",
      summary: "补充11月最新撮合规模18.5亿",
      content: "# 11月最新撮合规模补充\n\n确认 11 月最新撮合规模为 18.5 亿元。\n",
    });
    assert.equal(kbPropRes.ok, true);
    if (!kbPropRes.ok) return;

    // 未批准前，归档队列为空
    assert.equal(listIngestQueue(host).length, 0);

    bindProposalOutboxDispatcher(async () => ({ status: "delivered" }));

    // 主人批准该知识库更新提案 -> 自动送入 submitDirectIngestBatch 归档队列且回执状态为 delivered
    const decideKb = await decideColleagueProposal(host, {
      proposalId: kbPropRes.proposal.id,
      approve: true,
    });
    assert.equal(decideKb.ok, true);
    if (!decideKb.ok) return;
    assert.equal(decideKb.proposal.status, "approved");
    assert.equal(decideKb.proposal.receiptOutbox[0]?.status, "delivered");
    assert.equal(listIngestQueue(host).length, 1);

    // 重复点击批准保持幂等，不会二次入队
    const decideKbAgain = await decideColleagueProposal(host, {
      proposalId: kbPropRes.proposal.id,
      approve: true,
    });
    assert.equal(decideKbAgain.ok, true);
    if (decideKbAgain.ok) assert.equal(decideKbAgain.idempotent, true);
    assert.equal(listIngestQueue(host).length, 1);

    // 5. 验证多日全天日程（2026-11-15 至 2026-11-17）在 .ics 中正确输出 DTSTART=20261115 与 DTEND=20261118（RFC 5545 exclusive end date）
    const multiDayRes = addCalendarEvent(host, {
      title: "年度战略闭门会",
      startIso: "2026-11-15",
      endIso: "2026-11-17",
      visibility: "public",
    });
    assert.equal(multiDayRes.ok, true);
    const icsMulti = buildIcs(host, "Bill", Date.parse("2026-11-12T08:00:00+08:00"));
    assert.equal(icsMulti.includes("DTSTART;VALUE=DATE:20261115"), true);
    assert.equal(icsMulti.includes("DTEND;VALUE=DATE:20261118"), true);
  });
});
