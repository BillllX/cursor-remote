import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getWorkspaceAutomationStatus } from "../src/ingest/hub.ts";
import { setupKbWorkspaceForTenant, type DropTenantHost } from "../src/ingest/tokens.ts";
import { setWecomCliRunnerForTest, addOrUpdateWecomWatchItem } from "../src/ingest/wecomSource.ts";
import {
  computeNextWorkspaceScheduleRunAt,
  listWorkspaceScheduleRuns,
  listWorkspaceSchedules,
  notifyWorkspaceSchedulesOnBatchCompleted,
  reconcileStaleWorkspaceSchedules,
  registerWorkspaceTaskExecutor,
  removeWorkspaceSchedule,
  toggleWorkspaceSchedule,
  triggerWorkspaceScheduleNow,
  startWorkspaceScheduleForUi,
  upsertWorkspaceSchedule,
} from "../src/ingest/workspaceSchedules.ts";

function createTestHost(): { host: DropTenantHost; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "jiebo-wsched-test-"));
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(workspaceRoot, "Fintopia集团"), { recursive: true });

  const host: DropTenantHost = {
    id: "t_sched_test",
    stateDir,
    workspaceRoot,
    resolveWorkspace(keyOrId: string) {
      if (keyOrId === "Fintopia集团" || keyOrId === "ws_fintopia") {
        return {
          key: "Fintopia集团",
          path: join(workspaceRoot, "Fintopia集团"),
          workspaceId: "ws_fintopia",
        };
      }
      return null;
    },
  };

  setupKbWorkspaceForTenant(host, {
    workspace: "Fintopia集团",
    title: "Fintopia集团知识库",
    categories: ["资金", "资产"],
  });

  return {
    host,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("computeNextWorkspaceScheduleRunAt: interval 与 daily_times 计算准确", () => {
  const base = Date.parse("2026-11-11T01:00:00.000Z"); // 北京时间 09:00
  const nextInterval = computeNextWorkspaceScheduleRunAt(
    {
      scheduleMode: "interval",
      intervalMinutes: 30,
      tz: "Asia/Shanghai",
    },
    base,
  );
  assert.equal(nextInterval, base + 30 * 60_000);

  const nextDaily = computeNextWorkspaceScheduleRunAt(
    {
      scheduleMode: "daily_times",
      intervalMinutes: 60,
      dailyTimes: ["08:45", "18:30"],
      tz: "Asia/Shanghai",
    },
    base,
  );
  // 北京时间当天 09:00 之后的下一个时刻应为当天 18:30 (10:30 UTC)
  assert.equal(new Date(nextDaily).toISOString(), "2026-11-11T10:30:00.000Z");

  // 验证 activeHours 跨日顺延不倒退：北京时间 07:00 (前一日 23:00 UTC) + 12 小时 = 当天 19:00（超出 09:00-18:00 窗口），应顺延至次日 09:00
  const earlyBase = Date.parse("2026-11-10T23:00:00.000Z"); // 北京时间 2026-11-11 07:00
  const nextWithWindow = computeNextWorkspaceScheduleRunAt(
    {
      scheduleMode: "interval",
      intervalMinutes: 720,
      activeHours: { start: "09:00", end: "18:00" },
      tz: "Asia/Shanghai",
    },
    earlyBase,
  );
  assert.equal(new Date(nextWithWindow).toISOString(), "2026-11-12T01:00:00.000Z");
});

test("两阶段单飞互斥锁与归档回调核销：一旦开始严禁重入，跑完归档才解锁回写", async () => {
  const { host, cleanup } = createTestHost();
  try {
    addOrUpdateWecomWatchItem(host, {
      workspace: "Fintopia集团",
      title: "保证金跟进",
      sourceType: "sheet",
      docId: "e3_sheet_1",
    });

    let currentCsv = "项目,金额\n百信,500\n";
    let remoteMtime = "2026-11-11 08:00:00";
    setWecomCliRunnerForTest(async (args) => {
      if (args[0] === "sheet") {
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify({ csv_data: currentCsv, actual_range: "A1:B2" }),
          stderr: "",
          parsed: { csv_data: currentCsv, actual_range: "A1:B2" },
        };
      }
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ update_time: remoteMtime }),
        stderr: "",
        parsed: { update_time: remoteMtime },
      };
    });

    const created = upsertWorkspaceSchedule(host, {
      workspace: "Fintopia集团",
      title: "企微台账每小时巡检",
      executorKind: "wecom_watch_sync",
      scheduleMode: "interval",
      intervalMinutes: 60,
      payload: { watchItemIds: "all", quietPeriodMinutes: 3 },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    // 第一次触发：发现首次变动并提交归档队列 -> 进入 running_step2 锁定状态
    const run1 = await triggerWorkspaceScheduleNow(host, created.item.id);
    assert.equal(run1.ok, true);
    assert.equal(run1.phase, "awaiting_ingest");
    assert.equal(run1.schedule?.state, "running_step2");
    const batchId = run1.schedule?.activeBatchIds?.[0];
    assert.ok(batchId, "应生成待核销的归档批次号");

    // 在 running_step2 锁定期间尝试再次触发：必须被防重入锁拦截拒绝！
    const concurrentAttempt = await triggerWorkspaceScheduleNow(host, created.item.id);
    assert.equal(concurrentAttempt.ok, false);
    assert.match(concurrentAttempt.error || "", /正在运行中.*严禁并发重入/);

    // 模拟后台 IngestRunner 完成归档并刷新 HTML 看板，回调核销
    const settledCount = notifyWorkspaceSchedulesOnBatchCompleted({
      host,
      batchId: batchId!,
      status: "completed",
      summaryText: "已完成《保证金跟进》归档，百信退保 500 万已更新至资金看板",
      movedFiles: [{ from: "inbox/保证金跟进.csv", to: "资金/洋钱罐/保证金跟进.csv", category: "资金" }],
      updatedHtmls: ["资金/资金.html"],
    });
    assert.equal(settledCount, 1);

    // 核查解锁后的任务状态与运行历史记录
    const listAfter = listWorkspaceSchedules(host, { workspace: "Fintopia集团" });
    assert.equal(listAfter.length, 1);
    assert.equal(listAfter[0].state, "idle");
    assert.equal(listAfter[0].lastStatus, "succeeded");
    assert.match(listAfter[0].lastSummary || "", /百信退保 500 万/);
    assert.deepEqual(listAfter[0].lastUpdatedFiles, ["资金/资金.html", "资金/洋钱罐/保证金跟进.csv"]);

    const runs = listWorkspaceScheduleRuns(host, { workspace: "Fintopia集团" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "succeeded");

    // 紧接着跑第二次（内容未变）：直接一阶段快速完成 no_change，0 Token 消耗回到 idle
    const run2 = await triggerWorkspaceScheduleNow(host, created.item.id);
    assert.equal(run2.ok, true);
    assert.equal(run2.phase, "completed");
    assert.equal(run2.schedule?.state, "idle");
    assert.equal(run2.schedule?.lastStatus, "no_change");
  } finally {
    setWecomCliRunnerForTest(null);
    cleanup();
  }
});

test("workspace_script 执行器与 toggle / remove / 崩溃自愈对账", async () => {
  const { host, cleanup } = createTestHost();
  try {
    const wsPath = join(host.workspaceRoot, "Fintopia集团");
    mkdirSync(join(wsPath, "scripts"), { recursive: true });
    writeFileSync(
      join(wsPath, "scripts", "gen.js"),
      `process.stdout.write("日期,余额\\n2026-11-11,1000\\n");`,
      "utf8",
    );

    const up = upsertWorkspaceSchedule(host, {
      workspace: "Fintopia集团",
      title: "本地脚本数据采集",
      executorKind: "workspace_script",
      scheduleMode: "interval",
      intervalMinutes: 30,
      payload: {
        runner: "node",
        scriptRelPath: "scripts/gen.js",
        ingestToKb: false,
      },
    });
    assert.equal(up.ok, true);
    if (!up.ok) return;

    const r1 = await triggerWorkspaceScheduleNow(host, up.item.id);
    assert.equal(r1.ok, true);
    assert.equal(r1.schedule?.lastStatus, "succeeded");

    // 第二次跑同样输出：哈希未变 -> no_change
    const r2 = await triggerWorkspaceScheduleNow(host, up.item.id);
    assert.equal(r2.ok, true);
    assert.equal(r2.schedule?.lastStatus, "no_change");

    const toggled = toggleWorkspaceSchedule(host, up.item.id, false);
    assert.equal(toggled.ok, true);
    if (toggled.ok) assert.equal(toggled.item.enabled, false);

    const reconciled = reconcileStaleWorkspaceSchedules(host);
    assert.equal(reconciled, 0);

    const removed = removeWorkspaceSchedule(host, up.item.id);
    assert.equal(removed.ok, true);
    assert.ok(typeof registerWorkspaceTaskExecutor === "function");
  } finally {
    cleanup();
  }
});

test("月度规则按时区处理短月与跨年", () => {
  const spec = {
    scheduleMode: "monthly",
    intervalMinutes: 60,
    tz: "Asia/Shanghai",
    monthly: { day: 31, time: "09:00", shortMonth: "skip" },
  } as const;
  const januaryRun = Date.parse("2028-01-31T01:00:00Z");
  assert.equal(computeNextWorkspaceScheduleRunAt(spec, januaryRun), Date.parse("2028-03-31T01:00:00Z"));
  assert.equal(
    computeNextWorkspaceScheduleRunAt({ ...spec, monthly: { ...spec.monthly, shortMonth: "last_day" } }, januaryRun),
    Date.parse("2028-02-29T01:00:00Z"),
  );
  assert.equal(
    computeNextWorkspaceScheduleRunAt(spec, Date.parse("2027-12-31T01:00:00Z")),
    Date.parse("2028-01-31T01:00:00Z"),
  );
});

test("编辑计划保留执行指令，防止重名创建和过期表单覆盖", () => {
  const { host, cleanup } = createTestHost();
  try {
    const seed = {
      workspace: "Fintopia集团",
      title: "投诉月报",
      executorKind: "agent_prompt",
      payload: { prompt: "汇总投诉" },
      enabled: false,
      createOnly: true,
    } as const;
    const base = Date.parse("2027-12-31T00:00:00Z");
    const created = upsertWorkspaceSchedule(host, seed, base);
    assert.ok(created.ok);
    assert.equal(created.item.nextRunAt, null);
    assert.equal(upsertWorkspaceSchedule(host, { ...seed, enabled: true }, base).ok, false);
    const edit = {
      id: created.item.id,
      expectedUpdatedAt: created.item.updatedAt,
      workspace: seed.workspace,
      title: seed.title,
      executorKind: seed.executorKind,
      scheduleMode: "monthly",
      monthly: { day: 5, time: "09:00", shortMonth: "skip" },
    } as const;
    const updated = upsertWorkspaceSchedule(host, edit, base + 1);
    assert.ok(updated.ok);
    assert.equal(updated.item.payload.prompt, seed.payload.prompt);
    assert.equal(updated.item.enabled, false);
    assert.equal(upsertWorkspaceSchedule(host, edit, base + 2).ok, false);
    const enabled = toggleWorkspaceSchedule(host, created.item.id, true, seed.workspace, base + 3);
    assert.ok(enabled.ok);
    assert.equal(enabled.item.nextRunAt, Date.parse("2028-01-05T01:00:00Z"));
  } finally {
    cleanup();
  }
});

test("正式运行先确认已开始，执行中重复请求不会再启动", async () => {
  const { host, cleanup } = createTestHost();
  let finish!: () => void;
  let executions = 0;
  registerWorkspaceTaskExecutor("agent_prompt", async () => {
    executions += 1;
    await new Promise<void>((resolve) => { finish = resolve; });
    return { phase: "completed", status: "succeeded", summary: "已交付" };
  });
  try {
    const created = upsertWorkspaceSchedule(host, {
      workspace: "Fintopia集团", title: "月报运行回执", executorKind: "agent_prompt",
      payload: { prompt: "汇总投诉" },
    });
    assert.ok(created.ok);
    assert.ok((await startWorkspaceScheduleForUi(host, created.item.id, "Fintopia集团")).ok);
    assert.equal(listWorkspaceSchedules(host)[0].state, "running_step1");
    assert.equal((await startWorkspaceScheduleForUi(host, created.item.id, "Fintopia集团")).ok, false);
    assert.equal(executions, 1);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(listWorkspaceScheduleRuns(host)[0].status, "succeeded");
  } finally {
    finish?.();
    cleanup();
  }
});

test("小驳自动化快照按工作区稳定 ID 归属，目录改名后仍显示原规则", () => {
  const { host, cleanup } = createTestHost();
  try {
    const created = upsertWorkspaceSchedule(host, {
      workspace: "Fintopia集团", title: "投诉月报", executorKind: "agent_prompt",
      payload: { prompt: "汇总投诉" },
    });
    assert.ok(created.ok);
    const workspaces = [{ id: "ws_fintopia", key: "Fintopia新目录" }, { id: "ws_empty", key: "空工作区" }];
    const combined = getWorkspaceAutomationStatus(host, workspaces);
    assert.deepEqual(combined.automationWorkspaces, workspaces);
    assert.equal(combined.workspaceSchedules?.[0]?.id, created.item.id);
    assert.equal(combined.workspaceSchedules?.[0]?.workspaceKey, "Fintopia新目录");
    assert.deepEqual(getWorkspaceAutomationStatus(host, [workspaces[1]]).workspaceSchedules, []);
    assert.deepEqual(combined.tokens, []);
    assert.equal(combined.ownerWx, undefined);
  } finally {
    cleanup();
  }
});
