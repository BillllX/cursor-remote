import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  SCHEDULE_DEFAULTS_VERSION,
  listOccurrences,
  listSchedules,
  recoverSchedules,
  seedDefaults,
  tickSchedules,
  type Schedule,
} from "../src/assistant/schedules.ts";
import { assistantPath, writeJson, writeJsonl, type TenantRef } from "../src/assistant/store.ts";
import { bumpAssistantRevision, readAssistantRevision } from "../src/assistant/revision.ts";

const root = mkdtempSync(join(tmpdir(), "cr-schedules-"));
const now = Date.parse("2026-10-23T12:00:00+08:00");

after(() => rmSync(root, { recursive: true, force: true }));

function ref(id: string): TenantRef {
  return { id, stateDir: join(root, id) };
}

function legacyBrief(): Schedule {
  return {
    id: "s_brief",
    title: "每日简报",
    kind: "brief",
    cron: "0 9 * * *",
    tz: "Asia/Shanghai",
    prompt: "生成今日简报",
    enabled: true,
    misfire: "runOnce",
    nextAt: now + 60_000,
    failCount: 0,
    createdAt: now - 1000,
  };
}

describe("schedule defaults migration", () => {
  test("新用户会得到 9:00 简报和 21:00 晚间收尾", () => {
    const tenant = ref("new");
    assert.equal(seedDefaults(tenant, now), true);

    const rows = listSchedules(tenant);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.id === "s_brief" && row.kind === "brief" && row.cron === "0 9 * * *"));
    assert.ok(
      rows.some(
        (row) =>
          row.id === "s_evening_wrap" &&
          row.kind === "prompt" &&
          row.cron === "0 21 * * *" &&
          row.prompt.includes("最多三条") &&
          row.prompt.includes("今天完成") &&
          row.prompt.includes("需顺延") &&
          row.prompt.includes("明天第一件事"),
      ),
    );
  });

  test("已 seeded 的旧文件升级时保留原任务并只补晚间收尾", () => {
    const tenant = ref("legacy");
    const custom: Schedule = { ...legacyBrief(), id: "custom", title: "自定义", kind: "remind", prompt: "喝水" };
    writeJson(assistantPath(tenant, "schedules.json"), {
      seeded: true,
      schedules: [legacyBrief(), custom],
    });

    assert.equal(seedDefaults(tenant, now), true);
    const rows = listSchedules(tenant);
    assert.equal(rows.filter((row) => row.id === "s_brief").length, 1);
    assert.equal(rows.filter((row) => row.id === "s_evening_wrap").length, 1);
    assert.ok(rows.some((row) => row.id === "custom"));

    const stored = JSON.parse(readFileSync(assistantPath(tenant, "schedules.json"), "utf8")) as {
      defaultsVersion?: number;
    };
    assert.equal(stored.defaultsVersion, SCHEDULE_DEFAULTS_VERSION);
  });

  test("重复迁移幂等，已有同语义晚间任务也不会重复创建", () => {
    const tenant = ref("idempotent");
    writeJson(assistantPath(tenant, "schedules.json"), {
      seeded: true,
      schedules: [
        legacyBrief(),
        {
          ...legacyBrief(),
          id: "user-evening",
          title: "晚间收尾",
          kind: "prompt",
          cron: "0 21 * * *",
          prompt: "我的晚间总结",
        },
      ],
    });

    assert.equal(seedDefaults(tenant, now), true);
    assert.equal(seedDefaults(tenant, now + 1000), false);
    const rows = listSchedules(tenant);
    assert.equal(rows.filter((row) => row.title === "晚间收尾" && row.cron === "0 21 * * *").length, 1);

    // 已迁移后删除默认任务是用户选择；后续启动不得重新创建。
    const path = assistantPath(tenant, "schedules.json");
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      schedules: Schedule[];
      defaultsVersion: number;
      seeded: boolean;
    };
    data.schedules = data.schedules.filter((row) => row.title !== "晚间收尾");
    writeFileSync(path, JSON.stringify(data));
    assert.equal(seedDefaults(tenant, now + 2000), false);
    assert.equal(
      listSchedules(tenant).some((row) => row.title === "晚间收尾"),
      false,
    );
  });
});

describe("schedule projection revision", () => {
  function dueSchedule(id: string, at: number, patch: Partial<Schedule> = {}): Schedule {
    return {
      id,
      title: id,
      kind: "prompt",
      cron: "* * * * *",
      tz: "Asia/Shanghai",
      prompt: "执行",
      enabled: true,
      misfire: "runOnce",
      nextAt: at,
      failCount: 0,
      createdAt: at - 1000,
      ...patch,
    };
  }

  test("nextAt、running、done 都通过变更回调推进 revision", async () => {
    const tenant = ref("tick-done");
    const at = Date.parse("2026-10-25T10:00:00+08:00");
    writeJson(assistantPath(tenant, "schedules.json"), {
      schedules: [dueSchedule("done", at)],
    });
    const initial = readAssistantRevision(tenant);
    let finish!: (value: { ok: boolean }) => void;
    const execution = new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve;
    });

    const started = tickSchedules(
      tenant,
      async () => execution,
      at,
      () => bumpAssistantRevision(tenant),
    );
    assert.equal(readAssistantRevision(tenant), initial + 1);
    assert.equal(listSchedules(tenant)[0].lastStatus, "running");
    assert.ok((listSchedules(tenant)[0].nextAt ?? 0) > at);

    finish({ ok: true });
    await Promise.all(started);
    assert.equal(readAssistantRevision(tenant), initial + 2);
    assert.equal(listSchedules(tenant)[0].lastStatus, "done");
    assert.equal(listSchedules(tenant)[0].failCount, 0);
  });

  test("skipped 与 failed/failCount 也分别推进 revision", async () => {
    const at = Date.parse("2026-10-25T10:00:00+08:00");
    const skipped = ref("tick-skipped");
    writeJson(assistantPath(skipped, "schedules.json"), {
      schedules: [
        dueSchedule("skipped", at - 10 * 60_000, {
          misfire: "skip",
        }),
      ],
    });
    const skippedInitial = readAssistantRevision(skipped);
    assert.equal(
      tickSchedules(
        skipped,
        async () => ({ ok: true }),
        at,
        () => bumpAssistantRevision(skipped),
      ).length,
      0,
    );
    assert.equal(readAssistantRevision(skipped), skippedInitial + 1);
    assert.equal(listSchedules(skipped)[0].lastStatus, "skipped");

    const failed = ref("tick-failed");
    writeJson(assistantPath(failed, "schedules.json"), {
      schedules: [dueSchedule("failed", at)],
    });
    const failedInitial = readAssistantRevision(failed);
    await Promise.all(
      tickSchedules(
        failed,
        async () => ({ ok: false, error: "boom" }),
        at,
        () => bumpAssistantRevision(failed),
      ),
    );
    assert.equal(readAssistantRevision(failed), failedInitial + 2);
    assert.equal(listSchedules(failed)[0].lastStatus, "failed");
    assert.equal(listSchedules(failed)[0].failCount, 1);
  });

  test("recoverSchedules 中断 running occurrence 时推进 revision", () => {
    const tenant = ref("recover");
    const at = Date.parse("2026-10-25T10:00:00+08:00");
    writeJson(assistantPath(tenant, "schedules.json"), {
      schedules: [dueSchedule("recover", at, { lastStatus: "running" })],
    });
    writeJsonl(assistantPath(tenant, "occurrences.jsonl"), [
      {
        occurrenceId: "recover@2026-10-25 10:00",
        scheduleId: "recover",
        plannedAt: at,
        state: "running",
        startedAt: at,
      },
    ]);
    const initial = readAssistantRevision(tenant);
    assert.equal(
      recoverSchedules(tenant, () => bumpAssistantRevision(tenant)),
      1,
    );
    assert.equal(readAssistantRevision(tenant), initial + 1);
    assert.equal(listSchedules(tenant)[0].lastStatus, "interrupted");
    assert.equal(listOccurrences(tenant)[0].state, "interrupted");
  });
});
