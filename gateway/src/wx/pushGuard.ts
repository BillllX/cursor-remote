import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ColleagueProposal, ProposalReceiptDelivery } from "../assistant/proposals.ts";
import { clip } from "../assistant/store.ts";
import { buildDropTenantHost } from "../ingest/http.ts";
import { runKbQaAsk } from "../ingest/qaRunner.ts";
import { QA_MAX_QUESTION_CHARS } from "../ingest/qaStorage.ts";
import {
  findColleaguePassByChannel,
  SESSION_TTL_MS,
  type DropSessionGrant,
  type DropTenantHost,
} from "../ingest/tokens.ts";
import { log } from "../log.ts";
import { getTenant } from "../tenants.ts";

/**
 * 微信通道推送守卫（WeChat PushGuard —— 移植 `BillllX/wechat-push-skill` 实战机制）与平台原生 IM 融合网关：
 * 1. `detectActiveWechatAccount(targetOpenId)`：扫描 `~/.openclaw/openclaw-weixin/accounts/` 下包含目标 `openId` 的 `*-im-bot.context-tokens.json`，并取 `.sync.json` mtime 最新的活跃 Bot；
 * 2. 防假成功校验：严禁只看 HTTP 200 或进程退出码；走 `openclaw message send` 时强校验 `stdout.includes("Sent via") && exitCode === 0`；
 * 3. `errcode === -14`（SESSION_EXPIRED）1 小时冷却保护，遇到超 24h 窗口或冷却时诚实返回 `pending_wx_window` 进入待补投队列；
 * 4. 平台原生 IM 1v1 单聊 `@小驳` 分身接待：当已授权同事在站内单聊向主人发送 `@小驳 ...` 时，核对 `imTenantId` 与 `kbAsk` 权限，拉起受控 `runKbQaAsk` 秒回知识库数据、脱敏忙闲或生成变更提案。
 */

export const SESSION_EXPIRED_ERRCODE = -14;
export const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;
export const WX_CHANNEL_NAME = "openclaw-weixin";

type BotCooldownMap = Map<string, number>;
const botPausedUntil: BotCooldownMap = new Map();

export function resetWxPushGuardMemoryForTest() {
  botPausedUntil.clear();
}

export function normalizeWxAccount(account: string): string {
  const clean = (account || "").trim();
  if (!clean) return "";
  return clean.endsWith("-im-bot") ? clean : `${clean}-im-bot`;
}

/**
 * 移植自 `BillllX/wechat-push-skill/lib/wechat_push.py`：
 * 扫描 `~/.openclaw/openclaw-weixin/accounts/` 找到与 `targetOpenId` 建立了 `context_token` 且 `sync.json` mtime 最新的活跃 Bot。
 * 若显式传入了 `targetOpenId` 但没有任何 Bot 的 `context-tokens.json` 包含该 `openId`，直接返回 `""`（不盲选无关 Bot 防假成功）。
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
      reason: "session_expired" | "no_account" | "cli_unavailable" | "false_success_blocked" | "send_error";
      error: string;
    };

export type OpenClawCliExecutor = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

let customCliExecutor: OpenClawCliExecutor | null = null;

export function bindOpenClawCliExecutorForTest(next: OpenClawCliExecutor | null) {
  customCliExecutor = next;
}

async function defaultRunOpenClawCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
 * 通过 `openclaw message send` 主动向目标微信 `openId` 推送消息（内置防假成功双条件校验与 `-14` 冷却保护）
 */
export async function sendProactiveWechatMessage(input: {
  targetOpenId: string;
  message: string;
  account?: string;
  silent?: boolean;
  accountsDir?: string;
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

  if (res.code === 127) {
    return { ok: false, reason: "cli_unavailable", error: "本机未安装或未启动 openclaw CLI 通道" };
  }

  return {
    ok: false,
    reason: res.code === 0 ? "false_success_blocked" : "send_error",
    error: `未通过真送达校验: exit=${res.code} stdout=${res.stdout.slice(0, 160)} stderr=${res.stderr.slice(0, 160)}`,
  };
}

/**
 * 判断一条站内 1v1 单聊消息是否在呼叫对方的小驳数字分身（如 `@小驳 ...` 或 `小驳，...`），并对问题长度做安全截断
 */
export function extractDmAssistantQuestion(rawText: string, assistantDisplayName = "小驳"): string | null {
  const clean = (rawText || "").trim();
  if (!clean) return null;
  if (clean.startsWith("【小驳·数字分身") || clean.startsWith("🤖 【")) return null;

  const escapedName = assistantDisplayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(?:@${escapedName}|@小驳|${escapedName}[，,:：\\s])[\\s,，:：]*(.+)$`, "is");
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
    const peerTenantId = hashIdx >= 0 ? delivery.targetId.slice(hashIdx + 1).trim() : delivery.targetId.trim();
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
    const pushRes = await sendProactiveWechatMessage({
      targetOpenId: delivery.targetId,
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
      const pass = findColleaguePassByChannel(host, { wxOpenId: delivery.targetId });
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
