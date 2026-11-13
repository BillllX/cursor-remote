import { resolve } from "node:path";
import { readJson, writeJson } from "../assistant/store.ts";
import { stateDir } from "../tenants.ts";

export type ModelHealthStatus = "blocked" | "cooldown";

export type ModelHealthEntry = {
  status: ModelHealthStatus;
  reason: string;
  until: number;
  updatedAt: number;
  failCount: number;
};

type ModelHealthFile = {
  version: 1;
  models: Record<string, ModelHealthEntry>;
};

/** 管理策略禁用、模型不存在等长期不可用状态：默认冷却 24 小时 */
export const MODEL_BLOCKED_TTL_MS = 24 * 60 * 60_000;

/** 429 速率限制、瞬时配额耗尽或上游过载：默认冷却 10 分钟 */
export const MODEL_COOLDOWN_TTL_MS = 10 * 60_000;

let memoryEntries: Map<string, ModelHealthEntry> | null = null;
let loadedFromPath: string | null = null;

function healthFilePath(): string {
  return resolve(stateDir(), "model-health.json");
}

function normalizeModelKey(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function ensureLoaded(now = Date.now()): Map<string, ModelHealthEntry> {
  const path = healthFilePath();
  if (memoryEntries && loadedFromPath === path) {
    return memoryEntries;
  }
  loadedFromPath = path;
  const raw = readJson<Partial<ModelHealthFile>>(path, { version: 1, models: {} });
  const map = new Map<string, ModelHealthEntry>();
  if (raw?.models && typeof raw.models === "object") {
    for (const [k, v] of Object.entries(raw.models)) {
      if (
        v &&
        (v.status === "blocked" || v.status === "cooldown") &&
        typeof v.until === "number" &&
        Number.isFinite(v.until) &&
        v.until > now
      ) {
        map.set(normalizeModelKey(k), {
          status: v.status,
          reason: typeof v.reason === "string" ? v.reason : "",
          until: v.until,
          updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : now,
          failCount: typeof v.failCount === "number" ? v.failCount : 1,
        });
      }
    }
  }
  memoryEntries = map;
  return map;
}

function persistHealth(now = Date.now()): void {
  const map = ensureLoaded(now);
  const models: Record<string, ModelHealthEntry> = {};
  for (const [k, v] of map.entries()) {
    if (v.until > now) {
      models[k] = v;
    } else {
      map.delete(k);
    }
  }
  try {
    writeJson(healthFilePath(), { version: 1, models } satisfies ModelHealthFile);
  } catch {
    // 状态目录不可写时仅保留内存态，不影响主流程
  }
}

/**
 * 识别模型调用失败的原因是否属于模型自身不可用（管理员策略封禁、模型下线、配额/速率限制）。
 * 排除用户主动取消、工作区配置错误或普通超时，防止误杀正常模型。
 */
export function classifyModelFailure(errOrText: unknown): {
  status: ModelHealthStatus;
  ttlMs: number;
  reason: string;
} | null {
  const raw =
    typeof errOrText === "string"
      ? errOrText
      : errOrText instanceof Error
        ? errOrText.message
        : errOrText && typeof errOrText === "object" && "message" in errOrText
          ? String((errOrText as { message?: unknown }).message)
          : String(errOrText ?? "");
  const text = raw.trim();
  if (!text) return null;

  // 忽略用户取消、会话中断或单纯的业务层超时
  if (/已取消|cancelled|aborted|评审超时|超过.*分钟|执行超时|思考超时/i.test(text)) {
    return null;
  }

  // 1. 团队管理员禁用 / 模型不存在 / 无权访问该模型 -> blocked (24h)
  if (
    /model blocked|blocked by your team admin|disabled by.*admin|not allowed.*admin|model_not_found|model .* (?:does not exist|not found|is not available|is unavailable)|invalid model|unsupported model|unknown model|no access to model/i.test(
      text,
    )
  ) {
    return {
      status: "blocked",
      ttlMs: MODEL_BLOCKED_TTL_MS,
      reason: text.slice(0, 200),
    };
  }

  // 2. 速率限制 / 配额耗尽 / 上游过载 -> cooldown (10m)
  if (
    /\b429\b|resource_exhausted|rate[_ -]?limit|quota exceeded|insufficient_quota|too many requests|overloaded|model_overloaded|capacity/i.test(
      text,
    )
  ) {
    return {
      status: "cooldown",
      ttlMs: MODEL_COOLDOWN_TTL_MS,
      reason: text.slice(0, 200),
    };
  }

  return null;
}

/** 记录一次模型调用失败；若命中模型级不可用规则则写入健康表并返回登记项 */
export function recordModelFailure(modelId: string, errOrText: unknown, now = Date.now()): ModelHealthEntry | null {
  const key = normalizeModelKey(modelId);
  if (!key) return null;
  const classified = classifyModelFailure(errOrText);
  if (!classified) return null;

  const map = ensureLoaded(now);
  const prev = map.get(key);
  const entry: ModelHealthEntry = {
    status: classified.status,
    reason: classified.reason,
    until: now + classified.ttlMs,
    updatedAt: now,
    failCount: (prev?.failCount ?? 0) + 1,
  };
  map.set(key, entry);
  persistHealth(now);
  return entry;
}

/** 记录模型调用成功，若此前处于熔断/冷却状态则立即解除 */
export function recordModelSuccess(modelId: string, now = Date.now()): void {
  const key = normalizeModelKey(modelId);
  if (!key) return;
  const map = ensureLoaded(now);
  if (map.delete(key)) {
    persistHealth(now);
  }
}

/** 判断指定模型当前是否健康可用（未处于未过期的 blocked / cooldown 状态） */
export function isModelHealthy(modelId: string, now = Date.now()): boolean {
  const key = normalizeModelKey(modelId);
  if (!key) return false;
  const map = ensureLoaded(now);
  const entry = map.get(key);
  if (!entry) return true;
  if (entry.until <= now) {
    map.delete(key);
    return true;
  }
  return false;
}

/** 查询指定模型当前的熔断/冷却详情（若健康则返回 null） */
export function getModelHealthEntry(modelId: string, now = Date.now()): ModelHealthEntry | null {
  const key = normalizeModelKey(modelId);
  if (!key) return null;
  const map = ensureLoaded(now);
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.until <= now) {
    map.delete(key);
    return null;
  }
  return entry;
}

/** 返回当前所有处于熔断/冷却期的模型快照 */
export function listUnhealthyModels(now = Date.now()): Record<string, ModelHealthEntry> {
  const map = ensureLoaded(now);
  const out: Record<string, ModelHealthEntry> = {};
  for (const [k, v] of map.entries()) {
    if (v.until > now) {
      out[k] = { ...v };
    } else {
      map.delete(k);
    }
  }
  return out;
}

/** 清空模型健康熔断记录（供单测或管理员手动重置） */
export function clearModelHealth(modelId?: string): void {
  const map = ensureLoaded();
  if (modelId) {
    map.delete(normalizeModelKey(modelId));
  } else {
    map.clear();
  }
  persistHealth();
}
