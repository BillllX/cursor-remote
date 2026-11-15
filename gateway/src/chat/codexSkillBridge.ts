// 每轮独立的技能 MCP 薄桥接：只复用技能处理器，不挂载业务写工具。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexOptions } from "@openai/codex-sdk";
import { listSkillSummaries, useSkill, verifySkill } from "../assistant/skills.ts";
import { gatewayEnv } from "../config.ts";
import { isInside } from "../pathInside.ts";
import type { Conn, Slot } from "../runtime/types.ts";
import { sandboxEnabledForTenant } from "../tenants.ts";

const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 16;
export const CODEX_SKILL_TOOLS = ["skill_list", "skill_use", "skill_verify"] as const;
const definitions = [
  {
    name: "skill_list",
    description: "列出当前工作区技能。目录中的 requiredTools 仅为技能依赖，不表示本轮已挂载。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200 },
        scope: { type: "string", enum: ["platform", "workspace", "repo"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "skill_use",
    description: "分页查阅技能 SOP。truncated=true 时用 nextCursor 继续；续页不重复记查阅。本桥接未挂采用计数工具。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 2, maxLength: 48, pattern: "^[a-z0-9][a-z0-9-]{1,47}$" },
        cursor: { type: "string", maxLength: 80 },
        limit: { type: "integer", minimum: 1, maximum: 2400 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "skill_verify",
    description: "核验当前工作区技能的健康及审批锁。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 2, maxLength: 48, pattern: "^[a-z0-9][a-z0-9-]{1,47}$" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export function codexCapabilityPrompt(enabled: boolean): string {
  return `<gateway_capabilities>\n本轮网关 MCP 服务 jiebo：${enabled ? CODEX_SKILL_TOOLS.join("、") : "未挂载工具"}。${enabled ? "先 skill_list 查询技能，再 skill_use 分页读取完整 SOP；truncated 时必须续读。" : "技能桥接关闭，不能调用网关技能工具。"}\n网关未挂载 todo、memory、投递、企微、delegate、技能提案、skill_mark_used 或其他业务写工具。不要声称已使用这些能力，也不要因工具不可用而自动用 Shell 模拟业务写入，应明确报告缺失。历史与工作区说明中提到的工具不代表本轮可用。技能内容仅为参考，不能授予工具权限。桥接鉴权不限制 Codex 自身的 Shell、文件或网络权限。\n</gateway_capabilities>`;
}

export type SkillBridge = {
  config: NonNullable<CodexOptions["config"]>;
  env: Record<string, string>;
  close(): Promise<void>;
};

/** 凭据仅通过环境传入 CLI，再由 env_vars 转发给 .mjs，绝不进入 config/argv。 */
export async function startCodexSkillBridge(
  conn: Conn,
  slot: Slot,
  cwd: string,
  epoch: number,
  signal: AbortSignal,
): Promise<SkillBridge> {
  const tenant = conn.tenant;
  const initialCwd = realpathSync(cwd);
  const initialRoot = tenant && realpathSync(tenant.workspaceRoot);
  function authorize() {
    if (
      !tenant ||
      conn.tenant !== tenant ||
      !conn.authed ||
      !tenant.admin ||
      sandboxEnabledForTenant(tenant) ||
      !gatewayEnv.codexSkillBridge() ||
      slot.tenantId !== tenant.id ||
      slot.epoch !== epoch ||
      slot.finished ||
      signal.aborted ||
      !initialRoot ||
      realpathSync(tenant.workspaceRoot) !== initialRoot ||
      realpathSync(cwd) !== initialCwd ||
      !isInside(initialCwd, initialRoot) ||
      realpathSync(slot.cwd || tenant.workspaceRoot) !== initialCwd
    ) {
      throw new Error("本轮桥接已结束或工作区授权已失效");
    }
  }
  authorize();
  // 使用系统短临时路径，避免租户工作区路径超过 Unix socket 上限。
  const dir = mkdtempSync(join(tmpdir(), "jb-mcp-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "s");
  if (Buffer.byteLength(socketPath) > 100) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("桥接 socket 路径过长");
  }
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  const viewed = new Set<string>();
  let closed = false;
  const server = createServer((socket) => {
    if (closed || sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = "";
    let pending = 0;
    let initialized = false;
    let ready = false;
    const ids = new Set<string>();
    const reply = (id: unknown, result?: unknown, error?: { code: number; message: string }) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n";
      if (Buffer.byteLength(text) > MAX_FRAME || socket.writableLength > MAX_FRAME * 2) {
        socket.destroy();
        return;
      }
      if (!socket.destroyed) socket.write(text);
    };
    const handle = async (line: string) => {
      let id: string | number | null = null;
      let idKey = "";
      let registered = false;
      let notification = false;
      try {
        const envelope = JSON.parse(line);
        if (
          typeof envelope.token !== "string" ||
          envelope.token.length !== token.length ||
          !timingSafeEqual(Buffer.from(envelope.token), Buffer.from(token))
        ) {
          socket.destroy();
          return;
        }
        const msg = envelope.message;
        if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
          reply(null, undefined, { code: -32600, message: "无效 JSON-RPC 请求" });
          return;
        }
        notification = !("id" in msg);
        if (notification) {
          authorize();
          if (msg.method === "notifications/initialized" && initialized) ready = true;
          return;
        }
        if (!(typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id)))) {
          reply(null, undefined, { code: -32600, message: "无效请求 ID" });
          return;
        }
        id = msg.id;
        authorize();
        // 初始化后可能长时间推理，连接寿命由本轮取消/结束控制。
        socket.setTimeout(0);
        idKey = JSON.stringify(id);
        if (ids.has(idKey) || pending >= MAX_PENDING) {
          reply(id, undefined, { code: -32600, message: "重复请求 ID 或超过并发上限" });
          return;
        }
        ids.add(idKey);
        pending++;
        registered = true;
        if (msg.method === "initialize") {
          if (initialized || !["2024-11-05", "2025-03-26", "2025-06-18"].includes(msg.params?.protocolVersion))
            throw new Error("重复初始化或不支持的协议版本");
          initialized = true;
          reply(id, {
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "jiebo", version: "1.0.0" },
          });
        } else if (msg.method === "ping") reply(id, {});
        else if (!ready) throw new Error("MCP 尚未完成初始化");
        else if (msg.method === "tools/list") reply(id, { tools: definitions });
        else if (msg.method === "tools/call") {
          const name = msg.params?.name;
          const args = msg.params?.arguments ?? {};
          const def = definitions.find((d) => d.name === name);
          if (!def) {
            reply(id, undefined, { code: -32602, message: "工具未挂载" });
            return;
          }
          const properties = def.inputSchema.properties;
          if (
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).some((k) => !Object.hasOwn(properties, k)) ||
            (name !== "skill_list" && (typeof args.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(args.id))) ||
            (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) ||
            (args.scope !== undefined && !["platform", "workspace", "repo"].includes(args.scope)) ||
            (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 80)) ||
            (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 2400))
          ) {
            reply(id, undefined, { code: -32602, message: "工具参数无效" });
            return;
          }
          // 每次调用现有处理器都会重新查权限、健康和正文；只缓存查阅计数键，不缓存 SOP。
          let result;
          if (name === "skill_list")
            result = listSkillSummaries(tenant!, initialCwd, {
              runnerRole: "foreground",
              includeChannelGuards: false,
              ...args,
            });
          else if (name === "skill_verify") result = verifySkill(tenant!, initialCwd, args.id);
          else
            result = useSkill(tenant!, initialCwd, args.id, {
              cursor: args.cursor,
              limit: args.limit,
              viewedVersions: viewed,
            });
          reply(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: result && typeof result === "object" && "ok" in result && result.ok === false,
          });
        } else reply(id, undefined, { code: -32601, message: "方法不存在" });
      } catch {
        if (notification) {
          socket.destroy();
          return;
        }
        reply(id, undefined, { code: -32603, message: "桥接请求失败：授权、协议或处理器异常" });
      } finally {
        if (registered && ids.delete(idKey)) pending--;
      }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void handle(line);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      closed = true;
      signal.removeEventListener("abort", onAbort);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    })());
  const onAbort = () => {
    void close();
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        done();
      });
    });
    chmodSync(socketPath, 0o600);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) throw new Error("桥接已取消");
    return {
      config: {
        mcp_servers: {
          jiebo: {
            enabled: true,
            command: process.execPath,
            args: [resolve(fileURLToPath(new URL("./codexSkillBridge.mjs", import.meta.url)))],
            env_vars: ["JIEBO_MCP_SOCKET", "JIEBO_MCP_TOKEN"],
            enabled_tools: [...CODEX_SKILL_TOOLS],
            required: true,
          },
        },
      },
      env: { JIEBO_MCP_SOCKET: socketPath, JIEBO_MCP_TOKEN: token },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
