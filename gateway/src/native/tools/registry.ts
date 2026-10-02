import type { AgentMode } from "../../../../shared/protocol.ts";
import type { ToolSpec } from "../types.ts";
import { fsTools } from "./fs.ts";

/** ask / plan 只给只读工具：模型看不到写工具，也就不会尝试调用。 */
export function toolsForMode(mode: AgentMode, extra: ToolSpec[] = []): ToolSpec[] {
  const all = [...fsTools, ...extra];
  if (mode === "agent") return all;
  return all.filter((tool) => tool.category === "read" || tool.category === "network");
}
