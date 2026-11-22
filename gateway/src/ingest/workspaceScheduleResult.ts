import { assistantPath, clip, type TenantRef } from "../assistant/store.ts";
import type { WorkspaceScheduleRunStatus } from "./workspaceScheduleTypes.ts";

export const WORKSPACE_RESULT_KEY_PREFIX = "workspace-result:";

export function workspaceScheduleRunsPath(ref: TenantRef) {
  return assistantPath(ref, "workspace-schedule-runs.jsonl");
}

export function workspaceRunAttention(status: WorkspaceScheduleRunStatus) {
  return status === "succeeded" || status === "no_change" ? "notice" : "recovery";
}

export function isStructuredScriptOutput(text: string): boolean {
  // 旧运行器会把 JSON 截断并追加省略号，无法再完整解析。
  return /^(?:\{\s*(?:"|\})|\[\s*(?:\[|\]|[{"\d-]|true\b|false\b|null\b))/u.test(text.trim());
}

export function summarizeSuccessfulScriptOutput(stdout: string): string {
  const text = stdout.trim();
  if (!text) return "脚本执行成功。";
  if (!isStructuredScriptOutput(text)) return clip(text, 300);

  try {
    const output: unknown = JSON.parse(text);
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const fields = output as Record<string, unknown>;
      for (const field of ["summary", "摘要", "说明"]) {
        const value = fields[field];
        if (typeof value === "string" && value.trim() && !isStructuredScriptOutput(value)) {
          return clip(value, 300);
        }
      }
    }
  } catch {
    // 历史正文可能只保存了机器输出的前缀。
    if (!text.endsWith("…")) return clip(text, 300);
  }
  return "脚本执行成功。可查看本次运行记录。";
}
