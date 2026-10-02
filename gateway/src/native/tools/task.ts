import { buildSystemPrompt } from "../context.ts";
import { runNativeLoop, type NativeHooks, type NativeRunInput } from "../loop.ts";
import type { Adapter, ModelEndpoint, ModelTurn, ToolCall, ToolResult, ToolSpec } from "../types.ts";

const SUB_MAX_STEPS = 20;
const RESULT_CHARS = 8_000;

export type TaskOptions = {
  adapter: Adapter;
  endpoint: ModelEndpoint;
  modelLabel: string;
  /** 父级可用的工具（不含 task 本身，子 Agent 不能再派子 Agent） */
  tools: ToolSpec[];
  /** ask / plan 模式只能派只读的 explore */
  allowBuilder: boolean;
  maxSteps?: number;
  /** 与主 Agent 同一套上下文压缩 */
  compact?: NativeRunInput["hooks"]["compact"];
  /** 审批、拦截沿用父级；子 Agent 的工具调用也要记进父级的改动和计量 */
  hooks: Pick<NativeHooks, "needsApproval" | "vet" | "turn"> & {
    approve: (call: ToolCall, args: Record<string, unknown>, spec: ToolSpec, parentId: string) => Promise<boolean>;
    toolStarted?: (call: ToolCall, args: Record<string, unknown>, spec: ToolSpec | undefined, parentId: string, role: string) => void;
    toolCompleted?: (call: ToolCall, result: ToolResult, spec: ToolSpec | undefined, parentId: string) => void;
  };
};

function brief(args: Record<string, unknown>) {
  const pick = args.path ?? args.pattern ?? args.command ?? args.query;
  return typeof pick === "string" ? pick.slice(0, 80) : "";
}

/** 派一个子 Agent 独立完成一件事，只把最后的汇报交回给主 Agent */
export function taskTool(options: TaskOptions): ToolSpec {
  return {
    name: "task",
    category: "task",
    description:
      "派一个子 Agent 独立完成一件边界清楚的事，返回它的最终汇报。explore：只读调研（找代码、读文件、总结现状）；" +
      (options.allowBuilder ? "builder：按明确的要求改代码。" : "当前模式只能用 explore。") +
      "子 Agent 看不到当前对话，prompt 里要写清楚背景、目标和要交回什么。适合把大范围的调研从主对话里分出去，避免占满上下文。",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-8 个字的任务标题" },
        prompt: { type: "string", description: "交给子 Agent 的完整说明" },
        subagent_type: { type: "string", enum: options.allowBuilder ? ["explore", "builder"] : ["explore"], description: "默认 explore" },
      },
      required: ["prompt"],
    },
    run: async (args, ctx) => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return { ok: false, content: "缺少 prompt" };
      const role = args.subagent_type === "builder" && options.allowBuilder ? "builder" : "explore";
      const tools = role === "builder" ? options.tools : options.tools.filter((t) => t.category === "read" || t.category === "network");
      const system = [
        buildSystemPrompt({ cwd: ctx.cwd, mode: role === "builder" ? "agent" : "ask", tools, modelLabel: options.modelLabel }),
        "",
        `你是主 Agent 派出的子 Agent（${role}）。主 Agent 只看得到你最后一条回复：完成后用简洁的中文汇报结论、关键文件路径和没解决的问题。`,
      ].join("\n");
      const changed = new Set<string>();
      const parentId = ctx.callId || "task";
      const scope = (call: ToolCall): ToolCall => ({ ...call, id: `${parentId}/${call.id}` });
      const say = (line: string) => ctx.onOutput?.({ stdout: `${line}\n` });
      say(`子 Agent（${role}）开始：${typeof args.description === "string" ? args.description : prompt.slice(0, 40)}`);
      const result = await runNativeLoop({
        adapter: options.adapter,
        endpoint: options.endpoint,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        tools,
        cwd: ctx.cwd,
        signal: ctx.signal,
        maxSteps: options.maxSteps ?? SUB_MAX_STEPS,
        hooks: {
          compact: options.compact,
          text: () => {},
          thinking: () => {},
          toolStarted: (call, a, spec) => {
            const scoped = scope(call);
            say(`→ ${call.name} ${brief(a)}`);
            options.hooks.toolStarted?.(scoped, a, spec, parentId, role);
          },
          toolCompleted: (call, r, spec) => {
            const scoped = scope(call);
            for (const path of r.changed ?? []) changed.add(path);
            options.hooks.toolCompleted?.(scoped, r, spec, parentId);
          },
          needsApproval: options.hooks.needsApproval,
          approve: (call, a, spec) => options.hooks.approve(scope(call), a, spec, parentId),
          vet: options.hooks.vet,
          turn: (turn: ModelTurn, step: number) => options.hooks.turn?.(turn, step),
        },
      });
      if (result.status === "cancelled") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const last = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
      const report = last?.content.trim() || "（子 Agent 没有给出汇报）";
      const clipped = report.length > RESULT_CHARS ? `${report.slice(0, RESULT_CHARS)}\n…（汇报过长已截断）` : report;
      const files = [...changed];
      if (result.status === "denied") return { ok: false, content: "用户拒绝了子 Agent 的写操作。", changed: files, denied: true };
      if (result.status === "error") return { ok: false, content: `子 Agent 出错：${result.error || "未知错误"}`, changed: files };
      const tail = result.status === "max_steps" ? `\n\n（子 Agent 用满 ${result.steps} 步上限，可能没做完）` : "";
      return { ok: true, content: `${clipped}${tail}${files.length ? `\n\n改动的文件：${files.join("、")}` : ""}`, changed: files };
    },
  };
}
