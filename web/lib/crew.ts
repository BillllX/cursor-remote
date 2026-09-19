export type CrewRole = "explore" | "builder" | "reviewer";

export const CREW_LABEL: Record<CrewRole, string> = {
  explore: "摸仓库",
  builder: "改代码",
  reviewer: "交叉审",
};

export function isCrewRole(value: string | undefined | null): value is CrewRole {
  return value === "explore" || value === "builder" || value === "reviewer";
}

export function crewRoleOf(name: string, args?: unknown): CrewRole | undefined {
  const n = name.trim().toLowerCase();
  if (isCrewRole(n)) return n;
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
    if (typeof value === "string" && isCrewRole(value.trim().toLowerCase())) {
      return value.trim().toLowerCase() as CrewRole;
    }
  }
}

export function crewLabel(name: string, args?: unknown, agent?: string): string {
  const role = (isCrewRole(agent) ? agent : undefined) || crewRoleOf(name, args);
  if (role) return CREW_LABEL[role];
  return "";
}
