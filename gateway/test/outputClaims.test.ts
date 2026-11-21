import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimOutputs, outputKeys, releaseOutputs } from "../src/outputClaims.ts";

test("以真实路径协调同一份产物，不锁工作区，也不声明区外链接", (t) => {
  const root = mkdtempSync(join(tmpdir(), "output-claims-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "业务");
  mkdirSync(join(workspace, "投诉"), { recursive: true });
  symlinkSync(join(workspace, "投诉"), join(workspace, "别名"));
  symlinkSync(root, join(workspace, "区外"));
  assert.throws(() => outputKeys(workspace, ["区外/报告.md"]));
  assert.throws(() => outputKeys(workspace, ["../报告.md"]));
  const report = outputKeys(workspace, ["投诉/月报.md"]);
  const alias = outputKeys(workspace, ["别名/月报.md"]);
  const other = outputKeys(workspace, ["临时核对.md"]);
  let running = true;
  assert.deepEqual(report, alias);
  assert.ok(claimOutputs(report, "scheduled", () => running));
  assert.equal(claimOutputs([...other, ...alias], "delegation"), false);
  assert.ok(claimOutputs(other, "other"));
  running = false;
  assert.ok(claimOutputs(alias, "delegation"));
  releaseOutputs(alias, "delegation");
  releaseOutputs(other, "other");
});
