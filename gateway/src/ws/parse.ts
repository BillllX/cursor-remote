// 解析客户端上行消息
import { normalizeAgentMode, type ClientMessage } from "../../../shared/protocol.ts";

export function parseClient(raw: string): ClientMessage | null {
  try {
    const data = JSON.parse(raw) as ClientMessage;
    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      return null;
    }
    if (data.type === "prompt" || data.type === "loop_start") {
      data.mode = normalizeAgentMode(data.mode);
    }
    return data;
  } catch {
    return null;
  }
}
