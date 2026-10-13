// git.ts 里请求热路径用到的几个 git 调用的异步版（不阻塞事件循环，可取消、有超时）。
// 参数、超时、环境变量、输出处理与同步版保持一致；同步版继续留给回合收尾、检查点等非请求热路径。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execText } from "./heavy.ts";
import { gitIdentity, shadowGitDir, tenantForCwd } from "./git.ts";

export type AsyncOpt = { signal?: AbortSignal };

/** 对应 git.ts 的 gitRoot（超时 2s） */
export async function gitRootAsync(cwd: string, opt: AsyncOpt = {}): Promise<string | null> {
  try {
    const out = await execText("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeoutMs: 2000,
      maxBuffer: 1024 * 1024,
      signal: opt.signal,
    });
    return out.trim();
  } catch (err) {
    if (opt.signal?.aborted) throw err;
    return null;
  }
}

/** 对应 git.ts 的 git()：带作者身份、超时 15s、输出上限 80MB，结果去首尾空白 */
export async function gitAsync(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
  opt: AsyncOpt = {},
): Promise<string> {
  const ident = gitIdentity();
  const out = await execText(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "-c",
      `user.name=${ident.GIT_AUTHOR_NAME}`,
      "-c",
      `user.email=${ident.GIT_AUTHOR_EMAIL}`,
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, ...ident, ...extraEnv },
      timeoutMs: 15000,
      maxBuffer: 80 * 1024 * 1024,
      signal: opt.signal,
    },
  );
  return out.trim();
}

/** 对应 git.ts 的 shadowGitEnv：工作区不是 git 仓库时，租户状态目录下的影子仓库环境 */
export async function shadowGitEnvAsync(cwd: string, opt: AsyncOpt = {}): Promise<Record<string, string> | null> {
  const tenant = tenantForCwd(cwd);
  if (!tenant) return null;
  const dir = shadowGitDir(cwd, tenant.stateDir);
  if (!existsSync(resolve(dir, "HEAD"))) return null;
  const env = {
    GIT_DIR: dir,
    GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: resolve(dir, "cursor-remote-index"),
  };
  try {
    await gitAsync(cwd, ["rev-parse", "--verify", "HEAD"], env, opt);
    return env;
  } catch (err) {
    if (opt.signal?.aborted) throw err;
    return null;
  }
}

/** 对应 git.ts 的 isTracked；root / env 由调用方传入，省得每次再起两个子进程重新探测 */
export async function isTrackedAsync(
  cwd: string,
  path: string,
  where: { root: string | null; shadow: Record<string, string> | null },
  opt: AsyncOpt = {},
): Promise<boolean> {
  const env = where.root ? undefined : where.shadow || undefined;
  if (!where.root && !env) return false;
  try {
    await execText("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      timeoutMs: 4000,
      maxBuffer: 1024 * 1024,
      signal: opt.signal,
    });
    return true;
  } catch (err) {
    if (opt.signal?.aborted) throw err;
    return false;
  }
}
