import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stateDir } from "./tenants.js";

/**
 * P11：第三方 OpenAI 兼容模型接入（MiniMax / GLM / Kimi / Grok 等）。
 *
 * 配置：stateDir/providers.json（即 CURSOR_REMOTE_STATE_DIR 指向的目录，
 * 生产为 /var/lib/cursor-remote/providers.json；注意服务跑在 cursor-remote
 * 用户下，文件属主要给对该用户）。key 不下发客户端；模型 id 以
 * `provider:model` 编码混进 ready.models
 * （如 "minimax:MiniMax-M2"），iOS 选中后 prompt.model 原样回传，网关按前缀路由。
 *
 * 能力边界：纯问答——无工具、无检查点、无 confirm-writes；历史由客户端
 * 随 prompt 上行（iOS 是会话内容权威源，服务端 state.json 只是同步副本）。
 * reasoning_content（GLM/MiniMax 的思考链）映射 thinking-delta。
 *
 * providers.json 示例：
 * {
 *   "providers": [{
 *     "id": "minimax",
 *     "name": "MiniMax",
 *     "baseURL": "https://api.minimaxi.com/v1",
 *     "apiKeyEnv": "MINIMAX_API_KEY",   // 或 "apiKey": "sk-..." 直写（不推荐）
 *     "models": ["MiniMax-M2"],
 *     "vision": false                    // true 才允许带图（data URL 内联）
 *   }]
 * }
 */

export type ExternalProvider = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  vision: boolean;
};

const ID_RE = /^[a-z][a-z0-9-]*$/;

let cache: ExternalProvider[] | null = null;

export function loadExternalProviders(): ExternalProvider[] {
  if (cache) return cache;
  cache = [];
  const file = resolve(stateDir(), "providers.json");
  if (!existsSync(file)) return cache;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { providers?: unknown };
    const rows = Array.isArray(raw?.providers) ? raw.providers : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id.trim() : "";
      const baseURL = typeof rec.baseURL === "string" ? rec.baseURL.trim().replace(/\/+$/, "") : "";
      const models = Array.isArray(rec.models)
        ? rec.models.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim())
        : [];
      const apiKey =
        (typeof rec.apiKeyEnv === "string" && rec.apiKeyEnv.trim()
          ? process.env[rec.apiKeyEnv.trim()]?.trim()
          : undefined) ??
        (typeof rec.apiKey === "string" ? rec.apiKey.trim() : "");
      if (!ID_RE.test(id)) {
        console.error(`providers.json：id「${id || "?"}」不合法（小写字母/数字/短横线），跳过`);
        continue;
      }
      if (!baseURL.startsWith("https://") && !baseURL.startsWith("http://127.0.0.1")) {
        console.error(`providers.json：${id} 的 baseURL 必须是 https，跳过`);
        continue;
      }
      if (!models.length) {
        console.error(`providers.json：${id} 没配 models，跳过`);
        continue;
      }
      if (!apiKey) {
        console.error(`providers.json：${id} 缺 API key（apiKeyEnv 指向的环境变量为空），跳过`);
        continue;
      }
      cache.push({
        id,
        name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id,
        baseURL,
        apiKey,
        models,
        vision: rec.vision === true,
      });
    }
  } catch (err) {
    console.error("providers.json 解析失败：", err instanceof Error ? err.message : err);
  }
  if (cache.length) {
    console.error(`第三方模型：${cache.map((p) => `${p.id}(${p.models.length})`).join("、")}`);
  }
  return cache;
}

/** "minimax:MiniMax-M2" → { provider, model }；非第三方 id（无已知前缀）→ null */
export function externalRoute(
  modelId: string,
): { provider: ExternalProvider; model: string; full: string } | null {
  const match = /^([a-z][a-z0-9-]*):(.+)$/.exec(modelId.trim());
  if (!match) return null;
  const provider = loadExternalProviders().find((p) => p.id === match[1]);
  if (!provider) return null;
  const model = match[2].trim();
  if (!provider.models.includes(model)) return null;
  return { provider, model, full: `${provider.id}:${model}` };
}

/** 合并进 ready.models 的第三方模型 id 列表 */
export function externalModelIds(): string[] {
  return loadExternalProviders().flatMap((p) => p.models.map((m) => `${p.id}:${m}`));
}

export type ChatHistoryItem = { role: "user" | "assistant"; text: string };

/**
 * MiniMax-M2 的思考链不走 reasoning_content 字段，而是内联在 content 的
 * <think>...</think> 标签里——流式拆分到 thinking 通道，否则用户看到原始标签。
 * 标签可能跨 delta（如 "<thi"+"nk>"），缓冲尾部保留「模式长-1」字符防切半；
 * 不输出 <think> 的模型透明转发（仅拖尾几字符，流式体验不受影响）。
 */
class ThinkSplitter {
  private buf = "";
  private inThink = false;
  constructor(
    private onText: (s: string) => void,
    private onThinking: (s: string) => void,
  ) {}
  push(delta: string) {
    this.buf += delta;
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>";
      const at = this.buf.indexOf(tag);
      if (at < 0) {
        const keep = Math.min(tag.length - 1, this.buf.length);
        const emit = this.buf.slice(0, this.buf.length - keep);
        if (emit) (this.inThink ? this.onThinking : this.onText)(emit);
        this.buf = this.buf.slice(this.buf.length - keep);
        return;
      }
      const before = this.buf.slice(0, at);
      if (before) (this.inThink ? this.onThinking : this.onText)(before);
      this.buf = this.buf.slice(at + tag.length);
      this.inThink = !this.inThink;
    }
  }
  flush() {
    if (this.buf) (this.inThink ? this.onThinking : this.onText)(this.buf);
    this.buf = "";
  }
}

/**
 * 流式 chat completions：SSE → onText/onThinking 回调。
 * 返回累计输出字符数（计量用）；取消/错误抛给调用方。
 */
export async function streamChatCompletions(opts: {
  provider: ExternalProvider;
  model: string;
  system: string;
  history: ChatHistoryItem[];
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  signal: AbortSignal;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
}): Promise<void> {
  const { provider, model, system, history, text, images, signal, onText, onThinking } = opts;
  type Message = {
    role: string;
    content: string | Array<Record<string, unknown>>;
  };
  const messages: Message[] = [{ role: "system", content: system }];
  for (const item of history.slice(-12)) {
    const clipped = item.text.length > 3000 ? `${item.text.slice(0, 3000)}\n…` : item.text;
    if (clipped.trim()) messages.push({ role: item.role, content: clipped });
  }
  const usableImages = provider.vision ? (images ?? []) : [];
  if (usableImages.length) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text },
        ...usableImages.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        })),
      ],
    });
  } else {
    messages.push({ role: "user", content: text });
  }

  const res = await fetch(`${provider.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${provider.name} 接口 ${res.status}：${body.slice(0, 200) || res.statusText}`);
  }
  if (!res.body) throw new Error(`${provider.name} 接口没有返回流`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const splitter = new ThinkSplitter(onText, onThinking);
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 按双换行分帧；行首 "data:"，[DONE] 结束
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
        };
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) onThinking(delta.reasoning_content);
        if (delta?.content) splitter.push(delta.content);
      } catch {
        // 半截 JSON（跨帧）/心跳注释——丢帧不致命
      }
    }
  }
  splitter.flush();
}
