import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import type { HistoryTurn, PreviewKind, TurnFile } from "../../shared/protocol.ts";
import { formatBytes, isByteKind, kindFromPath, mimeOf, sizeLimit } from "../../shared/preview.ts";

type RunTool = NonNullable<HistoryTurn["tools"]>[number];

export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const ARTIFACTS_QUOTA = 1024 * 1024 * 1024;
export const ARTIFACTS_TARGET = Math.floor(ARTIFACTS_QUOTA * 0.9);
export const DIFF_MAX_BYTES = 200_000;
export const MAX_TURN_FILES = 40;

/** finishRun 是同步的，整份清单（git + 快照 + 对照）的总预算；超了后面的文件只列不存 */
export const TURN_BUDGET_MS = 8_000;
/** 回合开始时建「只用于清单」的基线的预算，超了就不建 */
export const TREE_BASELINE_BUDGET_MS = 5_000;
/** 根目录工作区按文件清单 add，清单超过这个量就不建只用于清单的基线 */
export const TREE_BASELINE_MAX_FILES = 5_000;
/** 没基线时逐个调 readWorkspaceDiff 的上限，其余文件只给 sha */
export const FALLBACK_DIFF_LIMIT = 10;
export const QUOTA_RESCAN_MS = 10 * 60_000;

const SHA_RE = /^[0-9a-f]{64}$/;
const DIFF_CUT_MARK = "\n…（过长已截断）\n";
const GIT_TIMEOUT_MS = 5_000;

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA_RE.test(value);
}

export function isTextKind(kind: PreviewKind) {
  return kind === "text" || kind === "canvas" || kind === "markdown" || kind === "html" || kind === "svg";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------- 来源 A：工具调用里的路径 ----------

const PATH_KEYS = [
  "path",
  "file",
  "target",
  "file_path",
  "uri",
  "filename",
  "image_path",
  "imagePath",
  "output_path",
  "outputPath",
];
const LIST_KEYS = ["paths", "files"];
const PATCH_LINE = /^\*\*\* (?:Add|Update) File:[ \t]*(.+?)[ \t]*$/gm;

/** 判定规则与 iOS 端一致，改这里要同步改 iOS */
export function toolWritesFiles(name: string): boolean {
  const n = name.toLowerCase();
  if (/todo|createplan/.test(n)) return false;
  if (/delete|unlink|remove/.test(n)) return false;
  return /strreplace|replace|apply.?patch|editnotebook|edit|write|create|generateimage|generate_image|image_gen/.test(n);
}

function cleanPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith("file://")) return value;
  try {
    return decodeURIComponent(value.slice("file://".length));
  } catch {
    return value.slice("file://".length);
  }
}

function collectKeyed(value: unknown, out: string[], depth: number) {
  if (depth > 3 || !isRecord(value)) return;
  for (const key of PATH_KEYS) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) out.push(cleanPath(item));
  }
  for (const key of LIST_KEYS) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, 200)) {
      if (typeof item === "string" && item.trim()) out.push(cleanPath(item));
      else collectKeyed(item, out, depth + 1);
    }
  }
}

function collectPatch(value: unknown, out: string[], depth: number) {
  if (depth > 4) return;
  if (typeof value === "string") {
    if (!value.includes("*** ")) return;
    for (const match of value.matchAll(PATCH_LINE)) out.push(cleanPath(match[1]));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectPatch(item, out, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectPatch(item, out, depth + 1);
  }
}

/** 本轮写文件工具涉及的原始路径，按出现顺序去重 */
export function toolPaths(tools: RunTool[]): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || tool.status === "error") continue;
    if (!toolWritesFiles(tool.name)) continue;
    const found: string[] = [];
    collectKeyed(tool.args, found, 0);
    collectKeyed(tool.result, found, 0);
    collectPatch(tool.args, found, 0);
    for (const item of found) if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** 与 index.ts 的 workspacePath 同一口径，另外排除 .git 目录 */
export function workspaceRel(cwd: string, raw: string): string | null {
  if (!raw) return null;
  const abs = raw.startsWith("/") ? raw : resolve(cwd, raw);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return null;
  if (rel.split("/").includes(".git")) return null;
  return rel;
}

const CANVAS_PATH = /\.canvas\.tsx$/i;

function normalizeCanvasTarget(raw: string): string | null {
  let path = cleanPath(raw.trim());
  if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1).trim();
  const space = path.search(/\s/);
  if (space >= 0) path = path.slice(0, space);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.toLowerCase().startsWith("file://")) return null;
  path = cleanPath(path);
  path = path.split(/[#?]/, 1)[0] ?? path;
  path = path.replace(/:\d+(?:-\d+)?$/, "");
  path = path.replace(/[.,;:!?。，；：！？、）」』]+$/u, "");
  path = path.replace(/\/+$/, "").replace(/^\.\//, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // 保留原样
  }
  if (!CANVAS_PATH.test(path)) return null;
  return path;
}

/** 从助理回复里的 markdown 链接和 @ 提及提取 .canvas.tsx 路径，按出现顺序去重 */
export function canvasPathsFromAssistant(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const path = normalizeCanvasTarget(raw);
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  if (!text) return out;
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) push(match[1]);
  for (const match of text.matchAll(/@([^\s`[\]()<>,;]+)/g)) push(match[1]);
  return out;
}

// ---------- 来源 B：对比本轮开始时的检查点 ----------

export type GitCtx = { cwd: string; env: Record<string, string> };

export type TurnBaseline = {
  /** 检查点 commit，或只用于清单的 tree；diff --cached 两者都认 */
  commit: string;
  /** checkpointGit 给出的上下文；GIT_INDEX_FILE 会被临时文件替换 */
  ctx: GitCtx;
  /** 聊天目录在仓库里的相对前缀，根目录为空串 */
  prefix: string;
  /** 与 createCheckpoint 相同的 add 范围 */
  scope: string[];
};

type BaseChange = { status: "added" | "modified"; added?: number; removed?: number };

type BaselineDiff = {
  changes: Map<string, BaseChange>;
  /** 一次 git diff 拿全部路径的对照文本，按工作区相对路径拆好 */
  diffs(rels: string[]): Map<string, string>;
  /** 基线树里有哪些路径；git 失败返回 null（判断不了） */
  present(rels: string[]): Set<string> | null;
  close(): void;
};

function treeToCwd(treePath: string, prefix: string): string | null {
  const norm = treePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return null;
  if (!prefix) return norm;
  const lead = `${prefix}/`;
  return norm.startsWith(lead) ? norm.slice(lead.length) : null;
}

function cwdToTree(rel: string, prefix: string) {
  return prefix ? `${prefix}/${rel}` : rel;
}

export function parseNameStatus(out: string): Array<{ status: string; path: string }> {
  const parts = out.split("\0");
  const rows: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].trim();
    const path = parts[i + 1];
    if (status && path) rows.push({ status, path });
  }
  return rows;
}

export function parseNumstat(out: string): Map<string, { added?: number; removed?: number }> {
  const map = new Map<string, { added?: number; removed?: number }>();
  for (const row of out.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row.replace(/^\n+/, ""));
    if (!match) continue;
    map.set(match[3], {
      added: match[1] === "-" ? undefined : Number(match[1]),
      removed: match[2] === "-" ? undefined : Number(match[2]),
    });
  }
  return map;
}

/** git 对特殊字符路径用 C 风格加引号（quotePath=false 也只放过非 ASCII）：按字节还原再按 UTF-8 解码 */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1];
    if (next && /[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8) & 0xff);
      i += 3;
    } else if (next && next in simple) {
      bytes.push(simple[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 取 `diff --git a/X b/X` 里的 X（--no-renames 下两边相同）；带空格的未加引号路径按长度对半切 */
export function parseDiffHeader(line: string): string | null {
  const rest = line.replace(/^diff --git /, "");
  if (rest.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)" (.+)$/.exec(rest);
    if (!match) return null;
    const left = unquoteGitPath(`"${match[1]}"`);
    return left.startsWith("a/") ? left.slice(2) : null;
  }
  if (!rest.startsWith("a/")) return null;
  const n = (rest.length - 5) / 2;
  if (!Number.isInteger(n) || n <= 0) return null;
  if (rest.slice(2 + n, 5 + n) !== " b/") return null;
  return rest.slice(2, 2 + n);
}

/** 把一次 git diff 的整段输出按 `diff --git` 头拆成仓库路径 → 该文件的对照文本 */
export function splitGitDiff(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(out); m; m = re.exec(out)) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const chunk = out.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : out.length);
    const header = chunk.slice(0, chunk.indexOf("\n") < 0 ? chunk.length : chunk.indexOf("\n"));
    const path = parseDiffHeader(header);
    if (path) map.set(path, chunk);
  }
  return map;
}

type GitRun = (args: string[]) => string;

/** 每条 git 的超时取单条上限和剩余预算里较小的那个；预算用完直接抛错 */
function gitRunner(ctx: GitCtx, index: string, deadline: number): GitRun {
  const env = { ...process.env, ...ctx.env, GIT_INDEX_FILE: index };
  return (args) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("turn files budget exceeded");
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: ctx.cwd,
      encoding: "utf8",
      timeout: Math.min(GIT_TIMEOUT_MS, left),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  };
}

function tempIndex() {
  const index = resolve(tmpdir(), `cursor-remote-turn-${process.pid}-${randomBytes(6).toString("hex")}.index`);
  const close = () => {
    for (const file of [index, `${index}.lock`]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // 临时文件删不掉不影响结果
      }
    }
  };
  return { index, close };
}

/** 与 index.ts 的 createCheckpoint 相同的 add 范围：子目录只 add 前缀，根目录按文件清单 */
function stageScope(run: GitRun, prefix: string, scope: string[]) {
  try {
    if (scope.length) {
      for (let i = 0; i < scope.length; i += 200) {
        run(["add", "-A", "--", ...scope.slice(i, i + 200)]);
      }
    } else {
      run(["add", "-A"]);
    }
    run(["add", "-u", "--", ...(prefix ? [prefix] : ["."])]);
  } catch (err) {
    // 子目录范围失败时不能退成整仓 add，否则会把兄弟项目算进这一轮
    if (prefix) throw err;
    run(["add", "-A"]);
  }
}

/**
 * 回合开始时没建检查点（autoApprove 等）用的基线：临时 index 上 read-tree HEAD + add + write-tree，只要 tree。
 * 不 commit-tree、不 update-ref，用户的 index、HEAD 和还原点列表都不变。超预算或出错返回 null
 */
export function snapshotTree(
  base: Omit<TurnBaseline, "commit">,
  budgetMs = TREE_BASELINE_BUDGET_MS,
): string | null {
  const { index, close } = tempIndex();
  const run = gitRunner(base.ctx, index, Date.now() + budgetMs);
  try {
    try {
      run(["read-tree", "HEAD"]);
    } catch {
      run(["read-tree", "--empty"]);
    }
    stageScope(run, base.prefix, base.scope);
    const tree = run(["write-tree"]).trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    close();
  }
}

/** 用临时 index 把当前工作区和基线比；不碰仓库真实的 index 和 HEAD */
export function openBaseline(base: TurnBaseline, deadline = Date.now() + TURN_BUDGET_MS): BaselineDiff | null {
  const { index, close } = tempIndex();
  const run = gitRunner(base.ctx, index, deadline);
  // 具体文件路径一律按字面匹配，文件名里的 * [ ] 不当通配符
  const literal = (args: string[]) => run(["--literal-pathspecs", ...args]);
  try {
    run(["read-tree", base.commit]);
    stageScope(run, base.prefix, base.scope);
    const limit = base.prefix ? ["--", base.prefix] : [];
    const names = parseNameStatus(run(["diff", "--cached", "--name-status", "--no-renames", "-z", base.commit, ...limit]));
    const stats = parseNumstat(run(["diff", "--cached", "--numstat", "--no-renames", "-z", base.commit, ...limit]));
    const changes = new Map<string, BaseChange>();
    for (const row of names) {
      if (row.status.startsWith("D")) continue;
      const rel = treeToCwd(row.path, base.prefix);
      if (!rel) continue;
      const stat = stats.get(row.path);
      changes.set(rel, {
        status: row.status.startsWith("A") ? "added" : "modified",
        added: stat?.added,
        removed: stat?.removed,
      });
    }
    return {
      changes,
      diffs: (rels) => {
        const out = new Map<string, string>();
        if (!rels.length) return out;
        try {
          for (let i = 0; i < rels.length; i += 200) {
            const paths = rels.slice(i, i + 200).map((rel) => cwdToTree(rel, base.prefix));
            const text = literal(["diff", "--cached", "--no-renames", "--no-color", base.commit, "--", ...paths]);
            for (const [treePath, chunk] of splitGitDiff(text)) {
              const rel = treeToCwd(treePath, base.prefix);
              if (rel) out.set(rel, chunk);
            }
          }
        } catch {
          // 拿到多少算多少，缺的文件只给 sha
        }
        return out;
      },
      present: (rels) => {
        if (!rels.length) return new Set();
        try {
          const found = new Set<string>();
          for (let i = 0; i < rels.length; i += 200) {
            const paths = rels.slice(i, i + 200).map((rel) => cwdToTree(rel, base.prefix));
            const text = literal(["ls-tree", "-r", "-z", "--name-only", base.commit, "--", ...paths]);
            for (const row of text.split("\0")) {
              const rel = row ? treeToCwd(row, base.prefix) : null;
              if (rel) found.add(rel);
            }
          }
          return found;
        } catch {
          return null;
        }
      },
      close,
    };
  } catch {
    close();
    return null;
  }
}

// ---------- 快照存储 ----------

export function artifactsDir(stateDir: string) {
  return resolve(stateDir, "artifacts");
}

export function artifactPath(stateDir: string, sha: string): string | null {
  return isSha(sha) ? resolve(artifactsDir(stateDir), sha) : null;
}

export function sha256(buf: Buffer | string) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 已存在只刷新 mtime；新写走临时文件 + rename，避免半截快照被读到 */
export function storeArtifact(stateDir: string, buf: Buffer): { sha: string; wrote: boolean } {
  const sha = sha256(buf);
  const dir = artifactsDir(stateDir);
  const file = resolve(dir, sha);
  if (touchArtifact(stateDir, sha)) return { sha, wrote: false };
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(dir, `.${sha}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
    const cached = quotaCache.get(dir);
    if (cached) cached.total += buf.length;
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return { sha, wrote: true };
}

export function touchArtifact(stateDir: string, sha: string): boolean {
  const file = artifactPath(stateDir, sha);
  if (!file) return false;
  try {
    const now = new Date();
    utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

export function readArtifact(stateDir: string, sha: string): Buffer | null {
  const file = artifactPath(stateDir, sha);
  if (!file) return null;
  try {
    const buf = readFileSync(file);
    touchArtifact(stateDir, sha);
    return buf;
  } catch {
    return null;
  }
}

/** 按 artifacts 目录缓存的总字节数和上次扫描时间。写入时累加，进程内其它写入方不经过这里时靠定时重扫兜底 */
const quotaCache = new Map<string, { total: number; scannedAt: number }>();

/** 每轮结束都调：缓存显示没超额且扫描不旧时不碰磁盘 */
export function checkArtifactQuota(
  stateDir: string,
  max = ARTIFACTS_QUOTA,
  target = ARTIFACTS_TARGET,
  now = Date.now(),
): number {
  const cached = quotaCache.get(artifactsDir(stateDir));
  if (cached && cached.total <= max && now - cached.scannedAt < QUOTA_RESCAN_MS) return 0;
  return enforceArtifactQuota(stateDir, max, target, now);
}

/** 总量超过 max 时按 mtime 从旧到新删到 target 以下。顺手清掉一小时前没 rename 成功的临时文件 */
export function enforceArtifactQuota(
  stateDir: string,
  max = ARTIFACTS_QUOTA,
  target = ARTIFACTS_TARGET,
  now = Date.now(),
): number {
  const dir = artifactsDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    quotaCache.set(dir, { total: 0, scannedAt: now });
    return 0;
  }
  const rows: Array<{ file: string; size: number; mtime: number }> = [];
  let total = 0;
  const staleBefore = Date.now() - 60 * 60_000;
  for (const name of names) {
    const file = resolve(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      if (!SHA_RE.test(name)) {
        if (st.mtimeMs < staleBefore) unlinkSync(file);
        continue;
      }
      rows.push({ file, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch {
      // 并发删除等，跳过
    }
  }
  let removed = 0;
  if (total > max) {
    rows.sort((a, b) => a.mtime - b.mtime);
    for (const row of rows) {
      if (total <= target) break;
      try {
        unlinkSync(row.file);
        total -= row.size;
        removed += 1;
      } catch {
        // ignore
      }
    }
  }
  quotaCache.set(dir, { total, scannedAt: now });
  return removed;
}

// ---------- 读快照（read_file 带 sha） ----------

export type SnapshotFile = {
  path: string;
  content?: string;
  error?: string;
  kind?: PreviewKind;
  mime?: string;
  size?: number;
};

export const SNAPSHOT_GONE = "历史版本已清理";

/** 与 readWorkspaceFile 同样的大小和类型分支，只是内容来自快照 */
export function readSnapshotFile(stateDir: string, path: string, sha: string): SnapshotFile {
  if (!isSha(sha)) return { path, error: "sha 不合法" };
  const buf = readArtifact(stateDir, sha);
  if (!buf) return { path, error: SNAPSHOT_GONE };
  const kind = kindFromPath(path);
  const mime = mimeOf(path, kind);
  const size = buf.length;
  if (size > sizeLimit(kind)) {
    return { path, error: `文件太大（${formatBytes(size)}），不在这里打开`, kind, mime, size };
  }
  if (isByteKind(kind)) return { path, kind, mime, size };
  if ((kind === "html" || kind === "markdown") && size > 400_000) return { path, kind, mime, size };
  if (kind === "text" && buf.includes(0)) {
    return { path, error: "二进制文件，没法预览", kind: "binary", mime: "application/octet-stream", size };
  }
  return { path, content: buf.toString("utf8"), kind, mime, size };
}

export function readSnapshotDiff(stateDir: string, path: string, sha: string): SnapshotFile {
  if (!isSha(sha)) return { path, error: "sha 不合法" };
  const buf = readArtifact(stateDir, sha);
  if (!buf) return { path, error: SNAPSHOT_GONE };
  return { path, content: buf.toString("utf8"), kind: "text", mime: "text/x-diff", size: buf.length };
}

// ---------- 每轮清单 ----------

export function countDiffLines(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function capDiff(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= DIFF_MAX_BYTES) return text;
  const room = DIFF_MAX_BYTES - Buffer.byteLength(DIFF_CUT_MARK);
  // 截在字节上可能切断多字节字符，toString 会补替换符，可接受
  return buf.subarray(0, room).toString("utf8") + DIFF_CUT_MARK;
}

export type TurnFilesInput = {
  cwd: string;
  stateDir: string;
  tools: RunTool[];
  baseline?: TurnBaseline | null;
  /** 助理正文：其中的 canvas 链接/提及会追加到清单（在工具与 git 变更之后，避免挤掉真实改动） */
  assistantBody?: string;
  /** 没基线或文件不在基线可比范围里时的对照文本（index.ts 里是 readWorkspaceDiff） */
  fallbackDiff: (rel: string) => string | null;
  quota?: { max: number; target: number };
  /** 总预算，默认 TURN_BUDGET_MS */
  budgetMs?: number;
};

export function computeTurnFiles(input: TurnFilesInput): TurnFile[] {
  const { cwd, stateDir } = input;
  const deadline = Date.now() + (input.budgetMs ?? TURN_BUDGET_MS);
  const overBudget = () => Date.now() >= deadline;
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string | null) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    ordered.push(rel);
  };
  for (const raw of toolPaths(input.tools)) add(workspaceRel(cwd, raw));
  const base = input.baseline && !overBudget() ? openBaseline(input.baseline, deadline) : null;
  try {
    if (base) for (const rel of base.changes.keys()) add(workspaceRel(cwd, rel));
    if (input.assistantBody) {
      for (const raw of canvasPathsFromAssistant(input.assistantBody)) add(workspaceRel(cwd, raw));
    }
    const picked: Array<{ rel: string; abs: string; size: number; kind: PreviewKind }> = [];
    for (const rel of ordered) {
      if (picked.length >= MAX_TURN_FILES) break;
      const abs = resolve(cwd, rel);
      try {
        // lstat：符号链接不算，免得把工作区外的内容收进快照
        const st = lstatSync(abs);
        if (st.isFile()) picked.push({ rel, abs, size: st.size, kind: kindFromPath(rel) });
      } catch {
        // 结束时已不存在
      }
    }
    // 对照文本和「基线里有没有」各一次 git 批量拿，不按文件起子进程
    const textChanged = picked.filter((item) => isTextKind(item.kind) && base?.changes.has(item.rel)).map((item) => item.rel);
    const diffs = base && !overBudget() ? base.diffs(textChanged) : new Map<string, string>();
    const unchanged = picked.filter((item) => !base?.changes.has(item.rel)).map((item) => item.rel);
    const present = base && !overBudget() ? base.present(unchanged) : null;
    let fallbackLeft = FALLBACK_DIFF_LIMIT;
    const files: TurnFile[] = [];
    for (const { rel, abs, size, kind } of picked) {
      const change = base?.changes.get(rel);
      const inBase = change || !present ? null : present.has(rel);
      const row: TurnFile = { path: rel, kind, op: "modified", size };
      if (change) row.op = change.status;
      else if (inBase != null) row.op = inBase ? "modified" : "added";
      if (change?.added != null && change.removed != null) {
        row.added = change.added;
        row.removed = change.removed;
      }
      // 超预算后只列清单：不给 sha 时客户端打开当前版本
      if (overBudget()) {
        files.push(row);
        continue;
      }
      if (size <= SNAPSHOT_MAX_BYTES) {
        try {
          const buf = readFileSync(abs);
          const stored = storeArtifact(stateDir, buf);
          row.sha = stored.sha;
          row.size = buf.length;
        } catch {
          // 读不到就不给 sha，客户端打开当前版本
        }
      }
      let diff: string | null = null;
      if (isTextKind(kind)) {
        if (change) diff = diffs.get(rel) || null;
        // 没基线，或被 gitignore 的新文件不在基线比较范围里：退回工作区对照，限量
        else if ((!base || inBase === false) && fallbackLeft > 0 && !overBudget()) {
          fallbackLeft -= 1;
          diff = input.fallbackDiff(rel);
        }
      }
      if (!change && inBase == null && diff && /^new file/m.test(diff)) row.op = "added";
      if (isTextKind(kind) && diff) {
        try {
          const stored = storeArtifact(stateDir, Buffer.from(capDiff(diff), "utf8"));
          row.diffSha = stored.sha;
        } catch {
          // 对照文本存不下就只给文件快照
        }
      }
      if (row.added == null && diff) {
        const counted = countDiffLines(diff);
        row.added = counted.added;
        row.removed = counted.removed;
      }
      files.push(row);
    }
    return files;
  } finally {
    base?.close();
    try {
      checkArtifactQuota(stateDir, input.quota?.max, input.quota?.target);
    } catch {
      // 配额下次再收
    }
  }
}
