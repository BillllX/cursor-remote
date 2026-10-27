import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { mergeUploadedTurns } from "../src/runlog.ts";
import { gatewayState } from "../src/runtime/state.ts";
import type { Conn } from "../src/runtime/types.ts";
import type { Tenant } from "../src/tenants.ts";
import { onLoadChat } from "../src/ws/handlers/state.ts";

function tenantWith(turns: unknown[]): Tenant {
  return {
    id: "deferred-test",
    disk: {
      chats: [{ id: "chat-1", turns }],
      slots: [],
      rev: 7,
      deletedIds: [],
      chatRevs: { "chat-1": 7 },
    },
  } as unknown as Tenant;
}

function loadPage(
  caps: string[],
  maxMessageBytes = 2_000,
  turns: unknown[] = [{ id: "turn-1", user: "问题", assistant: "答".repeat(10_000) }],
) {
  let frame = "";
  const ws = {
    readyState: WebSocket.OPEN,
    send(value: string) {
      frame = value;
    },
  } as unknown as WebSocket;
  const conn = {
    ws,
    maxMessageBytes,
    caps: new Set(caps),
  } as Conn;
  const tenant = tenantWith(turns);
  onLoadChat({ ws, conn, tenant, state: gatewayState }, { type: "load_chat", chatId: "chat-1" });
  return {
    frame,
    message: JSON.parse(frame) as {
      turns: Array<Record<string, unknown>>;
      from: number;
      hasMore: boolean;
      chatRev?: number;
    },
  };
}

describe("超大回合分页", () => {
  test("deferred_turn 能力收到占位，整页不超过 80% 预算", () => {
    const { frame, message } = loadPage(["deferred_turn"]);
    assert.ok(Buffer.byteLength(frame) <= 1_600);
    assert.equal(message.turns.length, 1);
    assert.equal(message.turns[0].id, "turn-1");
    assert.equal(message.turns[0].deferred, true);
    assert.equal(message.chatRev, 7);
    assert.equal(message.turns[0].clipped, true);
    assert.equal(
      message.turns[0].bodyBytes,
      Buffer.byteLength(JSON.stringify({ id: "turn-1", user: "问题", assistant: "答".repeat(10_000) })),
    );
  });

  test("多字节预览按实际预算缩短且仍推进分页", () => {
    const { frame, message } = loadPage(["deferred_turn"], 500, [
      { id: "turn-1", user: "问".repeat(1_000), assistant: "🙂".repeat(1_000) },
    ]);
    assert.ok(Buffer.byteLength(frame) <= 400);
    assert.equal(message.turns.length, 1);
    assert.equal(message.turns[0].deferred, true);
    assert.equal(message.from, 0);
  });

  test("极小预算或超长 id 放不下最小占位时消费该回合，不在同一 from 空转", () => {
    const { message } = loadPage(["deferred_turn"], 100, [
      { id: "很长".repeat(1_000), user: "问题", assistant: "回答".repeat(1_000) },
    ]);
    assert.deepEqual(message.turns, []);
    assert.equal(message.from, 0);
    assert.equal(message.hasMore, false);
  });

  test("生成 deferred 占位只序列化一次巨型原回合", () => {
    let calls = 0;
    const turn = {
      id: "turn-1",
      user: "问题",
      assistant: "回答",
      toJSON() {
        calls += 1;
        return { id: this.id, user: this.user, assistant: "答".repeat(10_000) };
      },
    };
    const { message } = loadPage(["deferred_turn"], 2_000, [turn]);
    assert.equal(message.turns[0].deferred, true);
    assert.equal(calls, 1);
  });

  test("旧客户端继续收到 clipped 兼容副本", () => {
    const { frame, message } = loadPage([]);
    assert.ok(Buffer.byteLength(frame) <= 1_600);
    assert.equal(message.turns[0].id, "turn-1");
    assert.equal(message.turns[0].clipped, true);
    assert.equal(message.turns[0].deferred, undefined);
  });

  test("上传 deferred 占位不会覆盖服务端完整正文", () => {
    const full = { id: "turn-1", user: "问题", assistant: "完整回答" };
    const placeholder = {
      id: "turn-1",
      user: "问题",
      assistant: "预览",
      deferred: true,
      bodyBytes: 1234,
    };
    assert.deepEqual(mergeUploadedTurns([full], [placeholder], null).turns, [full]);
  });
});
