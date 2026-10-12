// 会话自动命名
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@cursor/sdk";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { gatewayEnv } from "../config.ts";
import { log } from "../log.ts";
import { adapterFor } from "../native/adapters/index.ts";
import { endpointFor, externalRoute } from "../providers.ts";
import { defaultModel } from "../runtime/env.ts";
import { chatNameKey, gatewayState, markChatNamed, type GatewayState } from "../runtime/state.ts";
import type { Tenant } from "../tenants.ts";
import { noteOutput, noteRun } from "../usage.ts";
import { send } from "../ws/send.ts";

const TITLE_SYSTEM =
  "你给这次对话起一个短标题。只输出标题本身，不要引号、句号或解释。中文优先，最多 16 个字，概括用户想做什么。";
const EXTERNAL_TIMEOUT_MS = 20_000;
const FALLBACK_CHARS = 16;

export function sanitizeChatTitle(raw: string) {
  let title =
    raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim()
      .split(/\r?\n/)[0] || "";
  title = title.replace(/^[#>*\-\s]+/, "");
  title = title.replace(/^标题[:：]\s*/, "");
  title = title.replace(/^["「『“]+|["」』”。！？.!?]+$/g, "").trim();
  if (title.length > 24) title = title.slice(0, 24).trim();
  return title;
}

/** 模型起不了标题时的兜底：用户首条消息的第一行前若干字 */
export function fallbackChatTitle(text: string) {
  const line = (text || "")
    .split(/\r?\n/)
    .map((row) => row.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return "";
  return sanitizeChatTitle([...line].slice(0, FALLBACK_CHARS).join(""));
}

type TitleModel = (userText: string) => Promise<string>;

export type TitleDeps = {
  state: GatewayState;
  cursorApiKey: string;
  /** 有 Cursor 密钥时用 */
  cursor: (apiKey: string, tenant: Tenant) => TitleModel;
  /** 没有 Cursor 密钥时，按会话当前模型找第三方提供方；不是第三方模型返回 null */
  external: (model: string) => TitleModel | null;
  emit: (ws: WebSocket, message: ServerMessage) => void;
};

function cursorTitleModel(apiKey: string, tenant: Tenant): TitleModel {
  return async (userText) => {
    const scratch = resolve(tenant.stateDir, "title-scratch");
    mkdirSync(scratch, { recursive: true });
    const result = await Agent.prompt(`用户第一条指令：\n${userText}`, {
      apiKey,
      model: { id: defaultModel() },
      local: { cwd: scratch, settingSources: [] },
      tools: [],
      systemPrompt: TITLE_SYSTEM,
    });
    return result.result || "";
  };
}

function externalTitleModel(model: string): TitleModel | null {
  const route = model ? externalRoute(model) : null;
  if (!route) return null;
  const endpoint = endpointFor(route.provider, route.model);
  const adapter = adapterFor(endpoint.adapter);
  return async (userText) => {
    const turn = await adapter({
      // 思考模型的思考链也占输出额度，给太少会只剩空正文
      endpoint: { ...endpoint, maxTokens: Math.min(endpoint.maxTokens ?? 1024, 1024) },
      messages: [
        { role: "system", content: `${TITLE_SYSTEM}下面是用户的第一条指令。` },
        { role: "user", content: userText },
      ],
      tools: [],
      signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
      onText: () => {},
      onThinking: () => {},
    });
    return turn.text;
  };
}

const defaultDeps = (): TitleDeps => ({
  state: gatewayState,
  cursorApiKey: gatewayEnv.cursorApiKey(),
  cursor: cursorTitleModel,
  external: externalTitleModel,
  emit: send,
});

/**
 * 有 Cursor 密钥时只用 Cursor 模型起标题（失败就不起）。
 * 没有时用会话当前的第三方模型，起不出来再退回用户首条消息的前几个字。
 */
export async function titleChat(
  ws: WebSocket,
  tenant: Tenant,
  chatId: string,
  text: string,
  model = "",
  overrides: Partial<TitleDeps> = {},
) {
  const deps = { ...defaultDeps(), ...overrides };
  const { state } = deps;
  const key = chatNameKey(tenant.id, chatId);
  if (!chatId || state.namedChats.has(key) || state.namingChats.has(key)) return;
  const userText = (text || "（附图）").trim().slice(0, 2000);
  const viaCursor = Boolean(deps.cursorApiKey);
  const ask = viaCursor ? deps.cursor(deps.cursorApiKey, tenant) : deps.external(model);
  state.namingChats.add(key);
  const titleT0 = Date.now();
  const chatLog = log.with({ tenant: tenant.id, chatId });
  try {
    let title = "";
    if (ask) {
      try {
        title = sanitizeChatTitle(await ask(userText));
        if (title) noteOutput(tenant.id, title.length); // 标题输出也走同一 API key
      } catch (err) {
        chatLog.error("titleChat", err instanceof Error ? err.message : err);
      } finally {
        noteRun(tenant.id, Date.now() - titleT0); // 起标题是一次真实模型调用（Kimi R1 M3），成败都计
      }
    }
    if (title === "新对话") title = "";
    if (!title && !viaCursor) title = fallbackChatTitle(text);
    if (!title || title === "新对话") return;
    markChatNamed(state, tenant.id, chatId);
    deps.emit(ws, { type: "chat_title", chatId, title });
  } finally {
    state.namingChats.delete(key);
  }
}
