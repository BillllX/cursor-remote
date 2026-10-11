// git 调用与影子仓库（工作区不是 git 仓库时用租户状态目录下的 shadow git）
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gatewayEnv } from "../config.ts";
import { allTenants, confinedCwd, type Tenant } from "../tenants.ts";

export function tenantForCwd(cwd: string): Tenant | undefined {
  const abs = resolve(cwd);
  for (const tenant of allTenants()) {
    if (confinedCwd(abs, tenant.workspaceRoot)) return tenant;
  }
}

export function shadowGitEnv(cwd: string): Record<string, string> | null {
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
    git(cwd, ["rev-parse", "--verify", "HEAD"], env);
    return env;
  } catch {
    return null;
  }
}

export function isTracked(cwd: string, path: string): boolean {
  const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
  if (!gitRoot(cwd) && !env) return false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    return true;
  } catch {
    return false;
  }
}

function gitIdentity(): Record<string, string> {
  const name = gatewayEnv.gitAuthorName();
  const email = gatewayEnv.gitAuthorEmail();
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: gatewayEnv.gitCommitterName() || name,
    GIT_COMMITTER_EMAIL: gatewayEnv.gitCommitterEmail() || email,
  };
}

export function gitBytes(cwd: string, args: string[], extraEnv?: Record<string, string>): Buffer {
  const ident = gitIdentity();
  return execFileSync(
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
      encoding: "buffer",
      timeout: 15000,
      maxBuffer: 80 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...ident, ...extraEnv },
    },
  );
}

export function git(cwd: string, args: string[], extraEnv?: Record<string, string>): string {
  return gitBytes(cwd, args, extraEnv).toString("utf8").trim();
}

function shadowGitDir(cwd: string, stateDir: string) {
  const id = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return resolve(stateDir, "shadow-git", id);
}

export function ensureShadowGit(cwd: string) {
  const tenant = tenantForCwd(cwd);
  if (!tenant) throw new Error("工作区不属于任何租户");
  const dir = shadowGitDir(cwd, tenant.stateDir);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(resolve(dir, "HEAD"))) {
    execFileSync("git", ["init", "--bare", dir], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const info = resolve(dir, "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(
    resolve(info, "exclude"),
    ["node_modules/", ".next/", ".git/", ".DS_Store", "*.tsbuildinfo", ".cursor-remote-index"].join("\n") + "\n",
  );
  return dir;
}

export function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
