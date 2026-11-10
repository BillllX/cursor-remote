// 工具调用的展示辅助：搜索词、一行预览、payload 里的路径、shell 命令与输出
import { toolKind } from "./toolKinds";
import type { Chat, ToolCall, Turn } from "./types";
import { sameCwd } from "./workspace";

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

function pickArgString(args: unknown, ...keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function shellCommand(tool: ToolCall): string {
  return pickArgString(tool.args, "command", "cmd") || tool.name;
}

function extractShellResult(result: unknown): { stdout: string; stderr: string; exitCode?: string } {
  if (result == null) return { stdout: "", stderr: "" };
  if (typeof result === "string") return { stdout: result, stderr: "" };
  if (typeof result !== "object") return { stdout: "", stderr: "" };
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
  const pickExit = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = inner[key];
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return value.trim();
    }
    return undefined;
  };
  return {
    stdout: pick("stdout", "output", "out", "text"),
    stderr: pick("stderr", "err", "errorMessage", "error"),
    exitCode: pickExit("exitCode", "exit_code", "code", "status"),
  };
}

export type ShellStatusFilter = "all" | "running" | "failed" | "succeeded";

export type ShellRow = {
  id: string;
  command: string;
  output: string;
  stdout: string;
  stderr: string;
  exitCode?: string;
  status: "running" | "completed" | "error";
  running: boolean;
  failed: boolean;
  cwd?: string;
  description?: string;
  agent?: string;
  turnId: string;
  turnIndex: number;
  turnPrompt: string;
  chatId?: string;
  chatTitle?: string;
};

export function shellRows(turns: Turn[], chatMeta?: { chatId?: string; chatTitle?: string }): ShellRow[] {
  const rows: ShellRow[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const turnPrompt = (turn.user || "").trim().replace(/\s+/g, " ").slice(0, 80);
    for (const tool of turn.tools) {
      if (toolKind(tool.name, tool.args) !== "shell") continue;
      const { stdout, stderr, exitCode } = extractShellResult(tool.result);
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const running = tool.status === "running";
      const nonZeroExit = exitCode != null && exitCode !== "" && exitCode !== "0";
      const failed = !running && (tool.status === "error" || nonZeroExit);
      rows.push({
        id: tool.callId,
        command: shellCommand(tool),
        output,
        stdout,
        stderr,
        exitCode,
        status: tool.status,
        running,
        failed,
        cwd: pickArgString(tool.args, "working_directory", "cwd", "workdir", "dir"),
        description: pickArgString(tool.args, "description", "reason", "title"),
        agent: tool.agent,
        turnId: turn.id,
        turnIndex: i + 1,
        turnPrompt,
        chatId: chatMeta?.chatId,
        chatTitle: chatMeta?.chatTitle,
      });
    }
  }
  return rows;
}

export function workspaceShellRows(
  chats: Chat[],
  workspacePath: string,
  workspaceRoot: string,
  isAssistantChat?: (id?: string) => boolean,
): ShellRow[] {
  const rows: ShellRow[] = [];
  for (const chat of chats) {
    if (chat.id === "boot" || isAssistantChat?.(chat.id)) continue;
    const chatCwd = chat.cwd || workspaceRoot;
    if (workspacePath && !sameCwd(chatCwd, workspacePath)) continue;
    const chatRows = shellRows(chat.turns, {
      chatId: chat.id,
      chatTitle: chat.title || "新对话",
    });
    rows.push(...chatRows);
  }
  return rows;
}

export function filterShellRows(rows: ShellRow[], statusFilter: ShellStatusFilter, query: string): ShellRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (statusFilter === "running" && !row.running) return false;
    if (statusFilter === "failed" && !row.failed) return false;
    if (statusFilter === "succeeded" && (row.running || row.failed)) return false;
    if (!q) return true;
    const haystacks = [row.command, row.description, row.cwd, row.stdout, row.stderr, row.chatTitle, row.turnPrompt];
    return haystacks.some((text) => text && text.toLowerCase().includes(q));
  });
}
