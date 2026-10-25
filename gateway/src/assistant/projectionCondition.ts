import { DEFAULT_TZ } from "./schedules.ts";
import { describeLocal } from "./cron.ts";
import { listTodos } from "./todos.ts";
import { assistantPath, readJson, writeJson, type TenantRef } from "./store.ts";

type StoredCondition = {
  schema?: unknown;
  value?: unknown;
};

const CONDITION_SCHEMA = 1;

function files(ref: TenantRef) {
  return [assistantPath(ref, "projection-condition.json"), assistantPath(ref, "projection-condition.backup.json")];
}

function dueAt(due: string | undefined) {
  if (!due) return undefined;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(due) ? Date.parse(`${due}T23:59:59+08:00`) : Date.parse(due);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 这些时间条件会在没有事实写入时改变只读投影：跨日会改变 dayThread，
 * 待办到期会改变 personalTasks。持久化双副本，重启后仍能发现条件变化。
 */
export function assistantProjectionCondition(ref: TenantRef, now = Date.now()): string {
  const overdue = listTodos(ref)
    .filter((todo) => {
      const due = dueAt(todo.due);
      return !todo.done && due !== undefined && due < now;
    })
    .map((todo) => todo.id)
    .sort();
  return JSON.stringify({
    day: describeLocal(now, DEFAULT_TZ).slice(0, 10),
    overdue,
  });
}

/**
 * 条件实际变化（或双副本都不可恢复）时返回 true；仅单副本损坏只修复，不误报变化。
 */
export function refreshAssistantProjectionCondition(ref: TenantRef, now = Date.now()): boolean {
  const value = assistantProjectionCondition(ref, now);
  const stored = files(ref).map((file) => readJson<StoredCondition>(file, {}));
  const recoverable = stored.some(
    (item) => item.schema === CONDITION_SCHEMA && typeof item.value === "string" && item.value === value,
  );
  const complete = stored.every(
    (item) => item.schema === CONDITION_SCHEMA && typeof item.value === "string" && item.value === value,
  );
  if (!complete) {
    for (const file of files(ref)) writeJson(file, { schema: CONDITION_SCHEMA, value });
  }
  return !recoverable;
}
