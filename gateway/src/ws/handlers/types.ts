// 上行消息处理函数的类型
import type { WebSocket } from "ws";
import type { ClientMessage } from "../../../../shared/protocol.ts";
import type { GatewayState } from "../../runtime/state.ts";
import type { Conn } from "../../runtime/types.ts";
import type { Tenant } from "../../tenants.ts";

export type ClientType = ClientMessage["type"];
export type MessageOf<T extends ClientType> = Extract<ClientMessage, { type: T }>;

/** 连接级上下文：鉴权之前只有 ws、conn 与运行时状态 */
export type WsConnCtx = { ws: WebSocket; conn: Conn; state: GatewayState };
/** 鉴权之后的上下文；tenant 就是鉴权门槛之后取的 conn.tenant（每条消息取一次，处理期间不再重读） */
export type WsCtx = WsConnCtx & { tenant: Tenant };

export type Handler<T extends ClientType> = (ctx: WsCtx, message: MessageOf<T>) => void | Promise<void>;

/** 在分发入口里单独处理、不进注册表的 type */
export type PreAuthType = "ping" | "hello";
export type HandlerTable = { [K in Exclude<ClientType, PreAuthType>]?: Handler<K> };
