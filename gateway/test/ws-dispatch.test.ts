import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.ts";
import { createGatewayState } from "../src/runtime/state.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";
import type { Tenant } from "../src/tenants.ts";
import { handleMessage, handlers } from "../src/ws/dispatch.ts";
import type { HandlerTable } from "../src/ws/handlers/types.ts";
import { loadProtocolTypes } from "./protocolTypes.ts";

// 租户名单首次使用时才加载：指到临时目录里的单租户，免得读到本机真实的 tenants.json 和状态目录
const dir = mkdtempSync(join(tmpdir(), "cr-dispatch-"));
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = "dispatch-test-token";
process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "test";
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 在 dispatch 入口里单独处理、不进注册表的 type */
const PRE_AUTH = ["ping", "hello"];
/** 协议里有、但网关有意不处理的 ClientMessage type → 理由（目前没有） */
const EXEMPT: Record<string, string> = {};

/** 假连接：send 的帧解析后记下来；每个用例一份独立的运行时状态，不碰进程内的 gatewayState */
function fake(authed: boolean, slots: Array<Partial<Slot>> = []) {
  const sent: ServerMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => sent.push(JSON.parse(frame) as ServerMessage),
  } as unknown as WebSocket;
  const conn = {
    authed,
    ip: "203.0.113.9",
    tenant: authed ? ({ id: "t1", name: "测试" } as Tenant) : null,
    slots: new Map(slots.map((slot) => [slot.chatId!, slot as Slot])),
    caps: new Set(),
    maxMessageBytes: 0,
  } as unknown as Conn;
  const state = createGatewayState();
  state.conns.set(ws, conn);
  return { ctx: { ws, conn, state }, sent };
}
const raw = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));

describe("handleMessage 入口顺序", () => {
  test("未鉴权时发普通消息：回「先发 hello。」，不进处理函数", async () => {
    const { ctx, sent } = fake(false);
    let called = false;
    await handleMessage(ctx, raw({ type: "set_model", model: "m" }), {
      set_model: () => {
        called = true;
      },
    });
    assert.equal(called, false);
    assert.deepEqual(sent, [{ type: "error", message: "先发 hello。" }]);
  });

  test("ping 未鉴权也回 pong", async () => {
    const { ctx, sent } = fake(false);
    await handleMessage(ctx, raw({ type: "ping" }));
    assert.deepEqual(sent, [{ type: "pong" }]);
  });

  test("hello 在鉴权门槛之前处理：口令不对回 auth 失败", async () => {
    const { ctx, sent } = fake(false);
    await handleMessage(ctx, raw({ type: "hello", token: "wrong" }));
    assert.deepEqual(sent, [{ type: "auth", ok: false, message: "密码不对。" }]);
    assert.equal(ctx.conn.authed, false);
  });

  test("非法 JSON、没有 type 的消息被忽略", async () => {
    const { ctx, sent } = fake(true);
    await handleMessage(ctx, raw("{not json"));
    await handleMessage(ctx, raw({ chatId: "c" }));
    await handleMessage(ctx, raw("null"));
    assert.deepEqual(sent, []);
  });

  test("已鉴权时未知 type 静默忽略", async () => {
    const { ctx, sent } = fake(true);
    await handleMessage(ctx, raw({ type: "no_such_type" }), {});
    await handleMessage(ctx, raw({ type: "set_model", model: "m" }), {});
    assert.deepEqual(sent, []);
  });

  test("处理函数拿到 ws / conn / state / 鉴权时的 tenant 与原消息", async () => {
    const { ctx } = fake(true);
    const seen: unknown[] = [];
    await handleMessage(ctx, raw({ type: "drop_queued", chatId: "c", text: "x" }), {
      drop_queued: (handlerCtx, message) => {
        seen.push(handlerCtx.ws, handlerCtx.conn, handlerCtx.state, handlerCtx.tenant, message);
      },
    });
    assert.equal(seen[2], ctx.state);
    assert.deepEqual(seen, [
      ctx.ws,
      ctx.conn,
      ctx.state,
      ctx.conn.tenant,
      { type: "drop_queued", chatId: "c", text: "x" },
    ]);
  });

  test("口令错误只记在这份状态的 loginHits 里", async () => {
    const { ctx } = fake(false);
    const other = fake(false);
    await handleMessage(ctx, raw({ type: "hello", token: "wrong" }));
    assert.equal(ctx.state.loginHits.get("203.0.113.9")?.count, 1);
    assert.equal(other.ctx.state.loginHits.size, 0);
  });
});

describe("handleMessage 错误处理同原 catch", () => {
  const throwing: Record<string, HandlerTable> = {
    同步抛错: {
      cancel: () => {
        throw new Error("同步炸了");
      },
    },
    异步抛错: {
      cancel: async () => {
        await Promise.resolve();
        throw new Error("异步炸了");
      },
    },
  };
  for (const [name, table] of Object.entries(throwing)) {
    test(`${name}：回带 chatId 的 error，已收尾的槽位不再 finishRun`, async () => {
      const slot = { chatId: "c1", finished: true, run: "still-here" } as unknown as Partial<Slot>;
      const { ctx, sent } = fake(true, [slot]);
      await handleMessage(ctx, raw({ type: "cancel", chatId: "c1" }), table);
      assert.deepEqual(sent, [{ type: "error", chatId: "c1", message: name === "同步抛错" ? "同步炸了" : "异步炸了" }]);
      // finishRun 会把 run 清成 null；已收尾的槽位不应被碰
      assert.equal((slot as { run: unknown }).run, "still-here");
    });
  }

  test("抛出的不是 Error：消息为「gateway 出错了」；没有 chatId 时 error 不带 chatId", async () => {
    const { ctx, sent } = fake(true);
    await handleMessage(ctx, raw({ type: "list_workspaces" }), {
      list_workspaces: () => {
        throw "not an error";
      },
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { type: "error", message: "gateway 出错了" });
  });

  test("tagged 请求失败时 error 回显 reqId，客户端可精确结清", async () => {
    const { ctx, sent } = fake(true);
    await handleMessage(ctx, raw({ type: "list_files", chatId: "c1", query: "", reqId: "rq-files-1" }), {
      list_files: () => {
        throw new Error("列文件失败");
      },
    });
    assert.deepEqual(sent, [
      {
        type: "files",
        chatId: "c1",
        query: "",
        mention: false,
        reqId: "rq-files-1",
        paths: [],
        status: {},
        truncated: false,
        error: "列文件失败",
      },
    ]);
  });
});

describe("ClientMessage 覆盖", () => {
  const client = loadProtocolTypes().client;
  test("每个 ClientMessage type 都有处理（ping/hello 在入口，其余在注册表），或在豁免清单里", () => {
    const handled = new Set([...PRE_AUTH, ...Object.keys(handlers)]);
    const missing = [...client].filter((type) => !handled.has(type) && !(type in EXEMPT));
    assert.deepEqual(missing, [], `没有处理也没有豁免的 type：${missing.join("、")}`);
  });
  test("注册表与豁免清单里没有协议之外或重复登记的 type", () => {
    assert.deepEqual(
      Object.keys(handlers).filter((type) => !client.has(type)),
      [],
    );
    assert.deepEqual(
      Object.keys(handlers).filter((type) => PRE_AUTH.includes(type)),
      [],
    );
    const staleExempt = Object.keys(EXEMPT).filter((type) => !client.has(type) || type in handlers);
    assert.deepEqual(staleExempt, [], `豁免清单里已失效的条目：${staleExempt.join("、")}`);
  });
});
