// 会话：标题、草稿、元数据与网关会话列表合并、孤儿运行收尾
import { settleTurn, turnHasOpenTools } from "./turns";
import type { Chat } from "./types";

export function isUntitled(title: string | undefined) {
  return !title || title === "新对话";
}

export function shortPadTitle(title: string | undefined, firstUser?: string) {
  if (!title || title === "新对话") return "新对话";
  const clip = (text: string) => (text.length > 32 ? `${text.slice(0, 32)}…` : text);
  const stripped = (firstUser || "")
    .replace(/@[^\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/[\u4e00-\u9fff]/.test(stripped)) return clip(stripped);
  const base = (title.split("/").filter(Boolean).pop() || title)
    .replace(/^@/, "")
    .replace(/[-_\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(base || "对话");
}

export const EMPTY_STARTERS = ["看一下这个项目的结构", "最近改了哪些文件？", "用 Canvas 概括这个仓库"];

export function usableDraft(chat: { draft?: string; turns: Array<{ user?: string }> }) {
  const draft = (chat.draft || "").trim();
  if (!draft) return "";
  for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
    if ((chat.turns[i].user || "").trim() === draft) return "";
  }
  return chat.draft || "";
}

/** 上传给网关的元数据：除正文（turns）、网关算的 preview 和服务端的 runMark 以外的全部字段。 */
export function chatMeta(chat: Chat): Omit<Chat, "turns"> {
  const rest: Record<string, unknown> = { ...chat };
  delete rest.turns;
  delete rest.preview;
  delete rest.runMark;
  delete rest.clipped;
  // 草稿只留在本机：打字很频繁，传上去会让网关把会话版本号往前推，其他设备跟着重拉
  delete rest.draft;
  delete rest.draftImages;
  const meta = rest as Omit<Chat, "turns">;
  return {
    ...meta,
    previewTabs: meta.previewTabs?.map(({ path, line }) => ({ path, line })),
  };
}

export function metaKey(chat: Chat): string {
  return JSON.stringify(chatMeta(chat));
}

/** 会话有没有内容：正文没加载时看网关给的 preview（有回合才会带这个键）。 */
export function chatHasContent(chat: Chat): boolean {
  return chat.turns.length > 0 || chat.preview !== undefined;
}

/**
 * 合并网关的会话列表（slim：只有元数据和 preview）。
 * 本地元数据和最后一次对齐的快照不同 = 本地改过还没确认，保留本地；否则用服务端的。
 * 正文一律保留本地已有的，由正文加载按 chatRev 判断是否过期。
 */
export function mergeSlimChats(
  local: Chat[],
  remote: Chat[],
  deleted: Set<string>,
  synced: Map<string, string>,
): Chat[] {
  const localById = new Map(local.map((chat) => [chat.id, chat]));
  const remoteIds = new Set<string>();
  const out: Chat[] = [];
  for (const row of remote) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id) continue;
    if (deleted.has(row.id) || remoteIds.has(row.id)) continue;
    remoteIds.add(row.id);
    const cur = localById.get(row.id);
    const base: Chat = { ...row, title: typeof row.title === "string" ? row.title : "新对话", turns: [] };
    delete (base as { runMark?: unknown }).runMark;
    // 草稿不跟网关走：服务端旧数据里可能还留着以前的草稿，不能带回来
    delete base.draft;
    delete base.draftImages;
    if (!cur) {
      synced.set(row.id, metaKey(base));
      out.push(base);
      continue;
    }
    const last = synced.get(row.id);
    if (last !== undefined && last !== metaKey(cur)) {
      // 三方合并：只保留本地改过的字段，其余跟服务端（别的设备可能改了别的字段）
      const before = JSON.parse(last) as Record<string, unknown>;
      const mine = chatMeta(cur) as Record<string, unknown>;
      const theirs = chatMeta(base) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...theirs };
      for (const key of new Set([...Object.keys(before), ...Object.keys(mine)])) {
        if (JSON.stringify(mine[key]) === JSON.stringify(before[key])) continue;
        if (mine[key] === undefined) delete merged[key];
        else merged[key] = mine[key];
      }
      synced.set(row.id, metaKey(base));
      out.push({
        ...(merged as Omit<Chat, "turns">),
        preview: base.preview,
        turns: cur.turns,
        draft: cur.draft,
        draftImages: cur.draftImages,
      } as Chat);
      continue;
    }
    if (last === undefined) {
      // 本地有、但从没和网关对齐过（本地新建后被别处同步上去）：本地元数据优先，下一轮上传
      out.push({ ...cur, preview: base.preview, agentId: cur.agentId || base.agentId });
      continue;
    }
    const next: Chat = { ...base, turns: cur.turns, draft: cur.draft, draftImages: cur.draftImages };
    synced.set(row.id, metaKey(next));
    out.push(next);
  }
  for (const chat of local) {
    if (remoteIds.has(chat.id) || deleted.has(chat.id) || chat.id === "boot") continue;
    // 只留从没和网关对齐过的（本地新建还没上传的）；对齐过又不在列表里 = 别处删了
    if (!synced.has(chat.id)) out.push(chat);
  }
  return out;
}

export function stopOrphanRuns(chats: Chat[], keepIds?: Iterable<string>): Chat[] {
  const keep = keepIds ? new Set(keepIds) : null;
  return chats.map((chat) => {
    if (keep?.has(chat.id)) return chat;
    return {
      ...chat,
      turns: chat.turns.map((turn) =>
        turn.running || turn.queued || turnHasOpenTools(turn) ? settleTurn(turn, turn.status || "cancelled") : turn,
      ),
    };
  });
}
