/**
 * 自研 Agent（native）的内部消息格式。各家适配器在边界上转换成自己的协议，
 * 循环、工具、会话持久化只认这一套。
 */

export type ImagePart = { data: string; mimeType: string };

/** Anthropic 思考块：带 tool_use 的轮次必须连同签名原样回传 */
export type ThinkingBlock = { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string };

export type ToolCall = {
  id: string;
  name: string;
  /** 模型给出的原始 JSON 字符串；解析失败时原样回给模型 */
  arguments: string;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImagePart[] }
  | {
      role: "assistant";
      content: string;
      reasoning?: string;
      /** 思考链来自正文里的 <think> 标签（MiniMax）。回传时要原样包回去 */
      reasoningInline?: boolean;
      thinkingBlocks?: ThinkingBlock[];
      toolCalls?: ToolCall[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type JsonSchema = Record<string, unknown>;

export type ToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function addUsage(into: Usage, more: Partial<Usage> | undefined) {
  if (!more) return into;
  into.inputTokens += more.inputTokens || 0;
  into.outputTokens += more.outputTokens || 0;
  into.cacheReadTokens += more.cacheReadTokens || 0;
  into.cacheWriteTokens += more.cacheWriteTokens || 0;
  into.reasoningTokens += more.reasoningTokens || 0;
  return into;
}

export type ModelTurn = {
  text: string;
  reasoning: string;
  reasoningInline: boolean;
  thinkingBlocks?: ThinkingBlock[];
  toolCalls: ToolCall[];
  usage?: Partial<Usage>;
  finishReason?: string;
};

export type AdapterKind = "openai" | "anthropic" | "xml";

export type ModelEndpoint = {
  /** provider id，日志和错误信息用 */
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  adapter: AdapterKind;
  vision: boolean;
  /** 把 reasoning_content 回传给模型（Kimi 思考模型的工具轮需要；DeepSeek 不能传） */
  echoReasoning: boolean;
  /** 支持 prompt caching 标记（Anthropic cache_control） */
  cache: boolean;
  maxTokens?: number;
};

export type AdapterRequest = {
  endpoint: ModelEndpoint;
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
};

export type Adapter = (req: AdapterRequest) => Promise<ModelTurn>;

export type ToolCategory = "read" | "write" | "shell" | "network" | "mcp" | "task";

export type ToolContext = {
  cwd: string;
  /** 这次调用的 id（task 用它把子 Agent 的事件挂到自己下面） */
  callId?: string;
  signal: AbortSignal;
  /** 长任务（shell）的流式输出 */
  onOutput?: (chunk: { stdout?: string; stderr?: string }) => void;
};

export type ToolResult = {
  ok: boolean;
  /** 回给模型的文本 */
  content: string;
  /** 本次改动的工作区相对路径 */
  changed?: string[];
  /** 子 Agent 的写操作被用户拒绝：父级循环按拒绝收尾（还原检查点） */
  denied?: boolean;
};

export type ToolSpec = ToolSchema & {
  category: ToolCategory;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};
