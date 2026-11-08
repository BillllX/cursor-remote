import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { assistantPath, readJson, type TenantRef } from "../assistant/store.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { hasControlChars, initKbWorkspaceConfig, loadKbWorkspaceConfig, type KbWorkspaceConfig } from "./contract.ts";

export type DropWorkspaceRef = {
  workspaceId: string;
  key: string;
  path: string;
};

export type DropTenantHost = TenantRef & {
  workspaceRoot: string;
  /** 根据工作区目录名（key）或稳定 workspaceId 查找当前真实工作区 */
  resolveWorkspace: (keyOrId: string) => DropWorkspaceRef | null;
};

export type DropTokenRecord = {
  id: string;
  label: string;
  workspaceId: string;
  workspaceKeySnapshot: string;
  salt: string;
  codeHash: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
};

type DropTokenFile = {
  version: 1;
  items: DropTokenRecord[];
};

export type DropSessionGrant = {
  sessionToken: string;
  qaSessionId: string;
  tokenId: string;
  tenantId: string;
  workspaceId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceTitle: string;
  kbConfig: KbWorkspaceConfig;
  submitterName: string;
  clientIp?: string;
  batchId?: string;
  receiptHash?: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
};

const MIN_PASSCODE_LEN = 6;
const MAX_PASSCODE_LEN = 64;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_LOCK_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_ENTRIES = 2048;
const MAX_SESSIONS_PER_TOKEN = 32;
const MAX_SESSIONS_PER_TENANT = 256;

/** 内存短期上传会话表：sessionTokenHash -> DropSessionGrant */
const activeDropSessions = new Map<string, DropSessionGrant>();

export type DropTokensRevokedListener = (ref: TenantRef, revokedTokenIds: ReadonlySet<string>) => void;
export type DropSessionEvictedListener = (grant: DropSessionGrant) => void;

const revokedListeners = new Set<DropTokensRevokedListener>();
const evictedListeners = new Set<DropSessionEvictedListener>();

export function onDropTokensRevoked(listener: DropTokensRevokedListener): () => void {
  revokedListeners.add(listener);
  return () => revokedListeners.delete(listener);
}

export function onDropSessionEvicted(listener: DropSessionEvictedListener): () => void {
  evictedListeners.add(listener);
  return () => evictedListeners.delete(listener);
}

/** 内存防暴力枚举限流表：key -> { failures: number[], attempts: number[], lockedUntil: number, lastSeen: number } */
const authRateLimiter = new Map<
  string,
  { failures: number[]; attempts: number[]; lockedUntil: number; lastSeen: number }
>();

function tokenStorePath(ref: TenantRef): string {
  return assistantPath(ref, "drop-tokens.json");
}

function readTokenFileUnlocked(ref: TenantRef): DropTokenFile {
  const raw = readJson<Partial<DropTokenFile>>(tokenStorePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter((r): r is DropTokenRecord => Boolean(r && typeof r.id === "string"))
    : [];
  return { version: 1, items };
}

function writeTokenFileUnlocked(ref: TenantRef, data: DropTokenFile) {
  atomicWriteFileSync(tokenStorePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

function hashPasscode(passcode: string, saltHex: string): Buffer {
  return scryptSync(passcode, Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
}

function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function cloneSessionGrant(grant: DropSessionGrant): DropSessionGrant {
  return {
    ...grant,
    kbConfig: {
      ...grant.kbConfig,
      allowedCategories: [...grant.kbConfig.allowedCategories],
      allowedExts: [...grant.kbConfig.allowedExts],
    },
  };
}

export function isValidPasscodeFormat(passcode: string): { ok: true; clean: string } | { ok: false; error: string } {
  if (typeof passcode !== "string" || hasControlChars(passcode) || passcode !== passcode.trim()) {
    return { ok: false, error: "投递口令不能包含控制字符或首尾空格" };
  }
  if (passcode.length < MIN_PASSCODE_LEN || passcode.length > MAX_PASSCODE_LEN) {
    return { ok: false, error: `投递口令长度必须在 ${MIN_PASSCODE_LEN}–${MAX_PASSCODE_LEN} 字符之间` };
  }
  return { ok: true, clean: passcode };
}

export function sanitizeSubmitterName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "请填写提交人姓名或称呼" };
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40 || hasControlChars(trimmed)) {
    return { ok: false, error: "提交人称呼需为 1–40 字符且不含控制字符" };
  }
  return { ok: true, name: trimmed };
}

/** 规范化客户端 IP（取首个 IP、去端口/IPv4-mapped 前缀、转小写并截断，防伪造长字符串撑爆内存） */
export function normalizeClientIp(rawIp: string): string {
  const first = (rawIp.split(",")[0] || "").trim().toLowerCase();
  if (!first) return "unknown";
  const withoutMapped = first.startsWith("::ffff:") ? first.slice(7) : first;
  return withoutMapped.slice(0, 64);
}

function rateLimitKey(tenantId: string, clientIp: string): string {
  return `${tenantId}:${normalizeClientIp(clientIp)}`;
}

function sweepRateLimiter(now: number) {
  for (const [k, state] of authRateLimiter.entries()) {
    state.failures = state.failures.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    state.attempts = state.attempts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (state.failures.length === 0 && state.attempts.length === 0 && state.lockedUntil <= now) {
      authRateLimiter.delete(k);
    }
  }
  if (authRateLimiter.size >= MAX_RATE_LIMIT_ENTRIES) {
    // 仅驱逐未处于 lockedUntil 冷却锁定期的旧条目；绝不驱逐正在锁定的 IP
    for (const [k, state] of authRateLimiter.entries()) {
      if (authRateLimiter.size < MAX_RATE_LIMIT_ENTRIES) break;
      if (state.lockedUntil <= now) {
        authRateLimiter.delete(k);
      }
    }
  }
}

function checkAndRecordAttempt(
  tenantId: string,
  clientIp: string,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfterSec: number } {
  const key = rateLimitKey(tenantId, clientIp);
  const existing = authRateLimiter.get(key);
  if (existing) {
    if (existing.lockedUntil > now) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((existing.lockedUntil - now) / 1000)) };
    }
    existing.failures = existing.failures.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    existing.attempts = existing.attempts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (existing.attempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
      return { ok: false, retryAfterSec: 60 };
    }
    existing.attempts.push(now);
    existing.lastSeen = now;
    return { ok: true };
  }
  if (authRateLimiter.size >= MAX_RATE_LIMIT_ENTRIES) {
    sweepRateLimiter(now);
    if (authRateLimiter.size >= MAX_RATE_LIMIT_ENTRIES) {
      // 表已被锁定条目占满，直接 fail-closed 拒绝新 IP 尝试
      return { ok: false, retryAfterSec: 60 };
    }
  }
  authRateLimiter.set(key, { failures: [], attempts: [now], lockedUntil: 0, lastSeen: now });
  return { ok: true };
}

function recordAuthFailure(tenantId: string, clientIp: string, now = Date.now()) {
  if (authRateLimiter.size >= MAX_RATE_LIMIT_ENTRIES / 2) {
    sweepRateLimiter(now);
  }
  const key = rateLimitKey(tenantId, clientIp);
  const state = authRateLimiter.get(key) ?? { failures: [], attempts: [now], lockedUntil: 0, lastSeen: now };
  state.failures = state.failures.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  state.failures.push(now);
  state.lastSeen = now;
  if (state.failures.length >= RATE_LIMIT_MAX_FAILURES) {
    state.lockedUntil = now + RATE_LIMIT_LOCK_MS;
  }
  authRateLimiter.delete(key);
  authRateLimiter.set(key, state);
}

/**
 * 无状态 Webhook 口令验证通过后撤回本次 attempts 计数（但保留已有的 failures 不清零，防止利用合法口令掩护暴力枚举其他口令），
 * 使得合法自动化脚本/热文件夹每分钟连续投递超过 20 个文件时不会触发 429 自锁。
 */
function refundStatelessSuccessAttempt(tenantId: string, clientIp: string) {
  const key = rateLimitKey(tenantId, clientIp);
  const state = authRateLimiter.get(key);
  if (!state) return;
  if (state.attempts.length > 0) {
    state.attempts.pop();
  }
}

/** 测试用：清空内存限流与短期会话状态 */
export function resetDropAuthMemoryStateForTest() {
  activeDropSessions.clear();
  authRateLimiter.clear();
}

/**
 * 为指定知识库工作区创建或更新投递口令（在小驳工具中调用）：
 * 1. 校验目标工作区存在且已配置合法的 .jiebo/kb.json；
 * 2. 口令经 scrypt 派生哈希落盘（0o600 权限），绝不保存明文；
 * 3. 同一租户内不允许两个未吊销口令使用相同的明文 passcode。
 */
export function createDropToken(
  host: DropTenantHost,
  input: {
    workspace: string;
    passcode: string;
    label?: string;
    expiresInDays?: number;
  },
  now = Date.now(),
): { ok: true; record: Omit<DropTokenRecord, "salt" | "codeHash"> } | { ok: false; error: string } {
  const passCheck = isValidPasscodeFormat(input.passcode);
  if (!passCheck.ok) return passCheck;

  const wsRef = host.resolveWorkspace(input.workspace.trim());
  if (!wsRef) {
    return { ok: false, error: `找不到工作区：${input.workspace}` };
  }
  const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbCheck.ok) {
    return {
      ok: false,
      error: `工作区 "${wsRef.key}" 尚未初始化为知识库工作区（${kbCheck.error}），请先调用 kb_workspace_init 初始化`,
    };
  }

  const label = (input.label?.trim() || `${wsRef.key} 投递码`).slice(0, 80);
  if (hasControlChars(label)) {
    return { ok: false, error: "备注名称包含非法控制字符" };
  }

  let expiresAt: number | undefined;
  if (input.expiresInDays !== undefined) {
    if (
      typeof input.expiresInDays !== "number" ||
      !Number.isFinite(input.expiresInDays) ||
      input.expiresInDays <= 0 ||
      input.expiresInDays > 3650
    ) {
      return { ok: false, error: "expiresInDays 必须为 1–3650 之间的正数" };
    }
    expiresAt = now + Math.floor(input.expiresInDays * 86_400_000);
  }

  const file = tokenStorePath(host);
  return withFileLockSync(file, () => {
    const data = readTokenFileUnlocked(host);
    for (const existing of data.items) {
      if (existing.revokedAt) continue;
      if (existing.expiresAt && existing.expiresAt <= now) continue;
      const candidateHash = hashPasscode(passCheck.clean, existing.salt);
      const storedBuf = Buffer.from(existing.codeHash, "hex");
      if (storedBuf.length === candidateHash.length && timingSafeEqual(storedBuf, candidateHash)) {
        return { ok: false as const, error: "该投递口令已存在且处于有效状态，请更换口令或先吊销旧口令" };
      }
    }

    const salt = randomBytes(16).toString("hex");
    const codeHash = hashPasscode(passCheck.clean, salt).toString("hex");
    const record: DropTokenRecord = {
      id: `dt_${now.toString(36)}${randomBytes(4).toString("hex")}`,
      label,
      workspaceId: wsRef.workspaceId,
      workspaceKeySnapshot: wsRef.key,
      salt,
      codeHash,
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    data.items.push(record);
    writeTokenFileUnlocked(host, data);

    const { salt: _s, codeHash: _h, ...publicRecord } = record;
    return { ok: true as const, record: publicRecord };
  });
}

/** 列出当前租户下的投递口令（不含 salt 和 codeHash） */
export function listDropTokens(
  host: DropTenantHost,
  opts: { includeRevoked?: boolean; now?: number } = {},
): Array<{
  id: string;
  label: string;
  workspaceId: string;
  workspaceKey: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  active: boolean;
}> {
  const now = opts.now ?? Date.now();
  const data = readTokenFileUnlocked(host);
  return data.items
    .filter((item) => opts.includeRevoked || !item.revokedAt)
    .map((item) => {
      const resolvedWs = host.resolveWorkspace(item.workspaceId);
      const expired = Boolean(item.expiresAt && item.expiresAt <= now);
      const active = !item.revokedAt && !expired && Boolean(resolvedWs);
      return {
        id: item.id,
        label: item.label,
        workspaceId: item.workspaceId,
        workspaceKey: resolvedWs?.key ?? item.workspaceKeySnapshot,
        createdAt: item.createdAt,
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        ...(item.revokedAt ? { revokedAt: item.revokedAt } : {}),
        active,
      };
    });
}

/** 吊销匹配 id 或 label 的所有未吊销投递口令，并立即清除其派生的所有活跃上传会话 */
export function revokeDropToken(
  host: TenantRef,
  idOrLabel: string,
  now = Date.now(),
  workspaceId?: string,
): { ok: true; revokedIds: string[]; revokedId: string } | { ok: false; error: string } {
  const target = idOrLabel.trim();
  if (!target) return { ok: false, error: "请提供要吊销的口令 id 或 label" };
  const file = tokenStorePath(host);
  const res = withFileLockSync(file, () => {
    const data = readTokenFileUnlocked(host);
    const matches = data.items.filter(
      (item) =>
        !item.revokedAt &&
        (!workspaceId || item.workspaceId === workspaceId) &&
        (item.id === target || item.label === target),
    );
    if (matches.length === 0) {
      return { ok: false as const, error: `未找到有效口令：${target}` };
    }
    const revokedIdSet = new Set<string>();
    for (const item of matches) {
      item.revokedAt = now;
      revokedIdSet.add(item.id);
    }
    writeTokenFileUnlocked(host, data);

    for (const [hashKey, sess] of activeDropSessions.entries()) {
      if (sess.tenantId === host.id && revokedIdSet.has(sess.tokenId)) {
        activeDropSessions.delete(hashKey);
      }
    }
    const revokedIds = [...revokedIdSet];
    return { ok: true as const, revokedIds, revokedId: revokedIds[0], revokedIdSet };
  });

  if (res.ok) {
    for (const listener of revokedListeners) {
      try {
        listener(host, res.revokedIdSet);
      } catch {
        // ignore listener error
      }
    }
    return { ok: true, revokedIds: res.revokedIds, revokedId: res.revokedId };
  }
  return res;
}

/**
 * 外部同事在网页端输入投递口令进行校验并签发短期上传会话 Token：
 * 1. 先检查 IP 限流冷却（注意：成功认证不会清空该 IP 已有的失败记录，防止持有 A 口令者交替暴力枚举 B 口令）；
 * 2. 遍历有效口令做常量时间哈希比对；
 * 3. 动态解析 workspaceId 当前路径并实时复核 .jiebo/kb.json 合法且位于租户根目录内（若工作区失效统一返回 401 并记失败，不泄露口令已命中）。
 */
export function verifyDropPasscodeAndCreateSession(
  host: DropTenantHost,
  input: {
    passcode: string;
    submitterName: string;
    clientIp: string;
  },
  now = Date.now(),
):
  | {
      ok: true;
      session: DropSessionGrant;
    }
  | {
      ok: false;
      status: 400 | 401 | 429;
      error: string;
      retryAfterSec?: number;
    } {
  const rate = checkAndRecordAttempt(host.id, input.clientIp, now);
  if (!rate.ok) {
    return {
      ok: false,
      status: 429,
      error: `口令尝试次数过多，请 ${rate.retryAfterSec} 秒后再试`,
      retryAfterSec: rate.retryAfterSec,
    };
  }

  const submitter = sanitizeSubmitterName(input.submitterName);
  if (!submitter.ok) {
    return { ok: false, status: 400, error: submitter.error };
  }

  const passCheck = isValidPasscodeFormat(input.passcode);
  if (!passCheck.ok) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const data = readTokenFileUnlocked(host);
  let matchedRecord: DropTokenRecord | null = null;
  for (const record of data.items) {
    if (record.revokedAt) continue;
    if (record.expiresAt && record.expiresAt <= now) continue;
    const computed = hashPasscode(passCheck.clean, record.salt);
    const expected = Buffer.from(record.codeHash, "hex");
    if (expected.length === computed.length && timingSafeEqual(expected, computed)) {
      matchedRecord = record;
    }
  }

  if (!matchedRecord) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const wsRef = host.resolveWorkspace(matchedRecord.workspaceId);
  if (!wsRef) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbLoaded.ok) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  // 清理过期 session，并按 tokenId（上限 32）与 tenantId（上限 256）分区淘汰最旧会话，绝不影响其他口令或租户
  const evictedGrants: DropSessionGrant[] = [];
  for (const [k, v] of activeDropSessions.entries()) {
    if (v.expiresAt <= now) {
      activeDropSessions.delete(k);
      evictedGrants.push(v);
    }
  }
  const sameTokenKeys: string[] = [];
  const sameTenantKeys: string[] = [];
  for (const [k, v] of activeDropSessions.entries()) {
    if (v.tenantId === host.id) {
      sameTenantKeys.push(k);
      if (v.tokenId === matchedRecord.id) {
        sameTokenKeys.push(k);
      }
    }
  }
  while (sameTokenKeys.length >= MAX_SESSIONS_PER_TOKEN) {
    const evictKey = sameTokenKeys.shift()!;
    const prev = activeDropSessions.get(evictKey);
    activeDropSessions.delete(evictKey);
    if (prev) evictedGrants.push(prev);
    const idx = sameTenantKeys.indexOf(evictKey);
    if (idx >= 0) sameTenantKeys.splice(idx, 1);
  }
  while (sameTenantKeys.length >= MAX_SESSIONS_PER_TENANT) {
    const evictKey = sameTenantKeys.shift()!;
    const prev = activeDropSessions.get(evictKey);
    activeDropSessions.delete(evictKey);
    if (prev) evictedGrants.push(prev);
  }

  for (const evicted of evictedGrants) {
    for (const listener of evictedListeners) {
      try {
        listener(evicted);
      } catch {
        // ignore listener error
      }
    }
  }

  const rawSessionToken = `ds_${randomBytes(24).toString("hex")}`;
  const qaSessionId = `qa_${randomBytes(16).toString("hex")}`;
  const normalizedIp = normalizeClientIp(input.clientIp);
  const grant: DropSessionGrant = {
    sessionToken: rawSessionToken,
    qaSessionId,
    tokenId: matchedRecord.id,
    tenantId: host.id,
    workspaceId: wsRef.workspaceId,
    workspaceKey: wsRef.key,
    workspacePath: kbLoaded.workspaceRealPath,
    workspaceTitle: kbLoaded.config.title,
    kbConfig: kbLoaded.config,
    submitterName: submitter.name,
    clientIp: normalizedIp,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  activeDropSessions.set(hashSessionToken(rawSessionToken), grant);

  return { ok: true, session: cloneSessionGrant(grant) };
}

/**
 * 校验短期上传会话 Token，并实时复核口令未被吊销、工作区路径仍在租户根内且 kb.json 有效。
 */
export function verifyDropSessionToken(
  host: DropTenantHost,
  rawSessionToken: string,
  now = Date.now(),
  expectedClientIp?: string,
): { ok: true; session: DropSessionGrant } | { ok: false; status: 401 | 403; error: string } {
  const token = rawSessionToken.trim();
  if (!token.startsWith("ds_") || token.length < 20) {
    return { ok: false, status: 401, error: "未授权或上传会话已失效" };
  }
  const key = hashSessionToken(token);
  const sess = activeDropSessions.get(key);
  if (!sess || sess.tenantId !== host.id) {
    return { ok: false, status: 401, error: "未授权或上传会话已失效" };
  }
  if (expectedClientIp && sess.clientIp && normalizeClientIp(expectedClientIp) !== sess.clientIp) {
    return { ok: false, status: 403, error: "会话客户端网络地址不匹配，请重新输入口令" };
  }

  const dropAndNotifyEvicted = (grant: DropSessionGrant) => {
    activeDropSessions.delete(key);
    for (const listener of evictedListeners) {
      try {
        listener(grant);
      } catch {
        // ignore
      }
    }
  };

  if (sess.expiresAt <= now || now - sess.createdAt >= SESSION_MAX_LIFETIME_MS) {
    dropAndNotifyEvicted(sess);
    return { ok: false, status: 401, error: "上传会话已过期，请重新输入口令" };
  }

  // 实时复核底层口令是否已被吊销或过期
  const data = readTokenFileUnlocked(host);
  const tokenRecord = data.items.find((r) => r.id === sess.tokenId);
  if (!tokenRecord || tokenRecord.revokedAt || (tokenRecord.expiresAt && tokenRecord.expiresAt <= now)) {
    dropAndNotifyEvicted(sess);
    return { ok: false, status: 401, error: "投递口令已被吊销或过期" };
  }

  // 实时复核工作区仍然有效（哪怕工作区中途改名也能按稳定 workspaceId 解析到新路径）
  const wsRef = host.resolveWorkspace(sess.workspaceId);
  if (!wsRef) {
    dropAndNotifyEvicted(sess);
    return { ok: false, status: 403, error: "目标工作区已不存在" };
  }
  const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbLoaded.ok) {
    dropAndNotifyEvicted(sess);
    return { ok: false, status: 403, error: "目标工作区知识库配置已失效" };
  }

  // 更新最新路径与配置快照，滑动顺延 expiresAt（受限于 createdAt + 2h 封顶），刷新 LRU 顺序，并返回深拷贝副本防外部篡改
  sess.workspaceKey = wsRef.key;
  sess.workspacePath = kbLoaded.workspaceRealPath;
  sess.workspaceTitle = kbLoaded.config.title;
  sess.kbConfig = kbLoaded.config;
  sess.lastActiveAt = now;
  const maxLifetimeDeadline = sess.createdAt + SESSION_MAX_LIFETIME_MS;
  sess.expiresAt = Math.min(maxLifetimeDeadline, now + SESSION_TTL_MS);
  activeDropSessions.delete(key);
  activeDropSessions.set(key, sess);

  return { ok: true, session: cloneSessionGrant(sess) };
}

/** 将创建好的 batchId（及可选的 receiptHash）绑定到短期上传会话上，后续该会话只能操作该 batchId */
export function bindBatchIdToDropSession(rawSessionToken: string, batchId: string, receiptHash?: string): boolean {
  const key = hashSessionToken(rawSessionToken.trim());
  const sess = activeDropSessions.get(key);
  if (!sess) return false;
  sess.batchId = batchId;
  if (receiptHash) sess.receiptHash = receiptHash;
  return true;
}

/**
 * 供单步 Webhook / CLI / 本地热文件夹同步使用的无状态口令校验：
 * 1. 与网页登录共享同一套 IP 限流器（checkAndRecordAttempt / recordAuthFailure），防暴力枚举；
 * 2. 常量时间 scrypt 比对口令，实时校验口令未吊销/未过期、工作区存在且 .jiebo/kb.json 合法；
 * 3. 返回一次性内存授权对象（不写入 activeDropSessions，避免高频自动化推送挤掉浏览器交互式会话）。
 */
export function verifyDropPasscodeStateless(
  host: DropTenantHost,
  input: {
    passcode: string;
    submitterName?: string;
    clientIp: string;
  },
  now = Date.now(),
):
  | {
      ok: true;
      session: DropSessionGrant;
    }
  | {
      ok: false;
      status: 400 | 401 | 429;
      error: string;
      retryAfterSec?: number;
    } {
  const rate = checkAndRecordAttempt(host.id, input.clientIp, now);
  if (!rate.ok) {
    return {
      ok: false,
      status: 429,
      error: `口令尝试次数过多，请 ${rate.retryAfterSec} 秒后再试`,
      retryAfterSec: rate.retryAfterSec,
    };
  }

  const rawSubmitter =
    typeof input.submitterName === "string" && input.submitterName.trim() ? input.submitterName : "Webhook 自动投递";
  const submitter = sanitizeSubmitterName(rawSubmitter);
  if (!submitter.ok) {
    return { ok: false, status: 400, error: submitter.error };
  }

  const passCheck = isValidPasscodeFormat(input.passcode);
  if (!passCheck.ok) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const data = readTokenFileUnlocked(host);
  let matchedRecord: DropTokenRecord | null = null;
  for (const record of data.items) {
    if (record.revokedAt) continue;
    if (record.expiresAt && record.expiresAt <= now) continue;
    const computed = hashPasscode(passCheck.clean, record.salt);
    const expected = Buffer.from(record.codeHash, "hex");
    if (expected.length === computed.length && timingSafeEqual(expected, computed)) {
      matchedRecord = record;
    }
  }

  if (!matchedRecord) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const wsRef = host.resolveWorkspace(matchedRecord.workspaceId);
  if (!wsRef) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbLoaded.ok) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  refundStatelessSuccessAttempt(host.id, input.clientIp);

  const grant: DropSessionGrant = {
    sessionToken: `ds_wh_${randomBytes(20).toString("hex")}`,
    qaSessionId: `qa_wh_${randomBytes(12).toString("hex")}`,
    tokenId: matchedRecord.id,
    tenantId: host.id,
    workspaceId: wsRef.workspaceId,
    workspaceKey: wsRef.key,
    workspacePath: kbLoaded.workspaceRealPath,
    workspaceTitle: kbLoaded.config.title,
    kbConfig: kbLoaded.config,
    submitterName: submitter.name,
    clientIp: normalizeClientIp(input.clientIp),
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };

  return { ok: true, session: cloneSessionGrant(grant) };
}

/**
 * 在单步流式上传结束时复核无状态 Webhook 会话对应的口令是否仍有效（未被中途吊销或过期）、工作区是否仍合法。
 */
export function reverifyStatelessDropSession(
  host: DropTenantHost,
  grant: DropSessionGrant,
  now = Date.now(),
): { ok: true; session: DropSessionGrant } | { ok: false; status: 401 | 403; error: string } {
  const data = readTokenFileUnlocked(host);
  const tokenRecord = data.items.find((r) => r.id === grant.tokenId);
  if (!tokenRecord || tokenRecord.revokedAt || (tokenRecord.expiresAt && tokenRecord.expiresAt <= now)) {
    return { ok: false, status: 401, error: "投递口令已被吊销或过期" };
  }
  const wsRef = host.resolveWorkspace(grant.workspaceId);
  if (!wsRef) {
    return { ok: false, status: 403, error: "目标工作区已不存在" };
  }
  const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
  if (!kbLoaded.ok) {
    return { ok: false, status: 403, error: "目标工作区知识库配置已失效" };
  }
  return {
    ok: true,
    session: cloneSessionGrant({
      ...grant,
      workspaceKey: wsRef.key,
      workspacePath: kbLoaded.workspaceRealPath,
      workspaceTitle: kbLoaded.config.title,
      kbConfig: kbLoaded.config,
      lastActiveAt: now,
    }),
  };
}

/** 供小驳调用的知识库工作区初始化包装（校验工作区位于租户根内） */
export function setupKbWorkspaceForTenant(
  host: DropTenantHost,
  input: {
    workspace: string;
    title: string;
    categories: string[];
  },
): { ok: true; workspaceKey: string; workspaceId: string; config: KbWorkspaceConfig } | { ok: false; error: string } {
  const wsRef = host.resolveWorkspace(input.workspace.trim());
  if (!wsRef) {
    return { ok: false, error: `找不到工作区：${input.workspace}` };
  }
  const targetDir = resolve(host.workspaceRoot, wsRef.key);
  const initRes = initKbWorkspaceConfig(targetDir, {
    title: input.title,
    allowedCategories: input.categories,
  });
  if (!initRes.ok) return initRes;
  const loaded = loadKbWorkspaceConfig(targetDir, host.workspaceRoot);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    workspaceKey: wsRef.key,
    workspaceId: wsRef.workspaceId,
    config: loaded.config,
  };
}
