import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, constants as h2, type ClientHttp2Session } from "node:http2";
import { appendJsonl, assistantPath, type TenantRef } from "./store.ts";
import { listApnsSubscriptions, removeApnsSubscription, type ApnsSubscription } from "./push.ts";

/**
 * APNs 推送：Node 内置 http2 + ES256 provider token（JWT），不依赖第三方包。
 * 通知里只带类型标题、条目标题（已截断）和路由用的 id；从不带收件箱 body、记忆或工作区路径。
 *
 * 环境变量（都写在网关环境里，不进 git）：
 *   APNS_TEAM_ID / APNS_KEY_ID / APNS_PRIVATE_KEY（.p8 全文，允许 \n 转义）或 APNS_PRIVATE_KEY_PATH
 *   APNS_BUNDLE_ID（订阅没带 bundleId 时的默认 topic）、APNS_DEFAULT_ENV（订阅没声明 environment 时用，默认 production）
 *   APNS_HOST_OVERRIDE（仅测试：如 http://127.0.0.1:PORT 走 h2c 明文，或 https://host:port）
 */

export type ApnsMessage = {
  itemId: string;
  kind: string;
  /** aps.alert.title：通知类型，如「有一项待你批准」 */
  title: string;
  /** aps.alert.body：条目标题，已截断，不是收件箱 body */
  body: string;
  chatId?: string;
  delegationId?: string;
};

export type ApnsConfig = { teamId: string; keyId: string; key: KeyObject; bundleId?: string; defaultEnv: "sandbox" | "production" };

/** provider token 最多用 50 分钟（Apple 要求 20–60 分钟内刷新） */
export const APNS_JWT_TTL_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** 这些 400 原因说明 token 永远发不出去，删订阅；其它错误只记日志 */
const DEAD_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

const b64u = (buf: Buffer) => buf.toString("base64url");

let cachedConfig: { sig: string; config: ApnsConfig } | null = null;
let warnedSig = "";

function readPem(env: NodeJS.ProcessEnv): string {
  const inline = env.APNS_PRIVATE_KEY?.trim();
  if (inline) return inline.replace(/\\n/g, "\n");
  const path = env.APNS_PRIVATE_KEY_PATH?.trim();
  return path ? readFileSync(path, "utf8") : "";
}

/** 读环境变量；没配全或密钥解析失败时返回 null（安静跳过，同一份配置只在日志里提示一次） */
export function apnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const teamId = env.APNS_TEAM_ID?.trim() ?? "";
  const keyId = env.APNS_KEY_ID?.trim() ?? "";
  const hasKey = Boolean(env.APNS_PRIVATE_KEY?.trim() || env.APNS_PRIVATE_KEY_PATH?.trim());
  if (!teamId || !keyId || !hasKey) return null;
  const sig = [teamId, keyId, env.APNS_PRIVATE_KEY ?? "", env.APNS_PRIVATE_KEY_PATH ?? "", env.APNS_BUNDLE_ID ?? "", env.APNS_DEFAULT_ENV ?? ""].join("\u0000");
  if (cachedConfig?.sig === sig) return cachedConfig.config;
  try {
    const key = createPrivateKey(readPem(env));
    if (key.asymmetricKeyType !== "ec") throw new Error("不是 EC 私钥");
    const config: ApnsConfig = {
      teamId,
      keyId,
      key,
      bundleId: env.APNS_BUNDLE_ID?.trim() || undefined,
      defaultEnv: env.APNS_DEFAULT_ENV?.trim() === "sandbox" ? "sandbox" : "production",
    };
    cachedConfig = { sig, config };
    return config;
  } catch (err) {
    if (warnedSig !== sig) {
      warnedSig = sig;
      console.error("apns: 私钥读取失败，已跳过 APNs 推送：", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

/** 网关配置好了 p8 且能发：AssistantState.pushApns */
export function apnsReady() {
  return apnsConfig() !== null;
}

let jwtCache: { id: string; token: string; at: number } | null = null;

/** ES256 provider token：header {alg,kid}，claims {iss: teamId, iat}。缓存约 50 分钟 */
export function apnsJwt(config: ApnsConfig, now = Date.now()) {
  const id = `${config.teamId}:${config.keyId}`;
  if (jwtCache && jwtCache.id === id && now >= jwtCache.at && now - jwtCache.at < APNS_JWT_TTL_MS) return jwtCache.token;
  const header = b64u(Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })));
  const claims = b64u(Buffer.from(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) })));
  const sig = sign("sha256", Buffer.from(`${header}.${claims}`), { key: config.key, dsaEncoding: "ieee-p1363" });
  const token = `${header}.${claims}.${b64u(sig)}`;
  jwtCache = { id, token, at: now };
  return token;
}

export function resetApnsCache() {
  cachedConfig = null;
  jwtCache = null;
  warnedSig = "";
}

export function apnsHost(environment: "sandbox" | "production", override = process.env.APNS_HOST_OVERRIDE) {
  const forced = override?.trim();
  if (forced) return /^https?:\/\//.test(forced) ? forced : `https://${forced}`;
  return environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

export function apnsPayload(message: ApnsMessage) {
  const cr: Record<string, string> = { itemId: message.itemId, kind: message.kind };
  if (message.chatId) cr.chatId = message.chatId;
  if (message.delegationId) cr.delegationId = message.delegationId;
  return {
    aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": "assistant-inbox" },
    cr,
  };
}

export function isDeadToken(status: number, reason?: string) {
  return status === 410 || (status === 400 && !!reason && DEAD_REASONS.has(reason));
}

type ApnsResult = { status: number; reason?: string };

function post(session: ClientHttp2Session, token: string, headers: Record<string, string>, body: string): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: ApnsResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    try {
      const req = session.request({ ":method": "POST", ":path": `/3/device/${token}`, ...headers });
      let status = 0;
      const chunks: Buffer[] = [];
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(h2.NGHTTP2_CANCEL);
        finish({ status: 0, reason: "timeout" });
      });
      req.on("response", (head) => {
        status = Number(head[":status"] ?? 0);
      });
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("error", () => finish({ status: 0, reason: "stream_error" }));
      req.on("close", () => {
        let reason: string | undefined;
        try {
          reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }).reason;
        } catch {
          reason = undefined;
        }
        finish({ status, reason });
      });
      req.end(body);
    } catch {
      finish({ status: 0, reason: "request_failed" });
    }
  });
}

/** 向租户全部 APNs 订阅发一条通知。未配置时直接返回 {sent:0,total:0}，不抛错 */
export async function sendApns(
  ref: TenantRef,
  message: ApnsMessage,
  opts: { host?: string; now?: number; attempts?: number } = {},
) {
  const config = apnsConfig();
  if (!config) return { sent: 0, total: 0 };
  const subs = listApnsSubscriptions(ref);
  if (!subs.length) return { sent: 0, total: 0 };
  const body = JSON.stringify(apnsPayload(message));
  const jwt = apnsJwt(config, opts.now);
  const sessions = new Map<string, ClientHttp2Session>();
  const sessionFor = (origin: string) => {
    let session = sessions.get(origin);
    if (!session) {
      session = connect(origin);
      session.on("error", () => undefined);
      sessions.set(origin, session);
    }
    return session;
  };
  let sent = 0;
  try {
    for (const sub of subs) {
      const topic = sub.bundleId || config.bundleId;
      let result: ApnsResult = { status: 0, reason: "no_topic" };
      if (topic) {
        const headers: Record<string, string> = {
          authorization: `bearer ${jwt}`,
          "apns-topic": topic,
          "apns-push-type": "alert",
          // 10 立即送达（待批），5 省电时机送达（其余）
          "apns-priority": message.kind === "approval" ? "10" : "5",
          "apns-expiration": String(Math.floor((opts.now ?? Date.now()) / 1000) + 86400),
          "apns-collapse-id": message.itemId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64),
          "content-type": "application/json",
        };
        if (!headers["apns-collapse-id"]) delete headers["apns-collapse-id"];
        const origin = apnsHost(sub.environment ?? config.defaultEnv, opts.host ?? process.env.APNS_HOST_OVERRIDE);
        result = await post(sessionFor(origin), sub.token, headers, body);
      }
      const ok = result.status >= 200 && result.status < 300;
      if (ok) sent += 1;
      if (isDeadToken(result.status, result.reason)) removeApnsSubscription(ref, sub.token);
      if (result.status === 403 && result.reason === "ExpiredProviderToken") jwtCache = null;
      logApns(ref, sub, message, ok, result, opts.attempts ?? 1);
    }
  } finally {
    for (const session of sessions.values()) session.close();
  }
  return { sent, total: subs.length };
}

function logApns(ref: TenantRef, sub: ApnsSubscription, message: ApnsMessage, ok: boolean, result: ApnsResult, attempts: number) {
  appendJsonl(assistantPath(ref, "push-log.jsonl"), {
    at: Date.now(),
    itemId: message.itemId,
    endpoint: `apns:${sub.token.slice(0, 8)}`,
    ok,
    status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    attempts,
    message,
  });
}
