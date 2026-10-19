import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { collectAllActivityEntries, memoryCenterActivity } from "../src/assistant/memoryCenterActivity.ts";
import {
  AUDIT_MAX_READ_BYTES,
  lineToAuditSnapshot,
  readAuditRecords,
  setAuditRetentionLimitsForTest,
  setMemoryCenterAuditWriterHooksForTest,
  validateAuditSnapshotShape,
  type StoredAuditRecord,
} from "../src/assistant/memoryCenterAudit.ts";
import { memoryCenterMutate } from "../src/assistant/memoryCenterMutate.ts";
import { memoryCenterRestore } from "../src/assistant/memoryCenterRestore.ts";
import {
  maybeRunDailySuggestionScan,
  memoryCenterSuggestionAnswer,
  memoryCenterSuggestionsGet,
  runMemoryCenterSuggestionScan,
  SUGGESTION_TZ,
} from "../src/assistant/memoryCenterSuggestions.ts";
import { isoWeekKey } from "../src/assistant/cron.ts";
import { assistantPath, writeJson } from "../src/assistant/store.ts";
import { memoryLineRevision } from "../src/assistant/memoryRevision.ts";
import { parseMemoryFile } from "../src/assistant/workspaceMemory.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mca-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tenant(id: string, workspaceRoot: string) {
  const stateDir = join(root, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  return { id, name: id, stateDir, workspaceRoot };
}

function seedMemory(base: string, rel: string, body: string) {
  const dir = join(base, rel, ".jiebo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.md"), body);
}

describe("memory center audit / restore / suggestions", () => {
  test("mutate 写审计且不含正文以外密钥", () => {
    const base = join(root, "aud1");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "ws",
      ["# 工作区记忆", "## 约定", "- 旧 <!-- id=wm_old from=user at=2026-01-01 -->"].join("\n"),
    );
    const t = tenant("aud1", base);
    const created = memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "审计测试条目" },
    });
    assert.equal(created.ok, true);
    const auditPath = join(base, "ws", ".jiebo", "memory-audit.jsonl");
    const auditText = readFileSync(auditPath, "utf8");
    assert.match(auditText, /"action":"create"/);
    assert.doesNotMatch(auditText, /sk-live/);
  });

  test("rollback create 与再次 rollback 冲突", () => {
    const base = join(root, "aud2");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n");
    const t = tenant("aud2", base);
    const created = memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "可回滚" },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const id = created.data.item!.id!;
    const activity = memoryCenterActivity(t, ["ws"], { scope: "ws" });
    const entry = activity.entries.find((row) => row.action === "create");
    assert.ok(entry?.canRestore);
    const restored = memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: entry!.auditId });
    assert.equal(restored.ok, true);
    assert.equal(parseMemoryFile(readFileSync(join(base, "ws", ".jiebo", "memory.md"), "utf8")).length, 0);
    const again = memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: entry!.auditId });
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.code, "conflict");
  });

  test("损坏尾行可读且 degraded", () => {
    const base = join(root, "aud3");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n");
    const t = tenant("aud3", base);
    memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "x" },
    });
    const auditPath = join(base, "ws", ".jiebo", "memory-audit.jsonl");
    writeFileSync(auditPath, `${readFileSync(auditPath, "utf8")}{bad json\n`);
    const read = readAuditRecords(auditPath);
    assert.equal(read.corruptLines >= 1, true);
    const activity = memoryCenterActivity(t, ["ws"], {});
    assert.equal(activity.degraded, true);
  });

  test("scanner 稳定 id 且 missing_ref", () => {
    const base = join(root, "aud4");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "proj",
      [
        "# 工作区记忆",
        "## 约定",
        "- 缺引用 <!-- id=wm_miss from=user at=2026-01-01 refs=missing.ts -->",
      ].join("\n"),
    );
    const t = tenant("aud4", base);
    const scan1 = runMemoryCenterSuggestionScan(t, ["proj"], { id: t.id, stateDir: t.stateDir });
    const scan2 = runMemoryCenterSuggestionScan(t, ["proj"], { id: t.id, stateDir: t.stateDir });
    const a = scan1.active.find((row) => row.kind === "missing_ref");
    const b = scan2.active.find((row) => row.kind === "missing_ref");
    assert.ok(a && b);
    assert.equal(a.id, b.id);
    const got = memoryCenterSuggestionsGet({ id: t.id, stateDir: t.stateDir });
    assert.ok(got.entries.some((row) => row.kind === "missing_ref"));
  });

  test("suggestion dismiss 与 accept stale_hot", () => {
    const base = join(root, "aud5");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "ws",
      [
        "# 工作区记忆",
        "## 约定",
        "- 旧 hot <!-- id=wm_hot from=user at=2020-01-01 state=hot -->",
      ].join("\n"),
    );
    const t = tenant("aud5", base);
    runMemoryCenterSuggestionScan(t, ["ws"], { id: t.id, stateDir: t.stateDir });
    const sug = memoryCenterSuggestionsGet({ id: t.id, stateDir: t.stateDir }).entries.find((r) => r.kind === "stale_hot");
    assert.ok(sug);
    const dismissed = memoryCenterSuggestionAnswer(t, ["ws"], { id: t.id, stateDir: t.stateDir }, {
      scope: "ws",
      id: sug!.id,
      accept: false,
    });
    assert.equal(dismissed.ok, true);
    assert.equal(
      memoryCenterSuggestionsGet({ id: t.id, stateDir: t.stateDir }).entries.some((r) => r.id === sug!.id),
      false,
    );

    const base2 = join(root, "aud5b");
    mkdirSync(base2, { recursive: true });
    seedMemory(
      base2,
      "ws",
      ["# 工作区记忆", "## 约定", "- 另一条 <!-- id=wm_hot2 from=user at=2020-02-01 state=hot -->"].join("\n"),
    );
    const t2 = tenant("aud5b", base2);
    runMemoryCenterSuggestionScan(t2, ["ws"], { id: t2.id, stateDir: t2.stateDir });
    const acceptTarget = memoryCenterSuggestionsGet({ id: t2.id, stateDir: t2.stateDir }).entries.find(
      (r) => r.kind === "stale_hot",
    );
    assert.ok(acceptTarget);
    const accepted = memoryCenterSuggestionAnswer(t2, ["ws"], { id: t2.id, stateDir: t2.stateDir }, {
      scope: "ws",
      id: acceptTarget!.id,
      accept: true,
    });
    assert.equal(accepted.ok, true);
  });

  test("retention 截断", () => {
    const base = join(root, "aud6");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n");
    const t = tenant("aud6", base);
    setAuditRetentionLimitsForTest({ count: 5, bytes: 4096 });
    try {
      for (let i = 0; i < 12; i += 1) {
        memoryCenterMutate(t, ["ws"], {
          scope: "ws",
          mutation: { action: "create", section: "约定", text: `条目${i}` },
        });
      }
      const auditPath = join(base, "ws", ".jiebo", "memory-audit.jsonl");
      const read = readAuditRecords(auditPath, { maxRecords: 20 });
      assert.ok(read.records.length <= 5);
    } finally {
      setAuditRetentionLimitsForTest(null);
    }
  });

  test("activity 分页等于全集且 action 过滤", () => {
    setAuditRetentionLimitsForTest(null);
    setMemoryCenterAuditWriterHooksForTest(null);
    const base = join(root, "aud-page");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n");
    const t = tenant("aud-page", base);
    for (let i = 0; i < 11; i += 1) {
      const created = memoryCenterMutate(t, ["ws"], {
        scope: "ws",
        mutation: { action: "create", section: "约定", text: `p${i}` },
      });
      assert.equal(created.ok, true);
    }
    const all = collectAllActivityEntries(t, ["ws"], { scope: "ws", pageSize: 4 });
    const direct = memoryCenterActivity(t, ["ws"], { scope: "ws", limit: 100 });
    assert.equal(all.length, direct.entries.length);
    const expectedCreates = direct.entries.filter((row) => row.action === "create").length;
    const updates = collectAllActivityEntries(t, ["ws"], { scope: "ws", action: "create", pageSize: 3 });
    assert.equal(updates.length, expectedCreates);
    assert.equal(expectedCreates, 11);
    assert.ok(updates.every((row) => row.action === "create"));
  });

  test("audit 失败补偿 memory 字节", () => {
    const base = join(root, "aud-comp");
    mkdirSync(base, { recursive: true });
    const body = "# 工作区记忆\n## 约定\n- 原样 <!-- id=wm_keep from=user at=2026-01-01 -->\n";
    seedMemory(base, "ws", body);
    const t = tenant("aud-comp", base);
    const memPath = join(base, "ws", ".jiebo", "memory.md");
    const before = readFileSync(memPath);
    setMemoryCenterAuditWriterHooksForTest({ failAppend: true });
    try {
      const failed = memoryCenterMutate(t, ["ws"], {
        scope: "ws",
        mutation: { action: "create", section: "约定", text: "不应留下" },
      });
      assert.equal(failed.ok, false);
      assert.equal(readFileSync(memPath).equals(before), true);
    } finally {
      setMemoryCenterAuditWriterHooksForTest(null);
    }
  });

  test("create 链三次切换且仅最新可 restore", () => {
    const base = join(root, "aud-chain");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n");
    const t = tenant("aud-chain", base);
    const memPath = join(base, "ws", ".jiebo", "memory.md");
    const created = memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "链式" },
    });
    assert.equal(created.ok, true);
    const createEntry = memoryCenterActivity(t, ["ws"], { action: "create" }).entries[0];
    assert.ok(createEntry?.canRestore);
    assert.equal(memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: createEntry.auditId }).ok, true);
    assert.equal(parseMemoryFile(readFileSync(memPath, "utf8")).length, 0);
    const restore1 = memoryCenterActivity(t, ["ws"], { action: "restore" }).entries[0];
    assert.ok(restore1?.canRestore);
    assert.equal(memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: restore1.auditId }).ok, true);
    assert.equal(parseMemoryFile(readFileSync(memPath, "utf8")).length, 1);
    const restore2 = memoryCenterActivity(t, ["ws"], { action: "restore" }).entries[0];
    assert.ok(restore2?.canRestore);
    assert.equal(memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: restore2.auditId }).ok, true);
    assert.equal(parseMemoryFile(readFileSync(memPath, "utf8")).length, 0);
    const act = memoryCenterActivity(t, ["ws"], { limit: 20 });
    const latest = act.entries.find((row) => row.itemId === createEntry.itemId && row.canRestore);
    assert.ok(latest);
    assert.equal(act.entries.filter((row) => row.itemId === createEntry.itemId && row.canRestore).length, 1);
    const oldCreate = act.entries.find((row) => row.auditId === createEntry.auditId);
    assert.ok(oldCreate);
    assert.equal(oldCreate.canRestore, false);
  });

  test("update 审计 rawLine/meta 保真且 restore 记录可连 restore 两次", () => {
    const base = join(root, "aud-dbl");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "ws",
      ["# 工作区记忆", "## 约定", "- 初版 <!-- id=wm_d1 from=user at=2026-01-01 customMeta=xy -->"].join("\r\n"),
    );
    const t = tenant("aud-dbl", base);
    const memPath = join(base, "ws", ".jiebo", "memory.md");
    const rev0 = memoryLineRevision(parseMemoryFile(readFileSync(memPath, "utf8"))[0]);
    const upd = memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "update", id: "wm_d1", revision: rev0, patch: { text: "第二版" } },
    });
    assert.equal(upd.ok, true);
    const auditPath = join(base, "ws", ".jiebo", "memory-audit.jsonl");
    const stored = readAuditRecords(auditPath).records.find((row) => row.action === "update");
    assert.ok(stored?.before?.rawLine.includes("customMeta=xy"));

    const updateEntry = memoryCenterActivity(t, ["ws"], { action: "update" }).entries[0];
    assert.ok(updateEntry?.canRestore);
    const undoUpdate = memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: updateEntry.auditId });
    assert.equal(undoUpdate.ok, true);
    assert.match(readFileSync(memPath, "utf8"), /初版/);

    const restoreEntry = memoryCenterActivity(t, ["ws"], { action: "restore" }).entries[0];
    assert.ok(restoreEntry?.canRestore);
    const undoRestore1 = memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: restoreEntry.auditId });
    assert.equal(undoRestore1.ok, true);
    assert.match(readFileSync(memPath, "utf8"), /第二版/);
    const restoreEntry2 = memoryCenterActivity(t, ["ws"], { action: "restore" }).entries[0];
    assert.ok(restoreEntry2?.canRestore);
    const undoRestore2 = memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: restoreEntry2.auditId });
    assert.equal(undoRestore2.ok, true);
    assert.match(readFileSync(memPath, "utf8"), /初版/);
  });

  test("尾读 truncated 与中间坏行", () => {
    const base = join(root, "aud-tail");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n");
    const t = tenant("aud-tail", base);
    memoryCenterMutate(t, ["ws"], { scope: "ws", mutation: { action: "create", section: "约定", text: "a" } });
    const auditPath = join(base, "ws", ".jiebo", "memory-audit.jsonl");
    const lines = readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
    lines.splice(0, 0, "{not-json");
    writeFileSync(auditPath, `${lines.join("\n")}\n`);
    const tail = readAuditRecords(auditPath, { maxBytes: AUDIT_MAX_READ_BYTES });
    assert.ok(tail.records.length >= 1);
    assert.equal(tail.corruptLines >= 1, true);
    const huge = readAuditRecords(auditPath, { maxBytes: 32 });
    assert.equal(huge.truncated, true);
  });

  test("scanner 五类与 accept 产 audit", () => {
    const base = join(root, "aud-scan");
    mkdirSync(base, { recursive: true });
    const dup = "完全相同的正文用于去重测试";
    seedMemory(
      base,
      "proj",
      [
        "# 工作区记忆",
        "## 约定",
        `- ${dup} <!-- id=wm_a from=user at=2020-01-01 state=hot uses=1 -->`,
        `- ${dup} <!-- id=wm_b from=user at=2020-02-01 state=hot uses=0 -->`,
        "- 缺引用 <!-- id=wm_miss from=user at=2026-01-01 refs=missing.ts -->",
        "## 进行中",
        "- 老进行 <!-- id=wm_go from=user at=2020-01-01 -->",
      ].join("\n"),
    );
    const t = tenant("aud-scan", base);
    const scan = runMemoryCenterSuggestionScan(t, ["proj"], { id: t.id, stateDir: t.stateDir });
    const kinds = new Set(scan.active.map((row) => row.kind));
    for (const k of ["missing_ref", "duplicate", "stale_hot", "stale_ongoing"] as const) {
      assert.ok(kinds.has(k), `missing kind ${k}`);
    }
    const staleHot = scan.active.find((row) => row.kind === "stale_hot");
    assert.ok(staleHot);
    const auditFile = join(base, "proj", ".jiebo", "memory-audit.jsonl");
    const auditBefore = existsSync(auditFile) ? readFileSync(auditFile, "utf8").length : 0;
    const accepted = memoryCenterSuggestionAnswer(t, ["proj"], { id: t.id, stateDir: t.stateDir }, {
      scope: "proj",
      id: staleHot!.id,
      accept: true,
    });
    assert.equal(accepted.ok, true);
    const auditAfter = readFileSync(join(base, "proj", ".jiebo", "memory-audit.jsonl"), "utf8");
    assert.ok(auditAfter.length > auditBefore);
  });

  test("tombstone 同日 dismiss 不再出现", () => {
    const base = join(root, "aud-tomb");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "ws",
      ["# 工作区记忆", "## 约定", "- 热 <!-- id=wm_t from=user at=2020-01-01 state=hot -->"].join("\n"),
    );
    const t = tenant("aud-tomb", base);
    runMemoryCenterSuggestionScan(t, ["ws"], { id: t.id, stateDir: t.stateDir });
    const sug = memoryCenterSuggestionsGet({ id: t.id, stateDir: t.stateDir }).entries[0];
    assert.ok(sug);
    memoryCenterSuggestionAnswer(t, ["ws"], { id: t.id, stateDir: t.stateDir }, { scope: "ws", id: sug.id, accept: false });
    runMemoryCenterSuggestionScan(t, ["ws"], { id: t.id, stateDir: t.stateDir });
    assert.equal(memoryCenterSuggestionsGet({ id: t.id, stateDir: t.stateDir }).entries.some((r) => r.id === sug.id), false);
  });

  test("daily scan 保留 lastLocalDay 且同周 inbox 一次", () => {
    const base = join(root, "aud-cron");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n- x <!-- id=wm_c from=user at=2020-01-01 state=hot -->\n");
    const t = tenant("aud-cron", base);
    const ref = { id: t.id, stateDir: t.stateDir };
    const now = Date.parse("2026-03-18T06:00:00.000Z");
    const day = "2026-03-18";
    const week = isoWeekKey(now, SUGGESTION_TZ);
    writeJson(assistantPath(ref, "memory-center-suggestions.json"), {
      generatedAt: new Date(0).toISOString(),
      lastRunAt: new Date(0).toISOString(),
      lastLocalDay: "2026-03-17",
      lastInboxWeek: week,
      tz: SUGGESTION_TZ,
      active: [],
      decisions: [],
    });
    const r1 = maybeRunDailySuggestionScan(t, ["ws"], ref, now, SUGGESTION_TZ);
    assert.equal(r1.ran, true);
    const statePath = assistantPath(ref, "memory-center-suggestions.json");
    const state1 = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(state1.lastRunAt);
    const r2 = maybeRunDailySuggestionScan(t, ["ws"], ref, now + 60_000, SUGGESTION_TZ);
    assert.equal(r2.ran, false);
    runMemoryCenterSuggestionScan(t, ["ws"], ref);
    const withSchedule = {
      ...JSON.parse(readFileSync(statePath, "utf8")),
      lastLocalDay: day,
      lastInboxWeek: undefined,
    };
    writeJson(statePath, withSchedule);
    runMemoryCenterSuggestionScan(t, ["ws"], ref, withSchedule);
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(saved.lastLocalDay, day);
    assert.ok(saved.lastRunAt);
    const inboxWeek = isoWeekKey(now, SUGGESTION_TZ);
    writeJson(statePath, { ...saved, lastLocalDay: "2026-03-17", lastInboxWeek: undefined });
    maybeRunDailySuggestionScan(t, ["ws"], ref, now, SUGGESTION_TZ);
    maybeRunDailySuggestionScan(t, ["ws"], ref, now + 90_000, SUGGESTION_TZ);
    const afterInbox = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(afterInbox.lastInboxWeek, inboxWeek);
  });

  test("validateAuditSnapshotShape 各 action 坏形状", () => {
    const base = join(root, "aud-shape");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n- 探针 <!-- id=wm_probe from=user at=2026-01-01 -->\n");
    const t = tenant("aud-shape", base);
    const memPath = join(base, "ws", ".jiebo", "memory.md");
    const line = parseMemoryFile(readFileSync(memPath, "utf8"))[0]!;
    const rev = memoryLineRevision(line);
    const raw = readFileSync(memPath, "utf8").trim().split("\n").pop()!;
    const after = lineToAuditSnapshot(line, raw);
    const before = lineToAuditSnapshot({ ...line, text: "旧" }, raw.replace("探针", "旧"));
    const baseRec = {
      auditId: "aud_x",
      scope: "ws",
      itemId: "wm_probe",
      actor: "user" as const,
      at: new Date().toISOString(),
    };

    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "create", after }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "create", before, after }).ok, false);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "create" }).ok, false);

    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "delete", before }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "delete", before, after }).ok, false);

    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "update", before, after }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "update", after }).ok, false);

    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "set_state", before, after }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "set_pinned", before, after }).ok, true);

    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "restore", before, after }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "restore", before }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "restore", after }).ok, true);
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "restore" }).ok, false);

    assert.equal(
      validateAuditSnapshotShape({ ...baseRec, action: "bogus", before, after } as unknown as StoredAuditRecord).ok,
      false,
    );

    const forged = lineToAuditSnapshot(line, raw);
    forged.revision = "deadbeef";
    assert.equal(validateAuditSnapshotShape({ ...baseRec, action: "update", before, after: forged }).ok, false);
    void rev;
  });

  test("update 缺 before 时 activity degraded 且 restore corrupt_audit 不写 memory", () => {
    const base = join(root, "aud-mal");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "ws", "# 工作区记忆\n## 约定\n- 条目 <!-- id=wm_m from=user at=2026-01-01 -->\n");
    const t = tenant("aud-mal", base);
    const memPath = join(base, "ws", ".jiebo", "memory.md");
    const rev0 = memoryLineRevision(parseMemoryFile(readFileSync(memPath, "utf8"))[0]);
    memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "update", id: "wm_m", revision: rev0, patch: { text: "新文本" } },
    });
    const afterMutate = readFileSync(memPath);
    const auditPath = join(base, "ws", ".jiebo", "memory-audit.jsonl");
    const rows = readFileSync(auditPath, "utf8").trimEnd().split("\n");
    const bad = JSON.parse(rows[rows.length - 1]) as Record<string, unknown>;
    delete bad.before;
    rows[rows.length - 1] = JSON.stringify(bad);
    writeFileSync(auditPath, `${rows.join("\n")}\n`);

    const act = memoryCenterActivity(t, ["ws"], { action: "update" });
    assert.equal(act.degraded, true);
    const entry = act.entries.find((row) => row.action === "update");
    assert.ok(entry);
    assert.equal(entry.canRestore, false);
    assert.equal(entry.degraded, true);

    const restored = memoryCenterRestore(t, ["ws"], { scope: "ws", auditId: entry!.auditId });
    assert.equal(restored.ok, false);
    if (!restored.ok) assert.equal(restored.code, "corrupt_audit");
    assert.equal(readFileSync(memPath).equals(afterMutate), true);
  });
});

