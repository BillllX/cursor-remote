// 受控运维入口：默认只预检；--apply 仅用于已获用户明确授权的逐路径归属修复。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repairSkillLockPaths, type SkillLockRepairPlan } from "../gateway/src/assistant/skills.ts";
const [stateDir, workspaceRoot, planFile, flag] = process.argv.slice(2);
if (!stateDir || !workspaceRoot || !planFile || flag && flag !== "--apply") {
  throw new Error("用法：tsx scripts/repair-skill-lock-paths.ts <租户状态目录> <工作区根目录> <已确认归属的计划.json> [--apply]");
}
const plan = JSON.parse(readFileSync(planFile, "utf8")) as { tenantId: string; plans: SkillLockRepairPlan[] };
if (!plan.tenantId) throw new Error("计划必须指定 tenantId");
console.log(JSON.stringify(repairSkillLockPaths({ id: plan.tenantId, stateDir: resolve(stateDir), workspaceRoot: resolve(workspaceRoot) }, plan.plans, flag === "--apply"), null, 2));
