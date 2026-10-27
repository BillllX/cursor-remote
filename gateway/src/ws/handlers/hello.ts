// 登录：校验口令、绑定租户、下发 ready 与当前状态（鉴权之前唯一可用的业务消息）
import { resolve } from "node:path";
import { defaultPolicy } from "../../../../shared/policy.ts";
import { hasAuth, resolveTenant } from "../../tenants.ts";
import { usageRec } from "../../usage.ts";
import { externalModelIds } from "../../providers.ts";
import { loopsForTenant } from "../../loops.ts";
import { assistantName, closeMemoryWatcher, onTenantHello } from "../../assistant/service.ts";
import { gatewayEnv } from "../../config.ts";
import { log } from "../../log.ts";
import { loginBlocked, noteLoginFail, noteLoginOk } from "../../auth/login.ts";
import { assistantChatIdOf } from "../../runtime/chats.ts";
import {
  attachLiveSlots,
  bindTenant,
  detachConn,
  hydrateConn,
  queuedChatIds,
  runningChatIds,
} from "../../runtime/slots.ts";
import { emitStoredState, ensureAssistantChat } from "../../sync/storedState.ts";
import { emitRunSnapshots } from "../../sync/transcript.ts";
import { sendCheckpoints } from "../../workspace/checkpoints.ts";
import { emitWorkspaces } from "../../workspace/workspaces.ts";
import { workspaceAgentsMessage } from "../../workspace/agents.ts";
import { send } from "../send.ts";
import { cachedModels, listModels } from "../../chat/models.ts";
import type { MessageOf, WsConnCtx } from "./types.ts";
import { deviceRegistry } from "../../device/registry.ts";

export function onHello({ ws, conn, state }: WsConnCtx, message: MessageOf<"hello">) {
  // 同一 socket 可以再次 hello；无论新鉴权是否成功，都先摘掉所有旧租户 memory 订阅。
  closeMemoryWatcher(ws);
  if (loginBlocked(conn.ip, state.loginHits)) {
    send(ws, { type: "auth", ok: false, message: "试太多次了，过几分钟再试。" });
    return;
  }
  if (!hasAuth()) {
    send(ws, {
      type: "auth",
      ok: false,
      message: "还没设登录密码。写入 tenants.json 或 CURSOR_REMOTE_TOKEN 后重启 gateway。",
    });
    return;
  }
  const tenant = resolveTenant(message.token || "");
  if (!tenant) {
    noteLoginFail(conn.ip, state.loginHits);
    send(ws, { type: "auth", ok: false, message: "密码不对。" });
    return;
  }
  noteLoginOk(conn.ip, state.loginHits);
  if (conn.authed) {
    deviceRegistry.close(conn);
    detachConn(conn);
  }
  // 客户端声明的单条消息接收上限（iOS URLSessionWebSocketTask 约 1MiB）；0 = 不限
  const declared = Number(message.client?.maxMessageBytes) || 0;
  conn.maxMessageBytes = declared > 0 ? Math.min(declared, 8 * 1024 * 1024) : 0;
  conn.caps = new Set(
    Array.isArray(message.client?.caps)
      ? message.client.caps.filter((item): item is string => typeof item === "string")
      : [],
  );
  conn.deviceId =
    typeof message.client?.deviceId === "string" && message.client.deviceId.length <= 256
      ? message.client.deviceId
      : undefined;
  conn.imForeground = conn.caps.has("im") ? true : undefined;
  bindTenant(conn, tenant);
  usageRec(tenant.id); // P9：建行 + touch lastActiveAt（登录即活动）
  const apiKey = gatewayEnv.cursorApiKey();
  hydrateConn(conn);
  attachLiveSlots(conn);
  const cached = cachedModels();
  const emitReady = (models: string[]) => {
    send(ws, {
      type: "ready",
      cwd: conn.cwd,
      hasApiKey: Boolean(apiKey),
      model: conn.model,
      models: [...models, ...externalModelIds()], // P11：第三方模型（provider:model）合并下发
      agentId: null,
      runningChatIds: runningChatIds(tenant),
      queuedChatIds: queuedChatIds(tenant),
      workspaceRoot: resolve(tenant.workspaceRoot),
      tenantId: tenant.id,
      tenantName: tenant.name,
      admin: tenant.admin,
      policy: conn.policy || defaultPolicy(),
      loops: loopsForTenant(tenant.id),
      assistantName: assistantName(tenant),
      assistantChatId: assistantChatIdOf(tenant),
      features: [
        "turn_files",
        "read_sha",
        "read_req_id",
        "seg_hashes",
        "tool_at",
        "slim_chats",
        "im",
        "im_group",
        "im_collab",
        "workspace_agents",
        "workspace_agent_viewing",
        "file_changed",
        "mobile_compact_v1",
        "canvas_versions",
        "device_bridge_v1",
      ],
    });
  };
  try {
    ensureAssistantChat(tenant);
    onTenantHello(tenant);
  } catch (err) {
    log.error("assistant hello", err);
  }
  emitReady(cached);
  emitStoredState(ws, tenant);
  emitWorkspaces(ws, tenant);
  send(ws, workspaceAgentsMessage(tenant));
  for (const chatId of runningChatIds(tenant)) {
    send(ws, { type: "status", chatId, status: "RUNNING" });
  }
  for (const slot of conn.slots.values()) {
    if (slot.checkpoints.length) sendCheckpoints(ws, slot);
  }
  emitRunSnapshots(ws, tenant);
  if (apiKey) {
    void listModels(apiKey).then((models) => {
      if (models.join("\n") !== cached.join("\n")) emitReady(models);
    });
  }
}
