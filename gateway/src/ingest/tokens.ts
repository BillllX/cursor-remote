import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { ColleaguePermissions, KbDropTokenItem } from "../../../shared/protocol.ts";
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

export type DropTokenWorkspaceBinding = {
  workspaceId: string;
  workspaceKeySnapshot: string;
};

export type DropTokenWxBinding = {
  status: "pending_owner" | "active" | "revoked";
  botId?: string;
  openId?: string;
  nickname?: string;
  updatedAt: number;
};

export type DropTokenRecord = {
  id: string;
  label: string;
  workspaceId: string;
  workspaceKeySnapshot: string;
  /** 多知识库绑定列表（向下兼容：缺省时自动按 [workspaceId] 处理） */
  workspaces?: DropTokenWorkspaceBinding[];
  /** 同事细粒度权限开关 */
  permissions?: ColleaguePermissions;
  /** 关联的平台内部 IM 租户账号 ID */
  imTenantId?: string;
  /** 关联的微信通道身份 */
  wxBinding?: DropTokenWxBinding;
  salt: string;
  codeHash: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
};

export type OwnerWxBinding = {
  botId: string;
  openId: string;
  nickname?: string;
  boundAt: number;
};

type DropTokenFile = {
  version: 1;
  ownerWx?: OwnerWxBinding;
  items: DropTokenRecord[];
};

export type AuthorizedWorkspaceGrant = {
  workspaceId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceTitle: string;
  kbConfig: KbWorkspaceConfig;
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
  /** 该口令当前获权访问的全部有效知识库工作区 */
  authorizedWorkspaces?: AuthorizedWorkspaceGrant[];
  /** 该同事的权限开关 */
  permissions?: ColleaguePermissions;
  submitterName: string;
  clientIp?: string;
  batchId?: string;
  receiptHash?: string;
  /** 是否为持久化记住登录会话（落盘于 drop-sessions.json，跨网关重启不丢） */
  persistent?: boolean;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
};

type PersistedDropSessionRecord = {
  sessionTokenHash: string;
  qaSessionId: string;
  tokenId: string;
  tenantId: string;
  activeWorkspaceId: string;
  submitterName: string;
  createdAt: number;
  lastActiveAt: number;
};

type PersistedDropSessionFile = {
  version: 1;
  items: PersistedDropSessionRecord[];
};

const MIN_PASSCODE_LEN = 6;
const MAX_PASSCODE_LEN = 64;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const SESSION_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
/** 持久化记住登录态寿命：10 年（只要底层口令未吊销/未过期即长期有效） */
export const PERSISTENT_SESSION_TTL_MS = 10 * 365 * 86_400_000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_LOCK_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_ENTRIES = 2048;
const MAX_SESSIONS_PER_TOKEN = 32;
const MAX_SESSIONS_PER_TENANT = 256;

export const DEFAULT_COLLEAGUE_PERMISSIONS: ColleaguePermissions = {
  kbAsk: true,
  kbDrop: true,
  kbPropose: true,
  calendarFreeBusy: true,
  calendarPropose: true,
};

/** 内存短期/长期上传会话表：sessionTokenHash -> DropSessionGrant */
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

function persistentSessionStorePath(ref: TenantRef): string {
  return assistantPath(ref, "drop-sessions.json");
}

function readTokenFileUnlocked(ref: TenantRef): DropTokenFile {
  const raw = readJson<Partial<DropTokenFile>>(tokenStorePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter((r): r is DropTokenRecord => Boolean(r && typeof r.id === "string"))
    : [];
  return {
    version: 1,
    ...(raw.ownerWx && typeof raw.ownerWx === "object" ? { ownerWx: raw.ownerWx } : {}),
    items,
  };
}

function writeTokenFileUnlocked(ref: TenantRef, data: DropTokenFile) {
  atomicWriteFileSync(tokenStorePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mkdir: true,
    mode: 0o600,
  });
}

function readPersistentSessionsUnlocked(ref: TenantRef): PersistedDropSessionFile {
  const raw = readJson<Partial<PersistedDropSessionFile>>(persistentSessionStorePath(ref), { version: 1, items: [] });
  const items = Array.isArray(raw.items)
    ? raw.items.filter(
        (r): r is PersistedDropSessionRecord =>
          Boolean(r && typeof r.sessionTokenHash === "string" && typeof r.tokenId === "string"),
      )
    : [];
  return { version: 1, items };
}

function writePersistentSessionsUnlocked(ref: TenantRef, data: PersistedDropSessionFile) {
  atomicWriteFileSync(persistentSessionStorePath(ref), `${JSON.stringify(data, null, 2)}\n`, {
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

export function normalizeColleaguePermissions(raw?: Partial<ColleaguePermissions>): ColleaguePermissions {
  return {
    kbAsk: raw?.kbAsk !== undefined ? Boolean(raw.kbAsk) : DEFAULT_COLLEAGUE_PERMISSIONS.kbAsk,
    kbDrop: raw?.kbDrop !== undefined ? Boolean(raw.kbDrop) : DEFAULT_COLLEAGUE_PERMISSIONS.kbDrop,
    kbPropose: raw?.kbPropose !== undefined ? Boolean(raw.kbPropose) : DEFAULT_COLLEAGUE_PERMISSIONS.kbPropose,
    calendarFreeBusy:
      raw?.calendarFreeBusy !== undefined ? Boolean(raw.calendarFreeBusy) : DEFAULT_COLLEAGUE_PERMISSIONS.calendarFreeBusy,
    calendarPropose:
      raw?.calendarPropose !== undefined ? Boolean(raw.calendarPropose) : DEFAULT_COLLEAGUE_PERMISSIONS.calendarPropose,
  };
}

/** 归一化提取一条口令记录绑定的所有工作区（向下兼容单字段 workspaceId） */
export function getTokenWorkspaceBindings(record: DropTokenRecord): DropTokenWorkspaceBinding[] {
  const seen = new Set<string>();
  const result: DropTokenWorkspaceBinding[] = [];
  const rawList = Array.isArray(record.workspaces) && record.workspaces.length > 0
    ? record.workspaces
    : [{ workspaceId: record.workspaceId, workspaceKeySnapshot: record.workspaceKeySnapshot }];
  for (const item of rawList) {
    if (!item || typeof item.workspaceId !== "string" || !item.workspaceId.trim()) continue;
    const id = item.workspaceId.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      workspaceId: id,
      workspaceKeySnapshot: (item.workspaceKeySnapshot || id).trim(),
    });
  }
  if (result.length === 0 && record.workspaceId) {
    result.push({
      workspaceId: record.workspaceId,
      workspaceKeySnapshot: record.workspaceKeySnapshot || record.workspaceId,
    });
  }
  return result;
}

/** 解析口令记录下当前所有真实有效且含合法 .jiebo/kb.json 的知识库工作区 */
export function resolveAuthorizedWorkspacesForToken(
  host: DropTenantHost,
  record: DropTokenRecord,
): AuthorizedWorkspaceGrant[] {
  const bindings = getTokenWorkspaceBindings(record);
  const grants: AuthorizedWorkspaceGrant[] = [];
  for (const b of bindings) {
    const wsRef = host.resolveWorkspace(b.workspaceId) ?? host.resolveWorkspace(b.workspaceKeySnapshot);
    if (!wsRef) continue;
    const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
    if (!kbLoaded.ok) continue;
    if (grants.some((g) => g.workspaceId === wsRef.workspaceId)) continue;
    grants.push({
      workspaceId: wsRef.workspaceId,
      workspaceKey: wsRef.key,
      workspacePath: kbLoaded.workspaceRealPath,
      workspaceTitle: kbLoaded.config.title,
      kbConfig: kbLoaded.config,
    });
  }
  return grants;
}

function cloneKbConfig(cfg: KbWorkspaceConfig): KbWorkspaceConfig {
  return {
    ...cfg,
    allowedCategories: [...cfg.allowedCategories],
    allowedExts: [...cfg.allowedExts],
  };
}

function cloneSessionGrant(grant: DropSessionGrant): DropSessionGrant {
  return {
    ...grant,
    kbConfig: cloneKbConfig(grant.kbConfig),
    ...(grant.authorizedWorkspaces
      ? {
          authorizedWorkspaces: grant.authorizedWorkspaces.map((w) => ({
            ...w,
            kbConfig: cloneKbConfig(w.kbConfig),
          })),
        }
      : {}),
    ...(grant.permissions ? { permissions: { ...grant.permissions } } : {}),
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

function validateAndResolveWorkspaces(
  host: DropTenantHost,
  workspaceKeysOrIds: string[],
): { ok: true; bindings: DropTokenWorkspaceBinding[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const bindings: DropTokenWorkspaceBinding[] = [];
  for (const raw of workspaceKeysOrIds) {
    const target = raw.trim();
    if (!target) continue;
    const wsRef = host.resolveWorkspace(target);
    if (!wsRef) {
      return { ok: false, error: `找不到工作区：${target}` };
    }
    const kbCheck = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
    if (!kbCheck.ok) {
      return {
        ok: false,
        error: `工作区 "${wsRef.key}" 尚未初始化为知识库工作区（${kbCheck.error}），请先调用 kb_workspace_init 初始化`,
      };
    }
    if (seen.has(wsRef.workspaceId)) continue;
    seen.add(wsRef.workspaceId);
    bindings.push({
      workspaceId: wsRef.workspaceId,
      workspaceKeySnapshot: wsRef.key,
    });
  }
  if (bindings.length === 0) {
    return { ok: false, error: "请至少指定一个有效的知识库工作区" };
  }
  return { ok: true, bindings };
}

/**
 * 为指定知识库工作区创建投递口令/同事通行证（支持一次绑定多个知识库工作区、配置日历与提案权限、关联站内 IM 账号，默认不过期）：
 * 1. 校验所有目标工作区存在且已配置合法的 .jiebo/kb.json；
 * 2. 口令经 scrypt 派生哈希落盘（0o600 权限），绝不保存明文；
 * 3. 同一租户内不允许两个未吊销口令使用相同的明文 passcode（防撞库越权）。
 */
export function createDropToken(
  host: DropTenantHost,
  input: {
    workspace: string;
    workspaces?: string[];
    passcode: string;
    label?: string;
    expiresInDays?: number;
    permissions?: Partial<ColleaguePermissions>;
    imTenantId?: string;
  },
  now = Date.now(),
): { ok: true; record: Omit<DropTokenRecord, "salt" | "codeHash"> } | { ok: false; error: string } {
  const passCheck = isValidPasscodeFormat(input.passcode);
  if (!passCheck.ok) return passCheck;

  const requestedWsList = [
    input.workspace,
    ...(Array.isArray(input.workspaces) ? input.workspaces : []),
  ].filter((x): x is string => typeof x === "string" && Boolean(x.trim()));

  const wsResolved = validateAndResolveWorkspaces(host, requestedWsList);
  if (!wsResolved.ok) return wsResolved;
  const primary = wsResolved.bindings[0]!;

  const label = (input.label?.trim() || `${primary.workspaceKeySnapshot} 投递码`).slice(0, 80);
  if (hasControlChars(label)) {
    return { ok: false, error: "备注名称包含非法控制字符" };
  }

  let expiresAt: number | undefined;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    if (
      typeof input.expiresInDays !== "number" ||
      !Number.isFinite(input.expiresInDays) ||
      input.expiresInDays <= 0 ||
      input.expiresInDays > 3650
    ) {
      return { ok: false, error: "expiresInDays 必须为 1–3650 之间的正数（不传则永久有效不过期）" };
    }
    expiresAt = now + Math.floor(input.expiresInDays * 86_400_000);
  }

  const imTenantId = input.imTenantId?.trim() || undefined;
  if (imTenantId && hasControlChars(imTenantId)) {
    return { ok: false, error: "关联的 IM 账号包含非法字符" };
  }

  const permissions = normalizeColleaguePermissions(input.permissions);

  const file = tokenStorePath(host);
  return withFileLockSync(file, () => {
    const data = readTokenFileUnlocked(host);
    for (const existing of data.items) {
      if (existing.revokedAt) continue;
      if (existing.expiresAt && existing.expiresAt <= now) continue;
      const candidateHash = hashPasscode(passCheck.clean, existing.salt);
      const storedBuf = Buffer.from(existing.codeHash, "hex");
      if (storedBuf.length === candidateHash.length && timingSafeEqual(storedBuf, candidateHash)) {
        return {
          ok: false as const,
          error: `该投递口令已被「${existing.label}」使用，请直接将该同事授权加入本知识库或更换口令`,
        };
      }
    }

    const salt = randomBytes(16).toString("hex");
    const codeHash = hashPasscode(passCheck.clean, salt).toString("hex");
    const record: DropTokenRecord = {
      id: `dt_${now.toString(36)}${randomBytes(4).toString("hex")}`,
      label,
      workspaceId: primary.workspaceId,
      workspaceKeySnapshot: primary.workspaceKeySnapshot,
      workspaces: wsResolved.bindings,
      permissions,
      ...(imTenantId ? { imTenantId } : {}),
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

/**
 * 显式更新已有同事通行证（支持增删绑定的知识库工作区、修改权限开关、关联站内 IM 账号、设为永不过期或调整有效期）
 */
export function updateDropToken(
  host: DropTenantHost,
  input: {
    tokenId: string;
    label?: string;
    addWorkspaces?: string[];
    removeWorkspaces?: string[];
    permissions?: Partial<ColleaguePermissions>;
    imTenantId?: string | null;
    wxBinding?: DropTokenWxBinding | null;
    neverExpire?: boolean;
    expiresInDays?: number;
  },
  now = Date.now(),
): { ok: true; record: Omit<DropTokenRecord, "salt" | "codeHash"> } | { ok: false; error: string } {
  const targetId = input.tokenId.trim();
  if (!targetId) return { ok: false, error: "请指定要更新的口令 ID" };

  let toAddBindings: DropTokenWorkspaceBinding[] = [];
  if (Array.isArray(input.addWorkspaces) && input.addWorkspaces.length > 0) {
    const check = validateAndResolveWorkspaces(host, input.addWorkspaces);
    if (!check.ok) return check;
    toAddBindings = check.bindings;
  }

  const removeSet = new Set<string>();
  if (Array.isArray(input.removeWorkspaces)) {
    for (const raw of input.removeWorkspaces) {
      const clean = raw.trim();
      if (!clean) continue;
      const wsRef = host.resolveWorkspace(clean);
      removeSet.add(wsRef ? wsRef.workspaceId : clean);
    }
  }

  const file = tokenStorePath(host);
  return withFileLockSync(file, () => {
    const data = readTokenFileUnlocked(host);
    const record = data.items.find((r) => r.id === targetId && !r.revokedAt);
    if (!record) {
      return { ok: false as const, error: `找不到有效的同事口令：${targetId}` };
    }

    if (input.label !== undefined) {
      const cleanLabel = input.label.trim().slice(0, 80);
      if (!cleanLabel || hasControlChars(cleanLabel)) {
        return { ok: false as const, error: "称呼备注不能为空或含控制字符" };
      }
      record.label = cleanLabel;
    }

    let bindings = getTokenWorkspaceBindings(record);
    if (removeSet.size > 0) {
      bindings = bindings.filter(
        (b) => !removeSet.has(b.workspaceId) && !removeSet.has(b.workspaceKeySnapshot),
      );
    }
    for (const add of toAddBindings) {
      if (!bindings.some((b) => b.workspaceId === add.workspaceId)) {
        bindings.push(add);
      }
    }
    if (bindings.length === 0) {
      return { ok: false as const, error: "至少需要保留一个关联的知识库工作区（如需彻底停用请点全局吊销）" };
    }
    record.workspaces = bindings;
    record.workspaceId = bindings[0]!.workspaceId;
    record.workspaceKeySnapshot = bindings[0]!.workspaceKeySnapshot;

    if (input.permissions) {
      record.permissions = normalizeColleaguePermissions({
        ...normalizeColleaguePermissions(record.permissions),
        ...input.permissions,
      });
    } else if (!record.permissions) {
      record.permissions = normalizeColleaguePermissions();
    }

    if (input.imTenantId !== undefined) {
      if (input.imTenantId === null || input.imTenantId.trim() === "") {
        delete record.imTenantId;
      } else {
        const cleanIm = input.imTenantId.trim();
        if (hasControlChars(cleanIm)) {
          return { ok: false as const, error: "IM 账号 ID 非法" };
        }
        record.imTenantId = cleanIm;
      }
    }

    if (input.wxBinding !== undefined) {
      if (input.wxBinding === null) {
        delete record.wxBinding;
      } else {
        record.wxBinding = input.wxBinding;
      }
    }

    if (input.neverExpire === true) {
      delete record.expiresAt;
    } else if (typeof input.expiresInDays === "number" && Number.isFinite(input.expiresInDays) && input.expiresInDays > 0) {
      record.expiresAt = now + Math.floor(Math.min(3650, input.expiresInDays) * 86_400_000);
    }

    writeTokenFileUnlocked(host, data);
    const { salt: _s, codeHash: _h, ...publicRecord } = record;
    return { ok: true as const, record: publicRecord };
  });
}

/** 读取或设置主人（Owner）绑定的个人微信通知通道 */
export function getOwnerWxBinding(ref: TenantRef): OwnerWxBinding | undefined {
  return readTokenFileUnlocked(ref).ownerWx;
}

export function setOwnerWxBinding(ref: TenantRef, binding: OwnerWxBinding | undefined): void {
  const file = tokenStorePath(ref);
  withFileLockSync(file, () => {
    const data = readTokenFileUnlocked(ref);
    if (binding) data.ownerWx = binding;
    else delete data.ownerWx;
    writeTokenFileUnlocked(ref, data);
  });
}

/** 按平台内部 IM 租户账号或微信 openId 查找对应的同事通行证记录 */
export function findColleaguePassByChannel(
  host: DropTenantHost,
  query: { imTenantId?: string; wxOpenId?: string },
  now = Date.now(),
): { record: DropTokenRecord; workspaces: AuthorizedWorkspaceGrant[]; permissions: ColleaguePermissions } | null {
  const data = readTokenFileUnlocked(host);
  for (const item of data.items) {
    if (item.revokedAt) continue;
    if (item.expiresAt && item.expiresAt <= now) continue;
    const matchedIm = Boolean(query.imTenantId && item.imTenantId && item.imTenantId === query.imTenantId.trim());
    const matchedWx = Boolean(
      query.wxOpenId &&
        item.wxBinding?.status === "active" &&
        item.wxBinding.openId &&
        item.wxBinding.openId === query.wxOpenId.trim(),
    );
    if (!matchedIm && !matchedWx) continue;
    const workspaces = resolveAuthorizedWorkspacesForToken(host, item);
    return {
      record: item,
      workspaces,
      permissions: normalizeColleaguePermissions(item.permissions),
    };
  }
  return null;
}

/** 列出当前租户下的投递口令/同事通行证（不含 salt 和 codeHash） */
export function listDropTokens(
  host: DropTenantHost,
  opts: { includeRevoked?: boolean; now?: number } = {},
): KbDropTokenItem[] {
  const now = opts.now ?? Date.now();
  const data = readTokenFileUnlocked(host);
  return data.items
    .filter((item) => opts.includeRevoked || !item.revokedAt)
    .map((item) => {
      const rawBindings = getTokenWorkspaceBindings(item);
      const workspaces = rawBindings.map((b) => {
        const resolved = host.resolveWorkspace(b.workspaceId) ?? host.resolveWorkspace(b.workspaceKeySnapshot);
        return {
          workspaceId: resolved?.workspaceId ?? b.workspaceId,
          workspaceKey: resolved?.key ?? b.workspaceKeySnapshot,
        };
      });
      const validGrants = resolveAuthorizedWorkspacesForToken(host, item);
      const primaryResolved =
        validGrants[0] ??
        workspaces[0] ?? {
          workspaceId: item.workspaceId,
          workspaceKey: item.workspaceKeySnapshot,
        };
      const expired = Boolean(item.expiresAt && item.expiresAt <= now);
      const active = !item.revokedAt && !expired && validGrants.length > 0;
      return {
        id: item.id,
        label: item.label,
        workspaceId: primaryResolved.workspaceId,
        workspaceKey: primaryResolved.workspaceKey,
        workspaces,
        permissions: normalizeColleaguePermissions(item.permissions),
        ...(item.imTenantId ? { imTenantId: item.imTenantId } : {}),
        ...(item.wxBinding ? { wxBinding: item.wxBinding } : {}),
        createdAt: item.createdAt,
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        ...(item.revokedAt ? { revokedAt: item.revokedAt } : {}),
        active,
      };
    });
}

function purgeSessionsForRevokedTokens(host: TenantRef, revokedIdSet: ReadonlySet<string>) {
  if (revokedIdSet.size === 0) return;
  for (const [hashKey, sess] of activeDropSessions.entries()) {
    if (sess.tenantId === host.id && revokedIdSet.has(sess.tokenId)) {
      activeDropSessions.delete(hashKey);
    }
  }
  const pFile = persistentSessionStorePath(host);
  try {
    withFileLockSync(pFile, () => {
      const pData = readPersistentSessionsUnlocked(host);
      const before = pData.items.length;
      pData.items = pData.items.filter((s) => !(s.tenantId === host.id && revokedIdSet.has(s.tokenId)));
      if (pData.items.length !== before) {
        writePersistentSessionsUnlocked(host, pData);
      }
    });
  } catch {
    // ignore
  }
}

/**
 * 吊销匹配 id 或 label 的未吊销投递口令，或将其从单个指定工作区解绑：
 * - 若传入了 `workspaceId` 且 `globalRevoke !== true`，而该口令还绑定了其他工作区，则仅将该工作区从 `workspaces[]` 移除；
 * - 若该口令只绑了这一个工作区，或未指定 `workspaceId` / `globalRevoke === true`，则整条口令置 `revokedAt` 并清除所有活跃会话。
 */
export function revokeDropToken(
  host: TenantRef,
  idOrLabel: string,
  now = Date.now(),
  workspaceId?: string,
  opts?: { globalRevoke?: boolean },
): { ok: true; revokedIds: string[]; revokedId: string } | { ok: false; error: string } {
  const target = idOrLabel.trim();
  if (!target) return { ok: false, error: "请提供要吊销的口令 id 或 label" };
  const file = tokenStorePath(host);
  const res = withFileLockSync(file, () => {
    const data = readTokenFileUnlocked(host);
    const matches = data.items.filter((item) => {
      if (item.revokedAt) return false;
      if (item.id !== target && item.label !== target) return false;
      if (!workspaceId) return true;
      const bindings = getTokenWorkspaceBindings(item);
      return bindings.some((b) => b.workspaceId === workspaceId || b.workspaceKeySnapshot === workspaceId);
    });
    if (matches.length === 0) {
      return { ok: false as const, error: `未找到有效口令：${target}` };
    }
    const revokedIdSet = new Set<string>();
    const touchedIds: string[] = [];
    for (const item of matches) {
      const bindings = getTokenWorkspaceBindings(item);
      if (workspaceId && !opts?.globalRevoke && bindings.length > 1) {
        const remaining = bindings.filter(
          (b) => b.workspaceId !== workspaceId && b.workspaceKeySnapshot !== workspaceId,
        );
        if (remaining.length > 0) {
          item.workspaces = remaining;
          item.workspaceId = remaining[0]!.workspaceId;
          item.workspaceKeySnapshot = remaining[0]!.workspaceKeySnapshot;
          touchedIds.push(item.id);
          continue;
        }
      }
      item.revokedAt = now;
      revokedIdSet.add(item.id);
      touchedIds.push(item.id);
    }
    writeTokenFileUnlocked(host, data);
    purgeSessionsForRevokedTokens(host, revokedIdSet);
    return { ok: true as const, revokedIds: touchedIds, revokedId: touchedIds[0]!, revokedIdSet };
  });

  if (res.ok) {
    if (res.revokedIdSet.size > 0) {
      for (const listener of revokedListeners) {
        try {
          listener(host, res.revokedIdSet);
        } catch {
          // ignore listener error
        }
      }
    }
    return { ok: true, revokedIds: res.revokedIds, revokedId: res.revokedId };
  }
  return res;
}

/**
 * 外部同事在网页端输入投递口令进行校验并签发上传会话 Token（默认开启 remember=true 持久化记住登录态，访问过一次后无缝自动登入）
 */
export function verifyDropPasscodeAndCreateSession(
  host: DropTenantHost,
  input: {
    passcode: string;
    submitterName: string;
    clientIp: string;
    remember?: boolean;
    preferredWorkspace?: string;
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

  const authorizedWorkspaces = resolveAuthorizedWorkspacesForToken(host, matchedRecord);
  if (authorizedWorkspaces.length === 0) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const preferred = input.preferredWorkspace?.trim();
  const activeWs =
    (preferred
      ? authorizedWorkspaces.find((w) => w.workspaceId === preferred || w.workspaceKey === preferred)
      : undefined) ?? authorizedWorkspaces[0]!;

  // 清理过期 session，并按 tokenId（上限 32）与 tenantId（上限 256）分区淘汰最旧会话
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

  const persistent = input.remember !== false;
  const rawSessionToken = `ds_${randomBytes(24).toString("hex")}`;
  const qaSessionId = `qa_${randomBytes(16).toString("hex")}`;
  const normalizedIp = normalizeClientIp(input.clientIp);
  const tokenHash = hashSessionToken(rawSessionToken);
  const permissions = normalizeColleaguePermissions(matchedRecord.permissions);

  const grant: DropSessionGrant = {
    sessionToken: rawSessionToken,
    qaSessionId,
    tokenId: matchedRecord.id,
    tenantId: host.id,
    workspaceId: activeWs.workspaceId,
    workspaceKey: activeWs.workspaceKey,
    workspacePath: activeWs.workspacePath,
    workspaceTitle: activeWs.workspaceTitle,
    kbConfig: activeWs.kbConfig,
    authorizedWorkspaces,
    permissions,
    submitterName: submitter.name,
    clientIp: normalizedIp,
    persistent,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + (persistent ? PERSISTENT_SESSION_TTL_MS : SESSION_TTL_MS),
  };
  activeDropSessions.set(tokenHash, grant);

  if (persistent) {
    const pFile = persistentSessionStorePath(host);
    try {
      withFileLockSync(pFile, () => {
        const pData = readPersistentSessionsUnlocked(host);
        pData.items.push({
          sessionTokenHash: tokenHash,
          qaSessionId,
          tokenId: matchedRecord.id,
          tenantId: host.id,
          activeWorkspaceId: activeWs.workspaceId,
          submitterName: submitter.name,
          createdAt: now,
          lastActiveAt: now,
        });
        // 同步执行每个 token 最多 MAX_SESSIONS_PER_TOKEN 与每个租户最多 MAX_SESSIONS_PER_TENANT 的淘汰上限
        let sameTokenCount = pData.items.filter(
          (x) => x.tenantId === host.id && x.tokenId === matchedRecord.id,
        ).length;
        while (sameTokenCount > MAX_SESSIONS_PER_TOKEN) {
          const oldestIdx = pData.items.findIndex(
            (x) => x.tenantId === host.id && x.tokenId === matchedRecord.id,
          );
          if (oldestIdx < 0) break;
          pData.items.splice(oldestIdx, 1);
          sameTokenCount -= 1;
        }
        while (pData.items.length > MAX_SESSIONS_PER_TENANT) {
          pData.items.shift();
        }
        writePersistentSessionsUnlocked(host, pData);
      });
    } catch {
      // ignore disk persistence error
    }
  }

  return { ok: true, session: cloneSessionGrant(grant) };
}

/**
 * 校验上传会话 Token（支持从持久化 drop-sessions.json 自动恢复跨网关重启的记住登录会话），
 * 并实时复核口令未被吊销、至少有一个绑定工作区有效。
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
  let sess = activeDropSessions.get(key);

  // 若内存未命中（例如网关进程重启过），尝试从持久化 drop-sessions.json 恢复
  if (!sess) {
    const pData = readPersistentSessionsUnlocked(host);
    const persisted = pData.items.find((x) => x.sessionTokenHash === key && x.tenantId === host.id);
    if (persisted) {
      const tokenData = readTokenFileUnlocked(host);
      const tokenRecord = tokenData.items.find((r) => r.id === persisted.tokenId);
      if (tokenRecord && !tokenRecord.revokedAt && (!tokenRecord.expiresAt || tokenRecord.expiresAt > now)) {
        const authorizedWorkspaces = resolveAuthorizedWorkspacesForToken(host, tokenRecord);
        if (authorizedWorkspaces.length > 0) {
          const activeWs =
            authorizedWorkspaces.find((w) => w.workspaceId === persisted.activeWorkspaceId) ??
            authorizedWorkspaces[0]!;
          sess = {
            sessionToken: token,
            qaSessionId: persisted.qaSessionId,
            tokenId: tokenRecord.id,
            tenantId: host.id,
            workspaceId: activeWs.workspaceId,
            workspaceKey: activeWs.workspaceKey,
            workspacePath: activeWs.workspacePath,
            workspaceTitle: activeWs.workspaceTitle,
            kbConfig: activeWs.kbConfig,
            authorizedWorkspaces,
            permissions: normalizeColleaguePermissions(tokenRecord.permissions),
            submitterName: persisted.submitterName,
            ...(expectedClientIp ? { clientIp: normalizeClientIp(expectedClientIp) } : {}),
            persistent: true,
            createdAt: persisted.createdAt,
            lastActiveAt: now,
            expiresAt: now + PERSISTENT_SESSION_TTL_MS,
          };
          activeDropSessions.set(key, sess);
        }
      }
    }
  }

  if (!sess || sess.tenantId !== host.id) {
    return { ok: false, status: 401, error: "未授权或上传会话已失效" };
  }
  // 对非持久化的短期会话保持严格 IP 校验；对持久化「记住我」会话允许同事在 Wi-Fi / 蜂窝网络切换后自动无缝续用
  if (!sess.persistent && expectedClientIp && sess.clientIp && normalizeClientIp(expectedClientIp) !== sess.clientIp) {
    return { ok: false, status: 403, error: "会话客户端网络地址不匹配，请重新输入口令" };
  }
  if (sess.persistent && expectedClientIp) {
    sess.clientIp = normalizeClientIp(expectedClientIp);
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

  const maxLife = sess.persistent ? PERSISTENT_SESSION_TTL_MS : SESSION_MAX_LIFETIME_MS;
  if (sess.expiresAt <= now || now - sess.createdAt >= maxLife) {
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

  // 实时复核绑定的多工作区列表（只要至少有 1 个工作区有效即不连坐 401）
  const authorizedWorkspaces = resolveAuthorizedWorkspacesForToken(host, tokenRecord);
  if (authorizedWorkspaces.length === 0) {
    dropAndNotifyEvicted(sess);
    return { ok: false, status: 403, error: "目标工作区已不存在或知识库配置已失效" };
  }

  const activeWs =
    authorizedWorkspaces.find((w) => w.workspaceId === sess!.workspaceId) ?? authorizedWorkspaces[0]!;

  // 若原激活工作区已被解绑或失效导致自动回落到另一个工作区，必须清除旧工作区绑定的 batchId 与 receiptHash，防止跨库误投
  if (sess.workspaceId !== activeWs.workspaceId) {
    sess.batchId = undefined;
    sess.receiptHash = undefined;
  }

  sess.workspaceId = activeWs.workspaceId;
  sess.workspaceKey = activeWs.workspaceKey;
  sess.workspacePath = activeWs.workspacePath;
  sess.workspaceTitle = activeWs.workspaceTitle;
  sess.kbConfig = activeWs.kbConfig;
  sess.authorizedWorkspaces = authorizedWorkspaces;
  sess.permissions = normalizeColleaguePermissions(tokenRecord.permissions);
  sess.lastActiveAt = now;
  const maxLifetimeDeadline = sess.createdAt + maxLife;
  sess.expiresAt = Math.min(
    maxLifetimeDeadline,
    now + (sess.persistent ? PERSISTENT_SESSION_TTL_MS : SESSION_TTL_MS),
  );
  activeDropSessions.delete(key);
  activeDropSessions.set(key, sess);

  return { ok: true, session: cloneSessionGrant(sess) };
}

/**
 * 在同一登录会话内切换当前激活的知识库工作区（校验目标工作区在该口令的 authorizedWorkspaces 白名单内）
 */
export function switchDropSessionWorkspace(
  host: DropTenantHost,
  rawSessionToken: string,
  targetWorkspaceKeyOrId: string,
  now = Date.now(),
):
  | {
      ok: true;
      session: DropSessionGrant;
      previousWorkspacePath: string;
      previousBatchId?: string;
    }
  | { ok: false; status: 400 | 401 | 403; error: string } {
  const key = hashSessionToken(rawSessionToken.trim());
  const preVerifySnap = activeDropSessions.get(key);
  const previousWorkspacePath = preVerifySnap?.workspacePath || "";
  const previousBatchId = preVerifySnap?.batchId;

  const verified = verifyDropSessionToken(host, rawSessionToken, now);
  if (!verified.ok) return verified;

  const target = targetWorkspaceKeyOrId.trim();
  if (!target) {
    return { ok: false, status: 400, error: "请指定要切换的知识库工作区" };
  }

  const sess = activeDropSessions.get(key);
  if (!sess) {
    return { ok: false, status: 401, error: "会话不存在或已过期" };
  }

  const authorized = sess.authorizedWorkspaces ?? [];
  const matched = authorized.find(
    (w) => w.workspaceId === target || w.workspaceKey === target || w.workspaceKey.toLowerCase() === target.toLowerCase(),
  );
  if (!matched) {
    return { ok: false, status: 403, error: `您的通行证未获权访问知识库：${target}` };
  }

  const finalPrevPath = previousWorkspacePath || sess.workspacePath;
  const finalPrevBatch = previousBatchId || sess.batchId;

  sess.workspaceId = matched.workspaceId;
  sess.workspaceKey = matched.workspaceKey;
  sess.workspacePath = matched.workspacePath;
  sess.workspaceTitle = matched.workspaceTitle;
  sess.kbConfig = matched.kbConfig;
  sess.batchId = undefined;
  sess.receiptHash = undefined;
  sess.lastActiveAt = now;

  if (sess.persistent) {
    const pFile = persistentSessionStorePath(host);
    try {
      withFileLockSync(pFile, () => {
        const pData = readPersistentSessionsUnlocked(host);
        const rec = pData.items.find((x) => x.sessionTokenHash === key && x.tenantId === host.id);
        if (rec) {
          rec.activeWorkspaceId = matched.workspaceId;
          rec.lastActiveAt = now;
          writePersistentSessionsUnlocked(host, pData);
        }
      });
    } catch {
      // ignore
    }
  }

  return {
    ok: true,
    session: cloneSessionGrant(sess),
    previousWorkspacePath: finalPrevPath,
    ...(finalPrevBatch ? { previousBatchId: finalPrevBatch } : {}),
  };
}

/** 主动注销单个登录会话（同事点击「退出登录/切换口令」时清除内存与磁盘持久化会话） */
export function logoutDropSessionToken(host: TenantRef, rawSessionToken: string): boolean {
  const token = rawSessionToken.trim();
  if (!token.startsWith("ds_")) return false;
  const key = hashSessionToken(token);
  const existed = activeDropSessions.delete(key);
  const pFile = persistentSessionStorePath(host);
  try {
    withFileLockSync(pFile, () => {
      const pData = readPersistentSessionsUnlocked(host);
      const before = pData.items.length;
      pData.items = pData.items.filter((x) => !(x.sessionTokenHash === key && x.tenantId === host.id));
      if (pData.items.length !== before) {
        writePersistentSessionsUnlocked(host, pData);
      }
    });
  } catch {
    // ignore
  }
  return existed;
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
 * 支持通过 preferredWorkspace 指定多工作区口令下的目标知识库。
 */
export function verifyDropPasscodeStateless(
  host: DropTenantHost,
  input: {
    passcode: string;
    submitterName?: string;
    clientIp: string;
    preferredWorkspace?: string;
  },
  now = Date.now(),
):
  | {
      ok: true;
      session: DropSessionGrant;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 429;
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

  const authorizedWorkspaces = resolveAuthorizedWorkspacesForToken(host, matchedRecord);
  if (authorizedWorkspaces.length === 0) {
    recordAuthFailure(host.id, input.clientIp, now);
    return { ok: false, status: 401, error: "投递口令无效或已过期" };
  }

  const preferred = input.preferredWorkspace?.trim();
  let activeWs = authorizedWorkspaces[0]!;
  if (preferred) {
    const found = authorizedWorkspaces.find(
      (w) =>
        w.workspaceId === preferred ||
        w.workspaceKey === preferred ||
        w.workspaceKey.toLowerCase() === preferred.toLowerCase(),
    );
    if (!found) {
      return { ok: false, status: 403, error: `该投递口令无权访问指定工作区：${preferred}` };
    }
    activeWs = found;
  }

  refundStatelessSuccessAttempt(host.id, input.clientIp);

  const grant: DropSessionGrant = {
    sessionToken: `ds_wh_${randomBytes(20).toString("hex")}`,
    qaSessionId: `qa_wh_${randomBytes(12).toString("hex")}`,
    tokenId: matchedRecord.id,
    tenantId: host.id,
    workspaceId: activeWs.workspaceId,
    workspaceKey: activeWs.workspaceKey,
    workspacePath: activeWs.workspacePath,
    workspaceTitle: activeWs.workspaceTitle,
    kbConfig: activeWs.kbConfig,
    authorizedWorkspaces,
    permissions: normalizeColleaguePermissions(matchedRecord.permissions),
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
  const authorizedWorkspaces = resolveAuthorizedWorkspacesForToken(host, tokenRecord);
  const matched = authorizedWorkspaces.find((w) => w.workspaceId === grant.workspaceId);
  if (!matched) {
    return { ok: false, status: 403, error: "目标工作区已不存在或知识库配置已失效" };
  }
  return {
    ok: true,
    session: cloneSessionGrant({
      ...grant,
      workspaceKey: matched.workspaceKey,
      workspacePath: matched.workspacePath,
      workspaceTitle: matched.workspaceTitle,
      kbConfig: matched.kbConfig,
      authorizedWorkspaces,
      permissions: normalizeColleaguePermissions(tokenRecord.permissions),
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
