import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isInside, relEscapes } from "../pathInside.ts";

export const KB_MANIFEST_REL_PATH = ".jiebo/kb.json";
export const KB_POLICY_DOC_REL_PATH = "归档说明.md";
export const KB_INGEST_LOG_REL_PATH = ".jiebo/ingest-log.jsonl";
export const KB_INBOX_REL_DIR = ".cursor-remote/uploads/inbox";
export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ALLOWED_FILE_BYTES = 32 * 1024 * 1024;
export const MIN_ALLOWED_FILE_BYTES = 1024;

export const DEFAULT_ALLOWED_EXTS = [
  ".xlsx",
  ".xls",
  ".csv",
  ".pdf",
  ".docx",
  ".doc",
  ".md",
  ".txt",
  ".sql",
  ".pptx",
  ".ppt",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
] as const;

/**
 * 严禁作为上传/归档文档扩展名的危险后缀（含脚本、可执行文件、网页脚本载体与启动器）。
 * 注意：.html / .htm / .svg 仅能通过专用 HTML 演进工具更新同名看板，绝不允许作为外部上传或普通归档文件。
 */
export const BLOCKED_EXECUTABLE_EXTS = new Set([
  ".exe",
  ".sh",
  ".bash",
  ".zsh",
  ".ksh",
  ".fish",
  ".csh",
  ".tcsh",
  ".bat",
  ".cmd",
  ".command",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".js",
  ".mjs",
  ".cjs",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".scr",
  ".com",
  ".pif",
  ".lnk",
  ".url",
  ".dll",
  ".so",
  ".dylib",
  ".msi",
  ".msp",
  ".apk",
  ".ipa",
  ".jar",
  ".war",
  ".class",
  ".py",
  ".pyc",
  ".pyo",
  ".pyw",
  ".rb",
  ".php",
  ".php3",
  ".php4",
  ".php5",
  ".phtml",
  ".phar",
  ".pl",
  ".pm",
  ".cgi",
  ".lua",
  ".desktop",
  ".app",
  ".action",
  ".workflow",
  ".run",
  ".bin",
  ".elf",
  ".wasm",
  ".html",
  ".htm",
  ".xhtml",
  ".shtml",
  ".svg",
  ".xml",
  ".xsl",
]);

/** 保留的特殊文件名（不区分大小写，禁止作为普通归档文件写入任意目录） */
export const RESERVED_ARCHIVE_FILE_NAMES = new Set(["归档说明.md", "agents.md", "claude.md"]);

export type KbWorkspaceConfig = {
  version: 1;
  kind: "knowledge_base";
  title: string;
  allowedCategories: string[];
  maxFileBytes: number;
  allowedExts: string[];
};

export type KbValidationResult =
  { ok: true; config: KbWorkspaceConfig; workspaceRealPath: string } | { ok: false; error: string };

/** 检查字符串是否包含控制字符（0x00-0x1F, 0x7F） */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 校验单个路径段（目录名或文件名）是否安全 */
export function isValidPathSegment(segment: string): boolean {
  if (!segment || segment.length > 180) return false;
  if (segment !== segment.trim()) return false;
  if (segment === "." || segment === "..") return false;
  if (hasControlChars(segment)) return false;
  if (/[/\\:]/.test(segment)) return false;
  return true;
}

/** 校验一级分类目录名：非空、单层目录、不以点开头、不含斜杠或控制字符 */
export function isValidCategoryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80 || name !== trimmed) return false;
  if (trimmed.startsWith(".")) return false;
  return isValidPathSegment(trimmed);
}

/** 规范化文件扩展名（转小写，确保以 . 开头） */
export function normalizeExt(ext: string): string | null {
  const clean = ext.trim().toLowerCase();
  if (!clean) return null;
  const withDot = clean.startsWith(".") ? clean : `.${clean}`;
  if (!/^\.[a-z0-9]{1,16}$/.test(withDot)) return null;
  if (BLOCKED_EXECUTABLE_EXTS.has(withDot)) return null;
  return withDot;
}

/** 提取文件名的最后一段扩展名（转小写） */
export function fileExtension(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

/** 提取文件名中所有点号分段扩展名（例如 "report.sh.pdf" -> [".sh", ".pdf"]） */
export function allFileExtensions(fileName: string): string[] {
  const base = fileName.split(/[/\\]/).pop() || "";
  const parts = base.split(".");
  if (parts.length <= 1) return [];
  const exts: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].toLowerCase();
    if (seg) exts.push(`.${seg}`);
  }
  return exts;
}

/** 校验文件名是否允许上传或归档（拒绝首尾空白或控制字符） */
export function isAllowedUploadFileName(
  fileName: string,
  config: KbWorkspaceConfig,
): { ok: true; ext: string; normalizedName: string } | { ok: false; error: string } {
  if (!isValidPathSegment(fileName) || fileName.startsWith(".")) {
    return { ok: false, error: "文件名包含非法字符、首尾空白或以点开头" };
  }
  if (RESERVED_ARCHIVE_FILE_NAMES.has(fileName.toLowerCase())) {
    return { ok: false, error: `文件名 "${fileName}" 为系统保留规范文件，禁止覆盖或归档` };
  }
  const ext = fileExtension(fileName);
  if (!ext) {
    return { ok: false, error: "文件缺少扩展名" };
  }
  const allExts = allFileExtensions(fileName);
  for (const subExt of allExts) {
    if (BLOCKED_EXECUTABLE_EXTS.has(subExt)) {
      return { ok: false, error: `禁止上传包含可执行、脚本或网页后缀的文件（${subExt}）` };
    }
  }
  if (!config.allowedExts.includes(ext)) {
    return { ok: false, error: `不支持的文件格式（${ext}），允许格式：${config.allowedExts.join(" ")}` };
  }
  return { ok: true, ext, normalizedName: fileName };
}

/**
 * 校验从工作区根到目标相对路径的每一级路径段：
 * 1. 拒绝原始路径中含 `..`、`.`、空段或控制字符；
 * 2. 直接对每一级调用 `lstatSync`（不先调 `existsSync`，从而精准拦截悬空符号链接与符号链接环）；
 * 3. 中间已存在段必须是真实目录，最后一段若已存在必须是真实普通文件（nlink === 1）或真实目录。
 */
export function ensureSafePathInWorkspace(
  workspaceDir: string,
  relPath: string,
  opts: { expectLeaf?: "file" | "dir" | "any" } = {},
): { ok: true; absPath: string; normalizedRel: string; workspaceRealPath: string } | { ok: false; error: string } {
  try {
    let wsStat;
    try {
      wsStat = lstatSync(workspaceDir);
    } catch {
      return { ok: false, error: "目标工作区目录不存在" };
    }
    if (wsStat.isSymbolicLink() || !wsStat.isDirectory()) {
      return { ok: false, error: "工作区根目录不能是符号链接或非目录" };
    }
    const workspaceRealPath = realpathSync(workspaceDir);
    if (hasControlChars(relPath) || relPath !== relPath.trim()) {
      return { ok: false, error: "路径包含非法控制字符或首尾空白" };
    }
    const cleanRel = relPath.replace(/\\/g, "/");
    if (!cleanRel || cleanRel.startsWith("/")) {
      return { ok: false, error: "路径必须是非空工作区相对路径" };
    }
    const rawParts = cleanRel.split("/");
    if (rawParts.some((p) => !p || p === "." || p === ".." || !isValidPathSegment(p))) {
      return { ok: false, error: "路径包含非法层级段（空段、.、.. 或非法字符）" };
    }

    const absCandidate = resolve(workspaceRealPath, ...rawParts);
    const normalizedRel = relative(workspaceRealPath, absCandidate).replace(/\\/g, "/");
    if (!normalizedRel || relEscapes(normalizedRel)) {
      return { ok: false, error: "目标路径超出工作区边界" };
    }

    const expectLeaf = opts.expectLeaf || "any";
    let cursor = workspaceRealPath;
    for (let i = 0; i < rawParts.length; i++) {
      const part = rawParts[i];
      const isLast = i === rawParts.length - 1;
      cursor = resolve(cursor, part);

      let st;
      try {
        st = lstatSync(cursor);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          continue;
        }
        return { ok: false, error: `无法访问路径段 "${part}"：${code || "ERR"}` };
      }

      if (st.isSymbolicLink()) {
        return { ok: false, error: `路径包含符号链接（含悬空链接），拒绝访问：${part}` };
      }
      if (!isLast && !st.isDirectory()) {
        return { ok: false, error: `中间路径段不是目录：${part}` };
      }
      if (isLast) {
        if (expectLeaf === "file" && !st.isFile()) {
          return { ok: false, error: `目标路径已存在但不是普通文件：${part}` };
        }
        if (expectLeaf === "dir" && !st.isDirectory()) {
          return { ok: false, error: `目标路径已存在但不是目录：${part}` };
        }
        if (!st.isFile() && !st.isDirectory()) {
          return { ok: false, error: `目标路径不能是特殊设备、管道或套接字：${part}` };
        }
        if (st.isFile() && st.nlink > 1) {
          return { ok: false, error: `目标文件存在多个硬链接（nlink=${st.nlink}），拒绝访问：${part}` };
        }
      }
      const realCursor = realpathSync(cursor);
      if (!isInside(realCursor, workspaceRealPath)) {
        return { ok: false, error: "真实路径逃逸出当前工作区" };
      }
    }
    return { ok: true, absPath: absCandidate, normalizedRel, workspaceRealPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "路径安全校验失败" };
  }
}

/**
 * 同步安全创建工作区内目录层级，缩小校验与创建之间被替换路径的窗口：
 * 每一级先校验父目录无符号链接且真实路径在工作区内，再创建当前级并复核。
 */
export function safeMkdirInWorkspaceSync(
  workspaceDir: string,
  relDir: string,
): { ok: true; absDir: string; normalizedRel: string; workspaceRealPath: string } | { ok: false; error: string } {
  const first = ensureSafePathInWorkspace(workspaceDir, relDir, { expectLeaf: "dir" });
  if (!first.ok) return first;
  const parts = first.normalizedRel.split("/");
  let cursor = first.workspaceRealPath;
  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parentReal = realpathSync(cursor);
      if (!isInside(parentReal, first.workspaceRealPath)) {
        return { ok: false, error: `父目录已逃逸出工作区：${part}` };
      }
      cursor = resolve(parentReal, part);
      try {
        const st = lstatSync(cursor);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          return { ok: false, error: `目录段 "${part}" 是符号链接或非目录` };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          mkdirSync(cursor, { mode: 0o755 });
        } else {
          throw err;
        }
      }
      const stAfter = lstatSync(cursor);
      if (stAfter.isSymbolicLink() || !stAfter.isDirectory()) {
        return { ok: false, error: `目录段 "${part}" 创建后复核失败` };
      }
      const realCursor = realpathSync(cursor);
      if (!isInside(realCursor, first.workspaceRealPath)) {
        return { ok: false, error: `目录段 "${part}" 真实路径逃逸出工作区` };
      }
    }
    const second = ensureSafePathInWorkspace(workspaceDir, relDir, { expectLeaf: "dir" });
    if (!second.ok || second.absPath !== first.absPath) {
      return { ok: false, error: "目录路径在创建过程中发生变化" };
    }
    return {
      ok: true,
      absDir: second.absPath,
      normalizedRel: second.normalizedRel,
      workspaceRealPath: second.workspaceRealPath,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "创建安全目录失败" };
  }
}

/**
 * 同步安全写入工作区内文件（通过同目录隐藏临时文件 + O_CREAT|O_EXCL|O_NOFOLLOW 写入 + 复核父目录后原子 rename）：
 * 1. 严禁对目标路径直接调用 O_TRUNC（防止父目录并发替换时截断区外已有文件）；
 * 2. 在父目录内用 O_CREAT | O_EXCL | O_NOFOLLOW 创建随机隐藏临时文件并写入；
 * 3. 写入后通过 `/proc/self/fd/<fd>`（若存在）或全路径逐级复核临时文件及父目录仍在工作区内；
 * 4. 确认目标位置不是目录或符号链接后，执行同目录 rename 原子替换，并最终复核目标路径。
 */
export function safeWriteWorkspaceFileSync(
  workspaceDir: string,
  relPath: string,
  data: string | Buffer,
): { ok: true; absPath: string; normalizedRel: string; size: number } | { ok: false; error: string } {
  const first = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf: "file" });
  if (!first.ok) return first;
  const parentRel = dirname(first.normalizedRel);
  if (parentRel && parentRel !== ".") {
    const dirRes = safeMkdirInWorkspaceSync(workspaceDir, parentRel);
    if (!dirRes.ok) return dirRes;
  }
  const second = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf: "file" });
  if (!second.ok || second.absPath !== first.absPath) {
    return { ok: false, error: second.ok ? "路径在校验后发生变化" : second.error };
  }

  const tmpRel =
    parentRel && parentRel !== "."
      ? `${parentRel}/.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpAbs = resolve(second.workspaceRealPath, tmpRel);

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(tmpAbs, flags, 0o644);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink > 1) {
      return { ok: false, error: "临时文件句柄异常" };
    }
    try {
      const fdReal = realpathSync(`/proc/self/fd/${fd}`);
      if (!isInside(fdReal, second.workspaceRealPath) || fdReal !== tmpAbs) {
        return { ok: false, error: "文件描述符真实路径不在工作区内" };
      }
    } catch {
      const parentCheck = ensureSafePathInWorkspace(workspaceDir, parentRel && parentRel !== "." ? parentRel : ".");
      if (parentRel && parentRel !== "." && !parentCheck.ok) {
        return { ok: false, error: "临时文件父目录复核失败" };
      }
      const lstTmp = lstatSync(tmpAbs);
      if (lstTmp.dev !== fst.dev || lstTmp.ino !== fst.ino) {
        return { ok: false, error: "临时文件 inode 复核不一致" };
      }
    }
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }

    const third = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf: "file" });
    if (!third.ok || third.absPath !== second.absPath) {
      return { ok: false, error: third.ok ? "目标路径在写入期间发生变化" : third.error };
    }
    const lstBeforeRename = lstatSync(tmpAbs);
    if (lstBeforeRename.isSymbolicLink() || lstBeforeRename.dev !== fst.dev || lstBeforeRename.ino !== fst.ino) {
      return { ok: false, error: "临时文件在 rename 前发生变化" };
    }
    renameSync(tmpAbs, third.absPath);
    renamed = true;
    closeSync(fd);
    fd = undefined;

    const fourth = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf: "file" });
    if (!fourth.ok || fourth.absPath !== third.absPath) {
      return { ok: false, error: "文件写入后复核失败" };
    }
    return {
      ok: true,
      absPath: fourth.absPath,
      normalizedRel: fourth.normalizedRel,
      size: buf.length,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "安全写入文件失败" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmpAbs);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 使用 O_NOFOLLOW | O_NONBLOCK 安全读取工作区内小体积 UTF-8 文本文件，
 * 打开后复核 fstatSync 与再次 ensureSafePathInWorkspace 的 lstatSync (dev/ino) 一致，消除 TOCTOU 窗口。
 */
export function safeReadWorkspaceTextFileSync(
  workspaceDir: string,
  relPath: string,
  maxBytes = 256 * 1024,
): { ok: true; text: string; absPath: string } | { ok: false; error: string } {
  const first = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf: "file" });
  if (!first.ok) return first;
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
  let fd: number | undefined;
  try {
    fd = openSync(first.absPath, flags);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, error: "目标不是普通文件" };
    }
    if (st.nlink > 1) {
      return { ok: false, error: "目标文件存在硬链接，拒绝读取" };
    }
    const second = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf: "file" });
    if (!second.ok || second.absPath !== first.absPath) {
      return { ok: false, error: "路径在打开后复核不一致" };
    }
    const lst = lstatSync(second.absPath);
    if (lst.dev !== st.dev || lst.ino !== st.ino) {
      return { ok: false, error: "文件 inode 在打开后发生变化" };
    }
    if (st.size > maxBytes) {
      return { ok: false, error: `文件体积超过上限（${maxBytes} bytes）` };
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const bytesRead = readSync(fd, buf, offset, st.size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return { ok: true, text: buf.subarray(0, offset).toString("utf8"), absPath: second.absPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: `文件不存在：${relPath}` };
    return { ok: false, error: err instanceof Error ? err.message : "安全读取文件失败" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

const ALLOWED_KB_CONFIG_KEYS = new Set([
  "version",
  "kind",
  "title",
  "allowedCategories",
  "maxFileBytes",
  "allowedExts",
]);

/** 解析并严格校验 KbWorkspaceConfig 对象（显式传入非法字段或未知字段一律拒绝，不静默回退） */
export function parseKbWorkspaceConfig(
  raw: unknown,
): { ok: true; config: KbWorkspaceConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "kb.json 必须是 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KB_CONFIG_KEYS.has(key)) {
      return { ok: false, error: `kb.json 包含未知配置字段：${key}` };
    }
  }
  if (obj.version !== 1) {
    return { ok: false, error: "kb.json version 必须为 1" };
  }
  if (obj.kind !== "knowledge_base") {
    return { ok: false, error: "kb.json kind 必须为 knowledge_base" };
  }
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title || title.length > 120 || hasControlChars(title)) {
    return { ok: false, error: "kb.json title 必须为 1–120 字符且不含控制字符的非空字符串" };
  }
  if (
    !Array.isArray(obj.allowedCategories) ||
    obj.allowedCategories.length === 0 ||
    obj.allowedCategories.length > 50
  ) {
    return { ok: false, error: "kb.json allowedCategories 必须是非空分类数组（1–50 项）" };
  }
  const categories: string[] = [];
  const seenCat = new Set<string>();
  for (const item of obj.allowedCategories) {
    if (typeof item !== "string" || !isValidCategoryName(item)) {
      return { ok: false, error: `非法的一级分类目录名：${String(item)}` };
    }
    const clean = item.trim();
    if (!seenCat.has(clean)) {
      seenCat.add(clean);
      categories.push(clean);
    }
  }

  let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  if (obj.maxFileBytes !== undefined) {
    if (
      typeof obj.maxFileBytes !== "number" ||
      !Number.isInteger(obj.maxFileBytes) ||
      obj.maxFileBytes < MIN_ALLOWED_FILE_BYTES ||
      obj.maxFileBytes > MAX_ALLOWED_FILE_BYTES
    ) {
      return {
        ok: false,
        error: `kb.json maxFileBytes 必须是 ${MIN_ALLOWED_FILE_BYTES} 到 ${MAX_ALLOWED_FILE_BYTES} 之间的整数`,
      };
    }
    maxFileBytes = obj.maxFileBytes;
  }

  let allowedExts: string[] = [...DEFAULT_ALLOWED_EXTS];
  if (obj.allowedExts !== undefined) {
    if (!Array.isArray(obj.allowedExts) || obj.allowedExts.length === 0 || obj.allowedExts.length > 50) {
      return { ok: false, error: "kb.json allowedExts 若提供则必须是非空字符串数组（1–50 项）" };
    }
    const parsedExts: string[] = [];
    const seenExt = new Set<string>();
    for (const extItem of obj.allowedExts) {
      if (typeof extItem !== "string") {
        return { ok: false, error: "allowedExts 必须为字符串数组" };
      }
      const norm = normalizeExt(extItem);
      if (!norm) {
        return { ok: false, error: `不允许或非法的扩展名配置：${extItem}` };
      }
      if (!seenExt.has(norm)) {
        seenExt.add(norm);
        parsedExts.push(norm);
      }
    }
    allowedExts = parsedExts;
  }

  return {
    ok: true,
    config: {
      version: 1,
      kind: "knowledge_base",
      title,
      allowedCategories: categories,
      maxFileBytes,
      allowedExts,
    },
  };
}

/** 读取并验证某个工作区是否为合法的知识库工作区 */
export function loadKbWorkspaceConfig(workspaceDir: string, tenantWorkspaceRoot?: string): KbValidationResult {
  try {
    if (tenantWorkspaceRoot) {
      let rootStat;
      try {
        rootStat = lstatSync(tenantWorkspaceRoot);
      } catch {
        return { ok: false, error: "租户工作区根目录不存在" };
      }
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return { ok: false, error: "租户工作区根目录非法" };
      }
      const rootReal = realpathSync(tenantWorkspaceRoot);
      let wsStat;
      try {
        wsStat = lstatSync(workspaceDir);
      } catch {
        return { ok: false, error: "工作区目录不存在" };
      }
      if (wsStat.isSymbolicLink() || !wsStat.isDirectory()) {
        return { ok: false, error: "工作区目录不能是符号链接或非目录" };
      }
      const wsReal = realpathSync(workspaceDir);
      if (!isInside(wsReal, rootReal) || wsReal === rootReal) {
        return { ok: false, error: "目标工作区不在租户工作区根目录内" };
      }
    }
    const readRes = safeReadWorkspaceTextFileSync(workspaceDir, KB_MANIFEST_REL_PATH);
    if (!readRes.ok) {
      return { ok: false, error: readRes.error };
    }
    const parsed = JSON.parse(readRes.text) as unknown;
    const validated = parseKbWorkspaceConfig(parsed);
    if (!validated.ok) return validated;
    const workspaceRealPath = realpathSync(workspaceDir);
    return {
      ok: true,
      config: validated.config,
      workspaceRealPath,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "读取 .jiebo/kb.json 失败" };
  }
}

/**
 * 校验归档移动的目标相对路径是否合法：
 * 1. 必须位于工作区内且无符号链接（含悬空符号链接），若已存在则必须是普通文件（expectLeaf: "file"）；
 * 2. 第一级目录必须属于 kb.json 的 allowedCategories；
 * 3. 至少包含二级路径（即 <category>/<file> 或 <category>/<subDir>/<file>），且所有层级段合法；
 * 4. 严禁修改或覆盖 归档说明.md、AGENTS.md、.jiebo/*、.cursor/*、.cursor-remote/* 或任何 .html/.htm/.svg 文件。
 */
export function validateArchiveTargetRelPath(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  targetRelPath: string,
): { ok: true; absPath: string; normalizedRel: string; category: string } | { ok: false; error: string } {
  const safe = ensureSafePathInWorkspace(workspaceDir, targetRelPath, { expectLeaf: "file" });
  if (!safe.ok) return safe;
  const parts = safe.normalizedRel.split("/");
  if (parts.length < 2 || parts.length > 8) {
    return { ok: false, error: "归档目标路径必须位于一级分类目录内（2–8 层）" };
  }
  const [category, ...rest] = parts;
  if (!config.allowedCategories.includes(category)) {
    return {
      ok: false,
      error: `目标一级目录 "${category}" 不在白名单 [${config.allowedCategories.join(", ")}] 内`,
    };
  }
  if (rest.some((segment) => segment.startsWith(".") || !isValidPathSegment(segment))) {
    return { ok: false, error: "归档目标路径不能包含隐藏目录/文件或非法字符" };
  }
  const fileName = rest[rest.length - 1];
  const parentDirName = parts[parts.length - 2];
  if (fileName.toLowerCase() === `${parentDirName.toLowerCase()}.html`) {
    return { ok: false, error: "严禁通过归档移动覆盖目录同名 HTML 知识库看板" };
  }
  const extCheck = isAllowedUploadFileName(fileName, config);
  if (!extCheck.ok) return extCheck;
  return {
    ok: true,
    absPath: safe.absPath,
    normalizedRel: safe.normalizedRel,
    category,
  };
}

/**
 * 校验允许 AI 演进更新的知识库 HTML 路径：
 * 仅允许更新 <category>/<category>.html 或 <category>/<sub>/<sub>.html，且若已存在必须是普通文件（expectLeaf: "file"）。
 */
export function validateKbHtmlRelPath(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  htmlRelPath: string,
): { ok: true; absPath: string; normalizedRel: string; category: string } | { ok: false; error: string } {
  const safe = ensureSafePathInWorkspace(workspaceDir, htmlRelPath, { expectLeaf: "file" });
  if (!safe.ok) return safe;
  const parts = safe.normalizedRel.split("/");
  if (parts.length !== 2 && parts.length !== 3) {
    return {
      ok: false,
      error: "知识库 HTML 路径必须为 <分类>/<分类>.html 或 <分类>/<子目录>/<子目录>.html",
    };
  }
  const category = parts[0];
  if (!config.allowedCategories.includes(category)) {
    return {
      ok: false,
      error: `HTML 所属一级分类 "${category}" 不在白名单 [${config.allowedCategories.join(", ")}] 内`,
    };
  }
  if (parts.some((p) => p.startsWith(".") || !isValidPathSegment(p))) {
    return { ok: false, error: "HTML 路径不能包含隐藏目录/文件或非法控制字符" };
  }
  const parentDirName = parts[parts.length - 2];
  const expectedFileName = `${parentDirName}.html`;
  const actualFileName = parts[parts.length - 1];
  if (actualFileName !== expectedFileName) {
    return {
      ok: false,
      error: `知识库 HTML 文件名必须与所在目录同名（期望 "${expectedFileName}"，实际 "${actualFileName}"）`,
    };
  }
  return {
    ok: true,
    absPath: safe.absPath,
    normalizedRel: safe.normalizedRel,
    category,
  };
}

/** 初始化或更新知识库工作区的 .jiebo/kb.json 与分类目录（使用无 TOCTOU 的同步安全创建与写入） */
export function initKbWorkspaceConfig(
  workspaceDir: string,
  input: {
    title: string;
    allowedCategories: string[];
    maxFileBytes?: number;
    allowedExts?: string[];
  },
): KbValidationResult {
  const candidate = {
    version: 1 as const,
    kind: "knowledge_base" as const,
    title: input.title,
    allowedCategories: input.allowedCategories,
    ...(input.maxFileBytes !== undefined ? { maxFileBytes: input.maxFileBytes } : {}),
    ...(input.allowedExts !== undefined ? { allowedExts: input.allowedExts } : {}),
  };
  const validated = parseKbWorkspaceConfig(candidate);
  if (!validated.ok) return validated;

  for (const cat of validated.config.allowedCategories) {
    const dirRes = safeMkdirInWorkspaceSync(workspaceDir, cat);
    if (!dirRes.ok) return dirRes;
  }

  const writeRes = safeWriteWorkspaceFileSync(
    workspaceDir,
    KB_MANIFEST_REL_PATH,
    `${JSON.stringify(validated.config, null, 2)}\n`,
  );
  if (!writeRes.ok) return writeRes;

  return {
    ok: true,
    config: validated.config,
    workspaceRealPath: realpathSync(workspaceDir),
  };
}

/**
 * 校验知识库只读问答（QA）允许读取的工作区相对路径（纯白名单策略）：
 * 1. 允许读取工作区根目录下的《归档说明.md》；
 * 2. 允许读取 `kb.json` 的 `allowedCategories` 一级分类目录下的普通文件或目录（深度 ≤ 8 层）；
 * 3. 严禁任何层级包含以 `.` 开头的隐藏目录/文件（天然封死 `.jiebo/*`、`.cursor-remote/*`、`.git/*`、`.env` 等一切系统或未归档批次数据）；
 * 4. 严禁读取任意层级的 `AGENTS.md` 或 `CLAUDE.md`；
 * 5. 全程经 `ensureSafePathInWorkspace` 校验，拒绝符号链接（含悬空链接）与硬链接（`nlink > 1`）。
 */
export function validateKbQaReadableRelPath(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  relPath: string,
  expectLeaf: "file" | "dir" | "any" = "file",
): { ok: true; absPath: string; normalizedRel: string; category?: string } | { ok: false; error: string } {
  const safe = ensureSafePathInWorkspace(workspaceDir, relPath, { expectLeaf });
  if (!safe.ok) return safe;

  if (safe.normalizedRel === KB_POLICY_DOC_REL_PATH) {
    return {
      ok: true,
      absPath: safe.absPath,
      normalizedRel: safe.normalizedRel,
    };
  }

  const parts = safe.normalizedRel.split("/");
  if (parts.length < 1 || parts.length > 8) {
    return { ok: false, error: "知识库问答访问路径层级超出限制（1–8 层）" };
  }

  if (parts.some((segment) => segment.startsWith(".") || !isValidPathSegment(segment))) {
    return { ok: false, error: "禁止访问隐藏目录/文件或系统元数据目录" };
  }

  const category = parts[0];
  if (!config.allowedCategories.includes(category)) {
    return {
      ok: false,
      error: `仅允许读取知识库开放分类目录 [${config.allowedCategories.join(", ")}] 或 归档说明.md`,
    };
  }

  const leafLower = parts[parts.length - 1].toLowerCase();
  if (leafLower === "agents.md" || leafLower === "claude.md") {
    return { ok: false, error: "禁止读取系统代理指令文件" };
  }

  return {
    ok: true,
    absPath: safe.absPath,
    normalizedRel: safe.normalizedRel,
    category,
  };
}
