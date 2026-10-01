import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as netCreateServer } from "node:net";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
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
const TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_LISTEN_MS = 45_000;

export type PublishTenant = {
  id: string;
  workspaceRoot: string;
  stateDir: string;
};

type TicketBody = { t: string; g: number; e: number; n: string };

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
  lastHitAt: number;
  child?: ChildProcess;
};

export type PublishController = {
  boot: () => void;
  close: () => void;
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
};

export function publishIdleDue(lastHit: number, now: number, idleMs: number) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return false;
  return now - lastHit >= idleMs;
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

function issueTicket(secret: string, tenantId: string, gen: number, ttlMs: number) {
  const body: TicketBody = {
    t: tenantId,
    g: gen,
    e: Date.now() + ttlMs,
    n: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readTicket(secret: string, ticket: string): TicketBody | null {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot !== ticket.lastIndexOf(".")) return null;
  const payload = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!secret || !payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<TicketBody>;
    const tenantId = parsed?.t;
    const gen = parsed?.g;
    const exp = parsed?.e;
    const nonce = parsed?.n;
    if (typeof tenantId !== "string" || typeof gen !== "number" || typeof exp !== "number" || typeof nonce !== "string" || !nonce) {
      return null;
    }
    if (!Number.isInteger(gen) || !Number.isInteger(exp)) return null;
    if (Date.now() > exp + 30_000) return null;
    return { t: tenantId, g: gen, e: exp, n: nonce };
  } catch {
    return null;
  }
}

function readCookie(header: string | string[] | undefined, name: string) {
  const raw = Array.isArray(header) ? header.join("; ") : header || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function stripOurCookie(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header.join("; ") : header || "";
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("jiebo_pub="));
  return kept.length ? kept.join("; ") : "";
}

function cookieHeader(ticket: string, exp: number, secure: boolean, cookiePath: string) {
  const age = Math.max(1, Math.floor((exp - Date.now()) / 1000));
  const parts = [
    `jiebo_pub=${encodeURIComponent(ticket)}`,
    "HttpOnly",
    `Path=${cookiePath}`,
    "SameSite=Lax",
    `Max-Age=${age}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
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
  if (!alive(pid)) return;
  if (!markerVisible(pid, marker)) {
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
  while (Date.now() < deadline && alive(pid)) await sleep(100);
  if (!alive(pid)) return;
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

function publicUrl(scheme: string, host: string, tenantId: string, ticket: string) {
  const name = cleanPublishHost(host);
  if (!name) return "";
  const proto = scheme === "http" ? "http" : "https";
  return `${proto}://${name}${publishBasePath(tenantId)}/?ticket=${encodeURIComponent(ticket)}`;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function createPublishController(options: {
  tenants: () => PublishTenant[];
  ticketSecret: () => string;
  host?: () => string;
  scheme?: () => string;
  portMin?: number;
  portMax?: number;
  idleMs?: number;
  listenTimeoutMs?: number;
  ticketTtlMs?: number;
}): PublishController {
  const slots = new Map<string, Slot>();
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const host = () => cleanPublishHost(options.host?.() ?? process.env.JIEBO_PUBLISH_HOST ?? "");
  const scheme = () => (options.scheme?.() ?? process.env.JIEBO_PUBLISH_SCHEME ?? "https").trim().toLowerCase();
  const portMin = options.portMin ?? numberEnv("JIEBO_PUBLISH_PORT_MIN", 20000);
  const portMax = options.portMax ?? numberEnv("JIEBO_PUBLISH_PORT_MAX", 20999);
  const idleMs = options.idleMs ?? numberEnv("JIEBO_PUBLISH_IDLE_MS", DEFAULT_IDLE_MS);
  const listenTimeoutMs = options.listenTimeoutMs ?? numberEnv("JIEBO_PUBLISH_LISTEN_MS", DEFAULT_LISTEN_MS);
  const ticketTtlMs = options.ticketTtlMs ?? TICKET_TTL_MS;

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
    const ticket = issueTicket(options.ticketSecret(), slot.tenantId, slot.gen, ticketTtlMs);
    const url = publicUrl(scheme(), host(), slot.tenantId, ticket);
    const lines = [
      listening ? "正在监听" : "进程还在，端口尚未监听",
      url || "外网地址还没配置（JIEBO_PUBLISH_HOST）。",
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

  function forget(tenant: PublishTenant, pid?: number) {
    const current = slots.get(tenant.id);
    if (pid != null && current && current.pid !== pid) return;
    slots.delete(tenant.id);
    clearPersisted(tenant);
  }

  async function ensureAlive(tenant: PublishTenant, slot: Slot) {
    if (alive(slot.pid) && markerVisible(slot.pid, slot.marker)) return slot;
    forget(tenant, slot.pid);
    return null;
  }

  async function stopSlot(tenant: PublishTenant, slot: Slot) {
    await killOwned(slot.pid, slot.marker);
    if (slot.child && !slot.child.killed) slot.child.unref();
    forget(tenant, slot.pid);
  }

  function allowed(tenant: PublishTenant, presented: string) {
    return secretEqual(presented, ensureTenantToken(tenant));
  }

  async function statusOf(cwd: string, presented: string) {
    const found = locate(cwd);
    if (!found) return { status: 400, body: { ok: false, message: "工作目录不在任何一个租户工作区里。" } };
    if (!allowed(found.tenant, presented)) return { status: 401, body: { ok: false, message: "口令不对。" } };
    if (!atUserRoot(found.cwd, found.tenant)) return offRoot;
    const existing = slots.get(found.tenant.id);
    const slot = existing ? await ensureAlive(found.tenant, existing) : null;
    if (!slot) return { status: 200, body: { ok: true, listening: false, message: "还没有公开的服务。" } };
    const listening = await portOpen(slot.port);
    const view = messageFor(slot, listening);
    return { status: 200, body: { ok: true, ...view, port: slot.port } };
  }

  async function stopAt(cwd: string, presented: string) {
    const found = locate(cwd);
    if (!found) return { status: 400, body: { ok: false, message: "工作目录不在任何一个租户工作区里。" } };
    if (!allowed(found.tenant, presented)) return { status: 401, body: { ok: false, message: "口令不对。" } };
    if (!atUserRoot(found.cwd, found.tenant)) return offRoot;
    const slot = slots.get(found.tenant.id);
    if (!slot) return { status: 200, body: { ok: true, message: "当前没有公开的服务。" } };
    if (!alive(slot.pid)) {
      forget(found.tenant, slot.pid);
      return { status: 200, body: { ok: true, message: "已停止。" } };
    }
    try {
      await stopSlot(found.tenant, slot);
    } catch (err) {
      return { status: 409, body: { ok: false, message: err instanceof Error ? err.message : "没有停掉。" } };
    }
    console.log(`publish stop ${found.tenant.id}`);
    return { status: 200, body: { ok: true, message: "已停止。" } };
  }

  async function startAt(cwd: string, command: string, presented: string) {
    const trimmed = command.trim();
    if (!trimmed || trimmed.length > 4000) {
      return { status: 400, body: { ok: false, message: "启动命令是空的，或超过 4000 字。" } };
    }
    const found = locate(cwd);
    if (!found) return { status: 400, body: { ok: false, message: "工作目录不在任何一个租户工作区里。" } };
    if (!allowed(found.tenant, presented)) return { status: 401, body: { ok: false, message: "口令不对。" } };
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
    const existing = slots.get(found.tenant.id);
    if (existing && (await ensureAlive(found.tenant, existing))) {
      return { status: 409, body: { ok: false, message: "已经有公开的服务。先执行 jiebo-publish stop。" } };
    }
    const port = await allocatePort();
    const prev = readPersisted(found.tenant);
    const gen = Math.max(readGen(found.tenant), prev?.gen || 0, existing?.gen || 0) + 1;
    writeGen(found.tenant, gen);
    const marker = `${found.tenant.id}:${gen}`;
    const logFile = resolve(found.tenant.stateDir, "publish.log");
    mkdirSync(found.tenant.stateDir, { recursive: true });
    const logFd = openSync(logFile, "w", 0o600);
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", trimmed, marker], {
        cwd: found.cwd,
        env: childEnv(port, marker, publishBasePath(found.tenant.id)),
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (err) {
      closeSync(logFd);
      return { status: 500, body: { ok: false, message: err instanceof Error ? err.message : "启动失败。" } };
    }
    closeSync(logFd);
    child.unref();
    const slot: Slot = {
      v: 1,
      tenantId: found.tenant.id,
      pid: child.pid || 0,
      port,
      command: trimmed,
      cwd: found.cwd,
      gen,
      marker,
      startedAt: Date.now(),
      lastHitAt: Date.now(),
      workspaceRoot: found.tenant.workspaceRoot,
      child,
    };
    if (!slot.pid) {
      return { status: 500, body: { ok: false, message: "没有拿到进程号。" } };
    }
    slots.set(found.tenant.id, slot);
    writePersisted(found.tenant, slot);
    let exited = false;
    child.on("exit", () => {
      exited = true;
      const current = slots.get(found.tenant.id);
      if (current?.pid === slot.pid) forget(found.tenant);
    });
    const deadline = Date.now() + Math.max(1000, listenTimeoutMs);
    let listening = false;
    while (Date.now() < deadline) {
      if (exited || !alive(slot.pid)) break;
      if (await portOpen(port)) {
        listening = true;
        break;
      }
      await sleep(200);
    }
    if (!listening) {
      const tail = logTail(logFile);
      try {
        await killOwned(slot.pid, slot.marker);
      } catch {
        // leave the slot if we cannot prove ownership; status will show it
      }
      if (!alive(slot.pid)) forget(found.tenant, slot.pid);
      const why = tail ? `\n${tail}` : "";
      return {
        status: 502,
        body: {
          ok: false,
          listening: false,
          message: `进程没在 127.0.0.1:${port} 监听。确认启动命令使用 HOST 和 PORT。${why}`,
        },
      };
    }
    if (boundToLoopback(port) !== true) {
      try {
        await killOwned(slot.pid, slot.marker);
      } catch {
        // 对不上就留着，避免误杀
      }
      if (!alive(slot.pid)) forget(found.tenant, slot.pid);
      return {
        status: 502,
        body: {
          ok: false,
          listening: false,
          message: `必须只监听 127.0.0.1:${port}，不要绑定 0.0.0.0 或 ::。`,
        },
      };
    }
    const view = messageFor(slot, true);
    console.log(`publish start ${found.tenant.id} 127.0.0.1:${port} pid ${slot.pid}`);
    return { status: 200, body: { ok: true, port, ...view } };
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

  function secureCookie(req: IncomingMessage) {
    const proto = String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    return proto === "https" || scheme() === "https";
  }

  function proxyHttp(
    req: IncomingMessage,
    res: ServerResponse,
    port: number,
    tenantId: string,
    ticket: string | null,
    exp: number | null,
  ) {
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
        if (ticket && exp) cookies.push(cookieHeader(ticket, exp, secureCookie(req), `${publishBasePath(tenantId)}/`));
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
    const slot = slots.get(label);
    if (!slot || !alive(slot.pid)) {
      if (slot && !alive(slot.pid)) forget(tenant, slot.pid);
      text(res, 404, "还没公开。在工作区里执行 jiebo-publish start。");
      return;
    }
    const current = new URL(req.url || "/", "http://127.0.0.1");
    const fromQuery = current.searchParams.get("ticket");
    const fromCookie = readCookie(req.headers.cookie, "jiebo_pub");
    const presented = fromQuery || fromCookie;
    const body = presented ? readTicket(options.ticketSecret(), presented) : null;
    if (!body || body.t !== label || body.g !== slot.gen) {
      text(res, 401, "这个服务还没对你开放。向接驳要一次新的链接。");
      return;
    }
    slot.lastHitAt = Date.now();
    if (fromQuery && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(302, {
        location: locationWithoutTicket(req.url || "/"),
        "set-cookie": cookieHeader(fromQuery, body.e, secureCookie(req), `${publishBasePath(label)}/`),
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
        "content-length": 0,
      });
      res.end();
      return;
    }
    proxyHttp(req, res, slot.port, label, fromQuery, fromQuery ? body.e : null);
  }

  function rejectUpgrade(socket: Duplex, status: number, message: string) {
    if (socket.destroyed) return;
    const body = Buffer.from(message);
    const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Bad Gateway";
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n" +
        "Cache-Control: no-store\r\n\r\n",
    );
    socket.end(body);
  }

  function proxyUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    port: number,
    tenantId: string,
    onActivity: () => void,
  ) {
    const beat = setInterval(onActivity, 30_000);
    beat.unref();
    const stopBeat = () => clearInterval(beat);
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
    const fail = () => {
      upstream.destroy();
      if (socket.writable) rejectUpgrade(socket, 502, "服务暂时连不上。");
      else socket.destroy();
    };
    upstream.on("error", fail);
    upstream.on("close", stopBeat);
    socket.on("close", stopBeat);
    socket.on("error", () => upstream.destroy());
  }

  function sweepIdle() {
    for (const [id, slot] of [...slots]) {
      const tenant = tenantById(id);
      if (!tenant) {
        slots.delete(id);
        continue;
      }
      void lock(async () => {
        const current = slots.get(id);
        if (!current || current.pid !== slot.pid) return;
        if (!alive(current.pid)) {
          forget(tenant, current.pid);
          return;
        }
        if (!publishIdleDue(current.lastHitAt, Date.now(), idleMs)) return;
        try {
          await stopSlot(tenant, current);
          console.log(`publish idle ${id}`);
        } catch (err) {
          console.error("publish idle", err instanceof Error ? err.message : err);
        }
      });
    }
  }

  return {
    boot() {
      for (const tenant of options.tenants()) {
        ensureTenantToken(tenant);
        const row = readPersisted(tenant);
        if (!row) continue;
        if (!alive(row.pid) || !markerVisible(row.pid, row.marker)) {
          clearPersisted(tenant);
          continue;
        }
        const cwd = confine(row.cwd, tenant);
        if (!cwd) {
          clearPersisted(tenant);
          continue;
        }
        slots.set(tenant.id, {
          ...row,
          cwd,
          tenantId: tenant.id,
          workspaceRoot: tenant.workspaceRoot,
          lastHitAt: Date.now(),
        });
        console.log(`publish attach ${tenant.id} 127.0.0.1:${row.port} pid ${row.pid}`);
      }
      if (idleMs > 0 && !timer) timer = setInterval(sweepIdle, 30_000);
      timer?.unref();
      const name = host();
      const proto = scheme() === "http" ? "http" : "https";
      console.log(name ? `对外预览               ${proto}://${name}/p/<id>/` : "对外预览               未配置 JIEBO_PUBLISH_HOST");
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
      const slot = slots.get(label);
      const presented = readCookie(req.headers.cookie, "jiebo_pub");
      const body = presented ? readTicket(options.ticketSecret(), presented) : null;
      if (!slot || !alive(slot.pid)) {
        if (slot && !alive(slot.pid)) {
          const tenant = tenantById(label);
          if (tenant) forget(tenant, slot.pid);
        }
        rejectUpgrade(socket, 404, "还没公开。");
        return true;
      }
      if (!body || body.t !== label || body.g !== slot.gen) {
        rejectUpgrade(socket, 401, "这个服务还没对你开放。向接驳要一次新的链接。");
        return true;
      }
      slot.lastHitAt = Date.now();
      proxyUpgrade(req, socket, head, slot.port, label, () => {
        slot.lastHitAt = Date.now();
      });
      return true;
    },
  };
}
