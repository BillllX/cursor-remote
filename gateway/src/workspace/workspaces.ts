// 工作区 CRUD：列出、隐藏、重命名、删除与推送工作区清单
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { WebSocket } from "ws";
import { assistantName } from "../assistant/service.ts";
import { atomicWriteFileSync } from "../fsAtomic.ts";
import { log } from "../log.ts";
import { chatIdOf, isAssistantChat } from "../runtime/chats.ts";
import { disposeSlot, persistTenant, runningChatIds } from "../runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../runtime/state.ts";
import type { Conn } from "../runtime/types.ts";
import { broadcastDigest } from "../sync/storedState.ts";
import { confinedCwd, isBillXuTenant, saveDiskNow, type Tenant } from "../tenants.ts";
import { send } from "../ws/send.ts";

export function sanitizeWorkspaceName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!name || name.length > 80) return null;
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    return null;
  }
  return name;
}

export function isUserWorkspace(cwd: string, root: string) {
  const next = confinedCwd(cwd, root);
  const base = confinedCwd(root, root);
  return Boolean(next && base && next === base);
}

/** USER 根目录，或 BillXu 的任意会话。工作目录仍须落在该用户的工作区里。 */
export function mayPublishHere(tenant: Tenant | null | undefined, cwd: string) {
  if (!tenant) return false;
  if (isBillXuTenant(tenant)) return true;
  return isUserWorkspace(cwd, tenant.workspaceRoot);
}

export function listWorkspaceItems(tenant: Tenant): { path: string; name: string; user?: boolean }[] {
  const root = resolve(tenant.workspaceRoot);
  const skip = new Set(["node_modules", "dist", "coverage", "venv", "__pycache__"]);
  const byPath = new Map<string, string>();
  const rootName = assistantName(tenant);
  byPath.set(root, rootName);
  const hidden = new Set(readHiddenWorkspaces(tenant));
  try {
    for (const name of readdirSync(root).sort()) {
      if (name.startsWith(".") || skip.has(name) || hidden.has(name)) continue;
      const abs = resolve(root, name);
      try {
        if (statSync(abs).isDirectory()) byPath.set(abs, name);
      } catch (err) {
        // skip unreadable
        log.debug("列工作区：子目录读不了", abs, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    // root missing
    log.debug("列工作区：根目录读不了", root, err instanceof Error ? err.message : err);
  }
  for (const slot of tenant.disk.slots) {
    const cwd = confinedCwd(slot.cwd, root);
    if (!cwd || byPath.has(cwd)) continue;
    const rel = relative(root, cwd);
    byPath.set(cwd, rel || basename(cwd));
  }
  return [...byPath.entries()].map(([path, name]) =>
    path === root ? { path, name: rootName, user: true as const } : { path, name },
  );
}

/** 用户“删除”了但目录里有文件、没真删的工作区：只从列表里藏起来，名字记在 stateDir 里 */
function hiddenWorkspacesFile(tenant: Tenant) {
  return resolve(tenant.stateDir, "hidden-workspaces.json");
}

export function readHiddenWorkspaces(tenant: Tenant): string[] {
  try {
    const raw = JSON.parse(readFileSync(hiddenWorkspacesFile(tenant), "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function writeHiddenWorkspaces(tenant: Tenant, names: string[]) {
  try {
    mkdirSync(tenant.stateDir, { recursive: true });
    atomicWriteFileSync(hiddenWorkspacesFile(tenant), JSON.stringify([...new Set(names)].sort()), { encoding: "utf8" });
  } catch (error) {
    log.warn("写 hidden-workspaces.json 失败", tenant.id, error);
  }
}

/** 根目录下的一级子目录才允许改名/删除；返回绝对路径和目录名，别的一律 null */
function topLevelWorkspace(tenant: Tenant, raw: string): { dir: string; name: string } | null {
  const root = resolve(tenant.workspaceRoot);
  const dir = confinedCwd(raw, root);
  if (!dir || dir === root) return null;
  const rel = relative(root, dir);
  if (!rel || rel.startsWith("..") || rel.includes("/") || rel.startsWith(".")) return null;
  return { dir, name: rel };
}

function underDir(path: string | undefined, dir: string) {
  if (!path) return false;
  const abs = resolve(path);
  return abs === dir || abs.startsWith(`${dir}/`);
}

/** 目录下有多少条没被删掉的会话 */
function chatsUnder(tenant: Tenant, dir: string) {
  const gone = new Set(tenant.disk.deletedIds);
  return tenant.disk.chats.filter((item) => {
    const id = chatIdOf(item);
    if (!id || gone.has(id) || isAssistantChat(tenant, id)) return false;
    const cwd = (item as { cwd?: unknown })?.cwd;
    return typeof cwd === "string" && underDir(cwd, dir);
  });
}

/**
 * 重命名工作区：改目录名，同时把会话、存盘槽、断点里指向旧路径的地方改到新路径。
 * 有会话在运行时不动。会话的 Agent 绑着旧目录，改完丢掉，下次发消息按历史重建。
 */
export async function renameWorkspace(ws: WebSocket, tenant: Tenant, conn: Conn, rawPath: string, rawName: string) {
  const fail = (message: string) => send(ws, { type: "error", message });
  const from = topLevelWorkspace(tenant, rawPath);
  const name = sanitizeWorkspaceName(rawName);
  if (!from) return fail("只能改根目录下的工作区。");
  if (!name || name.includes("/")) return fail("新名字不合法：不能带斜杠，也不能以点开头。");
  if (name === from.name) return fail("新名字和原来一样。");
  const root = resolve(tenant.workspaceRoot);
  const to = confinedCwd(resolve(root, name), root);
  if (!to || to === root) return fail("工作区必须在允许的目录里。");
  if (existsSync(to) || readHiddenWorkspaces(tenant).includes(name)) return fail(`已经有叫「${name}」的工作区。`);
  const chats = chatsUnder(tenant, from.dir);
  const busy = new Set(runningChatIds(tenant));
  if (
    chats.some((item) => busy.has(chatIdOf(item) || "")) ||
    [...liveSlotsOf(tenant).values()].some((slot) => busy.has(slot.chatId) && underDir(slot.cwd, from.dir))
  ) {
    return fail("里面有对话正在运行，先停掉再改名。");
  }
  try {
    renameSync(from.dir, to);
  } catch {
    return fail("改名失败，目录可能被占用。");
  }
  const move = (path: string) => (underDir(path, from.dir) ? resolve(to, relative(from.dir, resolve(path))) : path);
  for (const item of chats) {
    const row = item as { cwd?: string };
    // 原地改元数据：正文挂在行对象的隐藏属性上，换新对象会丢
    row.cwd = move(row.cwd || from.dir);
    tenant.disk.rev += 1;
    tenant.disk.chatRevs[chatIdOf(item) || ""] = tenant.disk.rev;
  }
  const fix = (slot: { cwd: string; agentId: string | null; checkpoints: unknown[] }) => {
    slot.cwd = move(slot.cwd);
    for (const cp of slot.checkpoints) {
      if (cp && typeof cp === "object" && typeof (cp as { workTree?: unknown }).workTree === "string") {
        (cp as { workTree: string }).workTree = move((cp as { workTree: string }).workTree);
      }
    }
  };
  for (const slot of tenant.disk.slots) {
    if (underDir(slot.cwd, from.dir)) {
      fix(slot);
      slot.agentId = null;
    }
  }
  for (const slot of liveSlotsOf(tenant).values()) {
    if (!underDir(slot.cwd, from.dir)) continue;
    fix(slot);
    await disposeSlot(slot);
    slot.agentId = null;
  }
  for (const other of gatewayState.conns.values()) {
    if (other.tenant?.id === tenant.id && underDir(other.cwd, from.dir)) other.cwd = move(other.cwd);
  }
  persistTenant(tenant);
  saveDiskNow(tenant);
  send(ws, { type: "workspace_renamed", from: from.dir, path: to, name });
  emitWorkspaces(ws, tenant);
  broadcastDigest(tenant, ws);
}

/**
 * 删除工作区：目录是空的就真删；里面有文件只从列表隐藏（文件不动）；还有对话就不处理。
 */
export function deleteWorkspace(ws: WebSocket, tenant: Tenant, conn: Conn, rawPath: string) {
  const fail = (message: string) => send(ws, { type: "error", message });
  const target = topLevelWorkspace(tenant, rawPath);
  if (!target) return fail("只能删根目录下的工作区。");
  const count = chatsUnder(tenant, target.dir).length;
  if (count) return fail(`里面还有 ${count} 个对话，先清空对话再删。`);
  let entries: string[] = [];
  try {
    entries = existsSync(target.dir) ? readdirSync(target.dir) : [];
  } catch {
    return fail("读不了这个目录。");
  }
  let mode: "deleted" | "hidden" = "hidden";
  if (!entries.length) {
    try {
      if (existsSync(target.dir)) rmdirSync(target.dir);
      mode = "deleted";
    } catch {
      return fail("删不掉这个目录。");
    }
  } else {
    writeHiddenWorkspaces(tenant, [...readHiddenWorkspaces(tenant), target.name]);
  }
  if (underDir(conn.cwd, target.dir)) conn.cwd = resolve(tenant.workspaceRoot);
  send(ws, { type: "workspace_removed", path: target.dir, name: target.name, mode });
  emitWorkspaces(ws, tenant);
}

export function emitWorkspaces(ws: WebSocket, tenant: Tenant) {
  send(ws, {
    type: "workspaces",
    root: resolve(tenant.workspaceRoot),
    items: listWorkspaceItems(tenant),
  });
}

export function ensureWorkspaceDir(cwd: string) {
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
}
