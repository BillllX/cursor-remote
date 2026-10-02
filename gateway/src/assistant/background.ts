import type { AgentOptions, RunResult, SDKCustomTool } from "@cursor/sdk";
import { postInbox } from "./inbox.ts";
import { endRunRecord, runningCount, startRunRecord, type RunOrigin } from "./runs.ts";
import { clip, type TenantRef } from "./store.ts";

/** 后台任务统一用的模型（已定），每次运行前用模型目录校验，不在就失败，不换模型 */
export const BACKGROUND_MODEL = "grok-4.7";

/** 后台运行可用的内置工具：只读，加上挂 customTools 用的 mcp。没有 edit、delete、shell、task */
export const BACKGROUND_TOOLS = ["read", "grep", "glob", "ls", "mcp"] as const;

export const BACKGROUND_MAX_MS = 20 * 60_000;
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
  /** 失败时是否进收件箱；整理者这类安静任务可以关掉 */
  inboxOnFailure?: boolean;
  timeoutMs?: number;
};

export type BackgroundResult =
  | { ok: true; runId: string; text: string }
  | { ok: false; runId?: string; error: string; busy?: boolean };

const BACKGROUND_PREAMBLE = [
  "你在后台运行，没有人盯着这次运行。",
  "你不能改文件、不能跑命令、不能派子代理；只能读、搜索，以及调用助理工具。",
  "需要改代码或做有副作用的事时，不要尝试执行，用 inbox_post 写一张待批卡片说明要做什么、为什么。",
  "用中文，结论先行，简短。",
].join("\n");

export async function modelAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (!deps) return { ok: false, reason: "后台通道没有初始化" };
  const apiKey = deps.apiKey();
  if (!apiKey) return { ok: false, reason: "服务器没有配置 CURSOR_API_KEY" };
  const catalog = await deps.listModels(apiKey);
  if (!catalog.includes(BACKGROUND_MODEL)) {
    return { ok: false, reason: `后台模型 ${BACKGROUND_MODEL} 不在当前模型目录里，后台任务已停用` };
  }
  return { ok: true };
}

/**
 * 后台运行：策略只在这里生成，调用方传不进 mode、confirmWrites、autoApprove。
 * 工具白名单每次都带；SDK 拒绝白名单或 customTools 时直接失败，不去掉限制重试。
 */
export async function runBackground(ref: TenantRef, req: BackgroundRequest): Promise<BackgroundResult> {
  if (!deps) return { ok: false, error: "后台通道没有初始化" };
  if (runningCount(ref) >= BACKGROUND_MAX_PER_TENANT) {
    return { ok: false, busy: true, error: "同时在跑的后台任务已满" };
  }
  const available = await modelAvailable();
  if (!available.ok) {
    const error = available.reason || "后台模型不可用";
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
  const run = startRunRecord(ref, {
    origin: req.origin,
    label: req.label,
    chatId: req.chatId,
    cwd: req.cwd,
    model: BACKGROUND_MODEL,
  });
  const options: AgentOptions = {
    apiKey: deps.apiKey(),
    model: { id: BACKGROUND_MODEL },
    tools: [...BACKGROUND_TOOLS],
    local: {
      cwd: req.cwd,
      sandboxOptions: { enabled: deps.sandbox(ref.id) },
      settingSources: [],
      customTools: req.customTools,
    },
  };
  const timeoutMs = req.timeoutMs ?? BACKGROUND_MAX_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      deps.prompt(`${BACKGROUND_PREAMBLE}\n\n${req.prompt}`, options),
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
