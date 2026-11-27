import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assessDelegationDelivery } from "../src/assistant/delegationDelivery.ts";
import {
  computeTurnFiles,
  fingerprintExpectedFiles,
  readSnapshotFile,
  sha256,
} from "../src/turnFiles.ts";

const shellTool = (command: string) => ({
  callId: `bash-${Math.random().toString(16).slice(2)}`,
  name: "Bash",
  status: "completed" as const,
  args: { command },
});

function tempDir(name: string) {
  const dir = join(tmpdir(), `expected-turn-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("无全树基线时脚本改动的 expectedFiles 可补采并通过验收", () => {
  const cwd = tempDir("cwd");
  const stateDir = tempDir("state");
  writeFileSync(resolve(cwd, "AGENTS.md"), "old agents\n");
  const baseline = fingerprintExpectedFiles(cwd, ["AGENTS.md", "归档说明.md", ".jiebo/memory.md"]);
  writeFileSync(resolve(cwd, "AGENTS.md"), "new agents\n");
  writeFileSync(resolve(cwd, "归档说明.md"), "# 归档\n");
  mkdirSync(resolve(cwd, ".jiebo"), { recursive: true });
  writeFileSync(resolve(cwd, ".jiebo/memory.md"), "memory line\n");

  const files = computeTurnFiles({
    cwd,
    stateDir,
    tools: [shellTool("python patch.py")],
    baseline: null,
    fallbackDiff: () => null,
    expectedWatch: {
      paths: ["AGENTS.md", "归档说明.md", ".jiebo/memory.md"],
      baseline,
    },
  });
  const paths = files.map((file) => file.path).sort();
  assert.deepEqual(paths, [".jiebo/memory.md", "AGENTS.md", "归档说明.md"]);
  for (const file of files) {
    assert.ok(file.sha);
    assert.equal(readSnapshotFile(stateDir, file.path, file.sha!).error, undefined);
  }
  const canOpen = (file: (typeof files)[number]) =>
    Boolean(file.sha && !readSnapshotFile(stateDir, file.path, file.sha!).error);
  const verdict = assessDelegationDelivery(
    "已更新",
    { requiresFile: true, expectedFiles: ["AGENTS.md", "归档说明.md", ".jiebo/memory.md"] },
    files,
    canOpen,
  );
  assert.equal(verdict.ok, true);
});

test("expectedFiles 本轮未改动时不补采、验收仍失败", () => {
  const cwd = tempDir("unchanged");
  const stateDir = tempDir("state-u");
  const body = "steady\n";
  writeFileSync(resolve(cwd, "AGENTS.md"), body);
  const baseline = fingerprintExpectedFiles(cwd, ["AGENTS.md"]);

  const files = computeTurnFiles({
    cwd,
    stateDir,
    tools: [shellTool("true")],
    baseline: null,
    fallbackDiff: () => null,
    expectedWatch: { paths: ["AGENTS.md"], baseline },
  });
  assert.deepEqual(files, []);
  const verdict = assessDelegationDelivery(
    "嘴上交付",
    { expectedFiles: ["AGENTS.md"] },
    files,
    () => true,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.text, /AGENTS\.md/);
  assert.equal(sha256(body), baseline.get("AGENTS.md")?.sha);
});

test("expectedFiles 不存在或符号链接越界时不补采", () => {
  const cwd = tempDir("symlink");
  const stateDir = tempDir("state-s");
  const outside = tempDir("outside");
  writeFileSync(resolve(outside, "secret.md"), "x\n");
  symlinkSync(resolve(outside, "secret.md"), resolve(cwd, "外链.md"));
  const baseline = fingerprintExpectedFiles(cwd, ["缺失.md", "外链.md"]);

  const files = computeTurnFiles({
    cwd,
    stateDir,
    tools: [],
    baseline: null,
    fallbackDiff: () => null,
    expectedWatch: { paths: ["缺失.md", "外链.md"], baseline },
  });
  assert.deepEqual(files, []);
  assert.equal(baseline.get("缺失.md")?.exists, false);
  assert.equal(baseline.get("外链.md")?.exists, false);
});