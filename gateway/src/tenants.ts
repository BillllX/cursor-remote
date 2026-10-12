import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  type Dirent,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import {
  createBodyStore,
  dropRemovedBodies,
  evictBodies,
  hydrateChat,
  isBodyLoaded,
  persistBodies,
  type BodyStore,
} from "./chatBodies.ts";
import { gatewayEnv } from "./config.ts";
import { ATOMIC_TMP_RE, atomicWriteFileSync, sweepStaleTmp } from "./fsAtomic.ts";
import { log } from "./log.ts";
import { isInside } from "./pathInside.ts";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type DiskSlot = {
  chatId: string;
  agentId: string | null;
  cwd: string;
  model?: string;
  edited: string[];
  checkpoints: unknown[];
  /** 该会话已登记的评审子代理。缺省表示升级前的旧会话，下次要重建 agent。 */
  reviewRoster?: { name: string; modelId: string }[];
};

export type DiskState = {
  chats: unknown[];
  slots: DiskSlot[];
  rev: number;
  deletedIds: string[];
  /** P4c：每个会话的服务端版本号（与 rev 同一计数器），用于 stored_digest 增量对账 */
  chatRevs: Record<string, number>;
};

export type Tenant = {
  id: string;
  name: string;
  tokenHash: Buffer;
  /** P9：管理员可查询全租户使用统计（admin_stats）。tenants.json 里 admin: true；
   * env 单租户模式默认 true（自己部署自己看） */
  admin: boolean;
  /** Agent 是否进沙箱。只由部署配置决定，不看显示名 */
  sandbox: boolean;
  workspaceRoot: string;
  stateDir: string;
  stateFile: string;
  disk: DiskState;
  /** 会话正文的分段存储（stateDir/chats/） */
  bodies: BodyStore;
};

export type TenantsRegistry = {
  tenants: Tenant[];
  mode: "file" | "env";
  file: string | null;
  mediaSecret: string;
  derivedMediaSecret: boolean;
  stateDir: string;
};

let registry: TenantsRegistry | null = null;

export function stateDir(): string {
  return resolve(gatewayEnv.stateDir());
}

export function emptyDisk(): DiskState {
  return { chats: [], slots: [], rev: 0, deletedIds: [], chatRevs: {} };
}

export function loadTenants(): TenantsRegistry {
  if (registry) return registry;
  const root = stateDir();
  const file = findTenantsFile();
  const media = resolveMediaSecret(file);
  if (file) {
    const tenants = loadTenantsFile(file, root);
    registry = {
      tenants,
      mode: "file",
      file,
      mediaSecret: media.secret,
      derivedMediaSecret: media.derived,
      stateDir: root,
    };
  } else {
    const token = gatewayEnv.singleTenantToken();
    // 单租户 env 模式的显示名：CURSOR_REMOTE_NAME（侧栏「名字 · 工作区」用），缺省回退 id
    const displayName = gatewayEnv.singleTenantName();
    const tenants = token
      ? [
          makeTenant("default", displayName, token, {
            workspaceRoot: resolve(gatewayEnv.singleTenantCwd()),
            stateDir: root,
            admin: true, // env 单租户模式：部署者即管理员
            // 显示名在这里也是部署者写进环境变量的配置，不是用户能改的字段
            sandbox: gatewayEnv.singleTenantSandbox() && tenantSlug(displayName) !== "billxu",
          }),
        ]
      : [];
    registry = {
      tenants,
      mode: "env",
      file: null,
      mediaSecret: media.secret,
      derivedMediaSecret: media.derived,
      stateDir: root,
    };
  }
  for (const tenant of registry.tenants) {
    mkdirSync(tenant.workspaceRoot, { recursive: true });
    mkdirSync(tenant.stateDir, { recursive: true });
    tenant.disk = readDisk(tenant.stateFile, tenant.bodies);
  }
  if (registry.derivedMediaSecret) {
    log.warn("未设 CURSOR_REMOTE_MEDIA_SECRET：已从本机配置派生预览签名密钥。");
  }
  return registry;
}

export function allTenants(): Tenant[] {
  return loadTenants().tenants;
}

function realOrResolved(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 清状态目录里崩溃残留的临时文件：每个目录的顶层和它下面的 native-sessions/，不递归。
 * 单租户时全局状态目录就是租户目录，重复的只扫一次。
 * 待扫目录（按 realpath）就是某个工作区根或在工作区里面时跳过并 warn：STATE_DIR 与 CWD 可以配成同一目录，
 * 那里的临时文件可能是用户的。工作区在状态目录里面（线上 /var/lib/cursor-remote/workspace）不跳过，因为不递归。
 * 返回删掉的文件数。
 */
export function sweepStateTmp(dirs: Iterable<string>, workspaceRoots: Iterable<string>, now = Date.now()): number {
  const roots = [...new Set([...workspaceRoots].map(realOrResolved))];
  const sweep = (dir: string, patterns?: readonly RegExp[]) => guardedSweep(dir, roots, now, patterns, true);
  let count = 0;
  for (const dir of new Set([...dirs].map(realOrResolved))) {
    const top = sweep(dir);
    if (top === null) continue;
    count += top + (sweep(resolve(dir, "native-sessions"), [ATOMIC_TMP_RE, /\.json\.tmp$/]) ?? 0);
  }
  return count;
}

/** 与工作区重叠时返回 null（warn 为 true 时打日志），否则返回删掉的文件数 */
function guardedSweep(
  dir: string,
  roots: string[],
  now: number,
  patterns: readonly RegExp[] | undefined,
  warn: boolean,
): number | null {
  const real = realOrResolved(dir);
  const root = roots.find((item) => isInside(real, item));
  if (root) {
    if (warn) log.warn("状态目录与工作区重叠，跳过临时文件清理", real, "工作区", root);
    return null;
  }
  return sweepStaleTmp(real, { now, patterns }).length;
}

/** chats/<会话>/：旧版固定名 `<sha1>.json.tmp`（更早是序号），以及原子写临时文件 */
export const CHAT_TMP_PATTERNS: readonly RegExp[] = [ATOMIC_TMP_RE, /^(?:[0-9a-f]{40}|\d+)\.json\.tmp$/];
/** artifacts/：旧版 `.<sha256>.<pid>.<hex>.tmp`，原子写后是不带点的同名 */
export const ARTIFACT_TMP_PATTERNS: readonly RegExp[] = [/^\.?[0-9a-f]{64}\.\d+\.[0-9a-f]{8}\.tmp$/];
/** assistant/ 下有原子写的各层目录 */
const ASSISTANT_TMP_DIRS = ["", "memory", "memory/episodes", "chat-index", "briefs"];

/**
 * sweepStateTmp 没覆盖的子目录：每个状态目录下的 chats/<会话>/、artifacts/、assistant/ 各层。
 * 会话目录可能很多，每扫一批让出一次事件循环，启动时延后调用、不等它。
 * 与工作区重叠的保护同 sweepStateTmp：状态目录本身在工作区里就整个跳过（那边已 warn），子目录各自再判一次。
 */
export async function sweepNestedStateTmp(
  dirs: Iterable<string>,
  workspaceRoots: Iterable<string>,
  now = Date.now(),
  batch = 50,
): Promise<number> {
  const roots = [...new Set([...workspaceRoots].map(realOrResolved))];
  const sweep = (dir: string, patterns: readonly RegExp[]) => guardedSweep(dir, roots, now, patterns, false) ?? 0;
  let count = 0;
  let sinceYield = 0;
  for (const dir of new Set([...dirs].map(realOrResolved))) {
    if (roots.some((root) => isInside(dir, root))) continue;
    count += sweep(resolve(dir, "artifacts"), ARTIFACT_TMP_PATTERNS);
    for (const sub of ASSISTANT_TMP_DIRS) count += sweep(resolve(dir, "assistant", sub), [ATOMIC_TMP_RE]);
    let chats: Dirent[] = [];
    try {
      chats = readdirSync(resolve(dir, "chats"), { withFileTypes: true });
    } catch {
      // 没有 chats/ 的状态目录（全局目录、新租户）
    }
    for (const entry of chats) {
      // Dirent 不跟符号链接：链到别处的会话目录不进去
      if (!entry.isDirectory()) continue;
      count += sweep(resolve(dir, "chats", entry.name), CHAT_TMP_PATTERNS);
      if ((sinceYield += 1) >= batch) {
        sinceYield = 0;
        await new Promise((done) => setImmediate(done));
      }
    }
  }
  return count;
}

export function getTenant(id: string): Tenant | undefined {
  return allTenants().find((item) => item.id === id);
}

function tenantSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 平台管理员创建的 Agent 不进沙箱，按 gateway 进程权限执行。
 *  其余租户看部署配置：tenants.json 里 id 为 billxu 或 sandbox: false，
 *  以及 env 单租户模式下 CURSOR_REMOTE_SANDBOX=0 或部署名为 BillXu，也不进沙箱。
 *  没有租户时默认进沙箱。 */
export function sandboxEnabledForTenant(
  tenant: { sandbox: boolean; admin?: boolean } | null | undefined,
): boolean {
  if (!tenant) return true;
  if (tenant.admin) return false;
  return tenant.sandbox;
}

/** 平台所有者。id 或显示名是 BillXu 都算。显示名不放开沙箱，只放开工作区围栏和对外网站。 */
export function isBillXuTenant(
  tenant: { id: string; name?: string } | null | undefined,
): boolean {
  if (!tenant) return false;
  return tenantSlug(tenant.id) === "billxu" || tenantSlug(tenant.name || "") === "billxu";
}

/** 会话工作区围栏：写到当前目录以外就拦截。BillXu 除外，可以改这台机器上 gateway 用户能碰到的路径。 */
export function workspaceFenceForTenant(
  tenant: { id: string; name: string } | null | undefined,
): boolean {
  return !isBillXuTenant(tenant);
}

export function mediaSecret(): string {
  return loadTenants().mediaSecret;
}

export function hasAuth(): boolean {
  return allTenants().length > 0;
}

export function resolveTenant(token: string): Tenant | null {
  if (!token) return null;
  const got = hashToken(token);
  let matched: Tenant | null = null;
  for (const tenant of allTenants()) {
    if (got.length !== tenant.tokenHash.length) continue;
    if (timingSafeEqual(got, tenant.tokenHash)) matched = tenant;
  }
  return matched;
}

export function confinedCwd(raw: string | undefined, root: string): string | null {
  const base = resolve(root);
  const input = (raw || base).trim();
  if (!input) return null;
  const next = resolve(isAbsolute(input) ? input : resolve(base, input));
  if (!isInside(next, base)) return null;
  try {
    if (existsSync(next)) {
      const real = realpathSync(next);
      const realRoot = existsSync(base) ? realpathSync(base) : base;
      if (!isInside(real, realRoot)) return null;
      return real;
    }
  } catch {
    return null;
  }
  return next;
}

export function requireCwd(raw: string | undefined, root: string): string {
  return confinedCwd(raw, root) || confinedCwd(root, root) || resolve(root);
}

const SAVE_IDLE_MS = 1_000;
const SAVE_MAX_WAIT_MS = 3_000;
const pendingSaves = new Map<Tenant, { first: number; timer: ReturnType<typeof setTimeout> }>();
let flushHooked = false;

/** 合并写：最后一次调用后 1s 落盘，最长等 3s。读方都读内存里的 tenant.disk。 */
export function saveDisk(tenant: Tenant) {
  hookFlushOnExit();
  const now = Date.now();
  const pending = pendingSaves.get(tenant);
  const first = pending ? pending.first : now;
  if (pending) clearTimeout(pending.timer);
  const wait = Math.max(0, Math.min(SAVE_IDLE_MS, first + SAVE_MAX_WAIT_MS - now));
  const timer = setTimeout(() => saveDiskNow(tenant), wait);
  pendingSaves.set(tenant, { first, timer });
}

export function saveDiskNow(tenant: Tenant) {
  const pending = pendingSaves.get(tenant);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(tenant);
  }
  const chats = tenant.disk.chats;
  try {
    mkdirSync(tenant.stateDir, { recursive: true });
    // 先写正文分段，成功了再写指向它们的 state.json
    const rows = persistBodies(tenant.bodies, chats);
    atomicWriteFileSync(tenant.stateFile, JSON.stringify({ version: DISK_VERSION, ...tenant.disk, chats: rows }));
    dropRemovedBodies(tenant.bodies, chats);
    evictBodies(tenant.bodies, chats, rows);
  } catch (err) {
    // disk full or permission — keep running
    log.warn("state 落盘失败", tenant.id, err instanceof Error ? err.message : err);
  }
}

export function flushDisks() {
  for (const tenant of [...pendingSaves.keys()]) saveDiskNow(tenant);
}

function hookFlushOnExit() {
  if (flushHooked) return;
  flushHooked = true;
  // usage.ts 也挂了同样的信号。挂了监听后 Node 不再默认退出，所以要有人 exit；
  // 留给最后一个监听者做，前面的监听者（以后可能加的清理）都能先跑完
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      flushDisks();
      if (process.listenerCount(signal) === 0) process.exit(0);
    });
  }
  process.on("exit", () => flushDisks());
}

function findTenantsFile(): string | null {
  const explicit = gatewayEnv.tenantsFile();
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;
  const candidates = [
    "/etc/cursor-remote/tenants.json",
    resolve(process.cwd(), "tenants.json"),
    resolve(process.cwd(), "../tenants.json"),
  ];
  return candidates.find((item) => existsSync(item)) || null;
}

function loadTenantsFile(file: string, dataRoot: string): Tenant[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { tenants?: unknown };
  const rows = Array.isArray(raw.tenants) ? raw.tenants : [];
  const tenants: Tenant[] = [];
  const seenId = new Set<string>();
  const seenHash = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { id?: unknown; name?: unknown; token?: unknown; admin?: unknown; sandbox?: unknown };
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const token = typeof rec.token === "string" ? rec.token : "";
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    const admin = rec.admin === true || rec.admin === "true"; // 手写 json 易写成字符串，宽容解析
    if (!ID_RE.test(id)) {
      throw new Error(`tenants.json：id「${id || "?"}」不合法，只用小写字母、数字和短横线。`);
    }
    if (!token.trim()) {
      throw new Error(`tenants.json：租户 ${id} 没有 token。`);
    }
    if (seenId.has(id)) throw new Error(`tenants.json：重复的 id ${id}。`);
    const digest = hashToken(token).toString("hex");
    if (seenHash.has(digest)) throw new Error(`tenants.json：租户 ${id} 的口令和别人重复。`);
    seenId.add(id);
    seenHash.add(digest);
    tenants.push(
      makeTenant(id, name, token, {
        workspaceRoot: resolve(dataRoot, "tenants", id, "workspace"),
        stateDir: resolve(dataRoot, "tenants", id),
        admin,
        sandbox: !(rec.sandbox === false || rec.sandbox === "false" || id === "billxu"),
      }),
    );
  }
  if (!tenants.length) throw new Error("tenants.json 里没有有效租户。");
  return tenants;
}

function makeTenant(
  id: string,
  name: string,
  token: string,
  paths: { workspaceRoot: string; stateDir: string; admin: boolean; sandbox: boolean },
): Tenant {
  return {
    id,
    name,
    tokenHash: hashToken(token),
    admin: paths.admin,
    sandbox: paths.sandbox,
    workspaceRoot: resolve(paths.workspaceRoot),
    stateDir: resolve(paths.stateDir),
    stateFile: resolve(paths.stateDir, "state.json"),
    disk: emptyDisk(),
    bodies: createBodyStore(paths.stateDir, settleTurns),
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}

function resolveMediaSecret(file: string | null): { secret: string; derived: boolean } {
  const explicit = gatewayEnv.mediaSecret();
  if (explicit) return { secret: explicit, derived: false };
  const api = gatewayEnv.cursorApiKey();
  let stamp = "none";
  if (file && existsSync(file)) {
    try {
      stamp = String(statSync(file).mtimeMs);
    } catch {
      stamp = basename(file);
    }
  }
  return {
    secret: createHash("sha256").update(`cursor-remote-media\n${api}\n${stamp}`).digest("hex"),
    derived: true,
  };
}

function settlePersistedChats(chats: unknown[]): unknown[] {
  return chats.map((item) => {
    if (!item || typeof item !== "object") return item;
    const chat = item as { turns?: unknown[] };
    if (!Array.isArray(chat.turns)) return item;
    let changed = false;
    const turns = chat.turns.map((turn) => {
      if (!turn || typeof turn !== "object") return turn;
      const row = turn as { running?: unknown; queued?: unknown; tools?: unknown[] };
      const toolsIn = Array.isArray(row.tools) ? row.tools : null;
      const tools = toolsIn
        ? toolsIn.map((tool) => {
            if (!tool || typeof tool !== "object") return tool;
            const rec = tool as { status?: unknown };
            if (rec.status !== "running") return tool;
            changed = true;
            return { ...rec, status: "error" };
          })
        : toolsIn;
      if (row.running || row.queued) {
        changed = true;
        return { ...row, running: false, queued: false, tools: tools ?? row.tools };
      }
      if (tools !== toolsIn) return { ...row, tools };
      return turn;
    });
    return changed ? { ...chat, turns } : item;
  });
}

function settleTurns(turns: unknown[]): unknown[] {
  return (settlePersistedChats([{ turns }])[0] as { turns: unknown[] }).turns;
}

/** 草稿只存在客户端，早期版本落过盘的清掉 */
function dropDraft(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const rec = row as Record<string, unknown>;
  delete rec.draft;
  delete rec.draftImages;
  return rec;
}

/** 2：正文拆到 stateDir/chats/<会话>/NNNNN.json，state.json 只留元数据 */
const DISK_VERSION = 2;

function readDisk(file: string, bodies: BodyStore): DiskState {
  try {
    if (!existsSync(file)) return emptyDisk();
    const raw = JSON.parse(readFileSync(file, "utf8")) as DiskState & { version?: unknown };
    const rows = Array.isArray(raw.chats) ? raw.chats : [];
    if (raw.version !== DISK_VERSION && rows.length) {
      // 旧格式第一次被拆分前留一份原样备份：退回旧版网关时把它改回 state.json
      const backup = `${file}.pre-split`;
      try {
        if (!existsSync(backup)) copyFileSync(file, backup);
      } catch (err) {
        log.warn("state.json 拆分前备份失败", backup, err instanceof Error ? err.message : err);
      }
    }
    const chats = rows
      .map((row) => hydrateChat(bodies, dropDraft(row)))
      .map((item) => (isBodyLoaded(item) ? settlePersistedChats([item])[0] : item));
    // chatRevs 裁剪到存活会话（P4 审核）：旧状态里 chats∩deletedIds 等残留 key 不带回内存
    const liveIds = new Set(
      chats
        .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === "string" && Boolean(id)),
    );
    return {
      chats,
      slots: Array.isArray(raw.slots) ? raw.slots : [],
      rev: typeof raw.rev === "number" && raw.rev >= 0 ? raw.rev : 0,
      deletedIds: Array.isArray(raw.deletedIds)
        ? raw.deletedIds.filter((id): id is string => typeof id === "string" && Boolean(id)).slice(0, 500)
        : [],
      chatRevs:
        raw.chatRevs && typeof raw.chatRevs === "object" && !Array.isArray(raw.chatRevs)
          ? Object.fromEntries(
              Object.entries(raw.chatRevs).filter(
                ([k, v]) => typeof v === "number" && v >= 0 && liveIds.has(k),
              ),
            )
          : {},
    };
  } catch (err) {
    // 坏文件挪开再按空状态启动，免得下一次写盘把它盖掉
    const aside = `${file}.unreadable-${Date.now()}`;
    try {
      if (existsSync(file)) renameSync(file, aside);
    } catch (moveErr) {
      // 挪不开就不能按空状态启动：之后写盘会盖掉唯一的原件
      throw new Error(`state.json 读不出也挪不开，停止启动：${file}`, { cause: moveErr });
    }
    log.warn("state.json 读取失败，按空状态启动，原文件挪到", aside, err instanceof Error ? err.message : err);
    return emptyDisk();
  }
}

export { settlePersistedChats };
