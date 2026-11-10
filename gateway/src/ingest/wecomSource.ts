import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { assistantPath, readJson, type TenantRef } from "../assistant/store.ts";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import { isInside } from "../pathInside.ts";
import {
  DEFAULT_MAX_FILE_BYTES,
  hasControlChars,
  isAllowedUploadFileName,
  loadKbWorkspaceConfig,
} from "./contract.ts";
import { submitDirectIngestBatch } from "./queue.ts";
import { MAX_FILES_PER_BATCH } from "./staging.ts";
import type { DropTenantHost } from "./tokens.ts";

export type WecomWatchSourceType = "sheet" | "smartsheet" | "doc" | "smartpage" | "disk_file";

export type WecomWatchedItem = {
  id: string;
  workspaceId: string;
  workspaceKeySnapshot: string;
  title: string;
  sourceType: WecomWatchSourceType;
  /** 企业微信文档 docid（如 e3_xxx）或文档 URL */
  docId?: string;
  /** 企业微信微盘文件 ID（如 fixxx） */
  fileId?: string;
  /** 可选，指定子表 ID 或名称（针对 sheet / smartsheet） */
  sheet?: string;
  /** 可选，指定读取范围（如 A1:Z500，不传默认读取全表已用区域） */
  range?: string;
  /** 可选，归档备注说明（例如提示归档到哪个主体分类） */
  note?: string;
  /** 上次同步或基线检查时的远端修改时间字符串 */
  lastSyncedUpdateTime?: string;
  /** 上次同步或基线检查时的内容 SHA-256 摘要 */
  lastSyncedSha256?: string;
  /** 上次同步时的内容预览摘要（前 600 字，便于做轻量 Diff 对比） */
  lastSnapshotPreview?: string;
  /** 上次成功归档入库的批次号 */
  lastBatchId?: string;
  /** 上次检查时间戳（ms） */
  lastCheckedAt?: number;
  /** 上次同步入库时间戳（ms） */
  lastSyncedAt?: number;
  createdAt: number;
};

type WecomWatchLedgerFile = {
  version: 1;
  items: WecomWatchedItem[];
};

export type WecomCliRunner = (
  args: string[],
  options?: { configDir: string; timeoutMs?: number; outputDir?: string },
) => Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; parsed?: Record<string, unknown> }>;

const WATCH_LEDGER_FILENAME = "wecom-watch-ledger.json";
const MAX_WATCHED_ITEMS_PER_TENANT = 200;
const DEFAULT_CLI_TIMEOUT_MS = 45_000;
const MAX_CLI_STDOUT_BYTES = 24 * 1024 * 1024;

/** 进程内按关注项 ID 的异步单飞锁，避免并发重复拉取与重复入库 */
const inFlightItemSync = new Set<string>();

export function wecomConfigDirForTenant(host: TenantRef): string {
  const dir = assistantPath(host, "wecom-cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function ledgerFilePath(host: TenantRef): string {
  return assistantPath(host, WATCH_LEDGER_FILENAME);
}

function lockFilePath(host: TenantRef): string {
  return assistantPath(host, `${WATCH_LEDGER_FILENAME}.lock`);
}

function readWatchLedger(host: TenantRef): WecomWatchLedgerFile {
  const raw = readJson<Partial<WecomWatchLedgerFile>>(ledgerFilePath(host), { version: 1, items: [] });
  const items = Array.isArray(raw?.items) ? raw.items.filter((x): x is WecomWatchedItem => Boolean(x && x.id)) : [];
  return { version: 1, items };
}

function writeWatchLedger(host: TenantRef, file: WecomWatchLedgerFile): void {
  atomicWriteFileSync(ledgerFilePath(host), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

function stripContextTagsFromText(text: string): string {
  return text
    .replace(/<extra_identity_context>[\s\S]*?<\/extra_identity_context>/gi, "")
    .replace(/<security_notice>[\s\S]*?<\/security_notice>/gi, "")
    .trim();
}

/** 递归剥离 wecom-cli 返回体中的内部上下文敏感染色字段 */
export function sanitizeWecomCliPayload<T>(input: T): T {
  if (typeof input === "string") {
    return stripContextTagsFromText(input) as unknown as T;
  }
  if (!input || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeWecomCliPayload(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "extra_identity_context" || k === "security_notice") continue;
    out[k] = sanitizeWecomCliPayload(v);
  }
  return out as T;
}

/** 校验企业微信资源标识符（docId / fileId / mailId / mediaId），严防前导 `-` 触发 CLI Option Injection */
export function isValidWecomResourceId(raw: string, maxLen = 512): boolean {
  const s = raw.trim();
  if (!s || s.length > maxLen) return false;
  if (s.startsWith("-") || hasControlChars(s) || /\s/.test(s)) return false;
  return true;
}

/** 清理搜索词或名称参数，防前导 `-` 被识别为 CLI 开关 */
function sanitizeCliOptionValue(raw: string, maxLen = 200): string {
  const trimmed = raw.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, maxLen);
  return trimmed.replace(/^-+/, "").trim();
}

/**
 * 安全读取受控临时目录中的下载产物：
 * 1. 若 CLI 返回了 candidatePath，强制要求其 realpath 必须位于 realpath(tempDir) 内部；
 * 2. 强制 lstatSync 检查为普通文件、非符号链接、nlink === 1，且 0 < size <= maxBytes。
 */
export function readSafeDownloadedFileSync(
  tempDir: string,
  candidatePath: string | undefined,
  maxBytes: number,
): { ok: true; filePath: string; fileName: string; data: Buffer } | { ok: false; error: string } {
  let realTempDir: string;
  try {
    realTempDir = realpathSync(tempDir);
  } catch {
    return { ok: false, error: "临时下载目录不存在或不可访问" };
  }

  let targetPath = "";
  if (candidatePath && candidatePath.trim()) {
    const resolvedCandidate = resolve(tempDir, candidatePath.trim());
    if (!isInside(resolvedCandidate, realTempDir) && !isInside(resolvedCandidate, resolve(tempDir))) {
      return { ok: false, error: "拒绝读取受控下载目录之外的文件路径" };
    }
    if (existsSync(resolvedCandidate)) {
      targetPath = resolvedCandidate;
    }
  }

  if (!targetPath) {
    try {
      const entries = readdirSync(realTempDir).filter((name) => !name.startsWith("."));
      if (entries.length > 0) {
        targetPath = join(realTempDir, entries[0]);
      }
    } catch {
      // ignore
    }
  }

  if (!targetPath || !existsSync(targetPath)) {
    return { ok: false, error: "未在受控临时目录中产出下载文件" };
  }

  try {
    const st = lstatSync(targetPath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
      return { ok: false, error: "下载产物不是安全的普通单链接文件" };
    }
    const realFile = realpathSync(targetPath);
    if (!isInside(realFile, realTempDir)) {
      return { ok: false, error: "下载产物真实路径越出受控临时目录" };
    }
    if (st.size <= 0) {
      return { ok: false, error: "下载文件为空文件" };
    }
    if (st.size > maxBytes) {
      return { ok: false, error: `文件体积（${st.size} bytes）超过单文件上限（${maxBytes} bytes）` };
    }
    const data = readFileSync(realFile);
    return {
      ok: true,
      filePath: realFile,
      fileName: basename(realFile),
      data,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "读取下载文件失败" };
  }
}

function resolveWecomCliBin(): string {
  const candidates = [
    process.env.WECOM_CLI_BIN,
    "/var/lib/cursor-remote/.local/bin/wecom-cli",
    "/usr/local/bin/wecom-cli",
    "/usr/bin/wecom-cli",
  ].filter((x): x is string => Boolean(x && x.trim()));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "wecom-cli";
}

/** 默认的 wecom-cli 子进程执行器（无 shell 注入，固定 env 隔离租户凭证目录，超限立即终止） */
export const defaultWecomCliRunner: WecomCliRunner = async (args, options) => {
  const bin = resolveWecomCliBin();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const finalArgs = [...args];
  if (options?.outputDir) {
    finalArgs.push("--output-dir", options.outputDir);
  }

  return await new Promise((resolveRun) => {
    const child = spawn(bin, finalArgs, {
      env: {
        ...process.env,
        PATH: `/var/lib/cursor-remote/.local/bin:/opt/node-v22/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
        WECOM_CLI_CONFIG_DIR: options?.configDir || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_CLI_STDOUT_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_CLI_STDOUT_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({
        ok: false,
        exitCode: 127,
        stdout: "",
        stderr: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = stripContextTagsFromText(Buffer.concat(stdoutChunks).toString("utf8"));
      const stderr = stripContextTagsFromText(Buffer.concat(stderrChunks).toString("utf8"));
      if (overflowed) {
        resolveRun({
          ok: false,
          exitCode: 137,
          stdout: "",
          stderr: `wecom-cli 输出体积超过上限（>${MAX_CLI_STDOUT_BYTES} bytes）`,
        });
        return;
      }
      if (timedOut) {
        resolveRun({
          ok: false,
          exitCode: 124,
          stdout,
          stderr: stderr || `wecom-cli 调用超时（>${timeoutMs}ms）`,
        });
        return;
      }

      let parsed: Record<string, unknown> | undefined;
      if (stdout.startsWith("{") && stdout.endsWith("}")) {
        try {
          const obj = JSON.parse(stdout) as unknown;
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            parsed = sanitizeWecomCliPayload(obj as Record<string, unknown>);
          }
        } catch {
          // non-json stdout
        }
      }

      const apiErrCode =
        parsed && typeof parsed.errcode === "number" && parsed.errcode !== 0
          ? parsed.errcode
          : parsed?.error &&
              typeof parsed.error === "object" &&
              typeof (parsed.error as Record<string, unknown>).code === "number"
            ? Number((parsed.error as Record<string, unknown>).code)
            : 0;

      const ok = code === 0 && apiErrCode === 0;
      resolveRun({
        ok,
        exitCode: code ?? 1,
        stdout,
        stderr,
        parsed,
      });
    });
  });
};

let activeRunner: WecomCliRunner = defaultWecomCliRunner;

/** 供单元测试注入 Mock wecom-cli 执行器 */
export function setWecomCliRunnerForTest(runner: WecomCliRunner | null): void {
  activeRunner = runner ?? defaultWecomCliRunner;
}

export async function getWecomAuthStatus(host: TenantRef): Promise<{
  ok: boolean;
  authorized: boolean;
  botId?: string;
  rawOutput: string;
}> {
  const configDir = wecomConfigDirForTenant(host);
  const res = await activeRunner(["auth", "show"], { configDir, timeoutMs: 10_000 });
  const text = `${res.stdout}\n${res.stderr}`.trim();
  const authorized = /Status:\s*authorized/i.test(text) || text === "authorized";
  const botMatch = /Bot ID:\s*(\S+)/i.exec(text);
  return {
    ok: res.exitCode === 0,
    authorized,
    botId: botMatch?.[1],
    rawOutput: text,
  };
}

/**
 * 检索企业微信中的最近文件、文档/表格或邮件
 */
export async function searchWecomResources(
  host: TenantRef,
  input: {
    scope: "recent_files" | "doc_search" | "disk_search" | "mail_search" | "mail_get";
    keyword?: string;
    limit?: number;
    onlyUnread?: boolean;
    hasAttachments?: boolean;
    mailId?: string;
  },
): Promise<{ ok: boolean; scope: string; data?: Record<string, unknown>; error?: string }> {
  const configDir = wecomConfigDirForTenant(host);
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));
  const kw = sanitizeCliOptionValue(input.keyword || "");

  if (input.scope === "recent_files") {
    const res = await activeRunner(["disk", "files", "list", "--limit", String(limit)], { configDir });
    if (!res.ok) return { ok: false, scope: input.scope, error: extractCliError(res) };
    return { ok: true, scope: input.scope, data: res.parsed ?? { raw: res.stdout } };
  }

  if (input.scope === "doc_search") {
    if (!kw) return { ok: false, scope: input.scope, error: "doc_search 必须提供有效的 keyword 搜索关键词" };
    const res = await activeRunner(["doc", "search", `--keywords=${kw}`, "--limit", String(limit)], { configDir });
    if (!res.ok) return { ok: false, scope: input.scope, error: extractCliError(res) };
    return { ok: true, scope: input.scope, data: res.parsed ?? { raw: res.stdout } };
  }

  if (input.scope === "disk_search") {
    if (!kw) return { ok: false, scope: input.scope, error: "disk_search 必须提供有效的 keyword 搜索关键词" };
    const res = await activeRunner(["disk", "files", "search", `--keywords=${kw}`, "--limit", String(limit)], {
      configDir,
    });
    if (!res.ok) return { ok: false, scope: input.scope, error: extractCliError(res) };
    return { ok: true, scope: input.scope, data: res.parsed ?? { raw: res.stdout } };
  }

  if (input.scope === "mail_search") {
    const args = ["mail", "search", "--limit", String(limit)];
    if (kw) args.push(`--keywords=${kw}`);
    if (input.onlyUnread) args.push("--only-unread");
    if (input.hasAttachments) args.push("--has-attachments");
    const res = await activeRunner(args, { configDir });
    if (!res.ok) return { ok: false, scope: input.scope, error: extractCliError(res) };
    return { ok: true, scope: input.scope, data: res.parsed ?? { raw: res.stdout } };
  }

  if (input.scope === "mail_get") {
    const mailId = (input.mailId || "").trim();
    if (!isValidWecomResourceId(mailId, 256)) {
      return { ok: false, scope: input.scope, error: "mail_get 必须提供合法的 mailId（不可为空或以 - 开头）" };
    }
    const tempDir = join(tmpdir(), `jiebo-wecom-mailget-${Date.now()}-${randomBytes(4).toString("hex")}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    try {
      const res = await activeRunner(["mail", "get", `--mail-ids=${mailId}`], { configDir, outputDir: tempDir });
      if (!res.ok) return { ok: false, scope: input.scope, error: extractCliError(res) };
      return { ok: true, scope: input.scope, data: res.parsed ?? { raw: res.stdout } };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  return { ok: false, scope: input.scope, error: `不支持的查询范围: ${String(input.scope)}` };
}

function extractCliError(res: { stdout: string; stderr: string; parsed?: Record<string, unknown> }): string {
  if (res.parsed) {
    if (typeof res.parsed.errmsg === "string" && res.parsed.errmsg && res.parsed.errmsg !== "ok") {
      return `企业微信接口错误 (${String(res.parsed.errcode ?? "")}): ${res.parsed.errmsg}`;
    }
    if (res.parsed.error && typeof res.parsed.error === "object") {
      const errObj = res.parsed.error as Record<string, unknown>;
      return `企业微信接口错误 (${String(errObj.code ?? "")}): ${String(errObj.message ?? "未知错误")}`;
    }
  }
  return res.stderr || res.stdout || "调用 wecom-cli 失败";
}

function resolveKbWorkspaceStrict(
  host: DropTenantHost,
  workspaceKeyOrId: string,
):
  | { ok: true; workspaceId: string; key: string; path: string; title: string; maxFileBytes: number }
  | { ok: false; error: string } {
  const target = workspaceKeyOrId.trim();
  if (!target) return { ok: false, error: "请指定知识库工作区名称（如 Fintopia集团）" };
  const resolved = host.resolveWorkspace(target);
  if (!resolved) return { ok: false, error: `未找到工作区 "${target}"` };
  const kbCheck = loadKbWorkspaceConfig(resolved.path, host.workspaceRoot);
  if (!kbCheck.ok) return { ok: false, error: kbCheck.error };
  return {
    ok: true,
    workspaceId: resolved.workspaceId,
    key: resolved.key,
    path: kbCheck.workspaceRealPath,
    title: kbCheck.config.title,
    maxFileBytes: kbCheck.config.maxFileBytes,
  };
}

/**
 * 为指定知识库工作区添加或更新一个企业微信关注文件（Watched Item）
 */
export function addOrUpdateWecomWatchItem(
  host: DropTenantHost,
  input: {
    workspace: string;
    title: string;
    sourceType: WecomWatchSourceType;
    docId?: string;
    fileId?: string;
    sheet?: string;
    range?: string;
    note?: string;
  },
): { ok: true; item: WecomWatchedItem; created: boolean } | { ok: false; error: string } {
  const ws = resolveKbWorkspaceStrict(host, input.workspace);
  if (!ws.ok) return ws;

  const title = input.title.trim();
  if (!title || title.length > 120 || hasControlChars(title)) {
    return { ok: false, error: "关注文件标题不能为空且长度不超过 120 字符" };
  }

  const validTypes: WecomWatchSourceType[] = ["sheet", "smartsheet", "doc", "smartpage", "disk_file"];
  if (!validTypes.includes(input.sourceType)) {
    return { ok: false, error: `不支持的 sourceType: ${String(input.sourceType)}` };
  }

  let docId = input.docId?.trim() || undefined;
  const fileId = input.fileId?.trim() || undefined;
  let extractedTabSheet: string | undefined;
  if (docId && /^https?:\/\//i.test(docId)) {
    try {
      const parsedUrl = new URL(docId);
      const tabParam = (parsedUrl.searchParams.get("tab") || parsedUrl.searchParams.get("sheet") || "").trim();
      if (tabParam && !tabParam.startsWith("-") && !hasControlChars(tabParam)) {
        extractedTabSheet = tabParam;
      }
      const pathSegs = parsedUrl.pathname.split("/").filter(Boolean);
      const lastSeg = pathSegs[pathSegs.length - 1] || "";
      if (/^e3_[A-Za-z0-9_-]+$/.test(lastSeg)) {
        docId = lastSeg;
      }
    } catch {
      // keep raw docId
    }
  }
  if (docId && !isValidWecomResourceId(docId, 500)) {
    return { ok: false, error: "docId 格式不合法（不可含空白/控制字符或以 - 开头）" };
  }
  if (fileId && !isValidWecomResourceId(fileId, 500)) {
    return { ok: false, error: "fileId 格式不合法（不可含空白/控制字符或以 - 开头）" };
  }
  if (input.sourceType === "disk_file" && !fileId && !docId) {
    return { ok: false, error: "微盘文件（disk_file）必须提供 fileId（或包含 ID 的链接）" };
  }
  if (input.sourceType !== "disk_file" && !docId) {
    return { ok: false, error: `${input.sourceType} 类型必须提供 docId（如 e3_xxx 或在线文档链接）` };
  }

  const cleanSheet = input.sheet?.trim() || extractedTabSheet || undefined;
  if (cleanSheet && (cleanSheet.length > 120 || hasControlChars(cleanSheet) || cleanSheet.startsWith("-"))) {
    return { ok: false, error: "sheet 名称不合法" };
  }
  const cleanRange = input.range?.trim() || undefined;
  if (cleanRange && (cleanRange.length > 64 || hasControlChars(cleanRange) || cleanRange.startsWith("-"))) {
    return { ok: false, error: "range 范围格式不合法" };
  }
  const cleanNote = input.note?.trim() || undefined;
  if (cleanNote && (cleanNote.length > 500 || hasControlChars(cleanNote))) {
    return { ok: false, error: "note 备注长度不能超过 500 字符且不可含控制字符" };
  }

  return withFileLockSync(lockFilePath(host), () => {
    const file = readWatchLedger(host);
    const existingIdx = file.items.findIndex(
      (x) =>
        x.workspaceId === ws.workspaceId &&
        ((docId && x.docId === docId && (x.sheet || "") === (cleanSheet || "")) ||
          (fileId && x.fileId === fileId) ||
          x.title === title),
    );

    const now = Date.now();
    if (existingIdx >= 0) {
      const prev = file.items[existingIdx];
      const nextDocId = input.sourceType === "disk_file" ? docId : (docId ?? prev.docId);
      const nextFileId = input.sourceType === "disk_file" ? (fileId ?? prev.fileId) : undefined;
      const nextSheet = (input.sheet !== undefined || extractedTabSheet !== undefined) ? cleanSheet : prev.sheet;
      const nextRange = input.range !== undefined ? cleanRange : prev.range;
      const coordsChanged =
        prev.sourceType !== input.sourceType ||
        prev.docId !== nextDocId ||
        prev.fileId !== nextFileId ||
        (prev.sheet || "") !== (nextSheet || "") ||
        (prev.range || "") !== (nextRange || "");

      const updated: WecomWatchedItem = {
        ...prev,
        workspaceKeySnapshot: ws.key,
        title,
        sourceType: input.sourceType,
        docId: nextDocId,
        fileId: nextFileId,
        sheet: nextSheet,
        range: nextRange,
        note: input.note !== undefined ? cleanNote : prev.note,
        ...(coordsChanged
          ? {
              lastSyncedUpdateTime: undefined,
              lastSyncedSha256: undefined,
              lastSnapshotPreview: undefined,
            }
          : {}),
      };
      file.items[existingIdx] = updated;
      writeWatchLedger(host, file);
      return { ok: true, item: updated, created: false };
    }

    if (file.items.length >= MAX_WATCHED_ITEMS_PER_TENANT) {
      return { ok: false, error: `关注文件总数已达上限（${MAX_WATCHED_ITEMS_PER_TENANT}）` };
    }

    const newItem: WecomWatchedItem = {
      id: `ww_${randomBytes(6).toString("hex")}`,
      workspaceId: ws.workspaceId,
      workspaceKeySnapshot: ws.key,
      title,
      sourceType: input.sourceType,
      docId,
      fileId,
      sheet: cleanSheet,
      range: cleanRange,
      note: cleanNote,
      createdAt: now,
    };
    file.items.push(newItem);
    writeWatchLedger(host, file);
    return { ok: true, item: newItem, created: true };
  });
}

export function listWecomWatchItems(
  host: DropTenantHost,
  filter?: { workspace?: string },
): { ok: true; items: WecomWatchedItem[] } | { ok: false; error: string } {
  const file = readWatchLedger(host);
  if (!filter?.workspace?.trim()) {
    return { ok: true, items: file.items };
  }
  const ws = resolveKbWorkspaceStrict(host, filter.workspace);
  if (!ws.ok) return ws;
  return {
    ok: true,
    items: file.items.filter((x) => x.workspaceId === ws.workspaceId),
  };
}

export function removeWecomWatchItem(
  host: DropTenantHost,
  idOrTitle: string,
  workspace?: string,
): { ok: true; removed: WecomWatchedItem } | { ok: false; error: string } {
  const target = idOrTitle.trim();
  if (!target) return { ok: false, error: "请提供要移除的关注项 ID（如 ww_xxx）或标题" };
  let wsIdFilter: string | undefined;
  if (workspace?.trim()) {
    const ws = resolveKbWorkspaceStrict(host, workspace);
    if (!ws.ok) return ws;
    wsIdFilter = ws.workspaceId;
  }

  return withFileLockSync(lockFilePath(host), () => {
    const file = readWatchLedger(host);
    const idx = file.items.findIndex(
      (x) => (!wsIdFilter || x.workspaceId === wsIdFilter) && (x.id === target || x.title === target),
    );
    if (idx < 0) {
      return { ok: false, error: `未找到匹配的企微关注文件 "${target}"` };
    }
    const [removed] = file.items.splice(idx, 1);
    writeWatchLedger(host, file);
    return { ok: true, removed };
  });
}

export type WecomFetchedSnapshot = {
  remoteUpdateTime?: string;
  sha256: string;
  fileName: string;
  data: Buffer;
  previewText: string;
  summary: string;
};

function sanitizeFileNameSegment(raw: string): string {
  return (
    raw
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "企微数据"
  );
}

/**
 * 从企业微信拉取单个关注项的最新内容与元数据指纹（用于变动检测或同步入库）
 */
export async function fetchWecomItemSnapshot(
  host: TenantRef,
  item: WecomWatchedItem,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<{ ok: true; snapshot: WecomFetchedSnapshot } | { ok: false; error: string }> {
  const configDir = wecomConfigDirForTenant(host);

  // 1. 尝试通过 doc search（非微盘普通文件）或 disk search 查询最新修改时间戳
  let remoteUpdateTime: string | undefined;
  const searchKw = sanitizeCliOptionValue(item.title);
  if (searchKw) {
    if (item.sourceType !== "disk_file") {
      const searchRes = await activeRunner(["doc", "search", `--keywords=${searchKw}`, "--limit", "10"], {
        configDir,
        timeoutMs: 15_000,
      });
      if (searchRes.ok && Array.isArray(searchRes.parsed?.docs)) {
        const matched = (searchRes.parsed.docs as Array<Record<string, unknown>>).find(
          (d) => (item.docId && d.docid === item.docId) || d.doc_name === item.title,
        );
        if (matched && typeof matched.modify_time === "string") {
          remoteUpdateTime = matched.modify_time;
        }
      }
    } else {
      const diskRes = await activeRunner(["disk", "files", "search", `--keywords=${searchKw}`, "--limit", "10"], {
        configDir,
        timeoutMs: 15_000,
      });
      if (diskRes.ok && Array.isArray(diskRes.parsed?.files)) {
        const matched = (diskRes.parsed.files as Array<Record<string, unknown>>).find(
          (f) => (item.fileId && f.id === item.fileId) || f.file_name === item.title,
        );
        if (matched && typeof matched.update_time === "string") {
          remoteUpdateTime = matched.update_time;
        }
      }
    }
  }

  // 2. 按类型拉取实时内容
  if (item.sourceType === "sheet") {
    const docId = item.docId || "";
    if (!isValidWecomResourceId(docId, 500)) {
      return { ok: false, error: "关注项 docId 不合法" };
    }
    const reqPayload: Record<string, unknown> = {
      docid: docId,
      csv: true,
    };
    if (item.sheet) reqPayload.sheet = item.sheet;
    if (item.range) {
      reqPayload.range = item.range;
    } else {
      reqPayload.full = true;
    }
    const res = await activeRunner(["sheet", "cells", "get", "--json", JSON.stringify(reqPayload)], {
      configDir,
    });
    if (!res.ok) return { ok: false, error: extractCliError(res) };
    const csvData = typeof res.parsed?.csv_data === "string" ? res.parsed.csv_data : "";
    if (!csvData.trim()) {
      return { ok: false, error: `在线表格《${item.title}》返回内容为空` };
    }
    const actualRange = typeof res.parsed?.actual_range === "string" ? res.parsed.actual_range : item.range || "full";
    const normalizedCsv = csvData.replace(/\r\n/g, "\n").trim();
    const dataBuf = Buffer.from(`\uFEFF${normalizedCsv}\n`, "utf8");
    if (dataBuf.length > maxFileBytes) {
      return { ok: false, error: `表格导出体积（${dataBuf.length} bytes）超过上限（${maxFileBytes} bytes）` };
    }
    const sha256 = createHash("sha256").update(normalizedCsv, "utf8").digest("hex");
    const lines = normalizedCsv.split("\n").filter((l) => l.replace(/,/g, "").trim().length > 0);
    const previewText = lines.slice(0, 12).join("\n").slice(0, 800);
    const safeTitle = sanitizeFileNameSegment(item.title);
    const sheetSuffix = item.sheet ? `_${sanitizeFileNameSegment(item.sheet)}` : "";
    return {
      ok: true,
      snapshot: {
        remoteUpdateTime,
        sha256,
        fileName: `${safeTitle}${sheetSuffix}.csv`,
        data: dataBuf,
        previewText,
        summary: `在线表格（区域 ${actualRange}，非空行 ${lines.length} 行）`,
      },
    };
  }

  if (item.sourceType === "smartsheet") {
    const docId = item.docId || "";
    if (!isValidWecomResourceId(docId, 500)) {
      return { ok: false, error: "关注项 docId 不合法" };
    }
    const args = ["smartsheet", "records", "list", `--docid=${docId}`, "--type", "records", "--limit", "500"];
    if (item.sheet) {
      args.push(`--sheet-title=${sanitizeCliOptionValue(item.sheet, 120)}`);
    }
    const res = await activeRunner(args, { configDir });
    if (!res.ok) return { ok: false, error: extractCliError(res) };
    if (!res.parsed || Object.keys(res.parsed).length === 0) {
      return { ok: false, error: `智能表格《${item.title}》返回数据为空或解析失败` };
    }
    const payloadObj = sanitizeWecomCliPayload(res.parsed);
    const canonical = JSON.stringify(payloadObj, null, 2);
    const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
    const mdContent = `# ${item.title}（企业微信智能表格同步快照）\n\n- 文档 ID：\`${docId}\`\n${remoteUpdateTime ? `- 远端修改时间：\`${remoteUpdateTime}\`\n` : ""}\n\`\`\`json\n${canonical}\n\`\`\`\n`;
    const dataBuf = Buffer.from(mdContent, "utf8");
    if (dataBuf.length > maxFileBytes) {
      return { ok: false, error: `智能表格导出体积超过上限（${maxFileBytes} bytes）` };
    }
    const safeTitle = sanitizeFileNameSegment(item.title);
    return {
      ok: true,
      snapshot: {
        remoteUpdateTime,
        sha256,
        fileName: `${safeTitle}_智能表格.md`,
        data: dataBuf,
        previewText: canonical.slice(0, 800),
        summary: `智能表格记录快照（${Buffer.byteLength(canonical)} bytes）`,
      },
    };
  }

  if (item.sourceType === "doc" || item.sourceType === "smartpage") {
    const docId = item.docId || "";
    if (!isValidWecomResourceId(docId, 500)) {
      return { ok: false, error: "关注项 docId 不合法" };
    }
    const args =
      item.sourceType === "doc"
        ? ["doc", "contents", "get", `--docid=${docId}`, "--content-type", "markdown"]
        : ["smartpage", "pages", "get", `--docid=${docId}`];
    const res = await activeRunner(args, { configDir });
    if (!res.ok) return { ok: false, error: extractCliError(res) };
    const bodyText =
      typeof res.parsed?.content === "string"
        ? res.parsed.content
        : typeof res.parsed?.markdown === "string"
          ? res.parsed.markdown
          : res.parsed && Object.keys(res.parsed).length > 0
            ? JSON.stringify(sanitizeWecomCliPayload(res.parsed), null, 2)
            : "";
    const normalized = bodyText.replace(/\r\n/g, "\n").trim();
    if (!normalized) {
      return { ok: false, error: `在线文档《${item.title}》返回正文为空` };
    }
    const sha256 = createHash("sha256").update(normalized, "utf8").digest("hex");
    const mdDoc = `# ${item.title}\n\n${normalized}\n`;
    const dataBuf = Buffer.from(mdDoc, "utf8");
    if (dataBuf.length > maxFileBytes) {
      return { ok: false, error: `文档体积超过上限（${maxFileBytes} bytes）` };
    }
    const safeTitle = sanitizeFileNameSegment(item.title);
    return {
      ok: true,
      snapshot: {
        remoteUpdateTime,
        sha256,
        fileName: `${safeTitle}.md`,
        data: dataBuf,
        previewText: normalized.slice(0, 800),
        summary: `在线文档（${Buffer.byteLength(normalized)} bytes）`,
      },
    };
  }

  if (item.sourceType === "disk_file") {
    const targetRef = item.fileId || item.docId || "";
    if (!isValidWecomResourceId(targetRef, 500)) {
      return { ok: false, error: "微盘文件 fileId/url 不合法" };
    }
    const tempDir = join(tmpdir(), `jiebo-wecom-dl-${Date.now()}-${randomBytes(4).toString("hex")}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    try {
      const args = ["disk", "files", "download"];
      if (item.fileId) args.push(`--file-id=${item.fileId}`);
      else args.push(`--url=${targetRef}`);
      const res = await activeRunner(args, { configDir, outputDir: tempDir, timeoutMs: 60_000 });
      if (!res.ok) return { ok: false, error: extractCliError(res) };

      const candidatePath =
        typeof res.parsed?.file_path === "string"
          ? res.parsed.file_path
          : typeof res.parsed?.path === "string"
            ? res.parsed.path
            : undefined;
      const safeRead = readSafeDownloadedFileSync(tempDir, candidatePath, maxFileBytes);
      if (!safeRead.ok) {
        return { ok: false, error: safeRead.error };
      }
      // 严禁通过 item.title 伪造扩展名绕过安全校验：文件扩展名必须以微盘实际下载文件的真实扩展名为准
      const actualExt = extname(safeRead.fileName).toLowerCase();
      if (!actualExt) {
        return { ok: false, error: `微盘文件 "${safeRead.fileName}" 缺少有效扩展名` };
      }
      const baseTitle = item.title.toLowerCase().endsWith(actualExt)
        ? item.title.slice(0, -actualExt.length)
        : item.title;
      const finalName = `${sanitizeFileNameSegment(baseTitle)}${actualExt}`;
      const sha256 = createHash("sha256").update(safeRead.data).digest("hex");
      return {
        ok: true,
        snapshot: {
          remoteUpdateTime,
          sha256,
          fileName: finalName,
          data: safeRead.data,
          previewText: `二进制文件 ${finalName} (${safeRead.data.length} bytes, sha256=${sha256.slice(0, 12)})`,
          summary: `微盘文件 ${finalName} (${(safeRead.data.length / 1024).toFixed(1)} KB)`,
        },
      };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  return { ok: false, error: `未知的 sourceType: ${String(item.sourceType)}` };
}

function summarizeTextDiff(oldPreview: string | undefined, newPreview: string): string {
  if (!oldPreview) return "首次建立基线（此前尚无入库同步记录）";
  const oldLines = new Set(
    oldPreview
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const newLines = newPreview
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const added = newLines.filter((l) => !oldLines.has(l));
  if (added.length === 0) return "远端内容哈希已变更（可能修改了表格后半部分或调整了数据顺序）";
  return `预览区检测到新增/变更行（示例）：${added.slice(0, 3).join(" | ").slice(0, 240)}`;
}

export type WecomChangeCheckItemResult = {
  id: string;
  workspaceKey: string;
  title: string;
  sourceType: WecomWatchSourceType;
  ok: boolean;
  hasChanged: boolean;
  firstCheck: boolean;
  remoteUpdateTime?: string;
  previousUpdateTime?: string;
  currentSha256?: string;
  previousSha256?: string;
  summary?: string;
  diffHint?: string;
  previewText?: string;
  error?: string;
};

/**
 * 只读检查关注的企业微信文件是否有变动（不触发归档写入，除非显式传 syncIfChanged=true）
 */
export async function checkAndOptionallySyncWecomItems(
  host: DropTenantHost,
  input: {
    workspace?: string;
    idOrTitle?: string;
    syncIfChanged?: boolean;
    forceSync?: boolean;
  },
): Promise<{
  ok: boolean;
  checkedCount: number;
  changedCount: number;
  syncedCount: number;
  results: Array<
    WecomChangeCheckItemResult & {
      synced?: boolean;
      batchId?: string;
      syncError?: string;
    }
  >;
  error?: string;
}> {
  const listed = listWecomWatchItems(host, { workspace: input.workspace });
  if (!listed.ok) return { ok: false, checkedCount: 0, changedCount: 0, syncedCount: 0, results: [], error: listed.error };

  let targets = listed.items;
  if (input.idOrTitle?.trim()) {
    const q = input.idOrTitle.trim();
    const exact = targets.filter((x) => x.id === q || x.title === q || x.docId === q || x.fileId === q);
    if (exact.length > 0) {
      targets = exact;
    } else {
      const fuzzy = targets.filter((x) => x.title.includes(q));
      if (fuzzy.length > 1 && input.syncIfChanged) {
        return {
          ok: false,
          checkedCount: 0,
          changedCount: 0,
          syncedCount: 0,
          results: [],
          error: `关键词 "${q}" 同时匹配到多个关注文件（${fuzzy.map((f) => f.title).join("、")}），请指定完整标题或 ID`,
        };
      }
      targets = fuzzy;
    }
  }
  if (targets.length === 0) {
    return {
      ok: true,
      checkedCount: 0,
      changedCount: 0,
      syncedCount: 0,
      results: [],
    };
  }

  const results: Array<
    WecomChangeCheckItemResult & {
      synced?: boolean;
      batchId?: string;
      syncError?: string;
    }
  > = [];
  let changedCount = 0;
  let syncedCount = 0;

  for (const item of targets) {
    const wsCheck = resolveKbWorkspaceStrict(host, item.workspaceId);
    const maxBytes = wsCheck.ok ? wsCheck.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
    const fetched = await fetchWecomItemSnapshot(host, item, maxBytes);
    const now = Date.now();
    if (!fetched.ok) {
      results.push({
        id: item.id,
        workspaceKey: item.workspaceKeySnapshot,
        title: item.title,
        sourceType: item.sourceType,
        ok: false,
        hasChanged: false,
        firstCheck: !item.lastSyncedSha256,
        error: fetched.error,
      });
      continue;
    }

    const snap = fetched.snapshot;
    const firstCheck = !item.lastSyncedSha256;
    const hasChanged = firstCheck || item.lastSyncedSha256 !== snap.sha256;
    if (hasChanged) changedCount += 1;

    const diffHint = hasChanged
      ? summarizeTextDiff(item.lastSnapshotPreview, snap.previewText)
      : "内容哈希与上次同步完全一致，无变动";

    const rowResult: WecomChangeCheckItemResult & {
      synced?: boolean;
      batchId?: string;
      syncError?: string;
    } = {
      id: item.id,
      workspaceKey: item.workspaceKeySnapshot,
      title: item.title,
      sourceType: item.sourceType,
      ok: true,
      hasChanged,
      firstCheck,
      remoteUpdateTime: snap.remoteUpdateTime,
      previousUpdateTime: item.lastSyncedUpdateTime,
      currentSha256: snap.sha256,
      previousSha256: item.lastSyncedSha256,
      summary: snap.summary,
      diffHint,
      previewText: snap.previewText,
    };

    const shouldSync = Boolean(input.forceSync || (input.syncIfChanged && hasChanged));
    if (shouldSync) {
      if (inFlightItemSync.has(item.id)) {
        rowResult.synced = false;
        rowResult.syncError = "该关注项正在同步中，已跳过并发重复提交";
        results.push(rowResult);
        continue;
      }
      inFlightItemSync.add(item.id);
      try {
        // 提交前在锁内复核账本最新状态，防止并发协程已同步相同 SHA 或配置已被修改
        const precheck = withFileLockSync(lockFilePath(host), () => {
          const ledger = readWatchLedger(host);
          const latest = ledger.items.find((x) => x.id === item.id);
          if (!latest) return { proceed: false, reason: "关注项已被移除" };
          if (
            latest.sourceType !== item.sourceType ||
            latest.docId !== item.docId ||
            latest.fileId !== item.fileId ||
            (latest.sheet || "") !== (item.sheet || "") ||
            (latest.range || "") !== (item.range || "")
          ) {
            return { proceed: false, reason: "关注项配置在拉取期间已变更，请重新检查" };
          }
          if (!input.forceSync && latest.lastSyncedSha256 === snap.sha256) {
            return { proceed: false, reason: "已被并发请求同步完成" };
          }
          return { proceed: true, reason: "" };
        });

        if (!precheck.proceed) {
          rowResult.synced = false;
          rowResult.syncError = precheck.reason;
          results.push(rowResult);
          continue;
        }

        const submitted = submitDirectIngestBatch(host, {
          workspaceKeyOrId: item.workspaceId,
          tokenId: "dt_wecom_watch_sync",
          submitterName: "企业微信同步",
          note:
            item.note ||
            `企业微信《${item.title}》(${item.sourceType}) 增量同步${snap.remoteUpdateTime ? ` · 修改于 ${snap.remoteUpdateTime}` : ""}`,
          files: [{ fileName: snap.fileName, data: snap.data }],
        });
        if (!submitted.ok) {
          rowResult.synced = false;
          rowResult.syncError = submitted.error;
        } else {
          rowResult.synced = true;
          rowResult.batchId = submitted.batchId;
          syncedCount += 1;
          withFileLockSync(lockFilePath(host), () => {
            const ledger = readWatchLedger(host);
            const idx = ledger.items.findIndex((x) => x.id === item.id);
            if (idx >= 0) {
              ledger.items[idx] = {
                ...ledger.items[idx],
                workspaceKeySnapshot: submitted.workspaceKey,
                lastSyncedUpdateTime: snap.remoteUpdateTime ?? ledger.items[idx].lastSyncedUpdateTime,
                lastSyncedSha256: snap.sha256,
                lastSnapshotPreview: snap.previewText,
                lastBatchId: submitted.batchId,
                lastCheckedAt: now,
                lastSyncedAt: now,
              };
              writeWatchLedger(host, ledger);
            }
          });
        }
      } finally {
        inFlightItemSync.delete(item.id);
      }
    } else {
      withFileLockSync(lockFilePath(host), () => {
        const ledger = readWatchLedger(host);
        const idx = ledger.items.findIndex((x) => x.id === item.id);
        if (idx >= 0) {
          ledger.items[idx] = {
            ...ledger.items[idx],
            lastCheckedAt: now,
          };
          writeWatchLedger(host, ledger);
        }
      });
    }

    results.push(rowResult);
  }

  return {
    ok: true,
    checkedCount: targets.length,
    changedCount,
    syncedCount,
    results,
  };
}

/**
 * 将企业微信中的指定邮件（含正文与可下载的 media_id 附件）直接归档进目标知识库工作区
 */
export async function ingestWecomMailToKb(
  host: DropTenantHost,
  input: {
    workspace: string;
    mailId: string;
    note?: string;
  },
): Promise<{
  ok: boolean;
  batchId?: string;
  workspaceKey?: string;
  workspaceTitle?: string;
  fileCount?: number;
  files?: string[];
  skippedAttachments?: string[];
  error?: string;
}> {
  const ws = resolveKbWorkspaceStrict(host, input.workspace);
  if (!ws.ok) return { ok: false, error: ws.error };
  const kbLoaded = loadKbWorkspaceConfig(ws.path, host.workspaceRoot);
  if (!kbLoaded.ok) return { ok: false, error: kbLoaded.error };

  const mailId = input.mailId.trim();
  if (!isValidWecomResourceId(mailId, 256)) {
    return { ok: false, error: "企业微信邮件 mailId 格式不合法（不可为空或以 - 开头）" };
  }

  const configDir = wecomConfigDirForTenant(host);
  const mailTempDir = join(tmpdir(), `jiebo-wecom-mail-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(mailTempDir, { recursive: true, mode: 0o700 });

  try {
    const res = await activeRunner(["mail", "get", `--mail-ids=${mailId}`], {
      configDir,
      outputDir: mailTempDir,
    });
    if (!res.ok) return { ok: false, error: extractCliError(res) };

    const mailList = Array.isArray(res.parsed?.mail_list)
      ? (res.parsed.mail_list as Array<Record<string, unknown>>)
      : [];
    const mailItem = mailList[0];
    if (!mailItem) {
      return { ok: false, error: "未读取到对应的企业微信邮件详情" };
    }

    const subject =
      typeof mailItem.subject === "string" && mailItem.subject.trim() ? mailItem.subject.trim() : "企业微信邮件";
    const senderObj =
      mailItem.sender && typeof mailItem.sender === "object" ? (mailItem.sender as Record<string, unknown>) : {};
    const senderText = [senderObj.name, senderObj.email].filter(Boolean).join(" <") + (senderObj.email ? ">" : "");

    let bodyContent = typeof mailItem.content === "string" ? mailItem.content : "";
    if (!bodyContent && typeof mailItem.file_path === "string" && mailItem.file_path.trim()) {
      const safeBody = readSafeDownloadedFileSync(
        mailTempDir,
        mailItem.file_path,
        kbLoaded.config.maxFileBytes,
      );
      if (safeBody.ok) {
        bodyContent = safeBody.data.toString("utf8");
      }
    }

    const filesToSubmit: Array<{ fileName: string; data: Buffer }> = [];
    const skippedAttachments: string[] = [];

    const safeSubject = sanitizeFileNameSegment(subject);
    const mdBody = [
      `# ${subject}`,
      "",
      `- **发件人**：${senderText || "未知"}`,
      `- **邮件 ID**：\`${mailId}\``,
      "",
      "---",
      "",
      bodyContent.trim() || "（邮件无文本正文）",
      "",
    ].join("\n");

    filesToSubmit.push({
      fileName: `${safeSubject}_邮件正文.md`,
      data: Buffer.from(mdBody, "utf8"),
    });

    const attachments = Array.isArray(mailItem.attachments)
      ? (mailItem.attachments as Array<Record<string, unknown>>)
      : [];
    for (const att of attachments) {
      if (filesToSubmit.length >= MAX_FILES_PER_BATCH) {
        skippedAttachments.push(`超出单批次 ${MAX_FILES_PER_BATCH} 个文件上限的其余附件`);
        break;
      }
      const attName = typeof att.name === "string" ? att.name.trim() : "";
      const mediaId = typeof att.media_id === "string" ? att.media_id.trim() : "";
      if (!attName || !mediaId) {
        if (attName) skippedAttachments.push(`${attName} (仅外链或防泄漏附件，无 media_id)`);
        continue;
      }
      if (!isValidWecomResourceId(mediaId, 512)) {
        skippedAttachments.push(`${attName} (media_id 格式非法)`);
        continue;
      }
      const check = isAllowedUploadFileName(attName, kbLoaded.config);
      if (!check.ok) {
        skippedAttachments.push(`${attName} (${check.error})`);
        continue;
      }

      const attTempDir = join(tmpdir(), `jiebo-wecom-mail-att-${Date.now()}-${randomBytes(4).toString("hex")}`);
      mkdirSync(attTempDir, { recursive: true, mode: 0o700 });
      try {
        const dlRes = await activeRunner(["media", "download", `--media-id=${mediaId}`], {
          configDir,
          outputDir: attTempDir,
          timeoutMs: 60_000,
        });
        if (!dlRes.ok) {
          skippedAttachments.push(`${attName} (下载失败)`);
          continue;
        }
        const dlCandidate =
          typeof dlRes.parsed?.file_path === "string"
            ? dlRes.parsed.file_path
            : typeof dlRes.parsed?.path === "string"
              ? dlRes.parsed.path
              : undefined;
        const safeAtt = readSafeDownloadedFileSync(attTempDir, dlCandidate, kbLoaded.config.maxFileBytes);
        if (!safeAtt.ok) {
          skippedAttachments.push(`${attName} (${safeAtt.error})`);
          continue;
        }
        filesToSubmit.push({
          fileName: check.normalizedName,
          data: safeAtt.data,
        });
      } finally {
        try {
          rmSync(attTempDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }

    const submitted = submitDirectIngestBatch(host, {
      workspaceKeyOrId: ws.workspaceId,
      tokenId: "dt_wecom_mail_ingest",
      submitterName: "企业微信邮件同步",
      note: input.note?.trim() || `企业微信邮件《${subject}》归档`,
      files: filesToSubmit,
    });
    if (!submitted.ok) {
      return { ok: false, error: submitted.error };
    }

    return {
      ok: true,
      batchId: submitted.batchId,
      workspaceKey: submitted.workspaceKey,
      workspaceTitle: submitted.workspaceTitle,
      fileCount: submitted.meta.files.length,
      files: submitted.meta.files.map((f) => f.storedName),
      skippedAttachments: skippedAttachments.length > 0 ? skippedAttachments : undefined,
    };
  } finally {
    try {
      rmSync(mailTempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
