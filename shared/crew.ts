import { crewChinesePrompt, usesChineseDialect } from "./dialect.ts";
import { PUBLISH_BUILDER_EN } from "./publishPrompt.ts";

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

export type ReviewBinding = { name: string; modelId: string };

const PANEL_CAP = 4;
const VENDOR_RANK = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "zhipu",
  "moonshot",
  "deepseek",
  "alibaba",
  "cursor",
  "other",
];

function isLiteModel(id: string): boolean {
  return /(^|-)(fast|small|mini|nano)(-|$)/i.test(id);
}

export function rosterKey(rows: ReviewBinding[]): string {
  return rows.map((row) => `${row.name}=${row.modelId}`).join("|");
}

/** 从目录里挑最多 4 个、彼此不同的评审模型。主模型本身不进名单。 */
export function pickReviewPanel(lead: string, catalog: string[]): ReviewBinding[] {
  const leadKey = lead.trim().toLowerCase();
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of catalog) {
    const id = raw.trim();
    const key = id.toLowerCase();
    if (!id || id.includes(":") || key === leadKey || seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  const byVendor = new Map<string, string[]>();
  for (const id of unique) {
    const vendor = vendorHint(id);
    const list = byVendor.get(vendor) || [];
    list.push(id);
    byVendor.set(vendor, list);
  }
  const best = (ids: string[]) => ids.find((id) => !isLiteModel(id)) || ids[0];
  const leadVendor = vendorHint(lead);
  const order = [...VENDOR_RANK.filter((vendor) => vendor !== leadVendor), leadVendor];
  const picked: string[] = [];
  for (const vendor of order) {
    const ids = byVendor.get(vendor);
    if (!ids?.length) continue;
    picked.push(best(ids));
    if (picked.length >= PANEL_CAP) break;
  }
  if (picked.length < 2) {
    for (const id of unique) {
      if (picked.some((item) => item.toLowerCase() === id.toLowerCase())) continue;
      picked.push(id);
      if (picked.length >= 2) break;
    }
  }
  return picked.map((modelId, index) => ({
    name: index === 0 ? "reviewer" : `review-${index + 1}`,
    modelId,
  }));
}

export function reviewPanelPrompt(panel: ReviewBinding[]): string {
  if (!panel.length) return "";
  const lines = panel.map((row) => `- ${row.name} → ${row.modelId}`).join("\n");
  return [
    "评审名单：每个名字绑定一个不同的模型。同一个名字再派一次，用的还是同一个模型。",
    lines,
    "用户要求不同模型一起评审时，网关会直接调用这份名单。你不要再把这些名字各派一遍。",
    "只是改完想要第二双眼睛时，只派 reviewer 一次。",
  ].join("\n");
}

export function wantsMultiModelReview(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (!/评审|审查|审一下|审这个|review/i.test(compact)) return false;
  return /多个模型|不同模型|多模型|各模型|各个模型|几家模型|多家模型|分别评审|共同评审|multiple models|different models/i.test(
    compact,
  );
}

export function isCrewRole(value: string | undefined | null): value is CrewRole {
  return value === "explore" || value === "builder" || value === "reviewer";
}

export function normalizeCrewRole(value: string | undefined | null): CrewRole | undefined {
  const n = value?.trim().toLowerCase() || "";
  if (n === "explore" || n === "builder" || n === "reviewer") return n;
  if (n === "review" || /^review-\d+$/.test(n) || /^reviewer-\d+$/.test(n)) return "reviewer";
}

export function isCrewToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "task" || n === "agent" || isCrewRole(n);
}

const CREW_ARG_KEYS = [
  "subagent_type",
  "subagentType",
  "subagent",
  "agent",
  "name",
  "type",
  "role",
];

export function crewAgentToken(name: string, args?: unknown): string | undefined {
  const direct = name.trim().toLowerCase();
  if (direct && direct !== "task" && direct !== "agent" && normalizeCrewRole(direct)) return direct;
  if (!args || typeof args !== "object") return;
  const record = args as Record<string, unknown>;
  for (const key of CREW_ARG_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const token = value.trim().toLowerCase();
    if (normalizeCrewRole(token)) return token;
  }
}

export function crewRoleOf(name: string, args?: unknown): CrewRole | undefined {
  const token = crewAgentToken(name, args);
  return token ? normalizeCrewRole(token) : undefined;
}

export function resolveCrewModel(
  name: string,
  args: unknown,
  roster?: ReviewBinding[],
): string | undefined {
  const bound = roster?.find((row) => row.name === crewAgentToken(name, args))?.modelId;
  return crewModelOf(args) || bound;
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
  reviewers?: ReviewBinding[],
): Record<string, CrewAgentDef> {
  const exploreModel = pickExplore(lead, catalog);
  const panel = reviewers ?? pickReviewPanel(lead, catalog);
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
  const reviewOf = (name: string, model: { id: string } | "inherit"): CrewAgentDef => {
    const id = model === "inherit" ? lead : model.id;
    const stamp =
      model === "inherit"
        ? "不要再派子代理。"
        : `你绑定的模型是 ${id}。不要再派子代理，也不要自称别的模型。`;
    return {
      description:
        model === "inherit"
          ? "Cross-reviewer. Use once after edits for a second look. Only review files in this workspace."
          : `Cross-reviewer bound to ${id}. Spawning ${name} again still uses ${id}. Only review files in this workspace.`,
      prompt: `${promptOf(
        "reviewer",
        model,
        "You review the plan or diff you are given. Read surrounding code inside this working directory. List concrete issues. Do not rewrite the feature unless you find a critical bug you can fix in a few lines. Do not expand scope or touch files outside this workspace.",
      )} ${stamp}`,
      model,
    };
  };
  const agents: Record<string, CrewAgentDef> = {
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
        `You implement the assigned change in this workspace. Stay inside the working directory. Make focused edits, run necessary commands, and report what you changed. Never write outside this workspace. ${PUBLISH_BUILDER_EN}`,
      ),
      model: "inherit",
    },
  };
  if (panel.length) {
    for (const row of panel) agents[row.name] = reviewOf(row.name, { id: row.modelId });
  } else {
    agents.reviewer = reviewOf("reviewer", pickReviewer(lead, catalog));
  }
  return agents;
}
