import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanPublishHost,
  createPublishController,
  locationWithoutTicket,
  markerTokenMatches,
  publishIdleDue,
  tenantFromPublishPath,
  type PublishController,
  type PublishTenant,
} from "./publish.ts";

const WIDE = `import { createServer } from "node:http";
createServer((req, res) => res.end("wide")).listen(Number(process.env.PORT), "0.0.0.0");
`;

const SERVER = `import { createHash } from "node:crypto";
import { createServer } from "node:http";
const port = Number(process.env.PORT);
const host = process.env.HOST || "127.0.0.1";
const server = createServer((req, res) => {
  const body = [req.url || "", host, String(port), process.env.BASE_PATH || "", process.env.JIEBO_PUBLISH_SECRET ? "leaked" : "clean", process.env.CURSOR_API_KEY ? "key" : "nokey"].join("\\n");
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
});
server.on("upgrade", (req, socket) => {
  const key = String(req.headers["sec-websocket-key"] || "");
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  socket.end();
});
server.listen(port, host);
`;

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

type Json = {
  ok?: boolean;
  message?: string;
  url?: string;
  listening?: boolean;
  port?: number;
};

function post(
  port: number,
  path: string,
  token: string,
  body: Record<string, unknown>,
  host = `127.0.0.1:${port}`,
): Promise<{ status: number; json: Json | null; raw: string }> {
  const raw = JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Host: host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
          authorization: token ? `Bearer ${token}` : "",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Json | null = null;
          try {
            json = JSON.parse(text) as Json;
          } catch {
            json = null;
          }
          resolvePromise({ status: res.statusCode || 0, json, raw: text });
        });
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
}

function get(
  port: number,
  path: string,
  host: string,
  cookie = "",
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function upgrade(port: number, host: string, cookie: string, path: string) {
  return new Promise<number>((resolvePromise, reject) => {
    const key = randomBytes(16).toString("base64");
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path,
      headers: {
        Host: host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
        Cookie: cookie,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolvePromise(res.statusCode || 101);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        reject(new Error(`upgrade ${res.statusCode} ${Buffer.concat(chunks).toString("utf8")}`));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function cookieFrom(headers: IncomingHttpHeaders) {
  const raw = headers["set-cookie"]?.[0] || "";
  const match = /jiebo_pub=([^;]+)/.exec(raw);
  return match ? `jiebo_pub=${match[1]}` : "";
}

function ticketFrom(url: string) {
  return new URL(url).searchParams.get("ticket") || "";
}

async function listen(server: Server) {
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  check(address && typeof address !== "string", "gateway 没有端口");
  return address.port;
}

function tenant(root: string, id: string): PublishTenant {
  const stateDir = join(root, "tenants", id);
  const workspaceRoot = join(stateDir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "server.mjs"), SERVER);
  writeFileSync(join(workspaceRoot, "wide.mjs"), WIDE);
  return { id, workspaceRoot, stateDir };
}

async function main() {
  check(cleanPublishHost("Jiebo.AIAgentSwitcher.com.") === "jiebo.aiagentswitcher.com", "主机名没规范化");
  check(cleanPublishHost("https://jiebo.aiagentswitcher.com/p/a") === "", "带协议的主机名不该通过");
  check(tenantFromPublishPath("/p/alpha") === "alpha", "路径没解析出租户");
  check(tenantFromPublishPath("/p/alpha/hello?x=1") === "alpha", "带查询的路径没解析出租户");
  check(tenantFromPublishPath("/p/alpha.evil") === null, "多出来的主机名被当成了租户");
  check(tenantFromPublishPath("/p/") === null, "空路径被当成了租户");
  check(tenantFromPublishPath("/health") === null, "站点根被当成了预览");
  check(locationWithoutTicket("/p/alpha/a?ticket=1&x=2") === "/p/alpha/a?x=2", "票据还在跳转地址里");
  check(publishIdleDue(0, 30_000, 30_000), "空闲判断错了");
  check(!publishIdleDue(0, 10, 0), "关闭空闲时不该回收");
  check(markerTokenMatches("JIEBO_PUBLISH_SLOT=alpha:1\0", "alpha:1"), "进程标记没对上");
  check(!markerTokenMatches("JIEBO_PUBLISH_SLOT=alpha:12\0", "alpha:1"), "短标记命中了更长的标记");
  check(markerTokenMatches("/bin/sh -c cmd alpha:1\n", "alpha:1"), "命令行标记没对上");
  check(!markerTokenMatches("/bin/sh -c cmd alpha:12\n", "alpha:1"), "命令行短标记命中了更长的标记");

  const root = mkdtempSync(join(tmpdir(), "jiebo-publish-"));
  const alpha = tenant(root, "alpha");
  const beta = tenant(root, "beta");
  const bad = tenant(root, "ab-");
  const outside = join(root, "outside");
  mkdirSync(outside);
  process.env.CURSOR_API_KEY = "cursor-test-key";
  const publish: PublishController = createPublishController({
    tenants: () => [alpha, beta, bad],
    ticketSecret: () => "ticket-secret",
    host: () => "preview.test",
    scheme: () => "http",
    portMin: 46100,
    portMax: 46140,
    idleMs: 0,
    listenTimeoutMs: 5000,
  });
  const gateway = createServer((req, res) => {
    if (publish.handleHttp(req, res)) return;
    if ((req.url || "").split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("gateway-health");
      return;
    }
    res.writeHead(404).end("gateway");
  });
  gateway.on("upgrade", (req, socket, head) => {
    if (!publish.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const node = process.execPath;
  const command = `"${node}" server.mjs`;
  let port = 0;
  try {
    publish.boot();
    const alphaToken = readFileSync(join(alpha.stateDir, "publish-token"), "utf8").trim();
    const betaToken = readFileSync(join(beta.stateDir, "publish-token"), "utf8").trim();
    const badToken = readFileSync(join(bad.stateDir, "publish-token"), "utf8").trim();
    check(alphaToken && alphaToken !== betaToken, "租户口令没有按人分开");
    port = await listen(gateway);
    const health = await get(port, "/health", `127.0.0.1:${port}`);
    check(health.body === "gateway-health", "本机 /health 被发布路由吃掉了");

    const denied = await post(port, "/jiebo-publish/v1/status", "nope", { cwd: alpha.workspaceRoot });
    check(denied.status === 401, "错误口令没有被拒绝");

    const outsideRes = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: outside,
      command,
    });
    check(outsideRes.status === 400, "工作区外的目录被接受了");

    const nested = join(alpha.workspaceRoot, "nested");
    mkdirSync(nested);
    const nestedStart = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: nested,
      command,
    });
    check(nestedStart.status === 403 && (nestedStart.json?.message || "").includes("USER"), "子工作区被允许公开网站");

    const badName = await post(port, "/jiebo-publish/v1/start", badToken, {
      cwd: bad.workspaceRoot,
      command,
    });
    check(badName.status === 400 && (badName.json?.message || "").includes("路径"), "非法路径被接受了");

    const failed = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: alpha.workspaceRoot,
      command: `"${node}" -e "process.exit(1)"`,
    });
    check(failed.json?.ok === false, "没监听的进程被当成公开成功");
    const wide = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: alpha.workspaceRoot,
      command: `"${node}" wide.mjs`,
    });
    check(wide.json?.ok === false && (wide.json?.message || "").includes("127.0.0.1"), wide.json?.message || "绑到所有网卡也被公开了");

    const started = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: alpha.workspaceRoot,
      command,
    });
    check(started.json?.ok && started.json.url, started.json?.message || "start 失败");
    const url = started.json.url;
    check(url.startsWith("http://preview.test/p/alpha/?ticket="), `地址不对：${url}`);
    const ticket = ticketFrom(url);
    const again = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: alpha.workspaceRoot,
      command,
    });
    check(again.status === 409, "重复公开没有被拒绝");

    const host = "preview.test";
    const openHealth = await get(port, "/health", host);
    check(openHealth.body === "gateway-health", "站点根上的 /health 被预览路由吃掉了");
    const hidden = await get(port, "/p/alpha/health", host);
    check(hidden.status === 401 && !hidden.body.includes("gateway-health"), "没票据也能看到预览");
    const redirected = await get(port, `/p/alpha/?ticket=${encodeURIComponent(ticket)}`, host);
    check(redirected.status === 302, "票据没有换成跳转");
    check(redirected.headers.location === "/p/alpha/", `跳转地址不对：${redirected.headers.location}`);
    check(!String(redirected.headers.location || "").includes("ticket"), "跳转还带着票据");
    check(String(redirected.headers["set-cookie"]).includes("HttpOnly"), "cookie 不是 HttpOnly");
    check(String(redirected.headers["set-cookie"]).includes("Path=/p/alpha/"), "cookie 没限制在这条路径");
    const cookie = cookieFrom(redirected.headers);
    check(cookie, "没有 Set-Cookie");
    const page = await get(port, "/p/alpha/hello", host, cookie);
    check(page.status === 200, "cookie 没能打开页面");
    check(page.body.startsWith("/p/alpha/hello"), `上游看到的路径不对：${page.body}`);
    check(page.body.split("\n")[3] === "/p/alpha", "BASE_PATH 没有注入");
    check(!page.body.includes("ticket"), "票据被转给了用户进程");
    check(page.body.includes("clean"), "发布口令漏进了用户进程");
    check(page.body.includes("nokey"), "CURSOR_API_KEY 漏进了用户进程");
    check(page.body.includes("127.0.0.1"), "HOST 没有注入");

    const tampered = await get(port, `/p/alpha/?ticket=${encodeURIComponent(`${ticket}x`)}`, host);
    check(tampered.status === 401, "改过的票据被接受了");

    const betaStarted = await post(port, "/jiebo-publish/v1/start", betaToken, {
      cwd: beta.workspaceRoot,
      command,
    });
    const cross = await post(port, "/jiebo-publish/v1/status", alphaToken, { cwd: beta.workspaceRoot });
    check(cross.status === 401, "alpha 的口令能看 beta");
    check(betaStarted.json?.ok && betaStarted.json.url, betaStarted.json?.message || "beta start 失败");
    const crossed = await get(port, "/p/beta/", host, cookie);
    check(crossed.status === 401, "alpha 的 cookie 打开了 beta");

    const statusCode = await upgrade(port, host, cookie, "/p/alpha/");
    check(statusCode === 101, `websocket 没有升级：${statusCode}`);

    const stopOnPublic = await post(port, "/jiebo-publish/v1/stop", alphaToken, { cwd: alpha.workspaceRoot }, host);
    check(stopOnPublic.status === 403, "公开主机名上的控制接口被执行了");
    const still = await post(port, "/jiebo-publish/v1/status", alphaToken, { cwd: alpha.workspaceRoot });
    check(still.json?.listening === true, "公开域名上的 stop 把服务停了");

    const cli = await new Promise<{ code: number; out: string }>((resolvePromise, reject) => {
      const child = spawn(node, [resolve(fileURLToPath(new URL("../../scripts/jiebo-publish.mjs", import.meta.url))), "status"], {
        cwd: alpha.workspaceRoot,
        env: {
          ...process.env,
          JIEBO_PUBLISH_SECRET: alphaToken,
          GATEWAY_PORT: String(port),
          GATEWAY_HOST: "127.0.0.1",
        },
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolvePromise({ code: code ?? 1, out: Buffer.concat(chunks).toString("utf8") }));
    });
    check(cli.code === 0 && cli.out.includes("http://preview.test/p/alpha/?ticket="), `CLI status 不对：${cli.out}`);

    const stopped = await post(port, "/jiebo-publish/v1/stop", alphaToken, { cwd: alpha.workspaceRoot });
    check(stopped.json?.ok === true, stopped.json?.message || "stop 失败");
    const after = await get(port, "/p/alpha/", host, cookie);
    check(after.status === 404, "停止后旧 cookie 还能打开");

    const restarted = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: alpha.workspaceRoot,
      command,
    });
    check(restarted.json?.ok && restarted.json.url, restarted.json?.message || "再次 start 失败");
    const stale = await get(port, "/p/alpha/", host, cookie);
    check(stale.status === 401, "停掉再公开后，旧 cookie 仍然有效");
    console.log("publish smoke ok");
  } finally {
    if (port) {
      const readToken = (dir: string) => {
        try {
          return readFileSync(join(dir, "publish-token"), "utf8").trim();
        } catch {
          return "";
        }
      };
      await post(port, "/jiebo-publish/v1/stop", readToken(alpha.stateDir), { cwd: alpha.workspaceRoot }).catch(() => undefined);
      await post(port, "/jiebo-publish/v1/stop", readToken(beta.stateDir), { cwd: beta.workspaceRoot }).catch(() => undefined);
    }
    gateway.close();
    publish.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
