import type { AgentOptions, RunResult } from "@cursor/sdk";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function coordinatorResult(message: string) {
  const line = message.trim().split("\n").at(-1) || "{}";
  const request = JSON.parse(line) as {
    actors?: Array<{ kind?: string; workspaceId?: string }>;
    tasks?: Array<{ status?: string; wave?: number }>;
  };
  const workspaces = (request.actors ?? [])
    .filter((actor) => actor.kind === "workspace_agent" && actor.workspaceId)
    .map((actor) => actor.workspaceId as string);
  const tasks = request.tasks ?? [];
  if (!tasks.length) {
    return {
      action: "plan",
      plan: {
        explanation: "UI smoke：先由第一个工作区执行第一波。",
        tasks: [
          {
            workspaceId: workspaces[0],
            title: "第一波确定性任务",
            brief: "UI smoke multi-agent wave 1",
            dependsOn: [],
            acceptance: ["返回确定性结果"],
          },
        ],
      },
    };
  }
  const terminal = tasks.every((task) => ["succeeded", "failed", "cancelled", "blocked"].includes(task.status || ""));
  const maxWave = Math.max(...tasks.map((task) => task.wave ?? 1));
  if (terminal && maxWave === 1 && workspaces.length > 1) {
    return {
      action: "next_wave",
      plan: {
        explanation: "UI smoke：第一波完成，进入第二波。",
        tasks: [
          {
            workspaceId: workspaces[1],
            title: "第二波确定性任务",
            brief: "UI smoke multi-agent wave 2",
            dependsOn: [],
            acceptance: ["返回确定性结果"],
          },
        ],
      },
    };
  }
  return {
    action: "finish",
    summary: "UI smoke：多 Agent 两波任务均已完成。",
    partial: false,
  };
}

/** 只供 scripts/smoke/ui-smoke.sh 的隔离网关使用，禁止在线上配置对应密钥标记。 */
export async function uiSmokeCollabPrompt(message: string, _options: AgentOptions): Promise<RunResult> {
  if (message.startsWith("你是小驳协作协调器。")) {
    return {
      status: "finished",
      result: JSON.stringify(coordinatorResult(message)),
    } as RunResult;
  }
  await wait(1_200);
  return {
    status: "finished",
    result: JSON.stringify({ summary: `UI smoke Agent 结果：${message.trim().split("\n").at(-1) || "任务完成"}` }),
  } as RunResult;
}
