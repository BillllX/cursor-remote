// 确保会话槽位上有可用的 Cursor agent（新建/恢复/换模型）
import { Agent } from "@cursor/sdk";
import { buildCrewAgents, pickReviewPanel, type ReviewBinding } from "../../../shared/crew.ts";
import { dialectOverlay } from "../../../shared/dialect.ts";
import { foregroundTools, workspaceToolsFor } from "../assistant/service.ts";
import { gatewayEnv } from "../config.ts";
import { slotLog } from "../log.ts";
import { isAssistantChat } from "../runtime/chats.ts";
import { defaultModel } from "../runtime/env.ts";
import { cwdOf, disposeSlot, persistConn } from "../runtime/slots.ts";
import type { AgentHandle, Conn, Slot } from "../runtime/types.ts";
import { sandboxEnabledForTenant, workspaceFenceForTenant } from "../tenants.ts";
import { diskChatTurns } from "./history.ts";
import { isModelHealthy, recordModelFailure } from "./modelHealth.ts";
import { listModels } from "./models.ts";

function isAgentMissing(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === "agent_not_found") return true;
  const text = [rec.message, err instanceof Error ? err.message : ""].filter(Boolean).join(" ");
  return /agent[-_ ].*not found/i.test(text) || /agent_not_found/i.test(text);
}

export async function ensureAgent(conn: Conn, slot: Slot): Promise<AgentHandle> {
  const apiKey = gatewayEnv.cursorApiKey();
  if (!apiKey) {
    throw new Error("服务器未配置 CURSOR_API_KEY。写入环境或 .env 后重启 gateway。");
  }
  const cwd = cwdOf(conn, slot);
  if (slot.agent) return slot.agent;

  const modelId = (slot.model || conn.model || defaultModel()).trim() || defaultModel();
  const catalog = await listModels(apiKey);
  const sandbox = sandboxEnabledForTenant(conn.tenant);
  const local: {
    cwd: string;
    sandboxOptions?: { enabled: boolean };
    customTools?: ReturnType<typeof foregroundTools>;
  } = {
    cwd,
    sandboxOptions: { enabled: sandbox },
  };
  // 助理工具只挂在唯一的助理会话上；其他会话没有个人记忆工具，只能提议写工作区记忆。
  // Ask / Plan 只读模式下传入 readonly: true，直接从 SDK customTools 层面剥离写操作与技能上架工具。
  const readonlyMode = slot.mode === "ask" || slot.mode === "plan";
  if (conn.tenant && isAssistantChat(conn.tenant, slot.chatId)) {
    local.customTools = foregroundTools(conn.tenant, slot.chatId, { readonly: readonlyMode });
  } else if (conn.tenant) {
    local.customTools = workspaceToolsFor(conn.tenant, slot.chatId, cwd, { readonly: readonlyMode });
  }
  const base = { apiKey, model: { id: modelId }, local };
  const overlay = slot.dialect === false ? undefined : dialectOverlay;
  const panel = [...(slot.reviewRoster ?? pickReviewPanel(modelId, catalog, { isHealthy: isModelHealthy }))];

  const open = async (next: ReviewBinding[] | null, resumeId: string | null) => {
    const opts = next
      ? { ...base, agents: buildCrewAgents(modelId, catalog, cwd, overlay, next, workspaceFenceForTenant(conn.tenant)) }
      : base;
    if (resumeId) return Agent.resume(resumeId, opts);
    return Agent.create(opts);
  };

  // 某个评审模型被拒时登记熔断并丢掉这一个再试，保留 explore / builder 和其余评审。
  // Agent.resume 会不会吃进新的 agents 没有类型保证，名单变化时上层会另开 agent。
  const openWithCrewFallback = async (resumeId: string | null) => {
    let next = panel;
    let bare = false;
    while (true) {
      try {
        return await open(bare ? null : next, resumeId);
      } catch (err) {
        if (isAgentMissing(err)) throw err;
        if (bare) throw err;
        if (next.length) {
          const dropped = next[next.length - 1];
          recordModelFailure(dropped.modelId, err);
          slotLog(slot).error("drop reviewer after crew reject", dropped.modelId, err);
          next = next.slice(0, -1);
          continue;
        }
        slotLog(slot).error("crew agents rejected, retrying without them", err);
        bare = true;
      }
    }
  };

  const resumeId = slot.agentId;
  try {
    slot.agent = await openWithCrewFallback(resumeId);
  } catch (err) {
    if (!resumeId || !isAgentMissing(err)) throw err;
    slotLog(slot).warn("agent missing, opening a new one", { agentId: resumeId });
    await disposeSlot(slot);
    slot.agentId = null;
    slot.reseed = true;
    slot.agent = await openWithCrewFallback(null);
  }
  if (!resumeId && diskChatTurns(conn.tenant, slot.chatId).length) slot.reseed = true;
  slot.agentId = slot.agent.agentId;
  persistConn(conn);
  return slot.agent;
}
