// 解析客户端上行消息
import type { ClientMessage } from "../../../shared/protocol.ts";

export function parseClient(raw: string): ClientMessage | null {
  try {
    const data = JSON.parse(raw) as ClientMessage;
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
