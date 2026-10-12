import { isAbsolute, relative, sep } from "node:path";

/** path.relative 的结果是否跑出了起点；`..notes.md` 这类以 .. 开头的文件名不算 */
export function relEscapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel);
}

/** path 就是 root 或在 root 里面；两者应已 resolve（需要防符号链接时先各自 realpath） */
export function isInside(path: string, root: string): boolean {
  return !relEscapes(relative(root, path));
}
