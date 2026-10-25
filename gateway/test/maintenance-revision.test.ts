import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import { runMaintenance } from "../src/assistant/jobs.ts";
import { listMemory, saveMemory } from "../src/assistant/memory.ts";
import { bumpAssistantRevision, readAssistantRevision } from "../src/assistant/revision.ts";
import type { TenantRef } from "../src/assistant/store.ts";

const root = mkdtempSync(resolve(tmpdir(), "cr-maintenance-revision-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ref = (id: string): TenantRef => ({ id, stateDir: resolve(root, id) });

describe("maintenance projection revision", () => {
  test("expireMemory 改变记忆投影时精确推进 revision", async () => {
    const tenant = ref("expired");
    const saved = saveMemory(
      tenant,
      {
        topic: "临时",
        text: "已经过期的临时事实",
        basis: "user_said",
        validUntil: "2000-01-01",
      },
      "page",
    );
    assert.equal(saved.ok, true);
    const initial = readAssistantRevision(tenant);
    let runs = 0;

    const result = await runMaintenance(
      tenant,
      async () => {
        runs += 1;
        return { ok: true, runId: "maintenance", text: "" };
      },
      Date.parse("2026-10-25T05:00:00+08:00"),
      "Asia/Shanghai",
      () => bumpAssistantRevision(tenant),
    );

    assert.equal(result.ran, true);
    assert.equal(result.expired, 1);
    assert.equal(runs, 0);
    assert.equal(readAssistantRevision(tenant), initial + 1);
    const entry = listMemory(tenant).entries.find((item) => item.text === "已经过期的临时事实");
    assert.equal(entry?.invalidReason, "有效期已过");
  });

  test("没有条目过期时不因 maintenance 元数据乱 bump", async () => {
    const tenant = ref("unchanged");
    const initial = readAssistantRevision(tenant);
    const result = await runMaintenance(
      tenant,
      async () => ({ ok: true, runId: "maintenance", text: "" }),
      Date.parse("2026-10-25T05:00:00+08:00"),
      "Asia/Shanghai",
      () => bumpAssistantRevision(tenant),
    );
    assert.equal(result.ran, true);
    assert.equal(result.expired, 0);
    assert.equal(readAssistantRevision(tenant), initial);
  });
});
