// Loop：开始、停止
import { startLoop, stopLoop } from "../../loops.ts";
import { send } from "../send.ts";
import { publishLoop } from "../../bindings/loops.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export function onLoopStart({ ws, tenant }: WsCtx, message: MessageOf<"loop_start">) {
  const result = startLoop({
    tenantId: tenant.id,
    chatId: message.chatId,
    goal: message.goal,
    intervalSec: message.intervalSec,
    maxTicks: message.maxTicks,
    model: message.model,
    mode: message.mode,
  });
  if ("error" in result) {
    send(ws, { type: "error", chatId: message.chatId, message: result.error });
    return;
  }
  publishLoop(tenant.id, { type: "loop_state", ...result.state });
}

export function onLoopStop({ tenant }: WsCtx, message: MessageOf<"loop_stop">) {
  const state = stopLoop(tenant.id, message.chatId);
  publishLoop(tenant.id, {
    type: "loop_state",
    chatId: message.chatId,
    status: "stopped",
    goal: state?.goal ?? "",
    intervalSec: state?.intervalSec ?? 0,
    tick: state?.tick ?? 0,
    maxTicks: state?.maxTicks,
    lastSummary: state?.lastSummary ?? "没有在跑的 Loop。",
  });
}
