import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { renderQrCodeSvgDataUrl } from "./qrSvg.ts";

/**
 * 网关内置腾讯微信 iLink 协议客户端（同源 `@tencent-weixin/openclaw-weixin`，零外部 CLI 强依赖）：
 * 1. `POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3`（传入本地已有的 `local_token_list`）获取 `qrcode` 与 `qrcode_img_content`；
 * 2. `GET https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=...` 轮询扫码状态（支持 `wait` / `scaned` / `need_verifycode` / `scaned_but_redirect` / `confirmed`）；
 * 3. `POST /ilink/bot/sendmessage` 主动/被动发送消息（含每次新生成的 `X-WECHAT-UIN` 反重放头与 `ret === 0` 真送达校验）；
 * 4. `POST /ilink/bot/getconfig` + `POST /ilink/bot/sendtyping` 发送顶部「正在输入…」状态；
 * 5. `POST /ilink/bot/getupdates` 35s 长轮询接收消息，并将账号凭证、`sync.json` 游标与 `context-tokens.json` 同步持久化到 `~/.openclaw/openclaw-weixin/accounts/`。
 */

export const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_ILINK_BOT_TYPE = "3";
export const ILINK_APP_ID = "bot";
/** 2.4.10 -> (2 << 16) | (4 << 8) | 10 = 132106 */
export const ILINK_APP_CLIENT_VERSION = "132106";
export const ILINK_CHANNEL_VERSION = "2.4.10";

export type IlinkBaseInfo = {
  channel_version: string;
  bot_agent: string;
};

export function buildIlinkBaseInfo(): IlinkBaseInfo {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: "OpenClaw",
  };
}

/** 生成反重放请求头 X-WECHAT-UIN：base64(String(randomUint32))（每次请求全新生成，绝不复用） */
export function generateWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

export function buildIlinkCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

export function buildIlinkPostHeaders(botToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": generateWechatUin(),
    ...buildIlinkCommonHeaders(),
  };
  if (botToken && botToken.trim()) {
    headers.Authorization = `Bearer ${botToken.trim()}`;
  }
  return headers;
}

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/** 校验并规范化腾讯微信 iLink API Base URL（仅允许受信任的微信 HTTPS 域名，拦截 SSRF 与非微信主机） */
export function sanitizeIlinkBaseUrl(rawUrl?: string): string {
  const raw = (rawUrl || "").trim();
  if (!raw) return DEFAULT_ILINK_BASE_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return DEFAULT_ILINK_BASE_URL;
    if (parsed.username || parsed.password || parsed.port) return DEFAULT_ILINK_BASE_URL;
    const host = parsed.hostname.toLowerCase();
    const isTrustedWeixinHost =
      host === "ilinkai.weixin.qq.com" ||
      host.endsWith(".weixin.qq.com") ||
      host.endsWith(".wechat.com");
    if (!isTrustedWeixinHost) return DEFAULT_ILINK_BASE_URL;
    return parsed.origin;
  } catch {
    return DEFAULT_ILINK_BASE_URL;
  }
}

export function normalizeIlinkAccountId(rawId: string): string {
  const clean = (rawId || "").trim().replace(/@im\.bot$/i, "-im-bot").replace(/@im\.wechat$/i, "-im-wechat");
  if (!clean) return "";
  const candidate = clean.endsWith("-im-bot") ? clean : `${clean}-im-bot`;
  if (candidate.includes("..") || !/^[a-zA-Z0-9._-]{1,120}$/.test(candidate)) {
    return "";
  }
  return candidate;
}

export function resolveOpenClawWeixinDir(customAccountsDir?: string): {
  weixinDir: string;
  accountsDir: string;
  accountsIndexPath: string;
} {
  const accountsDir =
    customAccountsDir?.trim() || join(homedir(), ".openclaw", "openclaw-weixin", "accounts");
  const weixinDir = join(accountsDir, "..");
  return {
    weixinDir,
    accountsDir,
    accountsIndexPath: join(weixinDir, "accounts.json"),
  };
}

export type PersistedWeixinAccount = {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt?: string;
};

/**
 * 读取 `~/.openclaw/openclaw-weixin/accounts/` 下已持久化的全部微信 iLink Bot 账号凭证
 */
export function listPersistedWeixinAccounts(customAccountsDir?: string): PersistedWeixinAccount[] {
  const { accountsDir, accountsIndexPath } = resolveOpenClawWeixinDir(customAccountsDir);
  if (!existsSync(accountsDir)) return [];

  const candidateIds = new Set<string>();
  if (existsSync(accountsIndexPath)) {
    try {
      const idx = JSON.parse(readFileSync(accountsIndexPath, "utf8")) as unknown;
      if (Array.isArray(idx)) {
        for (const id of idx) {
          if (typeof id === "string" && id.trim()) {
            candidateIds.add(normalizeIlinkAccountId(id));
          }
        }
      }
    } catch {
      // ignore
    }
  }

  try {
    for (const f of readdirSync(accountsDir)) {
      if (
        f.endsWith("-im-bot.json") &&
        !f.endsWith(".sync.json") &&
        !f.endsWith(".context-tokens.json")
      ) {
        candidateIds.add(f.slice(0, -".json".length));
      }
    }
  } catch {
    // ignore
  }

  const out: PersistedWeixinAccount[] = [];
  for (const accountId of candidateIds) {
    const acc = loadPersistedWeixinAccount(accountId, customAccountsDir);
    if (acc && acc.token) {
      out.push(acc);
    }
  }
  return out;
}

export function loadPersistedWeixinAccount(
  accountId: string,
  customAccountsDir?: string,
): PersistedWeixinAccount | null {
  const normId = normalizeIlinkAccountId(accountId);
  if (!normId) return null;
  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  const filePath = join(accountsDir, `${normId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      token?: unknown;
      baseUrl?: unknown;
      userId?: unknown;
      savedAt?: unknown;
    };
    const token = typeof raw.token === "string" ? raw.token.trim() : "";
    if (!token) return null;
    const baseUrl = sanitizeIlinkBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : undefined);
    return {
      accountId: normId,
      token,
      baseUrl,
      ...(typeof raw.userId === "string" && raw.userId.trim() ? { userId: raw.userId.trim() } : {}),
      ...(typeof raw.savedAt === "string" ? { savedAt: raw.savedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 持久化微信 iLink 扫码确认后的 Bot 凭证到 `~/.openclaw/openclaw-weixin/accounts/<botId>.json` 与 `accounts.json`
 */
export function savePersistedWeixinAccount(
  input: {
    accountId: string;
    token: string;
    baseUrl?: string;
    userId?: string;
  },
  customAccountsDir?: string,
): PersistedWeixinAccount {
  const accountId = normalizeIlinkAccountId(input.accountId);
  if (!accountId) {
    throw new Error("无效的微信 iLink Bot 账号 ID");
  }
  const { weixinDir, accountsDir, accountsIndexPath } = resolveOpenClawWeixinDir(customAccountsDir);
  mkdirSync(accountsDir, { recursive: true });
  mkdirSync(weixinDir, { recursive: true });

  return withFileLockSync(join(weixinDir, ".accounts.lock"), () => {
    const existing = loadPersistedWeixinAccount(accountId, customAccountsDir);
    const token = input.token.trim() || existing?.token || "";
    const baseUrl = sanitizeIlinkBaseUrl(input.baseUrl?.trim() || existing?.baseUrl);
    const userId = input.userId?.trim() || existing?.userId;
    const savedAt = new Date().toISOString();

    const record = {
      token,
      baseUrl,
      savedAt,
      ...(userId ? { userId } : {}),
    };

    atomicWriteFileSync(join(accountsDir, `${accountId}.json`), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mkdir: true,
      mode: 0o600,
    });

    // 同步更新 accounts.json 索引
    let indexList: string[] = [];
    if (existsSync(accountsIndexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(accountsIndexPath, "utf8")) as unknown;
        if (Array.isArray(parsed)) {
          indexList = parsed.filter((x): x is string => typeof x === "string" && Boolean(x.trim()));
        }
      } catch {
        indexList = [];
      }
    }
    if (!indexList.includes(accountId)) {
      indexList.push(accountId);
      atomicWriteFileSync(accountsIndexPath, `${JSON.stringify(indexList, null, 2)}\n`, {
        encoding: "utf8",
        mkdir: true,
        mode: 0o600,
      });
    }

    // 确保 .sync.json 存在以便 detectActiveWechatAccount 可读取 mtime
    const syncPath = join(accountsDir, `${accountId}.sync.json`);
    if (!existsSync(syncPath)) {
      atomicWriteFileSync(syncPath, `${JSON.stringify({ get_updates_buf: "" })}\n`, {
        encoding: "utf8",
        mkdir: true,
        mode: 0o600,
      });
    }

    return {
      accountId,
      token,
      baseUrl,
      ...(userId ? { userId } : {}),
      savedAt,
    };
  });
}

/**
 * 读取或更新 `<botId>.context-tokens.json`（与 `pushGuard.ts` 的 `detectActiveWechatAccount` 100% 兼容）
 */
export function loadAccountContextTokens(
  accountId: string,
  customAccountsDir?: string,
): Record<string, string> {
  const normId = normalizeIlinkAccountId(accountId);
  if (!normId) return {};
  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  const filePath = join(accountsDir, `${normId}.context-tokens.json`);
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) {
        out[k] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveAccountContextToken(
  accountId: string,
  userId: string,
  contextToken: string,
  customAccountsDir?: string,
): void {
  const normId = normalizeIlinkAccountId(accountId);
  const cleanUser = (userId || "").trim();
  const cleanCtx = (contextToken || "").trim();
  if (!normId || !cleanUser || !cleanCtx) return;

  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  mkdirSync(accountsDir, { recursive: true });
  const targetFile = join(accountsDir, `${normId}.context-tokens.json`);
  withFileLockSync(`${targetFile}.lock`, () => {
    const current = loadAccountContextTokens(normId, customAccountsDir);
    current[cleanUser] = cleanCtx;
    atomicWriteFileSync(targetFile, `${JSON.stringify(current)}\n`, {
      encoding: "utf8",
      mkdir: true,
      mode: 0o600,
    });
  });
}

export function loadAccountSyncBuf(accountId: string, customAccountsDir?: string): string {
  const normId = normalizeIlinkAccountId(accountId);
  if (!normId) return "";
  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  const filePath = join(accountsDir, `${normId}.sync.json`);
  if (!existsSync(filePath)) return "";
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { get_updates_buf?: unknown };
    return typeof parsed.get_updates_buf === "string" ? parsed.get_updates_buf : "";
  } catch {
    return "";
  }
}

export function saveAccountSyncBuf(
  accountId: string,
  getUpdatesBuf: string,
  customAccountsDir?: string,
): void {
  const normId = normalizeIlinkAccountId(accountId);
  if (!normId) return;
  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  mkdirSync(accountsDir, { recursive: true });
  atomicWriteFileSync(
    join(accountsDir, `${normId}.sync.json`),
    `${JSON.stringify({ get_updates_buf: getUpdatesBuf })}\n`,
    { encoding: "utf8", mkdir: true, mode: 0o600 },
  );
}

/** 获取本地已登录账号的 bot_token 列表（最多取最新 10 个，供 `get_bot_qrcode` 使用） */
export function getLocalBotTokenList(customAccountsDir?: string): string[] {
  const accounts = listPersistedWeixinAccounts(customAccountsDir);
  const tokens: string[] = [];
  for (let i = accounts.length - 1; i >= 0 && tokens.length < 10; i--) {
    const tok = accounts[i]?.token?.trim();
    if (tok && !tokens.includes(tok)) {
      tokens.push(tok);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 可注入 HTTP Fetch 传输层（方便单测 100% 离线模拟腾讯 iLink 响应）
// ---------------------------------------------------------------------------

export type IlinkFetchFn = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; text: string }>;

let customIlinkFetch: IlinkFetchFn | null = null;

export function bindIlinkFetchForTest(next: IlinkFetchFn | null) {
  customIlinkFetch = next;
}

async function executeIlinkHttp(params: {
  baseUrl: string;
  endpoint: string;
  method: "GET" | "POST";
  body?: string;
  token?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ status: number; ok: boolean; text: string }> {
  const sanitizedBase = sanitizeIlinkBaseUrl(params.baseUrl);
  const base = sanitizedBase.endsWith("/") ? sanitizedBase : `${sanitizedBase}/`;
  const fullUrl = new URL(params.endpoint, base).toString();
  const headers =
    params.method === "GET" ? buildIlinkCommonHeaders() : buildIlinkPostHeaders(params.token);

  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const onExternalAbort = () => controller.abort();
  if (params.abortSignal) {
    if (params.abortSignal.aborted) controller.abort();
    else params.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    if (customIlinkFetch) {
      return await customIlinkFetch(fullUrl, {
        method: params.method,
        headers,
        body: params.body,
        signal: controller.signal,
      });
    }
    const res = await fetch(fullUrl, {
      method: params.method,
      headers,
      ...(params.body !== undefined ? { body: params.body } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
    if (params.abortSignal) {
      params.abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** 将响应 JSON 中的顶层/非转义 uint64 message_id / msg_id / svr_id 无损转为字符串再 parse */
export function parseIlinkJson<T>(rawText: string): T {
  const safe = rawText.replace(
    /(?<!\\)"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g,
    (_, key: string, num: string) => (LOSSLESS_ID_FIELDS.has(key) ? `"${key}":"${num}"` : `"${key}":${num}`),
  );
  try {
    return JSON.parse(safe) as T;
  } catch {
    return JSON.parse(rawText) as T;
  }
}

// ---------------------------------------------------------------------------
// 1. 拉取微信官方绑定二维码 & 2. 轮询扫码状态
// ---------------------------------------------------------------------------

export type IlinkQrCodeResult =
  | {
      ok: true;
      qrcode: string;
      qrcodeImgContent: string;
      qrSvgDataUrl: string;
    }
  | { ok: false; error: string };

export async function fetchIlinkBotQrCode(opts?: {
  baseUrl?: string;
  botType?: string;
  accountsDir?: string;
}): Promise<IlinkQrCodeResult> {
  const baseUrl = opts?.baseUrl || DEFAULT_ILINK_BASE_URL;
  const botType = opts?.botType || DEFAULT_ILINK_BOT_TYPE;
  const localTokenList = getLocalBotTokenList(opts?.accountsDir);

  try {
    const res = await executeIlinkHttp({
      baseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      method: "POST",
      body: JSON.stringify({ local_token_list: localTokenList }),
      timeoutMs: 12_000,
    });
    if (!res.ok) {
      return { ok: false, error: `腾讯 iLink 获取二维码失败 (HTTP ${res.status})` };
    }
    const data = JSON.parse(res.text) as {
      ret?: number;
      errmsg?: string;
      qrcode?: string;
      qrcode_img_content?: string;
    };
    if (data.ret !== undefined && data.ret !== 0) {
      return {
        ok: false,
        error: `腾讯 iLink 返回错误 (ret=${data.ret}): ${data.errmsg || "未知错误"}`,
      };
    }
    const qrcode = (data.qrcode || "").trim();
    const qrcodeImgContent = (data.qrcode_img_content || "").trim();
    if (!qrcode || !qrcodeImgContent) {
      return { ok: false, error: "腾讯 iLink 未返回有效的二维码内容" };
    }
    const qrSvgDataUrl = renderQrCodeSvgDataUrl(qrcodeImgContent);
    return {
      ok: true,
      qrcode,
      qrcodeImgContent,
      qrSvgDataUrl,
    };
  } catch (err) {
    return {
      ok: false,
      error: `请求腾讯 iLink 二维码异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type IlinkQrPollStatus =
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect"
  | "confirmed"
  | "expired";

export type IlinkQrStatusResponse = {
  status: IlinkQrPollStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
};

export async function pollIlinkQrCodeStatus(opts: {
  qrcode: string;
  baseUrl?: string;
  verifyCode?: string;
  timeoutMs?: number;
}): Promise<IlinkQrStatusResponse> {
  const baseUrl = opts.baseUrl || DEFAULT_ILINK_BASE_URL;
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(opts.qrcode)}`;
  if (opts.verifyCode && opts.verifyCode.trim()) {
    endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode.trim())}`;
  }

  try {
    const res = await executeIlinkHttp({
      baseUrl,
      endpoint,
      method: "GET",
      timeoutMs: opts.timeoutMs ?? 6_000,
    });
    if (!res.ok) {
      return { status: "wait" };
    }
    const parsed = JSON.parse(res.text) as Partial<IlinkQrStatusResponse>;
    if (!parsed || typeof parsed.status !== "string") {
      return { status: "wait" };
    }
    return parsed as IlinkQrStatusResponse;
  } catch {
    // 长轮询超时或瞬时网络波动均视为 wait，供前端下次轮询继续
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// 3. 发送微信消息 (POST /ilink/bot/sendmessage) & 4. 正在输入状态 (sendtyping)
// ---------------------------------------------------------------------------

export type IlinkSendMessageOutcome =
  | {
      ok: true;
      account: string;
      messageId: string;
      serverMessageId?: string;
    }
  | {
      ok: false;
      reason: "session_expired" | "no_account" | "false_success_blocked" | "send_error";
      error: string;
    };

export async function sendIlinkBotTextMessage(params: {
  accountId: string;
  toUserId: string;
  text: string;
  contextToken?: string;
  baseUrl?: string;
  botToken?: string;
  accountsDir?: string;
  timeoutMs?: number;
}): Promise<IlinkSendMessageOutcome> {
  const normAccount = normalizeIlinkAccountId(params.accountId);
  const to = (params.toUserId || "").trim();
  const text = (params.text || "").trim();
  if (!normAccount || !to || !text) {
    return { ok: false, reason: "send_error", error: "账号、目标微信 ID 或消息内容为空" };
  }

  const persisted = loadPersistedWeixinAccount(normAccount, params.accountsDir);
  const botToken = params.botToken?.trim() || persisted?.token;
  if (!botToken) {
    return {
      ok: false,
      reason: "no_account",
      error: `未找到微信 Bot 账号 ${normAccount} 的 token 凭证`,
    };
  }
  const baseUrl = params.baseUrl?.trim() || persisted?.baseUrl || DEFAULT_ILINK_BASE_URL;
  const contextTokens = loadAccountContextTokens(normAccount, params.accountsDir);
  const contextToken = params.contextToken?.trim() || contextTokens[to];

  const clientId = `openclaw-weixin-${randomUUID()}`;
  const reqBody = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: 2, // MessageType.BOT (必须是整数 2)
      message_state: 2, // MessageState.FINISH (必须是整数 2)
      item_list: [{ type: 1, text_item: { text } }], // MessageItemType.TEXT (整数 1)
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: buildIlinkBaseInfo(),
  };

  try {
    const res = await executeIlinkHttp({
      baseUrl,
      endpoint: "ilink/bot/sendmessage",
      method: "POST",
      body: JSON.stringify(reqBody),
      token: botToken,
      timeoutMs: params.timeoutMs ?? 15_000,
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: "send_error",
        error: `iLink sendmessage HTTP ${res.status}: ${res.text.slice(0, 160)}`,
      };
    }

    const trimmed = res.text.trim();
    if (!trimmed || trimmed === "{}") {
      return {
        ok: false,
        reason: "false_success_blocked",
        error: "iLink sendmessage 返回空对象 {}（疑似会话未激活或假成功）",
      };
    }

    const parsed = parseIlinkJson<{
      ret?: number;
      errcode?: number;
      errmsg?: string;
      message_id?: string;
    }>(trimmed);

    if (
      parsed.errcode === -14 ||
      parsed.ret === -14 ||
      /session\s+timeout/i.test(parsed.errmsg || "")
    ) {
      return {
        ok: false,
        reason: "session_expired",
        error: `微信会话已过期 (errcode=-14: ${parsed.errmsg || "session timeout"})`,
      };
    }

    // 防假成功校验：要求业务层 ret === 0 且无非零 errcode
    if (parsed.ret !== 0 || (parsed.errcode !== undefined && parsed.errcode !== 0)) {
      return {
        ok: false,
        reason: "false_success_blocked",
        error: `iLink sendmessage 业务层拒绝: ret=${String(parsed.ret)} errcode=${String(parsed.errcode)} errmsg=${parsed.errmsg || ""}`,
      };
    }

    return {
      ok: true,
      account: normAccount,
      messageId: clientId,
      ...(parsed.message_id ? { serverMessageId: String(parsed.message_id) } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      reason: "send_error",
      error: `iLink sendmessage 异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function sendIlinkTypingIndicator(params: {
  baseUrl: string;
  botToken: string;
  ilinkUserId: string;
  contextToken?: string;
  status: 1 | 2;
}): Promise<void> {
  try {
    const cfgRes = await executeIlinkHttp({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getconfig",
      method: "POST",
      body: JSON.stringify({
        ilink_user_id: params.ilinkUserId,
        ...(params.contextToken ? { context_token: params.contextToken } : {}),
        base_info: buildIlinkBaseInfo(),
      }),
      token: params.botToken,
      timeoutMs: 6_000,
    });
    if (!cfgRes.ok) return;
    const cfg = JSON.parse(cfgRes.text) as { ret?: number; typing_ticket?: string };
    if (!cfg.typing_ticket) return;

    await executeIlinkHttp({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendtyping",
      method: "POST",
      body: JSON.stringify({
        ilink_user_id: params.ilinkUserId,
        typing_ticket: cfg.typing_ticket,
        status: params.status,
        base_info: buildIlinkBaseInfo(),
      }),
      token: params.botToken,
      timeoutMs: 6_000,
    });
  } catch {
    // 忽略 typing 状态发送失败，不影响主问答流程
  }
}

// ---------------------------------------------------------------------------
// 5. 长轮询接收微信消息 (POST /ilink/bot/getupdates)
// ---------------------------------------------------------------------------

export type IlinkInboundMessageItem = {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  file_item?: { file_name?: string };
  ref_msg?: {
    title?: string;
    message_item?: {
      type?: number;
      text_item?: { text?: string };
      voice_item?: { text?: string };
    };
  };
};

export type IlinkInboundMessage = {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  item_list?: IlinkInboundMessageItem[];
  context_token?: string;
};

export type IlinkGetUpdatesResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
};

export async function pollIlinkGetUpdates(params: {
  baseUrl: string;
  botToken: string;
  getUpdatesBuf: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<IlinkGetUpdatesResponse> {
  const timeoutMs = params.timeoutMs ?? 35_000;
  try {
    const res = await executeIlinkHttp({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      method: "POST",
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf || "",
        base_info: buildIlinkBaseInfo(),
      }),
      token: params.botToken,
      timeoutMs,
      abortSignal: params.abortSignal,
    });
    if (!res.ok) {
      return { ret: -1, errmsg: `HTTP ${res.status}` };
    }
    return parseIlinkJson<IlinkGetUpdatesResponse>(res.text);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

/** 从微信消息 item_list 中提取用户发送的文本（含语音自动转文字 `voice_item.text` 及引用上下文） */
export function extractTextFromIlinkMessage(msg: IlinkInboundMessage): string {
  if (!Array.isArray(msg.item_list) || msg.item_list.length === 0) return "";
  const parts: string[] = [];
  for (const item of msg.item_list) {
    if (item.ref_msg) {
      const refTitle = item.ref_msg.title?.trim();
      const refBody =
        item.ref_msg.message_item?.text_item?.text?.trim() ||
        item.ref_msg.message_item?.voice_item?.text?.trim();
      if (refTitle || refBody) {
        parts.push(`[引用：${[refTitle, refBody].filter(Boolean).join(" | ")}]`);
      }
    }
    if (item.type === 1 && item.text_item?.text != null) {
      const t = String(item.text_item.text).trim();
      if (t) parts.push(t);
    } else if (item.type === 3 && item.voice_item?.text) {
      const vt = String(item.voice_item.text).trim();
      if (vt) parts.push(vt);
    }
  }
  return parts.join("\n").trim();
}

export function touchAccountSyncMtime(accountId: string, customAccountsDir?: string): void {
  const normId = normalizeIlinkAccountId(accountId);
  if (!normId) return;
  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  const syncPath = join(accountsDir, `${normId}.sync.json`);
  if (!existsSync(syncPath)) {
    saveAccountSyncBuf(normId, "", customAccountsDir);
    return;
  }
  try {
    const currentBuf = loadAccountSyncBuf(normId, customAccountsDir);
    saveAccountSyncBuf(normId, currentBuf, customAccountsDir);
  } catch {
    // ignore
  }
}

export function getAccountSyncMtimeMs(accountId: string, customAccountsDir?: string): number {
  const normId = normalizeIlinkAccountId(accountId);
  if (!normId) return 0;
  const { accountsDir } = resolveOpenClawWeixinDir(customAccountsDir);
  const syncPath = join(accountsDir, `${normId}.sync.json`);
  try {
    return existsSync(syncPath) ? statSync(syncPath).mtimeMs : 0;
  } catch {
    return 0;
  }
}
