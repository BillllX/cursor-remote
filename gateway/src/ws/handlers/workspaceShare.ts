import { allTenants, stateDir } from "../../tenants.ts";
import { WorkspaceSharing, WorkspaceShareError } from "../../workspace/sharing.ts";
import { applySharedWorkspaceChanges, askSharedWorkspace } from "../../workspace/shareAsk.ts";
import { manageSharedWorkspace } from "../../workspace/shareManage.ts";
import { noteOutput, noteTurn } from "../../usage.ts";
import { WORKSPACE_SHARE_CAP } from "../../../../shared/workspaceShare.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

const activeQuestions = new WeakMap<
  WsCtx["ws"],
  { controller: AbortController; workspace?: string; tenantId: string }
>();

export function notifyWorkspaceShares(state: WsCtx["state"], accountIds?: string[]) {
  for (const [socket, connection] of state.conns) {
    if (
      connection.authed &&
      connection.tenant &&
      connection.caps.has(WORKSPACE_SHARE_CAP) &&
      (!accountIds || accountIds.includes(connection.tenant.id))
    )
      send(socket, { type: "workspace_share_changed" });
  }
}

export async function onWorkspaceShare({ ws, conn, tenant, state }: WsCtx, message: MessageOf<"workspace_share">) {
  if (!conn.caps.has(WORKSPACE_SHARE_CAP)) return;
  const requestId = message.requestId;
  if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
  try {
    const sharing = new WorkspaceSharing(stateDir(), allTenants);
    if (message.action === "manage") {
      const data = manageSharedWorkspace(sharing, tenant, message);
      send(ws, { type: "workspace_share_result", requestId, ok: true, data });
      if (message.section === "management" && message.operation === "rename") notifyWorkspaceShares(state);
      return;
    }
    if (message.action === "apply") {
      const data = applySharedWorkspaceChanges(sharing, tenant, message);
      send(ws, { type: "workspace_share_result", requestId, ok: true, data });
      return;
    }
    if (message.action === "cancel") {
      const run = activeQuestions.get(ws);
      if (run?.tenantId === tenant.id && run.workspace === message.workspace) run.controller.abort("用户停止了任务");
      send(ws, { type: "workspace_share_result", requestId, ok: true });
      return;
    }
    if (message.action === "ask") {
      if (activeQuestions.has(ws)) throw new WorkspaceShareError("上一条任务仍在执行");
      const caps = conn.caps;
      const abort = new AbortController();
      activeQuestions.set(ws, { controller: abort, workspace: message.workspace, tenantId: tenant.id });
      const stop = () => abort.abort();
      const checkConnection = setInterval(() => {
        if (!conn.authed || conn.tenant !== tenant || conn.caps !== caps) stop();
      }, 250);
      checkConnection.unref();
      ws.once("close", stop);
      try {
        const result = await askSharedWorkspace(sharing, tenant, message, abort.signal);
        if (!conn.authed || conn.tenant !== tenant || conn.caps !== caps || abort.signal.aborted) return;
        noteTurn(tenant.id, message.question?.length ?? 0);
        noteOutput(tenant.id, result.answer.length);
        send(ws, { type: "workspace_share_result", requestId, ok: true, data: result });
      } catch (error) {
        if (conn.authed && conn.tenant === tenant && conn.caps === caps) {
          if (!abort.signal.aborted) throw error;
          if (typeof abort.signal.reason === "string") throw new WorkspaceShareError(abort.signal.reason);
        }
      } finally {
        activeQuestions.delete(ws);
        clearInterval(checkConnection);
        ws.off("close", stop);
      }
      return;
    }
    const result = sharing.handle(tenant, message);
    if (message.action === "set") {
      const { affected, ...data } = result as { affected: string[]; memberIds: string[]; memberRevision: string };
      send(ws, { type: "workspace_share_result", requestId, ok: true, data });
      notifyWorkspaceShares(state, affected);
    } else send(ws, { type: "workspace_share_result", requestId, ok: true, data: result });
  } catch (error) {
    const known = error instanceof WorkspaceShareError;
    send(ws, {
      type: "workspace_share_result",
      requestId,
      ok: false,
      error: known ? error.message : "这次操作未完成，请刷新工作区后重试",
      code: known ? error.code : "INVALID",
    });
  }
}
