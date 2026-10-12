// 工具调用的展示辅助：搜索词、一行预览、payload 里的路径、shell 命令与输出
import { toolKind } from "./toolKinds";
import type { ToolCall, Turn } from "./types";

export function searchQuery(tool: { args?: unknown }) {
  if (!tool.args || typeof tool.args !== "object") return "";
  const record = tool.args as Record<string, unknown>;
  for (const key of ["pattern", "query", "globPattern", "glob", "glob_pattern"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function toolPreview(name: string, args: unknown) {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const bits = [name];
  for (const key of ["path", "command", "file", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) {
      bits.push(String(record[key]).slice(0, 72));
      break;
    }
  }
  return bits.join(" · ");
}

export function pathFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["path", "file", "target", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

export function mergeToolOutput(
  result: unknown,
  message: { stream?: string; chunk?: string; stdout?: string; stderr?: string },
): unknown {
  const rec: Record<string, unknown> =
    result && typeof result === "object"
      ? { ...(result as Record<string, unknown>) }
      : { stdout: typeof result === "string" ? result : "", stderr: "" };
  if (typeof rec.stdout !== "string") rec.stdout = "";
  if (typeof rec.stderr !== "string") rec.stderr = "";
  if (message.stdout != null) rec.stdout = message.stdout;
  if (message.stderr != null) rec.stderr = message.stderr;
  if (message.chunk) {
    const key = message.stream === "stderr" ? "stderr" : "stdout";
    rec[key] = String(rec[key] || "") + message.chunk;
  }
  return rec;
}

function shellCommand(tool: ToolCall): string {
  const args = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {};
  for (const key of ["command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return tool.name;
}

function shellText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const inner =
    record.result && typeof record.result === "object" ? (record.result as Record<string, unknown>) : record;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = inner[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  return [pick("stdout", "output", "out", "text"), pick("stderr", "err")].filter(Boolean).join("\n");
}

export function shellRows(turns: Turn[]): { id: string; command: string; output: string; running: boolean }[] {
  const rows: { id: string; command: string; output: string; running: boolean }[] = [];
  for (const turn of turns) {
    for (const tool of turn.tools) {
      if (toolKind(tool.name, tool.args) !== "shell") continue;
      rows.push({
        id: tool.callId,
        command: shellCommand(tool),
        output: shellText(tool.result),
        running: tool.status === "running",
      });
    }
  }
  return rows;
}
