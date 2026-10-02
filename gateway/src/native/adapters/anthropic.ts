import { httpError, readSse } from "../sse.ts";
import type { Adapter, ChatMessage, ModelEndpoint, ThinkingBlock, ToolCall, ToolSchema } from "../types.ts";

type Block = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: Block[] };

const EPHEMERAL = { type: "ephemeral" } as const;

export function messagesUrl(baseURL: string) {
  const base = baseURL.replace(/\/+$/, "");
  if (/\/v1\/messages$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function toolInput(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * 内部消息 → Messages API：system 单独拿出；tool 结果并进下一条 user 消息；
 * 同角色相邻的消息合并（接口要求 user / assistant 交替）。
 */
export function toAnthropic(messages: ChatMessage[], endpoint: ModelEndpoint): { system: string; messages: WireMessage[] } {
  const system: string[] = [];
  const out: WireMessage[] = [];
  const push = (role: WireMessage["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const msg of messages) {
    if (msg.role === "system") {
      system.push(msg.content);
    } else if (msg.role === "user") {
      const blocks: Block[] = [];
      for (const img of endpoint.vision ? msg.images || [] : []) {
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } });
      }
      blocks.push({ type: "text", text: msg.content || "（空）" });
      push("user", blocks);
    } else if (msg.role === "assistant") {
      const blocks: Block[] = [];
      for (const block of msg.thinkingBlocks || []) blocks.push({ ...block });
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls || []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: toolInput(call.arguments) });
      if (!blocks.length) blocks.push({ type: "text", text: "…" });
      push("assistant", blocks);
    } else {
      push("user", [{ type: "tool_result", tool_use_id: msg.toolCallId, content: msg.content || "（无输出）", ...(msg.isError ? { is_error: true } : {}) }]);
    }
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "（继续）" }] });
  return { system: system.join("\n\n"), messages: out };
}

/** 前缀缓存：system、工具定义、最后一条消息各打一个断点（上限 4 个） */
export function applyCacheControl(body: { system?: unknown; tools?: Block[]; messages: WireMessage[] }) {
  if (typeof body.system === "string" && body.system) {
    body.system = [{ type: "text", text: body.system, cache_control: EPHEMERAL }];
  }
  if (body.tools?.length) body.tools[body.tools.length - 1] = { ...body.tools[body.tools.length - 1], cache_control: EPHEMERAL };
  const last = body.messages[body.messages.length - 1];
  if (last?.content.length) {
    const i = last.content.length - 1;
    last.content[i] = { ...last.content[i], cache_control: EPHEMERAL };
  }
}

type StreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: RawUsage };
  content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; data?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
  usage?: RawUsage;
  error?: { type?: string; message?: string };
};

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type Building =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "tool"; id: string; name: string; json: string };

/** Anthropic Messages API 流式 tool calling（Claude、MiniMax /anthropic 等兼容实现）。 */
export const anthropicAdapter: Adapter = async ({ endpoint, messages, tools, signal, onText, onThinking }) => {
  const converted = toAnthropic(messages, endpoint);
  const body: { model: string; max_tokens: number; stream: true; system?: unknown; tools?: Block[]; messages: WireMessage[] } = {
    model: endpoint.model,
    max_tokens: endpoint.maxTokens || 8192,
    stream: true,
    messages: converted.messages,
  };
  if (converted.system) body.system = converted.system;
  if (tools.length) body.tools = tools.map((tool: ToolSchema) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  if (endpoint.cache) applyCacheControl(body);

  const res = await fetch(messagesUrl(endpoint.baseURL), {
    method: "POST",
    headers: {
      "x-api-key": endpoint.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res, endpoint.name);
  if (!res.body) throw new Error(`${endpoint.name} 接口没有返回流`);

  const blocks = new Map<number, Building>();
  let text = "";
  let reasoning = "";
  let finishReason: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const takeUsage = (raw?: RawUsage) => {
    if (!raw) return;
    if (raw.input_tokens != null) usage.inputTokens = raw.input_tokens;
    if (raw.output_tokens != null) usage.outputTokens = raw.output_tokens;
    if (raw.cache_read_input_tokens != null) usage.cacheReadTokens = raw.cache_read_input_tokens;
    if (raw.cache_creation_input_tokens != null) usage.cacheWriteTokens = raw.cache_creation_input_tokens;
  };
  let streamError = "";

  await readSse(res.body, endpoint.name, (data) => {
    let ev: StreamEvent;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const index = ev.index ?? 0;
    switch (ev.type) {
      case "message_start":
        takeUsage(ev.message?.usage);
        break;
      case "content_block_start": {
        const cb = ev.content_block || {};
        if (cb.type === "tool_use") blocks.set(index, { kind: "tool", id: cb.id || "", name: cb.name || "", json: "" });
        else if (cb.type === "thinking") {
          blocks.set(index, { kind: "thinking", thinking: cb.thinking || "", signature: cb.signature || "" });
          if (cb.thinking) {
            reasoning += cb.thinking;
            onThinking(cb.thinking);
          }
        } else if (cb.type === "redacted_thinking") blocks.set(index, { kind: "redacted", data: cb.data || "" });
        else {
          blocks.set(index, { kind: "text", text: cb.text || "" });
          if (cb.text) {
            text += cb.text;
            onText(cb.text);
          }
        }
        break;
      }
      case "content_block_delta": {
        const cur = blocks.get(index);
        const delta = ev.delta || {};
        if (!cur) break;
        if (delta.type === "text_delta" && cur.kind === "text" && delta.text) {
          cur.text += delta.text;
          text += delta.text;
          onText(delta.text);
        } else if (delta.type === "thinking_delta" && cur.kind === "thinking" && delta.thinking) {
          cur.thinking += delta.thinking;
          reasoning += delta.thinking;
          onThinking(delta.thinking);
        } else if (delta.type === "signature_delta" && cur.kind === "thinking" && delta.signature) {
          cur.signature += delta.signature;
        } else if (delta.type === "input_json_delta" && cur.kind === "tool" && delta.partial_json) {
          cur.json += delta.partial_json;
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
        takeUsage(ev.usage);
        break;
      case "error":
        streamError = ev.error?.message || ev.error?.type || "未知错误";
        break;
    }
  });
  if (streamError) throw new Error(`${endpoint.name} 流中报错：${streamError.slice(0, 300)}`);

  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  const thinkingBlocks: ThinkingBlock[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of ordered) {
    if (block.kind === "thinking" && block.signature) thinkingBlocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    else if (block.kind === "redacted") thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
    else if (block.kind === "tool" && block.name) {
      toolCalls.push({ id: block.id || `toolu_${Date.now().toString(36)}_${toolCalls.length}`, name: block.name, arguments: block.json || "{}" });
    }
  }
  return {
    text,
    reasoning,
    reasoningInline: false,
    thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
    toolCalls,
    usage,
    finishReason,
  };
};
