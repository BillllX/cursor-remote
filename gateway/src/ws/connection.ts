// 每条 WebSocket 连接：建连接状态、登记到 conns，挂 error / message / close 监听
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { defaultPolicy } from "../../../shared/policy.ts";
import { log } from "../log.ts";
import { peerIp } from "../auth/login.ts";
import { persistConn } from "../runtime/slots.ts";
import { conns } from "../runtime/state.ts";
import type { Conn } from "../runtime/types.ts";
import { defaultModel } from "../runtime/env.ts";
import { handleMessage } from "./dispatch.ts";

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
  conns.set(ws, conn);

  ws.on("error", (err) => {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
    log.error("ws error", code || (err instanceof Error ? err.message : err));
  });

  ws.on("message", (data) => handleMessage({ ws, conn }, data));

  ws.on("close", () => {
    if (conn.authed) persistConn(conn);
    for (const slot of conn.slots.values()) {
      if (slot.owner === ws) slot.owner = null;
    }
    conns.delete(ws);
  });
}
