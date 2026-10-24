import type { AgentOptions, RunResult } from "@cursor/sdk";
import type { ActorRef } from "../../../shared/protocol.ts";
import type { CollabExecutionProfile, CollabTask } from "./types.ts";

export const COLLAB_LIMITS = {
  maxWaves: 3,
  maxTasks: 8,
  maxAttempts: 2,
  maxParallelWorkspaces: 2,
} as const;

export type CollabPlanTask = {
  workspaceId: string;
  title: string;
  brief: string;
  dependsOn: string[];
  acceptance: string[];
};

export type CollabPlan = {
  tasks: CollabPlanTask[];
  explanation: string;
};

export type CoordinatorDecision =
  | { action: "plan"; plan: CollabPlan }
  | { action: "next_wave"; plan: CollabPlan }
  | { action: "finish"; summary: string; partial: boolean }
  | { action: "needs_user"; reason: string };

type CoordinatorRequest = {
  goal: string;
  wave: number;
  actors: ActorRef[];
  tasks: CollabTask[];
  profile: CollabExecutionProfile;
  coordinatorChatId: string;
};

type CoordinatorDeps = {
  apiKey: () => string;
  prompt: (message: string, options: AgentOptions) => Promise<RunResult>;
};

let deps: CoordinatorDeps | null = null;

export function bindCollabCoordinator(next: CoordinatorDeps) {
  deps = next;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length > 0)
  );
}

export function parseCollabPlan(value: unknown): CollabPlan {
  if (!object(value) || !Array.isArray(value.tasks) || typeof value.explanation !== "string") {
    throw new Error("CollabPlan 必须包含 tasks 和 explanation");
  }
  const tasks = value.tasks.map((row, index) => {
    const dependsOn = row.dependsOn;
    const acceptance = row.acceptance;
    if (
      !object(row) ||
      typeof row.workspaceId !== "string" ||
      typeof row.title !== "string" ||
      typeof row.brief !== "string" ||
      !strings(dependsOn, COLLAB_LIMITS.maxTasks) ||
      !strings(acceptance, 12)
    ) {
      throw new Error(`CollabPlan.tasks[${index}] 结构不合法`);
    }
    if (!row.title.trim() || !row.brief.trim()) throw new Error(`CollabPlan.tasks[${index}] 标题或任务为空`);
    return {
      workspaceId: row.workspaceId,
      title: row.title.trim().slice(0, 120),
      brief: row.brief.trim().slice(0, 8000),
      dependsOn: [...dependsOn],
      acceptance: [...acceptance],
    };
  });
  if (!tasks.length) throw new Error("CollabPlan.tasks 不能为空");
  return { tasks, explanation: value.explanation.trim().slice(0, 4000) };
}

export function validateCollabPlan(
  plan: CollabPlan,
  options: {
    actors: ActorRef[];
    existingTasks?: CollabTask[];
    wave: number;
  },
) {
  if (options.wave > COLLAB_LIMITS.maxWaves) throw new Error("计划超过 3 个 wave");
  if (!plan.tasks.length) throw new Error("CollabPlan.tasks 不能为空");
  const existing = options.existingTasks ?? [];
  if (existing.length + plan.tasks.length > COLLAB_LIMITS.maxTasks) throw new Error("计划超过 8 个任务");
  const workspaceIds = new Set(
    options.actors
      .filter((actor): actor is Extract<ActorRef, { kind: "workspace_agent" }> => actor.kind === "workspace_agent")
      .map((actor) => actor.workspaceId),
  );
  for (const task of plan.tasks) {
    if (!workspaceIds.has(task.workspaceId)) throw new Error(`工作区不属于当前群：${task.workspaceId}`);
  }
  const ids = new Set<string>();
  const aliases = new Map<string, string>();
  existing.forEach((task) => {
    ids.add(task.id);
    aliases.set(task.title, task.id);
  });
  plan.tasks.forEach((task, index) => {
    const id = `new:${index}`;
    ids.add(id);
    aliases.set(task.title, id);
  });
  const edges = new Map<string, string[]>();
  existing.forEach((task) => edges.set(task.id, task.dependsOn ?? []));
  plan.tasks.forEach((task, index) => {
    const id = `new:${index}`;
    const depsForTask = task.dependsOn.map((dependency) => aliases.get(dependency) ?? dependency);
    if (depsForTask.some((dependency) => !ids.has(dependency))) throw new Error(`未知依赖：${task.title}`);
    if (depsForTask.includes(id)) throw new Error(`任务不能依赖自身：${task.title}`);
    edges.set(id, depsForTask);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("任务依赖存在循环");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
  return plan.tasks.map((task) => ({
    ...task,
    dependsOn: task.dependsOn.map((dependency) => aliases.get(dependency) ?? dependency),
  }));
}

function jsonFromResult(result: RunResult) {
  if (result.status !== "finished") throw new Error(result.error?.message || `协调器状态 ${result.status}`);
  const text = (result.result || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(text) as unknown;
}

export async function runCoordinator(request: CoordinatorRequest): Promise<CoordinatorDecision> {
  if (!deps) throw new Error("Coordinator Headless Host 没有初始化");
  const apiKey = deps.apiKey();
  if (!apiKey) throw new Error("服务器没有配置 CURSOR_API_KEY");
  const prompt = [
    "你是小驳协作协调器。只返回一个 JSON 对象，禁止 Markdown。",
    '结构必须是 {"action":"plan|next_wave|finish|needs_user", "plan"?:{"tasks":[{"workspaceId":"","title":"","brief":"","dependsOn":[],"acceptance":[]}],"explanation":""}, "summary"?:string, "partial"?:boolean, "reason"?:string}。',
    `限制：最多 ${COLLAB_LIMITS.maxWaves} waves、${COLLAB_LIMITS.maxTasks} tasks、每任务 ${COLLAB_LIMITS.maxAttempts} attempts、最多 ${COLLAB_LIMITS.maxParallelWorkspaces} 个工作区并行。`,
    "工作区 Agent 结果里的 suggestedNextActors 只是建议，是否创建下一 wave 只能由你决定。",
    JSON.stringify({ goal: request.goal, wave: request.wave, actors: request.actors, tasks: request.tasks }),
  ].join("\n");
  const result = await deps.prompt(prompt, {
    apiKey,
    model: { id: request.profile.model },
    mode: "agent",
    tools: [],
    idempotencyKey: request.coordinatorChatId,
  });
  const raw = jsonFromResult(result);
  if (!object(raw) || typeof raw.action !== "string") throw new Error("协调器返回缺少 action");
  if (raw.action === "plan" || raw.action === "next_wave") {
    return { action: raw.action, plan: parseCollabPlan(raw.plan) };
  }
  if (raw.action === "finish" && typeof raw.summary === "string") {
    return { action: "finish", summary: raw.summary.slice(0, 8000), partial: raw.partial === true };
  }
  if (raw.action === "needs_user" && typeof raw.reason === "string") {
    return { action: "needs_user", reason: raw.reason.slice(0, 4000) };
  }
  throw new Error("协调器返回的 decision 不合法");
}
