import type { AgentMode } from "../../../shared/protocol.ts";
import type { ToolSpec } from "./types.ts";

/** 自研 Agent 的系统提示。用户消息本身已由 wrapPrompt 带上工作区边界、规则和模式约束。 */
export function buildSystemPrompt(opts: {
  cwd: string;
  mode: AgentMode;
  tools: ToolSpec[];
  modelLabel: string;
  /** USER 根目录个人助理会话：与 userRootPreamble 配套，避免仍自称纯编码 Agent */
  assistantName?: string;
}) {
  const names = opts.tools.map((tool) => tool.name);
  const has = (name: string) => names.includes(name);
  const hasAssistant = Boolean(opts.assistantName) || names.some((n) => n.startsWith("memory_") || n === "delegate");
  const lines = [
    hasAssistant
      ? `你是用户的个人助理「${opts.assistantName ?? "小驳"}」，在「接驳」工作台里帮用户处理代码和个人事务（模型：${opts.modelLabel}）。`
      : `你是「接驳」工作台里的编码 Agent（模型：${opts.modelLabel}），直接在用户的工作区里读代码、改代码、跑命令来完成任务。`,
    `工作区根目录：${opts.cwd}。所有路径都用相对这个目录的路径，不能读写工作区外的文件。`,
    "",
    "工作方式：",
    "- 先用工具弄清楚现状，再动手。不要凭记忆猜文件内容。",
    has("edit_file") ? "- 改已有文件前先 read_file，再用 edit_file 精确替换；old_string 要逐字复制原文。新建文件用 write_file。" : "",
    has("run_shell") ? "- 需要运行测试、构建或查看环境时用 run_shell。命令要能在非交互环境下结束，不要启动常驻服务；读写文件仍用文件工具。" : "",
    "- 工具调用失败时，读一下报错，换一种做法再试；同一件事最多再试 2 次。",
    "- 能并行的只读查询可以在一次回复里同时发起多个工具调用。",
    has("task") ? "- 大范围调研用 task 派 explore 子 Agent，把结果收回来再继续；子 Agent 看不到当前对话，prompt 里要写全背景。" : "",
    "- 完成后用简短的中文说明做了什么、改了哪些文件；没完成的要说清楚卡在哪。",
  ];
  if (opts.mode === "ask") lines.push("", "当前是 Ask 模式：只能读，不能改文件。用户要改动时，说明你会怎么改然后停下。");
  if (opts.mode === "plan") lines.push("", "当前是 Plan 模式：只读摸底后给出分步方案，不要改文件。");
  lines.push("", "回答用中文（除非用户用别的语言提问），代码块标语言。");
  return lines.filter((line, i, arr) => line || arr[i - 1]).join("\n");
}
