// 回合：结算（收尾未结束的工具）、服务端回合/快照/历史合并、待办提取
import type { HistoryTurn, ServerMessage } from "@shared/protocol";
import { mutatingTool } from "../../components/ToolCard";
import { pathFromPayload } from "./tools";
import type { TodoItem, Turn } from "./types";

export function uid() {
  return crypto.randomUUID();
}

export function extractTodos(name: string, payload: unknown): TodoItem[] | null {
  if (!/todo/i.test(name)) return null;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const list = record.todos ?? record.items ?? record.merge;
  if (!Array.isArray(list)) return null;
  const items = list
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const content = typeof row.content === "string" ? row.content : typeof row.text === "string" ? row.text : "";
      if (!content) return null;
      return {
        id: typeof row.id === "string" ? row.id : String(index),
        content,
        status: typeof row.status === "string" ? row.status : "pending",
      };
    })
    .filter((item): item is TodoItem => Boolean(item));
  return items.length ? items : null;
}

export function turnSuperseded(turns: Turn[], index: number) {
  const turn = turns[index];
  const next = turns[index + 1];
  if (!turn?.error || turn.running) return false;
  if (turn.assistant.trim()) return false;
  if (turn.tools.some((tool) => !/todo/i.test(tool.name))) return false;
  return Boolean(next && next.user.trim() === turn.user.trim());
}

export function editPathsOf(turn: Turn): string[] {
  const paths: string[] = [];
  for (const tool of turn.tools) {
    if (!mutatingTool(tool.name)) continue;
    const path = pathFromPayload(tool.args) || pathFromPayload(tool.result);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function rejectMutatingTools(turn: Turn): Turn {
  return {
    ...turn,
    pendingTool: undefined,
    tools: turn.tools.map((tool) => (mutatingTool(tool.name) ? { ...tool, review: tool.review || "rejected" } : tool)),
  };
}

export function turnHasOpenTools(turn: Turn) {
  return turn.tools.some((tool) => tool.status === "running");
}

function settleOpenTools(turn: Turn, toolStatus: "completed" | "error"): Turn {
  if (!turnHasOpenTools(turn) && !turn.running && !turn.queued && !turn.pendingTool) return turn;
  return {
    ...turn,
    running: false,
    queued: false,
    pendingTool: undefined,
    tools: turn.tools.map((tool) => (tool.status === "running" ? { ...tool, status: toolStatus } : tool)),
  };
}

export function settleTurn(turn: Turn, status?: string, durationMs?: number): Turn {
  const key = (status || turn.status || "").toLowerCase();
  if (key === "approval") {
    return {
      ...turn,
      running: false,
      queued: false,
      status: status || turn.status,
      durationMs: durationMs ?? turn.durationMs,
    };
  }
  const failed = key === "cancelled" || key === "canceled" || key === "error";
  return {
    ...settleOpenTools(turn, failed ? "error" : "completed"),
    status: status || turn.status,
    durationMs: durationMs ?? turn.durationMs,
  };
}

export function writesWereRejected(turn: Turn) {
  return /已拒绝写入/.test(`${turn.assistant || ""}\n${turn.status || ""}`);
}

export function liveTurn(turn: Turn): boolean {
  return Boolean(turn.running || turn.queued || turn.pendingTool);
}

export function serverTurn(raw: unknown): Turn | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<Turn>;
  if (typeof row.id !== "string" || !row.id) return null;
  const tools = Array.isArray(row.tools) ? row.tools : [];
  const turn: Turn = {
    ...(row as Turn),
    user: typeof row.user === "string" ? row.user : "",
    assistant: typeof row.assistant === "string" ? row.assistant : "",
    thinking: typeof row.thinking === "string" ? row.thinking : "",
    tools,
    running: Boolean(row.running),
  };
  if (!turn.todos) {
    let todos: TodoItem[] | null = null;
    for (const tool of tools) {
      todos = extractTodos(tool.name, tool.args) || extractTodos(tool.name, tool.result) || todos;
    }
    if (todos) turn.todos = todos;
  }
  return turn;
}

/** 服务端正文为准；本地还在跑、排队或待批的回合保留本地版本，服务端没有的接在末尾。 */
export function withLiveTurns(local: Turn[], server: Turn[]): Turn[] {
  const live = local.filter(liveTurn);
  if (!live.length) return server;
  const byId = new Map(live.map((turn) => [turn.id, turn]));
  const out = server.map((turn) => byId.get(turn.id) ?? turn);
  const seen = new Set(out.map((turn) => turn.id));
  for (const turn of live) if (!seen.has(turn.id)) out.push(turn);
  return out;
}

export function historyToTurns(items: HistoryTurn[]): Turn[] {
  return items.map((item) => ({
    id: item.id || uid(),
    user: item.user || "",
    assistant: item.assistant || "",
    thinking: item.thinking || "",
    tools: (item.tools || []).map((tool) => ({
      callId: tool.callId || uid(),
      name: tool.name,
      args: tool.args,
      result: tool.result,
      status: tool.status === "running" ? "completed" : tool.status,
      parentCallId: tool.parentCallId,
      agent: tool.agent,
      model: tool.model,
    })),
    running: false,
  }));
}

function mergeTools(local: Turn["tools"], remote: Turn["tools"]): Turn["tools"] {
  const out = [...local];
  for (const tool of remote) {
    const index = out.findIndex(
      (item) =>
        item.callId === tool.callId ||
        (item.name === tool.name && JSON.stringify(item.args) === JSON.stringify(tool.args)),
    );
    if (index < 0) {
      out.push({ ...tool, status: tool.status === "running" ? "completed" : tool.status });
      continue;
    }
    if (!out[index].result && tool.result) {
      out[index] = {
        ...out[index],
        result: tool.result,
        status: tool.status === "running" ? out[index].status : tool.status,
        parentCallId: out[index].parentCallId || tool.parentCallId,
        agent: out[index].agent || tool.agent,
        model: out[index].model || tool.model,
      };
    }
  }
  return out;
}

function userFingerprint(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, 240);
}

export function applyRunSnapshot(turns: Turn[], message: Extract<ServerMessage, { type: "run_snapshot" }>): Turn[] {
  const next = turns.slice();
  const queued = message.queued || [];
  const skipBody = !message.turnId && !message.userText && !message.assistant;
  if (!skipBody) {
    let index = message.turnId ? next.findIndex((turn) => turn.id === message.turnId) : -1;
    if (index < 0 && message.userText) {
      const fp = userFingerprint(message.userText);
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (userFingerprint(next[i].user) === fp) {
          index = i;
          break;
        }
      }
    }
    const tools = (message.tools || []).map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      args: tool.args,
      result: tool.result,
      status: tool.status,
      parentCallId: tool.parentCallId,
      agent: tool.agent,
      model: tool.model,
    }));
    if (index < 0) {
      const created: Turn = {
        id: message.turnId || uid(),
        user: message.userText,
        assistant: message.clipped ? "" : message.assistant,
        thinking: message.clipped ? "" : message.thinking || "",
        tools: message.clipped ? [] : tools,
        task: message.task,
        running: message.phase === "running",
        queued: false,
        mode: message.mode,
        model: message.model,
        status: message.phase === "done" ? message.status : undefined,
        durationMs: message.durationMs,
        pendingTool: message.awaitingApproval,
      };
      next.push(
        message.phase === "done" ? settleTurn(created, message.status || "finished", message.durationMs) : created,
      );
    } else {
      const cur = next[index];
      const replaced: Turn = {
        ...cur,
        assistant:
          message.clipped || message.assistant.length < cur.assistant.length ? cur.assistant : message.assistant,
        thinking:
          message.clipped || (message.thinking || "").length < (cur.thinking || "").length
            ? cur.thinking
            : message.thinking || "",
        tools: message.clipped || tools.length < cur.tools.length ? cur.tools : tools,
        task: message.task || cur.task,
        model: message.model || cur.model,
        mode: message.mode || cur.mode,
        running: message.phase === "running",
        queued: false,
        pendingTool: message.phase === "running" ? message.awaitingApproval : undefined,
      };
      next[index] =
        message.phase === "done" ? settleTurn(replaced, message.status || "finished", message.durationMs) : replaced;
    }
  }
  for (const item of queued) {
    if (item.turnId && next.some((turn) => turn.id === item.turnId)) continue;
    const fp = userFingerprint(item.userText);
    if (fp && next.some((turn) => userFingerprint(turn.user) === fp && (turn.queued || turn.running))) continue;
    next.push({
      id: item.turnId || uid(),
      user: item.userText,
      assistant: "",
      thinking: "",
      tools: [],
      running: false,
      queued: true,
    });
  }
  return next;
}

export function mergeHistoryTurns(local: Turn[], incoming: Turn[]): Turn[] {
  if (!incoming.length) return local;
  const localHasContent = local.some((turn) => turn.user.trim() || turn.assistant.trim() || turn.tools.length);
  if (!localHasContent) return incoming;
  const fingerprint = (turn: Turn) => turn.user.trim().replace(/\s+/g, " ").slice(0, 240);
  const merged = local.map((turn) => ({ ...turn }));
  const byFp = new Map<string, number>();
  merged.forEach((turn, index) => {
    const fp = fingerprint(turn);
    if (fp && !byFp.has(fp)) byFp.set(fp, index);
  });
  const prefix: Turn[] = [];
  let seenLocal = false;
  for (const remote of incoming) {
    const fp = fingerprint(remote);
    if (!fp) continue;
    const index = byFp.get(fp);
    if (index == null) {
      if (!seenLocal) prefix.push({ ...remote, running: false });
      continue;
    }
    seenLocal = true;
    const cur = merged[index];
    if (cur.running) continue;
    merged[index] = {
      ...cur,
      assistant: remote.assistant.length > cur.assistant.length ? remote.assistant : cur.assistant,
      thinking: (remote.thinking || "").length > (cur.thinking || "").length ? remote.thinking || "" : cur.thinking,
      tools: mergeTools(cur.tools, remote.tools),
    };
  }
  return prefix.length ? [...prefix, ...merged] : merged;
}
