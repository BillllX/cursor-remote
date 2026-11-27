// 助理委派与新建工作区的宿主回调（startAssistant 调用留在 index.ts）
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { delegationFollowUpId, delegationRecoveryId } from "../../../shared/delegationHandoff.ts";
import { APPROVAL_TTL_MS, findApproval, settleApproval } from "../assistant/approvals.ts";
import { assessDelegationDelivery, normalizeExpectedFiles } from "../assistant/delegationDelivery.ts";
import { createDelegation, getDelegation, updateDelegation, type Delegation } from "../assistant/delegations.ts";
import { deliverDelegationReceipt } from "../assistant/delegationReceipts.ts";
import {
  answerMemoryCard,
  type AssistantTenant,
  type CreateWorkspaceRequest,
  type DelegateRequest,
  flushWorkspaceProposals,
  publishDelegation,
  publishState,
  runDelegateInBackground,
} from "../assistant/service.ts";
import { answerWorkspaceAsk, askWorkspace } from "../assistant/workspaceAsk.ts";
import { finishRun } from "../chat/finish.ts";
import { attachDelegatedFiles } from "../delegationFiles.ts";
import { broadcastTurnFiles } from "../fileEvents.ts";
import { isMutatingTool } from "../chat/tools.ts";
import { safeReadWorkspaceFileSync } from "../ingest/contract.ts";
import { handlePrompt } from "../chat/runner.ts";
import { log } from "../log.ts";
import { hydrateChat } from "../chatBodies.ts";
import { claimOutputs, outputKeys, releaseOutputs } from "../outputClaims.ts";
import { readRunMark } from "../runlog.ts";
import type { TurnFile } from "../../../shared/protocol.ts";
import { cancelRun } from "../runtime/abort.ts";
import { resolveApprovalWait } from "../runtime/approvals.ts";
import { isSlotActive, persistTenant, slotOf } from "../runtime/slots.ts";
import { chatIdOf } from "../runtime/chats.ts";
import { gatewayState, liveSlotsOf } from "../runtime/state.ts";
import { broadcastDigest } from "../sync/storedState.ts";
import { readSnapshotFile, sha256 } from "../turnFiles.ts";
import { confinedCwd, getTenant, saveDiskNow, type Tenant } from "../tenants.ts";
import {
  emitWorkspaces,
  ensureWorkspaceDir,
  listWorkspaceItems,
  sanitizeWorkspaceName,
} from "../workspace/workspaces.ts";
import { openConn } from "./loops.ts";

/** 收件箱、父会话或任一设备作答委派子会话的挂起审批；不抢子会话的 owner */
export function answerDelegationApproval(tenant: Tenant, args: Record<string, unknown>) {
  const chatId = typeof args.chatId === "string" ? args.chatId : "";
  const callId = typeof args.callId === "string" ? args.callId : "";
  if (!chatId || !callId || typeof args.allow !== "boolean")
    return { ok: false, error: "要带 chatId、callId 和 allow。" };
  const card = answerMemoryCard(tenant, chatId, callId, args.allow);
  if (card) return card;
  if (answerWorkspaceAsk(tenant, chatId, callId, args.allow)) return { ok: true };
  const slot = liveSlotsOf(tenant).get(chatId);
  if (!slot || !slot.awaitingApproval || slot.approvalCallId !== callId) {
    // 落盘的挂起项还在、运行却没了：多半是网关重启后的残留，顺手清掉
    if (findApproval(tenant, chatId, callId)) settleApproval(tenant, chatId, callId);
    return { ok: false, error: "这项审批已经结束或过期了。" };
  }
  if (!slot.delegationId) return { ok: false, error: "只能在这里作答委派子会话的审批。" };
  resolveApprovalWait(slot, args.allow);
  return { ok: true };
}

/** 用户从任一设备停掉一项前台委派。后台委派是只读的，不提供停止 */
export async function cancelDelegation(ws: WebSocket, tenant: Tenant, args: Record<string, unknown>) {
  const id = typeof args.delegationId === "string" ? args.delegationId : "";
  const record = id ? getDelegation(tenant, id) : undefined;
  if (!record) return { ok: false, error: "没有这项委派。" };
  if (args.attempt !== undefined && args.attempt !== (record.attempt ?? 1)) return { ok: false, error: "委派已进入下一轮，请刷新后操作。" };
  if (record.status === "queued") {
    const cancelled = updateDelegation(tenant, record.id, { status: "cancelled", waitReason: undefined, result: "你取消了排队中的委派。", endedAt: Date.now(), receiptPending: true });
    if (cancelled) { deliverDelegationReceipt(tenant, cancelled); publishDelegation(tenant, cancelled); }
    return { ok: true };
  }
  if (args.queuedOnly === true) return { ok: false, error: "委派已离开队列，请核对最新状态。" };
  if (record.status !== "running" && record.status !== "awaiting") return { ok: false, error: "这项委派已经结束了。" };
  const slot = liveSlotsOf(tenant).get(record.childChatId);
  if (!slot || slot.finished) {
    return {
      ok: false,
      error: record.mode === "background" ? "后台委派是只读的，不能停，很快会自己结束。" : "这项委派已经没有在跑了。",
    };
  }
  resolveApprovalWait(slot, false);
  slot.externalAbort?.abort();
  await cancelRun(slot.run);
  finishRun(slot.owner ?? ws, slot, "cancelled");
  return { ok: true };
}

export function delegationWorkspaces(tenant: Tenant) {
  return listWorkspaceItems(tenant)
    .filter((item) => !item.user)
    .map((item) => item.name);
}

/** 助理请求新建工作区：先问用户，同意了才真正建目录 */
export async function requestWorkspace(req: CreateWorkspaceRequest): Promise<string> {
  const tenant = getTenant(req.tenant.id);
  if (!tenant) return JSON.stringify({ ok: false, error: "租户不存在" });
  const name = sanitizeWorkspaceName(req.name.replace(/^\.\//, ""));
  const root = resolve(tenant.workspaceRoot);
  const cwd = name ? confinedCwd(resolve(root, name), root) : null;
  if (!name || !cwd || cwd === root) return JSON.stringify({ ok: false, error: "工作区名字不合法。" });
  if (existsSync(cwd)) {
    return statSync(cwd).isDirectory()
      ? JSON.stringify({ ok: true, name, existed: true, note: "已经有这个工作区，直接 delegate。" })
      : JSON.stringify({ ok: false, error: "已经有同名文件。" });
  }
  if (!req.parentChatId) return JSON.stringify({ ok: false, error: "只有和用户对话时才能请求新建工作区。" });
  const outcome = await askWorkspace(
    tenant,
    { chatId: req.parentChatId, name, reason: req.reason },
    () => void publishState(tenant),
  );
  if (outcome === "expired") return JSON.stringify({ ok: false, error: "用户没有回应，没有建。可以稍后再问一次。" });
  if (outcome === "denied") return JSON.stringify({ ok: false, denied: true, error: "用户拒绝了，没有建。" });
  try {
    ensureWorkspaceDir(cwd);
  } catch {
    return JSON.stringify({ ok: false, error: "建不了这个工作区目录。" });
  }
  for (const conn of gatewayState.conns.values()) {
    if (conn.authed && conn.tenant?.id === tenant.id) emitWorkspaces(conn.ws, tenant);
  }
  return JSON.stringify({ ok: true, name, note: "已建好，可以 delegate 了。" });
}

function finishDelegation(tenant: Tenant, record: Delegation, ok: boolean, text: string, cancelled = false, deliveredFiles?: TurnFile[]) {
  const current = getDelegation(tenant, record.id);
  if (!current || current.attempt !== record.attempt || (current.status !== "running" && current.status !== "awaiting" && current.status !== "queued")) return;
  settleApproval(tenant, record.childChatId);
  // P1-5（方案 C 第二级收口）：仅零成本统计 memoryProposedCount 写观测日志，不触发后台二次补抽
  const persisted = persistedDelegationTurn(tenant, current);
  const memoryProposedCount = (persisted?.turn.tools ?? []).filter(
    (tool) => typeof tool?.name === "string" && /(?:^|:)workspace_memory_propose$/i.test(tool.name),
  ).length;
  log.info("delegation memory stats", {
    delegationId: record.id,
    workspace: record.workspace,
    mode: record.mode,
    ok,
    cancelled,
    memoryProposedCount,
  });
  if (record.notifyPolicy !== "collab_only") flushWorkspaceProposals(tenant, record.childChatId);
  const done = updateDelegation(tenant, record.id, {
    status: cancelled ? "cancelled" : ok ? "done" : "failed",
    waitReason: undefined,
    result: text,
    deliveredFiles: ok ? deliveredFiles ?? [] : undefined,
    inheritedFiles: undefined,
    endedAt: Date.now(),
    receiptPending: true,
  });
  if (done) {
    deliverDelegationReceipt(tenant, done);
    publishDelegation(tenant, done);
  }
}

const nextQueueCheck = () => new Promise<void>((resolve) => {
  setTimeout(resolve, 1000).unref();
});

function setDispatchState(tenant: Tenant, record: Delegation, status: "queued" | "running", waitReason?: string) {
  const current = getDelegation(tenant, record.id);
  if (!current || current.attempt !== record.attempt || !["queued", "running"].includes(current.status)) return;
  if (current.status === status && current.waitReason === waitReason) return current;
  const updated = updateDelegation(tenant, record.id, { status, waitReason });
  if (updated) publishDelegation(tenant, updated);
  return updated;
}

async function executeReadOnlyDelegation(tenant: Tenant, record: Delegation, cwd: string) {
  const prompt = [
    record.activeTask,
    record.deliverable && `交付要求：${record.deliverable}`,
    "请写明结论、关键来源和缺口。若本轮分析确立了新的架构决定、业务口径或排查出关键工程坑点，请在输出最终结论前调用 workspace_memory_propose 提交待确认沉淀提议（1~3 条，不要记任务流水账；提议会生成确认卡，未获用户确认前不得声称已写入工作区记忆）。",
  ].filter(Boolean).join("\n");
  while (setDispatchState(tenant, record, "queued", "等待后台执行名额")) {
    const result = await runDelegateInBackground(tenant, {
      chatId: record.childChatId, cwd, task: prompt, label: `委派：${record.title}`,
      onStart: () => Boolean(setDispatchState(tenant, record, "running")),
    }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : "未能启动后台委派。" }));
    if (!result.ok && "busy" in result && result.busy) {
      await nextQueueCheck();
      continue;
    }
    const checked = result.ok ? assessDelegationDelivery(result.text, record, [], () => false) : { ok: false, text: result.error };
    finishDelegation(tenant, record, checked.ok, checked.text);
    break;
  }
}

function persistedDelegationTurn(tenant: Tenant, record: Delegation) {
  if (!record.activeTurnId) return;
  const raw = tenant.disk.chats.find((row) => chatIdOf(row) === record.childChatId);
  const mark = readRunMark(raw);
  const chat = hydrateChat(tenant.bodies, raw) as { delegationId?: string; cwd?: string; turns?: Array<{ id: string; assistant?: string; status?: string; files?: TurnFile[]; tools?: Array<{ name: string; status?: string; args?: unknown }> }> } | undefined;
  if (chat?.delegationId !== record.id) return;
  const turn = chat.turns?.find((row) => row.id === record.activeTurnId);
  if (!turn) return;
  return { turn, cwd: chat.cwd ? confinedCwd(chat.cwd, tenant.workspaceRoot) ?? undefined : undefined, completed: (mark?.turnId === turn.id && mark.phase === "done" &&
    ["completed", "finished"].includes(mark.status ?? "")) || ["completed", "finished"].includes(turn.status ?? "") };
}

function openable(tenant: Tenant, file: TurnFile) {
  return Boolean(file.sha && !readSnapshotFile(tenant.stateDir, file.path, file.sha).error);
}

function validateDelivery(tenant: Tenant, record: Delegation, cwd: string | undefined, text: string, fresh: TurnFile[]) {
  const current = fresh.filter((file) => !file.sourceChatId && openable(tenant, file));
  const freshPaths = new Set(fresh.filter((file) => !file.sourceChatId).map((file) => file.path));
  const inherited = (record.inheritedFiles ?? []).filter((file) => {
    if (!cwd || freshPaths.has(file.path) || file.sourceChatId || !openable(tenant, file)) return false;
    const read = safeReadWorkspaceFileSync(cwd, file.path, 32_000_000);
    return read.ok && sha256(read.bytes) === file.sha;
  });
  const expected = record.expectedFiles ?? [];
  const files = [...current, ...inherited]
    .sort((a, b) => Number(expected.includes(b.path)) - Number(expected.includes(a.path)));
  return { ...assessDelegationDelivery(text, record, files, () => true), files };
}

function uncertainOperations(tools?: Array<{ name: string; status?: string; args?: unknown }>) {
  return [...new Set((tools ?? []).filter((tool) =>
    tool.status !== "completed" && typeof tool.name === "string" && (isMutatingTool(tool.name, tool.args) ||
      /shell|terminal|command|send|publish/i.test(tool.name)),
  ).map((tool) => tool.name))].slice(0, 8);
}

export function inspectInterruptedDelegation(tenantRef: AssistantTenant, record: Delegation) {
  const tenant = getTenant(tenantRef.id);
  const prior = tenant && persistedDelegationTurn(tenant, record);
  if (!tenant || !prior) return;
  const operations = uncertainOperations(prior.turn.tools);
  const files = (prior.turn.files ?? []).filter((file) => !file.sourceChatId && openable(tenant, file)).map((file) => file.path).slice(0, 12);
  return [
    files.length ? `已保留的可打开快照：${files.join("、")}。` : "",
    operations.length ? `以下操作的结果仍需核对，会保留原记录：${operations.join("、")}。` : "",
  ].filter(Boolean).join("\n");
}

export function reconcileDelegation(tenantRef: AssistantTenant, record: Delegation) {
  const tenant = getTenant(tenantRef.id);
  const prior = tenant && persistedDelegationTurn(tenant, record);
  if (!tenant || !prior?.completed) return;
  const checked = validateDelivery(tenant, record, prior.cwd, prior.turn.assistant || "", prior.turn.files ?? []);
  if (!checked.ok) return;
  const parent = attachDelegatedFiles(tenant, { chatId: record.childChatId, delegationId: record.id }, prior.turn.id,
    checked.files);
  if (parent) {
    saveDiskNow(tenant);
    broadcastTurnFiles(tenant.id, parent.chatId, parent.turnId, parent.files);
  }
  return { text: checked.text, files: checked.files };
}

export function retargetDelegation(tenant: Tenant, args: Record<string, unknown>) {
  const record = typeof args.delegationId === "string" ? getDelegation(tenant, args.delegationId) : undefined;
  if (!record || record.id !== args.delegationId || record.notifyPolicy === "collab_only" || record.status !== "queued" ||
      record.mode !== "foreground" || record.waitReason !== "等待同一产物更新完成" ||
      (record.attempt ?? 1) !== args.attempt || record.expectedFiles?.length !== 1 || typeof args.outputPath !== "string") {
    return { ok: false, error: "该委派已离开等待队列，或需要从小驳重新指定多个产物。" };
  }
  const chat = tenant.disk.chats.find((row) => chatIdOf(row) === record.childChatId) as { cwd?: string } | undefined;
  const cwd = chat?.cwd && confinedCwd(chat.cwd, tenant.workspaceRoot);
  if (!cwd) return { ok: false, error: "找不到原工作区。" };
  try {
    const paths = normalizeExpectedFiles([args.outputPath])!;
    const [path] = outputKeys(cwd, paths);
    if (!path || existsSync(path) || claimOutputs([path], "retarget-check") === false) {
      return { ok: false, error: "该路径已有文件或正在使用，请换一个名称。" };
    }
    releaseOutputs([path], "retarget-check");
    const updated = updateDelegation(tenant, record.id, { expectedFiles: paths });
    if (updated) publishDelegation(tenant, updated);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "产物路径无效。" };
  }
}

export async function recoverDelegation(ws: WebSocket, tenant: Tenant, args: Record<string, unknown>, run: typeof handlePrompt = handlePrompt) {
  const id = typeof args.delegationId === "string" ? args.delegationId : "";
  const attempt = args.attempt;
  const item = getDelegation(tenant, id);
  if (!item || item.id !== id || !item.parentChatId || item.notifyPolicy === "collab_only" ||
      !Number.isSafeInteger(attempt) || Number(attempt) < 1) return { ok: false, error: "找不到可恢复的委派。" };
  if ((item.attempt ?? 1) === Number(attempt) + 1) return { ok: true };
  if ((item.attempt ?? 1) !== attempt || !item.interrupted) return { ok: false, error: "委派状态已变，请刷新后再试。" };
  return JSON.parse(await startDelegation(
    { tenant, parentChatId: item.parentChatId, workspace: item.workspace, task: item.activeTask || item.task, background: false },
    run, { id, ws },
  )) as { ok: boolean; error?: string };
}

export function retryBackgroundDelegation(ref: AssistantTenant, record: Delegation) {
  const tenant = getTenant(ref.id);
  if (!tenant) return;
  const chat = tenant.disk.chats.find((row) => chatIdOf(row) === record.childChatId) as { cwd?: string; delegationId?: string } | undefined;
  const cwd = chat?.cwd && chat.delegationId === record.id ? confinedCwd(chat.cwd, tenant.workspaceRoot) : null;
  if (!cwd || cwd === confinedCwd(tenant.workspaceRoot, tenant.workspaceRoot) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    finishDelegation(tenant, record, false, "找不到原委派工作区，未自动重跑。");
    return;
  }
  return executeReadOnlyDelegation(tenant, record, cwd).catch((err) => log.error("保存后台委派结果失败", record.id, err));
}

export async function startDelegation(req: DelegateRequest, run: typeof handlePrompt = handlePrompt, direct?: { id: string; ws: WebSocket }): Promise<string> {
  const tenant = getTenant(req.tenant.id);
  if (!tenant) return JSON.stringify({ ok: false, error: "租户不存在" });
  const parent = req.parentChatId ? liveSlotsOf(tenant).get(req.parentChatId) : undefined;
  const recoveryId = direct?.id || delegationRecoveryId(parent?.transcript?.userText);
  const requestedId = recoveryId || delegationFollowUpId(parent?.transcript?.userText);
  const reject = (error: string) => JSON.stringify({ ok: false, error });
  if (requestedId && req.delegationId && requestedId !== req.delegationId) {
    return reject("续作编号与用户指定的委派不一致。");
  }
  const delegationId = requestedId || req.delegationId;
  const previous = delegationId ? getDelegation(tenant, delegationId) : undefined;
  if (delegationId) {
    if (!previous || previous.notifyPolicy === "collab_only" ||
        !req.parentChatId || previous.parentChatId !== req.parentChatId) {
      return reject("只能在原小驳对话里续作这项委派。");
    }
    if (recoveryId && !previous.interrupted) return reject("这项委派已恢复或无需恢复。");
    deliverDelegationReceipt(tenant, previous);
    if (recoveryId && previous.interrupted) {
      const delivered = reconcileDelegation(tenant, previous);
      if (delivered) {
        const done = updateDelegation(tenant, previous.id, { status: "done", interrupted: false, result: delivered.text, deliveredFiles: delivered.files, inheritedFiles: undefined, endedAt: Date.now(), receiptPending: true });
        if (done) { deliverDelegationReceipt(tenant, done); publishDelegation(tenant, done); }
        return JSON.stringify({ ok: true, id: previous.id, childChatId: previous.childChatId, note: "已核对并找回原交付。" });
      }
    }
    const live = liveSlotsOf(tenant).get(previous.childChatId);
    if (previous.status === "running" || previous.status === "awaiting" || previous.status === "queued" || (live && isSlotActive(live))) {
      return reject("这项委派仍在处理，等本轮结束后再续作。");
    }
  }
  const name = sanitizeWorkspaceName((recoveryId && previous ? previous.workspace : req.workspace).replace(/^\.\//, ""));
  const root = resolve(tenant.workspaceRoot);
  const originalChat = previous
    ? tenant.disk.chats.find((chat) => chatIdOf(chat) === previous.childChatId) as { cwd?: string; delegationId?: string } | undefined
    : undefined;
  if (previous && (!originalChat?.cwd || originalChat.delegationId !== previous.id)) {
    return reject("原委派会话或工作区不存在，无法续作。");
  }
  const cwd = previous && originalChat?.cwd
    ? confinedCwd(originalChat.cwd, root)
    : name ? confinedCwd(resolve(root, name), root) : null;
  if (!name || !cwd || cwd === root || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return reject(`没有这个子工作区：${req.workspace}。可用：${delegationWorkspaces(tenant).join("、")}。`);
  }
  if (previous && name !== previous.workspace && confinedCwd(resolve(root, name), root) !== cwd) {
    return reject("续作不能切换到另一个工作区。");
  }
  const task = (recoveryId && previous ? previous.activeTask || previous.task : req.task).trim();
  if (!task) return reject("任务说明为空。");
  let expectedFiles: string[] | undefined;
  try {
    expectedFiles = (recoveryId ? undefined : normalizeExpectedFiles(req.expectedFiles)) ?? previous?.expectedFiles;
  } catch (err) {
    return reject(err instanceof Error ? err.message : "验收文件不合法。");
  }
  const requiresFile = (recoveryId ? undefined : req.requiresFile) ?? previous?.requiresFile;
  const deliverable = (recoveryId ? undefined : req.deliverable?.trim().slice(0, 500)) || previous?.deliverable;
  const ownerConn = parent?.owner?.readyState === WebSocket.OPEN ? gatewayState.conns.get(parent.owner) : undefined;
  const conn = direct ? gatewayState.conns.get(direct.ws) : req.background ? undefined : ownerConn?.authed ? ownerConn : openConn(tenant.id);
  const background = !conn;
  if (background && previous) return reject("请从已连接的小驳对话续作，后台不能接续原子会话。");
  if (background && (requiresFile || expectedFiles?.length)) return reject("后台委派只能读和分析，不能交付文件。");
  const title = previous?.title || (req.title || task.split("\n")[0]).slice(0, 30);
  const childChatId = previous?.childChatId || crypto.randomUUID();
  const attempt = previous ? (previous.attempt ?? 1) + 1 : 1;
  const delivery = { deliverable, expectedFiles, requiresFile };
  const activeTurnId = crypto.randomUUID();
  const priorTurn = previous?.interrupted ? persistedDelegationTurn(tenant, previous)?.turn : undefined;
  const preserved = previous?.interrupted ? [...(priorTurn?.files ?? []), ...(previous.inheritedFiles ?? [])]
    .filter((file, i, all) => all.findIndex((other) => other.path === file.path) === i) : [];
  const uncertain = uncertainOperations(priorTurn?.tools);
  let keys: string[];
  try { keys = outputKeys(cwd, expectedFiles ?? []); }
  catch (err) { return reject(err instanceof Error ? err.message : "产物路径无效。"); }
  const owner = `${tenant.id}:${childChatId}:${attempt}`;
  const waiting = !background && !claimOutputs(keys, owner);
  const status = background || waiting ? "queued" : "running";
  const waitReason = background ? "等待后台执行名额" : waiting ? "等待同一产物更新完成" : undefined;
  const record = previous
    ? updateDelegation(tenant, previous.id, { ...delivery, attempt, activeTurnId, waitReason, activeTask: task.slice(0, 8000), interrupted: false, status, mode: "foreground", result: undefined, endedAt: undefined, inheritedFiles: preserved, deliveredFiles: undefined })
    : createDelegation(tenant, {
        ...delivery,
        attempt,
        activeTurnId,
        status,
        waitReason,
        activeTask: task.slice(0, 8000),
        backgroundRestarts: background ? 0 : undefined,
        parentChatId: req.parentChatId,
        parentTurnId: parent?.transcript?.turnId,
        childChatId,
        workspace: name,
        title,
        task,
        mode: background ? "background" : "foreground",
      });
  if (!record) return reject("无法找到原委派记录。");
  if (!previous) {
    tenant.disk.chats = [...tenant.disk.chats, {
      id: childChatId, title: `委派：${title}`, turns: [], cwd,
      parentChatId: req.parentChatId, delegationId: record.id,
    }];
    tenant.disk.rev += 1;
    tenant.disk.chatRevs[childChatId] = tenant.disk.rev;
    persistTenant(tenant);
    saveDiskNow(tenant);
    broadcastDigest(tenant);
  }
  publishDelegation(tenant, record);

  if (background) {
    void executeReadOnlyDelegation(tenant, record, cwd).catch((err) => log.error("保存后台委派结果失败", record.id, err));
    return JSON.stringify({
      ok: true,
      id: record.id,
      childChatId,
      mode: "background",
      note: "后台委派只读，结果进收件箱。",
    });
  }

  async function dispatch() {
    if (waiting) {
      for (;;) {
        await nextQueueCheck();
        const current = getDelegation(tenant!, record!.id);
        if (current?.status !== "queued" || current.attempt !== attempt) return;
        const candidates = outputKeys(cwd!, current.expectedFiles ?? []);
        if (claimOutputs(candidates, owner)) {
          keys = candidates;
          delivery.expectedFiles = current.expectedFiles;
          break;
        }
      }
      if (!setDispatchState(tenant!, record!, "running")) { releaseOutputs(keys, owner); return; }
    }
    const delegateConn = conn!.ws.readyState === WebSocket.OPEN ? conn! : openConn(tenant!.id);
    if (!delegateConn) {
      releaseOutputs(keys, owner);
      const interrupted = updateDelegation(tenant!, record!.id, { status: "failed", interrupted: true, waitReason: undefined, result: "等待产物期间连接断开，可以恢复委派。", endedAt: Date.now(), receiptPending: true });
      if (interrupted) { deliverDelegationReceipt(tenant!, interrupted); publishDelegation(tenant!, interrupted); }
      return;
    }
    const slot = slotOf(delegateConn, childChatId);
    slot.cwd = cwd!;
    slot.delegationId = record!.id;
    slot.approvalTimeoutMs = APPROVAL_TTL_MS;
    let text = "";
    let error = "";
    const settled = new Promise<string>((resolveDone) => {
      slot.captureText = (chunk) => {
        text += chunk;
      };
      slot.captureError = (chunk) => {
        error = chunk;
      };
      slot.captureDone = (status) => {
        if (status === "approval") return;
        resolveDone(status);
      };
    });
    const recovering = Boolean(previous?.interrupted);
    const prompt = [
      recovering ? "本轮因网关重启中断，用户已要求继续。先核对已有文件和上轮进度，只补未完成部分。不要重放已执行或执行结果不明的外部动作；需要时向用户说明并重新确认。旧审批已失效。" : "",
      uncertain.length ? `上轮未能确认结果的操作：${uncertain.join("、")}。先在汇报中列出这些待确认事项；本轮不要重放它们。` : "",
      previous ? "这是同一项委派的续作。沿用原有上下文和成果，依据本次要求补充或修改。" : "这是小驳交来的工作区委派。",
      "最终交付请说明结论、关键来源（资料名或工作区相对路径）和缺口；如有文件，请给出相对路径。缺失材料要明示。",
      "若本轮委派敲定了架构/方案决定、统一了业务口径、新增了标准验证命令或排查出非显而易见的工程坑点，请在输出最终汇报前调用 workspace_memory_propose 沉淀至工作区记忆（1~3 条，不要记单次任务流水账）。",
      delivery.deliverable ? `交付要求：${delivery.deliverable}` : "",
      delivery.expectedFiles?.length ? `本轮需交付的文件：${delivery.expectedFiles.join("、")}。这些路径优先于旧任务文字里曾写过的目标路径。` : delivery.requiresFile ? "本轮需要生成或修改可打开的文件。" : "",
      task,
    ].join("\n");
    void run(
      delegateConn.ws,
      delegateConn,
      slot,
      prompt,
      undefined,
      "agent",
      undefined,
      undefined,
      // 恢复后的写操作重新询问，不能继承中断前的审批。
      recovering,
      false,
      false,
      slot.policy,
      slot.dialect,
      undefined,
      false,
      activeTurnId,
    ).then((result) => {
      if (result === "busy") {
        error = "原委派会话正在处理其他消息。";
        slot.captureDone?.("error");
      }
    }).catch((err: unknown) => {
      error = err instanceof Error ? err.message : "未能启动委派。";
      slot.captureDone?.("error");
    });
    void settled.then((status) => {
      slot.captureText = undefined;
      slot.captureError = undefined;
      slot.captureDone = undefined;
      const ok = status === "completed" || status === "finished";
      const freshFiles = slot.transcript?.files ?? [];
      const current = getDelegation(tenant!, record!.id);
      if (!current || current.attempt !== record!.attempt || !["running", "awaiting", "queued"].includes(current.status)) return;
      const checked = ok
        ? validateDelivery(tenant!, current, cwd!, text, freshFiles)
        : { ok: false, text: status === "cancelled" ? "你停掉了这项委派。" : error || `结束状态：${status}`, files: [] };
      if (checked.ok) {
        const attached = attachDelegatedFiles(tenant!, slot, activeTurnId, checked.files);
        if (attached) broadcastTurnFiles(tenant!.id, attached.chatId, attached.turnId, attached.files);
      }
      saveDiskNow(tenant!);
      finishDelegation(tenant!, record!, checked.ok, checked.text, status === "cancelled", checked.files);
    }).catch((err) => log.error("保存委派结果失败", record!.id, err)).finally(() => releaseOutputs(keys, owner));
  }
  void dispatch().catch((err) => {
    releaseOutputs(keys, owner);
    log.error("启动委派失败", record.id, err);
    finishDelegation(tenant, record, false, err instanceof Error ? err.message : "启动委派失败。");
  });
  return JSON.stringify({
    ok: true,
    id: record.id,
    childChatId,
    mode: "foreground",
    note: waiting ? waitReason : previous?.interrupted ? "原子会话已恢复，写操作需重新确认；完成后汇报到收件箱。" : "子会话已开工；完成后汇报到收件箱。",
  });
}
