import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SCHEDULE_DEFAULTS_VERSION, listSchedules, seedDefaults, type Schedule } from "../src/assistant/schedules.ts";
import { assistantPath, writeJson, type TenantRef } from "../src/assistant/store.ts";

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
