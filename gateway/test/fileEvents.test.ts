import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.ts";
import { broadcastFileChanged } from "../src/fileEvents.ts";
import { gatewayState } from "../src/runtime/state.ts";

afterEach(() => gatewayState.conns.clear());

function peer(tenantId: string) {
  const messages: ServerMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(frame: string) {
      messages.push(JSON.parse(frame) as ServerMessage);
    },
  } as unknown as WebSocket;
  gatewayState.conns.set(ws, { ws, authed: true, tenant: { id: tenantId }, maxMessageBytes: 0 } as never);
  return messages;
}

describe("file_changed 广播", () => {
  test("同租户所有设备收到归一化路径，重复和空路径只发一次", () => {
    const first = peer("a");
    const second = peer("a");
    const other = peer("b");
    broadcastFileChanged("a", "chat-1", ["src/a.ts", "", "src/a.ts", "src/b.ts"]);
    const expected: ServerMessage[] = [
      { type: "file_changed", chatId: "chat-1", path: "src/a.ts" },
      { type: "file_changed", chatId: "chat-1", path: "src/b.ts" },
    ];
    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.deepEqual(other, []);
  });
});
