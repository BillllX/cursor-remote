// 发送提示词
import { parsePolicy } from "../../../../shared/policy.ts";
import { noteTurn } from "../../usage.ts";
import { parseClientClock } from "../../assistant/service.ts";
import { slotOf } from "../../runtime/slots.ts";
import { handlePrompt, promptModel } from "../../chat/runner.ts";
import { titleChat } from "../../chat/title.ts";
import type { MessageOf, WsCtx } from "./types.ts";

export async function onPrompt({ ws, conn, tenant }: WsCtx, message: MessageOf<"prompt">) {
  const slot = slotOf(conn, message.chatId);
  // P9 计量：一条用户消息记一个 turn（排队也算——用户确实发了）；
  // 埋点在分发处而非 handlePrompt，pending 重放不会重复计数
  noteTurn(tenant.id, (message.text || "").length);
  conn.clock = parseClientClock(message.clientTime) ?? conn.clock;
  await handlePrompt(
    ws,
    conn,
    slot,
    message.text,
    message.model,
    message.mode,
    message.files,
    message.images,
    Boolean(message.confirmWrites),
    Boolean(message.autoApprove),
    Boolean(message.fresh),
    parsePolicy(message.policy, conn.policy),
    message.dialect,
    message.history,
    true,
    message.turnId,
  );
  // 排队时 handlePrompt 不更新 slot.model，要按这条消息自己选的模型起标题
  if (message.nameChat) void titleChat(ws, tenant, slot.chatId, message.text, promptModel(message.model, slot, conn));
}
