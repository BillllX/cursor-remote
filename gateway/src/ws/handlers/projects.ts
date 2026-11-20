import { PROJECT_CAP, type ProjectRequest } from "../../../../shared/projectTypes.ts";
import { decodeProjectRequest } from "../../../../shared/projectValidation.ts";
import { publicProjectError } from "../../projects/ipc.ts";
import { projectRequest } from "../../projects/runtime.ts";
import { send } from "../send.ts";
import type { WsCtx } from "./types.ts";
const subscriptions = new WeakMap<
  WsCtx["conn"],
  Map<string, { cursor: number; timer: ReturnType<typeof setTimeout>; busy: boolean; tenantId: string }>
>();
const generations = new WeakMap<WsCtx["conn"], object>();
export function closeProjectSubscriptions(conn: WsCtx["conn"]) {
  const rows = subscriptions.get(conn);
  if (rows) for (const s of rows.values()) clearTimeout(s.timer);
  rows?.clear();
  generations.delete(conn);
  subscriptions.delete(conn);
}
export async function onProjectRequest(ctx: WsCtx, input: ProjectRequest) {
  const { ws, conn, tenant } = ctx,
    requestId = typeof input.requestId === "string" ? input.requestId : "";
  if (!conn.caps.has(PROJECT_CAP)) {
    send(ws, {
      type: "project_result",
      requestId,
      ok: false,
      error: { code: "CAP_REQUIRED", message: "请更新客户端后使用共享项目" },
    });
    return;
  }
  const generation = generations.get(conn) ?? {};
  generations.set(conn, generation);
  const current = () =>
    generations.get(conn) === generation && conn.authed && conn.tenant?.id === tenant.id && ws.readyState === 1;
  try {
    const request = decodeProjectRequest(input),
      data = await projectRequest(tenant, request);
    // await 期间可能发生同 socket 重新登录；旧结果不得发给新账号。
    if (!current()) return;
    send(ws, { type: "project_result", requestId, ok: true, data });
    if (request.action === "project_unsubscribe") {
      const sub = subscriptions.get(conn)?.get(request.workspaceId!);
      if (sub) clearTimeout(sub.timer);
      subscriptions.get(conn)?.delete(request.workspaceId!);
    }
    if (request.action === "project_subscribe") {
      let map = subscriptions.get(conn);
      if (!map) {
        map = new Map();
        subscriptions.set(conn, map);
      }
      const id = request.workspaceId!,
        old = map.get(id);
      if (old) clearTimeout(old.timer);
      if (map.size >= 10 && !old) return;
      const result = data as { items: import("../../../../shared/projectTypes.ts").ProjectEvent[] };
      for (const event of result.items) send(ws, event);
      const sub = {
        cursor: result.items.at(-1)?.eventSeq ?? Number(request.payload.afterEventSeq),
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        busy: false,
        tenantId: tenant.id,
      };
      const poll = async () => {
        if (map!.get(id) !== sub) return;
        if (!conn.authed || conn.tenant?.id !== sub.tenantId || ws.readyState !== 1 || !conn.caps.has(PROJECT_CAP)) {
          map!.delete(id);
          return;
        }
        if (ws.bufferedAmount > 1024 * 1024) {
          send(ws, {
            type: "project_result",
            requestId,
            ok: false,
            error: { code: "RESYNC_REQUIRED", message: "同步积压，请重新连接" },
          });
          map!.delete(id);
          return;
        }
        try {
          const result = (await projectRequest(tenant, {
            type: "project_request",
            protocol: 1,
            requestId: crypto.randomUUID(),
            action: "project_event_read",
            workspaceId: id,
            payload: { afterEventSeq: sub.cursor, limit: 100 },
          })) as { items: import("../../../../shared/projectTypes.ts").ProjectEvent[] };
          if (map!.get(id) !== sub || !current()) return;
          for (const event of result.items) {
            send(ws, event);
            sub.cursor = event.eventSeq;
          }
        } catch (e) {
          const error = publicProjectError(e);
          if (map!.get(id) !== sub) return;
          if (error.code === "NOT_ACCESSIBLE" || error.code === "FORBIDDEN")
            send(ws, { type: "project_access_revoked", workspaceId: id });
          send(ws, { type: "project_result", requestId, ok: false, error });
          map!.delete(id);
          return;
        }
        sub.timer = setTimeout(() => {
          void poll();
        }, 500);
        sub.timer.unref();
      };
      map.set(id, sub);
      sub.timer = setTimeout(() => {
        void poll();
      }, 100);
      sub.timer.unref();
    }
  } catch (e) {
    if (current()) send(ws, { type: "project_result", requestId, ok: false, error: publicProjectError(e) });
  }
}
