// 助理面板：取状态、执行操作
import {
  assistantPublishPending,
  buildState,
  handleOp,
  publishState,
  refreshProjectionCondition,
  waitForAssistantPublishes,
  watchMemory,
} from "../../assistant/service.ts";
import { readAssistantRevision } from "../../assistant/revision.ts";
import { send } from "../send.ts";
import { answerDelegationApproval, cancelDelegation } from "../../bindings/delegations.ts";
import type { AssistantResultMessage } from "../../../../shared/protocol.ts";
import type { MessageOf, WsCtx } from "./types.ts";

type AssistantGetDeps = {
  revision: typeof readAssistantRevision;
  build: typeof buildState;
  pending: typeof assistantPublishPending;
  settle: typeof waitForAssistantPublishes;
  refresh?: (tenant: Parameters<typeof refreshProjectionCondition>[0]) => void;
};

const assistantGetDeps: AssistantGetDeps = {
  revision: readAssistantRevision,
  build: buildState,
  pending: assistantPublishPending,
  settle: waitForAssistantPublishes,
  refresh: (tenant) => {
    if (refreshProjectionCondition(tenant)) void publishState(tenant);
  },
};

export async function onAssistantGet(
  { ws, conn, tenant }: WsCtx,
  message: MessageOf<"assistant_get">,
  helpers: AssistantGetDeps = assistantGetDeps,
) {
  watchMemory(tenant.id, ws, Boolean(message.memory), conn);
  helpers.refresh?.(tenant);
  const knownRevision =
    typeof message.knownRevision === "number" &&
    Number.isSafeInteger(message.knownRevision) &&
    message.knownRevision > 0
      ? message.knownRevision
      : undefined;

  while (true) {
    await helpers.settle(tenant.id);
    // settle 的 Promise 恢复到这里前可能又有同步 publish；有就重新等，避免越过队列发送。
    if (helpers.pending(tenant.id)) continue;
    const revision = helpers.revision(tenant);
    if (knownRevision === revision) {
      send(ws, {
        type: "assistant_not_modified",
        revision,
        reqId: message.reqId,
        generation: message.generation,
      });
      return;
    }

    const state = await helpers.build(tenant, { memory: Boolean(message.memory), revision });
    await helpers.settle(tenant.id);
    if (helpers.pending(tenant.id)) continue;
    // build 期间 publish 会同步 bump；只发送与当前持久 revision 相同的快照。
    if (helpers.revision(tenant) !== revision) continue;
    send(ws, {
      type: "assistant_state",
      state,
      reqId: message.reqId,
      generation: message.generation,
    });
    return;
  }
}

export async function onAssistantOp({ ws, tenant }: WsCtx, message: MessageOf<"assistant_op">) {
  const args = message.args && typeof message.args === "object" ? message.args : {};
  const result =
    message.op === "approval_answer"
      ? answerDelegationApproval(tenant, args)
      : message.op === "delegation_cancel"
        ? await cancelDelegation(ws, tenant, args)
        : await handleOp(tenant, message.op, args);
  send(ws, { type: "assistant_result", reqId: message.reqId, op: message.op, ...result } as AssistantResultMessage);
  if (result.ok) void publishState(tenant);
}
