import type { Adapter, ChatMessage, ModelEndpoint } from "./types.ts";

/**
 * 上下文压缩，每次调模型前执行（loop 的 compact 钩子）：
 * 1. 截短旧的工具结果（当前轮最近几步保留原文）；
 * 2. 还超预算：把更早的轮次交给模型写成摘要；
 * 3. 当前这一轮本身就超长（50+ 步的长任务）：把这一轮中间的步骤写成摘要，保留开头的需求和最近几步。
 * 摘要调用失败时退回机械摘要（列出调过的工具和改过的文件），保证不会因为压缩失败卡住任务。
 */

const OLD_TOOL_CHARS = 1_500;
const KEEP_RECENT = 8;
const SUMMARY_INPUT_CHARS = 60_000;

export function sizeOf(messages: ChatMessage[]) {
  let n = 0;
  for (const msg of messages) {
    n += msg.content.length;
    if (msg.role === "assistant") {
      n += msg.reasoning?.length ?? 0;
      for (const call of msg.toolCalls ?? []) n += call.arguments.length + call.name.length;
    }
  }
  return n;
}

/** 上下文窗口（token）换算成字符预算：中英混排按 2.5 字符/token，留 40% 给输出和误差 */
export function budgetFor(contextTokens = 128_000) {
  return Math.floor(contextTokens * 2.5 * 0.6);
}

function lastUserIndex(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

/** 第一级：截短工具结果。keepFrom 之后的消息保留原文 */
export function clipOldToolResults(messages: ChatMessage[], keepFrom: number): ChatMessage[] {
  return messages.map((msg, i) => {
    if (i >= keepFrom || msg.role !== "tool" || msg.content.length <= OLD_TOOL_CHARS) return msg;
    return { ...msg, content: `${msg.content.slice(0, OLD_TOOL_CHARS)}\n…（较早的结果已压缩，需要时重新读取）` };
  });
}

/** 从 from 往后找第一个 assistant 消息的位置，保证切点不会把 tool_call 和它的结果拆开 */
function assistantBoundary(messages: ChatMessage[], from: number) {
  for (let i = Math.max(from, 0); i < messages.length; i++) if (messages[i].role === "assistant") return i;
  return -1;
}

export function renderTranscript(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") lines.push(`【用户】${msg.content.slice(0, 4000)}`);
    else if (msg.role === "assistant") {
      if (msg.content) lines.push(`【助手】${msg.content.slice(0, 3000)}`);
      for (const call of msg.toolCalls ?? []) lines.push(`【调用 ${call.name}】${call.arguments.slice(0, 400)}`);
    } else lines.push(`【结果 ${msg.name}${msg.isError ? " 失败" : ""}】${msg.content.slice(0, 600)}`);
  }
  let text = lines.join("\n");
  if (text.length > SUMMARY_INPUT_CHARS) text = `…（更早部分略）\n${text.slice(-SUMMARY_INPUT_CHARS)}`;
  return text;
}

/** 摘要失败时的兜底：只列事实（调用过的工具、涉及的路径、最后的说明） */
export function mechanicalSummary(messages: ChatMessage[]) {
  const tools = new Map<string, number>();
  const paths = new Set<string>();
  let lastText = "";
  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (msg.content) lastText = msg.content;
      for (const call of msg.toolCalls ?? []) {
        tools.set(call.name, (tools.get(call.name) ?? 0) + 1);
        const path = /"path"\s*:\s*"([^"]+)"/.exec(call.arguments)?.[1];
        if (path) paths.add(path);
      }
    }
  }
  return [
    tools.size ? `调用过的工具：${[...tools].map(([name, n]) => `${name}×${n}`).join("、")}` : "",
    paths.size ? `涉及的文件：${[...paths].slice(0, 40).join("、")}` : "",
    lastText ? `最后的说明：${lastText.slice(0, 1500)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type Summarizer = (transcript: string, signal: AbortSignal) => Promise<string>;

/** 用同一个模型写摘要（不带工具） */
export function modelSummarizer(
  adapter: Adapter,
  endpoint: ModelEndpoint,
  onTurn?: (turn: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } }) => void,
): Summarizer {
  return async (transcript, signal) => {
    const turn = await adapter({
      endpoint: { ...endpoint, maxTokens: Math.min(endpoint.maxTokens ?? 2048, 2048) },
      messages: [
        {
          role: "system",
          content:
            "你负责压缩编码 Agent 的工作记录，供它自己接着干活。用中文写，800 字以内，只写事实：用户要做什么、已经完成了什么（改了哪些文件、关键结论）、发现的问题和约束、还没做完的事。不要寒暄，不要编造记录里没有的内容。",
        },
        { role: "user", content: `工作记录：\n${transcript}\n\n请输出摘要。` },
      ],
      tools: [],
      signal,
      onText: () => {},
      onThinking: () => {},
    });
    onTurn?.(turn);
    return turn.text.trim();
  };
}

export type CompactInfo = { stage: 1 | 2 | 3; before: number; after: number; summarized: number };

export function makeCompactor(opts: { budgetChars: number; summarize: Summarizer; onCompact?: (info: CompactInfo) => void }) {
  const summarizeSafe = async (part: ChatMessage[], signal: AbortSignal) => {
    try {
      const text = await opts.summarize(renderTranscript(part), signal);
      if (text) return text;
    } catch (err) {
      if (signal.aborted) throw err;
    }
    return mechanicalSummary(part);
  };

  return async (messages: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> => {
    const before = sizeOf(messages);
    if (before <= opts.budgetChars) return messages;
    const userAt = lastUserIndex(messages);
    const keepFrom = Math.max(userAt + 1, messages.length - KEEP_RECENT);
    let next = clipOldToolResults(messages, keepFrom);
    if (sizeOf(next) <= opts.budgetChars) {
      opts.onCompact?.({ stage: 1, before, after: sizeOf(next), summarized: 0 });
      return next;
    }

    const head = next[0]?.role === "system" ? [next[0]] : [];
    const start = head.length;
    // 第二级：更早的轮次（最后一条 user 之前）整体写成摘要
    if (userAt > start) {
      const older = next.slice(start, userAt);
      const summary = await summarizeSafe(older, signal);
      next = [
        ...head,
        { role: "user", content: `（更早对话的摘要，原文已压缩）\n${summary}` },
        { role: "assistant", content: "好的，我按这个摘要继续。" },
        ...next.slice(userAt),
      ];
      if (sizeOf(next) <= opts.budgetChars) {
        opts.onCompact?.({ stage: 2, before, after: sizeOf(next), summarized: older.length });
        return next;
      }
    }

    // 第三级：当前这一轮太长，保留需求原文和最近几步，中间写成摘要
    const userNow = lastUserIndex(next);
    const firstStep = userNow + 1;
    const cut = assistantBoundary(next, next.length - KEEP_RECENT);
    if (cut > firstStep) {
      const middle = next.slice(firstStep, cut);
      const summary = await summarizeSafe(middle, signal);
      // 摘要并进切点处那条 assistant，避免出现连续两条 assistant
      const anchor = next[cut] as Extract<ChatMessage, { role: "assistant" }>;
      const note = `（前面 ${middle.length} 条步骤的摘要，原文已压缩）\n${summary}`;
      const compacted: ChatMessage[] = [
        ...next.slice(0, firstStep),
        { ...anchor, content: anchor.content ? `${note}\n\n${anchor.content}` : note },
        ...next.slice(cut + 1),
      ];
      opts.onCompact?.({ stage: 3, before, after: sizeOf(compacted), summarized: middle.length });
      return compacted;
    }
    opts.onCompact?.({ stage: 2, before, after: sizeOf(next), summarized: 0 });
    return next;
  };
}
