import { assistantPath, readJson, writeJson, type TenantRef } from "./store.ts";

type StoredRevision = { schema?: unknown; revision?: unknown };

/** 构成 AssistantState 的字段或语义变化时递增；部署后每个租户只迁移、bump 一次。 */
export const ASSISTANT_PROJECTION_SCHEMA = 2;

const validRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const revisionFiles = (ref: TenantRef) => [
  assistantPath(ref, "revision.json"),
  assistantPath(ref, "revision.backup.json"),
];

function initialRevision() {
  // 两份标记同时丢失时也不能回到小整数；毫秒时间戳为旧客户端缓存提供新的单调代际。
  return Math.max(1, Date.now());
}

function persistRevision(ref: TenantRef, revision: number) {
  const value = { schema: ASSISTANT_PROJECTION_SCHEMA, revision };
  for (const file of revisionFiles(ref)) writeJson(file, value);
}

/**
 * 两份 revision 互为影子副本，读取时取最大有效值并修复另一份。
 * 两份都损坏/丢失时使用当前时间建立新代际，避免恢复成 1 后被客户端永久忽略。
 */
export function readAssistantRevision(ref: TenantRef): number {
  const stored = revisionFiles(ref).map((file) => readJson<StoredRevision>(file, {}));
  const revisions = stored.flatMap((item) => (validRevision(item.revision) ? [item.revision] : []));
  let revision = revisions.length ? Math.max(...revisions) : initialRevision();
  if (stored.some((item) => validRevision(item.revision) && item.schema !== ASSISTANT_PROJECTION_SCHEMA)) {
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("assistant revision 已达到安全整数上限");
    }
    revision += 1;
  }
  if (stored.some((item) => item.schema !== ASSISTANT_PROJECTION_SCHEMA || item.revision !== revision)) {
    persistRevision(ref, revision);
  }
  return revision;
}

function writeRevision(ref: TenantRef, revision: number) {
  persistRevision(ref, revision);
}

export function bumpAssistantRevision(ref: TenantRef): number {
  const current = readAssistantRevision(ref);
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("assistant revision 已达到安全整数上限");
  }
  const revision = current + 1;
  writeRevision(ref, revision);
  return revision;
}
