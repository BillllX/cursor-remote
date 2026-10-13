// IM 进程内单例：把 ImService 接到真实的租户名单、连接表和 APNs
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { sendApns } from "../assistant/apns.ts";
import { assistantBadgeCached } from "../assistant/badge.ts";
import { log } from "../log.ts";
import { gatewayState } from "../runtime/state.ts";
import { allTenants, getTenant, mediaSecret, stateDir } from "../tenants.ts";
import { reply } from "../ws/frame.ts";
import { ImService, type ImLiveConn } from "./service.ts";
import { ImStore } from "./store.ts";

export const IM_CAP = "im";

let instance: { service: ImService; store: ImStore } | null = null;

function* liveConns(): Generator<ImLiveConn> {
  for (const [ws, conn] of gatewayState.conns) {
    if (!conn.authed || !conn.tenant || !conn.caps.has(IM_CAP) || ws.readyState !== WebSocket.OPEN) continue;
    yield {
      key: ws,
      tenantId: conn.tenant.id,
      foreground: conn.imForeground !== false,
      send: (message) => reply(ws, message),
    };
  }
}

export function imRuntime() {
  if (instance) return instance;
  const root = stateDir();
  const store = new ImStore(root, (id) => getTenant(id)?.stateDir ?? resolve(root, "tenants", id));
  const service = new ImService({
    store,
    tenants: () => allTenants().map((tenant) => ({ id: tenant.id, name: tenant.name, imHidden: tenant.imHidden })),
    secret: () => mediaSecret(),
    conns: liveConns,
    push: (tenantId, message) => {
      const tenant = getTenant(tenantId);
      if (!tenant) return;
      void sendApns({ id: tenant.id, stateDir: tenant.stateDir }, message).catch((err) =>
        log.error("im apns", err instanceof Error ? err.message : err),
      );
    },
    assistantBadge: async (tenantId) => {
      const tenant = getTenant(tenantId);
      // 带超时和短缓存（badge.ts）：慢文件系统不拖慢聊天推送，超时先拿上次的数顶着
      return tenant ? await assistantBadgeCached({ id: tenant.id, stateDir: tenant.stateDir }) : 0;
    },
  });
  instance = { service, store };
  return instance;
}
