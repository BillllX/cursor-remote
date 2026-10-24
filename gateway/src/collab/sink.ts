import type { Tenant } from "../tenants.ts";

export type CollabSideEvent = {
  taskId: string;
  type: "approval" | "approval_expired" | "memory_proposal";
  payload: Record<string, unknown>;
};

let sink: ((tenant: Tenant, event: CollabSideEvent) => void | Promise<void>) | null = null;

export function bindCollabSink(next: typeof sink) {
  sink = next;
}

export function emitCollabSideEvent(tenant: Tenant, event: CollabSideEvent) {
  return sink?.(tenant, event);
}
