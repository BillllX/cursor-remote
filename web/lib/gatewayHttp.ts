import { gatewayUrl } from "./chat/connection";

/** Next 服务端到网关的 HTTP 基址。WS 地址可能带 /bridge，HTTP 路由必须从 origin 拼接。 */
export function gatewayHttp() {
  if (process.env.GATEWAY_HTTP_URL) return process.env.GATEWAY_HTTP_URL.replace(/\/$/, "");
  // 未配服务端地址时复用网页 WS 的开发态选择，避免页面连线上而 HTTP 却误打本机。
  const ws = process.env.GATEWAY_WS_URL || gatewayUrl();
  const target = new URL(ws);
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  return target.origin;
}
