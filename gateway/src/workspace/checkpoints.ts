// 检查点与撤销：打点、还原、回滚到最近检查点、按记录撤销编辑
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { WebSocket } from "ws";
import { log } from "../log.ts";
import { noteSession } from "../native/session.ts";
import { cwdOf } from "../runtime/slots.ts";
import type { Checkpoint, Conn, Slot } from "../runtime/types.ts";
import { confinedCwd, getTenant } from "../tenants.ts";
import { send } from "../ws/send.ts";
import { listWorkspaceFiles, pushWorkspace, workspacePath } from "./files.ts";
import { ensureShadowGit, git, gitRoot, isTracked, shadowGitEnv, tenantForCwd } from "./git.ts";

export function undoEdits(cwd: string, paths: string[]): { paths: string[]; error?: string } {
  if (!paths.length) return { paths: [], error: "这一轮没有记下改过的文件" };
  const restored: string[] = [];
  const failed: string[] = [];
  for (const raw of paths) {
    const path = workspacePath(cwd, raw);
    if (!path) continue;
    try {
      if (isTracked(cwd, path)) {
        const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
        execFileSync("git", ["checkout", "--", path], {
          cwd,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
          env: env ? { ...process.env, ...env } : process.env,
        });
        restored.push(path);
      } else {
        const abs = resolve(cwd, path);
        if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
        restored.push(path);
      }
    } catch {
      failed.push(path);
    }
  }
  if (!restored.length) {
    return { paths: [], error: failed.length ? "git 还原失败" : "没有可还原的文件" };
  }
  return {
    paths: restored,
    error: failed.length ? `部分失败：${failed.join(", ")}` : undefined,
  };
}

export function checkpointGit(cwd: string, checkpoint?: Checkpoint): { cwd: string; env: Record<string, string> } {
  const tenant = tenantForCwd(cwd);
  if (checkpoint?.gitDir && tenant) {
    const workTree = confinedCwd(checkpoint.workTree || cwd, tenant.workspaceRoot) || cwd;
    const gitDir = resolve(checkpoint.gitDir);
    const rel = relative(tenant.stateDir, gitDir);
    if (rel && !rel.startsWith("..") && !rel.split(/[/\\]/).includes("..")) {
      return {
        cwd: workTree,
        env: {
          GIT_DIR: gitDir,
          GIT_WORK_TREE: workTree,
          GIT_INDEX_FILE: resolve(gitDir, "cursor-remote-index"),
        },
      };
    }
  }
  const root = gitRoot(cwd);
  if (root) {
    let gitDir = git(root, ["rev-parse", "--git-dir"]);
    if (!gitDir.startsWith("/")) gitDir = resolve(root, gitDir);
    return {
      cwd: root,
      env: { GIT_INDEX_FILE: resolve(gitDir, "cursor-remote-index") },
    };
  }
  const gitDir = ensureShadowGit(cwd);
  return {
    cwd,
    env: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: cwd,
      GIT_INDEX_FILE: resolve(gitDir, "cursor-remote-index"),
    },
  };
}

function publicCheckpoints(slot: Slot) {
  return slot.checkpoints.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
}

export function sendCheckpoints(ws: WebSocket, slot: Slot) {
  send(ws, { type: "checkpoints", chatId: slot.chatId, items: publicCheckpoints(slot) });
}

/** 聊天目录在 git 工作区里的相对路径。根目录本身返回空串。 */
export function workspacePrefix(root: string, cwd: string): string {
  const rel = relative(resolve(root), resolve(cwd)).replace(/\\/g, "/");
  if (!rel || rel === ".") return "";
  if (rel === ".." || rel.startsWith("../") || rel.split("/").includes("..")) {
    throw new Error("检查点工作区不在仓库内");
  }
  return rel;
}

/** 把检查点树里的仓库路径收成聊天目录内的相对路径。仓库外的路径丢掉。 */
function cwdPathFromTree(treePath: string, prefix: string): string | null {
  const norm = treePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return null;
  if (!prefix) return norm;
  if (norm === prefix) return null;
  const lead = `${prefix}/`;
  if (!norm.startsWith(lead)) return null;
  return norm.slice(lead.length);
}

/** 目录里有没有任何非目录条目（含 git 忽略的文件和符号链接，不看 .git）。空目录检查点据此判定 */
function dirHasEntries(dir: string): boolean {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch {
      return true;
    }
    for (const name of names) {
      if (cur === dir && name === ".git") continue;
      try {
        const st = lstatSync(resolve(cur, name));
        if (st.isDirectory()) stack.push(resolve(cur, name));
        else return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

export function createCheckpoint(cwd: string, label: string): Checkpoint {
  const ctx = checkpointGit(cwd);
  try {
    git(ctx.cwd, ["read-tree", "HEAD"], ctx.env);
  } catch {
    git(ctx.cwd, ["read-tree", "--empty"], ctx.env);
  }
  // 子目录只快照自己。add -A 打在仓库根上会把兄弟项目卷进来，还原时再按根路径删文件。
  const prefix = workspacePrefix(ctx.cwd, cwd);
  const empty = !dirHasEntries(cwd);
  const listed = prefix ? [prefix] : listWorkspaceFiles(cwd, "").paths;
  try {
    if (listed.length) {
      for (let i = 0; i < listed.length; i += 200) {
        git(ctx.cwd, ["add", "-A", "--", ...listed.slice(i, i + 200)], ctx.env);
      }
    } else {
      git(ctx.cwd, ["add", "-A"], ctx.env);
    }
    git(ctx.cwd, ["add", "-u", "--", ...(prefix ? [prefix] : ["."])], ctx.env);
  } catch {
    if (prefix) throw new Error("子目录检查点没记下，已停止，避免快照整个仓库");
    git(ctx.cwd, ["add", "-A"], ctx.env);
  }
  const tree = git(ctx.cwd, ["write-tree"], ctx.env);
  const args = ["commit-tree", tree, "-m", `cursor-remote: ${label}`];
  try {
    args.splice(2, 0, "-p", git(ctx.cwd, ["rev-parse", "HEAD"], ctx.env));
  } catch (err) {
    // empty repo, no parent
    log.debug("检查点：仓库还没有 HEAD", ctx.cwd, err instanceof Error ? err.message : err);
  }
  const commit = git(ctx.cwd, args, ctx.env);
  const id = commit.slice(0, 8);
  git(ctx.cwd, ["update-ref", `refs/cursor-remote/${id}`, commit], ctx.env);
  if (ctx.env.GIT_DIR) {
    git(ctx.cwd, ["update-ref", "HEAD", commit], ctx.env);
  }
  return {
    id,
    label,
    commit,
    createdAt: Date.now(),
    gitDir: ctx.env.GIT_DIR,
    workTree: ctx.cwd,
    empty: empty || undefined,
  };
}

export function restoreCheckpoint(cwd: string, checkpoint: Checkpoint, extra: string[] = []): { error?: string } {
  try {
    const ctx = checkpointGit(cwd, checkpoint);
    const prefix = workspacePrefix(ctx.cwd, cwd);
    const keep = new Set<string>();
    if (!checkpoint.empty) {
      if (prefix) {
        git(ctx.cwd, ["restore", "--source", checkpoint.commit, "--worktree", "--", prefix], ctx.env);
      } else {
        git(ctx.cwd, ["restore", "--source", checkpoint.commit, "--worktree", "."], ctx.env);
      }
    }
    if (ctx.env.GIT_DIR) {
      git(ctx.cwd, ["update-ref", "HEAD", checkpoint.commit], ctx.env);
      git(ctx.cwd, ["read-tree", checkpoint.commit], ctx.env);
    }
    if (!checkpoint.empty) {
      const treePaths = git(ctx.cwd, ["ls-tree", "-z", "-r", "--name-only", checkpoint.commit], ctx.env)
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const name of treePaths) {
        const local = cwdPathFromTree(name, prefix);
        if (local) keep.add(local);
      }
      const treeHasScope = prefix
        ? treePaths.some((name) => name === prefix || name.startsWith(`${prefix}/`))
        : treePaths.length > 0;
      if (prefix && !treeHasScope) {
        return { error: "检查点里没有这个目录的文件，已停止删除。" };
      }
      if (treeHasScope && keep.size === 0) {
        return { error: "检查点路径对不上当前目录，已停止删除文件。" };
      }
    }
    const extras = new Set(extra.map((raw) => workspacePath(cwd, raw)).filter(Boolean) as string[]);
    for (const path of listWorkspaceFiles(cwd, "").paths) extras.add(path);
    for (const path of extras) {
      if (!path || keep.has(path)) continue;
      const abs = resolve(cwd, path);
      try {
        if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
      } catch (err) {
        // skip files we cannot remove
        log.warn("还原检查点：删不掉文件", abs, err instanceof Error ? err.message : err);
      }
    }
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "还原检查点失败" };
  }
}

export function nativeStateDir(conn: Conn, slot: Slot): string | null {
  return (conn.tenant || getTenant(slot.tenantId))?.stateDir ?? null;
}

/** 文件被还原后，自研 Agent 的会话里记一笔，否则模型下一轮会以为改动还在 */
export function noteNativeRestore(conn: Conn, slot: Slot, label?: string, paths?: string[]) {
  const dir = nativeStateDir(conn, slot);
  if (!dir) return;
  const what = paths?.length
    ? `这些文件已撤销到改动前：${paths.slice(0, 20).join(", ")}`
    : `工作区已还原到检查点${label ? `「${label}」` : ""}`;
  noteSession(dir, slot.chatId, `（系统提示：${what}。之前的改动可能已不存在，动手前先重新读取文件。）`);
}

export function rollbackToLatestCheckpoint(
  ws: WebSocket,
  slot: Slot,
  conn: Conn,
  silent = false,
): { error?: string; restored: boolean } {
  const cwd = cwdOf(conn, slot);
  const wanted = slot.checkpoints[0];
  if (wanted) {
    const preview = slot.edited.slice();
    const result = restoreCheckpoint(cwd, wanted, slot.edited);
    slot.edited = [];
    if (!result.error) {
      noteNativeRestore(conn, slot, wanted.label);
      send(ws, {
        type: "restored",
        chatId: slot.chatId,
        checkpointId: wanted.id,
        label: wanted.label,
        silent,
      });
      pushWorkspace(ws, slot, conn, silent ? [] : preview);
    }
    return { error: result.error, restored: !result.error };
  }
  const undone = undoEdits(cwd, slot.edited);
  slot.edited = [];
  if (undone.paths.length) {
    send(ws, {
      type: "undone",
      chatId: slot.chatId,
      paths: undone.paths,
      error: undone.error,
    });
    pushWorkspace(ws, slot, conn, undone.paths);
  }
  return { error: undone.error, restored: undone.paths.length > 0 };
}
