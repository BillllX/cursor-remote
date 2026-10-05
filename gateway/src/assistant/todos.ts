import { assistantPath, clip, newId, readJson, writeJson, type TenantRef } from "./store.ts";

export type Todo = {
  id: string;
  text: string;
  /** 截止日 YYYY-MM-DD 或到点提醒的 ISO 时间 */
  due?: string;
  remindAt?: number;
  reminded?: boolean;
  done: boolean;
  doneAt?: number;
  createdAt: number;
  /** 最近一次改内容或日期；日历用它当 DTSTAMP，没改过就用 createdAt */
  updatedAt?: number;
  chatId?: string;
  /** user 手动加 / chat 对话里助理记下 / nightly 夜里从聊天补记；老数据没有 */
  source?: TodoSource;
  /** 助理记下时的原话，方便用户判断有没有记错 */
  quote?: string;
};

export type TodoSource = "user" | "chat" | "nightly";

type TodosFile = { todos: Todo[] };

function file(ref: TenantRef) {
  return assistantPath(ref, "todos.json");
}

export function listTodos(ref: TenantRef, opts: { includeDone?: boolean } = {}) {
  const todos = readJson<TodosFile>(file(ref), { todos: [] }).todos;
  const open = todos.filter((todo) => !todo.done);
  const done = opts.includeDone ? todos.filter((todo) => todo.done).slice(-30) : [];
  return [...open, ...done];
}

const DUE_ERROR = "due 要写成 YYYY-MM-DD，或带时区的 ISO 时间（如 2026-10-03T09:00:00+08:00）。";

/** 校验 due，返回规范后的 due 和到点提醒时间；空串表示没有日期 */
function parseDue(raw: string | undefined): { ok: true; due?: string; remindAt?: number } | { ok: false } {
  const due = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  if (!due) return { ok: true };
  if (/T\d{2}:\d{2}/.test(due)) {
    // 带时间的必须带时区，否则网关所在时区和用户时区不一致时会差几个小时
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(due)) return { ok: false };
    const at = Date.parse(due);
    return Number.isFinite(at) ? { ok: true, due, remindAt: at } : { ok: false };
  }
  return realDay(due) ? { ok: true, due } : { ok: false };
}

/** 2026-02-31 这种外形对、日子不存在的也要拒：写进日历会变成无效事件 */
function realDay(due: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** 同一件事：去掉空白和标点后文字相同，并且日期落在同一天（都没日期也算） */
function sameTodo(todo: Todo, text: string, due?: string) {
  // 只去空白和标点；符号要留着，「付 ¥100」和「付 $100」是两件事
  const norm = (value: string) => value.toLowerCase().replace(/[\s\p{P}]+/gu, "");
  const day = (value?: string) => (value ? value.slice(0, 10) : "");
  return norm(todo.text) === norm(text) && day(todo.due) === day(due);
}

export function addTodo(
  ref: TenantRef,
  input: { text: string; due?: string; chatId?: string; source?: TodoSource; quote?: string },
) {
  const text = clip(input.text || "", 300);
  if (!text) return { ok: false as const, error: "待办内容为空。" };
  const data = readJson<TodosFile>(file(ref), { todos: [] });
  const parsed = parseDue(input.due);
  if (!parsed.ok) return { ok: false as const, error: DUE_ERROR };
  const existing = data.todos.find((todo) => !todo.done && sameTodo(todo, text, parsed.due));
  if (existing) return { ok: true as const, value: existing, duplicate: true };
  const quote = input.quote?.trim() ? clip(input.quote.trim(), 120) : undefined;
  const todo: Todo = {
    id: newId("t"),
    text,
    due: parsed.due,
    remindAt: parsed.remindAt,
    done: false,
    createdAt: Date.now(),
    chatId: input.chatId,
    source: input.source,
    quote,
  };
  data.todos.push(todo);
  writeJson(file(ref), data);
  return { ok: true as const, value: todo, duplicate: false };
}

/** 改文字或日期；due 传空串表示去掉日期。改了时间就重新等提醒 */
export function updateTodo(ref: TenantRef, id: string, patch: { text?: string; due?: string }) {
  const data = readJson<TodosFile>(file(ref), { todos: [] });
  const todo = data.todos.find((item) => item.id === id);
  if (!todo) return { ok: false as const, error: `没有这条待办：${id}` };
  if (patch.text !== undefined) {
    const text = clip(patch.text, 300);
    if (!text) return { ok: false as const, error: "待办内容为空。" };
    todo.text = text;
  }
  if (patch.due !== undefined) {
    const parsed = parseDue(patch.due);
    if (!parsed.ok) return { ok: false as const, error: DUE_ERROR };
    todo.due = parsed.due;
    todo.remindAt = parsed.remindAt;
    todo.reminded = parsed.remindAt !== undefined && parsed.remindAt <= Date.now();
  }
  todo.updatedAt = Date.now();
  writeJson(file(ref), data);
  return { ok: true as const, value: todo };
}

export function setTodoDone(ref: TenantRef, id: string, done = true) {
  const data = readJson<TodosFile>(file(ref), { todos: [] });
  const todo = data.todos.find((item) => item.id === id);
  if (!todo) return { ok: false as const, error: `没有这条待办：${id}` };
  todo.done = done;
  todo.doneAt = done ? Date.now() : undefined;
  writeJson(file(ref), data);
  return { ok: true as const, value: todo };
}

export function removeTodo(ref: TenantRef, id: string) {
  const data = readJson<TodosFile>(file(ref), { todos: [] });
  const next = data.todos.filter((item) => item.id !== id);
  if (next.length === data.todos.length) return false;
  writeJson(file(ref), { todos: next });
  return true;
}

/** 到点的提醒：取出并标记已提醒（每条只提醒一次） */
export function takeDueReminders(ref: TenantRef, now = Date.now()) {
  const data = readJson<TodosFile>(file(ref), { todos: [] });
  const due = data.todos.filter((todo) => !todo.done && !todo.reminded && todo.remindAt && todo.remindAt <= now);
  if (!due.length) return [];
  for (const todo of due) todo.reminded = true;
  writeJson(file(ref), data);
  return due;
}
