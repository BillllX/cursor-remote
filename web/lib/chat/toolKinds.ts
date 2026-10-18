// 工具调用的分类：按工具名（必要时看参数）归成 读/改/写/命令/搜索/其它
import { isDeleteToolName, isEditToolName, isWriteToolName } from "@shared/toolNames";
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function field(args: unknown, ...keys: string[]): string {
  const record = asRecord(args);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function toolKind(name: string, args?: unknown): "read" | "edit" | "write" | "shell" | "search" | "other" {
  const n = name.toLowerCase();
  if (/(todo|createplan)/.test(n)) return "other";
  if (/(shell|bash|terminal|command)/.test(n)) return "shell";
  if (/(grep|glob|search|find|ripgrep)/.test(n)) return "search";
  if (isEditToolName(name)) return "edit";
  if (isWriteToolName(name) || isDeleteToolName(name)) return "write";
  if (/(read|cat|open|getfile)/.test(n)) return "read";
  if (/(todo|task)/.test(n)) return "other";
  if (field(args, "globPattern", "glob", "glob_pattern", "pattern", "query")) return "search";
  return "other";
}

export function mutatingTool(name: string) {
  const kind = toolKind(name);
  return kind === "edit" || kind === "write";
}

/** 助理记忆检索/续期只服务模型上下文，不在 Web 回合里制造工具卡片。 */
export function silentAssistantTool(name: string) {
  const base =
    name
      .toLowerCase()
      .split(/__|[./:]/)
      .at(-1) || "";
  return (
    base.startsWith("memory_") ||
    base.startsWith("work_preference_") ||
    base === "workspace_memory_read" ||
    base === "workspace_memory_search" ||
    base === "workspace_memory_mark_used" ||
    base === "chat_search"
  );
}
