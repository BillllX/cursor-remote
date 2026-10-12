// 会话自动命名
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@cursor/sdk";
import type { WebSocket } from "ws";
import { gatewayEnv } from "../config.ts";
import { log } from "../log.ts";
import { defaultModel } from "../runtime/env.ts";
import { namedChats, namingChats } from "../runtime/state.ts";
import type { Tenant } from "../tenants.ts";
import { noteOutput, noteRun } from "../usage.ts";
import { send } from "../ws/send.ts";

function sanitizeChatTitle(raw: string) {
  let title = raw.trim().split(/\r?\n/)[0] || "";
  title = title.replace(/^[#>*\-\s]+/, "");
  title = title.replace(/^标题[:：]\s*/, "");
  title = title.replace(/^["「『“]+|["」』”。！？.!?]+$/g, "").trim();
  if (title.length > 24) title = title.slice(0, 24).trim();
  return title;
}

export async function titleChat(ws: WebSocket, tenant: Tenant, chatId: string, text: string) {
  if (!chatId || namedChats.has(chatId) || namingChats.has(chatId)) return;
  const apiKey = gatewayEnv.cursorApiKey();
  if (!apiKey) return;
  namingChats.add(chatId);
  const titleT0 = Date.now();
  try {
    const scratch = resolve(tenant.stateDir, "title-scratch");
    mkdirSync(scratch, { recursive: true });
    const result = await Agent.prompt(`用户第一条指令：\n${(text || "（附图）").trim().slice(0, 2000)}`, {
      apiKey,
      model: { id: defaultModel() },
      local: { cwd: scratch, settingSources: [] },
      tools: [],
      systemPrompt:
        "你给这次对话起一个短标题。只输出标题本身，不要引号、句号或解释。中文优先，最多 16 个字，概括用户想做什么。",
    });
    const title = sanitizeChatTitle(result.result || "");
    if (!title || title === "新对话") return;
    namedChats.add(chatId);
    noteOutput(tenant.id, title.length); // 标题输出也走同一 API key
    send(ws, { type: "chat_title", chatId, title });
  } catch (err) {
    log.error("titleChat", err instanceof Error ? err.message : err);
  } finally {
    namingChats.delete(chatId);
    noteRun(tenant.id, Date.now() - titleT0); // 起标题是一次真实 agent 调用（Kimi R1 M3），成败都计
  }
}
