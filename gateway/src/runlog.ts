import type { AgentMode, HistoryTurn, ServerMessage, TurnFile } from "../../shared/protocol.ts";

export type RunTool = NonNullable<HistoryTurn["tools"]>[number];

export type RunTranscript = {
  turnId: string;
  userText: string;
  images?: Array<{ data: string; mimeType: string }>;
  assistant: string;
  thinking: string;
  tools: RunTool[];
  task?: string;
  model?: string;
  mode?: AgentMode;
  awaitingApproval?: { callId: string; name: string; args?: unknown };
  status?: string;
  phase: "running" | "done";
  epoch: number;
  durationMs?: number;
  error?: string;
  /** 这一轮结束时算出的文件清单 */
  files?: TurnFile[];
};

/** 落在会话上的水位。短于它的上传不能盖掉这一回合。 */
export type RunMark = {
  turnId: string;
  assistantChars: number;
  thinkingChars: number;
  phase: "running" | "done";
  status?: string;
  userText: string;
};

const STREAM_TYPES = new Set([
  "text-delta",
  "thinking-delta",
  "tool-started",
  "tool-completed",
  "tool-output",
  "task",
  "run_meta",
  "approval",
  "error",
  "done",
]);

export function isStreamEvent(type: string) {
  return STREAM_TYPES.has(type);
}

export function markFromTranscript(transcript: RunTranscript): RunMark {
  return {
    turnId: transcript.turnId,
    assistantChars: transcript.assistant.length,
    thinkingChars: transcript.thinking.length,
    phase: transcript.phase,
    status: transcript.status,
    userText: transcript.userText,
  };
}

export function userFingerprint(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(turn: unknown, key: "assistant" | "thinking" | "user"): string {
  if (!isRecord(turn)) return "";
  const value = turn[key];
  return typeof value === "string" ? value : "";
}

export function readRunMark(chat: unknown): RunMark | null {
  if (!isRecord(chat) || !isRecord(chat.runMark)) return null;
  const row = chat.runMark;
  const turnId = typeof row.turnId === "string" ? row.turnId : "";
  if (!turnId) return null;
  const phase = row.phase === "done" ? "done" : "running";
  return {
    turnId,
    assistantChars: typeof row.assistantChars === "number" ? row.assistantChars : 0,
    thinkingChars: typeof row.thinkingChars === "number" ? row.thinkingChars : 0,
    phase,
    status: typeof row.status === "string" ? row.status : undefined,
    userText: typeof row.userText === "string" ? row.userText : "",
  };
}

function turnIdOf(turn: unknown) {
  if (!isRecord(turn)) return "";
  return typeof turn.id === "string" ? turn.id : "";
}

export function applyStreamEvent(transcript: RunTranscript, message: ServerMessage) {
  switch (message.type) {
    case "text-delta":
      transcript.assistant += message.text || "";
      break;
    case "thinking-delta":
      transcript.thinking += message.text || "";
      break;
    case "tool-started": {
      const next: RunTool = {
        callId: message.callId,
        name: message.name,
        args: capToolPayload(message.args),
        status: "running",
        parentCallId: message.parentCallId,
        agent: message.agent,
        model: message.model,
      };
      const index = transcript.tools.findIndex((item) => item.callId === next.callId);
      if (index >= 0) transcript.tools[index] = { ...transcript.tools[index], ...next };
      else transcript.tools.push(next);
      break;
    }
    case "tool-completed": {
      const index = transcript.tools.findIndex((item) => item.callId === message.callId);
      const prev = index >= 0 ? transcript.tools[index] : undefined;
      const next: RunTool = {
        callId: message.callId,
        name: message.name,
        args: prev?.args,
        result: capToolPayload(message.result),
        status: message.status,
        parentCallId: message.parentCallId || prev?.parentCallId,
        agent: message.agent || prev?.agent,
        model: message.model || prev?.model,
      };
      if (index >= 0) transcript.tools[index] = next;
      else transcript.tools.push(next);
      break;
    }
    case "tool-output": {
      let index = transcript.tools.findIndex((item) => item.callId === message.callId);
      if (index < 0) {
        transcript.tools.push({ callId: message.callId, name: "shell", status: "running" });
        index = transcript.tools.length - 1;
      }
      transcript.tools[index].result = capToolPayload(foldToolOutput(transcript.tools[index].result, message));
      break;
    }
    case "task":
      transcript.task = message.text;
      break;
    case "run_meta":
      if (message.model) transcript.model = message.model;
      if (message.mode) transcript.mode = message.mode;
      break;
    case "approval":
      transcript.awaitingApproval = {
        callId: message.callId,
        name: message.name,
        args: message.args,
      };
      break;
    case "error":
      if (message.message) transcript.error = message.message;
      break;
    case "done":
      if (message.status === "approval") {
        transcript.phase = "running";
        transcript.status = "approval";
      } else {
        transcript.phase = "done";
        transcript.status = message.status;
        transcript.awaitingApproval = undefined;
      }
      if (message.durationMs != null) transcript.durationMs = message.durationMs;
      break;
    default:
      break;
  }
}

const TOOL_TEXT_CAP = 24_000;
const TOOL_TEXT_MARK = "\n…（过长已截断）";

function capToolText(value: string): string {
  if (value.length <= TOOL_TEXT_CAP) return value;
  return value.slice(0, TOOL_TEXT_CAP - TOOL_TEXT_MARK.length) + TOOL_TEXT_MARK;
}

function capToolPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return capToolText(value);
  if (depth >= 8 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = depth === 0 && value.length > 400 ? value.slice(0, 400) : value;
    return items.map((item) => capToolPayload(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capToolPayload(item, depth + 1);
  }
  return out;
}

function foldToolOutput(
  result: unknown,
  message: {
    stream?: "stdout" | "stderr";
    chunk?: string;
    stdout?: string;
    stderr?: string;
  },
) {
  const rec: Record<string, unknown> =
    result && typeof result === "object" && !Array.isArray(result)
      ? { ...(result as Record<string, unknown>) }
      : { stdout: typeof result === "string" ? result : "", stderr: "" };
  if (typeof rec.stdout !== "string") rec.stdout = "";
  if (typeof rec.stderr !== "string") rec.stderr = "";
  if (message.stdout != null) rec.stdout = message.stdout;
  if (message.stderr != null) rec.stderr = message.stderr;
  if (message.chunk) {
    const key = message.stream === "stderr" ? "stderr" : "stdout";
    rec[key] = `${rec[key] || ""}${message.chunk}`;
  }
  return rec;
}

export function turnFromTranscript(transcript: RunTranscript): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: transcript.turnId,
    user: transcript.userText,
    assistant: transcript.assistant,
    thinking: transcript.thinking,
    tools: transcript.tools,
    running: transcript.phase === "running",
  };
  // 没图时不写键，合并时别把旧客户端传上来的图盖掉
  if (transcript.images?.length) row.images = transcript.images;
  if (transcript.task) row.task = transcript.task;
  if (transcript.model) row.model = transcript.model;
  if (transcript.mode) row.mode = transcript.mode;
  if (transcript.error) row.error = transcript.error;
  if (transcript.durationMs != null) row.durationMs = transcript.durationMs;
  if (transcript.files?.length) row.files = transcript.files;
  if (transcript.phase === "done" && transcript.status) row.status = transcript.status;
  else if (transcript.status === "approval") row.status = "approval";
  return row;
}

/** 按 turnId 更新已有回合；没有 id 时从后往前按用户原文配对一次。 */
export function upsertTranscriptTurn(turns: unknown[], transcript: RunTranscript): unknown[] {
  const next = turns.slice();
  const written = turnFromTranscript(transcript);
  const byId = transcript.turnId
    ? next.findIndex((item) => turnIdOf(item) === transcript.turnId)
    : -1;
  if (byId >= 0) {
    const prev = isRecord(next[byId]) ? next[byId] : {};
    next[byId] = { ...prev, ...written };
    return next;
  }
  const fp = userFingerprint(transcript.userText);
  if (fp) {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (userFingerprint(textOf(next[i], "user")) !== fp) continue;
      const raw = next[i];
      const prev: Record<string, unknown> = isRecord(raw) ? raw : {};
      next[i] = { ...prev, ...written, id: turnIdOf(prev) || transcript.turnId };
      return next;
    }
  }
  next.push(written);
  return next;
}

function longerTurn(disk: unknown, incoming: unknown): unknown {
  if (!isRecord(incoming)) return disk;
  if (!isRecord(disk)) return incoming;
  const diskAssistant = textOf(disk, "assistant");
  const diskThinking = textOf(disk, "thinking");
  const short =
    diskAssistant.length > textOf(incoming, "assistant").length ||
    diskThinking.length > textOf(incoming, "thinking").length;
  if (!short) return incoming;
  return {
    ...incoming,
    assistant: diskAssistant,
    thinking: diskThinking,
    tools: Array.isArray(disk.tools) ? disk.tools : incoming.tools,
  };
}

/** 客户端本地拼的回合没有 files 键（旧客户端也不认识它）：缺键时留用磁盘那份，带键时以上传为准 */
function withDiskFiles(disk: unknown, incoming: unknown): unknown {
  if (!isRecord(incoming) || "files" in incoming) return incoming;
  if (!isRecord(disk) || !Array.isArray(disk.files) || !disk.files.length) return incoming;
  // 只认同 id；按用户原文配上的可能是重问的另一轮
  const id = turnIdOf(incoming);
  if (!id || id !== turnIdOf(disk)) return incoming;
  return { ...incoming, files: disk.files };
}

/** 按回合 id 把磁盘上的 files 补回缺这个键的上传回合。给 index.ts 的各条合并路径共用 */
export function keepTurnFiles(prevTurns: unknown[] | undefined, turns: unknown[]): unknown[] {
  if (!Array.isArray(prevTurns) || !prevTurns.length) return turns;
  const byId = new Map<string, unknown>();
  for (const turn of prevTurns) {
    const id = turnIdOf(turn);
    if (id && isRecord(turn) && Array.isArray(turn.files)) byId.set(id, turn);
  }
  if (!byId.size) return turns;
  return turns.map((turn) => {
    const disk = byId.get(turnIdOf(turn));
    return disk ? withDiskFiles(disk, turn) : turn;
  });
}

function findDiskTurn(turns: unknown[], turn: unknown, used: Set<number>): number {
  const id = turnIdOf(turn);
  if (id) {
    const index = turns.findIndex((item, i) => !used.has(i) && turnIdOf(item) === id);
    if (index >= 0) return index;
  }
  const fp = userFingerprint(textOf(turn, "user"));
  if (!fp) return -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (used.has(i)) continue;
    if (userFingerprint(textOf(turns[i], "user")) === fp) return i;
  }
  return -1;
}

export function mergeUploadedTurns(
  prevTurns: unknown[],
  incoming: unknown[] | undefined,
  mark: RunMark | null,
): { turns: unknown[]; clearMark: boolean } {
  if (!incoming) return { turns: prevTurns, clearMark: false };
  const fullById = new Map(prevTurns.map((item) => [turnIdOf(item), item]));
  const used = new Set<number>();
  const turns = incoming.flatMap((item) => {
    if (isRecord(item) && item.clipped === true) {
      const full = fullById.get(turnIdOf(item));
      return full ? [full] : [];
    }
    const index = findDiskTurn(prevTurns, item, used);
    if (index < 0) return [item];
    used.add(index);
    return [withDiskFiles(prevTurns[index], longerTurn(prevTurns[index], item))];
  });
  const covered = Boolean(
    mark &&
      turns.some(
        (item) =>
          turnIdOf(item) === mark.turnId ||
          userFingerprint(textOf(item, "user")) === userFingerprint(mark.userText),
      ),
  );
  if (mark && !covered) {
    const diskIndex = prevTurns.findIndex((item) => turnIdOf(item) === mark.turnId);
    const disk =
      diskIndex >= 0
        ? prevTurns[diskIndex]
        : [...prevTurns].reverse().find((item) => userFingerprint(textOf(item, "user")) === userFingerprint(mark.userText));
    if (disk && !used.has(diskIndex)) turns.push(disk);
  }
  return { turns, clearMark: uploadCoversMark(incoming, mark) };
}

function uploadCoversMark(incoming: unknown[], mark: RunMark | null) {
  if (!mark || mark.phase !== "done") return false;
  const match = [...incoming].reverse().find((item) => {
    if (!isRecord(item) || item.clipped === true) return false;
    if (turnIdOf(item) === mark.turnId) return true;
    return userFingerprint(textOf(item, "user")) === userFingerprint(mark.userText);
  });
  if (!match || !isRecord(match) || match.clipped === true) return false;
  return (
    textOf(match, "assistant").length >= mark.assistantChars &&
    textOf(match, "thinking").length >= mark.thinkingChars
  );
}

export function snapshotMessage(
  chatId: string,
  transcript: RunTranscript,
  queued: Array<{ turnId?: string; userText: string }>,
): ServerMessage {
  return {
    type: "run_snapshot",
    chatId,
    turnId: transcript.turnId || undefined,
    phase: transcript.phase,
    status: transcript.status,
    userText: transcript.userText,
    assistant: transcript.assistant,
    thinking: transcript.thinking || undefined,
    tools: transcript.tools.length ? transcript.tools : undefined,
    task: transcript.task,
    model: transcript.model,
    mode: transcript.mode,
    awaitingApproval: transcript.awaitingApproval,
    queued: queued.length ? queued : undefined,
    durationMs: transcript.durationMs,
  };
}

export function diskSnapshot(
  chatId: string,
  mark: RunMark,
  turns: unknown[],
  cancelled: boolean,
): ServerMessage {
  const index = turns.findIndex((item) => turnIdOf(item) === mark.turnId);
  const turn =
    index >= 0
      ? turns[index]
      : [...turns].reverse().find((item) => userFingerprint(textOf(item, "user")) === userFingerprint(mark.userText));
  const row = isRecord(turn) ? turn : {};
  return {
    type: "run_snapshot",
    chatId,
    turnId: mark.turnId,
    phase: cancelled ? "done" : mark.phase,
    status: cancelled ? "cancelled" : mark.status,
    userText: mark.userText || textOf(row, "user"),
    assistant: textOf(row, "assistant"),
    thinking: textOf(row, "thinking") || undefined,
    tools: Array.isArray(row.tools) ? (row.tools as RunTool[]) : undefined,
    task: typeof row.task === "string" ? row.task : undefined,
    model: typeof row.model === "string" ? row.model : undefined,
    mode: row.mode === "agent" || row.mode === "plan" || row.mode === "ask" ? row.mode : undefined,
  };
}

/** 超限时先去掉工具和思考。仍放不下则只留状态，正文改走已有分页。 */
export function clipSnapshot(message: ServerMessage, maxBytes: number): ServerMessage {
  if (message.type !== "run_snapshot" || maxBytes <= 0) return message;
  if (Buffer.byteLength(JSON.stringify(message)) <= maxBytes) return message;
  const trimmed: ServerMessage = {
    ...message,
    thinking: undefined,
    tools: message.tools?.map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(trimmed)) <= maxBytes) return trimmed;
  return {
    ...trimmed,
    assistant: "",
    thinking: undefined,
    tools: undefined,
    clipped: true,
  };
}
