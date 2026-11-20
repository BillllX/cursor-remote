import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ProjectError, PROJECT_LIMITS, type ProjectEntry } from "../../../../shared/projectTypes.ts";
import { projectPath } from "../../../../shared/projectValidation.ts";
export const hashBytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function syncDir(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export class ProjectObjects {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectError("BAD_REQUEST");
    return join(this.root, hash.slice(0, 2), hash);
  }
  put(bytes: Uint8Array): string {
    const hash = hashBytes(bytes);
    const path = this.path(hash);
    const dir = join(this.root, hash.slice(0, 2));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    syncDir(this.root);
    const tmp = join(dir, `.${randomUUID()}`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      unlinkSync(tmp);
    }
    syncDir(dir);
    this.read(hash);
    return hash;
  }
  read(hash: string): Buffer {
    try {
      const path = this.path(hash),
        st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("invalid object");
      const value = readFileSync(path);
      if (hashBytes(value) !== hash) throw new Error("hash mismatch");
      return value;
    } catch {
      throw new ProjectError("STORAGE_CORRUPT", "项目对象损坏，已停止访问");
    }
  }
  tree(entries: ProjectEntry[]): string {
    if (entries.length > PROJECT_LIMITS.entries) throw new ProjectError("LIMIT_EXCEEDED");
    const seen = new Map<string, ProjectEntry>();
    let bytes = 0;
    for (const item of entries) {
      projectPath(item.path);
      const key = item.path.toLowerCase();
      if (seen.has(key)) throw new ProjectError("BAD_REQUEST", "文件名大小写冲突");
      seen.set(key, item);
      if (item.kind === "file") {
        if (
          !item.blobHash ||
          !Number.isSafeInteger(item.size) ||
          Number(item.size) < 0 ||
          Number(item.size) > PROJECT_LIMITS.fileBytes
        )
          throw new ProjectError("BAD_REQUEST");
        bytes += Number(item.size);
      }
    }
    for (const item of entries) {
      const pieces = item.path.split("/");
      pieces.pop();
      while (pieces.length) {
        const parent = seen.get(pieces.join("/").toLowerCase());
        if (parent && parent.kind !== "dir") throw new ProjectError("BAD_REQUEST", "文件不能作为目录");
        pieces.pop();
      }
    }
    if (bytes > PROJECT_LIMITS.currentBytes) throw new ProjectError("LIMIT_EXCEEDED");
    return this.put(
      Buffer.from(
        canonical({
          schema: 1,
          entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
        }),
      ),
    );
  }
  entries(hash: string): ProjectEntry[] {
    try {
      const tree = JSON.parse(this.read(hash).toString("utf8"));
      if (tree.schema !== 1 || !Array.isArray(tree.entries)) throw new Error();
      return tree.entries;
    } catch {
      throw new ProjectError("STORAGE_CORRUPT");
    }
  }
}
