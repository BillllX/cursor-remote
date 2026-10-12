// 工具调用辅助：shell 输出增量、工具参数展示与脱敏、编辑记录、写入/越界/发布判断
import { resolve } from "node:path";
import type { WebSocket } from "ws";
import type { Slot } from "../runtime/types.ts";
import { workspacePath } from "../workspace/files.ts";
import { send } from "../ws/send.ts";
import { isRecord } from "./history.ts";

function shellToolName(name: string) {
  return /(shell|bash|terminal|command)/i.test(name);
}

export function rememberShellCall(slot: Slot, name: string, callId: string) {
  if (shellToolName(name) && callId) slot.lastShellCallId = callId;
}

export function snapshotFromResult(result: unknown): { stdout?: string; stderr?: string } {
  if (typeof result === "string" && result) return { stdout: result };
  if (!isRecord(result)) return {};
  const inner = isRecord(result.value) ? result.value : isRecord(result.result) ? result.result : result;
  const stdout =
    typeof inner.stdout === "string"
      ? inner.stdout
      : typeof inner.output === "string"
        ? inner.output
        : typeof inner.text === "string"
          ? inner.text
          : "";
  const stderr = typeof inner.stderr === "string" ? inner.stderr : "";
  return {
    stdout: stdout || undefined,
    stderr: stderr || undefined,
  };
}

export function parseShellDelta(event: Record<string, unknown>): {
  callId: string;
  stream: "stdout" | "stderr";
  chunk: string;
} | null {
  const callId = String(event.callId || event.call_id || event.toolCallId || event.tool_call_id || event.id || "");
  const stream: "stdout" | "stderr" =
    event.stream === "stderr" || (typeof event.stderr === "string" && event.stderr && !event.stdout)
      ? "stderr"
      : "stdout";
  let chunk = "";
  if (typeof event.chunk === "string") chunk = event.chunk;
  else if (typeof event.data === "string") chunk = event.data;
  else if (typeof event.text === "string") chunk = event.text;
  else if (stream === "stderr" && typeof event.stderr === "string") chunk = event.stderr;
  else if (typeof event.stdout === "string") chunk = event.stdout;
  else if (typeof event.output === "string") chunk = event.output;
  if (!chunk) return null;
  return { callId, stream, chunk };
}

export function emitToolOutput(
  ws: WebSocket,
  slot: Slot,
  payload: {
    callId?: string;
    stream?: "stdout" | "stderr";
    chunk?: string;
    stdout?: string;
    stderr?: string;
  },
) {
  const callId = payload.callId || slot.lastShellCallId;
  if (!callId) return;
  if (!payload.chunk && payload.stdout == null && payload.stderr == null) return;
  send(ws, {
    type: "tool-output",
    chatId: slot.chatId,
    callId,
    stream: payload.stream,
    chunk: payload.chunk,
    stdout: payload.stdout,
    stderr: payload.stderr,
  });
}

function isAskQuestionTool(name: string): boolean {
  return /ask.?question/i.test(name);
}

/// 提问工具的选项必须原样送到客户端。通用摘要会把 questions 丢掉，界面就只剩一次突然结束。
export function presentToolArgs(name: string, args: unknown): unknown {
  if (!isAskQuestionTool(name)) return summarizeToolArgs(args);
  const asked = sanitizeAskArgs(args);
  return asked ?? summarizeToolArgs(args);
}

function sanitizeAskArgs(args: unknown): { title: string; questions: unknown[] } | null {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const nested = record?.args && typeof record.args === "object" ? (record.args as Record<string, unknown>) : null;
  const source = nested?.questions ? nested : record;
  if (!source) return null;
  const raw = Array.isArray(source.questions) ? source.questions : [];
  const questions = raw.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const prompt = typeof row.prompt === "string" ? row.prompt.slice(0, 500) : "";
    if (!prompt) return [];
    const id = typeof row.id === "string" && row.id ? row.id.slice(0, 80) : prompt.slice(0, 40);
    const allowMultiple = row.allow_multiple === true || row.allowMultiple === true;
    const options = (Array.isArray(row.options) ? row.options : []).slice(0, 12).flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const opt = option as Record<string, unknown>;
      const label = typeof opt.label === "string" ? opt.label.slice(0, 200) : "";
      if (!label) return [];
      const optionId = typeof opt.id === "string" && opt.id ? opt.id.slice(0, 80) : label.slice(0, 40);
      return [{ id: optionId, label }];
    });
    return [{ id, prompt, allowMultiple, options }];
  });
  if (!questions.length) return null;
  const title = typeof source.title === "string" ? source.title.slice(0, 200) : "";
  return { title, questions };
}

export function summarizeToolArgs(args: unknown): unknown {
  if (args == null || typeof args !== "object") return args;
  const record = args as Record<string, unknown>;
  const keep = [
    "path",
    "file",
    "target",
    "file_path",
    "command",
    "pattern",
    "query",
    "cwd",
    "old_string",
    "new_string",
    "oldString",
    "newString",
    "oldText",
    "newText",
    "contents",
    "content",
    "diff",
    "patch",
    "description",
    "title",
    "prompt",
    "subagent_type",
    "subagentType",
    "name",
    "agent",
    "model",
    "readonly",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    if (key in record) out[key] = record[key];
  }
  if (typeof out.prompt === "string" && out.prompt.length > 500) {
    out.prompt = `${out.prompt.slice(0, 500)}\n…`;
  }
  return Object.keys(out).length ? out : args;
}

export function pathFromTool(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "target", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

export function rememberEdit(slot: Slot, name: string, args: unknown, cwd?: string) {
  if (!isMutatingTool(name, args)) return;
  const raw = pathFromTool(args);
  const path = cwd ? workspacePath(cwd, raw) || raw : raw;
  if (path && !slot.edited.includes(path)) slot.edited.push(path);
}

export function shellPublishes(name: string, args: unknown) {
  if (!/(shell|bash|terminal|command)/i.test(name)) return false;
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const cmd = typeof record.command === "string" ? record.command : "";
  return /(?:^|[\s;|&`'"(])(?:\S*\/)?jiebo-publish\b/.test(cmd);
}

export function isMutatingTool(name: string, args: unknown): boolean {
  const n = name.toLowerCase();
  if (/todo|createplan/.test(n)) return false;
  if (/(write|strreplace|apply.?patch|editnotebook|delete|unlink|createfile)/.test(n)) {
    return true;
  }
  if (/(^|[^a-z])edit([^a-z]|$)/.test(n) && !/read/.test(n)) return true;
  if (/(shell|bash|terminal|command)/.test(n)) {
    const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const cmd = typeof record.command === "string" ? record.command : "";
    return /(^|\s)(rm|mv|cp|chmod|chown|sudo|mkdir|touch|tee|dd|truncate|git\s+(add|commit|push|reset|checkout)|npm\s+i(nstall)?|pnpm\s+add|yarn\s+add|pip\s+install)\b/i.test(
      cmd,
    );
  }
  return false;
}

export function toolEscapesWorkspace(cwd: string, name: string, args: unknown): boolean {
  const raw = pathFromTool(args);
  if (raw && !workspacePath(cwd, raw)) return true;
  if (!/(shell|bash|terminal|command)/i.test(name)) return false;
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const working = typeof record.working_directory === "string" ? record.working_directory : "";
  // workspacePath 对工作区根本身返回 null，"." 或根的绝对路径不算越界
  if (working && resolve(cwd, working) !== resolve(cwd) && !workspacePath(cwd, working)) return true;
  const cmd = typeof record.command === "string" ? record.command : "";
  if (!cmd) return false;
  for (const match of cmd.matchAll(/(?:^|[\s;|&])(?:\d*>{1,2}|tee(?:\s+-a)?)\s*(\/[^\s;|&]+)/g)) {
    const abs = match[1];
    if (abs === "/dev/null" || abs.startsWith("/dev/")) continue;
    if (!workspacePath(cwd, abs)) return true;
  }
  return false;
}
