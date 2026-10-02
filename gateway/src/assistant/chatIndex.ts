import { splitTerms } from "./memory.ts";
import { assistantPath, clip, readJson, writeJson, type TenantRef } from "./store.ts";

/**
 * 会话搜索索引：USER 会话每轮完成时写入，删会话时清掉。
 * 独立于 state.json，彻底删除记忆时可以抹掉片段而不动原会话。
 */

/** external：用户粘贴的大段文字（超过 2000 字或带代码块），整理者只当外部材料 */
export type IndexedTurn = { chatId: string; turn: number; title: string; user: string; assistant: string; at: number; external?: boolean };

type IndexFile = { turns: IndexedTurn[] };

const MAX_TURNS = 5000;

function file(ref: TenantRef) {
  return assistantPath(ref, "chat-index", "index.json");
}

export function indexTurn(ref: TenantRef, row: Omit<IndexedTurn, "at" | "external">) {
  const data = readJson<IndexFile>(file(ref), { turns: [] });
  const next: IndexedTurn = {
    ...row,
    external: row.user.length > 2000 || row.user.includes("```"),
    user: clip(row.user, 2000),
    assistant: clip(row.assistant, 2000),
    title: clip(row.title, 60),
    at: Date.now(),
  };
  const at = data.turns.findIndex((item) => item.chatId === row.chatId && item.turn === row.turn);
  if (at >= 0) data.turns[at] = next;
  else data.turns.push(next);
  data.turns = data.turns.slice(-MAX_TURNS);
  writeJson(file(ref), data);
}

export function dropChatFromIndex(ref: TenantRef, chatId: string) {
  const data = readJson<IndexFile>(file(ref), { turns: [] });
  const kept = data.turns.filter((item) => item.chatId !== chatId);
  if (kept.length !== data.turns.length) writeJson(file(ref), { turns: kept });
}

export function scrubChatIndex(ref: TenantRef, needles: string[]) {
  const data = readJson<IndexFile>(file(ref), { turns: [] });
  let changed = 0;
  for (const turn of data.turns) {
    for (const field of ["user", "assistant"] as const) {
      let value = turn[field];
      for (const needle of needles) if (needle && value.includes(needle)) value = value.split(needle).join("［已抹掉］");
      if (value !== turn[field]) {
        turn[field] = value;
        changed += 1;
      }
    }
  }
  if (changed) writeJson(file(ref), data);
  return changed;
}

export function searchChats(ref: TenantRef, query: string, limit = 8) {
  const terms = splitTerms(query);
  if (!terms.length) return [];
  const data = readJson<IndexFile>(file(ref), { turns: [] });
  return data.turns
    .map((turn) => {
      const hay = `${turn.title}\n${turn.user}\n${turn.assistant}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (hay.includes(term) ? 1 : 0), 0);
      return { turn, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.turn.at - a.turn.at)
    .slice(0, limit)
    .map(({ turn }) => ({
      chatId: turn.chatId,
      turn: turn.turn,
      title: turn.title,
      snippet: snippetOf(`${turn.user}\n${turn.assistant}`, terms),
      at: new Date(turn.at).toISOString(),
    }));
}

function snippetOf(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 60);
  return clip(text.slice(start, start + 240).replace(/\s+/g, " "), 240);
}
