import type { AgentOptions, RunResult, SDKCustomTool } from "@cursor/sdk";
import { rankModelsByFreshness } from "../../../shared/crew.ts";
import { isModelHealthy, recordModelFailure, recordModelSuccess } from "../chat/modelHealth.ts";
import { gatewayEnv } from "../config.ts";
import { postInbox } from "./inbox.ts";
import { readSettings } from "./memory.ts";
import { endRunRecord, runningCount, startRunRecord, type RunOrigin } from "./runs.ts";
import { clip, type TenantRef } from "./store.ts";

/** 后台任务默认首选模型；支持租户设置或环境变量 CURSOR_REMOTE_BACKGROUND_MODEL 覆盖，不可用时自动按健康表回退到目录内可用模型 */
export const BACKGROUND_MODEL = "grok-4.7";

/** 后台任务内置优先候选池（当首选模型不在目录或被熔断时，优先从这些稳定高性价比模型中挑选，再兜底全目录最新模型） */
export const BACKGROUND_FALLBACK_PREFERENCE = [
  "grok-4.7",
  "gpt-5.6-sol",
  "glm-5.2",
  "claude-sonnet-4-6",
  "composer-2.5",
] as const;

/** 后台运行可用的内置工具：只读，加上挂 customTools 用的 mcp。没有 edit、delete、shell、task */
export const BACKGROUND_TOOLS = ["read", "grep", "glob", "ls", "mcp"] as const;

export const BACKGROUND_MAX_MS = 30 * 60_000;
export const BACKGROUND_MAX_PER_TENANT = 2;

export type BackgroundDeps = {
  apiKey: () => string;
  listModels: (apiKey: string) => Promise<string[]>;
  prompt: (message: string, options: AgentOptions) => Promise<RunResult>;
  sandbox: (tenantId: string) => boolean;
};

let deps: BackgroundDeps | null = null;

export function bindBackground(next: BackgroundDeps) {
  deps = next;
}

export type BackgroundRequest = {
  origin: RunOrigin;
  label: string;
  cwd: string;
  prompt: string;
  customTools: Record<string, SDKCustomTool>;
  chatId?: string;
  /** 可选：单次调用指定的首选模型 ID */
  preferredModel?: string;
  /** 失败时是否进收件箱；整理者这类安静任务可以关掉 */
  inboxOnFailure?: boolean;
  timeoutMs?: number;
};

export type BackgroundResult =
  | { ok: true; runId: string; text: string }
  | { ok: false; runId?: string; error: string; busy?: boolean };

const BACKGROUND_PREAMBLE = [
  "你在后台运行，没有人盯着这次运行。",
  "你不能直接改代码文件、不能跑命令、不能派子代理；只能读、搜索，以及调用助理工具。",
  "需要改代码或做未授权的有副作用操作时，不要尝试执行，用 inbox_post 写一张待批卡片说明要做什么、为什么（若任务明确要求向指定知识库归档增量数据，可调用 kb_ingest_submit）。",
  "用中文，结论先行，简短。",
].join("\n");

/**
 * 解析当前后台任务的首选模型 ID：
 * 优先级：显式传入 `preferredModel` > 租户 `settings.json` 的 `backgroundModel` > 环境变量 `CURSOR_REMOTE_BACKGROUND_MODEL` > 默认 `BACKGROUND_MODEL`。
 */
export function resolvePreferredBackgroundModel(ref?: TenantRef | null, explicitModel?: string): string {
  const explicit = explicitModel?.trim();
  if (explicit) return explicit;
  if (ref) {
    const tenantModel = readSettings(ref).backgroundModel?.trim();
    if (tenantModel) return tenantModel;
  }
  const envModel = gatewayEnv.backgroundModel();
  if (envModel) return envModel;
  return BACKGROUND_MODEL;
}

/**
 * 根据模型目录与健康表生成有序的后台候选模型链：
 * 1. 首选模型（若在目录内且健康）；
 * 2. 预设优先候选池 `BACKGROUND_FALLBACK_PREFERENCE`（在目录内且健康）；
 * 3. 目录内其余健康的最新非轻量模型；
 * 4. 若目录内所有模型均处于熔断冷却期，保留首选模型（或目录首个模型）做最后一次探测重试。
 */
export function resolveBackgroundModelChain(
  catalog: string[],
  options?: {
    ref?: TenantRef | null;
    preferredModel?: string;
    exclude?: Iterable<string>;
  },
): string[] {
  const excluded = new Set<string>();
  if (options?.exclude) {
    for (const item of options.exclude) excluded.add(item.trim().toLowerCase());
  }
  const validCatalog = catalog.map((id) => id.trim()).filter((id) => Boolean(id) && !id.includes(":"));
  if (!validCatalog.length) return [];

  const catalogByLower = new Map<string, string>();
  for (const id of validCatalog) {
    const k = id.toLowerCase();
    if (!catalogByLower.has(k)) catalogByLower.set(k, id);
  }

  const preferred = resolvePreferredBackgroundModel(options?.ref, options?.preferredModel);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const tryPush = (rawId: string, requireHealthy: boolean) => {
    const canonical = catalogByLower.get(rawId.trim().toLowerCase());
    if (!canonical) return;
    const key = canonical.toLowerCase();
    if (seen.has(key) || excluded.has(key)) return;
    if (requireHealthy && !isModelHealthy(canonical)) return;
    seen.add(key);
    ordered.push(canonical);
  };

  // 1. 首选模型
  tryPush(preferred, true);
  // 2. 内置高性价比优先池
  for (const cand of BACKGROUND_FALLBACK_PREFERENCE) {
    tryPush(cand, true);
  }
  // 3. 目录内按代数新鲜度排序的其余健康模型
  for (const cand of rankModelsByFreshness(validCatalog)) {
    tryPush(cand, true);
  }
  // 4. 若全部处于冷却期，兜底放行未排除的首选模型或最新模型以防彻底死锁
  if (!ordered.length) {
    tryPush(preferred, false);
    for (const cand of rankModelsByFreshness(validCatalog)) {
      tryPush(cand, false);
      if (ordered.length) break;
    }
  }
  return ordered;
}

export async function modelAvailable(
  ref?: TenantRef | null,
  preferredModel?: string,
): Promise<{ ok: boolean; model: string; fallbackFrom?: string; reason?: string }> {
  const preferred = resolvePreferredBackgroundModel(ref, preferredModel);
  if (!deps) return { ok: false, model: preferred, reason: "后台通道没有初始化" };
  const apiKey = deps.apiKey();
  if (!apiKey) return { ok: false, model: preferred, reason: "服务器没有配置 CURSOR_API_KEY" };
  const catalog = await deps.listModels(apiKey);
  const chain = resolveBackgroundModelChain(catalog, { ref, preferredModel: preferred });
  const chosen = chain[0];
  if (!chosen) {
    return {
      ok: false,
      model: preferred,
      reason: `后台模型 ${preferred} 不在当前模型目录里，且无可用兜底模型`,
    };
  }
  if (chosen.toLowerCase() !== preferred.toLowerCase()) {
    return {
      ok: true,
      model: chosen,
      fallbackFrom: preferred,
      reason: `首选 ${preferred} 不可用，已自动兜底切换为 ${chosen}`,
    };
  }
  return { ok: true, model: chosen };
}

/**
 * 通用带健康表记录与自动替补重试的 Agent.prompt 执行器：
 * 供后台助理任务、知识库归档（ingest/runner）、知识库问答（ingest/qaRunner）及工作区定时巡检（workspaceScheduleExecutors）统一复用。
 */
export async function promptWithModelFallback(input: {
  catalog: string[];
  ref?: TenantRef | null;
  preferredModel?: string;
  maxAttempts?: number;
  runWithModel: (modelId: string) => Promise<RunResult>;
}): Promise<{ modelId: string; result: RunResult }> {
  const chain = resolveBackgroundModelChain(input.catalog, {
    ref: input.ref,
    preferredModel: input.preferredModel,
  });
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 2, chain.length || 1));
  const candidates = chain.length ? chain.slice(0, maxAttempts) : [resolvePreferredBackgroundModel(input.ref, input.preferredModel)];

  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const modelId = candidates[i]!;
    const hasNext = i + 1 < candidates.length;
    try {
      const result = await input.runWithModel(modelId);
      if (result.status === "finished") {
        recordModelSuccess(modelId);
        return { modelId, result };
      }
      const errMsg = result.error?.message || `后台运行结束状态 ${result.status}`;
      const healthEntry = recordModelFailure(modelId, errMsg);
      if (hasNext && healthEntry) {
        continue;
      }
      return { modelId, result };
    } catch (err) {
      lastErr = err;
      const healthEntry = recordModelFailure(modelId, err);
      if (hasNext && healthEntry) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "模型调用失败"));
}

/**
 * 后台运行：策略只在这里生成，调用方传不进 mode、confirmWrites、autoApprove。
 * 工具白名单每次都带；当首选模型不在目录或调用时报 Model Blocked / 429 时，自动按健康表切换可用替补模型兜底。
 */
export async function runBackground(ref: TenantRef, req: BackgroundRequest): Promise<BackgroundResult> {
  if (!deps) return { ok: false, error: "后台通道没有初始化" };
  if (runningCount(ref) >= BACKGROUND_MAX_PER_TENANT) {
    return { ok: false, busy: true, error: "同时在跑的后台任务已满" };
  }
  const apiKey = deps.apiKey();
  if (!apiKey) {
    const error = "服务器没有配置 CURSOR_API_KEY";
    if (req.inboxOnFailure !== false) {
      postInbox(ref, {
        kind: "run",
        title: `后台任务没有运行：${req.label}`,
        body: error,
        key: `model-missing:${req.origin}:${req.label}:${new Date().toISOString().slice(0, 10)}`,
        chatId: req.chatId,
      });
    }
    return { ok: false, error };
  }
  const catalog = await deps.listModels(apiKey);
  const chain = resolveBackgroundModelChain(catalog, { ref, preferredModel: req.preferredModel });
  if (!chain.length) {
    const preferred = resolvePreferredBackgroundModel(ref, req.preferredModel);
    const error = `后台模型 ${preferred} 不在当前模型目录里，后台任务已停用`;
    if (req.inboxOnFailure !== false) {
      postInbox(ref, {
        kind: "run",
        title: `后台任务没有运行：${req.label}`,
        body: error,
        key: `model-missing:${req.origin}:${req.label}:${new Date().toISOString().slice(0, 10)}`,
        chatId: req.chatId,
      });
    }
    return { ok: false, error };
  }

  const initialModel = chain[0]!;
  const run = startRunRecord(ref, {
    origin: req.origin,
    label: req.label,
    chatId: req.chatId,
    cwd: req.cwd,
    model: initialModel,
  });

  const timeoutMs = req.timeoutMs ?? BACKGROUND_MAX_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { result } = await Promise.race([
      promptWithModelFallback({
        catalog,
        ref,
        preferredModel: req.preferredModel,
        runWithModel: (modelId) =>
          deps!.prompt(`${BACKGROUND_PREAMBLE}\n\n${req.prompt}`, {
            apiKey,
            model: { id: modelId },
            tools: [...BACKGROUND_TOOLS],
            local: {
              cwd: req.cwd,
              sandboxOptions: { enabled: deps!.sandbox(ref.id) },
              settingSources: [],
              customTools: req.customTools,
            },
          }),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`后台运行超过 ${Math.round(timeoutMs / 60_000)} 分钟`)), timeoutMs);
      }),
    ]);
    const text = (result.result || "").trim();
    if (result.status !== "finished") {
      throw new Error(result.error?.message || `后台运行结束状态 ${result.status}`);
    }
    endRunRecord(ref, run.runId, { status: "done", summary: clip(text, 300) });
    return { ok: true, runId: run.runId, text };
  } catch (err) {
    const error = clip((err instanceof Error ? err.message : String(err)).replace(/cursor_[A-Za-z0-9_-]+/g, "cursor_…"), 400);
    endRunRecord(ref, run.runId, { status: "failed", error });
    if (req.inboxOnFailure !== false) {
      postInbox(ref, {
        kind: "run",
        title: `后台任务失败：${req.label}`,
        body: error,
        key: `failed:${run.runId}`,
        runId: run.runId,
        chatId: req.chatId,
      });
    }
    return { ok: false, runId: run.runId, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
