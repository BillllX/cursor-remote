import { ThinkSplitter } from "../../providers.ts";
import { httpError, readSse } from "../sse.ts";
import type { Adapter, ChatMessage, ModelEndpoint, ToolCall } from "../types.ts";

type WireMessage = Record<string, unknown>;

export function toOpenAIMessages(messages: ChatMessage[], endpoint: ModelEndpoint): WireMessage[] {
  const out: WireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") out.push({ role: "system", content: msg.content });
    else if (msg.role === "user") {
      const images = endpoint.vision ? msg.images || [] : [];
      out.push(
        images.length
          ? {
              role: "user",
              content: [
                { type: "text", text: msg.content },
                ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
              ],
            }
          : { role: "user", content: msg.content },
      );
    } else if (msg.role === "assistant") {
      const content =
        msg.reasoningInline && msg.reasoning ? `<think>${msg.reasoning}</think>${msg.content}` : msg.content;
      const row: WireMessage = { role: "assistant", content: content || (msg.toolCalls?.length ? null : "") };
      if (!msg.reasoningInline && msg.reasoning && endpoint.echoReasoning) row.reasoning_content = msg.reasoning;
      if (msg.toolCalls?.length) {
        row.tool_calls = msg.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        }));
      }
      out.push(row);
    } else {
      out.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.content });
    }
  }
  return out;
}

type Delta = {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type Chunk = {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

/** OpenAI 兼容 /chat/completions 流式 tool calling。 */
export const openaiAdapter: Adapter = async ({ endpoint, messages, tools, signal, onText, onThinking }) => {
  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages: toOpenAIMessages(messages, endpoint),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (endpoint.maxTokens) body.max_tokens = endpoint.maxTokens;

  const post = (payload: Record<string, unknown>) =>
    fetch(`${endpoint.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal,
    });

  let res = await post(body);
  if (res.status === 400 && body.stream_options) {
    // 部分兼容实现不认 stream_options，去掉再试一次
    const text = await res.text().catch(() => "");
    if (/stream_options|include_usage/i.test(text)) {
      delete body.stream_options;
      res = await post(body);
    } else {
      throw await httpError(new Response(text, { status: 400, statusText: res.statusText }), endpoint.name);
    }
  }
  if (!res.ok) throw await httpError(res, endpoint.name);
  if (!res.body) throw new Error(`${endpoint.name} 接口没有返回流`);

  let text = "";
  let reasoning = "";
  let inline = false;
  const splitter = new ThinkSplitter(
    (delta) => {
      text += delta;
      onText(delta);
    },
    (delta) => {
      inline = true;
      reasoning += delta;
      onThinking(delta);
    },
  );
  const calls = new Map<number, ToolCall>();
  let finishReason: string | undefined;
  let usage: ReturnType<typeof toUsage> | undefined;

  await readSse(res.body, endpoint.name, (data) => {
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.usage) usage = toUsage(chunk.usage);
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    const thinking = delta.reasoning_content ?? delta.reasoning;
    if (thinking) {
      reasoning += thinking;
      onThinking(thinking);
    }
    if (delta.content) splitter.push(delta.content);
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? calls.size;
      const cur = calls.get(index) || { id: "", name: "", arguments: "" };
      if (part.id) cur.id = part.id;
      if (part.function?.name) cur.name += part.function.name;
      if (part.function?.arguments) cur.arguments += part.function.arguments;
      calls.set(index, cur);
    }
  });
  splitter.flush();

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({ ...call, id: call.id || `call_${Date.now().toString(36)}_${index}` }))
    .filter((call) => call.name);
  return { text, reasoning, reasoningInline: inline, toolCalls, usage, finishReason };
};

function toUsage(raw: NonNullable<Chunk["usage"]>) {
  return {
    inputTokens: raw.prompt_tokens || 0,
    outputTokens: raw.completion_tokens || 0,
    cacheReadTokens: raw.prompt_tokens_details?.cached_tokens || 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens || 0,
  };
}
