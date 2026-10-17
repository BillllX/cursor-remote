import { WebSocket } from "ws";
import type { CanvasVersion, TurnFile } from "../../shared/protocol.ts";
import { gatewayState } from "./runtime/state.ts";
import { reply } from "./ws/frame.ts";

export function broadcastTurnFiles(tenantId: string, chatId: string, turnId: string, files: TurnFile[]) {
  if (!chatId || !turnId || !files.length) return;
  for (const conn of gatewayState.conns.values()) {
    if (!conn.authed || conn.tenant?.id !== tenantId || conn.ws.readyState !== WebSocket.OPEN) continue;
    reply(conn.ws, { type: "turn_files", chatId, turnId, files });
  }
}

/** 文件变化是租户级状态：发给所有设备；path 必须已经按该 chat 的 cwd 归一化。 */
export function broadcastFileChanged(tenantId: string, chatId: string, paths: Iterable<string>) {
  const unique = new Set([...paths].filter(Boolean));
  if (!chatId || !unique.size) return;
  for (const conn of gatewayState.conns.values()) {
    if (!conn.authed || conn.tenant?.id !== tenantId || conn.ws.readyState !== WebSocket.OPEN) continue;
    for (const path of unique) reply(conn.ws, { type: "file_changed", chatId, path });
  }
}

export function broadcastCanvasVersions(tenantId: string, chatId: string, path: string, versions: CanvasVersion[]) {
  for (const conn of gatewayState.conns.values()) {
    if (!conn.authed || conn.tenant?.id !== tenantId || conn.ws.readyState !== WebSocket.OPEN) continue;
    reply(conn.ws, { type: "canvas_versions", chatId, path, versions });
  }
}
