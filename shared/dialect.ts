import { PUBLISH_BUILDER_ZH } from "./publishPrompt.ts";

const CHINESE_VENDORS = /glm|zhipu|kimi|moonshot|deepseek|qwen/;

export function usesChineseDialect(modelId: string): boolean {
  return CHINESE_VENDORS.test(modelId.trim().toLowerCase());
}

function vendorNote(modelId: string): string {
  const n = modelId.trim().toLowerCase();
  if (n.includes("deepseek")) return "不要为了快整段覆盖文件，只改需要改的地方。";
  if (n.includes("kimi") || n.includes("moonshot")) return "不要把大段无关文件贴进回复。";
  if (n.startsWith("glm") || n.includes("zhipu")) return "按用户说的范围做，不要顺手重构邻文件。";
  return "";
}

/**
 * Cursor SDK 公开工具名。不要写成 Claude 的 Edit/Write 或 Codex 的 apply_patch。
 * 只给中文系模型（glm / kimi / qwen / deepseek）。和骨架开关无关。
 */
export function dialectOverlay(modelId: string): string {
  if (!usesChineseDialect(modelId)) return "";
  const note = vendorNote(modelId);
  return [
    "用中文回答，先改再解释。",
    "工具名只用这些：read 读文件，grep 搜内容，glob 或 ls 找文件，edit 改文件，delete 删文件，shell 跑命令，task 派子代理。",
    "没有 apply_patch，也没有叫 Edit 或 Write 的工具。不要编造工具名。",
    "改代码走 edit。不要用 shell 的 sed、awk、tee、echo、重定向、python -c、heredoc 改文件。",
    "路径只用当前工作目录内的相对路径。",
    note,
  ]
    .filter(Boolean)
    .join("");
}

export function crewChinesePrompt(
  role: "explore" | "builder" | "reviewer",
  bound: string,
  overlay: string,
): string {
  const head = `${bound}${overlay ? `${overlay} ` : ""}`;
  if (role === "explore") {
    return `${head}你是只读探路。只用 read、grep、glob、ls 摸当前工作目录。不要 edit、delete，不要跑会改系统的 shell。用中文短报相关文件和发现。`;
  }
  if (role === "builder") {
    return `${head}你在当前工作目录落地改动。改文件用 edit，命令用 shell。不要写到工作区外。命令失败时同一件事最多再试 2 次，每次换一种做法，不要原样重复。仍失败且后面的步骤不依赖它，就继续做。做完用中文说明改了什么，以及哪一步没成。${PUBLISH_BUILDER_ZH}`;
  }
  return `${head}你交叉审查交给你的方案，或当前工作目录里的改动。读 diff 和周围代码，列出具体问题。不要重写功能，除非几行能修的致命 bug。用中文回复。`;
}
