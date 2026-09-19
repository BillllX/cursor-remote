export const LAST_MODEL_KEY = "cursor-remote-last-model";
export const DEFAULT_MODEL = "composer-2.5";

export type ModelVendor =
  | "cursor"
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "zhipu"
  | "moonshot"
  | "deepseek"
  | "alibaba"
  | "meta"
  | "mistral"
  | "other";

export type ModelGroup = {
  vendor: ModelVendor;
  label: string;
  models: { id: string; name: string }[];
};

const VENDOR_ORDER: ModelVendor[] = [
  "cursor",
  "anthropic",
  "openai",
  "google",
  "xai",
  "zhipu",
  "moonshot",
  "deepseek",
  "alibaba",
  "meta",
  "mistral",
  "other",
];

const VENDOR_LABEL: Record<ModelVendor, string> = {
  cursor: "Cursor",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  zhipu: "智谱",
  moonshot: "Moonshot",
  deepseek: "DeepSeek",
  alibaba: "阿里",
  meta: "Meta",
  mistral: "Mistral",
  other: "其他",
};

const ACRONYMS: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  ai: "AI",
  xai: "xAI",
};

export function vendorOf(id: string): ModelVendor {
  const n = id.trim().toLowerCase();
  if (!n) return "other";
  if (n.includes("grok") || n.startsWith("xai")) return "xai";
  if (
    n === "auto" ||
    n === "auto-smart" ||
    n === "default" ||
    n.startsWith("composer") ||
    n === "cursor-small" ||
    n.startsWith("cursor-fast")
  ) {
    return "cursor";
  }
  if (
    n.includes("claude") ||
    n.includes("sonnet") ||
    n.includes("opus") ||
    n.includes("haiku") ||
    n.includes("fable")
  ) {
    return "anthropic";
  }
  if (
    n.startsWith("gpt") ||
    /^o[1-9]/.test(n) ||
    n.startsWith("chatgpt") ||
    n.includes("codex")
  ) {
    return "openai";
  }
  if (n.includes("gemini") || n.includes("gemma")) return "google";
  if (n.startsWith("glm") || n.includes("chatglm") || n.startsWith("zhipu")) return "zhipu";
  if (n.includes("kimi") || n.includes("moonshot")) return "moonshot";
  if (n.includes("deepseek")) return "deepseek";
  if (n.includes("qwen") || n.startsWith("qwq") || n.includes("dashscope")) return "alibaba";
  if (n.includes("llama") || n.includes("meta-llama")) return "meta";
  if (
    n.includes("mistral") ||
    n.includes("mixtral") ||
    n.includes("codestral") ||
    n.includes("magistral") ||
    n.includes("devstral")
  ) {
    return "mistral";
  }
  return "other";
}

export function prettyModelName(id: string): string {
  const raw = id.trim();
  if (!raw) return "";
  const n = raw.toLowerCase();
  if (n === "auto" || n === "auto-smart") return "Auto";
  if (n === "default") return "Default";
  const out: string[] = [];
  for (const part of raw.replace(/^cursor-/i, "").split("-").filter(Boolean)) {
    if (/^\d/.test(part) && out.length && /^\d/.test(out[out.length - 1])) {
      out[out.length - 1] = `${out[out.length - 1]}.${part}`;
      continue;
    }
    const key = part.toLowerCase();
    if (ACRONYMS[key]) {
      out.push(ACRONYMS[key]);
      continue;
    }
    if (/^\d/.test(part)) {
      out.push(part);
      continue;
    }
    out.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(" ");
}

export function modelLabel(id: string, name?: string): string {
  const given = name?.trim();
  if (given && given.toLowerCase() !== id.toLowerCase()) return given;
  return prettyModelName(id) || id;
}

export function groupModels(ids: string[]): ModelGroup[] {
  const seen = new Set<string>();
  const buckets = new Map<ModelVendor, { id: string; name: string }[]>();
  for (const id of ids) {
    const key = id.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const vendor = vendorOf(key);
    const list = buckets.get(vendor) || [];
    list.push({ id: key, name: prettyModelName(key) });
    buckets.set(vendor, list);
  }
  return VENDOR_ORDER.flatMap((vendor) => {
    const models = buckets.get(vendor);
    if (!models?.length) return [];
    return [{ vendor, label: VENDOR_LABEL[vendor], models }];
  });
}

export function withCurrentModel(ids: string[], current: string): string[] {
  const key = current.trim();
  if (!key || ids.includes(key)) return ids;
  return [key, ...ids];
}

export function resolveModel(preferred: string | undefined, ids: string[], fallback: string): string {
  const list = ids.map((id) => id.trim()).filter(Boolean);
  const want = preferred?.trim();
  const catalogReady = list.length > 1 || (list.length === 1 && list[0] !== DEFAULT_MODEL);
  if (want && (!catalogReady || list.includes(want))) return want;
  const next = fallback.trim();
  if (next && (!catalogReady || list.includes(next) || !list.length)) return next;
  return list[0] || next || want || DEFAULT_MODEL;
}

export function sessionModel(chat?: {
  model?: string;
  turns?: Array<{ model?: string }>;
} | null): string | undefined {
  if (!chat) return;
  if (chat.model?.trim()) return chat.model.trim();
  const turns = chat.turns || [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const id = turns[i]?.model?.trim();
    if (id) return id;
  }
}

export function readLastModel(): string {
  try {
    return localStorage.getItem(LAST_MODEL_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function writeLastModel(id: string) {
  const value = id.trim();
  if (!value) return;
  try {
    localStorage.setItem(LAST_MODEL_KEY, value);
  } catch {
    // private mode
  }
}
