import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isPolicyProtectedPath } from "../../../shared/policy.ts";

export class ConfineError extends Error {}

function inside(child: string, parent: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrSelf(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 最近一个存在的祖先目录的真实路径，再拼回剩下的部分。挡住经由符号链接逃出工作区。 */
function realResolved(abs: string) {
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    probe = parent;
  }
  return tail.length ? resolve(realOrSelf(probe), ...tail) : realOrSelf(probe);
}

export type Resolved = { abs: string; rel: string };

/**
 * 把模型给的路径解析到工作区内。绝对路径必须落在工作区里；`..`、符号链接逃逸、
 * `.git` 内部和策略保护文件一律拒绝。
 */
export function resolveInside(cwd: string, raw: unknown, opts: { write?: boolean } = {}): Resolved {
  const input = typeof raw === "string" ? raw.trim() : "";
  const root = realOrSelf(resolve(cwd));
  const abs = resolve(root, input || ".");
  if (!inside(abs, root)) throw new ConfineError(`路径不在工作区内：${input}`);
  const real = realResolved(abs);
  if (!inside(real, root)) throw new ConfineError(`路径经符号链接指向工作区外：${input}`);
  const rel = relative(root, real).split(sep).join("/");
  if (rel.split("/").includes(".git")) throw new ConfineError("不能访问 .git 内部");
  if (opts.write && isPolicyProtectedPath(rel)) throw new ConfineError(`受保护的文件，不能改：${rel}`);
  return { abs: real, rel };
}
