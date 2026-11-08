import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WxQrCodeStartData, WxQrCodeStatusData } from "../../../shared/protocol.ts";
import { postInbox } from "../assistant/inbox.ts";
import {
  decideColleagueProposal,
  flushPendingWechatReceiptsForPeer,
  listColleagueProposals,
  type ColleagueProposal,
  type ProposalReceiptDelivery,
} from "../assistant/proposals.ts";
import { clip } from "../assistant/store.ts";
import { buildDropTenantHost, type DropPortalTenant } from "../ingest/http.ts";
import { runKbQaAsk } from "../ingest/qaRunner.ts";
import { QA_MAX_QUESTION_CHARS } from "../ingest/qaStorage.ts";
import {
  findColleaguePassByChannel,
  getOwnerWxBinding,
  listDropTokens,
  SESSION_TTL_MS,
  setOwnerWxBinding,
  updateDropToken,
  type DropSessionGrant,
  type DropTenantHost,
} from "../ingest/tokens.ts";
import { log } from "../log.ts";
import { getTenant } from "../tenants.ts";
import {
  DEFAULT_ILINK_BASE_URL,
  extractTextFromIlinkMessage,
  fetchIlinkBotQrCode,
  listPersistedWeixinAccounts,
  loadAccountSyncBuf,
  loadPersistedWeixinAccount,
  normalizeIlinkAccountId,
  pollIlinkGetUpdates,
  pollIlinkQrCodeStatus,
  sanitizeIlinkBaseUrl,
  saveAccountContextToken,
  saveAccountSyncBuf,
  savePersistedWeixinAccount,
  sendIlinkBotTextMessage,
  sendIlinkTypingIndicator,
  type IlinkInboundMessage,
  type PersistedWeixinAccount,
} from "./ilinkClient.ts";

/**
 * 微信通道推送守卫（WeChat PushGuard —— 移植 `BillllX/wechat-push-skill` 实战机制）、
 * 腾讯 iLink 扫码绑定与常驻长轮询接待网关：
 * 1. `detectActiveWechatAccount(targetOpenId)`：扫描 `~/.openclaw/openclaw-weixin/accounts/` 下包含目标 `openId` 的 `*-im-bot.context-tokens.json`，并取 `.sync.json` mtime 最新的活跃 Bot；
 * 2. 双驱动自动适配：优先尝试 `openclaw message send` CLI（强校验 `stdout.includes("Sent via") && exitCode === 0`）；当本机未安装 `openclaw` CLI（`code === 127`）时，自动无缝切换至网关内置 iLink HTTP `POST /ilink/bot/sendmessage` 通道（含 `X-WECHAT-UIN` 请求头与 `ret === 0` 校验）；
 * 3. `errcode === -14`（SESSION_EXPIRED）1 小时冷却保护，遇到超 24h 窗口或冷却时诚实返回 `pending_wx_window` 进入待补投队列；
 * 4. 扫码绑定状态机（支持主人侧一键为同事/自己生成微信绑定码，以及 `/p/<tenant>/drop` 同事自助扫码绑定）；
 * 5. 后台长轮询 `POST /ilink/bot/getupdates`（含 `sendtyping` 正在输入状态），当已绑定且 `status === "active"` 的同事在微信发来消息时，自动更新 `context_token`、触发 `flushPendingWechatReceiptsForPeer` 补投挂起回执，并调用 `runKbQaAsk` 回答知识库/脱敏日历忙闲问题或创建变更提案。
 */

export const SESSION_EXPIRED_ERRCODE = -14;
export const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;
export const WX_CHANNEL_NAME = "openclaw-weixin";

type BotCooldownMap = Map<string, number>;
const botPausedUntil: BotCooldownMap = new Map();

export function markWxAccountPaused(accountId: string, durationMs = SESSION_PAUSE_DURATION_MS) {
  const norm = normalizeWxAccount(accountId);
  if (norm) {
    botPausedUntil.set(norm, Date.now() + durationMs);
  }
}

export function isWxAccountPaused(accountId: string, now = Date.now()): boolean {
  const norm = normalizeWxAccount(accountId);
  if (!norm) return false;
  return (botPausedUntil.get(norm) ?? 0) > now;
}

export function resetWxPushGuardMemoryForTest() {
  botPausedUntil.clear();
  activeQrSessions.clear();
  stopAllWxMonitorLoops();
}

export function normalizeWxAccount(account: string): string {
  return normalizeIlinkAccountId(account);
}

/**
 * 移植自 `BillllX/wechat-push-skill/lib/wechat_push.py`：
 * 扫描 `~/.openclaw/openclaw-weixin/accounts/` 找到与 `targetOpenId` 建立了 `context_token` 且 `sync.json` mtime 最新的活跃 Bot。
 * 若显式传入了 `targetOpenId` 但没有任何 Bot 的 `context-tokens.json` 包含该 `openId`，再检查是否有 `<botId>.json` 的 `userId === targetOpenId`（刚扫码绑定成功尚未发首条消息），否则直接返回 `""`（不盲选无关 Bot 防假成功）。
 */
export function detectActiveWechatAccount(
  targetOpenId?: string,
  accountsDir = join(homedir(), ".openclaw", "openclaw-weixin", "accounts"),
): string {
  if (!existsSync(accountsDir)) return "";
  let files: string[] = [];
  try {
    files = readdirSync(accountsDir);
  } catch {
    return "";
  }

  const now = Date.now();
  const isPaused = (botId: string) => {
    const until = botPausedUntil.get(botId) ?? 0;
    return until > now;
  };

  if (targetOpenId && targetOpenId.trim()) {
    const cleanTarget = targetOpenId.trim();
    const matches: Array<{ syncMtime: number; botId: string }> = [];
    for (const f of files) {
      if (!f.endsWith("-im-bot.context-tokens.json")) continue;
      const botId = `${f.slice(0, -"-im-bot.context-tokens.json".length)}-im-bot`;
      if (isPaused(botId)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(accountsDir, f), "utf8")) as Record<string, unknown>;
        if (raw && typeof raw === "object" && cleanTarget in raw) {
          const syncPath = join(accountsDir, `${botId}.sync.json`);
          const syncMtime = existsSync(syncPath) ? statSync(syncPath).mtimeMs : 0;
          matches.push({ syncMtime, botId });
        }
      } catch {
        continue;
      }
    }
    if (matches.length > 0) {
      matches.sort((a, b) => b.syncMtime - a.syncMtime);
      return matches[0]!.botId;
    }

    // 兜底检查刚通过扫码绑定落盘的 <botId>.json (userId 匹配且存在有效 token)
    const boundMatches: Array<{ syncMtime: number; botId: string }> = [];
    for (const f of files) {
      if (
        !f.endsWith("-im-bot.json") ||
        f.endsWith(".sync.json") ||
        f.endsWith(".context-tokens.json")
      ) {
        continue;
      }
      const botId = f.slice(0, -".json".length);
      if (isPaused(botId)) continue;
      try {
        const raw = JSON.parse(readFileSync(join(accountsDir, f), "utf8")) as {
          userId?: unknown;
          token?: unknown;
        };
        if (
          typeof raw.userId === "string" &&
          raw.userId.trim() === cleanTarget &&
          typeof raw.token === "string" &&
          raw.token.trim()
        ) {
          const syncPath = join(accountsDir, `${botId}.sync.json`);
          const syncMtime = existsSync(syncPath) ? statSync(syncPath).mtimeMs : 0;
          boundMatches.push({ syncMtime, botId });
        }
      } catch {
        continue;
      }
    }
    if (boundMatches.length > 0) {
      boundMatches.sort((a, b) => b.syncMtime - a.syncMtime);
      return boundMatches[0]!.botId;
    }

    return "";
  }

  // 仅当未指定 targetOpenId（如全局探活检测）时才按 sync.json mtime 选最新 Bot
  const syncCandidates: Array<{ mtime: number; botId: string }> = [];
  for (const f of files) {
    if (!f.endsWith("-im-bot.sync.json")) continue;
    const botId = f.slice(0, -".sync.json".length);
    if (isPaused(botId)) continue;
    try {
      const mtime = statSync(join(accountsDir, f)).mtimeMs;
      syncCandidates.push({ mtime, botId });
    } catch {
      continue;
    }
  }
  if (syncCandidates.length > 0) {
    syncCandidates.sort((a, b) => b.mtime - a.mtime);
    return syncCandidates[0]!.botId;
  }

  return "";
}

/** 生成反重放请求头 X-WECHAT-UIN：base64(String(randomUint32))（每次全新生成，绝不复用） */
export function generateRandomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

export type WechatPushResult =
  | { ok: true; account: string; detail: string }
  | {
      ok: false;
      reason:
        | "session_expired"
        | "no_account"
        | "cli_unavailable"
        | "false_success_blocked"
        | "send_error";
      error: string;
    };

export type OpenClawCliExecutor = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

let customCliExecutor: OpenClawCliExecutor | null = null;

export function bindOpenClawCliExecutorForTest(next: OpenClawCliExecutor | null) {
  customCliExecutor = next;
}

async function defaultRunOpenClawCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (customCliExecutor) return customCliExecutor(args);
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("openclaw", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolveRun({ code: 124, stdout, stderr: "openclaw message send timeout (20s)" });
    }, 20_000);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: 127, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * 主动向目标微信 `openId` 推送消息（内置防假成功双条件校验与 `-14` 冷却保护）：
 * 1. 若测试注入了 `customCliExecutor` 或本机安装了 `openclaw` CLI，尝试走 CLI；
 * 2. 当本机未安装 `openclaw` CLI（`res.code === 127`）或账号在 `~/.openclaw/openclaw-weixin/accounts/` 下存有内置 iLink `token` 时，自动走网关内置 iLink HTTP `POST /ilink/bot/sendmessage` 通道！
 */
export async function sendProactiveWechatMessage(input: {
  targetOpenId: string;
  message: string;
  account?: string;
  silent?: boolean;
  accountsDir?: string;
  contextToken?: string;
}): Promise<WechatPushResult> {
  const text = (input.message || "").trim();
  const target = (input.targetOpenId || "").trim();
  if (!text || !target) {
    return { ok: false, reason: "send_error", error: "目标 openid 或消息内容为空" };
  }

  const account = normalizeWxAccount(
    input.account || detectActiveWechatAccount(target, input.accountsDir),
  );
  if (!account) {
    return {
      ok: false,
      reason: "no_account",
      error: "未探测到与该微信用户建立过 context_token 的活跃 Bot 通道（需对方先发消息或处于 24h 窗口内）",
    };
  }

  const pausedUntil = botPausedUntil.get(account) ?? 0;
  if (pausedUntil > Date.now()) {
    return {
      ok: false,
      reason: "session_expired",
      error: `Bot ${account} 此前触发 errcode=-14 处于 1 小时冷却保护期`,
    };
  }

  // 如果未注入测试 CLI mock 且本地已有内置 iLink token 凭证，优先尝试内置 iLink HTTP 发送（更快且零子进程开销）
  const persistedAcc = loadPersistedWeixinAccount(account, input.accountsDir);
  if (!customCliExecutor && persistedAcc?.token) {
    const httpOutcome = await sendIlinkBotTextMessage({
      accountId: account,
      toUserId: target,
      text,
      contextToken: input.contextToken,
      baseUrl: persistedAcc.baseUrl,
      botToken: persistedAcc.token,
      accountsDir: input.accountsDir,
    });
    if (httpOutcome.ok) {
      return {
        ok: true,
        account,
        detail: `Sent via built-in iLink HTTP (msgId=${httpOutcome.serverMessageId || httpOutcome.messageId})`,
      };
    }
    if (httpOutcome.reason === "session_expired") {
      botPausedUntil.set(account, Date.now() + SESSION_PAUSE_DURATION_MS);
    }
    return {
      ok: false,
      reason: httpOutcome.reason,
      error: httpOutcome.error,
    };
  }

  const cmdArgs = [
    "message",
    "send",
    "--channel",
    WX_CHANNEL_NAME,
    "--account",
    account,
    "--target",
    target,
    "-m",
    text,
  ];
  if (input.silent) {
    cmdArgs.push("--silent");
  }

  const res = await defaultRunOpenClawCli(cmdArgs);
  const combined = `${res.stdout}\n${res.stderr}`;

  // 识别 errcode=-14 session timeout，触发 1 小时冷却保护
  if (/errcode["']?\s*:\s*-14|session\s+timeout/i.test(combined)) {
    botPausedUntil.set(account, Date.now() + SESSION_PAUSE_DURATION_MS);
    return {
      ok: false,
      reason: "session_expired",
      error: "微信会话超时 (errcode=-14) 或已超过 24 小时主动推送窗口",
    };
  }

  // 防假成功核心铁律（来自 wechat-push-skill）：必须同时满足 exitCode === 0 且 stdout 包含 "Sent via"
  if (res.code === 0 && res.stdout.includes("Sent via")) {
    return { ok: true, account, detail: res.stdout.trim() };
  }

  // 当本机未安装 openclaw CLI (code === 127) 时，若有内置 iLink 账号凭证，自动降级走内置 iLink HTTP 通道
  if (res.code === 127) {
    if (persistedAcc?.token) {
      const httpOutcome = await sendIlinkBotTextMessage({
        accountId: account,
        toUserId: target,
        text,
        contextToken: input.contextToken,
        baseUrl: persistedAcc.baseUrl,
        botToken: persistedAcc.token,
        accountsDir: input.accountsDir,
      });
      if (httpOutcome.ok) {
        return {
          ok: true,
          account,
          detail: `Sent via built-in iLink HTTP (msgId=${httpOutcome.serverMessageId || httpOutcome.messageId})`,
        };
      }
      if (httpOutcome.reason === "session_expired") {
        botPausedUntil.set(account, Date.now() + SESSION_PAUSE_DURATION_MS);
      }
      return {
        ok: false,
        reason: httpOutcome.reason,
        error: httpOutcome.error,
      };
    }
    return { ok: false, reason: "cli_unavailable", error: "本机未安装或未启动 openclaw CLI 通道" };
  }

  return {
    ok: false,
    reason: res.code === 0 ? "false_success_blocked" : "send_error",
    error: `未通过真送达校验: exit=${res.code} stdout=${res.stdout.slice(0, 160)} stderr=${res.stderr.slice(0, 160)}`,
  };
}

// ---------------------------------------------------------------------------
// 扫码绑定状态机（场景 A：主人后台直绑同事/主人自己；场景 B：同事 /p/<tenant>/drop 自助扫码）
// ---------------------------------------------------------------------------

type ActiveWxQrSession = {
  qrSessionId: string;
  tenantId: string;
  mode: "owner_colleague" | "owner_self" | "portal_colleague";
  tokenId: string;
  targetLabel: string;
  qrcode: string;
  qrcodeImgContent: string;
  qrSvgDataUrl: string;
  apiBaseUrl: string;
  status: WxQrCodeStatusData["status"];
  botId?: string;
  openId?: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  accountsDir?: string;
};

const QR_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_QR_SESSIONS = 128;
const activeQrSessions = new Map<string, ActiveWxQrSession>();
const inFlightQrPolls = new Map<
  string,
  Promise<{ ok: true; data: WxQrCodeStatusData } | { ok: false; error: string }>
>();

function purgeExpiredQrSessions(now = Date.now(), replacingKey?: { tenantId: string; tokenId: string }) {
  for (const [k, v] of activeQrSessions.entries()) {
    if (
      v.expiresAt <= now ||
      (replacingKey &&
        v.tenantId === replacingKey.tenantId &&
        v.tokenId === replacingKey.tokenId &&
        v.status !== "confirmed")
    ) {
      activeQrSessions.delete(k);
    }
  }
  while (activeQrSessions.size >= MAX_ACTIVE_QR_SESSIONS) {
    const oldest = activeQrSessions.keys().next().value;
    if (!oldest) break;
    activeQrSessions.delete(oldest);
  }
}

/**
 * 发起一次腾讯微信 iLink 扫码会话（获取官方 ClawBot 二维码并生成内联 SVG Data URL）
 */
export async function startWechatQrBindingSession(
  host: DropTenantHost,
  input: {
    mode: "owner_colleague" | "owner_self" | "portal_colleague";
    tokenId: string;
    submitterName?: string;
    accountsDir?: string;
    autoPollInBackground?: boolean;
    onConfirmed?: () => void;
  },
  now = Date.now(),
): Promise<{ ok: true; data: WxQrCodeStartData } | { ok: false; error: string }> {
  const cleanTokenId = input.tokenId.trim() || "__owner__";
  purgeExpiredQrSessions(now, { tenantId: host.id, tokenId: cleanTokenId });

  let targetLabel = "主人微信";

  if (input.mode !== "owner_self") {
    const tokens = listDropTokens(host, { includeRevoked: false, now });
    const matched = tokens.find((t) => t.id === cleanTokenId);
    if (!matched) {
      return { ok: false, error: `找不到有效的同事通行证：${cleanTokenId}` };
    }
    targetLabel = matched.label;
  }

  const qrRes = await fetchIlinkBotQrCode({ accountsDir: input.accountsDir });
  if (!qrRes.ok) {
    return { ok: false, error: qrRes.error };
  }

  const qrSessionId = `wxqr_${randomBytes(16).toString("hex")}`;
  const expiresAt = now + QR_SESSION_TTL_MS;
  const session: ActiveWxQrSession = {
    qrSessionId,
    tenantId: host.id,
    mode: input.mode,
    tokenId: cleanTokenId,
    targetLabel: input.submitterName?.trim() || targetLabel,
    qrcode: qrRes.qrcode,
    qrcodeImgContent: qrRes.qrcodeImgContent,
    qrSvgDataUrl: qrRes.qrSvgDataUrl,
    apiBaseUrl: DEFAULT_ILINK_BASE_URL,
    status: "wait",
    message:
      input.mode === "owner_self"
        ? "请使用您（主人）本人的手机微信扫描下方二维码确认连接"
        : input.mode === "owner_colleague"
          ? `请让同事「${targetLabel}」使用手机微信扫描下方二维码（或截图发给对方扫），扫码确认后将直接激活绑定`
          : `请使用您的手机微信扫描下方二维码，扫码点确认后将自动提交给主人激活`,
    createdAt: now,
    expiresAt,
    accountsDir: input.accountsDir,
  };

  activeQrSessions.set(qrSessionId, session);

  if (input.autoPollInBackground) {
    void (async () => {
      while (activeQrSessions.has(qrSessionId) && Date.now() < expiresAt) {
        await new Promise((resolveTimer) => {
          const t = setTimeout(resolveTimer, 2_500);
          t.unref?.();
        });
        const curr = activeQrSessions.get(qrSessionId);
        if (!curr || curr.status === "confirmed" || curr.status === "expired" || curr.status === "verify_code_blocked") {
          break;
        }
        if (curr.status === "need_verifycode") {
          continue;
        }
        const poll = await checkWechatQrBindingStatus(host, { qrSessionId });
        if (poll.ok && poll.data.status === "confirmed") {
          input.onConfirmed?.();
          break;
        }
        if (!poll.ok || poll.data.status === "expired" || poll.data.status === "verify_code_blocked") {
          break;
        }
      }
    })();
  }

  return {
    ok: true,
    data: {
      qrSessionId,
      tokenId: session.tokenId,
      targetLabel: session.targetLabel,
      qrcode: session.qrcode,
      qrcodeImgContent: qrRes.qrcodeImgContent,
      qrSvgDataUrl: qrRes.qrSvgDataUrl,
      expiresAt,
    },
  };
}

/**
 * 轮询指定微信扫码会话的状态（支持传入 `verifyCode` 验证码）：
 * - 当返回 `scaned_but_redirect` 时自动切换 `apiBaseUrl` 跨机房轮询；
 * - 当返回 `confirmed` 时：
 *   1. 将 `(ilink_bot_id, bot_token, ilink_user_id, baseurl)` 写入 `~/.openclaw/openclaw-weixin/accounts/`；
 *   2. 立即启动该 Bot 通道的后台 `getupdates` 长轮询协程；
 *   3. 若为场景 A（`owner_colleague`）则直接将该同事 `wxBinding` 置为 `status: "active"`；若为 `owner_self` 则写入 `ownerWx`；
 *   4. 若为场景 B（`portal_colleague`）则将该同事 `wxBinding` 置为 `status: "pending_owner"` 并向主人收件箱发出一键确认通知。
 */
export async function checkWechatQrBindingStatus(
  host: DropTenantHost,
  input: {
    qrSessionId: string;
    verifyCode?: string;
    expectedTokenId?: string;
  },
  now = Date.now(),
): Promise<{ ok: true; data: WxQrCodeStatusData } | { ok: false; error: string }> {
  const cleanSessionId = (input.qrSessionId || "").trim();
  const sess = activeQrSessions.get(cleanSessionId);
  if (!sess || sess.tenantId !== host.id) {
    return { ok: false, error: "二维码会话不存在或已过期，请重新点击生成" };
  }
  if (input.expectedTokenId && sess.tokenId !== input.expectedTokenId) {
    return { ok: false, error: "二维码会话与当前登录通行证不匹配" };
  }

  // 若此前已 confirmed，直接幂等返回成功状态
  if (sess.status === "confirmed") {
    return {
      ok: true,
      data: {
        qrSessionId: sess.qrSessionId,
        tokenId: sess.tokenId,
        status: "confirmed",
        botId: sess.botId,
        openId: sess.openId,
        bindingStatus: sess.mode === "portal_colleague" ? "pending_owner" : "active",
        message: sess.message,
      },
    };
  }

  const inFlightKey = `${cleanSessionId}:${input.verifyCode?.trim() || ""}`;
  const existingPoll = inFlightQrPolls.get(inFlightKey);
  if (existingPoll) {
    return existingPoll;
  }

  const runPoll = (async (): Promise<
    { ok: true; data: WxQrCodeStatusData } | { ok: false; error: string }
  > => {
    if (sess.expiresAt <= now) {
      sess.status = "expired";
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: "expired",
          message: "二维码已过期（超过 5 分钟），请点击重新生成二维码",
        },
      };
    }

    const pollRes = await pollIlinkQrCodeStatus({
      qrcode: sess.qrcode,
      baseUrl: sess.apiBaseUrl,
      verifyCode: input.verifyCode,
      timeoutMs: 4_000,
    });

    if (
      pollRes.status === "scaned_but_redirect" ||
      (pollRes.status === "binded_redirect" && !pollRes.bot_token && pollRes.redirect_host)
    ) {
      if (pollRes.redirect_host && /^[a-zA-Z0-9.-]+$/.test(pollRes.redirect_host)) {
        sess.apiBaseUrl = sanitizeIlinkBaseUrl(`https://${pollRes.redirect_host}`);
      }
      sess.status = "scaned";
      sess.message = "已扫码，正在跨机房同步确认状态…";
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: "scaned",
          message: sess.message,
        },
      };
    }

    if (pollRes.status === "wait") {
      sess.status = "wait";
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: "wait",
          message: sess.message,
        },
      };
    }

    if (pollRes.status === "scaned") {
      sess.status = "scaned";
      sess.message = "📱 已扫描二维码，请在手机微信上点击「确认连接」…";
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: "scaned",
          message: sess.message,
        },
      };
    }

    if (pollRes.status === "need_verifycode") {
      sess.status = "need_verifycode";
      sess.message = "请在下方输入框填写手机微信上显示的 6 位数字验证码";
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: "need_verifycode",
          message: sess.message,
        },
      };
    }

    if (pollRes.status === "verify_code_blocked" || pollRes.status === "expired") {
      sess.status = pollRes.status;
      sess.message =
        pollRes.status === "verify_code_blocked"
          ? "验证码输入错误次数过多，请重新生成二维码"
          : "二维码已过期，请重新生成二维码";
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: pollRes.status,
          message: sess.message,
        },
      };
    }

    if (pollRes.status === "confirmed" || pollRes.status === "binded_redirect") {
      const rawBotId = (pollRes.ilink_bot_id || "").trim();
      const botToken = (pollRes.bot_token || "").trim();
      const rawOpenId = (pollRes.ilink_user_id || "").trim();
      const baseUrl = sanitizeIlinkBaseUrl(pollRes.baseurl || sess.apiBaseUrl);
      const normBotId = normalizeIlinkAccountId(rawBotId);

      if (!normBotId || !botToken || !rawOpenId) {
        return {
          ok: false,
          error: "微信返回确认状态但缺少合法的 ilink_bot_id / bot_token / ilink_user_id 凭证",
        };
      }

      const savedAcc = savePersistedWeixinAccount(
        {
          accountId: normBotId,
          token: botToken,
          baseUrl,
          userId: rawOpenId,
        },
        sess.accountsDir,
      );

      // 清除可能存在的冷却标记，重启该 Bot 通道的 getUpdates 长轮询（中断可能拿着旧 token 的挂起请求）
      botPausedUntil.delete(normBotId);
      ensureWxAccountMonitorLoop(savedAcc, sess.accountsDir, { forceRestart: true });

      sess.status = "confirmed";
      sess.botId = normBotId;
      sess.openId = rawOpenId;

      if (sess.mode === "owner_self") {
        setOwnerWxBinding(host, {
          botId: normBotId,
          openId: rawOpenId,
          nickname: "主人微信",
          boundAt: now,
        });
        sess.message = `✅ 主人微信已成功绑定（${rawOpenId}），后续同事发起预约或知识库更新提案将同步推送到您的微信！`;
        return {
          ok: true,
          data: {
            qrSessionId: sess.qrSessionId,
            tokenId: sess.tokenId,
            status: "confirmed",
            botId: normBotId,
            openId: rawOpenId,
            bindingStatus: "active",
            message: sess.message,
          },
        };
      }

      if (sess.mode === "owner_colleague") {
        const upRes = updateDropToken(
          host,
          {
            tokenId: sess.tokenId,
            wxBinding: {
              status: "active",
              botId: normBotId,
              openId: rawOpenId,
              nickname: sess.targetLabel,
              updatedAt: now,
            },
          },
          now,
        );
        if (!upRes.ok) {
          return { ok: false, error: upRes.error };
        }
        sess.message = `✅ 同事「${sess.targetLabel}」微信扫码绑定成功并已激活（${rawOpenId}），现在可在微信内直接与小驳对话！`;
        return {
          ok: true,
          data: {
            qrSessionId: sess.qrSessionId,
            tokenId: sess.tokenId,
            status: "confirmed",
            botId: normBotId,
            openId: rawOpenId,
            bindingStatus: "active",
            message: sess.message,
          },
        };
      }

      // 场景 B：portal_colleague（同事在 /p/<tenant>/drop 登录态下自助扫码，写入 pending_owner 通知主人一键确认）
      const upRes = updateDropToken(
        host,
        {
          tokenId: sess.tokenId,
          wxBinding: {
            status: "pending_owner",
            botId: normBotId,
            openId: rawOpenId,
            nickname: sess.targetLabel,
            updatedAt: now,
          },
        },
        now,
      );
      if (!upRes.ok) {
        return { ok: false, error: upRes.error };
      }

      postInbox(host, {
        kind: "approval",
        key: `wxbind:${sess.tokenId}:${rawOpenId}`,
        title: `[微信扫码绑定确认] ${sess.targetLabel} 已扫码请求绑定微信`,
        body: [
          `通行口令：${upRes.record.label} (${sess.tokenId})`,
          `微信标识：${rawOpenId}`,
          `专属通道：${normBotId}`,
          `操作提示：确认是本人后，可在「小驳 → 同事」点击「确认激活微信」或对我说「激活同事 ${sess.tokenId} 的微信绑定」。`,
        ].join("\n"),
        actionPrompt: `请帮我确认并激活同事口令 ${sess.tokenId} 的微信绑定（openId: ${rawOpenId}）`,
      });

      // 若主人已绑定自己的微信，也顺手通知主人微信一声
      const ownerWx = getOwnerWxBinding(host);
      if (ownerWx?.openId) {
        void sendProactiveWechatMessage({
          targetOpenId: ownerWx.openId,
          account: ownerWx.botId,
          message: `【微信扫码绑定待确认】同事「${upRes.record.label}」已扫码申请绑定微信（${rawOpenId}）。请在工作台「小驳 → 同事」点击确认激活。`,
          accountsDir: sess.accountsDir,
        }).catch(() => undefined);
      }

      sess.message = `✅ 微信扫码确认成功（${rawOpenId}）！已通知主人确认，主人点击「确认激活微信」后即可在微信内直接收发消息。`;
      return {
        ok: true,
        data: {
          qrSessionId: sess.qrSessionId,
          tokenId: sess.tokenId,
          status: "confirmed",
          botId: normBotId,
          openId: rawOpenId,
          bindingStatus: "pending_owner",
          message: sess.message,
        },
      };
    }

    return {
      ok: true,
      data: {
        qrSessionId: sess.qrSessionId,
        tokenId: sess.tokenId,
        status: "wait",
        message: sess.message,
      },
    };
  })();

  inFlightQrPolls.set(inFlightKey, runPoll);
  try {
    return await runPoll;
  } finally {
    inFlightQrPolls.delete(inFlightKey);
  }
}

// ---------------------------------------------------------------------------
// 微信入站消息处理（getUpdates -> 更新 context_token -> 补投挂起回执 -> runKbQaAsk / 主人快捷审批）
// ---------------------------------------------------------------------------

let registeredTenantsProvider: (() => DropPortalTenant[]) | null = null;
const activeAccountMonitors = new Map<string, { abort: AbortController; accountId: string }>();
const processedWeixinMessageIds = new Set<string>();

function rememberProcessedMsgId(id: string): boolean {
  if (!id) return false;
  if (processedWeixinMessageIds.has(id)) return true;
  if (processedWeixinMessageIds.size >= 2000) {
    const oldest = processedWeixinMessageIds.keys().next().value;
    if (oldest) processedWeixinMessageIds.delete(oldest);
  }
  processedWeixinMessageIds.add(id);
  return false;
}

/**
 * 处理单条来自微信 `getupdates` 的入站消息（支持直接被单测调用验证完整接待闭环）
 */
export async function handleInboundWeixinMessage(params: {
  account: PersistedWeixinAccount;
  message: IlinkInboundMessage;
  tenants?: DropPortalTenant[];
  accountsDir?: string;
}): Promise<{ handled: boolean; replyText?: string; flushedReceipts?: string[] }> {
  const { account, message, accountsDir } = params;
  // 忽略机器人自己发出的消息 (message_type === 2)
  if (message.message_type === 2) {
    return { handled: false };
  }

  const fromOpenId = (message.from_user_id || "").trim();
  if (!fromOpenId) {
    return { handled: false };
  }

  const msgUniqueId = `${account.accountId}:${message.message_id || message.seq || ""}:${message.create_time_ms || ""}`;
  if ((message.message_id || message.seq) && rememberProcessedMsgId(msgUniqueId)) {
    return { handled: false };
  }

  const contextToken = (message.context_token || "").trim();
  if (contextToken) {
    saveAccountContextToken(account.accountId, fromOpenId, contextToken, accountsDir);
  }

  const rawText = extractTextFromIlinkMessage(message);
  if (!rawText) {
    return { handled: false };
  }

  const tenantList = params.tenants ?? (registeredTenantsProvider ? registeredTenantsProvider() : []);

  // 1. 优先检查发送方是否为主人本人（ownerWx）且发送了快捷批单指令（「批准 prop_xxx」或「拒绝 prop_xxx」），避免主人同时测试过同事口令时被拦截
  const approvalCmdMatch = /^(?:批准|同意|通过|拒绝|驳回)\s*(?:提案\s*)?([a-zA-Z0-9_-]+)?(?:\s+(.+))?$/i.exec(
    rawText.trim(),
  );
  if (approvalCmdMatch) {
    const ownerCandidates = tenantList
      .map((t) => {
        const host = buildDropTenantHost(t);
        const ownerWx = getOwnerWxBinding(host);
        return ownerWx && ownerWx.openId === fromOpenId ? { host, ownerWx } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (b.ownerWx.botId === account.accountId ? 1 : 0) - (a.ownerWx.botId === account.accountId ? 1 : 0));

    for (const { host } of ownerCandidates) {
      const isApprove = /^(?:批准|同意|通过)/i.test(rawText.trim());
      let targetPropId = (approvalCmdMatch[1] || "").trim();
      const decisionNote = (approvalCmdMatch[2] || "").trim() || undefined;
      if (!targetPropId) {
        const pendingList = listColleagueProposals(host, { status: "pending", limit: 1 });
        targetPropId = pendingList[0]?.id || "";
      }
      if (!targetPropId) {
        const msg = "【小驳】当前没有待审批的同事提案。";
        await sendIlinkBotTextMessage({
          accountId: account.accountId,
          toUserId: fromOpenId,
          text: msg,
          contextToken,
          baseUrl: account.baseUrl,
          botToken: account.token,
          accountsDir,
        });
        return { handled: true, replyText: msg };
      }

      const decided = await decideColleagueProposal(host, {
        proposalId: targetPropId,
        approve: isApprove,
        decisionNote,
      });
      const replyText = decided.ok
        ? `【小驳】已${isApprove ? "批准" : "拒绝"}同事提案 ${decided.proposal.id}（申请人：${decided.proposal.proposerName}），回执已自动发送。`
        : `【小驳】处理提案失败：${decided.error}`;

      await sendIlinkBotTextMessage({
        accountId: account.accountId,
        toUserId: fromOpenId,
        text: replyText,
        contextToken,
        baseUrl: account.baseUrl,
        botToken: account.token,
        accountsDir,
      });
      return { handled: true, replyText };
    }
  }

  // 2. 检查发送方是否为某个租户下已绑定且 status === "active" 的同事（优先匹配绑定了当前 botId 的租户）
  const colleagueMatches = tenantList
    .map((t) => {
      const host = buildDropTenantHost(t);
      const colleaguePass = findColleaguePassByChannel(host, { wxOpenId: fromOpenId });
      return colleaguePass ? { host, colleaguePass } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => {
      const aBotMatch = a.colleaguePass.record.wxBinding?.botId === account.accountId ? 1 : 0;
      const bBotMatch = b.colleaguePass.record.wxBinding?.botId === account.accountId ? 1 : 0;
      return bBotMatch - aBotMatch;
    });

  for (const { host, colleaguePass } of colleagueMatches) {
    // 若该同事记录未填 botId，补充记录当前活跃 botId
    if (!colleaguePass.record.wxBinding?.botId) {
      updateDropToken(host, {
        tokenId: colleaguePass.record.id,
        wxBinding: {
          ...colleaguePass.record.wxBinding!,
          botId: account.accountId,
          updatedAt: Date.now(),
        },
      });
    }

    // 2a. 先触发待补投回执队列（同事发消息瞬间恢复了 24h context_token 窗口，0 延迟先补发之前挂起的审批回执）
    const flushedReceipts = await flushPendingWechatReceiptsForPeer(
      host,
      fromOpenId,
      async (receiptMsg) => {
        const sendRes = await sendIlinkBotTextMessage({
          accountId: account.accountId,
          toUserId: fromOpenId,
          text: `【小驳·审批回执补达】${receiptMsg}`,
          contextToken,
          baseUrl: account.baseUrl,
          botToken: account.token,
          accountsDir,
        });
        return sendRes.ok;
      },
    );

    if (colleaguePass.workspaces.length === 0 || colleaguePass.permissions.kbAsk === false) {
      const denyText = "【小驳·数字分身】您的通行证当前未开启知识库与助理问答权限。";
      await sendIlinkBotTextMessage({
        accountId: account.accountId,
        toUserId: fromOpenId,
        text: denyText,
        contextToken,
        baseUrl: account.baseUrl,
        botToken: account.token,
        accountsDir,
      });
      return { handled: true, replyText: denyText, flushedReceipts };
    }

    // 2b. 发送微信顶部「对方正在输入…」状态 (status = 1)，并在 finally 中确保取消 (status = 2)
    void sendIlinkTypingIndicator({
      baseUrl: account.baseUrl,
      botToken: account.token,
      ilinkUserId: fromOpenId,
      contextToken,
      status: 1,
    });

    const qaSessionHash = createHash("sha256")
      .update(`wx_ilink:${host.id}:${colleaguePass.record.id}:${fromOpenId}`)
      .digest("hex")
      .slice(0, 32);

    const buildGrantFromPass = (
      pass: NonNullable<ReturnType<typeof findColleaguePassByChannel>>,
    ): DropSessionGrant => {
      const primaryWs = pass.workspaces[0]!;
      return {
        sessionToken: `ds_wx_${qaSessionHash}`,
        qaSessionId: `qa_${qaSessionHash}`,
        tokenId: pass.record.id,
        tenantId: host.id,
        workspaceId: primaryWs.workspaceId,
        workspaceKey: primaryWs.workspaceKey,
        workspacePath: primaryWs.workspacePath,
        workspaceTitle: primaryWs.workspaceTitle,
        kbConfig: primaryWs.kbConfig,
        authorizedWorkspaces: pass.workspaces,
        permissions: pass.permissions,
        submitterName: pass.record.label || "微信同事",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
    };

    let askRes: Awaited<ReturnType<typeof runKbQaAsk>>;
    try {
      askRes = await runKbQaAsk({
        host,
        initialSession: buildGrantFromPass(colleaguePass),
        question: clip(rawText, QA_MAX_QUESTION_CHARS),
        sourceChannel: "wechat",
        sourcePeerId: fromOpenId,
        reverifySession: () => {
          const fresh = findColleaguePassByChannel(host, { wxOpenId: fromOpenId });
          if (!fresh || fresh.workspaces.length === 0 || fresh.permissions.kbAsk === false) {
            return { ok: false, status: 403, error: "同事通行证已被吊销或问答权限已关闭" };
          }
          return { ok: true, session: buildGrantFromPass(fresh) };
        },
      });
    } finally {
      // 取消正在输入状态 (status = 2)
      void sendIlinkTypingIndicator({
        baseUrl: account.baseUrl,
        botToken: account.token,
        ilinkUserId: fromOpenId,
        contextToken,
        status: 2,
      });
    }

    const replyText = askRes.ok
      ? `【小驳·数字分身】${askRes.answer}${
          askRes.citedPaths.length > 0 ? `\n\n📄 引用来源：${askRes.citedPaths.join("、")}` : ""
        }`
      : `【小驳·数字分身】暂时无法完成查询：${askRes.error}`;

    await sendIlinkBotTextMessage({
      accountId: account.accountId,
      toUserId: fromOpenId,
      text: replyText,
      contextToken,
      baseUrl: account.baseUrl,
      botToken: account.token,
      accountsDir,
    });

    return { handled: true, replyText, flushedReceipts };
  }

  return { handled: false };
}

/**
 * 为单个已绑定的微信 iLink Bot 账号启动后台常驻 `getupdates` 长轮询协程
 */
export function ensureWxAccountMonitorLoop(
  account: PersistedWeixinAccount,
  customAccountsDir?: string,
  opts?: { forceRestart?: boolean },
): void {
  const normId = normalizeIlinkAccountId(account.accountId);
  if (!normId || !account.token) return;
  const existing = activeAccountMonitors.get(normId);
  if (existing) {
    if (!opts?.forceRestart) return;
    existing.abort.abort();
    activeAccountMonitors.delete(normId);
  }

  const abort = new AbortController();
  activeAccountMonitors.set(normId, { abort, accountId: normId });

  void (async () => {
    let getUpdatesBuf = loadAccountSyncBuf(normId, customAccountsDir);
    let nextTimeoutMs = 35_000;
    let consecutiveFailures = 0;

    while (!abort.signal.aborted) {
      if (isWxAccountPaused(normId)) {
        await sleepWithAbort(30_000, abort.signal);
        continue;
      }

      try {
        const freshAcc = loadPersistedWeixinAccount(normId, customAccountsDir) ?? account;
        const resp = await pollIlinkGetUpdates({
          baseUrl: freshAcc.baseUrl,
          botToken: freshAcc.token,
          getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
          abortSignal: abort.signal,
        });

        if (abort.signal.aborted) break;

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = Math.min(60_000, Math.max(5_000, resp.longpolling_timeout_ms));
        }

        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (isError) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
            markWxAccountPaused(normId, SESSION_PAUSE_DURATION_MS);
            log.warn(`wx ilink getupdates session expired (-14) for ${normId}, pausing 60m`);
            consecutiveFailures = 0;
            await sleepWithAbort(30_000, abort.signal);
            continue;
          }
          consecutiveFailures += 1;
          const delay = consecutiveFailures >= 3 ? 30_000 : 3_000;
          await sleepWithAbort(delay, abort.signal);
          continue;
        }

        consecutiveFailures = 0;
        // 每次成功轮询都更新 sync.json（即使 buf 未变也刷新 mtime，供 detectActiveWechatAccount 判定活跃）
        const nextBuf =
          resp.get_updates_buf !== undefined && resp.get_updates_buf !== ""
            ? resp.get_updates_buf
            : getUpdatesBuf;
        getUpdatesBuf = nextBuf;
        saveAccountSyncBuf(normId, getUpdatesBuf, customAccountsDir);

        const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
        for (const msg of msgs) {
          // 先同步更新 context_token，再异步执行耗时的问答，避免阻塞 getupdates 主长轮询通道
          const fromUser = (msg.from_user_id || "").trim();
          const ctxTok = (msg.context_token || "").trim();
          if (fromUser && ctxTok && msg.message_type !== 2) {
            saveAccountContextToken(normId, fromUser, ctxTok, customAccountsDir);
          }
          void handleInboundWeixinMessage({
            account: freshAcc,
            message: msg,
            accountsDir: customAccountsDir,
          }).catch((msgErr) => {
            log.error("wx ilink inbound message error", msgErr);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        consecutiveFailures += 1;
        await sleepWithAbort(consecutiveFailures >= 3 ? 30_000 : 3_000, abort.signal);
      }
    }
  })().finally(() => {
    const current = activeAccountMonitors.get(normId);
    if (current?.abort === abort) {
      activeAccountMonitors.delete(normId);
    }
  });
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function stopAllWxMonitorLoops(): void {
  for (const [, entry] of activeAccountMonitors) {
    entry.abort.abort();
  }
  activeAccountMonitors.clear();
}

/**
 * 网关启动时自动恢复 `~/.openclaw/openclaw-weixin/accounts/` 下所有已绑定微信 Bot 的长轮询协程
 */
export function startWeixinIlinkRuntime(opts: {
  tenants: () => DropPortalTenant[];
  accountsDir?: string;
}): number {
  registeredTenantsProvider = opts.tenants;
  const accounts = listPersistedWeixinAccounts(opts.accountsDir);
  for (const acc of accounts) {
    ensureWxAccountMonitorLoop(acc, opts.accountsDir);
  }
  return accounts.length;
}

/**
 * 判断一条站内 1v1 单聊消息是否在呼叫对方的小驳数字分身（如 `@小驳 ...` 或 `小驳，...`），并对问题长度做安全截断
 */
export function extractDmAssistantQuestion(
  rawText: string,
  assistantDisplayName = "小驳",
): string | null {
  const clean = (rawText || "").trim();
  if (!clean) return null;
  if (clean.startsWith("【小驳·数字分身") || clean.startsWith("🤖 【")) return null;

  const escapedName = assistantDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^(?:@${escapedName}|@小驳|${escapedName}[，,:：\\s])[\\s,，:：]*(.+)$`,
    "is",
  );
  const match = re.exec(clean);
  if (!match?.[1]?.trim()) return null;
  return clip(match[1].trim(), QA_MAX_QUESTION_CHARS);
}

export type ImSystemReplySender = (input: {
  fromTenantId: string;
  toTenantId: string;
  convId: string;
  text: string;
  replyToSeq?: number;
}) => Promise<{ rejected?: boolean } | void>;

let imReplySender: ImSystemReplySender | null = null;

export function bindImSystemReplySender(next: ImSystemReplySender | null) {
  imReplySender = next;
}

/**
 * 处理平台原生 IM 单聊中的 `@小驳` 同事提问：
 * 1. 当已绑定 `imTenantId` 的同事在与 `ownerTenantId` 的单聊里发送 `@小驳 ...` 时触发（若对方无通行证则静默忽略，不消耗主人发送配额、也不发生角色反转）；
 * 2. 校验 `colleaguePass.permissions.kbAsk !== false`；
 * 3. 构造进程内受控只读会话调用 `runKbQaAsk`（`reverifySession` 每次基于最新重查结果构造会话快照）；
 * 4. 将回答加上 `【小驳·数字分身】` 前缀追加回原单聊会话。
 */
export async function handleColleagueDmMention(input: {
  ownerTenantId: string;
  senderTenantId: string;
  convId: string;
  messageSeq: number;
  messageText: string;
}): Promise<{ handled: boolean; answer?: string }> {
  const question = extractDmAssistantQuestion(input.messageText);
  if (!question) return { handled: false };

  const ownerTenant = getTenant(input.ownerTenantId);
  if (!ownerTenant) return { handled: false };

  const host = buildDropTenantHost(ownerTenant);
  const colleaguePass = findColleaguePassByChannel(host, { imTenantId: input.senderTenantId });

  // 仅对已在 owner 通行证表中登记了 imTenantId 的同事触发分身代答（未登记或主人自己说话静默忽略）
  if (!colleaguePass || colleaguePass.workspaces.length === 0) {
    return { handled: false };
  }

  if (colleaguePass.permissions.kbAsk === false) {
    const denyMsg = "【小驳·数字分身】您的通行证当前未开启知识库与助理问答权限。";
    if (imReplySender) {
      await imReplySender({
        fromTenantId: input.ownerTenantId,
        toTenantId: input.senderTenantId,
        convId: input.convId,
        text: denyMsg,
        replyToSeq: input.messageSeq,
      });
    }
    return { handled: true, answer: denyMsg };
  }

  const qaSessionHash = createHash("sha256")
    .update(`im_dm:${input.ownerTenantId}:${input.senderTenantId}`)
    .digest("hex")
    .slice(0, 32);

  // 根据传入的最新 pass 对象动态构造 in-process QA 会话快照（不外溢到 HTTP）
  const buildGrantFromPass = (
    pass: NonNullable<ReturnType<typeof findColleaguePassByChannel>>,
  ): DropSessionGrant => {
    const primaryWs = pass.workspaces[0]!;
    return {
      sessionToken: `ds_im_${qaSessionHash}`,
      qaSessionId: `qa_${qaSessionHash}`,
      tokenId: pass.record.id,
      tenantId: host.id,
      workspaceId: primaryWs.workspaceId,
      workspaceKey: primaryWs.workspaceKey,
      workspacePath: primaryWs.workspacePath,
      workspaceTitle: primaryWs.workspaceTitle,
      kbConfig: primaryWs.kbConfig,
      authorizedWorkspaces: pass.workspaces,
      permissions: pass.permissions,
      submitterName: pass.record.label || input.senderTenantId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  };

  const askRes = await runKbQaAsk({
    host,
    initialSession: buildGrantFromPass(colleaguePass),
    question,
    sourceChannel: "im_dm",
    sourcePeerId: `${input.convId}#${input.senderTenantId}`,
    reverifySession: () => {
      const fresh = findColleaguePassByChannel(host, { imTenantId: input.senderTenantId });
      if (!fresh || fresh.workspaces.length === 0 || fresh.permissions.kbAsk === false) {
        return { ok: false, status: 403, error: "同事通行证已被吊销或问答权限已关闭" };
      }
      return { ok: true, session: buildGrantFromPass(fresh) };
    },
  });

  const replyText = askRes.ok
    ? `【小驳·数字分身】${askRes.answer}${
        askRes.citedPaths.length > 0 ? `\n\n📄 引用来源：${askRes.citedPaths.join("、")}` : ""
      }`
    : `【小驳·数字分身】暂时无法完成查询：${askRes.error}`;

  if (imReplySender) {
    await imReplySender({
      fromTenantId: input.ownerTenantId,
      toTenantId: input.senderTenantId,
      convId: input.convId,
      text: replyText,
      replyToSeq: input.messageSeq,
    });
  }

  return { handled: true, answer: replyText };
}

/**
 * 统一提案回执 Outbox 投递器（同时负责向「平台原生 IM 单聊」与「微信通道」发送主人审批完成后的回执，并在微信超 24h 时自动转入待补投队列 + 站内 IM 兜底）
 */
export async function dispatchProposalReceiptOutbox(
  host: DropTenantHost,
  _proposal: ColleagueProposal,
  delivery: ProposalReceiptDelivery,
): Promise<{ status: "delivered" | "pending_wx_window" | "failed"; error?: string }> {
  if (delivery.channel === "drop_portal") {
    return { status: "delivered" };
  }

  if (delivery.channel === "im_dm") {
    if (!imReplySender) {
      return { status: "failed", error: "IM 回复通道未初始化" };
    }
    const hashIdx = delivery.targetId.indexOf("#");
    const convIdPart = hashIdx >= 0 ? delivery.targetId.slice(0, hashIdx).trim() : "";
    const peerTenantId =
      hashIdx >= 0 ? delivery.targetId.slice(hashIdx + 1).trim() : delivery.targetId.trim();
    if (!peerTenantId) {
      return { status: "failed", error: "无效的 IM 目标租户 ID" };
    }
    const ack = await imReplySender({
      fromTenantId: host.id,
      toTenantId: peerTenantId,
      convId: convIdPart,
      text: `【小驳·数字分身】${delivery.message}`,
    });
    if (ack && typeof ack === "object" && ack.rejected) {
      return { status: "failed", error: "接收方已拒收站内 IM 消息" };
    }
    return { status: "delivered" };
  }

  if (delivery.channel === "wechat") {
    const pass = findColleaguePassByChannel(host, { wxOpenId: delivery.targetId });
    const pushRes = await sendProactiveWechatMessage({
      targetOpenId: delivery.targetId,
      account: pass?.record.wxBinding?.botId,
      message: delivery.message,
    });
    if (pushRes.ok) {
      return { status: "delivered" };
    }
    if (
      pushRes.reason === "session_expired" ||
      pushRes.reason === "no_account" ||
      pushRes.reason === "cli_unavailable"
    ) {
      // 当微信处于 24h 窗口外、session 超时或 CLI 未就绪时，若该同事绑定了站内 IM 账号，自动通过站内 IM 兜底投递
      if (pass?.record.imTenantId && imReplySender) {
        try {
          await imReplySender({
            fromTenantId: host.id,
            toTenantId: pass.record.imTenantId,
            convId: "",
            text: `【小驳·数字分身（微信超时自动转站内IM）】${delivery.message}`,
          });
        } catch (err) {
          log.error("wx fallback to im", err);
        }
      }
      return { status: "pending_wx_window", error: pushRes.error };
    }
    return { status: "failed", error: pushRes.error };
  }

  return { status: "delivered" };
}
