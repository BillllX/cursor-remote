import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { AssistantState, ServerMessage } from "../../shared/protocol.ts";
import {
  ASSISTANT_PROJECTION_SCHEMA,
  bumpAssistantRevision,
  readAssistantRevision,
} from "../src/assistant/revision.ts";
import {
  publishState,
  startAssistant,
  stopAssistant,
  watchMemory,
  type AssistantTenant,
} from "../src/assistant/service.ts";
import { assistantPath, writeJson, type TenantRef } from "../src/assistant/store.ts";
import { refreshAssistantProjectionCondition } from "../src/assistant/projectionCondition.ts";
import { addTodo } from "../src/assistant/todos.ts";
import { onAssistantGet } from "../src/ws/handlers/assistant.ts";
import type { WsCtx } from "../src/ws/handlers/types.ts";

const root = mkdtempSync(resolve(tmpdir(), "cr-assistant-revision-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ref = (id: string): TenantRef => ({ id, stateDir: resolve(root, id) });

function handlerContext(tenant: TenantRef) {
  const sent: ServerMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (frame: string) => sent.push(JSON.parse(frame) as ServerMessage),
  } as unknown as WebSocket;
  return { sent, ctx: { ws, tenant } as unknown as WsCtx };
}

const stateAt = (revision: number) =>
  ({
    revision,
    name: "测试助理",
    background: { model: "test", ok: true },
    inbox: [],
    todos: [],
    schedules: [],
    delegations: [],
    approvals: [],
    runs: [],
  }) as AssistantState;

const idle = {
  pending: () => false,
  settle: async () => undefined,
};

describe("助理投影 revision", () => {
  test("knownRevision 相等时直接 not_modified，不构建状态", async () => {
    const tenant = ref("not-modified");
    const { ctx, sent } = handlerContext(tenant);
    let builds = 0;
    await onAssistantGet(
      ctx,
      { type: "assistant_get", knownRevision: 7, reqId: "req-7", generation: 3 },
      {
        ...idle,
        revision: () => 7,
        build: async () => {
          builds += 1;
          return stateAt(7);
        },
      },
    );
    assert.equal(builds, 0);
    assert.deepEqual(sent, [
      {
        type: "assistant_not_modified",
        revision: 7,
        reqId: "req-7",
        generation: 3,
      },
    ]);
  });

  test("revision 变化时构建并返回带同一 revision 的新状态", async () => {
    const tenant = ref("changed");
    const { ctx, sent } = handlerContext(tenant);
    let options: unknown;
    await onAssistantGet(
      ctx,
      { type: "assistant_get", knownRevision: 4, memory: true },
      {
        ...idle,
        revision: () => 5,
        build: async (_tenant, opts) => {
          options = opts;
          return stateAt(5);
        },
      },
    );
    assert.deepEqual(options, { memory: true, revision: 5 });
    assert.deepEqual(sent, [{ type: "assistant_state", state: stateAt(5) }]);
  });

  test("双副本保持单调；主文件损坏由备份修复，两份丢失建立新代际", () => {
    const tenant = ref("persistence");
    const initial = readAssistantRevision(tenant);
    assert.ok(initial > 0);
    assert.deepEqual(JSON.parse(readFileSync(assistantPath(tenant, "revision.json"), "utf8")), {
      schema: ASSISTANT_PROJECTION_SCHEMA,
      revision: initial,
    });
    assert.equal(bumpAssistantRevision(tenant), initial + 1);
    assert.equal(readAssistantRevision(tenant), initial + 1);

    writeFileSync(assistantPath(tenant, "revision.json"), "{broken");
    assert.equal(readAssistantRevision(tenant), initial + 1);
    assert.deepEqual(JSON.parse(readFileSync(assistantPath(tenant, "revision.json"), "utf8")), {
      schema: ASSISTANT_PROJECTION_SCHEMA,
      revision: initial + 1,
    });
    rmSync(assistantPath(tenant, "revision.json"));
    assert.equal(readAssistantRevision(tenant), initial + 1);
  });

  test("旧 revision 文件按投影 schema 只迁移并 bump 一次", () => {
    const tenant = ref("schema-migration");
    writeJson(assistantPath(tenant, "revision.json"), { revision: 8 });
    assert.equal(readAssistantRevision(tenant), 9);
    assert.equal(readAssistantRevision(tenant), 9);
    assert.deepEqual(JSON.parse(readFileSync(assistantPath(tenant, "revision.json"), "utf8")), {
      schema: ASSISTANT_PROJECTION_SCHEMA,
      revision: 9,
    });
  });

  test("并发触发的 bump 仍得到唯一、严格递增并持久化的 revision", async () => {
    const tenant = ref("concurrent");
    const revisions = await Promise.all(
      Array.from({ length: 20 }, async () => {
        await Promise.resolve();
        return bumpAssistantRevision(tenant);
      }),
    );
    const start = revisions[0] - 1;
    assert.deepEqual(
      revisions,
      Array.from({ length: 20 }, (_, index) => start + index + 1),
    );
    assert.equal(readAssistantRevision(tenant), start + 20);
  });

  test("并发 publish 串行发出递增快照，旧 revision 不会后到覆盖", async () => {
    const tenant: AssistantTenant = {
      id: "publish-concurrent",
      name: "测试",
      stateDir: resolve(root, "publish-concurrent"),
      workspaceRoot: resolve(root, "workspace"),
    };
    const published: number[] = [];
    let firstRevision = 0;
    startAssistant({
      tenants: () => [tenant],
      publish: (_tenantId, message) => {
        if (message.type === "assistant_state") published.push(message.state.revision ?? 0);
      },
      globalStateDir: resolve(root, "global"),
      delegate: async () => "chat",
      workspaces: () => [],
      createWorkspace: async () => "workspace",
      appUrl: () => "https://example.test/",
    });
    try {
      const first = publishState(tenant);
      firstRevision = readAssistantRevision(tenant);
      const second = publishState(tenant);
      assert.equal(readAssistantRevision(tenant), firstRevision + 1);
      const third = publishState(tenant);
      assert.equal(readAssistantRevision(tenant), firstRevision + 2);
      await Promise.all([first, second, third]);
    } finally {
      stopAssistant();
    }
    assert.deepEqual(published, [firstRevision, firstRevision + 1, firstRevision + 2]);
    assert.equal(readAssistantRevision(tenant), firstRevision + 2);
  });

  test("assistant_get 构建期间 revision 变化会丢弃旧快照并重建", async () => {
    const tenant = ref("get-build-race");
    const { ctx, sent } = handlerContext(tenant);
    let current = 5;
    const builds: number[] = [];
    await onAssistantGet(
      ctx,
      { type: "assistant_get", knownRevision: 4 },
      {
        ...idle,
        revision: () => current,
        build: async (_tenant, options) => {
          assert.ok(options);
          const revision = options.revision!;
          builds.push(revision);
          if (revision === 5) current = 6;
          return stateAt(revision);
        },
      },
    );
    assert.deepEqual(builds, [5, 6]);
    assert.deepEqual(sent, [{ type: "assistant_state", state: stateAt(6) }]);
  });

  test("assistant_get 等待发布队列稳定后才判断 not_modified", async () => {
    const tenant = ref("get-not-modified-race");
    const { ctx, sent } = handlerContext(tenant);
    let current = 7;
    let pending = true;
    let builds = 0;
    await onAssistantGet(
      ctx,
      { type: "assistant_get", knownRevision: 7 },
      {
        revision: () => current,
        pending: () => pending,
        settle: async () => {
          current = 8;
          pending = false;
        },
        build: async (_tenant, options) => {
          assert.ok(options);
          builds += 1;
          return stateAt(options.revision!);
        },
      },
    );
    assert.equal(builds, 1);
    assert.deepEqual(sent, [{ type: "assistant_state", state: stateAt(8) }]);
  });

  test("投影时间条件覆盖跨日和待办到期，单副本损坏可无 bump 恢复", () => {
    const tenant = ref("projection-condition");
    const beforeDue = Date.parse("2026-10-25T08:00:00+08:00");
    assert.equal(
      addTodo(tenant, {
        text: "十点处理",
        due: "2026-10-25T10:00:00+08:00",
        source: "user",
      }).ok,
      true,
    );
    assert.equal(refreshAssistantProjectionCondition(tenant, beforeDue), true);
    assert.equal(refreshAssistantProjectionCondition(tenant, beforeDue), false);

    assert.equal(refreshAssistantProjectionCondition(tenant, Date.parse("2026-10-25T11:00:00+08:00")), true);
    assert.equal(refreshAssistantProjectionCondition(tenant, Date.parse("2026-10-26T08:00:00+08:00")), true);

    rmSync(assistantPath(tenant, "projection-condition.json"));
    assert.equal(refreshAssistantProjectionCondition(tenant, Date.parse("2026-10-26T08:00:00+08:00")), false);
  });

  test("memory watcher 直推前复核实时租户绑定，重绑后不会收到旧租户记忆", async () => {
    const tenantA: AssistantTenant = {
      id: "watcher-a",
      name: "A",
      stateDir: resolve(root, "watcher-a"),
      workspaceRoot: resolve(root, "workspace-a"),
    };
    const tenantB: AssistantTenant = {
      id: "watcher-b",
      name: "B",
      stateDir: resolve(root, "watcher-b"),
      workspaceRoot: resolve(root, "workspace-b"),
    };
    const direct: ServerMessage[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (frame: string) => direct.push(JSON.parse(frame) as ServerMessage),
    } as unknown as WebSocket;
    const binding = { authed: true, tenant: tenantA, ws };
    const broadcasts: ServerMessage[] = [];
    startAssistant({
      tenants: () => [tenantA, tenantB],
      publish: (_tenantId, message) => broadcasts.push(message),
      globalStateDir: resolve(root, "global-watcher"),
      delegate: async () => "chat",
      workspaces: () => [],
      createWorkspace: async () => "workspace",
      appUrl: () => "https://example.test/",
    });
    try {
      watchMemory(tenantA.id, ws, true, binding);
      await publishState(tenantA);
      assert.equal(direct.length, 1);
      assert.ok(direct[0].type === "assistant_state" && direct[0].state.memory);

      direct.length = 0;
      binding.tenant = tenantB;
      await publishState(tenantA);
      assert.deepEqual(direct, []);
      const last = broadcasts.at(-1);
      assert.ok(last?.type === "assistant_state" && !last.state.memory);
    } finally {
      stopAssistant();
    }
  });

  test("memory watcher 取消订阅后 publish 不会直推 memory", async () => {
    const tenant: AssistantTenant = {
      id: "watcher-unsub",
      name: "U",
      stateDir: resolve(root, "watcher-unsub"),
      workspaceRoot: resolve(root, "workspace-u"),
    };
    const direct: ServerMessage[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: (frame: string) => direct.push(JSON.parse(frame) as ServerMessage),
    } as unknown as WebSocket;
    const binding = { authed: true, tenant, ws };
    startAssistant({
      tenants: () => [tenant],
      publish: () => {},
      globalStateDir: resolve(root, "global-watcher-unsub"),
      delegate: async () => "chat",
      workspaces: () => [],
      createWorkspace: async () => "workspace",
      appUrl: () => "https://example.test/",
    });
    try {
      watchMemory(tenant.id, ws, true, binding);
      await publishState(tenant);
      assert.equal(direct.length, 1);
      assert.ok(direct[0].type === "assistant_state" && direct[0].state.memory);
      watchMemory(tenant.id, ws, false);
      direct.length = 0;
      await publishState(tenant);
      assert.deepEqual(direct, []);
    } finally {
      stopAssistant();
    }
  });
});
