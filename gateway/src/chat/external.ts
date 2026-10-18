// 第三方模型（OpenAI 兼容接口）对话运行
import type { WebSocket } from "ws";
import { type ChatHistoryItem, type ExternalProvider, streamChatCompletions } from "../providers.ts";
import { isAbortError } from "../runtime/abort.ts";
import type { Slot } from "../runtime/types.ts";
import { getTenant } from "../tenants.ts";
import { noteOutput } from "../usage.ts";
import { send } from "../ws/send.ts";
import { finishRun } from "./finish.ts";
import { loadWorkspaceRules } from "./prompt.ts";

/** P11：第三方 OpenAI 兼容模型的问答 run——SSE 流映射成现有 text/thinking-delta 事件，
 *  iOS 端 turn 组装与 Cursor run 完全同一条链路。无工具，不产生 edited/checkpoint。 */
export async function runExternalChat(
  ws: WebSocket,
  slot: Slot,
  ext: { provider: ExternalProvider; model: string; full: string },
  input: {
    text: string;
    images: Array<{ data: string; mimeType: string }>;
    history: ChatHistoryItem[];
    epoch: number;
    cwd: string;
    assistantBlock?: string;
  },
) {
  const { epoch } = input;
  const t0 = Date.now();
  send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
  send(ws, {
    type: "run_meta",
    chatId: slot.chatId,
    model: ext.full,
    mode: "ask", // 第三方一律按问答对待（无工具），UI 不显示工具相关徽标
    policy: slot.policy,
    dialect: false,
  });
  if (input.images.length && !ext.provider.vision) {
    send(ws, {
      type: "error",
      chatId: slot.chatId,
      message: `${ext.provider.name} 这个模型不收图片（providers.json 里 vision: true 才放行）。`,
    });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
    return;
  }
  const rules = loadWorkspaceRules(input.cwd, getTenant(slot.tenantId), input.text);
  const system = input.assistantBlock
    ? [
        input.assistantBlock,
        "当前模型没有工具，读不了也改不了工作区文件——只能根据对话和上面的记忆数据回答；需要动手时请让用户换 Cursor 目录里的模型。",
        rules ? `工作区规则：\n${rules}` : "",
        "回答用中文（除非用户用别的语言提问），代码块标语言。",
      ]
        .filter(Boolean)
        .join("\n\n")
    : [
        "你是「接驳」客户端里的问答助手。你没有工具，读不了也改不了工作区文件——只能根据对话内容回答。",
        `用户的工作区路径：${input.cwd}。`,
        rules ? `工作区规则：\n${rules}` : "",
        "回答用中文（除非用户用别的语言提问），代码块标语言。",
      ]
        .filter(Boolean)
        .join("\n");
  const abort = new AbortController();
  slot.externalAbort = abort;
  try {
    await streamChatCompletions({
      provider: ext.provider,
      model: ext.model,
      system,
      history: input.history,
      text: input.text,
      images: input.images,
      signal: abort.signal,
      onText: (delta) => {
        send(ws, { type: "text-delta", chatId: slot.chatId, text: delta });
        noteOutput(slot.tenantId, delta.length); // P9 计量：与 Cursor run 同口径
      },
      onThinking: (delta) => {
        send(ws, { type: "thinking-delta", chatId: slot.chatId, text: delta });
        noteOutput(slot.tenantId, delta.length);
      },
    });
    finishRun(ws, slot, "completed", Date.now() - t0, epoch);
  } catch (err) {
    if (isAbortError(err)) {
      finishRun(ws, slot, "cancelled", Date.now() - t0, epoch);
    } else {
      send(ws, {
        type: "error",
        chatId: slot.chatId,
        message: err instanceof Error ? err.message : "第三方模型调用失败",
      });
      finishRun(ws, slot, "error", Date.now() - t0, epoch);
    }
  } finally {
    if (slot.externalAbort === abort) slot.externalAbort = null;
  }
}
