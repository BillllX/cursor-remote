import { ConfineError } from "./confine.ts";
import { HttpError } from "./sse.ts";
import {
  addUsage,
  emptyUsage,
  type Adapter,
  type ChatMessage,
  type ModelEndpoint,
  type ModelTurn,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
  type Usage,
} from "./types.ts";

export type NativeStatus = "completed" | "cancelled" | "error" | "denied" | "max_steps";

export type NativeHooks = {
  text: (delta: string) => void;
  thinking: (delta: string) => void;
  toolStarted: (call: ToolCall, args: Record<string, unknown>, spec: ToolSpec | undefined) => void;
  toolOutput?: (call: ToolCall, chunk: { stdout?: string; stderr?: string }) => void;
  toolCompleted: (call: ToolCall, result: ToolResult, spec: ToolSpec | undefined) => void;
  /** 返回 false 表示用户拒绝，循环以 denied 结束 */
  approve: (call: ToolCall, args: Record<string, unknown>, spec: ToolSpec) => Promise<boolean>;
  needsApproval: (spec: ToolSpec, args: Record<string, unknown>) => boolean;
  /** 执行前的硬性拦截（越界、禁用命令）：返回原因则不执行，原因作为错误结果回给模型 */
  vet?: (spec: ToolSpec, args: Record<string, unknown>) => string | null;
  /** 一次模型调用结束（含 usage），计量用 */
  turn?: (turn: ModelTurn, step: number) => void;
  /** 退避重试前的提示 */
  retrying?: (attempt: number, waitMs: number, reason: string) => void;
  /** 每轮发给模型前整理上下文（P3 压缩） */
  compact?: (messages: ChatMessage[], signal: AbortSignal) => Promise<ChatMessage[]>;
};

export type NativeRunInput = {
  adapter: Adapter;
  endpoint: ModelEndpoint;
  messages: ChatMessage[];
  tools: ToolSpec[];
  cwd: string;
  signal: AbortSignal;
  hooks: NativeHooks;
  maxSteps?: number;
  /** 同一轮里只读工具并发执行 */
  parallelReads?: boolean;
  maxRetries?: number;
};

export type NativeRunResult = {
  status: NativeStatus;
  messages: ChatMessage[];
  usage: Usage;
  steps: number;
  error?: string;
};

const MAX_TOOL_CONTENT = 30_000;

function clipToolContent(text: string) {
  if (text.length <= MAX_TOOL_CONTENT) return text;
  const head = text.slice(0, MAX_TOOL_CONTENT * 0.7);
  const tail = text.slice(-MAX_TOOL_CONTENT * 0.25);
  return `${head}\n…（中间省略 ${text.length - head.length - tail.length} 字符）…\n${tail}`;
}

export function isAbort(err: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 429 / 5xx / 网络错误按指数退避重试；已经流出正文的不重试，避免重复输出 */
export function retryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status === 408 || err.status >= 500;
  if (!(err instanceof Error)) return false;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|停滞/i.test(`${err.message} ${(err as { cause?: Error }).cause?.message || ""}`);
}

export function parseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = (raw || "").trim();
  if (!text) return { ok: true, args: {} };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, args: value as Record<string, unknown> };
    return { ok: false, error: "参数必须是 JSON 对象" };
  } catch (err) {
    return { ok: false, error: `参数不是合法 JSON：${(err as Error).message}` };
  }
}

async function callModel(input: NativeRunInput, messages: ChatMessage[]): Promise<ModelTurn> {
  const { adapter, endpoint, tools, signal, hooks } = input;
  const maxRetries = input.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    try {
      return await adapter({
        endpoint,
        messages,
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        signal,
        onText: (delta) => {
          streamed = true;
          hooks.text(delta);
        },
        onThinking: (delta) => {
          streamed = true;
          hooks.thinking(delta);
        },
      });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      if (streamed || attempt >= maxRetries || !retryable(err)) throw err;
      const hinted = err instanceof HttpError ? err.retryAfterMs : undefined;
      const waitMs = Math.min(hinted ?? 1000 * 2 ** attempt + Math.floor(Math.random() * 400), 30_000);
      hooks.retrying?.(attempt + 1, waitMs, err instanceof Error ? err.message : String(err));
      await sleep(waitMs, signal);
    }
  }
}

async function execTool(
  input: NativeRunInput,
  call: ToolCall,
  spec: ToolSpec | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!spec) return { ok: false, content: `没有叫 ${call.name} 的工具。可用：${input.tools.map((t) => t.name).join(", ")}` };
  try {
    return await spec.run(args, {
      cwd: input.cwd,
      signal: input.signal,
      onOutput: input.hooks.toolOutput ? (chunk) => input.hooks.toolOutput!(call, chunk) : undefined,
    });
  } catch (err) {
    if (isAbort(err, input.signal)) throw err;
    if (err instanceof ConfineError) return { ok: false, content: err.message };
    return { ok: false, content: `工具执行出错：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 工具调用循环：调模型 → 收齐 tool_calls → 审批 → 执行 → 结果回灌，直到模型不再调用工具。
 * 返回完整消息列表（含本轮新增），由调用方持久化。
 */
export async function runNativeLoop(input: NativeRunInput): Promise<NativeRunResult> {
  const { signal, hooks } = input;
  const maxSteps = input.maxSteps ?? 40;
  let messages = input.messages.slice();
  const usage = emptyUsage();
  let step = 0;
  const finish = (status: NativeStatus, error?: string): NativeRunResult => ({ status, messages, usage, steps: step, error });

  try {
    while (step < maxSteps) {
      if (signal.aborted) return finish("cancelled");
      if (hooks.compact) messages = await hooks.compact(messages, signal);
      step += 1;
      const turn = await callModel(input, messages);
      addUsage(usage, turn.usage);
      hooks.turn?.(turn, step);
      messages.push({
        role: "assistant",
        content: turn.text,
        reasoning: turn.reasoning || undefined,
        reasoningInline: turn.reasoningInline || undefined,
        toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined,
      });
      if (!turn.toolCalls.length) return finish("completed");

      const prepared = turn.toolCalls.map((call) => {
        const spec = input.tools.find((tool) => tool.name === call.name);
        const parsed = parseArgs(call.arguments);
        return { call, spec, parsed };
      });

      const runOne = async (item: (typeof prepared)[number]): Promise<"ok" | "denied"> => {
        const { call, spec, parsed } = item;
        const args = parsed.ok ? parsed.args : {};
        hooks.toolStarted(call, args, spec);
        let result: ToolResult;
        const veto = parsed.ok && spec ? hooks.vet?.(spec, args) : null;
        if (!parsed.ok) result = { ok: false, content: parsed.error };
        else if (veto) result = { ok: false, content: veto };
        else {
          if (spec && hooks.needsApproval(spec, args)) {
            const allowed = await hooks.approve(call, args, spec);
            if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            if (!allowed) {
              result = { ok: false, content: "用户拒绝了这次操作。" };
              hooks.toolCompleted(call, result, spec);
              messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, isError: true });
              return "denied";
            }
          }
          result = await execTool(input, call, spec, args);
        }
        hooks.toolCompleted(call, result, spec);
        return pushResult(call, result);
      };

      const pushResult = (call: ToolCall, result: ToolResult): "ok" => {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: clipToolContent(result.content || (result.ok ? "完成" : "失败")),
          isError: !result.ok || undefined,
        });
        return "ok";
      };

      const allReads =
        input.parallelReads !== false &&
        prepared.length > 1 &&
        prepared.every((item) => item.spec && item.parsed.ok && (item.spec.category === "read" || item.spec.category === "network") && !hooks.needsApproval(item.spec, item.parsed.args) && !hooks.vet?.(item.spec, item.parsed.args));
      if (allReads) {
        prepared.forEach((item) => hooks.toolStarted(item.call, item.parsed.ok ? item.parsed.args : {}, item.spec));
        const results = await Promise.all(prepared.map((item) => execTool(input, item.call, item.spec, item.parsed.ok ? item.parsed.args : {})));
        prepared.forEach((item, i) => {
          hooks.toolCompleted(item.call, results[i], item.spec);
          pushResult(item.call, results[i]);
        });
        continue;
      }

      for (let i = 0; i < prepared.length; i++) {
        const outcome = await runOne(prepared[i]);
        if (outcome === "denied") {
          for (const rest of prepared.slice(i + 1)) {
            messages.push({ role: "tool", toolCallId: rest.call.id, name: rest.call.name, content: "未执行：前一个操作被用户拒绝。", isError: true });
          }
          return finish("denied");
        }
      }
    }
    return finish("max_steps");
  } catch (err) {
    if (isAbort(err, signal)) return finish("cancelled");
    return finish("error", err instanceof Error ? err.message : String(err));
  }
}
