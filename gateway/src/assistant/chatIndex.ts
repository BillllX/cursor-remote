import { splitTerms } from "./memory.ts";
import { cachedIndex, fingerprint, retrieve, tokenize } from "./retrieval.ts";
import { assistantPath, clip, readJson, writeJson, type TenantRef } from "./store.ts";

/**
 * 会话搜索索引：USER 会话每轮完成时写入，删会话时清掉。
 * 独立于 state.json，彻底删除记忆时可以抹掉片段而不动原会话。
 */

/** external：用户粘贴的大段文字（超过 2000 字或带代码块），整理者只当外部材料 */
export type IndexedTurn = { chatId: string; turn: number; title: string; user: string; assistant: string; at: number; external?: boolean };

type IndexFile = { turns: IndexedTurn[] };

const MAX_TURNS = 5000;

/** 按索引文件计写入次数，检索缓存靠它判断文档集变了没有（抹片段可能不改长度） */
const writes = new Map<string, number>();

function file(ref: TenantRef) {
  return assistantPath(ref, "chat-index", "index.json");
}

function save(ref: TenantRef, data: IndexFile) {
  const path = file(ref);
  writes.set(path, (writes.get(path) ?? 0) + 1);
  writeJson(path, data);
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
  save(ref, data);
}

export function dropChatFromIndex(ref: TenantRef, chatId: string) {
  const data = readJson<IndexFile>(file(ref), { turns: [] });
  const kept = data.turns.filter((item) => item.chatId !== chatId);
  if (kept.length !== data.turns.length) save(ref, { turns: kept });
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
  if (changed) save(ref, data);
  return changed;
}

/** 混合检索（关键词 + 字符向量 + 实体），同分时新的在前 */
export function searchChats(ref: TenantRef, query: string, limit = 8) {
  const terms = splitTerms(query);
  if (!terms.length) return [];
  const data = readJson<IndexFile>(file(ref), { turns: [] });
  const path = file(ref);
  const key = `${writes.get(path) ?? 0}:${fingerprint(data.turns.map((t) => `${t.chatId}:${t.turn}:${t.at}:${t.user.length}:${t.assistant.length}`))}`;
  const index = cachedIndex(path, key, () => data.turns.map((turn) => ({ topic: turn.title, text: `${turn.user}\n${turn.assistant}` })));
  const now = Date.now();
  const snippetTerms = [...terms, ...tokenize(query).filter((term) => term.length > 1)];
  return retrieve(index, query, { limit, prior: (i) => Math.exp(-Math.max(0, now - data.turns[i].at) / (30 * 86_400_000)) }).map(
    ({ index: i }) => {
      const turn = data.turns[i];
      return {
        chatId: turn.chatId,
        turn: turn.turn,
        title: turn.title,
        snippet: snippetOf(`${turn.user}\n${turn.assistant}`, snippetTerms),
        at: new Date(turn.at).toISOString(),
      };
    },
  );
}

function snippetOf(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((at) => at >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 60);
  return clip(text.slice(start, start + 240).replace(/\s+/g, " "), 240);
}
