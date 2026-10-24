import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { WebSocket } from "ws";
import type { DeviceResult, ServerMessage } from "../../shared/protocol.ts";
import { assistantTools, assistantToolNames, type ToolHost } from "../src/assistant/tools.ts";
import { foregroundTools, startAssistant, stopAssistant } from "../src/assistant/service.ts";
import { listInbox } from "../src/assistant/inbox.ts";
import { assistantPath, type TenantRef } from "../src/assistant/store.ts";
import { DeviceBridgeError, DeviceRegistry, type DeviceInvokeInput } from "../src/device/registry.ts";
import { summarizeDeviceParams, writeDeviceAudit } from "../src/device/audit.ts";
import { createGatewayState } from "../src/runtime/state.ts";
import type { Conn } from "../src/runtime/types.ts";

const root = mkdtempSync(join(tmpdir(), "cr-device-"));
after(() => rmSync(root, { recursive: true, force: true }));

function ref(id: string): TenantRef {
  return { id, stateDir: join(root, id) };
}

function fakeConn(
  tenant: TenantRef,
  options: { cap?: boolean; authed?: boolean; open?: boolean; deviceId?: string } = {},
) {
  const ws = { readyState: options.open === false ? 3 : 1 } as WebSocket;
  const conn = {
    authed: options.authed ?? true,
    tenant: { ...tenant, id: tenant.id },
    caps: new Set(options.cap === false ? [] : ["device_bridge"]),
    ws,
    ip: "127.0.0.1",
    deviceId: options.deviceId ?? `phone-${tenant.id}`,
  } as unknown as Conn;
  return { ws, conn };
}

function input(op: DeviceInvokeInput["op"] = "calendar_events_list"): DeviceInvokeInput {
  return { op, params: { start: "2026-10-23T00:00:00Z", end: "2026-10-24T00:00:00Z" }, actor: "chat:c1" };
}

function harness(rows: Array<{ ws: WebSocket; conn: Conn }>, options: { timeoutMs?: number } = {}) {
  const state = createGatewayState();
  for (const row of rows) state.conns.set(row.ws, row.conn);
  const sent: Array<{ conn: Conn; message: ServerMessage }> = [];
  const audits: unknown[] = [];
  const security: string[] = [];
  let seq = 0;
  const registry = new DeviceRegistry({
    state,
    send: (conn, message) => sent.push({ conn, message }),
    audit: (_tenant, record) => audits.push(record),
    reqId: () => `req-${++seq}`,
    timeoutMs: () => options.timeoutMs ?? 30_000,
    securityLog: (message) => security.push(message),
  });
  return { registry, sent, audits, security };
}

function ok(reqId: string, op: string = "calendar_events_list"): DeviceResult {
  return { type: "device_result", reqId, op, status: "ok", result: { count: 1 } };
}

describe("DeviceRegistry", () => {
  test("只选择同租户、已鉴权、有 cap 且在线的一个设备并单播参数", async () => {
    const tenant = ref("tenant-a");
    const wrongTenant = fakeConn(ref("tenant-b"));
    const noCap = fakeConn(tenant, { cap: false });
    const closed = fakeConn(tenant, { open: false });
    const selected = fakeConn(tenant);
    const h = harness([wrongTenant, noCap, closed, selected]);

    const pending = h.registry.invoke(tenant, input());
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]?.conn, selected.conn);
    const sent = h.sent[0]?.message as Extract<ServerMessage, { type: "device_invoke" }>;
    assert.ok(sent.timeoutMs > 29_000 && sent.timeoutMs <= 30_000);
    assert.deepEqual(
      { ...sent, timeoutMs: 30_000 },
      {
        type: "device_invoke",
        reqId: "req-1",
        op: "calendar_events_list",
        params: input().params,
        timeoutMs: 30_000,
        idempotencyKey: undefined,
        approval: undefined,
      },
    );
    assert.equal(h.registry.handleResult(selected.conn, ok("req-1")), true);
    assert.equal((await pending).status, "ok");
  });

  test("租户错配、无 cap 和未知 reqId 都不会完成请求，并写安全日志", async () => {
    const tenant = ref("tenant-sec");
    const selected = fakeConn(tenant);
    const other = fakeConn(ref("tenant-other"));
    const noCap = fakeConn(tenant, { cap: false });
    const h = harness([selected, other, noCap]);
    const pending = h.registry.invoke(tenant, input());

    assert.equal(h.registry.handleResult(other.conn, ok("req-1")), false);
    assert.equal(h.registry.handleResult(noCap.conn, ok("req-1")), false);
    assert.equal(h.registry.handleResult(selected.conn, ok("missing")), false);
    assert.equal(h.security.length, 3);
    h.registry.handleResult(selected.conn, ok("req-1"));
    await pending;
  });

  test("读操作超时返回结构化错误且审计失败", async () => {
    const tenant = ref("tenant-timeout");
    const selected = fakeConn(tenant);
    const h = harness([selected], { timeoutMs: 5 });
    await assert.rejects(
      h.registry.invoke(tenant, input()),
      (error: unknown) => error instanceof DeviceBridgeError && error.code === "timeout",
    );
    assert.equal((h.audits[0] as { status: string }).status, "error");
  });

  test("超时为同一幂等键保留有限墓碑，迟到结果和传输重试都不会再次写", async () => {
    const tenant = ref("tenant-timeout-idem");
    const selected = fakeConn(tenant);
    const h = harness([selected], { timeoutMs: 5 });
    const request = { ...input("reminders_upsert"), idempotencyKey: "call-timeout" };
    const timedOut = assert.rejects(h.registry.invoke(tenant, request), { code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await timedOut;
    assert.equal(h.registry.handleResult(selected.conn, ok("req-1", "reminders_upsert")), false);
    await assert.rejects(h.registry.invoke(tenant, request), { code: "timeout" });
    assert.equal(h.sent.length, 1);
  });

  test("设备断线拒绝 pending；错误结果正常完成并写审计", async () => {
    const tenant = ref("tenant-close");
    const selected = fakeConn(tenant);
    const h = harness([selected]);
    const disconnected = h.registry.invoke(tenant, input());
    h.registry.close(selected.conn);
    await assert.rejects(
      disconnected,
      (error: unknown) => error instanceof DeviceBridgeError && error.code === "disconnected",
    );

    const failed = h.registry.invoke(tenant, input());
    h.registry.handleResult(selected.conn, {
      type: "device_result",
      reqId: "req-2",
      op: "calendar_events_list",
      status: "error",
      error: "EventKit unavailable",
    });
    assert.equal((await failed).status, "error");
    assert.equal((h.audits.at(-1) as { status: string }).status, "error");
  });

  test("同一租户/op/幂等键复用在途与 24 小时结果缓存", async () => {
    const tenant = ref("tenant-idem");
    const selected = fakeConn(tenant);
    const h = harness([selected]);
    const request = { ...input("reminders_upsert"), idempotencyKey: "idem-1" };
    const first = h.registry.invoke(tenant, request);
    const inflight = h.registry.invoke(tenant, request);
    assert.equal(h.sent.length, 1);
    h.registry.handleResult(selected.conn, ok("req-1", "reminders_upsert"));
    assert.equal(await first, await inflight);
    assert.equal((await h.registry.invoke(tenant, request)).status, "ok");
    assert.equal(h.sent.length, 1);
  });

  test("只缓存写成功；读结果和写失败允许下一次调用执行", async () => {
    const tenant = ref("tenant-cache-policy");
    const selected = fakeConn(tenant);
    const h = harness([selected]);
    const read = { ...input(), idempotencyKey: "read-call" };
    const firstRead = h.registry.invoke(tenant, read);
    h.registry.handleResult(selected.conn, ok("req-1"));
    await firstRead;
    const secondRead = h.registry.invoke(tenant, read);
    assert.equal(h.sent.length, 2);
    h.registry.handleResult(selected.conn, ok("req-2"));
    await secondRead;

    const write = { ...input("reminders_upsert"), idempotencyKey: "failed-call" };
    const failed = h.registry.invoke(tenant, write);
    h.registry.handleResult(selected.conn, {
      type: "device_result",
      reqId: "req-3",
      op: "reminders_upsert",
      status: "denied",
    });
    assert.equal((await failed).status, "denied");
    const retry = h.registry.invoke(tenant, write);
    assert.equal(h.sent.length, 4);
    h.registry.handleResult(selected.conn, ok("req-4", "reminders_upsert"));
    await retry;
  });

  test("设备返回 unavailable/busy 时按顺序尝试其他同租户设备且不并发弹窗", async () => {
    const tenant = ref("tenant-fallback");
    const first = fakeConn(tenant, { deviceId: "first" });
    const second = fakeConn(tenant, { deviceId: "second" });
    const h = harness([first, second]);
    const pending = h.registry.invoke(tenant, {
      ...input("calendar_event_upsert"),
      approval: { summary: "写日历", risk: "会保存", requiresConfirmation: true },
    });
    assert.equal(h.sent.length, 1);
    assert.equal(
      h.registry.handleResult(first.conn, {
        type: "device_result",
        reqId: "req-1",
        op: "calendar_event_upsert",
        status: "unavailable",
      }),
      true,
    );
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1]?.conn, second.conn);
    assert.deepEqual((h.sent[1]?.message as { approval?: unknown }).approval, {
      summary: "写日历",
      risk: "会保存",
      requiresConfirmation: true,
    });
    h.registry.handleResult(second.conn, ok("req-1", "calendar_event_upsert"));
    assert.equal((await pending).status, "ok");
  });
});

describe("设备审计", () => {
  test("摘要和落盘记录不包含 notes、联系人查询、地址、电话或标题正文", () => {
    const sensitive = {
      title: "私人会议",
      notes: "电话 13800138000，地址秘密路 1 号",
      query: "张三 13800138000",
      address: "秘密路 1 号",
      phone: "13800138000",
      start: "2026-10-23T08:00:00Z",
    };
    assert.deepEqual(summarizeDeviceParams("calendar_event_upsert", sensitive), {
      hasExternalId: false,
      hasTitle: true,
      hasNotes: true,
    });
    const tenant = ref("tenant-audit");
    writeDeviceAudit(tenant, {
      op: "contacts_search",
      actor: "chat:c1",
      at: "2026-10-23T08:00:00.000Z",
      deviceHash: "0123456789abcdef",
      summary: summarizeDeviceParams("contacts_search", sensitive),
      status: "ok",
      externalId: "contact-1",
    });
    const text = readFileSync(assistantPath(tenant, "device-audit.jsonl"), "utf8");
    for (const secret of Object.values(sensitive)) assert.equal(text.includes(secret), false);
    assert.match(text, /"queryLength":/);
    assert.match(text, /"externalId":"contact-1"/);
  });
});

describe("助理设备工具", () => {
  const deviceNames = [
    "calendar_events_list",
    "calendar_event_upsert",
    "reminders_list",
    "reminders_upsert",
    "contacts_search",
  ];

  function host(
    role: ToolHost["role"],
    invoke: NonNullable<ToolHost["deviceInvoke"]> = async () =>
      ({ type: "device_result", reqId: "r", op: "x", status: "ok" }) as DeviceResult,
  ): ToolHost {
    return { ref: ref(`tools-${role}`), role, chatId: "c1", deviceInvoke: invoke };
  }

  test("五个工具只在 chat role 出现", () => {
    for (const name of deviceNames) assert.equal(assistantToolNames(host("chat")).includes(name), true);
    for (const role of ["schedule", "integrator", "loop"] as const) {
      for (const name of deviceNames) assert.equal(assistantToolNames(host(role)).includes(name), false);
    }
  });

  test("两个写工具向 iOS 下发 requiresConfirmation、风险与幂等键", async () => {
    const calls: Parameters<NonNullable<ToolHost["deviceInvoke"]>>[0][] = [];
    const tools = assistantTools(
      host("chat", async (request) => {
        calls.push(request);
        return { type: "device_result", reqId: "r", op: request.op, status: "ok" };
      }),
    );
    await tools.calendar_event_upsert!.execute(
      { title: "评审", start: "2026-10-24T09:00:00+08:00", end: "2026-10-24T10:00:00+08:00" },
      {} as never,
    );
    await tools.reminders_upsert!.execute({ title: "交报告" }, {} as never);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.approval?.requiresConfirmation, true);
      assert.ok(call.approval?.summary);
      assert.ok(call.approval?.risk);
      assert.ok(call.idempotencyKey);
    }
  });

  test("幂等键绑定真实 toolCallId：同一调用重传复用，参数相同的独立调用不复用", async () => {
    const calls: Parameters<NonNullable<ToolHost["deviceInvoke"]>>[0][] = [];
    const tools = assistantTools(
      host("chat", async (request) => {
        calls.push(request);
        return { type: "device_result", reqId: "r", op: request.op, status: "ok" };
      }),
    );
    const args = { title: "同样标题" };
    await tools.reminders_upsert!.execute(args, { toolCallId: "call-a" });
    await tools.reminders_upsert!.execute(args, { toolCallId: "call-a" });
    await tools.reminders_upsert!.execute(args, { toolCallId: "call-b" });
    assert.equal(calls[0]?.idempotencyKey, calls[1]?.idempotencyKey);
    assert.notEqual(calls[0]?.idempotencyKey, calls[2]?.idempotencyKey);
  });

  test("没有设备时工具保留结构化 no_device", async () => {
    const tools = assistantTools(host("chat", async () => ({ status: "no_device", error: "没有在线设备" })));
    const result = await tools.contacts_search!.execute({ query: "张三" }, {} as never);
    assert.equal(result, JSON.stringify({ status: "no_device", error: "没有在线设备" }));
  });

  test("service 在无设备时返回 no_device，并按幂等键只提示一次收件箱", async () => {
    const tenant = { ...ref("tools-no-device"), name: "测试租户", workspaceRoot: join(root, "workspace") };
    startAssistant({
      tenants: () => [tenant],
      publish: () => undefined,
      globalStateDir: root,
      delegate: async () => "",
      workspaces: () => [],
      createWorkspace: async () => "",
      appUrl: () => "./",
      deviceInvoke: async () => {
        throw new DeviceBridgeError("no_device", "没有设备");
      },
    });
    try {
      const tools = foregroundTools(tenant, "assistant-chat");
      const first = await tools.contacts_search!.execute({ query: "张三" }, {} as never);
      const second = await tools.contacts_search!.execute({ query: "李四" }, {} as never);
      assert.equal(first, JSON.stringify({ status: "no_device", error: "没有在线且已授权的 Apple 设备。" }));
      assert.equal(second, first);
      const notices = listInbox(tenant).filter((item) => item.key === "device:no-device:assistant-chat");
      assert.equal(notices.length, 1);
    } finally {
      stopAssistant();
    }
  });
});
