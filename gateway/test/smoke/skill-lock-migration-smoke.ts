import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { prepareSkillLockRename, finishSkillLockRename, repairSkillLockPaths, verifySkill, useSkill } from "../../src/assistant/skills.ts";
const root = mkdtempSync(resolve(tmpdir(), "skill-migration-"));
const tenant = { id: "test", stateDir: resolve(root, "state"), workspaceRoot: resolve(root, "work") };
const lockFile = resolve(tenant.stateDir, "assistant/skill-lock.json");
const key = "old/.jiebo/skills/test-skill/SKILL.md";
const text = "---\nid: test-skill\nname: 测试技能\nsummary: 测试\nrequiredTools: [read]\n---\n正文\n";
const lock = { skillId: "test-skill", sha256: createHash("sha256").update(text.trim()).digest("hex"), approvedAt: "2026-01-01", proposalId: "p1", rev: 2 };
const json = (p: string, value: unknown) => writeFileSync(p, JSON.stringify(value));
const mapping = (name: string) => json(resolve(tenant.stateDir, "workspace-agent-chats.json"), { items: { [name]: { workspaceId: "wsa-test", path: resolve(tenant.workspaceRoot, name) } } });
function setup() {
  rmSync(tenant.stateDir, { recursive: true, force: true }); rmSync(tenant.workspaceRoot, { recursive: true, force: true });
  mkdirSync(resolve(tenant.stateDir, "assistant"), { recursive: true });
  mkdirSync(resolve(tenant.workspaceRoot, "old/.jiebo/skills/test-skill"), { recursive: true });
  writeFileSync(resolve(tenant.workspaceRoot, key), text);
  json(lockFile, { locks: { [key]: lock, "other/.jiebo/skills/test-skill/SKILL.md": { ...lock, proposalId: "unrelated" } } });
  json(resolve(tenant.stateDir, "assistant/skill-proposals.json"), { rev: 3, proposals: [{ id: "p1", status: "approved", relSkillPath: key, sha256: lock.sha256, skillId: lock.skillId }] });
  mapping("old");
}
function moved() { renameSync(resolve(tenant.workspaceRoot, "old"), resolve(tenant.workspaceRoot, "new")); mapping("new"); }
const plan = () => [{ from: "old", to: "new", workspaceId: "wsa-test", evidence: "测试：操作员明确确认历史归属", entries: { [key]: lock } }];
try {
  setup();
  const before = JSON.parse(readFileSync(lockFile, "utf8"));
  const receipt = prepareSkillLockRename(tenant, "old", "new", "wsa-test"); moved();
  finishSkillLockRename(tenant, receipt); const once = readFileSync(lockFile, "utf8"); finishSkillLockRename(tenant, receipt);
  assert.equal(readFileSync(lockFile, "utf8"), once);
  const after = JSON.parse(once); assert.deepEqual(after.locks["new/.jiebo/skills/test-skill/SKILL.md"], lock);
  assert.deepEqual(after.locks["other/.jiebo/skills/test-skill/SKILL.md"], before.locks["other/.jiebo/skills/test-skill/SKILL.md"]);
  assert.equal(verifySkill(tenant, resolve(tenant.workspaceRoot, "new"), "test-skill").health, "healthy");
  writeFileSync(resolve(tenant.workspaceRoot, "new/.jiebo/skills/test-skill/SKILL.md"), text + "修改");
  assert.equal(verifySkill(tenant, resolve(tenant.workspaceRoot, "new"), "test-skill").healthCode, "content_mismatch");
  assert.equal(useSkill(tenant, resolve(tenant.workspaceRoot, "new"), "test-skill").ok, false);
  console.log("通过：真实改名、审批字段保留、审计、重复执行、无关同 ID 锁不变、真实篡改阻断");
  setup(); moved();
  assert.equal(verifySkill(tenant, resolve(tenant.workspaceRoot, "new"), "test-skill").healthCode, "approval_unlinked");
  const original = readFileSync(lockFile, "utf8"); repairSkillLockPaths(tenant, plan()); assert.equal(readFileSync(lockFile, "utf8"), original);
  repairSkillLockPaths(tenant, plan(), true); const repaired = readFileSync(lockFile, "utf8"); repairSkillLockPaths(tenant, plan(), true); assert.equal(readFileSync(lockFile, "utf8"), repaired);
  console.log("通过：缺审批区分、受控修复预检不写、修复幂等");
  setup(); moved(); assert.throws(() => repairSkillLockPaths(tenant, [{ ...plan()[0]!, workspaceId: "other" }], true));
  const conflicting = JSON.parse(readFileSync(lockFile, "utf8")); conflicting.locks["new/.jiebo/skills/test-skill/SKILL.md"] = lock; json(lockFile, conflicting);
  assert.throws(() => repairSkillLockPaths(tenant, plan(), true));
  setup(); const pending = prepareSkillLockRename(tenant, "old", "new", "wsa-test");
  mkdirSync(resolve(tenant.workspaceRoot, "new")); mapping("new"); assert.throws(() => finishSkillLockRename(tenant, pending));
  setup(); moved(); const file = resolve(tenant.workspaceRoot, "new/.jiebo/skills/test-skill/SKILL.md"); rmSync(file); symlinkSync(lockFile, file); assert.throws(() => repairSkillLockPaths(tenant, plan(), true));
  setup(); moved(); json(resolve(tenant.stateDir, "assistant/skill-proposals.json"), { proposals: [] }); assert.throws(() => repairSkillLockPaths(tenant, plan(), true));
  console.log("通过：身份不符、目标冲突、非迁移复制、符号链接、缺原批准提案均拒绝");
  setup(); moved();
  writeFileSync(resolve(tenant.workspaceRoot, "new/.jiebo/skills/test-skill/SKILL.md"), text + "改变");
  const unchanged = readFileSync(lockFile, "utf8"); assert.throws(() => repairSkillLockPaths(tenant, plan(), true)); assert.equal(readFileSync(lockFile, "utf8"), unchanged);
  setup(); moved(); mkdirSync(resolve(tenant.workspaceRoot, "old"));
  json(resolve(tenant.stateDir, "workspace-agent-chats.json"), { items: {
    old: { workspaceId: "new-owner", path: resolve(tenant.workspaceRoot, "old") },
    new: { workspaceId: "wsa-test", path: resolve(tenant.workspaceRoot, "new") },
  } });
  assert.throws(() => repairSkillLockPaths(tenant, plan(), true));
  const vacant = statSync(resolve(tenant.workspaceRoot, "old"));
  const explicit = [{ ...plan()[0]!, vacantSource: { workspaceId: "new-owner", device: vacant.dev, inode: vacant.ino } }];
  writeFileSync(resolve(tenant.workspaceRoot, "old/new-data"), "新工作区资料");
  assert.throws(() => repairSkillLockPaths(tenant, explicit, true)); rmSync(resolve(tenant.workspaceRoot, "old/new-data"));
  repairSkillLockPaths(tenant, explicit, true);
  assert.equal(verifySkill(tenant, resolve(tenant.workspaceRoot, "new"), "test-skill").health, "healthy");
  console.log("通过：修复时内容改变零写入；旧名占用默认拒绝，仅明确 CAS 确认的不同身份空目录可修复");

} finally { rmSync(root, { recursive: true, force: true }); }
