import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

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
  return resolve(process.env.CURSOR_REMOTE_STATE_DIR || resolve(homedir(), ".cursor-remote"));
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
    const token = (
      process.env.CURSOR_REMOTE_TOKEN ||
      process.env.CURSOR_REMOTE_PASSWORD ||
      ""
    ).trim();
    // 单租户 env 模式的显示名：CURSOR_REMOTE_NAME（侧栏「名字 · 工作区」用），缺省回退 id
    const displayName = (process.env.CURSOR_REMOTE_NAME || "").trim() || "default";
    const tenants = token
      ? [
          makeTenant("default", displayName, token, {
            workspaceRoot: resolve(process.env.CURSOR_REMOTE_CWD || `${homedir()}/Projects`),
            stateDir: root,
            admin: true, // env 单租户模式：部署者即管理员
            // 显示名在这里也是部署者写进环境变量的配置，不是用户能改的字段
            sandbox: !/^(0|false|off|no)$/i.test(process.env.CURSOR_REMOTE_SANDBOX || "") && tenantSlug(displayName) !== "billxu",
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
    tenant.disk = readDisk(tenant.stateFile);
  }
  if (registry.derivedMediaSecret) {
    console.warn("未设 CURSOR_REMOTE_MEDIA_SECRET：已从本机配置派生预览签名密钥。");
  }
  return registry;
}

export function allTenants(): Tenant[] {
  return loadTenants().tenants;
}

export function getTenant(id: string): Tenant | undefined {
  return allTenants().find((item) => item.id === id);
}

function tenantSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 只有部署配置里标了不进沙箱的租户（tenants.json 里 id 为 billxu 或 sandbox: false；
 *  env 单租户模式下 CURSOR_REMOTE_SANDBOX=0 或部署名为 BillXu）按 gateway 进程权限执行。
 *  管理员和其余租户都进沙箱：子工作区会话读不到租户状态目录里的助理数据。 */
export function sandboxEnabledForTenant(tenant: { sandbox: boolean } | null | undefined): boolean {
  return tenant ? tenant.sandbox : true;
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
  if (!inside(next, base)) return null;
  try {
    if (existsSync(next)) {
      const real = realpathSync(next);
      const realRoot = existsSync(base) ? realpathSync(base) : base;
      if (!inside(real, realRoot)) return null;
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

export function saveDisk(tenant: Tenant) {
  try {
    mkdirSync(tenant.stateDir, { recursive: true });
    writeFileSync(tenant.stateFile, JSON.stringify(tenant.disk));
  } catch {
    // disk full or permission — keep running
  }
}

function findTenantsFile(): string | null {
  const explicit = (process.env.CURSOR_REMOTE_TENANTS_FILE || "").trim();
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
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest();
}

function resolveMediaSecret(file: string | null): { secret: string; derived: boolean } {
  const explicit = (process.env.CURSOR_REMOTE_MEDIA_SECRET || "").trim();
  if (explicit) return { secret: explicit, derived: false };
  const api = process.env.CURSOR_API_KEY?.trim() || "";
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

function inside(path: string, root: string) {
  if (path === root) return true;
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith("..") && !rel.split(/[/\\]/).includes("..");
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

function readDisk(file: string): DiskState {
  try {
    if (!existsSync(file)) return emptyDisk();
    const raw = JSON.parse(readFileSync(file, "utf8")) as DiskState;
    const chats = settlePersistedChats(Array.isArray(raw.chats) ? raw.chats : []);
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
  } catch {
    return emptyDisk();
  }
}

export { settlePersistedChats };
