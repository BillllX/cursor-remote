import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Agent } from "@cursor/sdk";
import { WebSocketServer } from "ws";
import {
  allTenants,
  getTenant,
  hasAuth,
  loadTenants,
  sandboxEnabledForTenant,
  saveDiskNow,
  stateDir,
  sweepStateTmp,
} from "./tenants.ts";
import { bindLoops } from "./loops.ts";
import { bindBackground } from "./assistant/background.ts";
import { startAssistant, calendarFeed } from "./assistant/service.ts";
import { createPublishController } from "./publish.ts";
import { gatewayEnv, loadDotEnv } from "./config.ts";
import { log } from "./log.ts";
import { agentSocketPath, handleMedia, handleState, handleUpload } from "./http/routes.ts";
import { isAbortError } from "./runtime/abort.ts";
import { compactTenantChats } from "./sync/storedState.ts";
import { delegationWorkspaces, requestWorkspace, startDelegation } from "./bindings/delegations.ts";
import { dispatchLoop, loopBusy, publishLoop } from "./bindings/loops.ts";
import { listModels } from "./chat/models.ts";
import { healthPayload } from "./http/health.ts";
import { proxyUpgrade, proxyWeb } from "./http/proxy.ts";
import { defaultModel, gatewayHost, webUrl } from "./runtime/env.ts";
import { onConnection } from "./ws/connection.ts";

loadDotEnv([resolve(process.cwd(), ".env"), resolve(process.cwd(), "../.env")]);

const PORT = gatewayEnv.gatewayPort();
// runtime/env.ts 的缓存函数在原来的时机先求值一次（非法值仍在启动这里抛错）
gatewayHost();
webUrl();
const PROXY_WEB = gatewayEnv.proxyWeb();
defaultModel();

loadTenants();
const sweptTmp = sweepStateTmp(
  [stateDir(), ...allTenants().map((tenant) => tenant.stateDir)],
  allTenants().map((tenant) => tenant.workspaceRoot),
);
if (sweptTmp) log.info(`已清理状态目录里残留的临时文件 ${sweptTmp} 个`);
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

wss.on("connection", onConnection);

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
