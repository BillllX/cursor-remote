export const POLICY_IDS = ["baseline", "plane"] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

export type ToolCategory = "write" | "shell" | "other";

export function parsePolicy(value: unknown, fallback: PolicyId = "baseline"): PolicyId {
  return value === "plane" || value === "baseline" ? value : fallback;
}

export function defaultPolicy(): PolicyId {
  return parsePolicy(typeof process !== "undefined" ? process.env.CURSOR_REMOTE_POLICY : undefined);
}

export function isPlane(policy: PolicyId | string | undefined): boolean {
  return policy === "plane";
}

export function askDisallowedTools(): string[] {
  return ["edit", "delete", "shell", "mcp", "task", "applyAgentDiff", "generateImage"];
}

export function planDisallowedTools(): string[] {
  return ["edit", "delete", "applyAgentDiff"];
}

export function isPolicyProtectedPath(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return /(^|\/)\.cursor\/(hooks\.json|sandbox\.json|permissions\.json)$/i.test(n);
}

export function toolCategory(name: string, args?: unknown): ToolCategory {
  const n = name.toLowerCase();
  if (/(write|strreplace|apply.?patch|editnotebook|delete|unlink|createfile|applyagentdiff)/.test(n)) {
    return "write";
  }
  if (/(^|[^a-z])edit([^a-z]|$)/.test(n) && !/read/.test(n)) return "write";
  if (/(shell|bash|terminal|command)/.test(n)) return "shell";
  return "other";
}

export function toolFingerprint(name: string, args?: unknown): string {
  const cat = toolCategory(name, args);
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const path =
    (["path", "file", "target", "file_path"] as const)
      .map((key) => record[key])
      .find((value): value is string => typeof value === "string" && Boolean(value)) || "";
  const cmd = typeof record.command === "string" ? record.command.slice(0, 120) : "";
  return `${cat}:${name}:${path}:${cmd}`;
}
