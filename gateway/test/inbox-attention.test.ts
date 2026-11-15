import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postInbox, listInbox, markInboxRead } from "../src/assistant/inbox.ts";

test("reading does not resolve an actionable notification; resolution survives reload", () => {
  const ref = { id: "test", stateDir: mkdtempSync(join(tmpdir(), "inbox-attention-")) };
  try {
    const { item } = postInbox(ref, { kind: "run", title: "Failed", body: "Retry" });
    assert.equal(item.attention, "recovery");
    markInboxRead(ref, [item.id]);
    assert.equal(listInbox(ref)[0].read, true);
    assert.notEqual(listInbox(ref)[0].resolved, true);
    assert.equal(markInboxRead(ref, [item.id], true), 1);
    assert.equal(listInbox(ref)[0].resolved, true);
    assert.equal(markInboxRead(ref, [item.id], true), 0);
    const result = postInbox(ref, { kind: "reminder", attention: "notice", title: "Done", body: "" });
    assert.equal(result.item.attention, "notice");
  } finally {
    rmSync(ref.stateDir, { recursive: true, force: true });
  }
});

test("snoozed reminders wake once and legacy approvals retain actionable identifiers", async () => {
  const { snoozeInbox, wakeSnoozedInbox } = await import("../src/assistant/inbox.ts");
  const ref = { id: "test", stateDir: mkdtempSync(join(tmpdir(), "inbox-snooze-")) };
  try {
    const reminder = postInbox(ref, { kind: "reminder", title: "Meeting", body: "" }).item;
    assert.equal(snoozeInbox(ref, reminder.id, 15, 1000), true);
    assert.equal(wakeSnoozedInbox(ref, 900999), 0);
    assert.equal(wakeSnoozedInbox(ref, 901000), 1);
    assert.equal(wakeSnoozedInbox(ref, 901001), 0);
    assert.equal(listInbox(ref)[0].read, false);
    const approval = postInbox(ref, { kind: "approval", title: "Skill", body: "", key: "skill-proposal:abc:3" }).item;
    assert.equal(snoozeInbox(ref, approval.id, 15), false);
    assert.deepEqual(listInbox(ref)[0].decision, { kind: "skill", id: "abc", rev: 3 });
    assert.equal(snoozeInbox(ref, reminder.id, -1), false);
  } finally {
    rmSync(ref.stateDir, { recursive: true, force: true });
  }
});

test("notification operations reject invalid approvals and keep failed decisions pending", async () => {
  const { handleOp } = await import("../src/assistant/service.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "inbox-operation-"));
  const tenant = { id: "test", name: "Test", stateDir, workspaceRoot: stateDir };
  try {
    const item = postInbox(tenant, {
      kind: "approval",
      title: "Missing proposal",
      body: "",
      decision: { kind: "proposal", id: "missing" },
    }).item;
    assert.equal((await handleOp(tenant, "inbox_decide", { id: item.id, approve: "true" })).ok, false);
    assert.equal((await handleOp(tenant, "inbox_decide", { id: item.id, approve: true })).ok, false);
    assert.notEqual(listInbox(tenant)[0].resolved, true);
    assert.equal((await handleOp(tenant, "inbox_snooze", { id: item.id, minutes: 15 })).ok, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("settled approvals archive only their matching notification", async () => {
  const { addApproval, settleApproval } = await import("../src/assistant/approvals.ts");
  const ref = { id: "test", stateDir: mkdtempSync(join(tmpdir(), "approval-inbox-")) };
  try {
    addApproval(ref, { chatId: "chat", callId: "call", tool: "shell", summary: "test" });
    postInbox(ref, { kind: "approval", title: "Run", body: "", key: "approval:chat:call" });
    postInbox(ref, { kind: "approval", title: "Other", body: "", key: "proposal:other" });
    settleApproval(ref, "chat", "call");
    const rows = listInbox(ref);
    assert.equal(rows.find(row => row.key === "approval:chat:call")?.resolved, true);
    assert.notEqual(rows.find(row => row.key === "proposal:other")?.resolved, true);
  } finally { rmSync(ref.stateDir, { recursive: true, force: true }); }
});

test("mark all read clears unread without resolving approvals; batch archive excludes them", async () => {
  const { handleOp } = await import("../src/assistant/service.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "inbox-batch-"));
  const tenant = { id: "batch", name: "Batch", stateDir, workspaceRoot: stateDir };
  try {
    const approval = postInbox(tenant, { kind: "approval", title: "Confirm", body: "" }).item;
    const reminder = postInbox(tenant, { kind: "reminder", title: "Reminder", body: "" }).item;
    await handleOp(tenant, "inbox_read", {});
    assert.equal(listInbox(tenant).filter(item => !item.read).length, 0);
    assert.equal(listInbox(tenant).filter(item => item.resolved).length, 0);
    await handleOp(tenant, "inbox_read", { ids: [approval.id, reminder.id], resolve: true });
    assert.equal(listInbox(tenant).find(item => item.id === reminder.id)?.resolved, true);
    assert.notEqual(listInbox(tenant).find(item => item.id === approval.id)?.resolved, true);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
