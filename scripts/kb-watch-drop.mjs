#!/usr/bin/env node
/**
 * 接驳知识库「本地热文件夹（Watch Folder）」与 CLI 一键直投脚本（纯 Node 标准库，零外部依赖，可独立拷贝到任意 Mac/PC 运行）
 *
 * 支持两种模式：
 * 1. 单次直投（--once <file>）：将指定文件一键上传至 `/p/<tenant>/drop/api/webhook` 入库；
 * 2. 常驻热文件夹监听（--dir <folder>）：将文件拖入或保存到该目录后，自动检测写入静止、O_NOFOLLOW 安全读取、校验去重（SHA-256）、上传归档，成功后移入 `.archived/` 子目录，异常文件移入 `.failed/` 隔离。
 */

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
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_ALLOWED_EXTS = new Set([
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
]);

export function expandLocalPath(rawPath) {
  const trimmed = String(rawPath || "").trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function normalizeWebhookUrl(rawUrl, allowInsecureHttp = false) {
  const trimmed = String(rawUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) throw new Error("未提供 Webhook URL");
  let normalized = trimmed;
  if (!normalized.endsWith("/api/webhook") && normalized.endsWith("/drop")) {
    normalized = `${normalized}/api/webhook`;
  }
  const parsed = new URL(normalized);
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    if (isLoopback || allowInsecureHttp) return parsed.toString();
    throw new Error(
      "为保护投递口令安全，远程 Webhook 地址必须使用 https://（仅本机 127.0.0.1/localhost 允许 http://）",
    );
  }
  throw new Error(`不支持的 URL 协议：${parsed.protocol}`);
}

export function readLocalFileSafelyWithSha256(filePath, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  const absPath = expandLocalPath(filePath);
  const flags =
    constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);

  let fd;
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

export async function uploadSingleFileToWebhook({
  webhookUrl,
  passcode,
  filePath,
  submitter,
  note,
  maxBytes,
  preloaded,
}) {
  const loaded = preloaded ?? readLocalFileSafelyWithSha256(filePath, maxBytes);
  const endpoint = new URL(normalizeWebhookUrl(webhookUrl));
  endpoint.searchParams.set("fileName", loaded.fileName);
  if (submitter) endpoint.searchParams.set("submitterName", submitter);
  if (note) endpoint.searchParams.set("note", note);

  const res = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${passcode}`,
      "content-type": "application/octet-stream",
      "content-length": String(loaded.size),
    },
    body: new Uint8Array(loaded.buffer),
  });

  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || `上传失败 (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function loadSentLedger(ledgerPath) {
  try {
    if (!existsSync(ledgerPath)) return {};
    return JSON.parse(readFileSync(ledgerPath, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveSentLedger(ledgerPath, ledger) {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isIgnoredWatchFile(name) {
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
  return !DEFAULT_ALLOWED_EXTS.has(ext);
}

export async function scanWatchFolderOnce({ watchDir, webhookUrl, passcode, submitter, note, settleMs = 0, maxBytes }) {
  const rootDir = expandLocalPath(watchDir);
  const archivedDir = join(rootDir, ".archived");
  const failedDir = join(rootDir, ".failed");
  const ledgerPath = join(rootDir, ".jiebo-watch-ledger.json");
  mkdirSync(archivedDir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });

  const ledger = loadSentLedger(ledgerPath);
  const entries = readdirSync(rootDir).sort();
  const uploaded = [];
  const duplicates = [];
  const failed = [];

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
      const loaded = readLocalFileSafelyWithSha256(fullPath, maxBytes);
      if (ledger[loaded.sha256]) {
        const destDup = join(archivedDir, `${Date.now()}_dup_${name}`);
        renameSync(fullPath, destDup);
        duplicates.push(name);
        continue;
      }

      const result = await uploadSingleFileToWebhook({
        webhookUrl,
        passcode,
        filePath: fullPath,
        submitter,
        note: note || `本地热文件夹自动同步：${name}`,
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
      const status = err?.status;
      const isPermanentFileError =
        status === 400 || status === 413 || msg.includes("超过单文件上限") || msg.includes("不是普通文件");
      let failedPath;
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

function parseArgs(argv) {
  const opts = {
    url: process.env.JIEBO_DROP_URL || "",
    passcode: process.env.JIEBO_DROP_PASSCODE || "",
    submitter: process.env.JIEBO_DROP_SUBMITTER || "本地热文件夹同步",
    note: process.env.JIEBO_DROP_NOTE || "",
    dir: "",
    once: "",
    intervalMs: 3000,
    settleMs: 1500,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) opts.url = argv[++i];
    else if (arg === "--passcode" && argv[i + 1]) opts.passcode = argv[++i];
    else if (arg === "--submitter" && argv[i + 1]) opts.submitter = argv[++i];
    else if (arg === "--note" && argv[i + 1]) opts.note = argv[++i];
    else if (arg === "--dir" && argv[i + 1]) opts.dir = argv[++i];
    else if (arg === "--once" && argv[i + 1]) opts.once = argv[++i];
    else if (arg === "--interval-ms" && argv[i + 1]) opts.intervalMs = Math.max(500, Number(argv[++i]) || 3000);
    else if (arg === "--settle-ms" && argv[i + 1]) opts.settleMs = Math.max(200, Number(argv[++i]) || 1500);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`用法：
  1) 监听本地热文件夹（拖入文件即自动归档入库）：
     node scripts/kb-watch-drop.mjs \\
       --url "https://你的网关域名/p/default/drop/api/webhook" \\
       --passcode "你的投递口令" \\
       --dir "~/Jiebo-Drop/Fintopia集团" \\
       --submitter "Mac热文件夹"

  2) 单文件命令行一键直投：
     node scripts/kb-watch-drop.mjs \\
       --url "https://你的网关域名/p/default/drop/api/webhook" \\
       --passcode "你的投递口令" \\
       --once "./11月资金日报.xlsx" \\
       --note "11月最新日报"
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url || !opts.passcode || (!opts.dir && !opts.once)) {
    printHelp();
    process.exit(1);
  }

  if (opts.once) {
    const res = await uploadSingleFileToWebhook({
      webhookUrl: opts.url,
      passcode: opts.passcode,
      filePath: opts.once,
      submitter: opts.submitter,
      note: opts.note,
    });
    console.log(
      `[成功入队] 工作区：${res.workspaceTitle} | 批次号：${res.batchId} | 文件：${res.storedName} (${res.size} bytes) | 回执：${res.receiptToken}`,
    );
    return;
  }

  const watchDir = expandLocalPath(opts.dir);
  mkdirSync(watchDir, { recursive: true });
  console.log(`[接驳热文件夹] 正在监听目录：${watchDir}`);
  console.log(`[接驳热文件夹] 目标接口：${normalizeWebhookUrl(opts.url)}`);

  while (true) {
    try {
      const { uploaded, duplicates, failed } = await scanWatchFolderOnce({
        watchDir,
        webhookUrl: opts.url,
        passcode: opts.passcode,
        submitter: opts.submitter,
        note: opts.note,
        settleMs: opts.settleMs,
      });
      for (const item of uploaded) {
        console.log(`[已自动归档] ${item.fileName} -> 批次 ${item.batchId}（已移入 .archived/）`);
      }
      for (const dup of duplicates) {
        console.log(`[已跳过重复文件] ${dup}（已移入 .archived/）`);
      }
      for (const errItem of failed) {
        console.error(`[文件处理失败] ${errItem.fileName}：${errItem.error}`);
      }
    } catch (err) {
      console.error(`[同步异常] ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
