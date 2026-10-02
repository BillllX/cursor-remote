import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatMessage } from "./types.ts";

/**
 * 自研 Agent 的会话持久化：stateDir/native-sessions/<chatId>.json。
 * 存的是带工具调用的完整消息（不含 system），下一轮直接接上，模型记得自己读过/改过什么。
 * 网页端不上行 history，这里就是唯一的上下文来源；iOS 上行的 history 用来校验是否同一段对话。
 */

export type StoredSession = {
  version: 1;
  model: string;
  /** 每轮用户原文（裁到 3000 字），与客户端 history 对齐用 */
  userKeys: string[];
  messages: Exclude<ChatMessage, { role: "system" }>[];
  /** 下一轮要告诉模型的旁白（如工作区已被还原） */
  notes?: string[];
  updatedAt: number;
};

const MAX_TOTAL_CHARS = 400_000;
const OLD_TOOL_CHARS = 2_000;
const KEY_CHARS = 3_000;

export function sessionKey(text: string) {
  return text.trim().slice(0, KEY_CHARS);
}

function fileFor(stateDir: string, chatId: string) {
  const safe = /^[A-Za-z0-9_-]{1,100}$/.test(chatId) ? chatId : createHash("sha256").update(chatId).digest("hex").slice(0, 40);
  return resolve(stateDir, "native-sessions", `${safe}.json`);
}

export function loadSession(stateDir: string, chatId: string): StoredSession | null {
  const file = fileFor(stateDir, chatId);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as StoredSession;
    if (raw?.version !== 1 || !Array.isArray(raw.messages) || !Array.isArray(raw.userKeys)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function deleteSession(stateDir: string, chatId: string) {
  try {
    rmSync(fileFor(stateDir, chatId), { force: true });
  } catch {
    // 删不掉不影响主流程
  }
}

function write(stateDir: string, chatId: string, session: StoredSession) {
  const file = fileFor(stateDir, chatId);
  mkdirSync(resolve(stateDir, "native-sessions"), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(session));
  renameSync(tmp, file);
}

/** 记一条旁白，下一轮开头告诉模型（会话不存在时忽略） */
export function noteSession(stateDir: string, chatId: string, note: string) {
  const session = loadSession(stateDir, chatId);
  if (!session) return;
  session.notes = [...(session.notes ?? []), note].slice(-5);
  try {
    write(stateDir, chatId, session);
  } catch {
    // ignore
  }
}

/** 按用户消息切成轮次；每轮从一条 user 开始，保证 tool_call / tool_result 不会被拆开 */
function splitTurns(messages: StoredSession["messages"]) {
  const turns: StoredSession["messages"][] = [];
  for (const msg of messages) {
    if (msg.role === "user" || !turns.length) turns.push([msg]);
    else turns[turns.length - 1].push(msg);
  }
  return turns;
}

function sizeOf(msg: ChatMessage) {
  let n = msg.content.length;
  if (msg.role === "assistant") {
    n += (msg.reasoning?.length ?? 0) + (msg.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length + call.name.length, 0);
  }
  return n;
}

/** 中途取消会留下没有结果的 tool_call，各家接口都会拒收；补一条「已取消」结果 */
export function repairToolPairs(messages: StoredSession["messages"]): StoredSession["messages"] {
  const out: StoredSession["messages"] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== "assistant" || !msg.toolCalls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    for (; j < messages.length && messages[j].role === "tool"; j++) {
      out.push(messages[j]);
      answered.add((messages[j] as { toolCallId: string }).toolCallId);
    }
    for (const call of msg.toolCalls) {
      if (!answered.has(call.id)) out.push({ role: "tool", toolCallId: call.id, name: call.name, content: "未执行：用户中途停止了这一轮。", isError: true });
    }
    i = j - 1;
  }
  return out;
}

const INTERRUPTED = "（这一轮被中断，没有回复。）";

/**
 * 整理成各家接口都收的序列：首条是 user；tool 只能跟在带 tool_calls 的 assistant 后面；
 * 不出现连续 user（中间补占位回复），连续的纯文本 assistant 合并；不以 user 结尾。
 */
export function normalizeSequence(messages: StoredSession["messages"]): StoredSession["messages"] {
  const out: StoredSession["messages"] = [];
  const pending = new Set<string>();
  for (const msg of repairToolPairs(messages)) {
    const prev = out[out.length - 1];
    if (!out.length && msg.role !== "user") continue;
    if (msg.role === "tool") {
      if (!pending.delete(msg.toolCallId)) continue;
      out.push(msg);
      continue;
    }
    pending.clear();
    if (msg.role === "user") {
      if (prev?.role === "user") out.push({ role: "assistant", content: INTERRUPTED });
      out.push(msg);
      continue;
    }
    if (prev?.role === "assistant" && !prev.toolCalls?.length && !msg.toolCalls?.length) {
      out[out.length - 1] = { ...prev, content: [prev.content, msg.content].filter(Boolean).join("\n\n") };
      continue;
    }
    out.push(msg);
    for (const call of msg.toolCalls ?? []) pending.add(call.id);
  }
  if (out[out.length - 1]?.role === "user") out.push({ role: "assistant", content: INTERRUPTED });
  return out;
}

/** 落盘前瘦身：图片不存、旧轮次的工具结果和思考截短、总量超限时丢最早的整轮 */
export function slimMessages(messages: StoredSession["messages"]): { messages: StoredSession["messages"]; droppedTurns: number } {
  const turns = splitTurns(normalizeSequence(messages));
  const slim = turns.map((turn, index) => {
    const last = index === turns.length - 1;
    return turn.map((msg): StoredSession["messages"][number] => {
      if (msg.role === "user" && msg.images?.length) {
        return { role: "user", content: `${msg.content}\n（本轮附了 ${msg.images.length} 张图片，未保存）` };
      }
      if (last) return msg;
      if (msg.role === "tool" && msg.content.length > OLD_TOOL_CHARS) {
        return { ...msg, content: `${msg.content.slice(0, OLD_TOOL_CHARS)}\n…（旧结果已截短）` };
      }
      if (msg.role === "assistant" && msg.reasoning && msg.reasoning.length > OLD_TOOL_CHARS) {
        return { ...msg, reasoning: msg.reasoning.slice(-OLD_TOOL_CHARS) };
      }
      return msg;
    });
  });
  let total = slim.reduce((sum, turn) => sum + turn.reduce((s, m) => s + sizeOf(m), 0), 0);
  let droppedTurns = 0;
  while (slim.length > 1 && total > MAX_TOTAL_CHARS) {
    const gone = slim.shift()!;
    total -= gone.reduce((s, m) => s + sizeOf(m), 0);
    if (gone[0].role === "user") droppedTurns += 1;
  }
  return { messages: slim.flat(), droppedTurns };
}

/**
 * 决定这一轮的上文：
 * - 客户端没带 history（网页）：用存档；
 * - 带了（iOS）：存档的用户原文序列以它结尾才算同一段对话，否则以客户端为准重建。
 */
export function resumeMessages(
  stored: StoredSession | null,
  history: Array<{ role: "user" | "assistant"; text: string }>,
): { messages: StoredSession["messages"]; userKeys: string[]; notes: string[]; source: "stored" | "client" | "none" } {
  const clientUsers = history.filter((item) => item.role === "user").map((item) => sessionKey(item.text));
  if (stored && stored.messages.length) {
    const tail = stored.userKeys.slice(-clientUsers.length);
    const aligned = !clientUsers.length || (tail.length === clientUsers.length && tail.every((key, i) => key === clientUsers[i]));
    if (aligned) return { messages: normalizeSequence(stored.messages), userKeys: stored.userKeys, notes: stored.notes ?? [], source: "stored" };
  }
  if (!history.length) return { messages: [], userKeys: [], notes: [], source: "none" };
  return {
    messages: normalizeSequence(history.map((item) => ({ role: item.role, content: item.text }))),
    userKeys: clientUsers,
    notes: [],
    source: "client",
  };
}

export function saveSession(
  stateDir: string,
  chatId: string,
  input: { model: string; userKeys: string[]; messages: ChatMessage[]; notes?: string[] },
) {
  const body = input.messages.filter((msg): msg is StoredSession["messages"][number] => msg.role !== "system");
  const { messages, droppedTurns } = slimMessages(body);
  const userKeys = droppedTurns ? input.userKeys.slice(Math.min(droppedTurns, input.userKeys.length)) : input.userKeys;
  const notes = input.notes?.length ? input.notes.slice(-5) : undefined;
  write(stateDir, chatId, { version: 1, model: input.model, userKeys, messages, notes, updatedAt: Date.now() });
}
