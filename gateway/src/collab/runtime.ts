import { WebSocket } from "ws";
import type { CollabRunState } from "../../../shared/protocol.ts";
import { gatewayState } from "../runtime/state.ts";
import { allTenants, type Tenant } from "../tenants.ts";
import { reply } from "../ws/frame.ts";
import { hasGroupCaps, imRuntime } from "../im/runtime.ts";
import { bindCollabSink } from "./sink.ts";
import { CollabEngine } from "./engine.ts";

const engines = new Map<string, CollabEngine>();
let timer: ReturnType<typeof setInterval> | null = null;
let lastCleanup = 0;

function publishState(tenant: Tenant, convId: string, runs: CollabRunState[], snapshotSeq: number) {
  for (const conn of gatewayState.conns.values()) {
    if (
      !conn.authed ||
      conn.tenant?.id !== tenant.id ||
      conn.ws.readyState !== WebSocket.OPEN ||
      !hasGroupCaps(conn.caps)
    )
      continue;
    reply(conn.ws, { type: "collab_state", convId, snapshotSeq, runs, removedRunIds: [] });
  }
}

export function collabEngine(tenant: Tenant) {
  let engine = engines.get(tenant.id);
  if (!engine) {
    const im = imRuntime();
    engine = new CollabEngine({
      tenant,
      imStore: im.store,
      imService: im.service,
      publishState: (convId, runs, snapshotSeq) => publishState(tenant, convId, runs, snapshotSeq),
    });
    engines.set(tenant.id, engine);
  }
  return engine;
}

export function startCollabRuntime() {
  bindCollabSink((tenant, event) => collabEngine(tenant).sideEvent(event.taskId, event.type, event.payload));
  for (const tenant of allTenants()) {
    const engine = collabEngine(tenant);
    void engine
      .recover()
      .then(() => engine.tick())
      .catch(() => undefined);
  }
  timer ??= setInterval(() => {
    const now = Date.now();
    for (const tenant of allTenants()) {
      const engine = collabEngine(tenant);
      void engine.tick().catch(() => undefined);
      if (now - lastCleanup >= 24 * 60 * 60_000) void engine.store.cleanup(now).catch(() => undefined);
    }
    if (now - lastCleanup >= 24 * 60 * 60_000) lastCleanup = now;
  }, 1000);
  timer.unref?.();
}

export function stopCollabRuntime() {
  if (timer) clearInterval(timer);
  timer = null;
}
