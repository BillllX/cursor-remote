// 多模型评审：评审名单同步与评审面板运行
import { Agent } from "@cursor/sdk";
import type { WebSocket } from "ws";
import { pickReviewPanel, type ReviewBinding, rosterKey, workspaceConfinePrompt } from "../../../shared/crew.ts";
import { gatewayEnv } from "../config.ts";
import { disposeSlot, persistConn } from "../runtime/slots.ts";
import type { Conn, Slot } from "../runtime/types.ts";
import { sandboxEnabledForTenant } from "../tenants.ts";
import { noteOutput, noteRun, noteToolCall } from "../usage.ts";
import { send } from "../ws/send.ts";
import { diskChatTurns } from "./history.ts";
import { listModels } from "./models.ts";

/** 多模型并行评审单路超时上限：10 分钟 */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;

const MAX_REVIEW_SOURCE_CHARS = 24_000;

export async function syncReviewRoster(conn: Conn, slot: Slot, lead: string) {
  const apiKey = gatewayEnv.cursorApiKey();
  const catalog = apiKey ? await listModels(apiKey) : [];
  const next = pickReviewPanel(lead, catalog);
  const known = slot.reviewRoster;
  const same = known ? rosterKey(known) === rosterKey(next) : false;
  if (same) return;
  const stale = known !== undefined || Boolean(slot.agent || slot.agentId);
  if (stale && (slot.agent || slot.agentId)) {
    if (slot.agent) await disposeSlot(slot);
    slot.agentId = null;
    slot.reseed = true;
  }
  slot.reviewRoster = next;
  if (stale) persistConn(conn);
}

function clipReviewError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "评审失败";
  return raw
    .replace(/cursor_[A-Za-z0-9_-]+/g, "cursor_…")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-…")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "jwt_…")
    .slice(0, 300);
}

/**
 * 组装交给独立评审模型的上下文：
 * 当用户只发了「再评审下这个方案」等简短指令时，自动附带当前会话最近 2 轮对话摘录与关联文件路径，
 * 避免评审员因缺少上下文而在全库盲搜导致评偏或超时。
 */
export function buildReviewSource(
  userText: string,
  opts?: {
    recentTurns?: Array<{ user: string; assistant: string }>;
    files?: string[];
  },
): string {
  const parts: string[] = [];
  const files = (opts?.files ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length) {
    parts.push(`关联文件：\n${files.map((f) => `- ${f}`).join("\n")}`);
  }
  const wanted = userText.trim();
  const turns = (opts?.recentTurns ?? []).filter((t) => {
    if (!t.user && !t.assistant) return false;
    if (wanted && t.user === wanted && !t.assistant) return false;
    return true;
  });
  if (turns.length) {
    const recent = turns.slice(-2).map((t, idx) => {
      const u = t.user.length > 2_000 ? `${t.user.slice(0, 2_000)}\n…` : t.user;
      const a = t.assistant.length > 8_000 ? `${t.assistant.slice(0, 8_000)}\n…` : t.assistant;
      return `[近期上文 ${idx + 1}]\n用户：${u || "（空）"}\n助手：${a || "（无文字回复）"}`;
    });
    parts.push(`当前会话近期上下文（供定位被评审的方案或画布）：\n${recent.join("\n\n")}`);
  }
  parts.push(`本轮评审请求：\n${wanted}`);
  const combined = parts.join("\n\n");
  return combined.length > MAX_REVIEW_SOURCE_CHARS
    ? `${combined.slice(0, MAX_REVIEW_SOURCE_CHARS)}\n…（原文过长，已截断）`
    : combined;
}

function reviewsForLead(rows: Array<{ name: string; modelId: string; ok: boolean; text: string }>): string {
  if (!rows.length) return "";
  const body = rows
    .map((row) => `## ${row.name}（${row.modelId}）\n${row.ok ? row.text : `这次没评成：${row.text}`}`)
    .join("\n\n");
  return [
    "",
    "网关已经用不同模型分别评审过上面的内容。你只汇总一致结论、分歧和必须先改的点。",
    "不要再派 reviewer 或 review-* 重复评审，也不要说你又调用了这些模型。",
    body,
  ].join("\n");
}

export type ReviewPromptFn = typeof Agent.prompt;

export type RunReviewPanelOptions = {
  files?: string[];
  recentTurns?: Array<{ user: string; assistant: string }>;
  timeoutMs?: number;
  promptFn?: ReviewPromptFn;
};

export async function runReviewPanel(
  ws: WebSocket,
  conn: Conn,
  slot: Slot,
  panel: ReviewBinding[],
  userText: string,
  cwd: string,
  apiKey: string,
  epoch: number,
  options?: RunReviewPanelOptions,
): Promise<string> {
  const sandbox = sandboxEnabledForTenant(conn.tenant);
  const recentTurns = options?.recentTurns ?? diskChatTurns(conn.tenant, slot.chatId);
  const source = buildReviewSource(userText, {
    recentTurns,
    files: options?.files,
  });
  const timeoutMs = options?.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const promptFn = options?.promptFn ?? ((msg, opts) => Agent.prompt(msg, opts));

  send(ws, {
    type: "text-delta",
    chatId: slot.chatId,
    text: `正在用 ${panel.map((row) => row.modelId).join("、")} 分别评审。\n\n`,
  });
  const jobs = panel.map(async (row) => {
    const callId = crypto.randomUUID();
    if (slot.finished || slot.epoch !== epoch) return null;
    const args = { subagent_type: row.name, description: `${row.modelId} 评审` };
    if (!slot.openTools) slot.openTools = new Map();
    slot.openTools.set(callId, { name: "task", args, agent: "reviewer", model: row.modelId });
    slot.runStats.toolStarts += 1;
    send(ws, {
      type: "tool-started",
      chatId: slot.chatId,
      callId,
      name: "task",
      args,
      agent: "reviewer",
      model: row.modelId,
    });
    const started = Date.now();
    const finish = (status: "completed" | "error", result: string) => {
      slot.openTools?.delete(callId);
      noteToolCall(slot.tenantId);
      if (status === "completed") noteOutput(slot.tenantId, result.length);
      noteRun(slot.tenantId, Date.now() - started);
      if (slot.epoch !== epoch) return;
      send(ws, {
        type: "tool-completed",
        chatId: slot.chatId,
        callId,
        name: "task",
        status,
        result,
        agent: "reviewer",
        model: row.modelId,
      });
    };
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelPollTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const result = await Promise.race([
        promptFn(
          [
            `你是独立评审，绑定模型 ${row.modelId}。只评审，不要改文件，不要派子代理。`,
            workspaceConfinePrompt(cwd),
            "对照仓库里的相关代码。列出具体问题，按 CRITICAL / MAJOR / MINOR。没有问题的部分直接说可行。用中文。",
            "",
            "要评审的内容：",
            source,
          ].join("\n"),
          {
            apiKey,
            model: { id: row.modelId },
            local: { cwd, sandboxOptions: { enabled: sandbox } },
            disallowedTools: ["edit", "delete", "shell", "task", "mcp", "applyAgentDiff", "generateImage"],
          },
        ),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error("评审超时")), timeoutMs);
          cancelPollTimer = setInterval(() => {
            if (slot.finished || slot.epoch !== epoch) {
              reject(new Error("评审已取消"));
            }
          }, 200);
          cancelPollTimer.unref?.();
        }),
      ]);
      if (slot.finished || slot.epoch !== epoch) {
        slot.openTools?.delete(callId);
        return null;
      }
      const text = (result.result || "").trim() || result.error?.message || "没有返回正文";
      const ok = result.status === "finished" && Boolean(result.result?.trim());
      finish(ok ? "completed" : "error", text);
      return { name: row.name, modelId: row.modelId, ok, text };
    } catch (err) {
      if (slot.finished || slot.epoch !== epoch) {
        slot.openTools?.delete(callId);
        return null;
      }
      const text = clipReviewError(err);
      finish("error", text);
      return { name: row.name, modelId: row.modelId, ok: false, text };
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (cancelPollTimer !== undefined) clearInterval(cancelPollTimer);
    }
  });
  const rows = (await Promise.all(jobs)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  return reviewsForLead(rows);
}
