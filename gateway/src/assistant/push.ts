import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { appendJsonl, assistantPath, readJson, readJsonl, writeJson, writeJsonl, type TenantRef } from "./store.ts";

/**
 * Web 推送：VAPID（RFC 8292）+ aes128gcm 加密（RFC 8291），不依赖第三方包。
 * 推送正文只带标题、类型和收件箱条目 id，从不带记忆内容。
 */

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string }; createdAt?: number; ua?: string };

type VapidFile = { publicKey: string; privateJwk: { kty: string; crv: string; x: string; y: string; d: string } };

const b64u = (buf: Buffer) => buf.toString("base64url");
const fromB64u = (text: string) => Buffer.from(text, "base64url");

/** VAPID 密钥按网关实例共用，放在全局状态目录 */
export function vapidKeys(globalStateDir: string): VapidFile {
  const file = `${globalStateDir}/assistant-vapid.json`;
  const known = readJson<VapidFile | null>(file, null);
  if (known?.publicKey && known.privateJwk?.d) return known;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const priv = privateKey.export({ format: "jwk" }) as VapidFile["privateJwk"];
  const raw = Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)]);
  const next: VapidFile = { publicKey: b64u(raw), privateJwk: priv };
  writeJson(file, next);
  return next;
}

export function vapidJwt(vapid: VapidFile, endpoint: string, subject: string, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ key: vapid.privateJwk, format: "jwk" });
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64u(sig)}`;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number) {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** RFC 8291 aes128gcm 单记录加密 */
export function encryptPayload(sub: PushSubscription, plaintext: Buffer, salt = randomBytes(16)) {
  const server = createECDH("prime256v1");
  server.generateKeys();
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function subsFile(ref: TenantRef) {
  return assistantPath(ref, "push-subs.json");
}
function logFile(ref: TenantRef) {
  return assistantPath(ref, "push-log.jsonl");
}

/** APNs 订阅：token 为 hex device token，environment 缺省时按 APNS_DEFAULT_ENV 解析 */
export type ApnsSubscription = {
  token: string;
  bundleId: string;
  environment?: "sandbox" | "production";
  createdAt?: number;
  ua?: string;
};

type SubsFile = { web: PushSubscription[]; apns: ApnsSubscription[] };

const MAX_SUBS_PER_CHANNEL = 20;
const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/i;
const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,155}$/;

/** 读订阅文件；旧格式 { subs } 自动迁移成 { web, apns } 并原子写回 */
function readSubs(ref: TenantRef): SubsFile {
  const raw = readJson<{ subs?: PushSubscription[]; web?: PushSubscription[]; apns?: ApnsSubscription[] } | null>(subsFile(ref), null);
  if (!raw) return { web: [], apns: [] };
  const legacy = Array.isArray(raw.subs) && !Array.isArray(raw.web);
  const file: SubsFile = {
    web: (Array.isArray(raw.web) ? raw.web : Array.isArray(raw.subs) ? raw.subs : []).slice(-MAX_SUBS_PER_CHANNEL),
    apns: (Array.isArray(raw.apns) ? raw.apns : []).slice(-MAX_SUBS_PER_CHANNEL),
  };
  if (legacy) writeJson(subsFile(ref), file);
  return file;
}

function writeSubs(ref: TenantRef, file: SubsFile) {
  writeJson(subsFile(ref), { web: file.web.slice(-MAX_SUBS_PER_CHANNEL), apns: file.apns.slice(-MAX_SUBS_PER_CHANNEL) });
}

export function listSubscriptions(ref: TenantRef): PushSubscription[] {
  return readSubs(ref).web;
}

export function listApnsSubscriptions(ref: TenantRef): ApnsSubscription[] {
  return readSubs(ref).apns;
}

export function addSubscription(ref: TenantRef, sub: PushSubscription) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return { ok: false as const, error: "订阅信息不完整。" };
  }
  const file = readSubs(ref);
  const subs = file.web.filter((item) => item.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: Date.now(), ua: sub.ua?.slice(0, 120) });
  writeSubs(ref, { ...file, web: subs });
  return { ok: true as const, count: Math.min(subs.length, MAX_SUBS_PER_CHANNEL) };
}

export function removeSubscription(ref: TenantRef, endpoint: string) {
  const file = readSubs(ref);
  const next = file.web.filter((item) => item.endpoint !== endpoint);
  if (next.length !== file.web.length) writeSubs(ref, { ...file, web: next });
  return file.web.length - next.length;
}

/** 校验并登记 APNs 订阅；同 token 重复注册更新 bundleId / environment / ua */
export function addApnsSubscription(ref: TenantRef, input: { token?: unknown; bundleId?: unknown; environment?: unknown; ua?: unknown }) {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!APNS_TOKEN_RE.test(token) || token.length % 2 !== 0) return { ok: false as const, error: "APNs token 格式不对（要 64 位以上的偶数长度 hex）。" };
  const bundleId = typeof input.bundleId === "string" ? input.bundleId.trim() : "";
  if (!BUNDLE_ID_RE.test(bundleId)) return { ok: false as const, error: "bundleId 不能为空，且只能含字母、数字、点和连字符。" };
  const env = input.environment;
  if (env !== undefined && env !== null && env !== "" && env !== "sandbox" && env !== "production") {
    return { ok: false as const, error: "environment 只能是 sandbox 或 production。" };
  }
  const environment = env === "sandbox" || env === "production" ? env : undefined;
  const ua = typeof input.ua === "string" && input.ua ? input.ua.slice(0, 120) : undefined;
  const file = readSubs(ref);
  const key = token.toLowerCase();
  const known = file.apns.find((item) => item.token.toLowerCase() === key);
  const apns = file.apns.filter((item) => item.token.toLowerCase() !== key);
  apns.push({ token: key, bundleId, environment, createdAt: known?.createdAt ?? Date.now(), ua: ua ?? known?.ua });
  writeSubs(ref, { ...file, apns });
  return { ok: true as const, count: Math.min(apns.length, MAX_SUBS_PER_CHANNEL) };
}

export function removeApnsSubscription(ref: TenantRef, token: string) {
  const key = token.trim().toLowerCase();
  const file = readSubs(ref);
  const next = file.apns.filter((item) => item.token.toLowerCase() !== key);
  if (next.length !== file.apns.length) writeSubs(ref, { ...file, apns: next });
  return file.apns.length - next.length;
}

export type PushMessage = { itemId: string; kind: string; title: string; url: string };

type PushLog = { at: number; itemId: string; endpoint: string; ok: boolean; status?: number; attempts: number; message: PushMessage };

export type PushSender = (endpoint: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

const defaultSender: PushSender = async (endpoint, init) => {
  const res = await fetch(endpoint, { method: init.method, headers: init.headers, body: new Uint8Array(init.body) });
  return { status: res.status };
};

export async function sendPush(
  ref: TenantRef,
  vapid: VapidFile,
  message: PushMessage,
  opts: { subject?: string; sender?: PushSender; only?: string[]; attempts?: number } = {},
) {
  const sender = opts.sender ?? defaultSender;
  const subs = listSubscriptions(ref).filter((sub) => !opts.only || opts.only.includes(sub.endpoint));
  const payload = Buffer.from(JSON.stringify(message));
  let sent = 0;
  for (const sub of subs) {
    let status = 0;
    try {
      const body = encryptPayload(sub, payload);
      const res = await sender(sub.endpoint, {
        method: "POST",
        headers: {
          TTL: "86400",
          Urgency: message.kind === "approval" ? "high" : "normal",
          Topic: message.itemId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          Authorization: `vapid t=${vapidJwt(vapid, sub.endpoint, opts.subject ?? "mailto:assistant@cursor-remote.local")}, k=${vapid.publicKey}`,
        },
        body,
      });
      status = res.status;
    } catch {
      status = 0;
    }
    const ok = status >= 200 && status < 300;
    if (status === 404 || status === 410) removeSubscription(ref, sub.endpoint);
    if (ok) sent += 1;
    appendJsonl(logFile(ref), { at: Date.now(), itemId: message.itemId, endpoint: sub.endpoint, ok, status, attempts: opts.attempts ?? 1, message } satisfies PushLog);
  }
  return { sent, total: subs.length };
}

/** 网关重启后补发：只补最近 24 小时内失败、订阅还在、尝试不到 3 次的 */
export async function retryFailedPushes(ref: TenantRef, vapid: VapidFile, sender?: PushSender) {
  const rows = readJsonl<PushLog>(logFile(ref));
  const latest = new Map<string, PushLog>();
  for (const row of rows) latest.set(`${row.itemId}|${row.endpoint}`, row);
  const live = new Set(listSubscriptions(ref).map((sub) => sub.endpoint));
  let retried = 0;
  for (const row of latest.values()) {
    if (row.ok || row.attempts >= 3 || Date.now() - row.at > 86_400_000 || !live.has(row.endpoint)) continue;
    await sendPush(ref, vapid, row.message, { sender, only: [row.endpoint], attempts: row.attempts + 1 });
    retried += 1;
  }
  if (rows.length > 3000) writeJsonl(logFile(ref), rows.slice(-2000));
  return retried;
}
