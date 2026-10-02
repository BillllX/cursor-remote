import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSse, redactSecrets } from "./sse.ts";
import type { ToolResult, ToolSpec } from "./types.ts";

/**
 * 精简 MCP 客户端：initialize → tools/list → tools/call，传输支持 stdio 与 Streamable HTTP。
 * 配置只读网关状态目录里的 mcp.json（管理员维护），不读工作区里的配置——
 * 否则模型改一个文件就能让网关拉起任意命令。
 *
 * mcp.json：
 * { "mcpServers": {
 *     "fs":   { "command": "npx", "args": ["-y", "some-server"], "env": { "K": "V" }, "readOnlyTools": ["read"] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } },
 *     "x":    { …, "disabled": true }
 * } }
 */

export type McpServerConfig = {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** 管理员认定为只读的工具名（ask 模式可用、免审批）。服务端自报的 readOnlyHint 不作数 */
  readOnlyTools?: string[];
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

type McpContent = { type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } };

const PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const TOOLS_TTL_MS = 5 * 60_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_SCHEMA_CHARS = 16_000;

/** 远端错误正文和 stderr 可能回显配置里的密钥：先按配置值精确抹掉，再走通用脱敏 */
export function scrub(text: string, cfg: McpServerConfig) {
  let out = text;
  const secrets = [...Object.values(cfg.headers || {}), ...Object.values(cfg.env || {})]
    .flatMap((value) => [value, value.replace(/^(Bearer|Basic|Token)\s+/i, "")])
    .filter((value) => value.length >= 6);
  for (const secret of secrets) out = out.split(secret).join("***");
  return redactSecrets(out);
}

/** 工具 schema 规范成接口都认的形状：根必须是 object；过大或不合法的退回空参数 */
export function normalizeSchema(raw: unknown): Record<string, unknown> {
  const empty = { type: "object", properties: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  if (JSON.stringify(raw).length > MAX_SCHEMA_CHARS) return empty;
  const schema = { ...(raw as Record<string, unknown>) };
  if (schema.type !== "object") return empty;
  const props = schema.properties;
  schema.properties = props && typeof props === "object" && !Array.isArray(props) ? props : {};
  if (schema.required !== undefined) {
    const keys = Object.keys(schema.properties as object);
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string" && keys.includes(k)) : [];
    if (required.length) schema.required = required;
    else delete schema.required;
  }
  return schema;
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

export function loadMcpConfig(dirs: string[]): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const dir of dirs) {
    const file = resolve(dir, "mcp.json");
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
      for (const [name, rec] of Object.entries(raw.mcpServers || {})) {
        if (!rec || typeof rec !== "object" || rec.disabled === true) {
          byName.delete(name);
          continue;
        }
        const strMap = (value: unknown) =>
          value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
            : undefined;
        const cfg: McpServerConfig = {
          name,
          command: typeof rec.command === "string" ? rec.command : undefined,
          args: Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === "string") : undefined,
          env: strMap(rec.env),
          cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
          url: typeof rec.url === "string" ? rec.url : undefined,
          headers: strMap(rec.headers),
          readOnlyTools: Array.isArray(rec.readOnlyTools) ? rec.readOnlyTools.filter((t): t is string => typeof t === "string") : undefined,
        };
        if (cfg.command || cfg.url) byName.set(name, cfg);
      }
    } catch (err) {
      console.error(`mcp.json 解析失败（${file}）`, err instanceof Error ? err.message : err);
    }
  }
  return [...byName.values()];
}

/** 工具名只能是 [A-Za-z0-9_-]，且多数接口限 64 字符 */
export function mcpToolName(server: string, tool: string) {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= 64) return full;
  return `${full.slice(0, 55)}_${createHash("sha256").update(full).digest("hex").slice(0, 8)}`;
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

function rpcError(error: { code?: number; message?: string }) {
  return new Error(`MCP 错误 ${error.code ?? ""}：${(error.message || "").slice(0, 300)}`);
}

abstract class Transport {
  abstract request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  abstract notify(method: string, params?: unknown): Promise<void>;
  abstract close(): void;
  abstract get alive(): boolean;
}

class StdioTransport extends Transport {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  private stderrTail = "";

  constructor(private cfg: McpServerConfig) {
    super();
    const env: Record<string, string> = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME || "/tmp", LANG: process.env.LANG || "C.UTF-8", ...(cfg.env || {}) };
    this.child = spawn(cfg.command!, cfg.args || [], { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    liveChildren.add(this.child);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-1000);
    });
    const fail = (why: string) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(scrub(`MCP 服务 ${cfg.name} ${why}${this.stderrTail ? `：${this.stderrTail.trim().slice(-300)}` : ""}`, cfg)));
      }
      this.pending.clear();
    };
    this.child.on("error", (err) => fail(`启动失败（${err.message}）`));
    this.child.on("exit", (code) => {
      liveChildren.delete(this.child);
      fail(`已退出（${code}）`);
    });
  }

  get alive() {
    return !this.closed;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    if (this.buf.length > MAX_MESSAGE_BYTES) {
      this.buf = "";
      this.stderrTail = "单条消息超过 4MB";
      this.close();
      return;
    }
    let at: number;
    while ((at = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, at).trim();
      this.buf = this.buf.slice(at + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id) && !msg.method) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(rpcError(msg.error));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // 服务端发来的请求（sampling、roots 等）一律回「不支持」
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
      }
    }
  }

  private write(msg: unknown) {
    if (this.closed) throw new Error(`MCP 服务 ${this.cfg.name} 已断开`);
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<unknown>((resolveP, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 服务 ${this.cfg.name} ${method} 超时`));
      }, timeoutMs);
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        void this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => {});
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolveP(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  close() {
    this.closed = true;
    killTree(this.child, "SIGTERM");
    const child = this.child;
    setTimeout(() => killTree(child, "SIGKILL"), 2000).unref();
  }
}

class HttpTransport extends Transport {
  private nextId = 1;
  private session = "";
  private closed = false;
  constructor(private cfg: McpServerConfig) {
    super();
  }
  get alive() {
    return !this.closed;
  }

  private async post(body: unknown, timeoutMs: number, signal?: AbortSignal, expectId?: number): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(this.cfg.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...(this.session ? { "mcp-session-id": this.session } : {}),
          ...(this.cfg.headers || {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.session = sid;
      if (!res.ok) throw new Error(scrub(`MCP 服务 ${this.cfg.name} HTTP ${res.status}：${(await res.text().catch(() => "")).slice(0, 200)}`, this.cfg));
      if (expectId == null) return undefined;
      const type = res.headers.get("content-type") || "";
      const pick = (msg: { id?: number; result?: unknown; error?: { code?: number; message?: string } }) => {
        if (msg.id !== expectId) return undefined;
        if (msg.error) throw rpcError(msg.error);
        return { value: msg.result };
      };
      if (type.includes("text/event-stream") && res.body) {
        let found: { value: unknown } | undefined;
        let failure: Error | undefined;
        // 拿到对应 id 的结果就断开，别等服务端关流
        await readSse(res.body, `MCP ${this.cfg.name}`, (data) => {
          try {
            found = pick(JSON.parse(data));
          } catch (err) {
            failure = err instanceof SyntaxError ? undefined : (err as Error);
          }
          return Boolean(found || failure);
        }, timeoutMs, MAX_MESSAGE_BYTES);
        if (failure) throw failure;
        if (!found) throw new Error(`MCP 服务 ${this.cfg.name} 没有返回结果`);
        return found.value;
      }
      const text = await res.text();
      if (text.length > MAX_MESSAGE_BYTES) throw new Error(`MCP 服务 ${this.cfg.name} 返回内容超过 4MB`);
      const json = JSON.parse(text) as unknown;
      const rows = Array.isArray(json) ? json : [json];
      for (const row of rows) {
        const got = pick(row as never);
        if (got) return got.value;
      }
      throw new Error(`MCP 服务 ${this.cfg.name} 没有返回结果`);
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (ctrl.signal.aborted) throw new Error(`MCP 服务 ${this.cfg.name} 超时`);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal) {
    const id = this.nextId++;
    return this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal, id);
  }
  async notify(method: string, params?: unknown) {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, CONNECT_TIMEOUT_MS);
  }
  close() {
    this.closed = true;
    if (this.session) {
      void fetch(this.cfg.url!, { method: "DELETE", headers: { "mcp-session-id": this.session, ...(this.cfg.headers || {}) } }).catch(() => {});
    }
  }
}

class McpConnection {
  private transport: Transport | null = null;
  private connecting: Promise<Transport> | null = null;
  private tools: { at: number; list: McpTool[] } | null = null;
  constructor(readonly cfg: McpServerConfig) {}

  private async connect(): Promise<Transport> {
    if (this.transport?.alive) return this.transport;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const t = this.cfg.url ? new HttpTransport(this.cfg) : new StdioTransport(this.cfg);
      try {
        await t.request(
          "initialize",
          { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "jiebo-native-agent", version: "1" } },
          CONNECT_TIMEOUT_MS,
        );
        await t.notify("notifications/initialized");
      } catch (err) {
        t.close();
        throw err;
      }
      this.transport = t;
      this.tools = null;
      return t;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async listTools(): Promise<McpTool[]> {
    if (this.tools && Date.now() - this.tools.at < TOOLS_TTL_MS && this.transport?.alive) return this.tools.list;
    const t = await this.connect();
    const list: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = (await t.request("tools/list", cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS)) as { tools?: McpTool[]; nextCursor?: string };
      list.push(...(res.tools || []).filter((tool) => tool && typeof tool.name === "string"));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    this.tools = { at: Date.now(), list: list.slice(0, MAX_TOOLS_PER_SERVER) };
    return this.tools.list;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    let res: { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };
    try {
      const t = await this.connect();
      res = (await t.request("tools/call", { name, arguments: args }, CALL_TIMEOUT_MS, signal)) as typeof res;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      return { ok: false, content: scrub(err instanceof Error ? err.message : String(err), this.cfg) };
    }
    const parts = (res.content || []).map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "resource") return part.resource?.text || `[资源 ${part.resource?.uri || ""}]`;
      return `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ""}]`;
    });
    if (!parts.length && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent));
    return { ok: !res.isError, content: parts.join("\n") || (res.isError ? "失败" : "完成") };
  }

  close() {
    this.transport?.close();
    this.transport = null;
  }
}

/** 按完整配置做键：不同租户的同名服务、改过参数的服务各用各的连接；闲置 30 分钟回收 */
const connections = new Map<string, { conn: McpConnection; usedAt: number }>();
const IDLE_MS = 30 * 60_000;
/** 连不上的服务冷却一段时间，别让每一轮都卡在连接超时上 */
const failedAt = new Map<string, { at: number; error: string }>();
const RETRY_AFTER_MS = 2 * 60_000;

/** stdio 服务各自一个进程组；网关退出时整组杀掉，不留孙进程 */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // gone
    }
  }
}
process.on("exit", () => {
  for (const child of liveChildren) killTree(child, "SIGKILL");
});

/**
 * 按当前配置拿 MCP 工具。连不上的服务跳过并报原因，不影响本轮。
 * signal 取消时立即返回空列表；正在建立的连接留在缓存里，下次直接复用或闲置回收。
 */
export async function mcpTools(dirs: string[], opts: { allowStdio: boolean; signal?: AbortSignal }): Promise<{ tools: ToolSpec[]; errors: string[] }> {
  const { signal } = opts;
  if (signal?.aborted) return { tools: [], errors: [] };
  const work = discover(dirs, opts.allowStdio);
  if (!signal) return work;
  return Promise.race([
    work,
    new Promise<{ tools: ToolSpec[]; errors: string[] }>((ok) => signal.addEventListener("abort", () => ok({ tools: [], errors: [] }), { once: true })),
  ]);
}

async function discover(dirs: string[], allowStdio: boolean): Promise<{ tools: ToolSpec[]; errors: string[] }> {
  const opts = { allowStdio };
  const now = Date.now();
  for (const [key, row] of connections) {
    if (now - row.usedAt > IDLE_MS) {
      row.conn.close();
      connections.delete(key);
    }
  }
  const configs = loadMcpConfig(dirs).filter((cfg) => cfg.url || opts.allowStdio);
  const errors: string[] = [];
  const results = await Promise.all(
    configs.map(async (cfg) => {
      const key = JSON.stringify(cfg);
      const failed = failedAt.get(key);
      if (failed && now - failed.at < RETRY_AFTER_MS) {
        errors.push(`${cfg.name}：${failed.error}`);
        return [];
      }
      let row = connections.get(key);
      if (!row) {
        row = { conn: new McpConnection(cfg), usedAt: now };
        connections.set(key, row);
      }
      row.usedAt = now;
      const conn = row.conn;
      try {
        const list = await conn.listTools();
        failedAt.delete(key);
        return list.map((tool): ToolSpec => {
          // 只有管理员在 readOnlyTools 里点名的才按联网查询对待（ask 可用、可并行、免审批）；其余按 shell 级别审批
          const readOnly = cfg.readOnlyTools?.includes(tool.name) === true;
          return {
            name: mcpToolName(cfg.name, tool.name),
            description: `[MCP ${cfg.name}] ${tool.description || tool.name}`.slice(0, 1024),
            parameters: normalizeSchema(tool.inputSchema),
            category: readOnly ? "network" : "mcp",
            run: (args, ctx) => conn.call(tool.name, args, ctx.signal),
          };
        });
      } catch (err) {
        conn.close();
        connections.delete(key);
        const error = scrub(err instanceof Error ? err.message : String(err), cfg);
        failedAt.set(key, { at: now, error });
        errors.push(`${cfg.name}：${error}`);
        return [];
      }
    }),
  );
  const seen = new Set<string>();
  const tools = results.flat().filter((tool) => {
    if (!seen.has(tool.name)) return seen.add(tool.name), true;
    errors.push(`工具名冲突，已跳过重复的 ${tool.name}`);
    return false;
  });
  return { tools, errors };
}

export function closeAllMcp() {
  for (const row of connections.values()) row.conn.close();
  connections.clear();
}
