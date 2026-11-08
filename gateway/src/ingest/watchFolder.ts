import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { DEFAULT_ALLOWED_EXTS, DEFAULT_MAX_FILE_BYTES } from "./contract.ts";

const ALLOWED_EXT_SET = new Set<string>(DEFAULT_ALLOWED_EXTS);

/** 展开 `~/...` 路径到用户主目录并解析为绝对路径 */
export function expandLocalPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

/**
 * 规范化并校验 Webhook URL：
 * 1. 自动补齐 `/api/webhook` 后缀；
 * 2. 强制要求 `https://`，仅允许本机回环地址（`127.0.0.1`、`localhost`、`[::1]`）使用 `http://`（防止长期口令在公网明文传输）。
 */
export function normalizeWebhookUrl(rawUrl: string, allowInsecureHttp = false): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("未提供 Webhook URL");
  let normalized = trimmed;
  if (!normalized.endsWith("/api/webhook")) {
    if (normalized.endsWith("/drop")) {
      normalized = `${normalized}/api/webhook`;
    }
  }
  const parsed = new URL(normalized);
  if (parsed.protocol === "https:") {
    return parsed.toString();
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    if (isLoopback || allowInsecureHttp) {
      return parsed.toString();
    }
    throw new Error(
      "为保护投递口令安全，远程 Webhook 地址必须使用 https://（仅本机 127.0.0.1/localhost 允许 http://）",
    );
  }
  throw new Error(`不支持的 URL 协议：${parsed.protocol}`);
}

/**
 * 使用 O_NOFOLLOW 打开本地文件一次，通过同一个 fd 完成 fstat 校验、大小上限预检、读取与 SHA-256 计算，
 * 彻底消除 lstat 与 readFile 之间的符号链接替换（TOCTOU）竞态。
 */
export function readLocalFileSafelyWithSha256(
  filePath: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): { fileName: string; buffer: Buffer; size: number; sha256: string } {
  const absPath = expandLocalPath(filePath);
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

  let fd: number | undefined;
  try {
    fd = openSync(absPath, flags);
    const st = fstatSync(fd);
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error(`不是普通文件：${absPath}`);
    }
    if (st.size <= 0) {
      throw new Error(`文件为空：${absPath}`);
    }
    if (st.size > maxBytes) {
      throw new Error(`文件体积（${st.size} bytes）超过单文件上限（${maxBytes} bytes）`);
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    const finalBuf = buf.subarray(0, offset);
    const sha256 = createHash("sha256").update(finalBuf).digest("hex");
    return {
      fileName: basename(absPath),
      buffer: finalBuf,
      size: finalBuf.length,
      sha256,
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export type WebhookUploadResponse = {
  ok: boolean;
  batchId: string;
  receiptToken: string;
  workspaceKey: string;
  workspaceTitle: string;
  storedName: string;
  size: number;
  sha256: string;
  error?: string;
};

/**
 * 将已安全读入的本地文件上传至单步 Webhook 端点
 */
export async function uploadSingleFileToWebhook(input: {
  webhookUrl: string;
  passcode: string;
  filePath: string;
  submitter?: string;
  note?: string;
  maxBytes?: number;
  preloaded?: { fileName: string; buffer: Buffer; size: number; sha256: string };
}): Promise<WebhookUploadResponse> {
  const loaded = input.preloaded ?? readLocalFileSafelyWithSha256(input.filePath, input.maxBytes);
  const endpoint = new URL(normalizeWebhookUrl(input.webhookUrl));
  endpoint.searchParams.set("fileName", loaded.fileName);
  if (input.submitter) endpoint.searchParams.set("submitterName", input.submitter);
  if (input.note) endpoint.searchParams.set("note", input.note);

  const res = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.passcode}`,
      "content-type": "application/octet-stream",
      "content-length": String(loaded.size),
    },
    body: new Uint8Array(loaded.buffer),
  });

  const data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as WebhookUploadResponse;
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || `上传失败 (HTTP ${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

type WatchLedgerRecord = {
  fileName: string;
  batchId: string;
  receiptToken: string;
  uploadedAt: string;
};

function loadSentLedger(ledgerPath: string): Record<string, WatchLedgerRecord> {
  try {
    if (!existsSync(ledgerPath)) return {};
    return (JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, WatchLedgerRecord>) || {};
  } catch {
    return {};
  }
}

function saveSentLedger(ledgerPath: string, ledger: Record<string, WatchLedgerRecord>) {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function isIgnoredWatchFile(name: string): boolean {
  if (!name || name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  if (
    lower.endsWith(".part") ||
    lower.endsWith(".crdownload") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".download") ||
    lower.startsWith("~$")
  ) {
    return true;
  }
  const ext = extname(lower);
  return !ALLOWED_EXT_SET.has(ext);
}

/**
 * 扫描一次本地热文件夹：
 * 1. 每个文件独立 try/catch：单个异常或超限文件移入 `.failed/` 目录隔离，绝不阻塞同目录后续正常文件；
 * 2. 命中 `.jiebo-watch-ledger.json`（SHA-256 相同）的重复文件直接移入 `.archived/`，避免重复入队；
 * 3. 上传成功后记录 ledger 并移入 `.archived/`。
 */
export async function scanWatchFolderOnce(input: {
  watchDir: string;
  webhookUrl: string;
  passcode: string;
  submitter?: string;
  note?: string;
  settleMs?: number;
  maxBytes?: number;
}): Promise<{
  uploaded: Array<{ fileName: string; batchId: string; archivedPath: string }>;
  duplicates: string[];
  failed: Array<{ fileName: string; error: string; failedPath?: string }>;
}> {
  const rootDir = expandLocalPath(input.watchDir);
  const archivedDir = join(rootDir, ".archived");
  const failedDir = join(rootDir, ".failed");
  const ledgerPath = join(rootDir, ".jiebo-watch-ledger.json");
  mkdirSync(archivedDir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });

  const ledger = loadSentLedger(ledgerPath);
  const entries = readdirSync(rootDir).sort();
  const uploaded: Array<{ fileName: string; batchId: string; archivedPath: string }> = [];
  const duplicates: string[] = [];
  const failed: Array<{ fileName: string; error: string; failedPath?: string }> = [];
  const settleMs = input.settleMs ?? 0;

  for (const name of entries) {
    if (isIgnoredWatchFile(name)) continue;
    const fullPath = join(rootDir, name);
    let st;
    try {
      st = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0) continue;

    if (settleMs > 0) {
      const sizeBefore = st.size;
      const mtimeBefore = st.mtimeMs;
      await new Promise((r) => setTimeout(r, settleMs));
      let stAfter;
      try {
        stAfter = statSync(fullPath);
      } catch {
        continue;
      }
      if (stAfter.size !== sizeBefore || stAfter.mtimeMs !== mtimeBefore) {
        continue;
      }
    }

    try {
      const loaded = readLocalFileSafelyWithSha256(fullPath, input.maxBytes);
      if (ledger[loaded.sha256]) {
        const destDup = join(archivedDir, `${Date.now()}_dup_${name}`);
        renameSync(fullPath, destDup);
        duplicates.push(name);
        continue;
      }

      const result = await uploadSingleFileToWebhook({
        webhookUrl: input.webhookUrl,
        passcode: input.passcode,
        filePath: fullPath,
        submitter: input.submitter,
        note: input.note || `本地热文件夹自动同步：${name}`,
        preloaded: loaded,
      });

      ledger[loaded.sha256] = {
        fileName: name,
        batchId: result.batchId,
        receiptToken: result.receiptToken,
        uploadedAt: new Date().toISOString(),
      };
      saveSentLedger(ledgerPath, ledger);

      const archivedPath = join(archivedDir, `${new Date().toISOString().slice(0, 10)}_${result.batchId}_${name}`);
      renameSync(fullPath, archivedPath);
      uploaded.push({ fileName: name, batchId: result.batchId, archivedPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      // 对于确定性文件错误（本地超限、400 非法文件名、413 体积超限），移入 .failed/ 避免死循环重试阻塞目录
      const isPermanentFileError =
        status === 400 || status === 413 || msg.includes("超过单文件上限") || msg.includes("不是普通文件");
      let failedPath: string | undefined;
      if (isPermanentFileError && existsSync(fullPath)) {
        try {
          failedPath = join(failedDir, `${Date.now()}_err_${name}`);
          renameSync(fullPath, failedPath);
        } catch {
          failedPath = undefined;
        }
      }
      failed.push({ fileName: name, error: msg, ...(failedPath ? { failedPath } : {}) });
    }
  }

  return { uploaded, duplicates, failed };
}
