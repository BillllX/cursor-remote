// 即时消息（im_*）。只处理 hello caps 含 "im" 的连接；其余连接回 im_error code=no_cap
// （不静默忽略：网页端从不发 im_*，回错误只会让漏声明 cap 的客户端更容易排查）
import type { ServerMessage } from "../../../../shared/protocol.ts";
import { ImError } from "../../im/errors.ts";
import { IM_CAP, imRuntime } from "../../im/runtime.ts";
import type { ImService } from "../../im/service.ts";
import { log } from "../../log.ts";
import { send } from "../send.ts";
import type { MessageOf, WsCtx } from "./types.ts";

type ImType =
  | "im_contacts"
  | "im_list"
  | "im_history"
  | "im_send"
  | "im_recall"
  | "im_read"
  | "im_settings"
  | "im_profile"
  | "im_block"
  | "im_presence";

async function run(
  ctx: WsCtx,
  message: MessageOf<ImType>,
  work: (service: ImService, me: string, origin: unknown) => ServerMessage | null | Promise<ServerMessage | null>,
) {
  const clientId =
    message.type === "im_send" && typeof message.clientId === "string" ? { clientId: message.clientId } : {};
  if (!ctx.conn.caps.has(IM_CAP)) {
    send(ctx.ws, { type: "im_error", ...clientId, code: "no_cap", message: "这个连接没有声明 im 能力" });
    return;
  }
  try {
    const out = await work(imRuntime().service, ctx.tenant.id, ctx.ws);
    if (out) send(ctx.ws, out);
  } catch (err) {
    if (err instanceof ImError) {
      send(ctx.ws, { type: "im_error", ...clientId, code: err.code, message: err.message });
      return;
    }
    log.error("im", message.type, err instanceof Error ? err.message : err);
    send(ctx.ws, { type: "im_error", ...clientId, code: "internal", message: "网关出错了，稍后再试" });
  }
}

export const onImContacts = (ctx: WsCtx, message: MessageOf<"im_contacts">) =>
  run(ctx, message, (service, me) => service.contacts(me));

export const onImList = (ctx: WsCtx, message: MessageOf<"im_list">) =>
  run(ctx, message, (service, me) => service.list(me, message));

export const onImHistory = (ctx: WsCtx, message: MessageOf<"im_history">) =>
  run(ctx, message, (service, me) => service.history(me, message));

export const onImSend = (ctx: WsCtx, message: MessageOf<"im_send">) =>
  run(ctx, message, (service, me, origin) => service.send(me, origin, message));

export const onImRecall = (ctx: WsCtx, message: MessageOf<"im_recall">) =>
  run(ctx, message, (service, me, origin) => service.recall(me, origin, message));

export const onImRead = (ctx: WsCtx, message: MessageOf<"im_read">) =>
  run(ctx, message, (service, me, origin) => service.read(me, origin, message));

export const onImSettings = (ctx: WsCtx, message: MessageOf<"im_settings">) =>
  run(ctx, message, (service, me, origin) => service.settings(me, origin, message));

export const onImProfile = (ctx: WsCtx, message: MessageOf<"im_profile">) =>
  run(ctx, message, (service, me, origin) => service.profile(me, origin, message));

export const onImBlock = (ctx: WsCtx, message: MessageOf<"im_block">) =>
  run(ctx, message, (service, me, origin) => service.block(me, origin, message));

/** 只记在连接上，没有回包 */
export const onImPresence = (ctx: WsCtx, message: MessageOf<"im_presence">) =>
  run(ctx, message, () => {
    ctx.conn.imForeground = message.foreground !== false;
    return null;
  });
