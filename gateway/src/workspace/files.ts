// 工作区文件：读写、上传落盘、文件操作、diff、文件清单与搜索、撤销单个 hunk
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { WebSocket } from "ws";
import { isPolicyProtectedPath } from "../../../shared/policy.ts";
import { formatBytes, isByteKind, kindFromPath, mimeOf, sizeLimit } from "../../../shared/preview.ts";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { log } from "../log.ts";
import { relEscapes } from "../pathInside.ts";
import { filePayload } from "../media.ts";
import { cwdOf } from "../runtime/slots.ts";
import type { Conn, Slot, WorkspaceFile, WorkspaceFiles } from "../runtime/types.ts";
import { getTenant, mediaSecret, type Tenant } from "../tenants.ts";
import { fitWorkspaceFiles } from "../ws/frame.ts";
import { send } from "../ws/send.ts";
import { git, gitRoot, isTracked, shadowGitEnv } from "./git.ts";

export function payload(
  tenant: Tenant,
  chatId: string | undefined,
  path: string,
  file: Parameters<typeof filePayload>[4],
  diff: boolean,
  echo?: Parameters<typeof filePayload>[6],
) {
  return filePayload(mediaSecret(), tenant.id, chatId, path, file, diff, echo);
}

export function workspacePath(cwd: string, raw: string): string | null {
  const abs = raw.startsWith("/") ? raw : resolve(cwd, raw);
  const rel = relative(cwd, abs);
  if (!rel || relEscapes(rel)) return null;
  return rel;
}

export function pushWorkspace(ws: WebSocket, slot: Slot, conn: Conn, paths: string[] = []) {
  const cwd = cwdOf(conn, slot);
  const listed = listWorkspaceFilesForClient(cwd, "");
  send(ws, filesMessage(conn, { chatId: slot.chatId, query: "" }, listed));
  const unique = [...new Set(paths.filter(Boolean))];
  for (const path of unique) {
    const file = readWorkspaceFile(cwd, path);
    send(ws, payload(conn.tenant || getTenant(slot.tenantId)!, slot.chatId, path, file, false));
    const diff = readWorkspaceDiff(cwd, path);
    send(ws, payload(conn.tenant || getTenant(slot.tenantId)!, slot.chatId, path, diff, true));
  }
}

export function readWorkspaceFile(cwd: string, raw: string): WorkspaceFile {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const abs = resolve(cwd, path);
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { path, error: "这不是文件" };
    const kind = kindFromPath(path);
    const mime = mimeOf(path, kind);
    const limit = sizeLimit(kind);
    if (st.size > limit) {
      return {
        path,
        error: `文件太大（${formatBytes(st.size)}），不在这里打开`,
        kind,
        mime,
        size: st.size,
      };
    }
    if (isByteKind(kind)) {
      return { path, kind, mime, size: st.size };
    }
    if ((kind === "html" || kind === "markdown") && st.size > 400_000) {
      return { path, kind, mime, size: st.size };
    }
    const buf = readFileSync(abs);
    if (kind === "text" && buf.includes(0)) {
      return {
        path,
        error: "二进制文件，没法预览",
        kind: "binary",
        mime: "application/octet-stream",
        size: st.size,
      };
    }
    return { path, content: buf.toString("utf8"), kind, mime, size: st.size };
  } catch {
    return { path, error: "读不了这个文件" };
  }
}

export function writeWorkspaceFile(cwd: string, raw: string, content: string): { path: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path)) return { path, error: "不能改策略文件" };
  if (content.length > 500_000) return { path, error: "内容超过 500KB，不在这里保存" };
  const abs = resolve(cwd, path);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return { path };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "写不了这个文件" };
  }
}

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

const UPLOAD_DIR = ".cursor-remote/uploads";

function safeUploadName(raw: string): string {
  const base = basename(raw || "file").replace(/[\\/]/g, "");
  const cleaned =
    base
      .replace(/[\x00-\x1f:*?"<>|]/g, "_")
      .replace(/^\.+/g, "")
      .trim() || "file";
  return cleaned.slice(0, 120);
}

export function uniqueUploadPath(cwd: string, name: string): string | null {
  const safe = safeUploadName(name);
  for (let n = 0; n < 200; n++) {
    const stem =
      n === 0
        ? safe
        : (() => {
            const dot = safe.lastIndexOf(".");
            const head = dot > 0 ? safe.slice(0, dot) : safe;
            const ext = dot > 0 ? safe.slice(dot) : "";
            return `${head}-${n}${ext}`;
          })();
    const rel = `${UPLOAD_DIR}/${stem}`;
    if (!workspacePath(cwd, rel)) return null;
    if (!existsSync(resolve(cwd, rel))) return rel;
  }
  return null;
}

export function writeWorkspaceBytes(
  cwd: string,
  raw: string,
  buf: Buffer,
): { path: string; error?: string; size?: number } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path)) return { path, error: "不能改策略文件" };
  if (buf.length > MAX_UPLOAD_BYTES) return { path, error: "文件超过 32MB" };
  try {
    mkdirSync(dirname(resolve(cwd, path)), { recursive: true });
    writeFileSync(resolve(cwd, path), buf);
    return { path, size: buf.length };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "写不了这个文件" };
  }
}

export function runFsOp(
  cwd: string,
  op: "create" | "mkdir" | "rename" | "delete",
  raw: string,
  to?: string,
): { path: string; to?: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  if (isPolicyProtectedPath(path) || (to && isPolicyProtectedPath(to))) {
    return { path, to, error: "不能改策略文件" };
  }
  const abs = resolve(cwd, path);
  try {
    if (op === "mkdir") {
      mkdirSync(abs, { recursive: true });
      return { path };
    }
    if (op === "create") {
      mkdirSync(dirname(abs), { recursive: true });
      if (existsSync(abs)) return { path, error: "已经有这个文件" };
      writeFileSync(abs, "");
      return { path };
    }
    if (op === "rename") {
      if (!to?.trim()) return { path, error: "缺少新名字" };
      const dest = workspacePath(cwd, to);
      if (!dest) return { path, to, error: "新路径不在工作区里" };
      const destAbs = resolve(cwd, dest);
      if (existsSync(destAbs)) return { path, to: dest, error: "目标已存在" };
      mkdirSync(dirname(destAbs), { recursive: true });
      renameSync(abs, destAbs);
      return { path, to: dest };
    }
    if (op === "delete") {
      if (!existsSync(abs)) return { path, error: "不存在" };
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (readdirSync(abs).length) return { path, error: "目录不是空的" };
        rmdirSync(abs);
      } else {
        unlinkSync(abs);
      }
      return { path };
    }
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "操作失败" };
  }
  return { path, error: "未知操作" };
}

export function readWorkspaceDiff(cwd: string, raw: string): WorkspaceFile {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  try {
    if (kind === "image" || kind === "svg") {
      const abs = resolve(cwd, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        return { path, error: "这不是文件", kind, mime };
      }
      const size = statSync(abs).size;
      if (!isTracked(cwd, path)) {
        return { path, kind, mime, size, hasHead: false };
      }
      const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
      const out = git(cwd, ["diff", "HEAD", "--", path], env);
      if (!out) return { path, error: "没有未提交的改动", kind, mime, size };
      return { path, kind, mime, size, hasHead: true };
    }
    if (isByteKind(kind)) {
      return { path, error: "这类文件没有文本 diff", kind, mime };
    }
    if (isTracked(cwd, path)) {
      const env = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
      const out = git(cwd, ["diff", "HEAD", "--", path], env);
      if (out) return { path, content: out, kind: "text", mime: "text/x-diff" };
      return { path, error: "没有未提交的改动", kind };
    }
    const file = readWorkspaceFile(cwd, path);
    if (file.error || file.content == null) {
      return { path, error: file.error || "读不了这个文件", kind: file.kind, mime: file.mime, size: file.size };
    }
    const lines = file.content.split("\n");
    const body = [
      `diff --git a/${path} b/${path}`,
      "new file",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return { path, content: body, kind: "text", mime: "text/x-diff", size: file.size };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : "没有 diff", kind, mime };
  }
}

export function walkFiles(root: string, dir: string, acc: string[], depth: number) {
  if (depth > 3 || acc.length > 200) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === ".next" ||
      name === "dist" ||
      name === ".loop" ||
      name === ".cursor" ||
      name === ".venv" ||
      name === "venv" ||
      name === "coverage"
    ) {
      continue;
    }
    const full = resolve(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        if (full !== root && existsSync(resolve(full, ".git"))) continue;
        walkFiles(root, full, acc, depth + 1);
      } else acc.push(relative(root, full));
    } catch (err) {
      // skip unreadable
      log.debug("遍历文件：读不了", full, err instanceof Error ? err.message : err);
    }
  }
}

function gitLetter(xy: string): string {
  if (xy === "??" || xy.includes("?")) return "U";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  if (xy.includes("R") || xy.includes("C")) return "R";
  return "M";
}

function unescapeGitPath(file: string): string {
  if (!(file.startsWith('"') && file.endsWith('"'))) return file;
  const inner = file.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === "\\") {
        bytes.push(next.charCodeAt(0));
        i += 1;
        continue;
      }
      const oct = /^\\([0-7]{3})/.exec(inner.slice(i));
      if (oct) {
        bytes.push(Number.parseInt(oct[1], 8));
        i += oct[0].length - 1;
        continue;
      }
    }
    bytes.push(inner.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString("utf8");
}

function parsePorcelain(out: string, root: string, cwd: string): Record<string, string> {
  const map: Record<string, string> = {};
  const nul = out.includes("\0");
  const chunks = nul ? out.split("\0") : out.split("\n");
  for (let i = 0; i < chunks.length; i++) {
    const raw = chunks[i];
    if (raw.length < 3) continue;
    const xy = raw.slice(0, 2);
    let file = unescapeGitPath(raw.slice(3));
    if ((xy.includes("R") || xy.includes("C")) && nul && i + 1 < chunks.length) {
      file = unescapeGitPath(chunks[++i]);
    } else {
      const arrow = file.lastIndexOf(" -> ");
      if (arrow >= 0) file = file.slice(arrow + 4);
    }
    if (!file) continue;
    const rel = relative(cwd, resolve(root, file));
    if (!rel || relEscapes(rel)) continue;
    map[rel] = gitLetter(xy);
  }
  return map;
}

function headNames(cwd: string, extra?: Record<string, string>): Set<string> {
  try {
    const out = extra
      ? git(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], extra)
      : execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
          cwd,
          encoding: "utf8",
          timeout: 4000,
          stdio: ["ignore", "pipe", "ignore"],
        });
    return new Set(
      out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function dropGhostStatus(
  cwd: string,
  map: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const head = headNames(cwd, extra);
  const next: Record<string, string> = {};
  for (const [path, letter] of Object.entries(map)) {
    if (existsSync(resolve(cwd, path)) || head.has(path)) next[path] = letter;
  }
  return next;
}

function gitStatusMap(cwd: string): Record<string, string> {
  const run = (root: string, extra?: Record<string, string>) => {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain", "-uall", "-z"], {
      cwd,
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      env: extra ? { ...process.env, ...extra } : process.env,
    });
    return dropGhostStatus(cwd, parsePorcelain(out, root, cwd), extra);
  };
  const root = gitRoot(cwd);
  if (root) {
    try {
      return run(root);
    } catch {
      return {};
    }
  }
  const extra = shadowGitEnv(cwd);
  if (!extra) return {};
  try {
    return run(cwd, extra);
  } catch {
    return {};
  }
}

export function listWorkspaceFiles(cwd: string, query: string): WorkspaceFiles {
  const { paths, status } = collectWorkspaceFiles(cwd);
  return rankWorkspaceFiles(paths, status, query);
}

/**
 * 给文件树和 @ 补全用：嵌套仓库在外层 git 里只占一项 `dir/`，要进去再列一次。
 * 检查点不能用这个——还原时会删掉清单里有、快照里没有的文件，而快照只记了嵌套仓库的 gitlink。
 */
export function listWorkspaceFilesForClient(cwd: string, query: string): WorkspaceFiles {
  const { paths, status } = collectWithNested(cwd, 0);
  return rankWorkspaceFiles(paths, status, query);
}

function collectWithNested(cwd: string, depth: number): { paths: string[]; status: Record<string, string> } {
  const own = collectWorkspaceFiles(cwd);
  if (depth >= 3) return own;
  const nested = own.paths.filter((path) => {
    try {
      const abs = resolve(cwd, path);
      return statSync(abs).isDirectory() && existsSync(resolve(abs, ".git"));
    } catch {
      return false;
    }
  });
  if (!nested.length) return own;
  const skip = new Set(nested);
  const paths = own.paths.filter((path) => !skip.has(path));
  const status: Record<string, string> = {};
  for (const [path, letter] of Object.entries(own.status)) if (!skip.has(path)) status[path] = letter;
  for (const dir of nested) {
    const inner = collectWithNested(resolve(cwd, dir), depth + 1);
    for (const path of inner.paths) paths.push(`${dir}/${path}`);
    for (const [path, letter] of Object.entries(inner.status)) status[`${dir}/${path}`] = letter;
  }
  return { paths, status };
}

function collectWorkspaceFiles(cwd: string): { paths: string[]; status: Record<string, string> } {
  let paths: string[] = [];
  const root = gitRoot(cwd);
  const shadow = root ? null : shadowGitEnv(cwd);
  try {
    if (root) {
      // quotepath 默认会把中文路径收成 "\345\256..."，后面的 existsSync 对不上磁盘，整批被丢掉。
      const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z"], {
        cwd,
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      paths = out
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else if (shadow) {
      paths = git(cwd, ["ls-tree", "-z", "-r", "--name-only", "HEAD"], shadow)
        .split("\0")
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      walkFiles(cwd, cwd, paths, 0);
    }
  } catch {
    walkFiles(cwd, cwd, paths, 0);
  }
  const status = gitStatusMap(cwd);
  paths = paths.filter((path) => existsSync(resolve(cwd, path)));
  for (const path of Object.keys(status)) {
    if (status[path] === "D") continue;
    if (!paths.includes(path) && existsSync(resolve(cwd, path))) paths.push(path);
  }
  return { paths, status };
}

function rankWorkspaceFiles(paths: string[], status: Record<string, string>, query: string): WorkspaceFiles {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? paths.filter((path) => {
        const base = path.split("/").pop() || path;
        return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
      })
    : paths;
  const dirty = Object.keys(status);
  const rest = filtered.filter((path) => !status[path]);
  const ranked = q ? filtered : [...dirty.filter((path) => filtered.includes(path)), ...rest];
  const sliced = ranked.slice(0, 8000);
  return { paths: sliced, status, truncated: ranked.length > sliced.length };
}

export function filesMessage(
  conn: Conn | undefined,
  base: { chatId?: string; query: string; mention?: boolean },
  listed: WorkspaceFiles,
): ServerMessage {
  const overhead = Buffer.byteLength(JSON.stringify({ type: "files", ...base, truncated: true }));
  const fitted = fitWorkspaceFiles(listed, conn?.maxMessageBytes ?? 0, overhead);
  return { type: "files", ...base, paths: fitted.paths, status: fitted.status, truncated: fitted.truncated };
}

function parseSearchHits(raw: string): { path: string; line: number; text: string }[] {
  const hits: { path: string; line: number; text: string }[] = [];
  for (const row of raw.split("\n")) {
    if (!row) continue;
    const match = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!match) continue;
    hits.push({
      path: match[1].replace(/^\.\//, ""),
      line: Number(match[2]),
      text: match[3].replace(/\s+/g, " ").trim().slice(0, 140),
    });
    if (hits.length >= 100) break;
  }
  return hits;
}

export function searchWorkspace(cwd: string, query: string): { path: string; line: number; text: string }[] {
  const needle = query.trim();
  if (!needle || needle.length > 200) return [];
  const globs = [
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!**/.next/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/.venv/**",
  ];
  try {
    const out = execFileSync(
      "rg",
      [
        "-n",
        "--fixed-strings",
        "--hidden",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        "24",
        "--max-filesize",
        "200K",
        ...globs,
        "--",
        needle,
        ".",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 2_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return parseSearchHits(out);
  } catch (err) {
    const failed = err as { status?: number; stdout?: string };
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  try {
    const extra = gitRoot(cwd) ? undefined : shadowGitEnv(cwd) || undefined;
    const out = execFileSync("git", ["-c", "core.quotepath=false", "grep", "-n", "-I", "-F", "-e", needle, "--", "."], {
      cwd,
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: extra ? { ...process.env, ...extra } : process.env,
    });
    return parseSearchHits(out);
  } catch (err) {
    const failed = err as { status?: number; stdout?: string };
    if (failed.status === 1) return parseSearchHits(failed.stdout || "");
  }
  const paths: string[] = [];
  walkFiles(cwd, cwd, paths, 0);
  const hits: { path: string; line: number; text: string }[] = [];
  const lower = needle.toLowerCase();
  for (const path of paths) {
    const abs = resolve(cwd, path);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > 200_000) continue;
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue;
      const lines = buf.toString("utf8").split("\n");
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(lower)) continue;
        hits.push({
          path,
          line: i + 1,
          text: lines[i].replace(/\s+/g, " ").trim().slice(0, 140),
        });
        n += 1;
        if (n >= 8 || hits.length >= 100) break;
      }
    } catch (err) {
      // skip unreadable
      log.debug("搜索：文件读不了", abs, err instanceof Error ? err.message : err);
    }
    if (hits.length >= 100) break;
  }
  return hits;
}

export function revertHunk(cwd: string, raw: string, hunk: string): { path: string; error?: string } {
  const path = workspacePath(cwd, raw);
  if (!path) return { path: raw, error: "路径不在工作区里" };
  const headerRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const hunkLines = hunk.split("\n");
  const atIdx = hunkLines.findIndex((line) => headerRe.test(line));
  if (atIdx < 0) return { path, error: "看不懂这段 diff" };
  const header = headerRe.exec(hunkLines[atIdx]);
  if (!header) return { path, error: "看不懂这段 diff" };
  const file = readWorkspaceFile(cwd, path);
  if (file.error || file.content == null) {
    return { path, error: file.error || "读不了这个文件" };
  }
  let i = Number(header[1]) - 1;
  const lines = file.content.split("\n");
  const body = hunkLines.slice(atIdx + 1);
  for (let k = 0; k < body.length; k++) {
    const row = body[k];
    if (k === body.length - 1 && row === "") continue;
    if (row.startsWith("+")) {
      if (i < 0 || i >= lines.length) return { path, error: "这段 diff 对不上文件" };
      lines.splice(i, 1);
    } else if (row.startsWith("-")) {
      lines.splice(Math.max(i, 0), 0, row.slice(1));
      i += 1;
    } else if (row.startsWith("\\")) {
      continue;
    } else {
      i += 1;
    }
  }
  const abs = resolve(cwd, path);
  const next = lines.join("\n");
  try {
    if (!next.trim() && !isTracked(cwd, path)) {
      if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
    } else {
      writeFileSync(abs, next);
    }
  } catch {
    return { path, error: "写回失败" };
  }
  return { path };
}
