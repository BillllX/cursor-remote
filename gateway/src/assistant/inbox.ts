import { assistantPath, clip, newId, readJson, writeJson, type TenantRef } from "./store.ts";

export type InboxKind = "approval" | "delegation" | "reminder" | "brief" | "run" | "memory" | "info";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  /** 幂等键：同一个键只写一次（例如调度的单次运行 id） */
  key?: string;
  chatId?: string;
  runId?: string;
  scheduleId?: string;
  delegationId?: string;
};

type InboxFile = { items: InboxItem[] };

const MAX_ITEMS = 300;

/** 这几类按已定的推送事件发通知 */
export const PUSH_KINDS: InboxKind[] = ["approval", "delegation", "reminder", "brief"];

type Listener = (ref: TenantRef, item: InboxItem) => void;
const listeners: Listener[] = [];

export function onInbox(listener: Listener) {
  listeners.push(listener);
}

function file(ref: TenantRef) {
  return assistantPath(ref, "inbox.json");
}

export function listInbox(ref: TenantRef, limit = 100): InboxItem[] {
  return readJson<InboxFile>(file(ref), { items: [] }).items.slice(-limit).reverse();
}

export function postInbox(
  ref: TenantRef,
  input: Omit<InboxItem, "id" | "createdAt" | "read"> & { read?: boolean },
): { item: InboxItem; created: boolean } {
  const data = readJson<InboxFile>(file(ref), { items: [] });
  if (input.key) {
    const known = data.items.find((item) => item.key === input.key);
    if (known) return { item: known, created: false };
  }
  const item: InboxItem = {
    ...input,
    id: newId("i"),
    title: clip(input.title, 120),
    body: clip(input.body, 4000),
    createdAt: Date.now(),
    read: input.read ?? false,
  };
  data.items = [...data.items, item].slice(-MAX_ITEMS);
  writeJson(file(ref), data);
  for (const listener of listeners) {
    try {
      listener(ref, item);
    } catch (err) {
      console.error("inbox listener", err);
    }
  }
  return { item, created: true };
}

export function markInboxRead(ref: TenantRef, ids: string[] | "all") {
  const data = readJson<InboxFile>(file(ref), { items: [] });
  let changed = 0;
  for (const item of data.items) {
    if (item.read) continue;
    if (ids === "all" || ids.includes(item.id)) {
      item.read = true;
      changed += 1;
    }
  }
  if (changed) writeJson(file(ref), data);
  return changed;
}

/** 彻底删除记忆时，含该内容的收件箱条目抹掉正文 */
export function scrubInbox(ref: TenantRef, needles: string[]) {
  const data = readJson<InboxFile>(file(ref), { items: [] });
  let changed = 0;
  for (const item of data.items) {
    if (needles.some((needle) => needle && (item.body.includes(needle) || item.title.includes(needle)))) {
      item.body = "（相关记忆已彻底删除，正文已抹掉）";
      if (needles.some((needle) => needle && item.title.includes(needle))) item.title = "已抹掉";
      changed += 1;
    }
  }
  if (changed) writeJson(file(ref), data);
  return changed;
}
