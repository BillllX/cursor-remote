import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

type Claim = { owner: string; active: () => boolean };
const claims = new Map<string, Claim>();

/** 统一已有路径和待创建文件；拒绝符号链接指向工作区外的声明产物。 */
export function outputKeys(cwd: string, paths: readonly string[]): string[] {
  const root = realpathSync(cwd);
  return [...new Set(paths.map((raw) => {
    const path = raw.replaceAll("\\", "/");
    if (!path || path.length > 300 || path !== path.trim() || /[\x00-\x1f:]/.test(path) ||
        path.startsWith("/") || path.split("/").includes("..")) throw new Error("产物路径须在工作区内。");
    const target = resolve(root, path);
    let parent = target;
    for (;;) {
      try {
        const key = resolve(realpathSync(parent), target.slice(parent.length).replace(/^\//, ""));
        if (!key.startsWith(root + sep)) throw new Error("产物路径须在工作区内。");
        return key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === root) throw error;
        parent = dirname(parent);
      }
    }
  }))].sort();
}

export function claimOutputs(keys: string[], owner: string, active: () => boolean = () => true): boolean {
  for (const key of keys) {
    const existing = claims.get(key);
    if (existing && !existing.active()) claims.delete(key);
    else if (existing && existing.owner !== owner) return false;
  }
  for (const key of keys) claims.set(key, { owner, active });
  return true;
}

export function releaseOutputs(keys: string[], owner: string) {
  for (const key of keys) if (claims.get(key)?.owner === owner) claims.delete(key);
}
