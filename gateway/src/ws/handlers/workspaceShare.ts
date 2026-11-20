import { allTenants, stateDir } from "../../tenants.ts";
import { WorkspaceSharing, WorkspaceShareError } from "../../workspace/sharing.ts";
import { WORKSPACE_SHARE_CAP } from "../../../../shared/workspaceShare.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

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

export function onWorkspaceShare({ ws, conn, tenant, state }: WsCtx, message: MessageOf<"workspace_share">) {
  if (!conn.caps.has(WORKSPACE_SHARE_CAP)) return;
  const requestId = message.requestId;
  if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId)) return;
  try {
    const result = new WorkspaceSharing(stateDir(), allTenants).handle(tenant, message);
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
