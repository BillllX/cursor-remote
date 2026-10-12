// 会话历史：从盘上/SDK 会话还原 turns、重建上下文（reseed）与 agent_history 回填
import { Agent } from "@cursor/sdk";
import type { WebSocket } from "ws";
import { crewRoleOf, resolveCrewModel, type ReviewBinding } from "../../../shared/crew.ts";
import type { HistoryTurn } from "../../../shared/protocol.ts";
import { log } from "../log.ts";
import { chatIdOf } from "../runtime/chats.ts";
import { cwdOf } from "../runtime/slots.ts";
import type { Conn, Slot } from "../runtime/types.ts";
import type { Tenant } from "../tenants.ts";
import { fitTurnsFromEnd } from "../ws/frame.ts";
import { send } from "../ws/send.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function clipHistory(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

export function diskChatTurns(tenant: Tenant | null | undefined, chatId: string) {
  if (!tenant || !chatId) return [] as { user: string; assistant: string }[];
  const chat = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
  if (!isRecord(chat) || !Array.isArray(chat.turns)) return [];
  const out: { user: string; assistant: string }[] = [];
  for (const raw of chat.turns) {
    if (!isRecord(raw)) continue;
    const error = typeof raw.error === "string" ? raw.error : "";
    if (/agent[-_ ].*not found/i.test(error)) continue;
    const user = typeof raw.user === "string" ? raw.user.trim() : "";
    const assistant = typeof raw.assistant === "string" ? raw.assistant.trim() : "";
    if (!user && !assistant) continue;
    out.push({ user, assistant });
  }
  return out;
}

export function attachReseedContext(
  tenant: Tenant | null | undefined,
  chatId: string,
  currentText: string,
  prompt: string,
) {
  const wanted = currentText.trim();
  const prior = diskChatTurns(tenant, chatId).filter((turn) => {
    if (!wanted) return Boolean(turn.user || turn.assistant);
    if (turn.user === wanted && !turn.assistant) return false;
    return Boolean(turn.user || turn.assistant);
  });
  if (!prior.length) return prompt;
  const pieces: string[] = [];
  let used = 0;
  const budget = 24_000;
  for (const turn of prior.slice(-10).reverse()) {
    const user = turn.user ? clipHistory(turn.user, 1_500) : "（附图或空消息）";
    const assistant = turn.assistant ? clipHistory(turn.assistant, 4_000) : "（无文字回复）";
    const block = `用户：${user}\n助手：${assistant}`;
    if (used && used + block.length > budget) break;
    pieces.push(block);
    used += block.length;
  }
  pieces.reverse();
  return `以下是同一工作区里此前的对话摘录，文件以磁盘为准。请直接接着当前请求继续，不要复述这段说明，也不要说自己是新会话。

${pieces.join("\n\n")}

当前请求：
${prompt}`;
}

/** 续接时 prompt 前面拼了此前对话摘录（attachReseedContext），回放时只留「当前请求」之后的部分 */
function unwrapReseedPrompt(text: string): string {
  const mark = "\n\n当前请求：\n";
  if (!text.startsWith("以下是同一工作区里此前的对话摘录")) return text;
  const at = text.lastIndexOf(mark);
  return at >= 0 ? text.slice(at + mark.length) : text;
}

function conversationToTurns(conv: unknown[], roster?: ReviewBinding[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const raw of conv) {
    if (!isRecord(raw) || raw.type === "shellConversationTurn") continue;
    // SDK 1.x：{ type: "agentConversationTurn", turn: { userMessage, steps } }；旧格式字段直接在顶层
    const item = isRecord(raw.turn) ? raw.turn : raw;
    const user =
      isRecord(item.userMessage) && typeof item.userMessage.text === "string"
        ? unwrapReseedPrompt(item.userMessage.text)
        : "";
    const steps = Array.isArray(item.steps) ? item.steps : [];
    let assistant = "";
    let thinking = "";
    const tools: NonNullable<HistoryTurn["tools"]> = [];
    for (const step of steps) {
      if (!isRecord(step)) continue;
      const msg = step.message;
      if (step.type === "assistantMessage" && isRecord(msg) && typeof msg.text === "string") {
        assistant += msg.text;
      } else if (step.type === "thinkingMessage" && isRecord(msg) && typeof msg.text === "string") {
        thinking += msg.text;
      } else if (step.type === "toolCall" && isRecord(msg)) {
        const name = typeof msg.type === "string" ? msg.type : "tool";
        const wrap = msg.result;
        let result: unknown;
        let status: "completed" | "error" = "completed";
        if (isRecord(wrap)) {
          if (wrap.status === "error") status = "error";
          result = "value" in wrap ? wrap.value : wrap;
        }
        tools.push({
          callId: crypto.randomUUID(),
          name,
          args: msg.args,
          result,
          status,
          agent: crewRoleOf(name, msg.args),
          model: resolveCrewModel(name, msg.args, roster),
        });
      }
    }
    if (!user && !assistant && !tools.length) continue;
    out.push({
      id: crypto.randomUUID(),
      user,
      assistant: clipHistory(assistant, 80_000),
      thinking: thinking ? clipHistory(thinking, 20_000) : undefined,
      tools,
    });
  }
  return out;
}

/**
 * 只给落盘里没有任何回合的会话补回 SDK 历史。客户端按用户原文配对合并，而 SDK 记下的
 * 用户消息带着网关拼的规则和说明，配不上的回合会整批插到前面，落盘有正文时只会造成重复。
 */
export async function sendAgentHistory(ws: WebSocket, conn: Conn, slot: Slot) {
  const agentId = slot.agentId;
  if (!agentId) return;
  if (diskChatTurns(conn.tenant, slot.chatId).length > 0) return;
  try {
    const listed = await Agent.listRuns(agentId, {
      runtime: "local",
      cwd: cwdOf(conn, slot),
      limit: 12,
    });
    const turns: HistoryTurn[] = [];
    for (const run of listed.items) {
      try {
        if (typeof run.supports === "function" && !run.supports("conversation")) continue;
        const conv = await run.conversation();
        turns.push(...conversationToTurns(conv as unknown[], slot.reviewRoster));
      } catch {
        continue;
      }
      if (turns.length >= 40) break;
    }
    if (turns.length) {
      // 与 load_chat 同口径：条数 40、字节为接收上限的 80%（不限的连接按 800KB）
      const declared = conn.maxMessageBytes;
      const budget = declared > 0 ? Math.floor(declared * 0.8) : 800 * 1024;
      const page = fitTurnsFromEnd(turns, budget, 40) as HistoryTurn[];
      if (page.length) send(ws, { type: "history", chatId: slot.chatId, turns: page });
    }
  } catch (err) {
    // History is best-effort; local store may not have runs yet.
    log.debug("读 Agent 历史失败", slot.chatId, err instanceof Error ? err.message : err);
  }
}
