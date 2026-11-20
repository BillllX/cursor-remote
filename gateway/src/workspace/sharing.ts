import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  readSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fchmodSync,
  fsyncSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { workspaceAgentById, readWorkspaceAgentFile, workspaceKey } from "./agents.ts";
import type { Tenant } from "../tenants.ts";
import type { SharedWorkspace, WorkspaceShareRequest } from "../../../shared/workspaceShare.ts";

type Grant = { owner: string; workspace: string; dev: number; ino: number; members: string[] };
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_ENTRIES = 400;
export class WorkspaceShareError extends Error {
  constructor(
    message: string,
    readonly code: "CONFLICT" | "UNAVAILABLE" | "INVALID" = "INVALID",
  ) {
    super(message);
  }
}
const unavailable = () => new WorkspaceShareError("这个工作区已不可访问", "UNAVAILABLE");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function workspaceSharingSupported() {
  return process.platform === "linux" && Boolean(constants.O_NOFOLLOW) && existsSync("/proc/self/fd");
}
function eligible(owner: Tenant, member: Tenant) {
  if (owner.id === member.id || Boolean(owner.imHidden) !== Boolean(member.imHidden)) return false;
  const a = owner.projectSharingDomain,
    b = member.projectSharingDomain;
  return a || b ? Boolean(a && a === b) : true;
}
function shareId(grant: Grant) {
  return grant.owner + ":" + grant.workspace;
}
function pathParts(raw: unknown, rootAllowed = false) {
  if (rootAllowed && (raw === "" || raw === undefined)) return [];
  if (
    typeof raw !== "string" ||
    raw.length > 1024 ||
    /[\\:]/u.test(raw) ||
    Array.from(raw).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new WorkspaceShareError("文件路径无效");
  const parts = raw.split("/");
  if (parts.length > 24 || parts.some((part) => !visibleSegment(part))) throw new WorkspaceShareError("文件路径无效");
  return parts;
}
function visibleSegment(name: string) {
  return (
    name.length > 0 &&
    !name.startsWith(".") &&
    Buffer.byteLength(name) <= 255 &&
    !["node_modules", "agents.md", "credentials.json", "secrets.json"].includes(name.toLowerCase()) &&
    !/[\\/:]/u.test(name) &&
    !Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
const fdPath = (fd: number) => "/proc/self/fd/" + fd;
const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
function withDirectory<T>(
  root: string,
  grant: Pick<Grant, "dev" | "ino">,
  parts: string[],
  action: (dir: number) => T,
) {
  const fd = openSync(root, dirFlags);
  let dir = fd;
  try {
    const st = fstatSync(fd);
    if (st.dev !== grant.dev || st.ino !== grant.ino) throw unavailable();
    for (const part of parts) {
      const next = openSync(join(fdPath(dir), part), dirFlags);
      if (dir !== fd) closeSync(dir);
      dir = next;
    }
    return action(dir);
  } finally {
    if (dir !== fd) closeSync(dir);
    closeSync(fd);
  }
}
function readText(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_TEXT_BYTES)
      throw new WorkspaceShareError("此文件不能在共享视图中编辑");
    const buffer = Buffer.allocUnsafe(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const next = readSync(fd, buffer, length, buffer.length - length, null);
      if (!next) break;
      length += next;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) throw new WorkspaceShareError("此文件不能在共享视图中编辑");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new WorkspaceShareError("此文件不能在共享视图中编辑");
    }
    return { content, revision: digest(bytes), mode: info.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}
function saveText(path: string, content: string, revision: string) {
  const current = readText(path);
  if (current.revision !== revision) throw new WorkspaceShareError("文件已被修改，请比较最新内容后再保存", "CONFLICT");
  const tmp = join(path, "..", ".share-" + randomUUID());
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, content);
    fchmodSync(fd, current.mode);
    fsyncSync(fd);
    if (readText(path).revision !== revision)
      throw new WorkspaceShareError("文件已被修改，请比较最新内容后再保存", "CONFLICT");
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        /* 已替换或清理 */
      }
    }
  }
  return { revision: digest(content) };
}
export class WorkspaceSharing {
  private readonly ledger: string;
  constructor(
    stateDirectory: string,
    private readonly tenants: () => Tenant[],
  ) {
    this.ledger = join(stateDirectory, "workspace-sharing.json");
  }

  private getGrants(): Grant[] {
    try {
      return JSON.parse(readFileSync(this.ledger, "utf8")) as Grant[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private locate(owner: Tenant, id: string) {
    const entry = workspaceAgentById(owner, id);
    if (!entry || !visibleSegment(entry.key)) throw unavailable();
    const root = resolve(realpathSync(owner.workspaceRoot), entry.key);
    const st = lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink()) throw unavailable();
    return { root, name: entry.key, dev: st.dev, ino: st.ino };
  }

  private owned(actor: Tenant, path: unknown) {
    if (typeof path !== "string" || !path || path.length > 4096) throw unavailable();
    const key = workspaceKey(actor, path);
    if (!key || !visibleSegment(key)) throw unavailable();
    const items = readWorkspaceAgentFile(actor).items;
    const item = Object.hasOwn(items, key) ? items[key] : null;
    if (!item) throw unavailable();
    return { id: item.workspaceId, ...this.locate(actor, item.workspaceId) };
  }

  /** 所有者普通编辑器与访客保存共享文件时走同一个内容版本检查。 */
  saveOwnedFile(actor: Tenant, cwd: string, rawPath: string, content: string, revision?: string) {
    if (!workspaceSharingSupported() || typeof rawPath !== "string" || typeof content !== "string") return false;
    const grants = this.getGrants().filter((g) => g.owner === actor.id);
    if (!grants.length) return false;
    const target = resolve(cwd, rawPath);
    for (const grant of grants) {
      let workspace: ReturnType<WorkspaceSharing["locate"]>;
      try {
        workspace = this.locate(actor, grant.workspace);
      } catch {
        continue;
      }
      if (workspace.dev !== grant.dev || workspace.ino !== grant.ino) continue;
      const path = relative(workspace.root, target);
      if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) continue;
      // 隐藏文件、私人配置和助手规则不属于共享文件。
      const parts = path.split("/");
      if (parts.some((part) => !visibleSegment(part))) return false;
      const name = parts.pop()!;
      return withDirectory(workspace.root, grant, parts, (dir) => {
        const anchored = join(fdPath(dir), name);
        let info;
        try {
          info = lstatSync(anchored);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (revision === undefined) return false;
          throw new WorkspaceShareError("文件已被移除，请刷新后再保存", "CONFLICT");
        }
        if (!info.isFile() || info.nlink !== 1) throw new WorkspaceShareError("这个文件不能直接保存");
        if (info.size > MAX_TEXT_BYTES) return false;
        if (!revision || !/^[a-f0-9]{64}$/.test(revision)) throw new WorkspaceShareError("请重新打开文件后再保存");
        if (Buffer.byteLength(content) > MAX_TEXT_BYTES || content.includes("\0"))
          throw new WorkspaceShareError("此内容不能在编辑器中保存");
        saveText(anchored, content, revision);
        return true;
      });
    }
    return false;
  }

  handle(actor: Tenant, request: WorkspaceShareRequest): unknown {
    if (!workspaceSharingSupported()) throw unavailable();
    if (!["list", "people", "set", "files", "read", "write"].includes(request.action))
      throw new WorkspaceShareError("共享操作无效");
    if (request.action === "list") {
      const items: SharedWorkspace[] = [];
      for (const g of this.getGrants()) {
        if (!g.members.includes(actor.id)) continue;
        const owner = this.tenants().find((t) => t.id === g.owner);
        if (!owner || !eligible(owner, actor)) continue;
        try {
          const workspace = this.locate(owner, g.workspace);
          if (workspace.dev === g.dev && workspace.ino === g.ino)
            items.push({ id: shareId(g), name: workspace.name, ownerName: owner.name });
        } catch {
          /* 已移除或不可用的目录不出现在列表。 */
        }
      }
      return { items };
    }
    if (request.action === "people" || request.action === "set") {
      const workspace = this.owned(actor, request.workspace);
      const people = this.tenants()
        .filter((t) => eligible(actor, t))
        .map(({ id, name }) => ({ id, name }));
      const selected = (grants: Grant[]) =>
        grants
          .find(
            (g) =>
              g.owner === actor.id &&
              g.workspace === workspace.id &&
              g.dev === workspace.dev &&
              g.ino === workspace.ino,
          )
          ?.members.filter((id) => people.some((p) => p.id === id)) ?? [];
      if (request.action === "people") {
        const memberIds = selected(this.getGrants());
        return { people, memberIds, memberRevision: digest(JSON.stringify(memberIds)) };
      }
      if (
        !Array.isArray(request.memberIds) ||
        request.memberIds.length > 100 ||
        request.memberIds.some((id) => !people.some((p) => p.id === id))
      )
        throw new WorkspaceShareError("所选同事不可用");
      const memberIds = [...new Set(request.memberIds)].sort();
      return withFileLockSync(this.ledger, () => {
        const grants = this.getGrants(),
          previous = selected(grants);
        if (request.memberRevision !== digest(JSON.stringify(previous)))
          throw new WorkspaceShareError("共享名单已更新，请重新打开", "CONFLICT");
        const next = grants.filter((g) => g.owner !== actor.id || g.workspace !== workspace.id);
        if (memberIds.length)
          next.push({
            owner: actor.id,
            workspace: workspace.id,
            dev: workspace.dev,
            ino: workspace.ino,
            members: memberIds,
          });
        atomicWriteFileSync(this.ledger, JSON.stringify(next), { mode: 0o600, fsync: true });
        return {
          affected: [...new Set([...previous, ...memberIds])],
          memberIds,
          memberRevision: digest(JSON.stringify(memberIds)),
        };
      });
    }

    const grant = this.getGrants().find((g) => shareId(g) === request.workspace && g.members.includes(actor.id));
    const owner = grant && this.tenants().find((t) => t.id === grant.owner);
    if (!owner || !grant || !eligible(owner, actor)) throw unavailable();
    const { root } = this.locate(owner, grant.workspace);
    const parts = pathParts(request.path, request.action === "files");
    if (request.action === "files") {
      return withDirectory(root, grant, parts, (dir) => {
        const entries = readdirSync(fdPath(dir), { withFileTypes: true }).filter(
          (e) => visibleSegment(e.name) && (e.isFile() || e.isDirectory()),
        );
        entries.sort(
          (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"),
        );
        // 页的编码体积与 WS 有界，文件名仍按原样显示。
        return {
          items: entries.slice(0, MAX_ENTRIES).map((e) => ({ name: e.name, directory: e.isDirectory() })),
          truncated: entries.length > MAX_ENTRIES,
        };
      });
    }
    const name = parts.pop();
    if (!name) throw new WorkspaceShareError("请选择文件");
    return withDirectory(root, grant, parts, (dir) => {
      const path = join(fdPath(dir), name);
      if (request.action === "read") {
        const { content, revision } = readText(path);
        return { content, revision };
      }
      if (
        request.action !== "write" ||
        typeof request.content !== "string" ||
        Buffer.byteLength(request.content) > MAX_TEXT_BYTES ||
        request.content.includes("\0") ||
        typeof request.revision !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.revision)
      )
        throw new WorkspaceShareError("保存请求无效");
      return saveText(path, request.content, request.revision);
    });
  }
}
