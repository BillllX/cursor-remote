import { assistantPath, clip, newId, readJson, writeJson, type TenantRef } from "./store.ts";

export type DelegationStatus = "running" | "awaiting" | "done" | "failed";

export type Delegation = {
  id: string;
  parentChatId?: string;
  childChatId: string;
  workspace: string;
  title: string;
  task: string;
  mode: "foreground" | "background";
  status: DelegationStatus;
  createdAt: number;
  endedAt?: number;
  result?: string;
};

type DelegationsFile = { items: Delegation[] };

function file(ref: TenantRef) {
  return assistantPath(ref, "delegations.json");
}

export function listDelegations(ref: TenantRef, limit = 30) {
  return readJson<DelegationsFile>(file(ref), { items: [] }).items.slice(-limit).reverse();
}

export function getDelegation(ref: TenantRef, id: string) {
  return readJson<DelegationsFile>(file(ref), { items: [] }).items.find((item) => item.id === id || item.childChatId === id);
}

export function createDelegation(ref: TenantRef, input: Omit<Delegation, "id" | "status" | "createdAt">) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const item: Delegation = { ...input, title: clip(input.title, 40), task: clip(input.task, 8000), id: newId("d"), status: "running", createdAt: Date.now() };
  data.items = [...data.items, item].slice(-200);
  writeJson(file(ref), data);
  return item;
}

export function updateDelegation(ref: TenantRef, id: string, patch: Partial<Pick<Delegation, "status" | "result" | "endedAt">>) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const item = data.items.find((row) => row.id === id);
  if (!item) return;
  Object.assign(item, patch);
  if (patch.result) item.result = clip(patch.result, 4000);
  writeJson(file(ref), data);
  return item;
}

/** 同一子工作区同时只能有一个委派在跑 */
export function activeDelegationFor(ref: TenantRef, workspace: string) {
  return readJson<DelegationsFile>(file(ref), { items: [] }).items.find(
    (item) => item.workspace === workspace && (item.status === "running" || item.status === "awaiting"),
  );
}

/** 网关重启：在跑的委派记为失败（运行已丢），由调用方发收件箱 */
export function recoverDelegations(ref: TenantRef) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const stale = data.items.filter((item) => item.status === "running" || item.status === "awaiting");
  for (const item of stale) {
    item.status = "failed";
    item.endedAt = Date.now();
    item.result = "网关重启，委派运行被中断。";
  }
  if (stale.length) writeJson(file(ref), data);
  return stale;
}
