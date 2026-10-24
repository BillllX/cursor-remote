import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type {
  DeviceApproval,
  DeviceOp,
  DevicePermissionReport,
  DeviceResult,
  JSONValue,
  ServerMessage,
} from "../../../shared/protocol.ts";
import type { GatewayState } from "../runtime/state.ts";
import type { Conn } from "../runtime/types.ts";
import type { TenantRef } from "../assistant/store.ts";
import { gatewayState } from "../runtime/state.ts";
import { send } from "../ws/send.ts";
import { log } from "../log.ts";
import { hashDeviceId, summarizeDeviceParams, writeDeviceAudit, type DeviceAuditWriter } from "./audit.ts";

export const DEVICE_READ_TIMEOUT_MS = 30_000;
export const DEVICE_WRITE_TIMEOUT_MS = 120_000;
export const DEVICE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const DEVICE_SETTLED_TTL_MS = 10 * 60_000;
const DEVICE_SETTLED_MAX = 4_096;
const DEVICE_CACHE_MAX = 4_096;

export class DeviceBridgeError extends Error {
  constructor(
    readonly code: "no_device" | "timeout" | "disconnected" | "send_failed",
    message: string,
  ) {
    super(message);
  }
}

export type DeviceInvokeInput = {
  op: DeviceOp;
  params: JSONValue;
  actor: string;
  idempotencyKey?: string;
  approval?: DeviceApproval;
};

type Pending = {
  reqId: string;
  tenantId: string;
  conn: Conn;
  op: DeviceOp;
  params: JSONValue;
  actor: string;
  idempotencyKey?: string;
  approval?: DeviceApproval;
  cacheKey?: string;
  deadlineAt: number;
  attempted: Set<Conn>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: DeviceResult) => void;
  reject: (error: DeviceBridgeError) => void;
};

type Cached = { expiresAt: number; result: DeviceResult };
type Settled = { expiresAt: number; error: DeviceBridgeError };

export type DeviceRegistryDeps = {
  state: GatewayState;
  send: (conn: Conn, message: ServerMessage) => void;
  audit?: DeviceAuditWriter;
  now?: () => number;
  reqId?: () => string;
  /** 生产使用固定读/写超时；测试可缩短，但不能由客户端参数覆盖。 */
  timeoutMs?: (op: DeviceOp) => number;
  isOpen?: (conn: Conn) => boolean;
  securityLog?: (message: string) => void;
};

const isWriteOp = (op: DeviceOp) => op === "calendar_event_upsert" || op === "reminders_upsert";

export class DeviceRegistry {
  private readonly pending = new Map<string, Pending>();
  private readonly cache = new Map<string, Cached>();
  /** 超时调用的有限墓碑：同一 tool call 的传输重试不会再次写，迟到结果也不会复活请求。 */
  private readonly settled = new Map<string, Settled>();
  private readonly inflightByKey = new Map<string, Promise<DeviceResult>>();
  private readonly now: () => number;
  private readonly audit: DeviceAuditWriter;
  private readonly securityLog: (message: string) => void;

  constructor(private readonly deps: DeviceRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.audit = deps.audit ?? writeDeviceAudit;
    this.securityLog = deps.securityLog ?? ((message) => log.warn("device bridge security", message));
  }

  /** 只选一个同租户、已鉴权且声明能力的在线连接。 */
  select(tenantId: string, excluded: ReadonlySet<Conn> = new Set()): Conn | undefined {
    for (const conn of this.deps.state.conns.values()) {
      if (
        !excluded.has(conn) &&
        conn.authed &&
        conn.tenant?.id === tenantId &&
        conn.caps.has("device_bridge") &&
        (this.deps.isOpen?.(conn) ?? conn.ws.readyState === WebSocket.OPEN)
      ) {
        return conn;
      }
    }
    return undefined;
  }

  invoke(tenant: TenantRef, input: DeviceInvokeInput): Promise<DeviceResult> {
    this.pruneSettled();
    const cacheKey = input.idempotencyKey ? `${tenant.id}\0${input.op}\0${input.idempotencyKey}` : undefined;
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.result);
      const settled = this.settled.get(cacheKey);
      if (settled && settled.expiresAt > this.now()) return Promise.reject(settled.error);
      const inflight = this.inflightByKey.get(cacheKey);
      if (inflight) return inflight;
    }
    const promise = this.startInvoke(tenant, input, cacheKey);
    if (cacheKey) {
      this.inflightByKey.set(cacheKey, promise);
      void promise.finally(() => this.inflightByKey.delete(cacheKey)).catch(() => undefined);
    }
    return promise;
  }

  private startInvoke(tenant: TenantRef, input: DeviceInvokeInput, cacheKey?: string): Promise<DeviceResult> {
    const conn = this.select(tenant.id);
    if (!conn) return Promise.reject(new DeviceBridgeError("no_device", "没有可用的 Apple 设备。"));
    const reqId = this.deps.reqId?.() ?? `dev_${randomUUID()}`;
    const timeoutMs =
      this.deps.timeoutMs?.(input.op) ?? (isWriteOp(input.op) ? DEVICE_WRITE_TIMEOUT_MS : DEVICE_READ_TIMEOUT_MS);
    const promise = new Promise<DeviceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(reqId);
        if (!pending) return;
        this.pending.delete(reqId);
        const error = new DeviceBridgeError("timeout", "设备操作超时。");
        if (pending.cacheKey) this.rememberSettled(pending.cacheKey, error);
        reject(error);
        this.auditResult(pending, "error");
      }, timeoutMs);
      timer.unref?.();
      const pending: Pending = {
        reqId,
        tenantId: tenant.id,
        conn,
        op: input.op,
        params: input.params,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        approval: input.approval,
        cacheKey,
        deadlineAt: this.now() + timeoutMs,
        attempted: new Set([conn]),
        timer,
        resolve,
        reject,
      };
      this.pending.set(reqId, pending);
      try {
        this.sendPending(pending);
      } catch {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new DeviceBridgeError("send_failed", "设备请求发送失败。"));
        this.auditResult(pending, "error");
      }
    });
    if (!cacheKey || !isWriteOp(input.op)) return promise;
    return promise.then((result) => {
      if (result.status === "ok") {
        this.rememberCache(cacheKey, result);
      }
      return result;
    });
  }

  handleResult(conn: Conn, result: DeviceResult): boolean {
    const pending = this.pending.get(result.reqId);
    if (!this.validReply(conn, result.reqId, pending)) return false;
    if (result.op !== pending!.op) {
      this.securityLog(`op_mismatch reqId=${result.reqId}`);
      return false;
    }
    if (result.status === "unavailable" || result.status === "busy") {
      const next = this.select(pending!.tenantId, pending!.attempted);
      if (next) {
        pending!.conn = next;
        pending!.attempted.add(next);
        try {
          this.sendPending(pending!);
          return true;
        } catch {
          // 发送失败的设备也算尝试过；继续寻找下一个设备。
          return this.retryAfterSendFailure(pending!);
        }
      }
    }
    clearTimeout(pending!.timer);
    this.pending.delete(result.reqId);
    pending!.resolve(result);
    this.auditResult(pending!, result.status, result.externalId ?? externalIdFrom(result.result));
    return true;
  }

  handlePermissionReport(conn: Conn, report: DevicePermissionReport): boolean {
    if (!conn.authed || !conn.tenant || !conn.caps.has("device_bridge")) {
      this.securityLog("permission_report unauthorized");
      return false;
    }
    if (report.reqId) {
      const pending = this.pending.get(report.reqId);
      if (!pending || pending.conn !== conn || pending.tenantId !== conn.tenant.id) {
        this.securityLog(`permission_report unknown_req reqId=${report.reqId}`);
        return false;
      }
    }
    return true;
  }

  close(conn: Conn) {
    for (const pending of [...this.pending.values()]) {
      if (pending.conn !== conn) continue;
      clearTimeout(pending.timer);
      this.pending.delete(pending.reqId);
      pending.reject(new DeviceBridgeError("disconnected", "设备已断开。"));
      this.auditResult(pending, "error");
    }
  }

  private validReply(conn: Conn, reqId: string, pending: Pending | undefined): pending is Pending {
    if (!conn.authed || !conn.tenant || !conn.caps.has("device_bridge")) {
      this.securityLog(`result unauthorized reqId=${reqId}`);
      return false;
    }
    if (!pending) {
      this.securityLog(`result unknown_req reqId=${reqId}`);
      return false;
    }
    if (pending.conn !== conn || pending.tenantId !== conn.tenant.id) {
      this.securityLog(`result tenant_or_device_mismatch reqId=${reqId}`);
      return false;
    }
    return true;
  }

  private sendPending(pending: Pending) {
    const timeoutMs = Math.max(1, pending.deadlineAt - this.now());
    this.deps.send(pending.conn, {
      type: "device_invoke",
      reqId: pending.reqId,
      op: pending.op,
      params: pending.params,
      timeoutMs,
      idempotencyKey: pending.idempotencyKey,
      approval: pending.approval,
    });
  }

  private retryAfterSendFailure(pending: Pending): boolean {
    const next = this.select(pending.tenantId, pending.attempted);
    if (next) {
      pending.conn = next;
      pending.attempted.add(next);
      try {
        this.sendPending(pending);
        return true;
      } catch {
        return this.retryAfterSendFailure(pending);
      }
    }
    clearTimeout(pending.timer);
    this.pending.delete(pending.reqId);
    pending.reject(new DeviceBridgeError("send_failed", "设备请求发送失败。"));
    this.auditResult(pending, "error");
    return false;
  }

  private auditResult(pending: Pending, status: string, externalId?: string) {
    const tenant = pending.conn.tenant;
    if (!tenant) return;
    try {
      this.audit(
        { id: tenant.id, stateDir: tenant.stateDir },
        {
          op: pending.op,
          actor: pending.actor.slice(0, 128),
          at: new Date(this.now()).toISOString(),
          deviceHash: hashDeviceId(pending.conn.deviceId || `${tenant.id}:${pending.conn.ip}`),
          summary: summarizeDeviceParams(pending.op, pending.params),
          status,
          externalId: externalId?.slice(0, 256),
        },
      );
    } catch (err) {
      log.warn("device audit", err instanceof Error ? err.message : String(err));
    }
  }

  private pruneSettled() {
    const now = this.now();
    for (const [key, row] of this.cache) if (row.expiresAt <= now) this.cache.delete(key);
    for (const [key, row] of this.settled) if (row.expiresAt <= now) this.settled.delete(key);
  }

  private rememberSettled(key: string, error: DeviceBridgeError) {
    this.settled.delete(key);
    this.settled.set(key, { expiresAt: this.now() + DEVICE_SETTLED_TTL_MS, error });
    while (this.settled.size > DEVICE_SETTLED_MAX) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }

  private rememberCache(key: string, result: DeviceResult) {
    this.cache.delete(key);
    this.cache.set(key, { expiresAt: this.now() + DEVICE_IDEMPOTENCY_TTL_MS, result });
    while (this.cache.size > DEVICE_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function externalIdFrom(value: JSONValue | undefined) {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  const id = value.externalId ?? value.id;
  return typeof id === "string" ? id : undefined;
}

export const deviceRegistry = new DeviceRegistry({
  state: gatewayState,
  send: (conn, message) => send(conn.ws, message),
});
