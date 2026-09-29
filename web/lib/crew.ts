export type CrewRole = "explore" | "builder" | "reviewer";

export const CREW_LABEL: Record<CrewRole, string> = {
  explore: "摸仓库",
  builder: "改代码",
  reviewer: "交叉审",
};

export function isCrewRole(value: string | undefined | null): value is CrewRole {
  return value === "explore" || value === "builder" || value === "reviewer";
}

function normalizeCrewRole(value: string | undefined | null): CrewRole | undefined {
  const n = value?.trim().toLowerCase() || "";
  if (n === "explore" || n === "builder" || n === "reviewer") return n;
  if (n === "review" || /^review-\d+$/.test(n) || /^reviewer-\d+$/.test(n)) return "reviewer";
}

export function crewRoleOf(name: string, args?: unknown): CrewRole | undefined {
  const direct = name.trim().toLowerCase();
  if (direct && direct !== "task" && direct !== "agent") {
    const role = normalizeCrewRole(direct);
    if (role) return role;
  }
  if (!args || typeof args !== "object") return;
  const record = args as Record<string, unknown>;
  for (const key of [
    "subagent_type",
    "subagentType",
    "subagent",
    "agent",
    "name",
    "type",
    "role",
  ]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const role = normalizeCrewRole(value);
    if (role) return role;
  }
}

export function crewLabel(name: string, args?: unknown, agent?: string): string {
  const role = normalizeCrewRole(agent) || crewRoleOf(name, args);
  if (role) return CREW_LABEL[role];
  return "";
}
