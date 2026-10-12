import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import { drainPending } from "../src/chat/runner.ts";
import { conns, liveSlotsOf } from "../src/runtime/state.ts";
import type { Conn, Slot } from "../src/runtime/types.ts";
import { allTenants } from "../src/tenants.ts";

// 租户名单是首次使用时才加载的：改成临时目录里的单租户，免得读到本机真实的 tenants.json
const dir = mkdtempSync(join(tmpdir(), "cr-runner-"));
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = "runner-test-token";
process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "test";
after(() => {
  conns.clear();
  rmSync(dir, { recursive: true, force: true });
});

const ws = {} as WebSocket;
const conn = {} as Conn;
const queued = () => ({ text: "下一条" }) as Slot["pending"][number];
function slotWith(fields: Partial<Slot>): Slot {
  return {
    chatId: "c",
    epoch: 1,
    pending: [queued()],
    finished: true,
    run: undefined,
    externalAbort: undefined,
    owner: null,
    ...fields,
  } as Slot;
}
const tick = () => new Promise((done) => setTimeout(done, 0));

describe("drainPending 排队守卫", () => {
  test("测试租户来自临时目录", () => {
    assert.deepEqual(
      allTenants().map((t) => t.workspaceRoot),
      [join(dir, "ws")],
    );
  });
  test("epoch 失配：过期栈不碰 pending", async () => {
    const slot = slotWith({ epoch: 2 });
    drainPending(ws, conn, slot, 1);
    await tick();
    assert.equal(slot.pending.length, 1);
  });
  test("还没收尾（finished=false）时消息留在队首", async () => {
    const slot = slotWith({ finished: false });
    drainPending(ws, conn, slot, 1);
    await tick();
    assert.equal(slot.pending.length, 1);
  });
  test("run 还在或第三方运行没结束时消息留在队首", async () => {
    const running = slotWith({ run: {} as Slot["run"] });
    const external = slotWith({ externalAbort: new AbortController() });
    drainPending(ws, conn, running, 1);
    drainPending(ws, conn, external);
    await tick();
    assert.equal(running.pending.length, 1);
    assert.equal(external.pending.length, 1);
  });
  test("本槽队列空时踢全局队列：没有 owner 或 owner 连接没开的槽位不出队", async () => {
    const tenant = allTenants()[0];
    const live = liveSlotsOf(tenant);
    const noOwner = slotWith({ chatId: "a" });
    const closedSock = { readyState: WebSocket.CLOSED } as WebSocket;
    const closedOwner = slotWith({ chatId: "b", owner: closedSock });
    conns.set(closedSock, { tenant } as Conn);
    live.set("a", noOwner);
    live.set("b", closedOwner);
    try {
      drainPending(ws, conn, slotWith({ pending: [] }), 1);
      await tick();
      assert.equal(noOwner.pending.length, 1);
      assert.equal(closedOwner.pending.length, 1);
    } finally {
      live.clear();
      conns.delete(closedSock);
    }
  });
});
