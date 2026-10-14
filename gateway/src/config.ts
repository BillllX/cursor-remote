/**
 * 网关读取的环境变量都在这里声明：名字、类型、默认值、说明。
 *
 * 访问器每次调用才读 process.env，不在 import 时拍快照：loadDotEnv 在 index.ts 的 import 之后才补写，
 * 冒烟脚本也会在运行中途改写 process.env（APNS_*、CURSOR_REMOTE_STATE_DIR）。
 * 想要“启动时读一次”的值，由调用方在模块顶层调用访问器。
 *
 * 不经过这里的读取（scripts/check-env.mjs 里有对应白名单）：
 * - 传给子进程的整份环境 `{ ...process.env }`（index.ts 的 git/shell、turnFiles.ts、publish.ts childEnv）；
 * - native/tools/shell.ts 的 ENV_ALLOW 白名单和 sandboxMasks 的 HOME、native/mcp.ts 的 PATH/HOME/LANG、
 *   native/tools/fs.ts 的 PATH；
 * - providers.ts 按 providers.json 里的 apiKeyEnv 动态取键；
 * - shared/policy.ts 读 CURSOR_REMOTE_POLICY（网页也引用 shared，不能依赖网关的 config）。
 *
 * 新增变量：在 ENV_SPECS 加一行、在 gatewayEnv 加访问器、在 scripts/gateway.env.example 加一行（npm run check:env 会查）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type EnvSpec = {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  /** 文档用的默认值；实际默认值以访问器为准 */
  default?: string;
  group: string;
  doc: string;
};

export const ENV_SPECS = [
  {
    name: "GATEWAY_PORT",
    type: "number",
    default: "8787",
    group: "网关",
    doc: "监听端口；非数字会得到 NaN（与历史行为一致）",
  },
  { name: "GATEWAY_HOST", type: "string", default: "127.0.0.1", group: "网关", doc: "监听地址" },
  {
    name: "CURSOR_REMOTE_WEB_ORIGIN",
    type: "string",
    default: "http://127.0.0.1:3000",
    group: "网关",
    doc: "本机 Next 网页的地址，GATEWAY_PROXY_WEB 打开时反代到这里",
  },
  {
    name: "GATEWAY_PROXY_WEB",
    type: "boolean",
    default: "1",
    group: "网关",
    doc: "是否反代网页；只有 0/false/off/no（不分大小写、不去空格）算关",
  },
  {
    name: "GATEWAY_LOG_LEVEL",
    type: "enum",
    default: "info",
    group: "网关",
    doc: "日志级别 debug/info/warn/error，其它值按 info",
  },
  {
    name: "GATEWAY_LOG_FORMAT",
    type: "enum",
    default: "text",
    group: "网关",
    doc: "日志格式 text/json；json 每条一行（level、time、tenant、chatId、msg），其它值按 text",
  },

  { name: "CURSOR_API_KEY", type: "string", group: "Cursor", doc: "Cursor User API Key，必填；读取时去首尾空格" },
  { name: "CURSOR_REMOTE_MODEL", type: "string", default: "composer-2.5", group: "Cursor", doc: "默认模型" },
  {
    name: "CURSOR_API_ENDPOINT",
    type: "string",
    default: "https://api2.cursor.sh",
    group: "Cursor",
    doc: "用量/计费接口地址，去掉末尾斜杠；每次请求时读取",
  },
  {
    name: "CURSOR_REMOTE_POLICY",
    type: "enum",
    default: "baseline",
    group: "Cursor",
    doc: "默认 harness 路径 baseline/plane；由 shared/policy.ts 直接读取，这里只做登记",
  },

  {
    name: "CURSOR_REMOTE_STATE_DIR",
    type: "string",
    default: "~/.cursor-remote",
    group: "租户与状态",
    doc: "会话、检查点、shadow-git 的根目录",
  },
  {
    name: "CURSOR_REMOTE_TENANTS_FILE",
    type: "string",
    group: "租户与状态",
    doc: "多租户名单；不设则依次找 /etc/cursor-remote/tenants.json、./tenants.json、../tenants.json",
  },
  {
    name: "CURSOR_REMOTE_TOKEN",
    type: "string",
    group: "租户与状态",
    doc: "没有 tenants.json 时的单租户口令",
  },
  {
    name: "CURSOR_REMOTE_PASSWORD",
    type: "string",
    group: "租户与状态",
    doc: "CURSOR_REMOTE_TOKEN 的旧名，前者为空时才用",
  },
  {
    name: "CURSOR_REMOTE_NAME",
    type: "string",
    default: "default",
    group: "租户与状态",
    doc: "单租户模式的显示名",
  },
  {
    name: "CURSOR_REMOTE_CWD",
    type: "string",
    default: "~/Projects",
    group: "租户与状态",
    doc: "单租户模式的工作区根目录",
  },
  {
    name: "CURSOR_REMOTE_SANDBOX",
    type: "boolean",
    default: "1",
    group: "租户与状态",
    doc: "单租户模式是否启用沙箱；只有 0/false/off/no 算关",
  },
  {
    name: "WORKSPACE_MEMORY_CONFIRM",
    type: "boolean",
    default: "0",
    group: "租户与状态",
    doc: "工作区记忆提议要不要先出确认卡；默认 0 直接写进 .jiebo/memory.md，1/true/yes/on 才攒着请用户批准",
  },
  {
    name: "CURSOR_REMOTE_MEDIA_SECRET",
    type: "string",
    group: "租户与状态",
    doc: "媒体预览签名密钥；不设则由 CURSOR_API_KEY 和 tenants.json 修改时间派生",
  },

  {
    name: "GIT_AUTHOR_NAME",
    type: "string",
    group: "检查点 git 身份",
    doc: "检查点提交的作者名，优先于 CURSOR_REMOTE_GIT_NAME",
  },
  { name: "GIT_AUTHOR_EMAIL", type: "string", group: "检查点 git 身份", doc: "检查点提交的作者邮箱" },
  {
    name: "CURSOR_REMOTE_GIT_NAME",
    type: "string",
    default: "cursor-remote",
    group: "检查点 git 身份",
    doc: "GIT_AUTHOR_NAME 为空时的作者名",
  },
  {
    name: "CURSOR_REMOTE_GIT_EMAIL",
    type: "string",
    default: "cursor-remote@localhost",
    group: "检查点 git 身份",
    doc: "GIT_AUTHOR_EMAIL 为空时的作者邮箱",
  },
  { name: "GIT_COMMITTER_NAME", type: "string", group: "检查点 git 身份", doc: "提交者名，缺省同作者" },
  { name: "GIT_COMMITTER_EMAIL", type: "string", group: "检查点 git 身份", doc: "提交者邮箱，缺省同作者" },

  {
    name: "JIEBO_PUBLISH_HOST",
    type: "string",
    group: "对外预览",
    doc: "对外预览主机名，https://<主机名>/p/<id>/",
  },
  { name: "JIEBO_PUBLISH_SCHEME", type: "string", default: "https", group: "对外预览", doc: "http 或 https" },
  {
    name: "JIEBO_PUBLISH_PORT_MIN",
    type: "number",
    default: "20000",
    group: "对外预览",
    doc: "预览进程端口下限；空串按 0，非数字按默认",
  },
  {
    name: "JIEBO_PUBLISH_PORT_MAX",
    type: "number",
    default: "20999",
    group: "对外预览",
    doc: "预览进程端口上限；空串按 0，非数字按默认",
  },
  {
    name: "JIEBO_PUBLISH_LISTEN_MS",
    type: "number",
    default: "45000",
    group: "对外预览",
    doc: "等预览进程开始监听的毫秒数；空串按 0，非数字按默认",
  },

  { name: "APNS_TEAM_ID", type: "string", group: "APNs 推送", doc: "Apple Developer Team ID" },
  { name: "APNS_KEY_ID", type: "string", group: "APNs 推送", doc: ".p8 的 Key ID" },
  {
    name: "APNS_PRIVATE_KEY",
    type: "string",
    group: "APNs 推送",
    doc: ".p8 全文，换行可写成 \\n；与 APNS_PRIVATE_KEY_PATH 二选一",
  },
  { name: "APNS_PRIVATE_KEY_PATH", type: "string", group: "APNs 推送", doc: ".p8 文件路径" },
  { name: "APNS_BUNDLE_ID", type: "string", group: "APNs 推送", doc: "默认 topic" },
  {
    name: "APNS_DEFAULT_ENV",
    type: "enum",
    default: "production",
    group: "APNs 推送",
    doc: "sandbox 或 production，其它值按 production",
  },
  {
    name: "APNS_HOST_OVERRIDE",
    type: "string",
    group: "APNs 推送",
    doc: "仅测试：覆盖 APNs 主机，生产不要设",
  },
] as const satisfies readonly EnvSpec[];

export type EnvName = (typeof ENV_SPECS)[number]["name"];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = "text" | "json";

const FALSY = /^(0|false|off|no)$/i;

function raw(name: EnvName, source: NodeJS.ProcessEnv = process.env): string | undefined {
  return source[name];
}

/** 未设置或空串用 fallback；只有 0/false/off/no 算假，不去空格 */
function flag(name: EnvName, fallback: string): boolean {
  return !FALSY.test(raw(name) || fallback);
}

/** 未设置或非数字用 fallback；空串 Number("") 是 0，按 0 处理 */
function finiteNumber(name: EnvName, fallback: number): number {
  const value = Number(raw(name));
  return Number.isFinite(value) ? value : fallback;
}

/** APNs 相关的原始值；apnsConfig 支持传入别的 env 对象，所以带 source 参数 */
export function apnsEnv(source: NodeJS.ProcessEnv = process.env) {
  return {
    teamId: raw("APNS_TEAM_ID", source),
    keyId: raw("APNS_KEY_ID", source),
    privateKey: raw("APNS_PRIVATE_KEY", source),
    privateKeyPath: raw("APNS_PRIVATE_KEY_PATH", source),
    bundleId: raw("APNS_BUNDLE_ID", source),
    defaultEnv: raw("APNS_DEFAULT_ENV", source),
  };
}

export const gatewayEnv = {
  gatewayPort: () => Number(raw("GATEWAY_PORT") || 8787),
  gatewayHost: () => raw("GATEWAY_HOST") || "127.0.0.1",
  webOrigin: () => raw("CURSOR_REMOTE_WEB_ORIGIN") || "http://127.0.0.1:3000",
  proxyWeb: () => flag("GATEWAY_PROXY_WEB", "1"),
  logLevel: (): LogLevel => {
    const value = (raw("GATEWAY_LOG_LEVEL") || "").trim().toLowerCase();
    return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : "info";
  },
  logFormat: (): LogFormat => ((raw("GATEWAY_LOG_FORMAT") || "").trim().toLowerCase() === "json" ? "json" : "text"),

  /** 去首尾空格；未设置为空串 */
  cursorApiKey: () => raw("CURSOR_API_KEY")?.trim() || "",
  defaultModel: () => raw("CURSOR_REMOTE_MODEL") || "composer-2.5",
  cursorApiEndpoint: () => (raw("CURSOR_API_ENDPOINT") || "https://api2.cursor.sh").replace(/\/$/, ""),

  /** 未 resolve 的状态目录 */
  stateDir: () => raw("CURSOR_REMOTE_STATE_DIR") || resolve(homedir(), ".cursor-remote"),
  /** 只取显式设置的状态目录，未设置为空串（沙箱遮罩用，不套默认值） */
  stateDirOverride: () => raw("CURSOR_REMOTE_STATE_DIR") || "",
  tenantsFile: () => (raw("CURSOR_REMOTE_TENANTS_FILE") || "").trim(),
  /** 单租户口令：CURSOR_REMOTE_TOKEN，空则 CURSOR_REMOTE_PASSWORD，去首尾空格 */
  singleTenantToken: () => (raw("CURSOR_REMOTE_TOKEN") || raw("CURSOR_REMOTE_PASSWORD") || "").trim(),
  singleTenantName: () => (raw("CURSOR_REMOTE_NAME") || "").trim() || "default",
  /** 未 resolve 的单租户工作区 */
  singleTenantCwd: () => raw("CURSOR_REMOTE_CWD") || `${homedir()}/Projects`,
  singleTenantSandbox: () => flag("CURSOR_REMOTE_SANDBOX", ""),
  /** 只有明确设成 1/true/yes/on 才要确认卡；默认直接写 */
  workspaceMemoryConfirm: () => /^(1|true|yes|on)$/i.test((raw("WORKSPACE_MEMORY_CONFIRM") || "").trim()),
  mediaSecret: () => (raw("CURSOR_REMOTE_MEDIA_SECRET") || "").trim(),

  gitAuthorName: () => raw("GIT_AUTHOR_NAME") || raw("CURSOR_REMOTE_GIT_NAME") || "cursor-remote",
  gitAuthorEmail: () => raw("GIT_AUTHOR_EMAIL") || raw("CURSOR_REMOTE_GIT_EMAIL") || "cursor-remote@localhost",
  /** 未设置或空串为 undefined，由调用方回退到作者 */
  gitCommitterName: () => raw("GIT_COMMITTER_NAME") || undefined,
  gitCommitterEmail: () => raw("GIT_COMMITTER_EMAIL") || undefined,

  /** 未设置为 undefined（空串原样返回），便于调用方用 ?? 接在 options 后面 */
  publishHost: () => raw("JIEBO_PUBLISH_HOST"),
  publishScheme: () => raw("JIEBO_PUBLISH_SCHEME"),
  publishPortMin: () => finiteNumber("JIEBO_PUBLISH_PORT_MIN", 20000),
  publishPortMax: () => finiteNumber("JIEBO_PUBLISH_PORT_MAX", 20999),
  publishListenMs: () => finiteNumber("JIEBO_PUBLISH_LISTEN_MS", 45_000),

  apnsHostOverride: () => raw("APNS_HOST_OVERRIDE"),
};

/** 读 .env 文件：只补 process.env 里还没有的键，已有的（含空串）不覆盖；文件不存在跳过 */
export function loadDotEnv(files: string[]) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}
