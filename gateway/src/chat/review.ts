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
import { listModels } from "./models.ts";

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
  return raw.replace(/cursor_[A-Za-z0-9_-]+/g, "cursor_…").slice(0, 300);
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

export async function runReviewPanel(
  ws: WebSocket,
  conn: Conn,
  slot: Slot,
  panel: ReviewBinding[],
  userText: string,
  cwd: string,
  apiKey: string,
  epoch: number,
): Promise<string> {
  const sandbox = sandboxEnabledForTenant(conn.tenant);
  const source = userText.length > 24_000 ? `${userText.slice(0, 24_000)}\n…（原文过长，已截断）` : userText;
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
      if (slot.epoch !== epoch) return;
      noteToolCall(slot.tenantId);
      if (status === "completed") noteOutput(slot.tenantId, result.length);
      noteRun(slot.tenantId, Date.now() - started);
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
    try {
      const result = await Promise.race([
        Agent.prompt(
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
          setTimeout(() => reject(new Error("评审超时")), 4 * 60_000);
        }),
      ]);
      if (slot.finished || slot.epoch !== epoch) return null;
      const text = (result.result || "").trim() || result.error?.message || "没有返回正文";
      const ok = result.status === "finished" && Boolean(result.result?.trim());
      finish(ok ? "completed" : "error", text);
      return { name: row.name, modelId: row.modelId, ok, text };
    } catch (err) {
      if (slot.finished || slot.epoch !== epoch) return null;
      const text = clipReviewError(err);
      finish("error", text);
      return { name: row.name, modelId: row.modelId, ok: false, text };
    }
  });
  const rows = (await Promise.all(jobs)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  return reviewsForLead(rows);
}
