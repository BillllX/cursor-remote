// 助理面板：取状态、执行操作
import { buildState, handleOp, publishState, watchMemory } from "../../assistant/service.ts";
import { send } from "../send.ts";
import { answerDelegationApproval, cancelDelegation } from "../../bindings/delegations.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export async function onAssistantGet({ ws, tenant }: WsCtx, message: MessageOf<"assistant_get">) {
  if (message.memory) watchMemory(tenant.id, true);
  send(ws, { type: "assistant_state", state: await buildState(tenant, { memory: Boolean(message.memory) }) });
}

export async function onAssistantOp({ ws, tenant }: WsCtx, message: MessageOf<"assistant_op">) {
  const args = message.args && typeof message.args === "object" ? message.args : {};
  const result =
    message.op === "approval_answer"
      ? answerDelegationApproval(tenant, args)
      : message.op === "delegation_cancel"
        ? await cancelDelegation(ws, tenant, args)
        : await handleOp(tenant, message.op, args);
  send(ws, { type: "assistant_result", reqId: message.reqId, op: message.op, ...result });
  if (result.ok) void publishState(tenant);
}
