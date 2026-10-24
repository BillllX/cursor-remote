// 网关地址、上传地址与 hello 客户端标识、发往网关的消息序列化
import type { ClientMessage, HelloClient } from "@shared/protocol";

const ONLINE_ORIGIN = "https://jiebo.aiagentswitcher.com";

const ONLINE_GATEWAY_WS = "wss://jiebo.aiagentswitcher.com/bridge";

export function gatewayUrl() {
  const explicit = process.env.NEXT_PUBLIC_GATEWAY_WS;
  if (explicit) return explicit;
  // 本地 Next（:3000）也走线上网关，不连本机 8787
  if (typeof window === "undefined" || window.location.port === "3000") return ONLINE_GATEWAY_WS;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${protocol}//${window.location.host}${base}/bridge`;
}

export function uploadUrl(chatId: string, name: string) {
  const query = `chatId=${encodeURIComponent(chatId)}&name=${encodeURIComponent(name)}`;
  if (typeof window === "undefined" || window.location.port === "3000") {
    return `${ONLINE_ORIGIN}/upload?${query}`;
  }
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${base}/upload?${query}`;
}

/** 超大回合只走同源代理，令牌留在 Authorization 头，不放进 URL。 */
export function turnUrl(chatId: string, turnId: string) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${base}/api/turn?chatId=${encodeURIComponent(chatId)}&turnId=${encodeURIComponent(turnId)}`;
}

/** hello 携带的客户端标识（P2 协议护栏，网关可据此区分客户端与版本） */
export const HELLO_CLIENT: HelloClient = {
  name: "cursor-remote-web",
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
  caps: ["sync_chat", "stored_digest", "slim_state", "deferred_turn", "im", "im_group", "im_collab"],
  maxMessageBytes: 8 * 1024 * 1024,
};

/** prompt 在真正发出时才盖上本机时间和系统时区：离线攒在发件箱里的，按发出那一刻算 */
export function wire(message: ClientMessage) {
  return JSON.stringify(
    message.type === "prompt"
      ? { ...message, clientTime: { now: Date.now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "" } }
      : message,
  );
}
