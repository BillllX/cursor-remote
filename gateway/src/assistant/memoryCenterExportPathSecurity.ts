import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isInside } from "../pathInside.ts";

export type SecurePathOk = { ok: true; exportDir: string; rootReal: string };
export type SecurePathFail = { ok: false; code: "security"; message: string };

function lstatPlainDir(abs: string): SecurePathFail | { ok: true; dev: number; ino: number; real: string } {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, code: "security", message: "路径含符号链接。" };
    if (!st.isDirectory()) return { ok: false, code: "security", message: "路径不是目录。" };
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return { ok: false, code: "security", message: "无法解析目录 realpath。" };
    }
    return { ok: true, dev: st.dev, ino: st.ino, real };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, code: "security", message: "目录不存在。" };
    return { ok: false, code: "security", message: "无法检查目录。" };
  }
}

function verifyParentInode(parentAbs: string, expect: { dev: number; ino: number; real: string }, rootReal: string): SecurePathFail | null {
  if (!isInside(parentAbs, rootReal) && parentAbs !== rootReal) {
    return { ok: false, code: "security", message: "父路径越界。" };
  }
  const now = lstatPlainDir(parentAbs);
  if (!now.ok) return now;
  if (now.dev !== expect.dev || now.ino !== expect.ino) {
    return { ok: false, code: "security", message: "父目录 inode 已变更。" };
  }
  if (now.real !== expect.real) {
    return { ok: false, code: "security", message: "父目录 realpath 已变更。" };
  }
  return null;
}

/** 从 workspaceRoot 逐级检查 `.jiebo` / `memory-export` 不得为 symlink；缺失则逐级创建并每级验证。 */
export function prepareSecureMemoryExportDir(workspaceRoot: string): SecurePathOk | SecurePathFail {
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(workspaceRoot));
  } catch {
    return { ok: false, code: "security", message: "无法解析 workspace 根。" };
  }
  const rootStat = lstatPlainDir(rootReal);
  if (!rootStat.ok) return rootStat;

  const jieboAbs = resolve(rootReal, ".jiebo");
  let jieboStat = lstatPlainDir(jieboAbs);
  if (!jieboStat.ok) {
    if (jieboStat.message === "目录不存在。") {
      try {
        mkdirSync(jieboAbs, { mode: 0o700 });
      } catch {
        return { ok: false, code: "security", message: "无法创建 .jiebo。" };
      }
      jieboStat = lstatPlainDir(jieboAbs);
      if (!jieboStat.ok) return jieboStat;
    } else return jieboStat;
  }
  if (!isInside(jieboStat.real, rootReal)) {
    return { ok: false, code: "security", message: ".jiebo 指向 workspace 外。" };
  }

  const exportAbs = resolve(jieboAbs, "memory-export");
  let exportStat = lstatPlainDir(exportAbs);
  if (!exportStat.ok) {
    if (exportStat.message === "目录不存在。") {
      const parentSnap = { dev: jieboStat.dev, ino: jieboStat.ino, real: jieboStat.real };
      try {
        mkdirSync(exportAbs, { mode: 0o700 });
      } catch {
        return { ok: false, code: "security", message: "无法创建 memory-export。" };
      }
      const parentErr = verifyParentInode(jieboAbs, parentSnap, rootReal);
      if (parentErr) return parentErr;
      exportStat = lstatPlainDir(exportAbs);
      if (!exportStat.ok) return exportStat;
    } else return exportStat;
  }
  if (!isInside(exportStat.real, rootReal)) {
    return { ok: false, code: "security", message: "memory-export 指向 workspace 外。" };
  }
  return { ok: true, exportDir: exportAbs, rootReal };
}

export function verifyExportWriteParent(
  fileAbs: string,
  rootReal: string,
  exportDirSnap: { dev: number; ino: number; real: string },
): SecurePathFail | null {
  const parent = resolve(fileAbs, "..");
  return verifyParentInode(parent, exportDirSnap, rootReal);
}

export function snapshotExportDirStat(exportDir: string): { dev: number; ino: number; real: string } {
  const st = lstatPlainDir(exportDir);
  if (!st.ok) throw new Error(st.message);
  return { dev: st.dev, ino: st.ino, real: st.real };
}
