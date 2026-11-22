import { atomicWriteFileSync } from "../fsAtomic.ts";
import { assistantPath, clip, newId, readJson, type TenantRef } from "./store.ts";

import type { TurnFile } from "../../../shared/protocol.ts";

export type DelegationDelivery = { text: string; files: TurnFile[] };

export type DelegationStatus = "queued" | "running" | "awaiting" | "done" | "failed" | "cancelled";

export type Delegation = {
  id: string;
  parentChatId?: string;
  /** 委派工具所在父回合；子会话交付物靠它幂等回填父 turn。 */
  parentTurnId?: string;
  childChatId: string;
  workspace: string;
  title: string;
  task: string;
  deliverable?: string;
  expectedFiles?: string[];
  requiresFile?: boolean;
  attempt?: number;
  /** 本轮原始要求，包含续作时的补充。仅服务端用于恢复。 */
  activeTask?: string;
  activeTurnId?: string;
  /** 中断前的候选产物，完成或重启对账时重新核对。 */
  inheritedFiles?: TurnFile[];
  deliveredFiles?: TurnFile[];
  waitReason?: string;
  backgroundRestarts?: number;
  interrupted?: boolean;
  receiptPending?: boolean;
  mode: "foreground" | "background";
  /** 协作任务只投 Collab Event，不得进入助理 Inbox/APNs 或父回合附件。 */
  notifyPolicy?: "default" | "collab_only";
  workspaceId?: string;
  workspaceKeyAtDispatch?: string;
  collabTaskId?: string;
  status: DelegationStatus;
  createdAt: number;
  endedAt?: number;
  result?: string;
};

export function publicDelegation({ activeTask: _task, activeTurnId: _turn, backgroundRestarts: _restarts, receiptPending: _pending, inheritedFiles: _inherited, ...item }: Delegation) {
  return item;
}

type DelegationsFile = { items: Delegation[] };

function file(ref: TenantRef) {
  return assistantPath(ref, "delegations.json");
}

function save(ref: TenantRef, data: DelegationsFile) {
  atomicWriteFileSync(file(ref), JSON.stringify(data, null, 1), { mkdir: true, fsync: true });
}

export function listDelegations(ref: TenantRef, limit = 30) {
  return readJson<DelegationsFile>(file(ref), { items: [] }).items.slice(-limit).reverse();
}

export function getDelegation(ref: TenantRef, id: string) {
  return readJson<DelegationsFile>(file(ref), { items: [] }).items.find((item) => item.id === id || item.childChatId === id);
}

function retainDelegations(items: Delegation[]) {
  // 历史可以裁剪，尚未处理或未发回执的记录不能丢失。
  const archived = items.filter((item) => !item.receiptPending && !item.interrupted &&
    (item.status === "done" || item.status === "failed" || item.status === "cancelled"));
  const trim = new Set(archived.slice(0, Math.max(0, archived.length - 200)));
  return items.filter((item) => !trim.has(item));
}

export function createDelegation(ref: TenantRef, input: Omit<Delegation, "id" | "status" | "createdAt"> & { status?: DelegationStatus }) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const item: Delegation = { ...input, title: clip(input.title, 40), task: clip(input.task, 8000), id: newId("d"), status: input.status ?? "running", createdAt: Date.now() };
  data.items = retainDelegations([...data.items, item]);
  save(ref, data);
  return item;
}

/** 确定性 id 的委派按 id/childChatId upsert，effect 重放不会重复创建。 */
export function createDelegationRecord(
  ref: TenantRef,
  input: Omit<Delegation, "status" | "createdAt">,
) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const known = data.items.find((item) => item.id === input.id || item.childChatId === input.childChatId);
  if (known) return known;
  const item: Delegation = {
    ...input,
    title: clip(input.title, 40),
    task: clip(input.task, 8000),
    status: "running",
    createdAt: Date.now(),
  };
  data.items = retainDelegations([...data.items, item]);
  save(ref, data);
  return item;
}

export function updateDelegation(ref: TenantRef, id: string, patch: Partial<Pick<Delegation, "status" | "result" | "endedAt" | "attempt" | "mode" | "deliverable" | "expectedFiles" | "requiresFile" | "activeTask" | "activeTurnId" | "inheritedFiles" | "deliveredFiles" | "waitReason" | "interrupted" | "receiptPending">>) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const item = data.items.find((row) => row.id === id);
  if (!item) return;
  Object.assign(item, patch);
  if (patch.result) item.result = clip(patch.result, 4000);
  save(ref, data);
  return item;
}

/** 协作调度沿用原有的候选工作区忙碌判断。个人委派不使用此限制。 */
export function activeDelegationFor(ref: TenantRef, workspace: string) {
  return readJson<DelegationsFile>(file(ref), { items: [] }).items.find(
    (item) => item.workspace === workspace && (item.status === "running" || item.status === "awaiting"),
  );
}

/** 只重跑标记过的纯只读任务一次；等待审批及可写任务交回用户。 */
export function recoverDelegations(ref: TenantRef, retryReadOnly?: (item: Delegation) => void, reconcile?: (item: Delegation) => DelegationDelivery | undefined, inspect?: (item: Delegation) => string | undefined) {
  const data = readJson<DelegationsFile>(file(ref), { items: [] });
  const stale: Delegation[] = [];
  const retry: Delegation[] = [];
  let reconciled = false;
  for (const item of data.items) {
    if (item.status === "queued" && item.mode === "background" && item.notifyPolicy !== "collab_only" && retryReadOnly) {
      retry.push(item);
      continue;
    }
    if (item.notifyPolicy === "collab_only" || (item.status !== "running" && item.status !== "awaiting" && item.status !== "queued")) continue;
    const delivered = item.status === "running" && reconcile?.(item);
    if (delivered) {
      Object.assign(item, { status: "done", result: clip(delivered.text, 4000), deliveredFiles: delivered.files, inheritedFiles: undefined, endedAt: Date.now(), interrupted: false, receiptPending: true });
      reconciled = true;
      continue;
    }
    if (retryReadOnly && item.status === "running" && item.mode === "background" &&
        item.backgroundRestarts === 0 && item.activeTask && !item.requiresFile && !item.expectedFiles?.length) {
      item.backgroundRestarts = 1;
      retry.push(item);
      continue;
    }
    const awaiting = item.status === "awaiting";
    item.status = "failed";
    item.endedAt = Date.now();
    item.interrupted = true;
    item.waitReason = undefined;
    item.receiptPending = true;
    item.result = awaiting
      ? "网关重启，之前的审批已失效。续作会检查已有进度，并在需要时重新申请审批。"
      : item.parentChatId
        ? "网关重启，委派中断。可以从委派详情或原卡片继续；续作会先检查已有进度。"
        : "网关重启，后台委派中断。本轮没有关联的小驳对话，可以重新交办。";
    const details = inspect?.(item);
    if (details) item.result = clip(`${item.result}\n\n${details}`, 4000);
    stale.push(item);
  }
  if (reconciled || stale.length || retry.length) save(ref, data);
  for (const item of retry) retryReadOnly?.(item);
  return stale;
}
