import { basename, resolve } from "node:path";
import { publishState } from "../assistant/service.ts";
import { listSkillProposals, listSkillSummaries, proposeSkillPackage } from "../assistant/skills.ts";
import { flushChat, proposeWorkspaceMemory } from "../assistant/workspaceMemory.ts";
import { buildDropTenantHost } from "../ingest/http.ts";
import { listWorkspaceSchedules, toggleWorkspaceSchedule } from "../ingest/workspaceSchedules.ts";
import type { Tenant } from "../tenants.ts";
import { updateWorkspaceAgentProfile, workspaceAgentById } from "./agents.ts";
import { WorkspaceShareError, type WorkspaceSharing } from "./sharing.ts";
import type { WorkspaceShareRequest } from "../../../shared/workspaceShare.ts";

function text(value: unknown, field: string, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    throw new WorkspaceShareError(`${field}不能为空且不得超过 ${limit} 字符`);
  return value.trim();
}

/** 只转发明确列出的工作区操作，禁止用所有者身份透传 assistant_op。 */
export function manageSharedWorkspace(sharing: WorkspaceSharing, actor: Tenant, request: WorkspaceShareRequest) {
  const { root, grant, owner } = sharing.resolveMember(actor, request.workspace);
  if (!grant.managers?.includes(actor.id)) throw new WorkspaceShareError("需要所有者授予工作区管理权限");
  const entry = workspaceAgentById(owner, grant.workspace);
  if (!entry) throw new WorkspaceShareError("这个工作区已不可访问", "UNAVAILABLE");
  const args = request.parameters ?? {};
  if (request.section === "skills") {
    if (request.operation === "propose") {
      const result = proposeSkillPackage(owner, root, {
        id: text(args.id, "技能 ID", 48),
        name: text(args.name, "技能名称", 80),
        summary: text(args.summary, "摘要", 200),
        body: text(args.body, "技能说明", 16_000),
        scope: "workspace",
        mode: "read",
      });
      if (!result.ok) throw new WorkspaceShareError(result.error);
      void publishState(owner);
      return { notice: "已提交技能提案，等待工作区所有者批准" };
    }
    if (request.operation !== "list") throw new WorkspaceShareError("技能操作无效");
    const skills = listSkillSummaries(owner, root, { includeChannelGuards: false })
      .slice(0, 100)
      .map(({ id, name, summary, health }) => ({ id, name, summary, health }));
    const proposals = listSkillProposals(owner)
      .filter((proposal) => resolve(proposal.targetDir) === root)
      .slice(-30)
      .map(({ id, name, status }) => ({ id, name, status }));
    return { skills, proposals };
  }
  if (request.section === "schedules") {
    const host = buildDropTenantHost(owner);
    const items = listWorkspaceSchedules(host, { workspace: grant.workspace }).filter(
      (item) => item.workspaceId === grant.workspace,
    );
    if (request.operation === "pause") {
      const id = text(args.id, "任务 ID", 100);
      if (!items.some((item) => item.id === id)) throw new WorkspaceShareError("此任务不属于当前工作区");
      const result = toggleWorkspaceSchedule(host, id, false, grant.workspace);
      if (!result.ok) throw new WorkspaceShareError(result.error);
      return { notice: "已暂停定时任务" };
    }
    if (request.operation !== "list") throw new WorkspaceShareError("新建、启用和运行所有者的定时任务需由所有者操作");
    return {
      schedules: items
        .slice(0, 100)
        .map(
          ({ id, title, enabled, scheduleMode, weeklyDays, dailyTimes, intervalMinutes, nextRunAt, lastStatus, executorKind }) => ({
            id,
            title,
            enabled,
            scheduleMode,
            weeklyDays,
            dailyTimes,
            intervalMinutes,
            nextRunAt,
            lastStatus,
            executorKind,
          }),
        ),
    };
  }
  if (request.section === "memory") {
    if (request.operation === "propose") {
      const chatId = `shared-memory:${grant.workspace}:${actor.id}`;
      const result = proposeWorkspaceMemory(
        owner,
        { chatId, cwd: root, section: "约定", text: text(args.text, "记忆内容", 2000) },
        { confirm: true },
      );
      if (!result.ok) throw new WorkspaceShareError(result.error || "无法提交记忆提案");
      if (!result.duplicate) flushChat(owner, chatId);
      void publishState(owner);
      return { notice: result.duplicate ? "已有相同的记忆或待确认提案" : "已提交记忆提案，等待工作区所有者批准" };
    }
    if (request.operation !== "list") throw new WorkspaceShareError("规则与记忆操作无效");
    return {
      rules: sharing.readSharedPolicy(actor, request.workspace, "rules"),
      memory: sharing.readSharedPolicy(actor, request.workspace, "memory"),
    };
  }
  if (request.section === "management") {
    if (request.operation === "rename") {
      const name = text(args.name, "显示名称", 80);
      if (!updateWorkspaceAgentProfile(owner, entry.path, name, undefined))
        throw new WorkspaceShareError("显示名称修改失败");
      return { notice: "已更新显示名称", name };
    }
    if (request.operation !== "list") throw new WorkspaceShareError("工作区设置操作无效");
    return { name: entry.item.displayName ?? basename(root), directory: basename(root), ownerName: owner.name };
  }
  throw new WorkspaceShareError("工作区功能不存在");
}
