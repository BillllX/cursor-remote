import { assistantPath, clip, newId, readJson, writeJson, type TenantRef } from "./store.ts";
import { log } from "../log.ts";

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
  /** 点开条目后交给助理的真实输入；只用于尚未处理的外部捕获。 */
  decision?: { kind: "proposal" | "skill" | "wechat"; id: string; rev?: number; openId?: string };
  snoozedUntil?: number;
  resolved?: boolean;
  attention?: "confirmation" | "content" | "reminder" | "recovery" | "suggestion" | "notice";
  todoId?: string;
  eventId?: string;
  actionPrompt?: string;
  chatId?: string;
  runId?: string;
  scheduleId?: string;
  delegationId?: string;
  /** 捕获入口已校验的结构化字段；投影只能读这里，不能从正文反解析 URL。 */
  capture?: {
    kind: "text" | "link" | "location" | "file";
    title?: string;
    url?: string;
    path?: string;
    /** 租户 artifacts/ 中的受控快照；path 只是展示文件名，不是工作区落点。 */
    sha?: string;
    mime?: string;
    size?: number;
    intent?: string;
  };
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
  return readJson<InboxFile>(file(ref), { items: [] })
    .items.slice(-limit)
    .reverse()
    .map((item) => {
      // Older persisted notifications have stable server-issued keys, but no structured decision.
      if (!item.decision && item.kind === "approval" && item.key) {
        if (item.key.startsWith("proposal:")) item.decision = { kind: "proposal", id: item.key.slice(9) };
        const skill = /^skill-proposal:(.+):(\d+)$/.exec(item.key);
        if (skill) item.decision = { kind: "skill", id: skill[1]!, rev: Number(skill[2]) };
        const wx = /^wxbind:([^:]+):(.+)$/.exec(item.key);
        if (wx) item.decision = { kind: "wechat", id: wx[1]!, openId: wx[2]! };
      }
      return item;
    });
}

export function inboxByKey(ref: TenantRef, key: string): InboxItem | undefined {
  return readJson<InboxFile>(file(ref), { items: [] }).items.find((item) => item.key === key);
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
    attention:
      input.attention ??
      (input.kind === "approval"
        ? "confirmation"
        : input.kind === "run"
          ? "recovery"
          : input.kind === "reminder"
            ? "reminder"
            : input.actionPrompt
              ? "content"
              : "notice"),
    id: newId("i"),
    title: clip(input.title, 120),
    body: clip(input.body, 4000),
    createdAt: Date.now(),
    read: input.read ?? false,
  };
  data.items = [...data.items, item].slice(-MAX_ITEMS);
  writeJson(file(ref), data, item.kind === "delegation");
  for (const listener of listeners) {
    try {
      listener(ref, item);
    } catch (err) {
      log.error("inbox listener", err);
    }
  }
  return { item, created: true };
}

export function markInboxRead(ref: TenantRef, ids: string[] | "all", resolve = false) {
  const data = readJson<InboxFile>(file(ref), { items: [] });
  let changed = 0;
  for (const item of data.items) {
    if (item.read && (!resolve || item.resolved)) continue;
    if (ids === "all" || ids.includes(item.id)) {
      item.read = true;
      if (resolve) item.resolved = true;
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

export function snoozeInbox(ref: TenantRef, id: string, minutes: number, now = Date.now()) {
  const data = readJson<InboxFile>(file(ref), { items: [] });
  const item = data.items.find((row) => row.id === id);
  if (!item || item.resolved || item.kind !== "reminder") return false;
  if (![15, 60, 1440].includes(minutes)) return false;
  item.snoozedUntil = now + minutes * 60_000;
  item.read = true;
  writeJson(file(ref), data);
  return true;
}

export function wakeSnoozedInbox(ref: TenantRef, now = Date.now()) {
  const data = readJson<InboxFile>(file(ref), { items: [] });
  const due = data.items.filter((item) => !item.resolved && item.snoozedUntil && item.snoozedUntil <= now);
  if (!due.length) return 0;
  for (const item of due) {
    delete item.snoozedUntil;
    item.read = false;
  }
  writeJson(file(ref), data);
  for (const item of due)
    for (const listener of listeners) {
      try {
        listener(ref, item);
      } catch (err) {
        log.error("snoozed inbox listener", err);
      }
    }
  return due.length;
}
