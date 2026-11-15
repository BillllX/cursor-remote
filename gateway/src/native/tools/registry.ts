import type { AgentMode } from "../../../../shared/protocol.ts";
import type { ToolSpec } from "../types.ts";
import { fsTools } from "./fs.ts";

/** Agent 始终获得完整工具集；写确认由独立的 policy / approval 机制处理。 */
export function toolsForMode(mode: AgentMode, extra: ToolSpec[] = []): ToolSpec[] {
  void mode;
  return [...fsTools, ...extra];
}
