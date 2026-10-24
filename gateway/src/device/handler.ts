import { deviceRegistry } from "./registry.ts";
import type { MessageOf, WsCtx } from "../ws/handlers/types.ts";

/** 结果只唤醒对应 pending，不在 WS 分发循环里等待后续工作。 */
export function onDeviceResult({ conn }: WsCtx, message: MessageOf<"device_result">) {
  deviceRegistry.handleResult(conn, message);
}

export function onDevicePermissionReport({ conn }: WsCtx, message: MessageOf<"device_permission_report">) {
  deviceRegistry.handlePermissionReport(conn, message);
}
