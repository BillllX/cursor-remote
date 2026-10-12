// 助理委派与新建工作区的宿主回调（startAssistant 调用留在 index.ts）
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { APPROVAL_TTL_MS, findApproval, settleApproval } from "../assistant/approvals.ts";
import { activeDelegationFor, createDelegation, getDelegation, updateDelegation } from "../assistant/delegations.ts";
import { postInbox } from "../assistant/inbox.ts";
import {
  answerMemoryCard,
  type CreateWorkspaceRequest,
  type DelegateRequest,
  flushWorkspaceProposals,
  publishDelegation,
  publishState,
  runDelegateInBackground,
} from "../assistant/service.ts";
import { answerWorkspaceAsk, askWorkspace } from "../assistant/workspaceAsk.ts";
import { finishRun } from "../chat/finish.ts";
import { handlePrompt } from "../chat/runner.ts";
import { cancelRun } from "../runtime/abort.ts";
import { resolveApprovalWait } from "../runtime/approvals.ts";
import { persistTenant, slotOf } from "../runtime/slots.ts";
import { conns, liveSlotsOf } from "../runtime/state.ts";
import { broadcastDigest } from "../sync/storedState.ts";
import { confinedCwd, getTenant, type Tenant } from "../tenants.ts";
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
  for (const conn of conns.values()) {
    if (conn.authed && conn.tenant?.id === tenant.id) emitWorkspaces(conn.ws, tenant);
  }
  return JSON.stringify({ ok: true, name, note: "已建好，可以 delegate 了。" });
}

export async function startDelegation(req: DelegateRequest): Promise<string> {
  const tenant = getTenant(req.tenant.id);
  if (!tenant) return JSON.stringify({ ok: false, error: "租户不存在" });
  const name = sanitizeWorkspaceName(req.workspace.replace(/^\.\//, ""));
  const root = resolve(tenant.workspaceRoot);
  const cwd = name ? confinedCwd(resolve(root, name), root) : null;
  if (!name || !cwd || cwd === root || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return JSON.stringify({
      ok: false,
      error: `没有这个子工作区：${req.workspace}。可用：${delegationWorkspaces(tenant).join("、")}。需要新的可以先用 create_workspace（会请用户确认）。`,
    });
  }
  const task = req.task.trim();
  if (!task) return JSON.stringify({ ok: false, error: "任务说明为空" });
  const busy = activeDelegationFor(tenant, name);
  if (busy)
    return JSON.stringify({ ok: false, error: `子工作区 ${name} 已有委派「${busy.title}」在跑，等它完成再交新的。` });
  const parent = req.parentChatId ? liveSlotsOf(tenant).get(req.parentChatId) : undefined;
  const ownerConn = parent?.owner?.readyState === WebSocket.OPEN ? conns.get(parent.owner) : undefined;
  const conn = req.background ? undefined : ownerConn?.authed ? ownerConn : openConn(tenant.id);
  const background = !conn;
  const title = (req.title || task.split("\n")[0]).slice(0, 30);
  const childChatId = crypto.randomUUID();
  const record = createDelegation(tenant, {
    parentChatId: req.parentChatId,
    childChatId,
    workspace: name,
    title,
    task,
    mode: background ? "background" : "foreground",
  });
  tenant.disk.chats = [
    ...tenant.disk.chats,
    {
      id: childChatId,
      title: `委派：${title}`,
      turns: [],
      cwd,
      parentChatId: req.parentChatId,
      delegationId: record.id,
    },
  ];
  tenant.disk.rev += 1;
  tenant.disk.chatRevs[childChatId] = tenant.disk.rev;
  persistTenant(tenant);
  broadcastDigest(tenant);
  publishDelegation(tenant, record);

  const finish = (ok: boolean, text: string) => {
    settleApproval(tenant, childChatId);
    flushWorkspaceProposals(tenant, childChatId);
    const done = updateDelegation(tenant, record.id, {
      status: ok ? "done" : "failed",
      result: text,
      endedAt: Date.now(),
    });
    if (done) publishDelegation(tenant, done);
    postInbox(tenant, {
      kind: "delegation",
      title: `委派${ok ? "完成" : "失败"}：${title}`,
      body: text.slice(0, 3000) || "（没有输出）",
      key: `delegation:${record.id}`,
      chatId: childChatId,
      delegationId: record.id,
    });
  };

  if (background) {
    void runDelegateInBackground(tenant, { chatId: childChatId, cwd, task, label: `委派：${title}` }).then((result) =>
      finish(result.ok, result.ok ? result.text : result.error),
    );
    return JSON.stringify({
      ok: true,
      id: record.id,
      childChatId,
      mode: "background",
      note: "后台委派只读，结果进收件箱。",
    });
  }

  const slot = slotOf(conn, childChatId);
  slot.cwd = cwd;
  slot.delegationId = record.id;
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
  const prompt = [
    "这是从个人工作区委派来的任务。做完用三五句话汇报：做了什么、改了哪些文件、还有什么没做。",
    "",
    task,
  ].join("\n");
  void handlePrompt(
    conn.ws,
    conn,
    slot,
    prompt,
    undefined,
    "agent",
    undefined,
    undefined,
    true,
    false,
    false,
    slot.policy,
    slot.dialect,
  );
  void settled.then((status) => {
    slot.captureText = undefined;
    slot.captureError = undefined;
    slot.captureDone = undefined;
    const ok = status === "completed" || status === "finished";
    finish(ok, ok ? text.trim() : status === "cancelled" ? "你停掉了这项委派。" : error || `结束状态：${status}`);
  });
  return JSON.stringify({
    ok: true,
    id: record.id,
    childChatId,
    mode: "foreground",
    note: "子会话已开工，写文件要你批准；完成后汇报到收件箱。",
  });
}
