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
  chatId?: string;
};

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

export function addTodo(ref: TenantRef, input: { text: string; due?: string; chatId?: string }) {
  const text = clip(input.text || "", 300);
  if (!text) return { ok: false as const, error: "待办内容为空。" };
  const data = readJson<TodosFile>(file(ref), { todos: [] });
  const due = typeof input.due === "string" && input.due.trim() ? input.due.trim() : undefined;
  let remindAt: number | undefined;
  if (due && /T\d{2}:\d{2}/.test(due)) {
    const at = Date.parse(due);
    if (Number.isFinite(at)) remindAt = at;
  }
  if (due && !remindAt && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return { ok: false as const, error: "due 要写成 YYYY-MM-DD，或带时区的 ISO 时间（如 2026-10-03T09:00:00+08:00）。" };
  }
  const todo: Todo = { id: newId("t"), text, due, remindAt, done: false, createdAt: Date.now(), chatId: input.chatId };
  data.todos.push(todo);
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
