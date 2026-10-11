import { CREW_LABEL, crewRoleOf, normalizeCrewRole } from "@shared/crew";

// 角色判定与网关共用 shared/crew.ts；这里只放网页独有的 crewLabel
export { CREW_LABEL, crewRoleOf, isCrewRole } from "@shared/crew";
export type { CrewRole } from "@shared/crew";

export function crewLabel(name: string, args?: unknown, agent?: string): string {
  const role = normalizeCrewRole(agent) || crewRoleOf(name, args);
  if (role) return CREW_LABEL[role];
  return "";
}
