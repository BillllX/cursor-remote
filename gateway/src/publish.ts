import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as netCreateServer } from "node:net";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { defaultWorkbenchPage, workbenchDownPage } from "./publish-home.ts";
import { confinedCwd } from "./tenants.ts";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROL_PATHS = new Set([
  "/jiebo-publish/v1/start",
  "/jiebo-publish/v1/stop",
  "/jiebo-publish/v1/status",
]);
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);
const DEFAULT_LISTEN_MS = 45_000;
const SWEEP_MS = 30_000;
/** 自动拉起失败后的退避：30 秒起翻倍，最长 30 分钟 */
const REVIVE_BASE_MS = 30_000;
const REVIVE_MAX_MS = 30 * 60 * 1000;

export type PublishTenant = {
  id: string;
  workspaceRoot: string;
  stateDir: string;
  name?: string;
};

/** publish.json：用户要的工作台（命令 + 目录）和当前进程。只有 stop 才删，进程没了靠它重新拉起 */
type Persisted = {
  v: 1;
  pid: number;
  port: number;
  command: string;
  cwd: string;
  gen: number;
  marker: string;
  startedAt: number;
};

type Slot = Persisted & {
  tenantId: string;
  workspaceRoot: string;
  child?: ChildProcess;
};

type Backoff = { failures: number; nextAt: number };

type Outcome = { status: number; body: Record<string, unknown> };

export type PublishController = {
  boot: () => void;
  close: () => void;
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
};

export function reviveDelay(failures: number) {
  if (failures <= 0) return 0;
  return Math.min(REVIVE_MAX_MS, REVIVE_BASE_MS * 2 ** Math.min(failures - 1, 16));
}

export function cleanPublishHost(raw: string) {
  let value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (value.startsWith("*.")) value = value.slice(2);
  if (!value || /[:/\s*]/.test(value) || !/^[a-z0-9.-]+$/.test(value)) return "";
  return value;
}

const PUBLISH_PATH = /^\/p\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\/|$)/;

export function publishBasePath(tenantId: string) {
  return `/p/${tenantId}`;
}

export function tenantFromPublishPath(rawUrl: string): string | null {
  const match = PUBLISH_PATH.exec(pathnameOf(rawUrl));
  return match ? match[1] : null;
}

function pathnameOf(rawUrl: string) {
  const query = rawUrl.indexOf("?");
  const path = (query >= 0 ? rawUrl.slice(0, query) : rawUrl) || "/";
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

/** 以前发出去的链接带 ?ticket=，现在不校验了，转给用户进程前去掉 */
export function locationWithoutTicket(rawUrl: string) {
  const url = new URL(rawUrl || "/", "http://127.0.0.1");
  url.searchParams.delete("ticket");
  const path = url.pathname.startsWith("/") && !url.pathname.startsWith("//") ? url.pathname : "/";
  const query = url.searchParams.toString();
  return query ? `${path}?${query}` : path;
}

function hostnameOf(hostHeader: string) {
  const value = hostHeader.trim().toLowerCase().replace(/\.$/, "");
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(1, end) : value;
  }
  return value.split(":")[0] || "";
}

function secretEqual(got: string, expected: string) {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] || "";
}

/** 以前的访问 cookie 不再有用，别转给用户进程 */
function stripOurCookie(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header.join("; ") : header || "";
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("jiebo_pub="));
  return kept.length ? kept.join("; ") : "";
}

function text(res: ServerResponse, status: number, message: string) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(message);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function html(res: ServerResponse, status: number, page: string, head: boolean) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(page);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(head ? undefined : body);
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>) {
  if (res.headersSent || res.writableEnded) return;
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": raw.length,
    "cache-control": "no-store",
  });
  res.end(raw);
}

function readBody(req: IncomingMessage, limit: number) {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求太大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 进程是 detached 起的，pgid 就是首进程 pid。sh -c 'a && b' 这类命令首进程会先退，服务还在组里 */
function groupAlive(pgid: number) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return alive(pgid);
  }
}

function groupMembers(pgid: number) {
  if (process.platform !== "linux") return [];
  const out: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) out.push(Number(name));
    } catch {
      // 进程刚退出
    }
  }
  return out;
}

/** 组里还有带着本次标记的进程，才算是我们起的那一份（防 pid 复用） */
function groupOwned(pgid: number, marker: string) {
  if (alive(pgid) && markerVisible(pgid, marker)) return true;
  return groupMembers(pgid).some((pid) => markerVisible(pid, marker));
}

export function markerTokenMatches(text: string, marker: string) {
  const key = `JIEBO_PUBLISH_SLOT=${marker}`;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(key, from);
    if (at < 0) break;
    const after = text[at + key.length];
    if (after == null || /[\s\u0000]/.test(after)) return true;
    from = at + key.length;
  }
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s\\u0000])${escaped}(?:$|[\\s\\u0000])`).test(text);
}

function markerVisible(pid: number, marker: string) {
  try {
    if (process.platform === "linux") {
      const buf = readFileSync(`/proc/${pid}/environ`);
      if (markerTokenMatches(buf.toString("utf8"), marker)) return true;
    }
  } catch {
    // fall through to ps
  }
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (markerTokenMatches(args, marker)) return true;
  } catch {
    // ignore
  }
  try {
    const env = execFileSync("ps", ["eww", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return markerTokenMatches(env, marker);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostHeader: string) {
  const host = hostnameOf(hostHeader);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackPeer(req: IncomingMessage) {
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function hexIp(hex: string) {
  const value = hex.toLowerCase();
  if (value === "0100007f") return "127.0.0.1";
  if (value === "00000000") return "0.0.0.0";
  if (value === "00000000000000000000000001000000") return "::1";
  if (value === "00000000000000000000000000000000") return "::";
  return value;
}

function linuxListenHosts(port: number) {
  const hosts: string[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4 || parts[3] !== "0A") continue;
      const [ip, portHex] = parts[1].split(":");
      if (!ip || !portHex || parseInt(portHex, 16) !== port) continue;
      hosts.push(hexIp(ip));
    }
  }
  return hosts;
}

function lsofListenHosts(port: number) {
  const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const hosts: string[] = [];
  for (const line of out.split("\n")) {
    const match = /TCP\s+(\S+):(\d+)\s+\(LISTEN\)/.exec(line);
    if (!match || Number(match[2]) !== port) continue;
    hosts.push(match[1]);
  }
  return hosts;
}

function boundToLoopback(port: number): boolean | null {
  try {
    const hosts = process.platform === "linux" ? linuxListenHosts(port) : lsofListenHosts(port);
    if (!hosts.length) return null;
    return hosts.every((host) => host === "127.0.0.1" || host === "[::1]" || host === "::1");
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function portOpen(port: number) {
  return new Promise<boolean>((resolveOpen) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(300, () => done(false));
  });
}

function portFree(port: number) {
  return new Promise<boolean>((resolveFree) => {
    const server = netCreateServer();
    server.unref();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveFree(true));
    });
  });
}

const CHILD_SECRET_KEYS = new Set([
  "JIEBO_PUBLISH_SECRET",
  "CURSOR_API_KEY",
  "CURSOR_REMOTE_MEDIA_SECRET",
  "CURSOR_REMOTE_TOKEN",
  "CURSOR_REMOTE_PASSWORD",
]);

function childEnv(port: number, marker: string, basePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || CHILD_SECRET_KEYS.has(key)) continue;
    env[key] = value;
  }
  env.HOST = "127.0.0.1";
  env.PORT = String(port);
  env.BASE_PATH = basePath;
  env.JIEBO_PUBLISH_SLOT = marker;
  return env;
}

function logTail(file: string) {
  try {
    const textBody = readFileSync(file, "utf8").trim();
    return textBody.slice(-1500);
  } catch {
    return "";
  }
}

function persistedPath(tenant: PublishTenant) {
  return resolve(tenant.stateDir, "publish.json");
}

function readPersisted(tenant: PublishTenant): Persisted | null {
  try {
    const parsed = JSON.parse(readFileSync(persistedPath(tenant), "utf8")) as Persisted;
    if (parsed?.v !== 1 || !Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port)) return null;
    if (typeof parsed.command !== "string" || typeof parsed.cwd !== "string") return null;
    if (!Number.isInteger(parsed.gen) || typeof parsed.marker !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersisted(tenant: PublishTenant, row: Persisted) {
  const plain: Persisted = {
    v: 1,
    pid: row.pid,
    port: row.port,
    command: row.command,
    cwd: row.cwd,
    gen: row.gen,
    marker: row.marker,
    startedAt: row.startedAt,
  };
  mkdirSync(tenant.stateDir, { recursive: true });
  writeFileSync(persistedPath(tenant), JSON.stringify(plain));
}

function clearPersisted(tenant: PublishTenant) {
  try {
    unlinkSync(persistedPath(tenant));
  } catch {
    // already gone
  }
}

function genPath(tenant: PublishTenant) {
  return resolve(tenant.stateDir, "publish-gen");
}

function readGen(tenant: PublishTenant) {
  try {
    const value = Number(readFileSync(genPath(tenant), "utf8"));
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeGen(tenant: PublishTenant, gen: number) {
  mkdirSync(tenant.stateDir, { recursive: true });
  writeFileSync(genPath(tenant), String(gen));
}

function readTokenFile(file: string) {
  try {
    const text = readFileSync(file, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(text) ? text : "";
  } catch {
    return "";
  }
}

function writeTokenFile(file: string, token: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

/** 这个口令只管 Agent 能不能 start/stop 自己的工作台，访问工作台不需要它 */
function ensureTenantToken(tenant: PublishTenant) {
  const file = resolve(tenant.stateDir, "publish-token");
  let token = readTokenFile(file);
  if (!token) {
    token = randomBytes(32).toString("hex");
    writeTokenFile(file, token);
  }
  const mirror = resolve(tenant.workspaceRoot, ".cursor-remote", "publish-token");
  if (readTokenFile(mirror) !== token) writeTokenFile(mirror, token);
  return token;
}

async function killOwned(pid: number, marker: string) {
  if (!groupAlive(pid)) return;
  if (!groupOwned(pid, marker)) {
    throw new Error("进程对不上，没有停掉。");
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && groupAlive(pid)) await sleep(100);
  if (!groupAlive(pid)) return;
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

function publicUrl(scheme: string, host: string, tenantId: string) {
  const name = cleanPublishHost(host);
  if (!name) return "";
  const proto = scheme === "http" ? "http" : "https";
  return `${proto}://${name}${publishBasePath(tenantId)}/`;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function createPublishController(options: {
  tenants: () => PublishTenant[];
  host?: () => string;
  scheme?: () => string;
  portMin?: number;
  portMax?: number;
  listenTimeoutMs?: number;
  sweepMs?: number;
}): PublishController {
  const slots = new Map<string, Slot>();
  const backoff = new Map<string, Backoff>();
  const reviving = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const host = () => cleanPublishHost(options.host?.() ?? process.env.JIEBO_PUBLISH_HOST ?? "");
  const scheme = () => (options.scheme?.() ?? process.env.JIEBO_PUBLISH_SCHEME ?? "https").trim().toLowerCase();
  const portMin = options.portMin ?? numberEnv("JIEBO_PUBLISH_PORT_MIN", 20000);
  const portMax = options.portMax ?? numberEnv("JIEBO_PUBLISH_PORT_MAX", 20999);
  const listenTimeoutMs = options.listenTimeoutMs ?? numberEnv("JIEBO_PUBLISH_LISTEN_MS", DEFAULT_LISTEN_MS);
  const sweepMs = options.sweepMs ?? SWEEP_MS;

  function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function tenantById(id: string) {
    return options.tenants().find((tenant) => tenant.id === id);
  }

  function real(path: string) {
    const resolved = resolve(path);
    try {
      return existsSync(resolved) ? realpathSync(resolved) : resolved;
    } catch {
      return resolved;
    }
  }

  function confine(cwd: string, tenant: PublishTenant) {
    // macOS 上 /var 是 /private/var 的符号链接。先对齐真实路径，否则 shell 的 cwd 对不上工作区。
    return confinedCwd(real(cwd), real(tenant.workspaceRoot));
  }

  function locate(cwd: string) {
    let best: { tenant: PublishTenant; cwd: string; root: string } | null = null;
    for (const tenant of options.tenants()) {
      const next = confine(cwd, tenant);
      if (!next) continue;
      const root = real(tenant.workspaceRoot);
      if (!best || root.length > best.root.length) best = { tenant, cwd: next, root };
    }
    return best ? { tenant: best.tenant, cwd: best.cwd } : null;
  }

  function atUserRoot(cwd: string, tenant: PublishTenant) {
    return real(cwd) === real(tenant.workspaceRoot);
  }

  const offRoot = {
    status: 403,
    body: { ok: false, message: "对外网站只能在 USER 工作区里创建。换到用户根目录下的会话再执行 jiebo-publish。" },
  };

  function messageFor(slot: Slot, listening: boolean) {
    const url = publicUrl(scheme(), host(), slot.tenantId);
    const lines = [
      listening ? "正在监听" : "进程还在，端口尚未监听",
      url || "外网地址还没配置（JIEBO_PUBLISH_HOST）。",
      "任何人拿到这个地址都能打开；会一直开着，进程退出或平台重启后自动拉起。",
      `本机 127.0.0.1:${slot.port}`,
      `命令 ${slot.command}`,
    ];
    return { url, listening, message: lines.join("\n") };
  }

  async function allocatePort() {
    const used = new Set([...slots.values()].map((slot) => slot.port));
    if (!Number.isInteger(portMin) || !Number.isInteger(portMax) || portMin < 1024 || portMax > 65535 || portMin > portMax) {
      throw new Error("端口范围不合法。");
    }
    if (portMax - portMin > 2000) throw new Error("端口范围太大。");
    for (let port = portMin; port <= portMax; port += 1) {
      if (used.has(port)) continue;
      if (await portFree(port)) return port;
    }
    throw new Error("没有空闲端口。");
  }

  /** 只丢掉内存里的进程记录；publish.json 留着，监督循环据此重新拉起 */
  function dropSlot(tenantId: string, pid?: number) {
    const current = slots.get(tenantId);
    if (pid != null && current && current.pid !== pid) return;
    slots.delete(tenantId);
  }

  /** 自己起的进程靠 exit 事件；开机接上的没有事件，每次都核对标记，防 pid 被别的进程复用 */
  function slotAlive(slot: Slot) {
    if (!groupAlive(slot.pid)) return false;
    if (slot.child && slot.child.exitCode === null && slot.child.signalCode === null) return true;
    return groupOwned(slot.pid, slot.marker);
  }

  function liveSlot(tenantId: string) {
    const slot = slots.get(tenantId);
    if (!slot) return null;
    if (slotAlive(slot)) return slot;
    dropSlot(tenantId, slot.pid);
    return null;
  }

  async function launch(
    tenant: PublishTenant,
    command: string,
    cwd: string,
  ): Promise<{ ok: true; slot: Slot } | { ok: false; status: number; message: string }> {
    let port: number;
    try {
      port = await allocatePort();
    } catch (err) {
      return { ok: false, status: 503, message: err instanceof Error ? err.message : "没有空闲端口。" };
    }
    const prev = readPersisted(tenant);
    const gen = Math.max(readGen(tenant), prev?.gen || 0, slots.get(tenant.id)?.gen || 0) + 1;
    writeGen(tenant, gen);
    const marker = `${tenant.id}:${gen}`;
    const logFile = resolve(tenant.stateDir, "publish.log");
    mkdirSync(tenant.stateDir, { recursive: true });
    const logFd = openSync(logFile, "w", 0o600);
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command, marker], {
        cwd,
        env: childEnv(port, marker, publishBasePath(tenant.id)),
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (err) {
      closeSync(logFd);
      return { ok: false, status: 500, message: err instanceof Error ? err.message : "启动失败。" };
    }
    closeSync(logFd);
    child.unref();
    const slot: Slot = {
      v: 1,
      tenantId: tenant.id,
      pid: child.pid || 0,
      port,
      command,
      cwd,
      gen,
      marker,
      startedAt: Date.now(),
      workspaceRoot: tenant.workspaceRoot,
      child,
    };
    if (!slot.pid) return { ok: false, status: 500, message: "没有拿到进程号。" };
    slots.set(tenant.id, slot);
    let exited = false;
    child.on("error", () => {
      exited = true;
    });
    child.on("exit", () => {
      // 首进程退了但组里服务还在（sh -c 'a && b'），交给 slotAlive 按组判断
      if (groupAlive(slot.pid) && groupOwned(slot.pid, slot.marker)) return;
      exited = true;
      dropSlot(tenant.id, slot.pid);
    });
    const deadline = Date.now() + Math.max(1000, listenTimeoutMs);
    let listening = false;
    while (Date.now() < deadline) {
      if (exited || !groupAlive(slot.pid)) break;
      if (await portOpen(port)) {
        listening = true;
        break;
      }
      await sleep(200);
    }
    const fail = async (message: string) => {
      try {
        await killOwned(slot.pid, slot.marker);
      } catch {
        // 对不上就留着，避免误杀
      }
      if (!groupAlive(slot.pid)) dropSlot(tenant.id, slot.pid);
      return { ok: false as const, status: 502, message };
    };
    if (!listening) {
      const tail = logTail(logFile);
      const why = tail ? `\n${tail}` : "";
      return fail(`进程没在 127.0.0.1:${port} 监听。确认启动命令使用 HOST 和 PORT。${why}`);
    }
    if (boundToLoopback(port) !== true) {
      return fail(`必须只监听 127.0.0.1:${port}，不要绑定 0.0.0.0 或 ::。`);
    }
    return { ok: true, slot };
  }

  /** 用户要过工作台、进程却不在：按 publish.json 重新拉起，失败按退避重试，不清用户的设置 */
  async function revive(tenant: PublishTenant) {
    const row = readPersisted(tenant);
    if (!row) {
      backoff.delete(tenant.id);
      return;
    }
    if (liveSlot(tenant.id)) return;
    const wait = backoff.get(tenant.id);
    if (wait && Date.now() < wait.nextAt) return;
    const cwd = confine(row.cwd, tenant);
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory() || !DNS_LABEL.test(tenant.id)) {
      console.warn(`publish revive ${tenant.id}: 工作目录没了，放弃自动拉起`);
      clearPersisted(tenant);
      backoff.delete(tenant.id);
      return;
    }
    const result = await launch(tenant, row.command, cwd);
    if (result.ok) {
      writePersisted(tenant, result.slot);
      backoff.delete(tenant.id);
      console.log(`publish revive ${tenant.id} 127.0.0.1:${result.slot.port} pid ${result.slot.pid}`);
      return;
    }
    const failures = (wait?.failures || 0) + 1;
    backoff.set(tenant.id, { failures, nextAt: Date.now() + reviveDelay(failures) });
    console.warn(`publish revive ${tenant.id} 第 ${failures} 次失败：${result.message.split("\n")[0]}`);
  }

  async function statusOf(cwd: string, presented: string): Promise<Outcome> {
    const found = locate(cwd);
    if (!found) return { status: 400, body: { ok: false, message: "工作目录不在任何一个租户工作区里。" } };
    if (!secretEqual(presented, ensureTenantToken(found.tenant))) {
      return { status: 401, body: { ok: false, message: "口令不对。" } };
    }
    if (!atUserRoot(found.cwd, found.tenant)) return offRoot;
    const slot = liveSlot(found.tenant.id);
    if (!slot) {
      const row = readPersisted(found.tenant);
      if (!row) return { status: 200, body: { ok: true, listening: false, message: "还没有公开的服务。外网地址现在显示默认介绍页。" } };
      const wait = backoff.get(found.tenant.id);
      const tail = logTail(resolve(found.tenant.stateDir, "publish.log"));
      const lines = [
        "工作台进程没在运行，平台会自动重新拉起。",
        wait ? `已连续失败 ${wait.failures} 次，下次重试在 ${Math.max(0, Math.round((wait.nextAt - Date.now()) / 1000))} 秒后。` : "",
        `命令 ${row.command}`,
        tail ? `最近日志：\n${tail}` : "",
      ].filter(Boolean);
      return { status: 200, body: { ok: true, listening: false, message: lines.join("\n") } };
    }
    const listening = await portOpen(slot.port);
    const view = messageFor(slot, listening);
    return { status: 200, body: { ok: true, ...view, port: slot.port } };
  }

  async function stopAt(cwd: string, presented: string): Promise<Outcome> {
    const found = locate(cwd);
    if (!found) return { status: 400, body: { ok: false, message: "工作目录不在任何一个租户工作区里。" } };
    if (!secretEqual(presented, ensureTenantToken(found.tenant))) {
      return { status: 401, body: { ok: false, message: "口令不对。" } };
    }
    if (!atUserRoot(found.cwd, found.tenant)) return offRoot;
    const slot = slots.get(found.tenant.id);
    const hadRow = Boolean(readPersisted(found.tenant));
    if (slot && groupAlive(slot.pid)) {
      try {
        await killOwned(slot.pid, slot.marker);
      } catch (err) {
        return { status: 409, body: { ok: false, message: err instanceof Error ? err.message : "没有停掉。" } };
      }
      if (slot.child && !slot.child.killed) slot.child.unref();
    }
    dropSlot(found.tenant.id);
    clearPersisted(found.tenant);
    backoff.delete(found.tenant.id);
    if (!slot && !hadRow) return { status: 200, body: { ok: true, message: "当前没有公开的服务。" } };
    console.log(`publish stop ${found.tenant.id}`);
    return { status: 200, body: { ok: true, message: "已停止。外网地址现在显示默认介绍页。" } };
  }

  async function startAt(cwd: string, command: string, presented: string): Promise<Outcome> {
    const trimmed = command.trim();
    if (!trimmed || trimmed.length > 4000) {
      return { status: 400, body: { ok: false, message: "启动命令是空的，或超过 4000 字。" } };
    }
    const found = locate(cwd);
    if (!found) return { status: 400, body: { ok: false, message: "工作目录不在任何一个租户工作区里。" } };
    if (!secretEqual(presented, ensureTenantToken(found.tenant))) {
      return { status: 401, body: { ok: false, message: "口令不对。" } };
    }
    if (!atUserRoot(found.cwd, found.tenant)) return offRoot;
    if (!existsSync(found.cwd) || !statSync(found.cwd).isDirectory()) {
      return { status: 400, body: { ok: false, message: "工作目录不存在。" } };
    }
    if (!DNS_LABEL.test(found.tenant.id)) {
      return {
        status: 400,
        body: { ok: false, message: `租户 id「${found.tenant.id}」不能出现在路径里。用小写字母、数字和中间的短横线。` },
      };
    }
    if (liveSlot(found.tenant.id)) {
      return { status: 409, body: { ok: false, message: "已经有公开的服务。先执行 jiebo-publish stop。" } };
    }
    const result = await launch(found.tenant, trimmed, found.cwd);
    if (!result.ok) {
      // 新命令起不来就不再记着旧的，外网回到默认页
      clearPersisted(found.tenant);
      backoff.delete(found.tenant.id);
      return { status: result.status, body: { ok: false, listening: false, message: result.message } };
    }
    writePersisted(found.tenant, result.slot);
    backoff.delete(found.tenant.id);
    const view = messageFor(result.slot, true);
    console.log(`publish start ${found.tenant.id} 127.0.0.1:${result.slot.port} pid ${result.slot.pid}`);
    return { status: 200, body: { ok: true, port: result.slot.port, ...view } };
  }

  async function control(req: IncomingMessage, res: ServerResponse, op: "start" | "stop" | "status") {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, message: "只用 POST。" });
      return;
    }
    if (!isLoopbackHost(String(req.headers.host || "")) || !isLoopbackPeer(req)) {
      json(res, 403, { ok: false, message: "只接受本机调用。" });
      return;
    }
    let payload: { cwd?: unknown; command?: unknown };
    try {
      payload = JSON.parse(await readBody(req, 64 * 1024)) as { cwd?: unknown; command?: unknown };
    } catch {
      json(res, 400, { ok: false, message: "请求不合法。" });
      return;
    }
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    const command = typeof payload.command === "string" ? payload.command : "";
    const presented = bearer(req);
    const result = await lock(() => {
      if (op === "start") return startAt(cwd, command, presented);
      if (op === "stop") return stopAt(cwd, presented);
      return statusOf(cwd, presented);
    });
    json(res, result.status, result.body);
  }

  function proxyHttp(req: IncomingMessage, res: ServerResponse, port: number, tenantId: string) {
    const headers = { ...req.headers };
    const cookie = stripOurCookie(headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    delete headers["proxy-connection"];
    headers["x-forwarded-prefix"] = publishBasePath(tenantId);
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: locationWithoutTicket(req.url || "/"),
        method: req.method,
        headers,
      },
      (up) => {
        const out: Record<string, string | string[]> = {};
        const cookies: string[] = [];
        for (let i = 0; i < up.rawHeaders.length; i += 2) {
          const key = up.rawHeaders[i].toLowerCase();
          if (HOP.has(key)) continue;
          const value = up.rawHeaders[i + 1];
          if (key === "set-cookie") {
            cookies.push(value);
            continue;
          }
          out[key] = value;
        }
        if (cookies.length) out["set-cookie"] = cookies;
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      },
    );
    upstream.setTimeout(0);
    const fail = () => {
      upstream.destroy();
      if (!res.headersSent) text(res, 502, "服务暂时连不上。");
      else res.destroy();
    };
    upstream.on("error", fail);
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  function handlePublic(req: IncomingMessage, res: ServerResponse, label: string) {
    const tenant = tenantById(label);
    if (!tenant) {
      text(res, 404, "没有这个用户。");
      return;
    }
    const slot = liveSlot(label);
    if (slot) {
      proxyHttp(req, res, slot.port, label);
      return;
    }
    const head = req.method === "HEAD";
    if (readPersisted(tenant)) {
      scheduleRevive(tenant);
      html(res, 503, workbenchDownPage(tenant.id, tenant.name), head);
      return;
    }
    const path = pathnameOf(req.url || "/");
    const atRoot = path === publishBasePath(label) || path === `${publishBasePath(label)}/`;
    html(res, atRoot ? 200 : 404, defaultWorkbenchPage(tenant.id, tenant.name), head);
  }

  function rejectUpgrade(socket: Duplex, status: number, message: string) {
    if (socket.destroyed) return;
    const body = Buffer.from(message);
    const reason = status === 404 ? "Not Found" : status === 503 ? "Service Unavailable" : "Bad Gateway";
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n" +
        "Cache-Control: no-store\r\n\r\n",
    );
    socket.end(body);
  }

  function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, tenantId: string) {
    const upstream = netConnect(port, "127.0.0.1", () => {
      let raw = `${req.method || "GET"} ${locationWithoutTicket(req.url || "/")} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const lower = key.toLowerCase();
        if (lower === "cookie") {
          const next = stripOurCookie(req.rawHeaders[i + 1]);
          if (next) raw += `Cookie: ${next}\r\n`;
          continue;
        }
        if (lower === "x-forwarded-prefix") continue;
        raw += `${key}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += `X-Forwarded-Prefix: ${publishBasePath(tenantId)}\r\n`;
      raw += "\r\n";
      upstream.write(raw);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      upstream.destroy();
      if (socket.writable) rejectUpgrade(socket, 502, "服务暂时连不上。");
      else socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
  }

  function scheduleRevive(tenant: PublishTenant) {
    if (reviving.has(tenant.id)) return;
    reviving.add(tenant.id);
    void lock(() => revive(tenant))
      .catch((err) => {
        // 异常也计入退避，否则外部请求能反复触发
        const failures = (backoff.get(tenant.id)?.failures || 0) + 1;
        backoff.set(tenant.id, { failures, nextAt: Date.now() + reviveDelay(failures) });
        console.error("publish revive", err instanceof Error ? err.message : err);
      })
      .finally(() => reviving.delete(tenant.id));
  }

  function sweep() {
    for (const tenant of options.tenants()) scheduleRevive(tenant);
    for (const id of [...slots.keys()]) {
      if (!tenantById(id)) slots.delete(id);
    }
  }

  return {
    boot() {
      for (const tenant of options.tenants()) {
        ensureTenantToken(tenant);
        const row = readPersisted(tenant);
        if (!row) continue;
        const cwd = confine(row.cwd, tenant);
        if (cwd && groupAlive(row.pid) && groupOwned(row.pid, row.marker)) {
          slots.set(tenant.id, { ...row, cwd, tenantId: tenant.id, workspaceRoot: tenant.workspaceRoot });
          console.log(`publish attach ${tenant.id} 127.0.0.1:${row.port} pid ${row.pid}`);
        }
      }
      // 平台重启会带走这些进程（同一个 systemd cgroup），开机就按 publish.json 拉回来
      sweep();
      if (sweepMs > 0 && !timer) {
        timer = setInterval(sweep, sweepMs);
        timer.unref();
      }
      const name = host();
      const proto = scheme() === "http" ? "http" : "https";
      console.log(name ? `对外预览               ${proto}://${name}/p/<id>/（公开访问，常驻）` : "对外预览               未配置 JIEBO_PUBLISH_HOST");
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    handleHttp(req, res) {
      const label = tenantFromPublishPath(req.url || "/");
      if (label) {
        try {
          handlePublic(req, res, label);
        } catch (err) {
          console.error("publish", err instanceof Error ? err.message : err);
          text(res, 500, "发布路由出错。");
        }
        return true;
      }
      const path = (req.url || "/").split("?")[0];
      if (!CONTROL_PATHS.has(path)) return false;
      const op = path.endsWith("/start") ? "start" : path.endsWith("/stop") ? "stop" : "status";
      void control(req, res, op).catch((err) => {
        console.error("publish", err instanceof Error ? err.message : err);
        json(res, 500, { ok: false, message: "发布路由出错。" });
      });
      return true;
    },
    handleUpgrade(req, socket, head) {
      const label = tenantFromPublishPath(req.url || "/");
      if (!label) return false;
      const slot = liveSlot(label);
      if (!slot) {
        const tenant = tenantById(label);
        if (tenant && readPersisted(tenant)) {
          scheduleRevive(tenant);
          rejectUpgrade(socket, 503, "工作台正在重新启动。");
        } else {
          rejectUpgrade(socket, 404, "工作台还没在运行。");
        }
        return true;
      }
      proxyUpgrade(req, socket, head, slot.port, label);
      return true;
    },
  };
}
