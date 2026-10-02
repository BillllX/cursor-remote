import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfineError, resolveInside } from "../confine.ts";
import type { ToolResult, ToolSpec } from "../types.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "coverage", ".venv", "venv", "__pycache__", ".turbo"]);
const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function fail(content: string): ToolResult {
  return { ok: false, content };
}

function isBinary(buf: Buffer) {
  const head = buf.subarray(0, 8000);
  return head.includes(0);
}

/** 遍历工作区文件（跳过依赖和构建目录），返回相对 base 的路径。不跟随符号链接，避免逃出工作区或成环 */
export function walk(base: string, limit = 20_000): string[] {
  const out: string[] = [];
  const stack = [base];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) stack.push(abs);
      } else if (st.isFile()) {
        out.push(relative(base, abs).split("\\").join("/"));
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/** 只读前 max 字节，大文件不整块进内存 */
function readHead(abs: string, max: number): Buffer {
  const fd = openSync(abs, constants.O_RDONLY);
  try {
    const buf = Buffer.alloc(max);
    let total = 0;
    while (total < max) {
      const n = readSync(fd, buf, total, max - total, null);
      if (!n) break;
      total += n;
    }
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/**
 * 写入前再校验一次：父目录真实路径仍在工作区内，目标不是符号链接也不是多链接文件，
 * 打开时带 O_NOFOLLOW。缩小校验与写入之间被替换路径的窗口。
 */
function safeWrite(cwd: string, raw: unknown, content: string) {
  const first = resolveInside(cwd, raw, { write: true });
  mkdirSync(dirname(first.abs), { recursive: true });
  const { abs, rel } = resolveInside(cwd, raw, { write: true });
  if (abs !== first.abs) throw new ConfineError(`路径在校验后发生变化：${rel}`);
  if (existsSync(abs) || isDanglingLink(abs)) {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new ConfineError(`不写符号链接：${rel}`);
    if (st.isFile() && st.nlink > 1) throw new ConfineError(`不写有多个硬链接的文件：${rel}`);
  }
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    const buf = Buffer.from(content);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
  return { abs, rel };
}

function isDanglingLink(abs: string) {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/** glob → 正则：支持 **、*、?、{a,b}。不带 / 的模式匹配任意层级的文件名 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\.\//, "");
  if (!p.includes("/")) p = `**/${p}`;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      re += `(?:${p
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

let rgPath: string | null | undefined;

/** 冒烟测试切换 rg / JS 两条路径用 */
export function setRgPathForTest(path: string | null | undefined) {
  rgPath = path;
}

/** 优先 PATH 上的 rg，其次 @cursor/sdk 自带的那份；都没有就走 JS 扫描 */
function findRg(): string | null {
  if (rgPath !== undefined) return rgPath;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    ...(process.env.PATH || "").split(":").filter(Boolean).map((dir) => join(dir, "rg")),
    resolve(here, "../../../../node_modules/@cursor/sdk-linux-x64/bin/rg"),
    resolve(here, "../../../node_modules/@cursor/sdk-linux-x64/bin/rg"),
    resolve(here, "../../../../node_modules/@cursor/sdk-darwin-arm64/bin/rg"),
  ];
  rgPath = candidates.find((path) => existsSync(path)) || null;
  return rgPath;
}

function runRg(args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(findRg()!, args, { cwd, maxBuffer: 4_000_000, timeout: 20_000, signal }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 2) : 0;
      if (err && code !== 1 && !stdout) {
        reject(err);
        return;
      }
      resolvePromise({ code, out: stdout });
    });
  });
}

const readFile: ToolSpec = {
  name: "read_file",
  category: "read",
  description:
    "读取工作区里的文本文件，返回带行号的内容（格式 `行号|内容`）。大文件用 offset/limit 分段读。改文件前先读。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作区的路径" },
      offset: { type: "integer", description: "起始行号，从 1 开始" },
      limit: { type: "integer", description: "最多读多少行，默认 2000" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const { abs, rel } = resolveInside(ctx.cwd, args.path);
    if (!existsSync(abs)) return fail(`文件不存在：${rel}`);
    const st = statSync(abs);
    if (st.isDirectory()) return fail(`${rel} 是目录，用 list_dir`);
    const buf = readHead(abs, MAX_READ_BYTES);
    if (isBinary(buf)) return fail(`${rel} 是二进制文件（${st.size} 字节）`);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const start = num(args.offset, 1);
    const limit = num(args.limit, DEFAULT_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return { ok: true, content: lines.length <= 1 && !text ? "（空文件）" : `超出范围：文件共 ${lines.length} 行` };
    const width = String(start + slice.length).length;
    const body = slice
      .map((line, i) => {
        const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        return `${String(start + i).padStart(width, " ")}|${clipped}`;
      })
      .join("\n");
    const more = start - 1 + slice.length < lines.length ? `\n…（共 ${lines.length} 行，用 offset 继续读）` : "";
    const truncated = st.size > MAX_READ_BYTES ? `\n…（文件 ${st.size} 字节，只读了前 ${MAX_READ_BYTES} 字节）` : "";
    return { ok: true, content: body + more + truncated };
  },
};

const listDir: ToolSpec = {
  name: "list_dir",
  category: "read",
  description: "列出目录内容。目录名以 / 结尾。默认列工作区根目录。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "相对工作区的目录，默认 ." } },
  },
  async run(args, ctx) {
    const { abs, rel } = resolveInside(ctx.cwd, args.path || ".");
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return fail(`不是目录：${rel || "."}`);
    const rows: string[] = [];
    for (const name of readdirSync(abs).sort()) {
      if (name === ".git") continue;
      let st;
      try {
        st = statSync(join(abs, name));
      } catch {
        continue;
      }
      rows.push(st.isDirectory() ? `${name}/` : `${name}  (${st.size} B)`);
      if (rows.length >= 500) {
        rows.push("…（超过 500 项，已截断）");
        break;
      }
    }
    return { ok: true, content: rows.length ? rows.join("\n") : "（空目录）" };
  },
};

const glob: ToolSpec = {
  name: "glob",
  category: "read",
  description: "按 glob 模式找文件，例如 `**/*.ts`、`src/**/index.{js,ts}`。跳过 node_modules、.git、构建目录。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "在哪个子目录下找，默认工作区根目录" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const pattern = str(args.pattern);
    if (!pattern) return fail("缺 pattern");
    const { abs, rel } = resolveInside(ctx.cwd, args.path || ".");
    const re = globToRegExp(pattern);
    const hits = walk(abs).filter((path) => re.test(path));
    const prefix = rel ? `${rel}/` : "";
    const shown = hits.slice(0, 500).map((path) => prefix + path);
    if (!shown.length) return { ok: true, content: "没有匹配的文件" };
    return { ok: true, content: shown.join("\n") + (hits.length > 500 ? `\n…（共 ${hits.length} 个，只列前 500）` : "") };
  },
};

const grep: ToolSpec = {
  name: "grep",
  category: "read",
  description:
    "用正则在工作区文件里搜索内容，返回 `路径:行号:内容`。可用 glob 限定文件类型，例如 `*.ts`。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "搜索的子目录或文件，默认工作区根目录" },
      glob: { type: "string", description: "只搜匹配的文件，例如 *.tsx" },
      ignore_case: { type: "boolean" },
      max_results: { type: "integer", description: "默认 200" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const pattern = str(args.pattern);
    if (!pattern) return fail("缺 pattern");
    const { abs, rel } = resolveInside(ctx.cwd, args.path || ".");
    const max = Math.min(num(args.max_results, 200), 1000);
    const fileGlob = str(args.glob);
    const ignoreCase = args.ignore_case === true;
    if (!existsSync(abs)) return fail(`路径不存在：${rel}`);
    const isDir = statSync(abs).isDirectory();
    const root = resolveInside(ctx.cwd, ".").abs;
    const lines: string[] = [];
    if (findRg()) {
      const rgArgs = ["-n", "--with-filename", "--no-heading", "--color", "never", "--hidden", "--max-columns", "400", "--max-filesize", "1M"];
      for (const dir of SKIP_DIRS) rgArgs.push("--glob", `!${dir}/**`);
      if (fileGlob) rgArgs.push("--glob", fileGlob);
      if (ignoreCase) rgArgs.push("-i");
      rgArgs.push("--", pattern, rel || ".");
      try {
        const { out } = await runRg(rgArgs, root, ctx.signal);
        for (const row of out.split("\n")) {
          if (!row) continue;
          lines.push(row.replace(/^\.\//, ""));
          if (lines.length >= max) break;
        }
        return { ok: true, content: lines.length ? lines.join("\n") : "没有匹配" };
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
      }
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (err) {
      return fail(`正则不合法：${(err as Error).message}`);
    }
    const prefix = rel ? `${rel}/` : "";
    const files = isDir
      ? walk(abs).map((p) => ({ abs: join(abs, p), shown: prefix + p, local: p }))
      : [{ abs, shown: rel, local: rel.split("/").pop() || rel }];
    const filter = fileGlob ? globToRegExp(fileGlob) : null;
    for (const file of files) {
      if (filter && !filter.test(file.local)) continue;
      let buf: Buffer;
      try {
        if (statSync(file.abs).size > 1_000_000) continue;
        buf = readFileSync(file.abs);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const rows = buf.toString("utf8").split("\n");
      for (let i = 0; i < rows.length; i++) {
        if (!re.test(rows[i])) continue;
        lines.push(`${file.shown}:${i + 1}:${rows[i].slice(0, 400)}`);
        if (lines.length >= max) break;
      }
      if (lines.length >= max) break;
    }
    return { ok: true, content: lines.length ? lines.join("\n") : "没有匹配" };
  },
};

function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

const editFile: ToolSpec = {
  name: "edit_file",
  category: "write",
  description:
    "精确替换文件里的一段文本。old_string 必须和文件内容逐字一致（含缩进），且在文件里唯一；不唯一时多带几行上下文，或设 replace_all。新建文件用 write_file。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "要被替换的原文" },
      new_string: { type: "string", description: "替换后的文本" },
      replace_all: { type: "boolean", description: "替换所有出现的位置" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(args, ctx) {
    const { abs, rel } = resolveInside(ctx.cwd, args.path, { write: true });
    const oldString = str(args.old_string);
    const newString = str(args.new_string);
    if (!existsSync(abs)) return fail(`文件不存在：${rel}。新建请用 write_file`);
    if (!oldString) return fail("old_string 不能为空");
    if (oldString === newString) return fail("old_string 和 new_string 相同，没有要改的");
    const st = statSync(abs);
    if (!st.isFile()) return fail(`${rel} 不是文件`);
    if (st.size > MAX_WRITE_BYTES) return fail(`${rel} 超过 2MB，不能用 edit_file 改`);
    const text = readFileSync(abs, "utf8");
    const count = countOccurrences(text, oldString);
    if (count === 0) {
      const trimmed = oldString.trim();
      const hint = trimmed && text.includes(trimmed) ? "去掉首尾空白后能找到，检查缩进和换行。" : "先用 read_file 读出原文再复制。";
      return fail(`在 ${rel} 里找不到 old_string。${hint}`);
    }
    if (count > 1 && args.replace_all !== true) {
      return fail(`old_string 在 ${rel} 里出现了 ${count} 次。多带几行上下文让它唯一，或设 replace_all: true。`);
    }
    const next = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
    if (Buffer.byteLength(next) > MAX_WRITE_BYTES) return fail("改完超过 2MB，拒绝写入");
    safeWrite(ctx.cwd, args.path, next);
    const delta = next.split("\n").length - text.split("\n").length;
    return {
      ok: true,
      content: `已修改 ${rel}（替换 ${args.replace_all === true ? count : 1} 处，行数 ${delta >= 0 ? "+" : ""}${delta}）`,
      changed: [rel],
    };
  },
};

const writeFile: ToolSpec = {
  name: "write_file",
  category: "write",
  description: "写入整个文件（不存在就新建，父目录自动创建；存在就整体覆盖）。改已有文件的一小段优先用 edit_file。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const { abs, rel } = resolveInside(ctx.cwd, args.path, { write: true });
    const content = str(args.content);
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return fail("内容超过 2MB，拒绝写入");
    if (existsSync(abs) && statSync(abs).isDirectory()) return fail(`${rel} 是目录`);
    const existed = existsSync(abs);
    safeWrite(ctx.cwd, args.path, content);
    return {
      ok: true,
      content: `${existed ? "已覆盖" : "已新建"} ${rel}（${content.split("\n").length} 行）`,
      changed: [rel],
    };
  },
};

const deleteFile: ToolSpec = {
  name: "delete_file",
  category: "write",
  description: "删除工作区里的一个文件（不能删目录）。",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async run(args, ctx) {
    const { abs, rel } = resolveInside(ctx.cwd, args.path, { write: true });
    if (!existsSync(abs)) return fail(`文件不存在：${rel}`);
    if (!statSync(abs).isFile()) return fail(`${rel} 不是文件`);
    unlinkSync(abs);
    return { ok: true, content: `已删除 ${rel}`, changed: [rel] };
  },
};

export const fsTools: ToolSpec[] = [readFile, listDir, glob, grep, editFile, writeFile, deleteFile];
