import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanPublishHost,
  createPublishController,
  locationWithoutTicket,
  markerTokenMatches,
  reviveDelay,
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

type Row = { pid: number; port: number };

function persisted(t: PublishTenant): Row | null {
  try {
    return JSON.parse(readFileSync(join(t.stateDir, "publish.json"), "utf8")) as Row;
  } catch {
    return null;
  }
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function waitFor(what: string, ms: number, probe: () => Promise<boolean>) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等不到：${what}`);
}

async function main() {
  check(cleanPublishHost("Jiebo.AIAgentSwitcher.com.") === "jiebo.aiagentswitcher.com", "主机名没规范化");
  check(cleanPublishHost("https://jiebo.aiagentswitcher.com/p/a") === "", "带协议的主机名不该通过");
  check(tenantFromPublishPath("/p/alpha") === "alpha", "路径没解析出租户");
  check(tenantFromPublishPath("/p/alpha/hello?x=1") === "alpha", "带查询的路径没解析出租户");
  check(tenantFromPublishPath("/p/alpha.evil") === null, "多出来的主机名被当成了租户");
  check(tenantFromPublishPath("/p/") === null, "空路径被当成了租户");
  check(tenantFromPublishPath("/health") === null, "站点根被当成了预览");
  check(locationWithoutTicket("/p/alpha/a?ticket=1&x=2") === "/p/alpha/a?x=2", "旧票据还在转发地址里");
  check(reviveDelay(0) === 0 && reviveDelay(1) === 30_000 && reviveDelay(2) === 60_000, "退避起点不对");
  check(reviveDelay(50) === 30 * 60 * 1000, "退避没有封顶");
  check(markerTokenMatches("JIEBO_PUBLISH_SLOT=alpha:1\0", "alpha:1"), "进程标记没对上");
  check(!markerTokenMatches("JIEBO_PUBLISH_SLOT=alpha:12\0", "alpha:1"), "短标记命中了更长的标记");
  check(markerTokenMatches("/bin/sh -c cmd alpha:1\n", "alpha:1"), "命令行标记没对上");
  check(!markerTokenMatches("/bin/sh -c cmd alpha:12\n", "alpha:1"), "命令行短标记命中了更长的标记");

  const root = mkdtempSync(join(tmpdir(), "jiebo-publish-"));
  const alpha = { ...tenant(root, "alpha"), name: "阿尔法" };
  const beta = tenant(root, "beta");
  const bad = tenant(root, "ab-");
  const outside = join(root, "outside");
  mkdirSync(outside);
  process.env.CURSOR_API_KEY = "cursor-test-key";
  const options = {
    tenants: () => [alpha, beta, bad],
    host: () => "preview.test",
    scheme: () => "http",
    portMin: 46100,
    portMax: 46140,
    listenTimeoutMs: 5000,
    // 巡检放慢，杀进程后先由访问看到重启页、再由访问触发拉起
    sweepMs: 5000,
  };
  let publish: PublishController = createPublishController(options);
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
    const host = "preview.test";
    const health = await get(port, "/health", `127.0.0.1:${port}`);
    check(health.body === "gateway-health", "本机 /health 被发布路由吃掉了");

    const home = await get(port, "/p/alpha/", host);
    check(home.status === 200 && String(home.headers["content-type"]).includes("text/html"), `默认页状态不对：${home.status}`);
    check(home.body.includes("阿尔法 还没有建自己的工作台") && home.body.includes("jiebo-publish start"), "默认页没写怎么生成工作台");
    const homeBare = await get(port, "/p/alpha", host);
    check(homeBare.status === 200, "不带斜杠的工作台地址没给默认页");
    const homeDeep = await get(port, "/p/alpha/nope.js", host);
    check(homeDeep.status === 404 && homeDeep.body.includes("工作台"), "没建工作台时子路径不该当成 200");
    const nobody = await get(port, "/p/nobody/", host);
    check(nobody.status === 404, "不存在的用户也给了页面");

    const denied = await post(port, "/jiebo-publish/v1/status", "nope", { cwd: alpha.workspaceRoot });
    check(denied.status === 401, "错误口令没有被拒绝");
    const outsideRes = await post(port, "/jiebo-publish/v1/start", alphaToken, { cwd: outside, command });
    check(outsideRes.status === 400, "工作区外的目录被接受了");
    const nested = join(alpha.workspaceRoot, "nested");
    mkdirSync(nested);
    const nestedStart = await post(port, "/jiebo-publish/v1/start", alphaToken, { cwd: nested, command });
    check(nestedStart.status === 403 && (nestedStart.json?.message || "").includes("USER"), "子工作区被允许公开网站");
    const badName = await post(port, "/jiebo-publish/v1/start", badToken, { cwd: bad.workspaceRoot, command });
    check(badName.status === 400 && (badName.json?.message || "").includes("路径"), "非法路径被接受了");

    const failed = await post(port, "/jiebo-publish/v1/start", alphaToken, {
      cwd: alpha.workspaceRoot,
      command: `"${node}" -e "process.exit(1)"`,
    });
    check(failed.json?.ok === false, "没监听的进程被当成公开成功");
    check(!persisted(alpha), "起不来的命令被记成了常驻工作台");
    const wide = await post(port, "/jiebo-publish/v1/start", alphaToken, { cwd: alpha.workspaceRoot, command: `"${node}" wide.mjs` });
    check(wide.json?.ok === false && (wide.json?.message || "").includes("127.0.0.1"), wide.json?.message || "绑到所有网卡也被公开了");
    check((await get(port, "/p/alpha/", host)).status === 200, "失败的 start 之后默认页没了");

    const started = await post(port, "/jiebo-publish/v1/start", alphaToken, { cwd: alpha.workspaceRoot, command });
    check(started.json?.ok && started.json.url, started.json?.message || "start 失败");
    check(started.json.url === "http://preview.test/p/alpha/", `地址不对：${started.json.url}`);
    const again = await post(port, "/jiebo-publish/v1/start", alphaToken, { cwd: alpha.workspaceRoot, command });
    check(again.status === 409, "重复公开没有被拒绝");

    const openHealth = await get(port, "/health", host);
    check(openHealth.body === "gateway-health", "站点根上的 /health 被预览路由吃掉了");
    const page = await get(port, "/p/alpha/hello", host);
    check(page.status === 200, `不带任何凭证打不开工作台：${page.status}`);
    check(page.body.startsWith("/p/alpha/hello"), `上游看到的路径不对：${page.body}`);
    check(page.body.split("\n")[3] === "/p/alpha", "BASE_PATH 没有注入");
    check(page.body.includes("clean"), "发布口令漏进了用户进程");
    check(page.body.includes("nokey"), "CURSOR_API_KEY 漏进了用户进程");
    check(page.body.includes("127.0.0.1"), "HOST 没有注入");
    const oldLink = await get(port, "/p/alpha/?ticket=old.link", host, "jiebo_pub=old");
    check(oldLink.status === 200 && !oldLink.body.includes("ticket"), "带旧票据的链接打不开，或票据被转给了用户进程");

    const statusCode = await upgrade(port, host, "", "/p/alpha/");
    check(statusCode === 101, `websocket 没有升级：${statusCode}`);

    // 首进程 sh 立刻退出、服务留在进程组里：不能当成挂了再拉一份
    const betaStarted = await post(port, "/jiebo-publish/v1/start", betaToken, { cwd: beta.workspaceRoot, command: `${command} &` });
    check(betaStarted.json?.ok, betaStarted.json?.message || "beta start 失败");
    const betaPid = persisted(beta)?.pid;
    await new Promise((r) => setTimeout(r, 500));
    check((await get(port, "/p/beta/hello", host)).status === 200, "首进程退出后，组里的服务没被当成活的");
    check(persisted(beta)?.pid === betaPid, "首进程退出后又被重复拉起");
    const cross = await post(port, "/jiebo-publish/v1/status", alphaToken, { cwd: beta.workspaceRoot });
    check(cross.status === 401, "alpha 的口令能看 beta");
    const stopOnPublic = await post(port, "/jiebo-publish/v1/stop", alphaToken, { cwd: alpha.workspaceRoot }, host);
    check(stopOnPublic.status === 403, "公开主机名上的控制接口被执行了");

    // 进程被杀：巡检按同一条命令拉起
    const first = persisted(alpha);
    check(first?.pid, "publish.json 没记下进程");
    killGroup(first.pid);
    await waitFor("被杀的进程退出", 3000, async () => {
      try {
        process.kill(first.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    const down = await get(port, "/p/alpha/", host);
    check(down.status === 503 && down.body.includes("正在重新启动"), `进程没了却没显示重启页：${down.status}`);
    await waitFor("被杀的工作台自动拉起", 8000, async () => {
      const row = persisted(alpha);
      if (!row || row.pid === first.pid) return false;
      return (await get(port, "/p/alpha/hello", host)).status === 200;
    });

    // 模拟平台重启：旧控制器关掉、进程全没了，新控制器开机就拉起
    publish.close();
    for (const t of [alpha, beta]) {
      const row = persisted(t);
      if (row) killGroup(row.pid);
    }
    await new Promise((r) => setTimeout(r, 300));
    publish = createPublishController(options);
    publish.boot();
    await waitFor("重启后两个工作台都拉起", 8000, async () => {
      const a = await get(port, "/p/alpha/hello", host);
      const b = await get(port, "/p/beta/hello", host);
      return a.status === 200 && b.status === 200;
    });

    const cli = await new Promise<{ code: number; out: string }>((resolvePromise, reject) => {
      const child = spawn(node, [resolve(fileURLToPath(new URL("../../scripts/jiebo-publish.mjs", import.meta.url))), "status"], {
        cwd: alpha.workspaceRoot,
        env: { ...process.env, JIEBO_PUBLISH_SECRET: alphaToken, GATEWAY_PORT: String(port), GATEWAY_HOST: "127.0.0.1" },
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
      child.on("error", reject);
      child.on("exit", (code) => resolvePromise({ code: code ?? 1, out: Buffer.concat(chunks).toString("utf8") }));
    });
    check(cli.code === 0 && cli.out.includes("http://preview.test/p/alpha/\n"), `CLI status 不对：${cli.out}`);

    // stop 之后回到默认页，巡检也不再拉起
    const stopped = await post(port, "/jiebo-publish/v1/stop", alphaToken, { cwd: alpha.workspaceRoot });
    check(stopped.json?.ok === true, stopped.json?.message || "stop 失败");
    check(!existsSync(join(alpha.stateDir, "publish.json")), "stop 后还记着工作台");
    await new Promise((r) => setTimeout(r, 1000));
    const after = await get(port, "/p/alpha/", host);
    check(after.status === 200 && after.body.includes("还没有建自己的工作台"), "stop 后没回到默认页，或被巡检又拉了起来");
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
