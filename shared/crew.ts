import { crewChinesePrompt, usesChineseDialect } from "./dialect.ts";

export const CREW_ROLES = ["explore", "builder", "reviewer"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export type CrewAgentDef = {
  description: string;
  prompt: string;
  model?: { id: string } | "inherit";
};

export const CREW_LABEL: Record<CrewRole, string> = {
  explore: "摸仓库",
  builder: "改代码",
  reviewer: "交叉审",
};

export function vendorHint(id: string): string {
  const n = id.trim().toLowerCase();
  if (!n) return "other";
  if (n.includes("grok") || n.startsWith("xai")) return "xai";
  if (
    n === "auto" ||
    n === "auto-smart" ||
    n === "default" ||
    n.startsWith("composer") ||
    n.includes("cursor")
  ) {
    return "cursor";
  }
  if (
    n.includes("claude") ||
    n.includes("sonnet") ||
    n.includes("opus") ||
    n.includes("haiku")
  ) {
    return "anthropic";
  }
  if (n.startsWith("gpt") || /^o[1-9]/.test(n) || n.includes("codex")) return "openai";
  if (n.includes("gemini")) return "google";
  if (n.startsWith("glm") || n.includes("zhipu")) return "zhipu";
  if (n.includes("kimi") || n.includes("moonshot")) return "moonshot";
  if (n.includes("deepseek")) return "deepseek";
  if (n.includes("qwen")) return "alibaba";
  return "other";
}

function catalogHas(catalog: string[], id: string): boolean {
  const want = id.trim().toLowerCase();
  return catalog.some((item) => item.trim().toLowerCase() === want);
}

function pickExplore(lead: string, catalog: string[]): { id: string } | "inherit" {
  const fast = catalog.find(
    (id) => id.trim() && id.trim() !== lead && /fast|small/i.test(id),
  );
  if (fast && catalogHas(catalog, fast)) return { id: fast };
  return "inherit";
}

function pickReviewer(lead: string, catalog: string[]): { id: string } | "inherit" {
  const leadVendor = vendorHint(lead);
  const pool = catalog.filter(
    (id) => id.trim() && id.trim() !== lead && !/fast|small/i.test(id),
  );
  const otherVendor = pool.find((id) => vendorHint(id) !== leadVendor);
  if (otherVendor) return { id: otherVendor };
  if (pool[0]) return { id: pool[0] };
  return "inherit";
}

export function isCrewRole(value: string | undefined | null): value is CrewRole {
  return value === "explore" || value === "builder" || value === "reviewer";
}

export function isCrewToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "task" || n === "agent" || isCrewRole(n);
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

export function crewModelOf(args?: unknown): string | undefined {
  if (!args || typeof args !== "object") return;
  const record = args as Record<string, unknown>;
  for (const key of ["model", "modelId", "model_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && "id" in value) {
      const id = (value as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  }
}

export function workspaceConfinePrompt(cwd: string): string {
  return [
    `工作区边界：当前工作目录是 ${cwd}。`,
    "所有方案、实现、文件创建/修改/删除、补丁、mkdir、重定向、shell 的 working_directory 都必须落在这个目录之内。",
    "只使用相对该目录的路径。Canvas 写到本工作区下的 .cursor-remote/canvases/。",
    "禁止写到父目录、兄弟项目、家目录、/tmp、/var 或其他项目。",
    "如果目标在工作区外，不要动手，改用工作区内的做法并说明原因。",
  ].join(" ");
}

export function buildCrewAgents(
  lead: string,
  catalog: string[],
  cwd?: string,
  overlayFor?: (modelId: string) => string,
): Record<string, CrewAgentDef> {
  const exploreModel = pickExplore(lead, catalog);
  const reviewerModel = pickReviewer(lead, catalog);
  const bound = cwd ? `${workspaceConfinePrompt(cwd)} ` : "";
  const extra = (model: { id: string } | "inherit") => {
    const id = model === "inherit" ? lead : model.id;
    const text = overlayFor?.(id)?.trim();
    return text ? `${text} ` : "";
  };
  const promptOf = (
    role: CrewRole,
    model: { id: string } | "inherit",
    english: string,
  ) => {
    const id = model === "inherit" ? lead : model.id;
    if (usesChineseDialect(id)) {
      return crewChinesePrompt(role, bound, extra(model).trim());
    }
    return `${bound}${extra(model)}${english}`;
  };
  return {
    explore: {
      description:
        "Read-only explorer. Use to search the current workspace, map files, and gather context in parallel without editing. Stay inside the working directory.",
      prompt: promptOf(
        "explore",
        exploreModel,
        "You are a read-only codebase explorer. Search and read files inside the working directory. Do not edit, write, delete, or run mutating shell commands. Do not look for or propose changes outside this workspace. Return a concise map of relevant files and findings.",
      ),
      model: exploreModel,
    },
    builder: {
      description:
        "Implementer. Use to make the actual code changes and run commands after the plan is clear. All edits must stay inside the working directory.",
      prompt: promptOf(
        "builder",
        "inherit",
        "You implement the assigned change in this workspace. Stay inside the working directory. Make focused edits, run necessary commands, and report what you changed. Never write outside this workspace.",
      ),
      model: "inherit",
    },
    reviewer: {
      description:
        "Cross-reviewer. Use after edits to inspect the diff for bugs, regressions, and missed cases. Prefer a second opinion, not a rewrite. Only review files in this workspace.",
      prompt: promptOf(
        "reviewer",
        reviewerModel,
        "You review the current workspace changes. Read the diff and surrounding code inside this working directory. List concrete issues. Do not rewrite the feature unless you find a critical bug you can fix in a few lines. Do not expand scope or touch files outside this workspace.",
      ),
      model: reviewerModel,
    },
  };
}
