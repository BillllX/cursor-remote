import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createServer,
  type IncomingMessage,
} from "node:http";
import { Agent, CursorAgentError } from "@cursor/sdk";
import { WebSocketServer } from "ws";
import { slimChat } from "./chatBodies.ts";
import {
  defaultPolicy,
  parsePolicy,
} from "../../shared/policy.ts";
import {
  allTenants,
  confinedCwd,
  getTenant,
  hasAuth,
  loadTenants,
  resolveTenant,
  sandboxEnabledForTenant,
  saveDiskNow,
  settlePersistedChats,
  stateDir,
} from "./tenants.ts";
import { cursorBill } from "./cursorBill.ts";
import {
  noteTurn,
  usageRec,
  usageSnapshot,
} from "./usage.ts";
import {
  readRunMark,
} from "./runlog.ts";
import {
  readSnapshotDiff,
  readSnapshotFile,
} from "./turnFiles.ts";
import {
  externalModelIds,
} from "./providers.ts";
import { deleteSession } from "./native/session.ts";
import { bindLoops, loopsForTenant, startLoop, stopLoop } from "./loops.ts";
import { bindBackground } from "./assistant/background.ts";
import {
  assistantName,
  buildState,
  handleOp,
  onTenantHello,
  publishState,
  startAssistant,
  watchMemory,
  calendarFeed,
  parseClientClock,
} from "./assistant/service.ts";
import { createPublishController } from "./publish.ts";
import { gatewayEnv, loadDotEnv } from "./config.ts";
import { log } from "./log.ts";
import { loginBlocked, noteLoginFail, noteLoginOk, peerIp } from "./auth/login.ts";
import { agentSocketPath, handleMedia, handleState, handleUpload } from "./http/routes.ts";
import { cancelRun, isAbortError } from "./runtime/abort.ts";
import { resolveApprovalWait } from "./runtime/approvals.ts";
import { assistantChatIdOf, chatIdOf, isAssistantChat } from "./runtime/chats.ts";
import { attachLiveSlots, bindTenant, chatIdsFrom, cwdOf, detachConn, diskSlot, disposeSlot, hydrateConn, lockedChatCwd, persistConn, pruneDroppedSlots, queuedChatIds, runningChatIds, slotOf } from "./runtime/slots.ts";
import { conns, liveSlotsOf } from "./runtime/state.ts";
import type { Conn, WorkspaceFile } from "./runtime/types.ts";
import { broadcastDigest, compactTenantChats, effectiveChatRevs, emitStateSync, emitStoredState, ensureAssistantChat, MAX_STORED_CHATS, mergeAndCompactChat, omitClientDraft, pruneChatRevs, stableStringify, tombstoneChat } from "./sync/storedState.ts";
import { emitRunSnapshots, protectChatUpload, stopRunFlush } from "./sync/transcript.ts";
import { noteNativeRestore, restoreCheckpoint, sendCheckpoints, undoEdits } from "./workspace/checkpoints.ts";
import { filesMessage, listWorkspaceFilesForClient, MAX_UPLOAD_BYTES, payload, pushWorkspace, readWorkspaceDiff, readWorkspaceFile, revertHunk, runFsOp, searchWorkspace, uniqueUploadPath, workspacePath, writeWorkspaceBytes, writeWorkspaceFile } from "./workspace/files.ts";
import { deleteWorkspace, emitWorkspaces, ensureWorkspaceDir, readHiddenWorkspaces, renameWorkspace, sanitizeWorkspaceName, writeHiddenWorkspaces } from "./workspace/workspaces.ts";
import { clipTurnForPage, reply } from "./ws/frame.ts";
import { parseClient } from "./ws/parse.ts";
import { send } from "./ws/send.ts";
import { answerDelegationApproval, cancelDelegation, delegationWorkspaces, requestWorkspace, startDelegation } from "./bindings/delegations.ts";
import { dispatchLoop, loopBusy, publishLoop } from "./bindings/loops.ts";
import { finishRun } from "./chat/finish.ts";
import { forgetChat } from "./chat/forget.ts";
import { sendAgentHistory } from "./chat/history.ts";
import { listModels, modelsCache } from "./chat/models.ts";
import { handlePrompt } from "./chat/runner.ts";
import { titleChat } from "./chat/title.ts";
import { healthPayload } from "./http/health.ts";
import { proxyUpgrade, proxyWeb } from "./http/proxy.ts";
import { defaultModel, gatewayHost, webUrl } from "./runtime/env.ts";

loadDotEnv([
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
]);

const PORT = gatewayEnv.gatewayPort();
// runtime/env.ts 的缓存函数在原来的时机先求值一次（非法值仍在启动这里抛错）
gatewayHost();
webUrl();
const PROXY_WEB = gatewayEnv.proxyWeb();
defaultModel();

loadTenants();
for (const tenant of allTenants()) {
  if (!sandboxEnabledForTenant(tenant)) {
    log.warn(`租户 ${tenant.name}（${tenant.id}）不启用沙箱。`);
  }
  if (compactTenantChats(tenant)) {
    saveDiskNow(tenant);
    log.info(`已截断过长的工具记录 ${tenant.name}（${tenant.id}）`);
  }
}

const publish = createPublishController({
  tenants: () =>
    allTenants().map((tenant) => ({
      id: tenant.id,
      workspaceRoot: tenant.workspaceRoot,
      stateDir: tenant.stateDir,
      name: tenant.name,
    })),
});

process.on("unhandledRejection", (err) => {
  if (isAbortError(err)) return;
  log.error(err);
});
process.on("uncaughtException", (err) => {
  if (isAbortError(err)) return;
  const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
  // 超长帧会关掉那一条连接。不能因此退出进程，否则 systemd 重启后客户端立刻重发，变成连上就断。
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    log.error("websocket payload too large");
    return;
  }
  log.error(err);
  process.exit(1);
});

const httpServer = createServer((req, res) => {
  if (publish.handleHttp(req, res)) return;
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    const body = healthPayload();
    res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/cal/")) {
    // 口令就是凭证，出错也不往日志里写路径
    const token = url.pathname.slice("/media/cal/".length).replace(/\.ics$/, "");
    let body: string | null = null;
    try {
      body = calendarFeed(allTenants(), token);
    } catch (err) {
      log.error("calendar feed", err instanceof Error ? err.message : err);
    }
    if (body === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": 'inline; filename="todos.ics"',
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/media") {
    try {
      handleMedia(req, res, url);
    } catch (err) {
      log.error("media", err instanceof Error ? err.message : err);
      if (!res.headersSent) res.writeHead(500).end("media failed");
      else res.destroy();
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/state") {
    handleState(req, res);
    return;
  }
  if (url.pathname === "/upload") {
    void handleUpload(req, res, url).catch((err) => {
      log.error("upload", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "上传失败" }));
      }
    });
    return;
  }
  if (!PROXY_WEB) {
    res.writeHead(404).end("not found");
    return;
  }
  proxyWeb(req, res);
});

// perMessageDeflate：WS 帧压缩（JSON 文本 10-20x），浏览器/ws 自动协商；
// 不支持扩展的客户端（iOS URLSessionWebSocketTask 不协商扩展）会优雅回落为不压缩。
// 注意：ws 的 threshold 只在关闭 context takeover 时生效； takeover 还会让每连接常驻 zlib 窗口，一并关掉。
const wss = new WebSocketServer({
  noServer: true,
  // 单条会话会带上完整工具记录。cursorremote 一条对话已经超过 40MB，16MB 上限会把网关打崩。
  maxPayload: 96 * 1024 * 1024,
  perMessageDeflate: {
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024,
  },
});

httpServer.on("upgrade", (req, socket, head) => {
  if (publish.handleUpgrade(req, socket, head)) return;
  if (agentSocketPath(req.url)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }
  if (!PROXY_WEB) {
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head);
});

wss.on("connection", (ws, req: IncomingMessage) => {
  const conn: Conn = {
    cwd: "",
    model: defaultModel(),
    authed: false,
    ip: peerIp(req),
    tenant: null,
    slots: new Map(),
    ws,
    maxMessageBytes: 0,
    caps: new Set(),
    policy: defaultPolicy(),
  };
  conns.set(ws, conn);

  ws.on("error", (err) => {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : "";
    log.error("ws error", code || (err instanceof Error ? err.message : err));
  });

  ws.on("message", async (data) => {
    const message = parseClient(String(data));
    if (!message) return;

    try {
      if (message.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (message.type === "hello") {
        if (loginBlocked(conn.ip)) {
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
          noteLoginFail(conn.ip);
          send(ws, { type: "auth", ok: false, message: "密码不对。" });
          return;
        }
        noteLoginOk(conn.ip);
        if (conn.authed) detachConn(conn);
        // 客户端声明的单条消息接收上限（iOS URLSessionWebSocketTask 约 1MiB）；0 = 不限
        const declared = Number(message.client?.maxMessageBytes) || 0;
        conn.maxMessageBytes = declared > 0 ? Math.min(declared, 8 * 1024 * 1024) : 0;
        conn.caps = new Set(
          Array.isArray(message.client?.caps)
            ? message.client.caps.filter((item): item is string => typeof item === "string")
            : [],
        );
        bindTenant(conn, tenant);
        usageRec(tenant.id); // P9：建行 + touch lastActiveAt（登录即活动）
        const apiKey = gatewayEnv.cursorApiKey();
        hydrateConn(conn);
        attachLiveSlots(conn);
        const cached = modelsCache?.ids?.length ? modelsCache.ids : [defaultModel()];
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
            features: ["turn_files", "read_sha", "read_req_id", "seg_hashes", "tool_at", "slim_chats"],
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
        return;
      }

      if (!conn.authed || !conn.tenant) {
        send(ws, { type: "error", message: "先发 hello。" });
        return;
      }
      const tenant = conn.tenant;

      if (message.type === "assistant_get") {
        if (message.memory) watchMemory(tenant.id, true);
        send(ws, { type: "assistant_state", state: await buildState(tenant, { memory: Boolean(message.memory) }) });
        return;
      }

      if (message.type === "assistant_op") {
        const args = message.args && typeof message.args === "object" ? message.args : {};
        const result =
          message.op === "approval_answer"
            ? answerDelegationApproval(tenant, args)
            : message.op === "delegation_cancel"
              ? await cancelDelegation(ws, tenant, args)
              : await handleOp(tenant, message.op, args);
        send(ws, { type: "assistant_result", reqId: message.reqId, op: message.op, ...result });
        if (result.ok) void publishState(tenant);
        return;
      }

      if (message.type === "loop_start") {
        const result = startLoop({
          tenantId: tenant.id,
          chatId: message.chatId,
          goal: message.goal,
          intervalSec: message.intervalSec,
          maxTicks: message.maxTicks,
          model: message.model,
          mode: message.mode,
        });
        if ("error" in result) {
          send(ws, { type: "error", chatId: message.chatId, message: result.error });
          return;
        }
        publishLoop(tenant.id, { type: "loop_state", ...result.state });
        return;
      }

      if (message.type === "loop_stop") {
        const state = stopLoop(tenant.id, message.chatId);
        publishLoop(tenant.id, {
          type: "loop_state",
          chatId: message.chatId,
          status: "stopped",
          goal: state?.goal ?? "",
          intervalSec: state?.intervalSec ?? 0,
          tick: state?.tick ?? 0,
          maxTicks: state?.maxTicks,
          lastSummary: state?.lastSummary ?? "没有在跑的 Loop。",
        });
        return;
      }

      // P9：管理员查询全租户使用统计。租户行是网关自计量；
      // cursor 是当前 CURSOR_API_KEY 的官方账单（与 CLI /usage 同一接口）。
      if (message.type === "admin_stats") {
        if (!tenant.admin) {
          send(ws, { type: "error", message: "需要管理员权限。" });
          return;
        }
        const rows = allTenants().map((item) => {
          const usage = usageSnapshot(item.id);
          const online = [...conns.values()].filter(
            (other) => other.authed && other.tenant?.id === item.id,
          ).length;
          return {
            id: item.id,
            name: item.name,
            admin: item.admin,
            online,
            chats: item.disk.chats.length,
            turns: usage.turns,
            runs: usage.runs,
            toolCalls: usage.toolCalls,
            runMs: usage.runMs,
            inChars: usage.inChars,
            outChars: usage.outChars,
            estTokens: Math.round((usage.inChars + usage.outChars) / 4),
            modelInTokens: usage.modelInTokens,
            modelOutTokens: usage.modelOutTokens,
            modelCacheTokens: usage.modelCacheTokens,
            firstSeenAt: usage.firstSeenAt,
            lastActiveAt: usage.lastActiveAt,
          };
        });
        const cursor = await cursorBill(gatewayEnv.cursorApiKey());
        send(ws, { type: "admin_stats", serverTime: Date.now(), tenants: rows, cursor });
        return;
      }

      if (message.type === "sync_state") {
        const clientRev = typeof message.rev === "number" ? message.rev : 0;
        if (clientRev < tenant.disk.rev) {
          emitStateSync(ws, tenant);
          return;
        }
        const prevCwd = new Map<string, string>();
        const prevJson = new Map<string, string>();
        const prevIds = chatIdsFrom(tenant.disk.chats);
        for (const item of tenant.disk.chats) {
          if (!item || typeof item !== "object") continue;
          const row = item as { id?: unknown; cwd?: unknown };
          if (typeof row.id === "string" && row.id) {
            if (typeof row.cwd === "string" && row.cwd) prevCwd.set(row.id, row.cwd);
            prevJson.set(row.id, stableStringify(item));
          }
        }
        // 助理会话不占 MAX_STORED_CHATS 名额；客户端漏带时用服务端那份，不能被墓碑化
        const assistantId = assistantChatIdOf(tenant);
        const uploaded: unknown[] = Array.isArray(message.chats) ? message.chats : [];
        const assistantRow =
          uploaded.find((item) => chatIdOf(item) === assistantId) ??
          tenant.disk.chats.find((item) => chatIdOf(item) === assistantId);
        const incoming = uploaded.filter((item) => chatIdOf(item) !== assistantId).slice(0, MAX_STORED_CHATS);
        if (assistantRow) incoming.unshift(assistantRow);
        const incomingIds = chatIdsFrom(incoming);
        for (const id of prevIds) {
          if (!incomingIds.has(id)) tombstoneChat(tenant, id);
        }
        const gone = new Set(tenant.disk.deletedIds);
        tenant.disk.chats = incoming
          .filter((item) => {
            const id = chatIdOf(item);
            return !id || !gone.has(id);
          })
          .map((raw) => {
            if (!raw || typeof raw !== "object") return raw;
            const item = omitClientDraft(raw);
            const row = item as { id?: unknown; cwd?: unknown };
            const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
            const id = typeof row.id === "string" ? row.id : "";
            const next =
              (id ? lockedChatCwd(tenant, id) : null) ||
              wanted ||
              (id ? confinedCwd(prevCwd.get(id), tenant.workspaceRoot) : null) ||
              tenant.workspaceRoot;
            const withCwd = row.cwd === next ? item : { ...row, cwd: next };
            const prevChat = id ? tenant.disk.chats.find((row) => chatIdOf(row) === id) : undefined;
            const merged = mergeAndCompactChat(prevChat, withCwd);
            const provided = Boolean(item && typeof item === "object" && Array.isArray((item as { turns?: unknown }).turns));
            // protect 可能因助手文本更长而留用磁盘上的旧工具列表，截断必须发生在那之后
            const uploaded = protectChatUpload(tenant, id, merged, provided);
            return mergeAndCompactChat(prevChat, uploaded);
          });
        tenant.disk.rev = clientRev;
        // P4c：按会话变更检测（规范化序列化，键序无关），只给真正变了的会话记新版本号
        for (const item of tenant.disk.chats) {
          const id = chatIdOf(item);
          if (!id) continue;
          if (prevJson.get(id) !== stableStringify(item)) {
            tenant.disk.chatRevs[id] = clientRev;
          }
        }
        pruneChatRevs(tenant);
        pruneDroppedSlots(tenant, chatIdsFrom(tenant.disk.chats));
        persistConn(conn);
        send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: effectiveChatRevs(tenant), keptBodies: true });
        broadcastDigest(tenant, ws); // 多设备实时对账
        return;
      }

      // 保留/还原只改标记。同时把磁盘上过长的工具正文截掉，打开着的标签不重载。
      if (message.type === "tool_review") {
        const chatId = typeof message.chatId === "string" ? message.chatId : "";
        const turnId = typeof message.turnId === "string" ? message.turnId : "";
        const reviews = Array.isArray(message.reviews) ? message.reviews : [];
        const ackRev = () => {
          send(ws, {
            type: "sync_ack",
            rev: tenant.disk.rev,
            chatRevs: chatId ? { [chatId]: tenant.disk.chatRevs[chatId] ?? tenant.disk.rev } : {},
            reviewOnly: true,
          });
        };
        if (!chatId || !turnId || tenant.disk.deletedIds.includes(chatId)) {
          ackRev();
          return;
        }
        const prev = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
        if (!prev || typeof prev !== "object") {
          ackRev();
          return;
        }
        const want = new Map<string, "accepted" | "rejected">();
        for (const item of reviews) {
          if (!item || typeof item !== "object") continue;
          const callId = (item as { callId?: unknown }).callId;
          const review = (item as { review?: unknown }).review;
          if (typeof callId !== "string" || !callId) continue;
          if (review !== "accepted" && review !== "rejected") continue;
          want.set(callId, review);
        }
        let applied = false;
        const stamped = { ...(prev as Record<string, unknown>) };
        if (Array.isArray(stamped.turns)) {
          stamped.turns = stamped.turns.map((turn) => {
            if (!turn || typeof turn !== "object" || (turn as { id?: unknown }).id !== turnId) return turn;
            if (!Array.isArray((turn as { tools?: unknown }).tools)) return turn;
            const tools = (turn as { tools: unknown[] }).tools.map((tool) => {
              if (!tool || typeof tool !== "object") return tool;
              const callId = (tool as { callId?: unknown }).callId;
              if (typeof callId !== "string" || !want.has(callId)) return tool;
              const review = want.get(callId);
              if ((tool as { review?: unknown }).review === review) return tool;
              applied = true;
              return { ...(tool as Record<string, unknown>), review };
            });
            return { ...(turn as Record<string, unknown>), tools };
          });
        }
        const hit = { n: 0 };
        const compacted = mergeAndCompactChat(prev, stamped, hit);
        if (applied || hit.n > 0) {
          tenant.disk.rev += 1;
          tenant.disk.chatRevs[chatId] = tenant.disk.rev;
          tenant.disk.chats = tenant.disk.chats.map((item) => (chatIdOf(item) === chatId ? compacted : item));
          persistConn(conn);
          broadcastDigest(tenant, ws);
        }
        ackRev();
        return;
      }

      if (message.type === "load_state") {
        emitStoredState(ws, tenant);
        return;
      }

      // 编辑、重试：截掉 turnId 及之后的回合
      if (message.type === "truncate_turns") {
        const id = typeof message.chatId === "string" ? message.chatId : "";
        const turnId = typeof message.turnId === "string" ? message.turnId : "";
        if (!id || !turnId) return;
        // 截断只动这一条会话、可重放，不做 rev 拒绝；rev 落后时接着服务端往前走
        const clientRev = typeof message.rev === "number" ? message.rev : 0;
        const nextRev = Math.max(clientRev, tenant.disk.rev + 1);
        const prev = tenant.disk.deletedIds.includes(id)
          ? undefined
          : tenant.disk.chats.find((item) => chatIdOf(item) === id);
        // 没截成（找不到回合或正在跑）：truncated: false，客户端重拉正文
        const ackCurrent = () =>
          send(ws, {
            type: "sync_ack",
            rev: tenant.disk.rev,
            chatRevs: prev ? { [id]: tenant.disk.chatRevs[id] ?? 0 } : {},
            truncated: false,
          });
        if (!prev || typeof prev !== "object") {
          ackCurrent();
          return;
        }
        const slot = liveSlotsOf(tenant).get(id);
        if (runningChatIds(tenant).includes(id) || slot?.transcript?.phase === "running") {
          ackCurrent();
          return;
        }
        const row = prev as Record<string, unknown>;
        const turns = Array.isArray(row.turns) ? row.turns : [];
        const index = turns.findIndex(
          (turn) => Boolean(turn) && typeof turn === "object" && (turn as { id?: unknown }).id === turnId,
        );
        if (index < 0) {
          ackCurrent();
          return;
        }
        const removed = new Set(
          turns
            .slice(index)
            .map((turn) => (turn && typeof turn === "object" ? (turn as { id?: unknown }).id : null))
            .filter((item): item is string => typeof item === "string" && Boolean(item)),
        );
        const next: Record<string, unknown> = { ...row, turns: turns.slice(0, index) };
        const mark = readRunMark(prev);
        if (mark && removed.has(mark.turnId)) delete next.runMark;
        // 否则 protectChatUpload / flushTranscript 会把删掉的回合按转录补回来
        if (slot?.transcript && removed.has(slot.transcript.turnId)) {
          stopRunFlush(slot);
          slot.transcript = undefined;
        }
        tenant.disk.rev = nextRev;
        tenant.disk.chatRevs[id] = nextRev;
        tenant.disk.chats = tenant.disk.chats.map((item) => (item === prev ? next : item));
        persistConn(conn);
        send(ws, { type: "sync_ack", rev: nextRev, chatRevs: { [id]: nextRev }, truncated: true });
        broadcastDigest(tenant, ws);
        return;
      }

      // P4b：单会话增量上传——只替换/追加这一条，不做 tombstone（结构变化仍走 sync_state）
      if (message.type === "sync_chat") {
        const clientRev = typeof message.rev === "number" ? message.rev : 0;
        if (clientRev < tenant.disk.rev) {
          emitStateSync(ws, tenant);
          return;
        }
        const id = chatIdOf(message.chat);
        if (!id) return;
        if (tenant.disk.deletedIds.includes(id)) {
          // 已删除的会话不接受内容更新；ack 带上该 id 让客户端收敛 inflight（空表会泄漏）
          send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
          return;
        }
        const prev = tenant.disk.chats.find((item) => chatIdOf(item) === id);
        // cwd 限定：与 sync_state 同一套（新值优先，其次旧值，最后租户根）
        let next = message.chat;
        if (next && typeof next === "object") {
          const row = next as { cwd?: unknown };
          const prevRow = prev && typeof prev === "object" ? (prev as { cwd?: unknown }) : {};
          const wanted = typeof row.cwd === "string" ? confinedCwd(row.cwd, tenant.workspaceRoot) : null;
          const fallback = typeof prevRow.cwd === "string" ? confinedCwd(prevRow.cwd, tenant.workspaceRoot) : null;
          const cwd = lockedChatCwd(tenant, id) || wanted || fallback || tenant.workspaceRoot;
          if (row.cwd !== cwd) next = { ...next, cwd };
        }
        // P8 slim 合并：incoming 没有 turns 键 = 元数据更新，保留服务端 turns
        //（键缺失 ≠ 清空，空数组才是清空；web 永远带 turns 走全量替换，不受影响）。
        // incoming 带 turns 时，clipped 标记的 turn 是 load_chat 分页的截断展示副本——
        // 按 id 回退服务端完整版，截断内容不允许回写落盘
        if (next && typeof next === "object") {
          const row = next as Record<string, unknown>;
          const prevTurns = prev && typeof prev === "object" ? (prev as { turns?: unknown }).turns : undefined;
          if (Array.isArray(prevTurns)) {
            if (!("turns" in row)) {
              next = { ...row, turns: prevTurns };
            } else if (Array.isArray(row.turns)) {
              const fullById = new Map(
                prevTurns.map((t) => [t && typeof t === "object" ? (t as { id?: unknown }).id : null, t]),
              );
              next = {
                ...row,
                turns: row.turns.flatMap((t) => {
                  if (!t || typeof t !== "object" || (t as { clipped?: unknown }).clipped !== true) return [t];
                  // 残片按 id 回退服务端完整版；id 对不上（服务端没有）则丢弃——
                  // 保留残片会把截断占位内容永久落盘（GLM 评审 M1）
                  const full = fullById.get((t as { id?: unknown }).id);
                  return full ? [full] : [];
                }),
              };
            }
          } else if (!("turns" in row)) {
            // 新会话且缺 turns 键：补空数组——磁盘 chat 永远带 turns 键，
            // web 端 chat.turns.map 不踩空（Kimi 设计评审 MINOR10）
            next = { ...row, turns: [] };
          }
        }
        next = mergeAndCompactChat(prev, omitClientDraft(next));
        const turnsProvided = Boolean(
          message.chat &&
            typeof message.chat === "object" &&
            Array.isArray((message.chat as { turns?: unknown }).turns),
        );
        next = protectChatUpload(tenant, id, next, turnsProvided);
        next = mergeAndCompactChat(prev, next);
        const changed = stableStringify(prev ?? null) !== stableStringify(next);
        const stored = tenant.disk.chats.filter((item) => !isAssistantChat(tenant, chatIdOf(item))).length;
        if (changed && !prev && !isAssistantChat(tenant, id) && stored >= MAX_STORED_CHATS) {
          // 条数硬顶：追加新会话被拒（替换既有会话不受限），回 ack 让客户端收敛 inflight
          log.warn("sync_chat 拒绝：会话数超上限", tenant.id, MAX_STORED_CHATS);
          send(ws, { type: "sync_ack", rev: tenant.disk.rev, chatRevs: { [id]: clientRev } });
          return;
        }
        // 先写 rev 再落盘（P4 审核：崩溃窗口不能出现「新内容旧 rev」）。
        // 无变化的重推不动全局 rev：否则其他设备的下一次推送会因 rev 落后被拒，白白多一轮对账。
        // chatRevs[id] 同样只在内容真变时前进（P8 审核：无变化 sync 也 bump 的话，其他端重连时
        // 会把纯元数据/未读类本地脏误判成正文变更，整会话作废重载）
        if (changed) {
          tenant.disk.rev = clientRev;
          tenant.disk.chatRevs[id] = clientRev;
          tenant.disk.chats = prev
            ? tenant.disk.chats.map((item) => (chatIdOf(item) === id ? next : item))
            : [...tenant.disk.chats, next];
        }
        persistConn(conn);
        // ack 回报服务端真实 chatRev（无变化时不前进），客户端对账口径与 digest 一致
        send(ws, {
          type: "sync_ack",
          rev: tenant.disk.rev,
          chatRevs: { [id]: tenant.disk.chatRevs[id] ?? clientRev },
          keptBodies: true,
        });
        if (changed) broadcastDigest(tenant, ws); // 多设备实时对账
        return;
      }

      // P4c：stored_digest 后按需拉取单个会话全量
      if (message.type === "load_chats") {
        const ids = (Array.isArray(message.ids) ? message.ids : [])
          .filter((item): item is string => typeof item === "string" && Boolean(item))
          .slice(0, 200); // 上限防滥用；正常分叉差异只有几条
        const gone = new Set(tenant.disk.deletedIds);
        const connNow = conns.get(ws);
        const limit = connNow?.maxMessageBytes ?? 0;
        // 注意：load_chats 对 slim_state 客户端也回全量——它只服务 digest 差异对账（通常单会话），
        // 是跨设备 turns 更新的唯一通道。带 slim_chats 的客户端按 segHashes 自己走 load_chat 补正文
        const slimRows = connNow?.caps.has("slim_chats") ?? false;
        for (const id of ids) {
          if (gone.has(id)) continue;
          const chat = tenant.disk.chats.find((item) => chatIdOf(item) === id);
          if (!chat) continue;
          const payload = {
            type: "stored_chat" as const,
            chat: slimRows ? slimChat(tenant.bodies, chat) : omitClientDraft(chat),
            rev: tenant.disk.chatRevs[id] ?? 0,
          };
          // 单条同样过接收上限护栏：超限回落 deferred，客户端走 HTTP /state 全量
          if (limit > 0 && Buffer.byteLength(JSON.stringify(payload)) > limit) {
            send(ws, { type: "stored_state_deferred", rev: tenant.disk.rev });
            continue;
          }
          send(ws, payload);
        }
        return;
      }

      // P8：slim 客户端的会话内容分页——from 省略=最后一页，否则返回 turns[..<from] 的上一页。
      // 条数（40）与字节（接收上限 80%）双上限：落盘 turns 没有 history 路径的 80KB clip，
      // 单条巨 turn 也能撑爆 WS 帧，必须按字节组页（评审 GLM m4 / Grok M5）
      if (message.type === "load_chat") {
        const id = typeof message.chatId === "string" ? message.chatId : "";
        // 分页代际 nonce 原样回显（Kimi R2 M1）：客户端降级/重启分页后靠它丢弃旧链迟到页
        const nonce =
          typeof message.nonce === "number" && Number.isFinite(message.nonce) ? message.nonce : undefined;
        const gone = tenant.disk.deletedIds.includes(id);
        const chat = id && !gone ? tenant.disk.chats.find((item) => chatIdOf(item) === id) : null;
        const all =
          chat && typeof chat === "object" && Array.isArray((chat as { turns?: unknown }).turns)
            ? (chat as { turns: unknown[] }).turns
            : [];
        const to =
          typeof message.from === "number" && Number.isFinite(message.from)
            ? Math.max(0, Math.min(Math.floor(message.from), all.length))
            : all.length;
        const declared = conn.maxMessageBytes;
        const budget = declared > 0 ? Math.floor(declared * 0.8) : 800 * 1024;
        const page: unknown[] = [];
        let bytes = 0;
        let from = to;
        while (from > 0 && page.length < 40) {
          let turn = all[from - 1];
          let size = Buffer.byteLength(JSON.stringify(turn));
          if (size > budget) {
            turn = clipTurnForPage(turn, budget);
            size = Buffer.byteLength(JSON.stringify(turn));
          }
          if (bytes + size > budget && page.length > 0) break;
          page.unshift(turn);
          bytes += size;
          from -= 1;
        }
        // 与 stored_state 同口径的 settle：非 live 会话的磁盘 running 残留（崩溃遗留）
        // 不能原样下发，否则 iOS 上永远转圈（Kimi 设计评审 MINOR6）
        const settledPage = runningChatIds(tenant).includes(id)
          ? page
          : (settlePersistedChats([{ turns: page }])[0] as { turns: unknown[] }).turns;
        send(ws, { type: "chat_turns", chatId: id, turns: settledPage, from, hasMore: from > 0, total: all.length, nonce });
        return;
      }

      if (message.type === "write_file") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const written = writeWorkspaceFile(cwd, message.path, message.content);
        send(ws, {
          type: "file_written",
          chatId: message.chatId,
          path: written.path,
          error: written.error,
        });
        return;
      }

      if (message.type === "upload_file") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const raw = typeof message.data === "string" ? message.data : "";
        const b64 = raw.replace(/^data:[^;]+;base64,/, "");
        const fail = (error: string) => {
          send(ws, {
            type: "file_uploaded",
            chatId: message.chatId,
            id: message.id,
            name: message.name,
            path: message.name || "",
            error,
          });
        };
        if (!b64) {
          fail("没有文件内容");
          return;
        }
        let buf: Buffer;
        try {
          buf = Buffer.from(b64, "base64");
        } catch {
          fail("文件解码失败");
          return;
        }
        if (!buf.length) {
          fail("空文件");
          return;
        }
        if (buf.length > MAX_UPLOAD_BYTES) {
          fail("文件超过 32MB");
          return;
        }
        const rel = uniqueUploadPath(cwd, message.name || "file");
        if (!rel) {
          fail("没法在工作区里放下这个文件");
          return;
        }
        const written = writeWorkspaceBytes(cwd, rel, buf);
        send(ws, {
          type: "file_uploaded",
          chatId: message.chatId,
          id: message.id,
          name: message.name,
          path: written.path,
          error: written.error,
          size: written.size,
        });
        if (!written.error && message.chatId) {
          pushWorkspace(ws, slotOf(conn, message.chatId), conn, [written.path]);
        }
        return;
      }

      if (message.type === "fs_op") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const result = runFsOp(cwd, message.op, message.path, message.to);
        send(ws, {
          type: "fs_done",
          chatId: message.chatId,
          op: message.op,
          path: result.path,
          to: result.to,
          error: result.error,
        });
        if (!result.error && message.chatId) {
          pushWorkspace(ws, slotOf(conn, message.chatId), conn, [result.to || result.path]);
        }
        return;
      }

      if (message.type === "list_files") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const listed = listWorkspaceFilesForClient(cwd, message.query || "");
        send(
          ws,
          filesMessage(conn, { chatId: message.chatId, query: message.query || "", mention: Boolean(message.mention) }, listed),
        );
        return;
      }

      if (message.type === "search_text") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        send(ws, {
          type: "search_hits",
          chatId: message.chatId,
          query: message.query,
          hits: searchWorkspace(cwd, message.query),
        });
        return;
      }

      if (message.type === "set_workspace") {
        if (message.chatId && isAssistantChat(tenant, message.chatId)) {
          send(ws, { type: "error", chatId: message.chatId, message: "助理会话固定在 USER 根目录，不能换工作区。" });
          return;
        }
        const next =
          (message.chatId ? lockedChatCwd(tenant, message.chatId) : null) ||
          confinedCwd(message.cwd || conn.cwd, tenant.workspaceRoot);
        if (!next) {
          send(ws, { type: "error", chatId: message.chatId, message: "工作区必须在允许的目录里。" });
          return;
        }
        try {
          ensureWorkspaceDir(next);
        } catch {
          send(ws, { type: "error", chatId: message.chatId, message: "建不了这个工作区目录。" });
          return;
        }
        if (message.chatId) {
          const slot = slotOf(conn, message.chatId);
          if (next !== slot.cwd) {
            slot.cwd = next;
            await disposeSlot(slot);
            slot.agentId = null;
          }
          persistConn(conn);
          send(ws, {
            type: "session",
            chatId: slot.chatId,
            agentId: slot.agentId || "",
            cwd: slot.cwd,
          });
        } else {
          conn.cwd = next;
          send(ws, { type: "session", chatId: "", agentId: "", cwd: conn.cwd });
        }
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "list_workspaces") {
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "create_workspace") {
        const name = sanitizeWorkspaceName(message.name);
        if (!name) {
          send(ws, { type: "error", message: "工作区名字不合法。" });
          return;
        }
        const next = confinedCwd(resolve(tenant.workspaceRoot, name), tenant.workspaceRoot);
        if (!next) {
          send(ws, { type: "error", message: "工作区必须在允许的目录里。" });
          return;
        }
        try {
          if (existsSync(next) && !statSync(next).isDirectory()) {
            send(ws, { type: "error", message: "已经有同名文件。" });
            return;
          }
          ensureWorkspaceDir(next);
        } catch {
          send(ws, { type: "error", message: "建不了这个工作区目录。" });
          return;
        }
        // 之前隐藏过的同名工作区：重新建就是取消隐藏
        const hidden = readHiddenWorkspaces(tenant);
        if (hidden.includes(name)) writeHiddenWorkspaces(tenant, hidden.filter((item) => item !== name));
        send(ws, { type: "workspace_created", path: next, name });
        emitWorkspaces(ws, tenant);
        return;
      }

      if (message.type === "rename_workspace") {
        await renameWorkspace(ws, tenant, conn, String(message.path || ""), String(message.name || ""));
        return;
      }

      if (message.type === "delete_workspace") {
        deleteWorkspace(ws, tenant, conn, String(message.path || ""));
        return;
      }

      if (message.type === "resume_session") {
        const slot = slotOf(conn, message.chatId);
        const stored = slot.agentId || diskSlot(tenant, slot.chatId)?.agentId || "";
        if (message.agentId !== stored) {
          // 宽容化（P7 后）：agentId 陈旧不再报错「不能恢复别人的会话」——resume 只是状态重挂，
          // 客户端拿着旧 agentId（agent 被轮换/多端同步延迟/跨环境残留）需要的是纠正而非拒绝。
          // 回当前真实状态（stored 为空时 agentId:"" → 客户端清掉陈旧值自愈），会话照常可用。
          send(ws, { type: "session", chatId: slot.chatId, agentId: stored, cwd: cwdOf(conn, slot) });
          if (stored) {
            sendCheckpoints(ws, slot);
            void sendAgentHistory(ws, conn, slot);
          }
          return;
        }
        send(ws, {
          type: "session",
          chatId: slot.chatId,
          agentId: slot.agentId || "",
          cwd: cwdOf(conn, slot),
        });
        sendCheckpoints(ws, slot);
        void sendAgentHistory(ws, conn, slot);
        return;
      }

      if (message.type === "delete_session") {
        if (isAssistantChat(tenant, message.chatId)) {
          send(ws, { type: "error", chatId: message.chatId, message: "助理会话不能删除。" });
          emitStoredState(ws, tenant);
          return;
        }
        await forgetChat(conn, message.chatId);
        emitStoredState(ws, tenant);
        return;
      }

      if (message.type === "new_session") {
        const slot = slotOf(conn, message.chatId);
        resolveApprovalWait(slot, false);
        // 过期门+清队列提到 cancelRun 之前：cancel 让出期间旧栈若以旧 epoch 走完
        // finishRun/drain，会把 pending 推进 microtask 拦不住（Grok R3 m2，对齐 forgetChat）
        slot.epoch += 1;
        slot.pending = [];
        await cancelRun(slot.run);
        finishRun(ws, slot, "cancelled");
        await disposeSlot(slot);
        deleteSession(tenant.stateDir, slot.chatId);
        slot.agentId = null;
        slot.edited = [];
        slot.checkpoints = [];
        slot.openTools.clear();
        const next =
          lockedChatCwd(tenant, slot.chatId) ||
          (message.cwd ? confinedCwd(message.cwd, tenant.workspaceRoot) : null);
        if (next) {
          try {
            ensureWorkspaceDir(next);
            slot.cwd = next;
          } catch {
            send(ws, { type: "error", chatId: slot.chatId, message: "建不了这个工作区目录。" });
          }
        }
        persistConn(conn);
        send(ws, { type: "session", chatId: slot.chatId, agentId: "", cwd: cwdOf(conn, slot) });
        send(ws, { type: "status", chatId: slot.chatId, status: "IDLE" });
        sendCheckpoints(ws, slot);
        persistConn(conn);
        return;
      }

      if (message.type === "approval_reply") {
        const slot = slotOf(conn, message.chatId);
        // 迟到的回复（旧工具、已超时）不能批准当前正在等的另一项
        if (message.callId && slot.approvalCallId && message.callId !== slot.approvalCallId) return;
        resolveApprovalWait(slot, Boolean(message.allow));
        return;
      }

      if (message.type === "cancel") {
        const slot = slotOf(conn, message.chatId);
        resolveApprovalWait(slot, false);
        const alreadyDone = slot.finished;
        slot.externalAbort?.abort(); // P11：第三方在途请求（无 RunHandle，走 AbortController）
        await cancelRun(slot.run);
        finishRun(ws, slot, "cancelled");
        if (alreadyDone) {
          send(ws, { type: "done", chatId: slot.chatId, status: "cancelled" });
        }
        return;
      }

      if (message.type === "drop_queued") {
        const slot = slotOf(conn, message.chatId);
        const needle = (message.text || "").trim();
        if (!needle) slot.pending = [];
        else {
          const index = slot.pending.findIndex((item) => item.text.trim() === needle);
          if (index >= 0) slot.pending.splice(index, 1);
        }
        return;
      }

      if (message.type === "set_model") {
        const id = message.model.trim();
        if (id) {
          conn.model = id;
          if (message.chatId) slotOf(conn, message.chatId).model = id;
        }
        return;
      }

      if (message.type === "list_checkpoints") {
        sendCheckpoints(ws, slotOf(conn, message.chatId));
        return;
      }

      if (message.type === "read_file") {
        const cwd = message.chatId
          ? cwdOf(conn, slotOf(conn, message.chatId))
          : conn.cwd;
        const echo = {
          reqId: typeof message.reqId === "string" ? message.reqId : undefined,
          sha: typeof message.sha === "string" ? message.sha : undefined,
        };
        let file: WorkspaceFile;
        if (echo.sha != null) {
          // 快照只按 sha 寻址，path 只用来定 kind 和显示名
          const rel = workspacePath(cwd, message.path) || message.path;
          file = message.diff
            ? readSnapshotDiff(tenant.stateDir, rel, echo.sha)
            : readSnapshotFile(tenant.stateDir, rel, echo.sha);
        } else {
          file = message.diff ? readWorkspaceDiff(cwd, message.path) : readWorkspaceFile(cwd, message.path);
        }
        reply(ws, payload(tenant, message.chatId, message.path, file, Boolean(message.diff), echo));
        return;
      }

      if (message.type === "revert_file") {
        const slot = slotOf(conn, message.chatId);
        if (slot.run || slot.externalAbort) {
          send(ws, {
            type: "error",
            chatId: slot.chatId,
            message: "Agent 还在跑，先停再还原。",
          });
          return;
        }
        const result = undoEdits(cwdOf(conn, slot), [message.path]);
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: result.paths,
          error: result.error,
        });
        if (result.paths.length) {
          const gone = new Set(result.paths);
          slot.edited = slot.edited.filter((item) => {
            const path = workspacePath(cwdOf(conn, slot), item);
            return !path || !gone.has(path);
          });
          pushWorkspace(ws, slot, conn, result.paths);
          noteNativeRestore(conn, slot, undefined, result.paths);
        }
        return;
      }

      if (message.type === "revert_hunk") {
        const slot = slotOf(conn, message.chatId);
        if (slot.run || slot.externalAbort) {
          send(ws, {
            type: "error",
            chatId: slot.chatId,
            message: "Agent 还在跑，先停再还原。",
          });
          return;
        }
        const result = revertHunk(cwdOf(conn, slot), message.path, message.hunk);
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: result.error ? [] : [result.path],
          error: result.error,
        });
        if (!result.error) {
          pushWorkspace(ws, slot, conn, [result.path]);
          noteNativeRestore(conn, slot, undefined, [result.path]);
        }
        return;
      }

      if (message.type === "undo" || message.type === "restore") {
        const slot = slotOf(conn, message.chatId);
        if (slot.run || slot.externalAbort) {
          send(ws, {
            type: "error",
            chatId: slot.chatId,
            message: "Agent 还在跑，先停再撤销。",
          });
          return;
        }
        const wanted =
          message.type === "restore"
            ? slot.checkpoints.find((item) => item.id === message.checkpointId)
            : slot.checkpoints[0];
        if (wanted) {
          const result = restoreCheckpoint(cwdOf(conn, slot), wanted, slot.edited);
          send(ws, {
            type: "restored",
            chatId: slot.chatId,
            checkpointId: wanted.id,
            label: wanted.label,
            error: result.error,
          });
          if (!result.error) {
            const preview = slot.edited.slice();
            slot.edited = [];
            pushWorkspace(ws, slot, conn, preview);
            noteNativeRestore(conn, slot, wanted.label);
          }
          persistConn(conn);
          return;
        }
        if (message.type === "restore") {
          send(ws, {
            type: "restored",
            chatId: slot.chatId,
            checkpointId: message.checkpointId,
            error: "找不到这个检查点",
          });
          return;
        }
        const result = undoEdits(cwdOf(conn, slot), slot.edited);
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: result.paths,
          error: result.error,
        });
        if (result.paths.length) {
          slot.edited = [];
          pushWorkspace(ws, slot, conn, result.paths);
          noteNativeRestore(conn, slot, undefined, result.paths);
        }
        return;
      }

      if (message.type === "set_policy") {
        const next = parsePolicy(message.policy, conn.policy);
        conn.policy = next;
        if (message.chatId) {
          const slot = slotOf(conn, message.chatId);
          if (slot.policy !== next) {
            slot.policy = next;
            slot.approvedKeys.clear();
            await disposeSlot(slot);
            slot.agentId = null;
            slot.reseed = true;
          }
        }
        send(ws, { type: "policy", policy: next, chatId: message.chatId });
        return;
      }

      if (message.type === "prompt") {
        const slot = slotOf(conn, message.chatId);
        // P9 计量：一条用户消息记一个 turn（排队也算——用户确实发了）；
        // 埋点在分发处而非 handlePrompt，pending 重放不会重复计数
        noteTurn(tenant.id, (message.text || "").length);
        conn.clock = parseClientClock(message.clientTime) ?? conn.clock;
        await handlePrompt(
          ws,
          conn,
          slot,
          message.text,
          message.model,
          message.mode,
          message.files,
          message.images,
          Boolean(message.confirmWrites),
          Boolean(message.autoApprove),
          Boolean(message.fresh),
          parsePolicy(message.policy, conn.policy),
          message.dialect,
          message.history,
          true,
          message.turnId,
        );
        if (message.nameChat) void titleChat(ws, tenant, slot.chatId, message.text);
      }
    } catch (err) {
      const messageText =
        err instanceof CursorAgentError
          ? err.message
          : err instanceof Error
            ? err.message
            : "gateway 出错了";
      const chatId = "chatId" in message && message.chatId ? message.chatId : undefined;
      send(ws, { type: "error", chatId, message: messageText });
      if (chatId) {
        const slot = conn.slots.get(chatId);
        if (slot && !slot.finished) finishRun(ws, slot, "error");
      }
    }
  });

  ws.on("close", () => {
    if (conn.authed) persistConn(conn);
    for (const slot of conn.slots.values()) {
      if (slot.owner === ws) slot.owner = null;
    }
    conns.delete(ws);
  });
});

bindLoops({ busy: loopBusy, dispatch: dispatchLoop, publish: publishLoop });

bindBackground({
  apiKey: () => gatewayEnv.cursorApiKey(),
  listModels,
  prompt: (message, options) => Agent.prompt(message, options),
  sandbox: (tenantId) => sandboxEnabledForTenant(getTenant(tenantId)),
});

startAssistant({
  tenants: () => allTenants(),
  publish: publishLoop,
  globalStateDir: stateDir(),
  delegate: startDelegation,
  createWorkspace: requestWorkspace,
  workspaces: (tenant) => {
    const full = getTenant(tenant.id);
    return full ? delegationWorkspaces(full) : [];
  },
  appUrl: () => "./",
});

httpServer.listen(PORT, gatewayHost(), () => {
  publish.boot();
  const tenants = allTenants();
  for (const tenant of tenants) {
    mkdirSync(tenant.workspaceRoot, { recursive: true });
    mkdirSync(tenant.stateDir, { recursive: true });
  }
  log.banner(`cursor-remote gateway  http://${gatewayHost()}:${PORT}`);
  if (tenants.length === 1) {
    log.banner(`工作区                 ${tenants[0].workspaceRoot}`);
  } else {
    log.banner(`租户                   ${tenants.map((item) => item.id).join(", ") || "(无)"}`);
  }
  log.banner(`状态目录               ${stateDir()}`);
  if (PROXY_WEB) log.banner(`本机网页               ${webUrl().origin}`);
  if (!gatewayEnv.cursorApiKey()) {
    log.warn("缺少 CURSOR_API_KEY：写入环境或 .env 后重启 gateway。");
  }
  if (!hasAuth()) {
    log.warn("缺少登录配置：写入 tenants.json 或 CURSOR_REMOTE_TOKEN 后重启 gateway。");
  }
});
