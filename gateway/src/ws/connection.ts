// 每条 WebSocket 连接：建连接状态、登记到连接表，挂 error / message / close 监听
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { defaultPolicy } from "../../../shared/policy.ts";
import { log } from "../log.ts";
import { peerIp } from "../auth/login.ts";
import { persistConn } from "../runtime/slots.ts";
import { gatewayState } from "../runtime/state.ts";
import type { Conn } from "../runtime/types.ts";
import { defaultModel } from "../runtime/env.ts";
import { handleMessage } from "./dispatch.ts";
import { deviceRegistry } from "../device/registry.ts";
import { closeMemoryWatcher } from "../assistant/service.ts";

export function onConnection(ws: WebSocket, req: IncomingMessage) {
  const conn: Conn = {
    cwd: "",
    model: defaultModel(),
    authed: false,
    ip: peerIp(req),
    tenant: null,
    slots: new Map(),
    ws,
    maxMessageBytes: 0,
    caps: new Set(),
    policy: defaultPolicy(),
  };
  const state = gatewayState;
  state.conns.set(ws, conn);

  ws.on("error", (err) => {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
    log.error("ws error", code || (err instanceof Error ? err.message : err));
  });

  ws.on("message", (data) => handleMessage({ ws, conn, state }, data));

  ws.on("close", () => {
    closeMemoryWatcher(ws);
    deviceRegistry.close(conn);
    if (conn.authed) persistConn(conn);
    for (const slot of conn.slots.values()) {
      if (slot.owner === ws) slot.owner = null;
    }
    state.conns.delete(ws);
  });
}
