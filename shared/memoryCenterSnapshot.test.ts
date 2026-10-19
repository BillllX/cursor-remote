import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  snapshotPayloadForChecksum,
  validateMemoryCenterSnapshotV1,
  type MemoryCenterSnapshotV1,
} from "./memoryCenterSnapshot.ts";

function sampleSnapshot(): MemoryCenterSnapshotV1 {
  const body = {
    schemaVersion: 1 as const,
    exportedAt: "2026-10-18T12:00:00.000Z",
    manifest: {
      checksum: "" as const,
      includedScopes: {
        personal: true,
        workPreference: true,
        personalSettings: true,
        workspaceIds: [] as string[],
      },
    },
    personal: {
      core: { rev: 1, fields: { 关于我: "hi", 偏好: "", 近况: "", 人物: "" } },
      settings: { paused: false, allowSensitive: {} },
      entries: [],
    },
    workPreferences: { text: "用中文", checksum: createHash("sha256").update("用中文", "utf8").digest("hex") },
    workspaces: [],
    rulesInventory: [],
  };
  const checksum = createHash("sha256").update(snapshotPayloadForChecksum(body)).digest("hex");
  return { ...body, manifest: { checksum, includedScopes: body.manifest.includedScopes } };
}

describe("memoryCenterSnapshot", () => {
  test("valid sample passes strict validator", () => {
    const snap = sampleSnapshot();
    const v = validateMemoryCenterSnapshotV1(snap);
    assert.equal(v.ok, true);
  });

  test("rejects unknown keys and bad checksum", () => {
    const snap = sampleSnapshot() as unknown as Record<string, unknown>;
    snap.extra = 1;
    const v = validateMemoryCenterSnapshotV1(snap);
    assert.equal(v.ok, false);
  });

  test("rejects proto keys and bad includedScopes", () => {
    const snap = sampleSnapshot() as unknown as Record<string, unknown>;
    (snap.manifest as Record<string, unknown>).__proto__ = { personal: true };
    assert.equal(validateMemoryCenterSnapshotV1(snap).ok, false);
    const snap2 = sampleSnapshot();
    snap2.manifest.includedScopes.workspaceIds = ["../evil"];
    assert.equal(validateMemoryCenterSnapshotV1(snap2).ok, false);
  });

  test("rejects nested malicious source probe", () => {
    const snap = sampleSnapshot();
    snap.personal.entries = [
      {
        id: "m1",
        rev: 1,
        topic: "t",
        kind: "fact",
        text: "x",
        basis: "user_said",
        confidence: 0.5,
        source: { chatId: { nested: "evil" } },
        createdAt: "2026-10-18T12:00:00.000Z",
        updatedAt: "2026-10-18T12:00:00.000Z",
        seen: 0,
      },
    ] as unknown as MemoryCenterSnapshotV1["personal"]["entries"];
    assert.equal(validateMemoryCenterSnapshotV1(snap).ok, false);
    const snap2 = sampleSnapshot();
    snap2.personal.entries = [
      {
        id: "m2",
        rev: 1,
        topic: "t",
        kind: "fact",
        text: "x",
        basis: "user_said",
        confidence: 0.5,
        source: { chatId: "c1", turn: 1, chatDeleted: true, extra: "nope" },
        createdAt: "2026-10-18T12:00:00.000Z",
        updatedAt: "2026-10-18T12:00:00.000Z",
        seen: 0,
      },
    ] as unknown as MemoryCenterSnapshotV1["personal"]["entries"];
    assert.equal(validateMemoryCenterSnapshotV1(snap2).ok, false);
  });

  test("rejects confidence out of range and nested supplements", () => {
    const snap = sampleSnapshot();
    snap.personal.entries = [
      {
        id: "m1",
        rev: 1,
        topic: "t",
        kind: "fact",
        text: "x",
        basis: "user_said",
        confidence: 1.5,
        source: null,
        validFrom: null,
        validUntil: null,
        createdAt: "2026-10-18T12:00:00.000Z",
        updatedAt: "2026-10-18T12:00:00.000Z",
        lastUsedAt: null,
        invalidAt: null,
        invalidReason: null,
        supplements: [{ nested: true }],
        seen: 0,
      },
    ] as unknown as MemoryCenterSnapshotV1["personal"]["entries"];
    assert.equal(validateMemoryCenterSnapshotV1(snap).ok, false);
  });

  test("deterministic stringify stable", () => {
    const inc = sampleSnapshot().manifest.includedScopes;
    const a = snapshotPayloadForChecksum({ ...sampleSnapshot(), manifest: { checksum: "", includedScopes: inc } });
    const b = snapshotPayloadForChecksum({ ...sampleSnapshot(), manifest: { checksum: "", includedScopes: inc } });
    assert.equal(a, b);
  });
});
