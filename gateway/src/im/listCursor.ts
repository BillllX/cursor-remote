// im_list 的排序与分页游标（纯函数）：置顶在前，再按最后一条可见消息时间倒序，同时间按会话号升序。
// 游标是排序键的 base64url(JSON)，表示「排在这一行之后」；对客户端不透明，原样回传即可
export type ListKey = { pin: boolean; at: number; convId: string };

export function rowKey(row: { pin: boolean; convId: string; last?: { at: number } }): ListKey {
  return { pin: row.pin, at: row.last?.at ?? 0, convId: row.convId };
}

export function compareKeys(a: ListKey, b: ListKey): number {
  if (a.pin !== b.pin) return a.pin ? -1 : 1;
  if (a.at !== b.at) return b.at - a.at;
  return a.convId < b.convId ? -1 : a.convId > b.convId ? 1 : 0;
}

export function encodeCursor(key: ListKey): string {
  return Buffer.from(JSON.stringify([key.pin ? 1 : 0, key.at, key.convId])).toString("base64url");
}

export function decodeCursor(text: string): ListKey | null {
  try {
    const raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(raw) || raw.length !== 3) return null;
    const [pin, at, convId] = raw;
    if ((pin !== 0 && pin !== 1) || !Number.isFinite(at) || typeof convId !== "string") return null;
    return { pin: pin === 1, at, convId };
  } catch {
    return null;
  }
}
