import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delegationFollowUp, delegationFollowUpId } from "../../shared/delegationHandoff.ts";
import type { TurnFile } from "../../shared/protocol.ts";
import { assessDelegationDelivery, normalizeExpectedFiles } from "../src/assistant/delegationDelivery.ts";
import { readSnapshotFile, storeArtifact } from "../src/turnFiles.ts";

test("有指定交付文件时，只认可本轮可打开的快照；历史或错路径不会通过", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "delegate-delivery-"));
  try {
    const sha = storeArtifact(stateDir, Buffer.from("# 三农信投诉复核\n")).sha;
    const canOpen = (file: TurnFile) => Boolean(file.sha && !readSnapshotFile(stateDir, file.path, file.sha).error);
    const actual: TurnFile = { path: "投诉/复核.md", kind: "markdown", op: "added", sha };
    const required = { requiresFile: true, expectedFiles: [actual.path] };
    for (const files of [
      [],
      [{ ...actual, path: "另一份报告.md" }],
      [{ ...actual, sourceChatId: "other" }],
      [{ ...actual, sha: undefined }],
      [{ ...actual, sha: "0".repeat(64) }],
    ]) {
      const result = assessDelegationDelivery("已做好", required, files, canOpen);
      assert.equal(result.ok, false);
      assert.match(result.text, /投诉\/复核\.md/);
    }
    assert.deepEqual(assessDelegationDelivery("结论及来源", required, [actual], canOpen), {
      ok: true,
      text: "结论及来源",
    });
    assert.equal(assessDelegationDelivery("", {}, [], canOpen).ok, false);
    assert.equal(assessDelegationDelivery("纯文字结果", {}, [], canOpen).ok, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("工作区验收路径标准化，拒绝跨目录路径", () => {
  assert.deepEqual(normalizeExpectedFiles(["./投诉/复核.md", "投诉\\复核.md"]), ["投诉/复核.md"]);
  for (const input of ["../other/report.md", "/tmp/report.md", "C:\\report.md", "投诉/../../报告.md"]) {
    assert.throws(() => normalizeExpectedFiles([input]), /相对文件路径/);
  }
});

test("卡片续作显式携带原委派编号，普通文字不作为卡片动作", () => {
  const id = "d_a12f9";
  assert.equal(delegationFollowUpId(delegationFollowUp(id, "补上人行渠道\n说明口径")), id);
  assert.equal(delegationFollowUpId(`帮我看看 ${id}`), undefined);
  assert.equal(delegationFollowUpId("继续委派（d_a12f9）：   "), undefined);
});
