import type { SDKCustomTool, SDKCustomToolContext, SDKJsonValue } from "@cursor/sdk";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  fileExtension,
  isValidPathSegment,
  KB_POLICY_DOC_REL_PATH,
  loadKbWorkspaceConfig,
  safeReadWorkspaceTextFileSync,
  validateKbQaReadableRelPath,
  type KbWorkspaceConfig,
} from "./contract.ts";
import { scanWorkspaceKbHtmlBoards } from "./hub.ts";
import {
  ensureQaSessionStorageSync,
  isQaSessionClosed,
  measureQaSessionDiskUsageSync,
  QA_MAX_FILE_BYTES,
  safeReadQaFileSync,
  validateQaTempFileName,
  writeQaTempOutputFileSync,
  type QaTempFileItem,
} from "./qaStorage.ts";
import type { DropSessionGrant, DropTenantHost } from "./tokens.ts";
import { MAX_KB_HTML_BYTES } from "./tools.ts";

export const QA_READABLE_TEXT_EXTS = new Set([
  ".html",
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".sql",
]);

export const QA_MAX_READ_RETURN_BYTES = 64 * 1024;
export const QA_MAX_SEARCH_SCAN_BYTES = 16 * 1024 * 1024;
export const QA_MAX_SEARCH_MATCHES = 50;
export const QA_MAX_LIST_ITEMS = 200;

export type QaToolExecutionLog = {
  citedPaths: string[];
  generatedFiles: QaTempFileItem[];
};

type Args = Record<string, SDKJsonValue>;

const str = (value: SDKJsonValue | undefined): string => (typeof value === "string" ? value : "");
const num = (value: SDKJsonValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;

/**
 * 将知识库 HTML 看板压缩提炼为结构化纯文本摘要（剥离 `<style>`、注释与冗余标签，保留标题、表格单元格与段落换行），
 * 大幅降低模型读取大型内联 CSS 看板时的上下文 Token 消耗。
 */
export function extractReadableTextFromHtml(htmlContent: string): string {
  return htmlContent
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<\/(tr|p|div|h[1-6]|li|section|article|header|footer)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 按 UTF-8 字节上限安全截断字符串（不切碎多字节中文或 surrogate pair） */
function truncateUtf8Safe(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const buf = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: buf.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

/**
 * 枚举知识库白名单分类目录下的文件与同名 HTML 看板（纯白名单，拒绝任何隐藏段、符号链接与硬链接）
 */
export function executeKbQaListFiles(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  subCategoryOrDir?: string,
  opts: { onlyReadableText?: boolean } = {},
):
  | {
      ok: true;
      workspaceTitle: string;
      allowedCategories: string[];
      boards: Array<{ relPath: string; title: string; category: string; level: string; updatedAt: number }>;
      files: Array<{ relPath: string; size: number; ext: string; readableAsText: boolean }>;
      truncated: boolean;
    }
  | { ok: false; error: string } {
  const boards = scanWorkspaceKbHtmlBoards(workspaceDir, config);
  const files: Array<{ relPath: string; size: number; ext: string; readableAsText: boolean }> = [];
  let truncated = false;

  // 检查根级《归档说明.md》
  if (!subCategoryOrDir || !subCategoryOrDir.trim()) {
    const policyCheck = validateKbQaReadableRelPath(workspaceDir, config, KB_POLICY_DOC_REL_PATH, "file");
    if (policyCheck.ok && existsSync(policyCheck.absPath)) {
      try {
        const st = lstatSync(policyCheck.absPath);
        if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) {
          files.push({
            relPath: KB_POLICY_DOC_REL_PATH,
            size: st.size,
            ext: ".md",
            readableAsText: true,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  const walkDir = (relDir: string, depth: number) => {
    if (depth > 8 || files.length >= QA_MAX_LIST_ITEMS) {
      if (files.length >= QA_MAX_LIST_ITEMS) truncated = true;
      return;
    }
    const dirCheck = validateKbQaReadableRelPath(workspaceDir, config, relDir, "dir");
    if (!dirCheck.ok || !existsSync(dirCheck.absPath)) return;

    let names: string[] = [];
    try {
      const dst = lstatSync(dirCheck.absPath);
      if (dst.isSymbolicLink() || !dst.isDirectory()) return;
      names = readdirSync(dirCheck.absPath).sort();
    } catch {
      return;
    }

    for (const name of names) {
      if (files.length >= QA_MAX_LIST_ITEMS) {
        truncated = true;
        return;
      }
      if (!name || name.startsWith(".") || !isValidPathSegment(name)) continue;
      const lower = name.toLowerCase();
      if (lower === "agents.md" || lower === "claude.md") continue;

      const childRel = `${dirCheck.normalizedRel}/${name}`;
      const childAbs = resolve(dirCheck.absPath, name);
      try {
        const st = lstatSync(childAbs);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          walkDir(childRel, depth + 1);
        } else if (st.isFile() && st.nlink === 1) {
          const ext = fileExtension(name);
          const readableAsText = QA_READABLE_TEXT_EXTS.has(ext);
          if (opts.onlyReadableText && !readableAsText) continue;
          files.push({
            relPath: childRel,
            size: st.size,
            ext,
            readableAsText,
          });
        }
      } catch {
        // ignore
      }
    }
  };

  const targetRel = (subCategoryOrDir || "").trim().replace(/^\/+|\/+$/g, "");
  if (targetRel) {
    const check = validateKbQaReadableRelPath(workspaceDir, config, targetRel, "dir");
    if (!check.ok) return check;
    walkDir(check.normalizedRel, check.normalizedRel.split("/").length);
  } else {
    for (const cat of config.allowedCategories) {
      walkDir(cat, 1);
      if (files.length >= QA_MAX_LIST_ITEMS) break;
    }
  }

  return {
    ok: true,
    workspaceTitle: config.title,
    allowedCategories: config.allowedCategories,
    boards,
    files,
    truncated,
  };
}

/**
 * 在知识库白名单分类目录下的可读文本与 HTML 看板中搜索关键词（纯 Node 逐文件安全扫描，禁调外部 grep/rg 防软链穿越）
 */
export function executeKbQaSearch(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  query: string,
  categoryFilter?: string,
):
  | {
      ok: true;
      query: string;
      matches: Array<{ relPath: string; line: number; snippet: string }>;
      scannedFiles: number;
      truncated: boolean;
    }
  | { ok: false; error: string } {
  const cleanQuery = query.trim();
  if (!cleanQuery || cleanQuery.length > 200) {
    return { ok: false, error: "搜索关键词长度需在 1–200 字符之间" };
  }

  const listed = executeKbQaListFiles(workspaceDir, config, categoryFilter, { onlyReadableText: true });
  if (!listed.ok) return listed;

  const keywords = cleanQuery
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  const matches: Array<{ relPath: string; line: number; snippet: string }> = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  let truncated = listed.truncated;
  const deadline = Date.now() + 3000;

  for (const item of listed.files) {
    if (!item.readableAsText) continue;
    if (Date.now() > deadline || scannedBytes >= QA_MAX_SEARCH_SCAN_BYTES || matches.length >= QA_MAX_SEARCH_MATCHES) {
      truncated = true;
      break;
    }
    const maxFileRead = item.ext === ".html" ? MAX_KB_HTML_BYTES + 64 * 1024 : 512 * 1024;
    if (item.size > maxFileRead) continue;

    const readRes = safeReadWorkspaceTextFileSync(workspaceDir, item.relPath, maxFileRead);
    if (!readRes.ok) continue;

    scannedFiles += 1;
    scannedBytes += Buffer.byteLength(readRes.text, "utf8");

    const searchableText =
      item.ext === ".html" ? extractReadableTextFromHtml(readRes.text) : readRes.text;
    const lines = searchableText.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i].trim();
      if (!lineText) continue;
      const lowerLine = lineText.toLowerCase();
      if (keywords.some((kw) => lowerLine.includes(kw))) {
        matches.push({
          relPath: item.relPath,
          line: i + 1,
          snippet: lineText.slice(0, 240),
        });
        if (matches.length >= QA_MAX_SEARCH_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
  }

  return {
    ok: true,
    query: cleanQuery,
    matches,
    scannedFiles,
    truncated,
  };
}

/**
 * 安全读取知识库白名单内的单个文件（支持对 `.html` 看板自动提取可读纯文本/表格摘要，对二进制底表引导读取同目录同名 `.html` 看板）
 */
export function executeKbQaReadFile(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  relPath: string,
  opts: { startLine?: number; maxLines?: number; rawHtml?: boolean } = {},
  log?: QaToolExecutionLog,
):
  | {
      ok: true;
      relPath: string;
      totalLines: number;
      startLine: number;
      endLine: number;
      truncated: boolean;
      content: string;
    }
  | { ok: false; error: string; suggestedBoardPath?: string } {
  const pathCheck = validateKbQaReadableRelPath(workspaceDir, config, relPath, "file");
  if (!pathCheck.ok) return pathCheck;

  const ext = fileExtension(pathCheck.normalizedRel);
  if (!QA_READABLE_TEXT_EXTS.has(ext)) {
    const parts = pathCheck.normalizedRel.split("/");
    const parentDir = parts.length >= 2 ? parts.slice(0, -1).join("/") : parts[0];
    const dirName = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const suggestedBoardPath = `${parentDir}/${dirName}.html`;
    return {
      ok: false,
      error: `文件 "${pathCheck.normalizedRel}" 为二进制归档格式（${ext}），不支持直接按纯文本读取。请优先读取同目录下的知识库汇总看板 "${suggestedBoardPath}" 或顶层分类看板 "${parts[0]}/${parts[0]}.html"。`,
      suggestedBoardPath,
    };
  }

  const maxReadBytes = ext === ".html" ? MAX_KB_HTML_BYTES + 64 * 1024 : 1024 * 1024;
  const readRes = safeReadWorkspaceTextFileSync(workspaceDir, pathCheck.normalizedRel, maxReadBytes);
  if (!readRes.ok) return readRes;

  const fullText =
    ext === ".html" && !opts.rawHtml
      ? extractReadableTextFromHtml(readRes.text)
      : readRes.text;

  const allLines = fullText.split(/\r?\n/);
  const totalLines = allLines.length;
  const startLine = Math.max(1, opts.startLine ?? 1);
  const maxLines = Math.min(500, Math.max(10, opts.maxLines ?? 250));
  const sliceLines = allLines.slice(startLine - 1, startLine - 1 + maxLines);

  let content = sliceLines.join("\n");
  let truncated = startLine - 1 + sliceLines.length < totalLines;
  const utf8Clipped = truncateUtf8Safe(content, QA_MAX_READ_RETURN_BYTES);
  if (utf8Clipped.truncated) {
    content = `${utf8Clipped.text}\n…（单次返回已截断至 64KB，请传入 startLine 分段读取）`;
    truncated = true;
  }

  if (log && !log.citedPaths.includes(pathCheck.normalizedRel)) {
    log.citedPaths.push(pathCheck.normalizedRel);
  }

  return {
    ok: true,
    relPath: pathCheck.normalizedRel,
    totalLines,
    startLine,
    endLine: Math.min(totalLines, startLine + sliceLines.length - 1),
    truncated,
    content,
  };
}

/**
 * 构建挂载给 QA Runner 的 6 个受控 customTools（运行在网关进程内，每次调用均实时复核口令、工作区与会话关闭状态）
 */
export function buildQaCustomTools(ctx: {
  host: DropTenantHost;
  getSession: () => { ok: true; session: DropSessionGrant } | { ok: false; error: string };
  executionLog: QaToolExecutionLog;
  isClosed: () => boolean;
}): Record<string, SDKCustomTool> {
  const { host, getSession, executionLog, isClosed } = ctx;

  const resolveActiveWorkspaceAndSession = ():
    | {
        ok: true;
        session: DropSessionGrant;
        workspaceDir: string;
        config: KbWorkspaceConfig;
      }
    | { ok: false; error: string } => {
    if (isClosed()) {
      return { ok: false, error: "当前问答运行已结束、超时或被取消，禁止继续调用工具" };
    }
    const sessRes = getSession();
    if (!sessRes.ok) {
      return { ok: false, error: sessRes.error };
    }
    if (isQaSessionClosed(sessRes.session.qaSessionId)) {
      return { ok: false, error: "当前问答会话已关闭或口令已被吊销" };
    }
    const wsRef = host.resolveWorkspace(sessRes.session.workspaceId);
    if (!wsRef) {
      return { ok: false, error: "目标知识库工作区已不存在" };
    }
    const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
    if (!kbLoaded.ok) {
      return { ok: false, error: kbLoaded.error };
    }
    return {
      ok: true,
      session: sessRes.session,
      workspaceDir: kbLoaded.workspaceRealPath,
      config: kbLoaded.config,
    };
  };

  const makeTool = (
    description: string,
    properties: Record<string, SDKJsonValue>,
    required: string[],
    run: (
      active: { session: DropSessionGrant; workspaceDir: string; config: KbWorkspaceConfig },
      args: Args,
    ) => unknown,
  ): SDKCustomTool => ({
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    execute: async (args, _context: SDKCustomToolContext) => {
      const active = resolveActiveWorkspaceAndSession();
      if (!active.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: active.error }) }],
          isError: true,
        };
      }
      try {
        const res = await run(active, args ?? {});
        return typeof res === "string" ? res : JSON.stringify(res);
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  });

  return {
    kb_qa_list_files: makeTool(
      "列出当前知识库工作区白名单分类目录下的所有 HTML 汇总看板、归档文档清单及《归档说明.md》（只读，自动过滤隐藏系统目录）。",
      {
        categoryOrDir: {
          type: "string",
          description: "可选，指定要查看的一级分类名或子目录相对路径（如 '资产' 或 '资产/洋钱罐（锋泰、瓴岳）'），留空则列出全部白名单分类。",
        },
      },
      [],
      (active, args) => executeKbQaListFiles(active.workspaceDir, active.config, str(args.categoryOrDir)),
    ),

    kb_qa_search: makeTool(
      "在当前知识库工作区的 HTML 看板与可读文本档案中按关键词搜索匹配内容片段（只读）。",
      {
        query: {
          type: "string",
          description: "要检索的关键词（支持空格分隔多个词，长度 1–200 字符）",
        },
        categoryOrDir: {
          type: "string",
          description: "可选，限定搜索的一级分类或子目录相对路径",
        },
      },
      ["query"],
      (active, args) =>
        executeKbQaSearch(active.workspaceDir, active.config, str(args.query), str(args.categoryOrDir)),
    ),

    kb_qa_read_file: makeTool(
      "安全只读读取知识库工作区内的同名 .html 看板（默认自动提取结构化纯文本与表格数据）或 .md/.csv/.txt/.json/.sql 文件。",
      {
        relPath: {
          type: "string",
          description: "知识库内的相对路径，如 '资产/资产.html' 或 '归档说明.md'",
        },
        startLine: {
          type: "number",
          description: "可选，起始行号（从 1 开始，默认 1）",
        },
        maxLines: {
          type: "number",
          description: "可选，本次读取的最大行数（默认 250，最大 500）",
        },
      },
      ["relPath"],
      (active, args) =>
        executeKbQaReadFile(
          active.workspaceDir,
          active.config,
          str(args.relPath),
          {
            startLine: args.startLine !== undefined ? num(args.startLine, 1) : undefined,
            maxLines: args.maxLines !== undefined ? num(args.maxLines, 250) : undefined,
          },
          executionLog,
        ),
    ),

    kb_qa_temp_list: makeTool(
      "列出当前问答会话独立临时目录（工作区外）中用户上传的临时比对附件（uploads/）与 AI 已生成的临时统计文件（outputs/）。",
      {},
      [],
      (active) => {
        const ensured = ensureQaSessionStorageSync(host, active.session);
        if (!ensured.ok) return { ok: false, error: ensured.error };
        const usage = measureQaSessionDiskUsageSync(ensured.sessionDir);
        return {
          ok: true,
          fileCount: usage.fileCount,
          totalBytes: usage.totalBytes,
          files: usage.files,
        };
      },
    ),

    kb_qa_temp_read: makeTool(
      "读取当前问答会话独立临时目录（uploads/ 或 outputs/）中的单个文本文件内容（支持高达 4MB 的比对附件，按行分页返回，单次最多返回 64KB）。",
      {
        scope: {
          type: "string",
          enum: ["uploads", "outputs"],
          description: "文件所在临时子目录：'uploads'（访客上传的临时附件）或 'outputs'（AI 生成的临时文件）",
        },
        fileName: {
          type: "string",
          description: "单段文件名，如 '比对样本.csv'",
        },
        startLine: {
          type: "number",
          description: "可选，起始行号（从 1 开始，默认 1）",
        },
        maxLines: {
          type: "number",
          description: "可选，本次读取的最大行数（默认 250，最大 500）",
        },
      },
      ["scope", "fileName"],
      (active, args) => {
        const scope = str(args.scope) === "outputs" ? "outputs" : "uploads";
        const nameCheck = validateQaTempFileName(str(args.fileName), scope);
        if (!nameCheck.ok) return nameCheck;

        const ensured = ensureQaSessionStorageSync(host, active.session);
        if (!ensured.ok) return { ok: false, error: ensured.error };

        const readRes = safeReadQaFileSync(
          ensured.sessionDir,
          `${scope}/${nameCheck.cleanName}`,
          QA_MAX_FILE_BYTES,
        );
        if (!readRes.ok) return readRes;

        const fullText = readRes.buffer.toString("utf8");
        const allLines = fullText.split(/\r?\n/);
        const totalLines = allLines.length;
        const startLine = Math.max(1, args.startLine !== undefined ? num(args.startLine, 1) : 1);
        const maxLines = Math.min(500, Math.max(10, args.maxLines !== undefined ? num(args.maxLines, 250) : 250));
        const sliceLines = allLines.slice(startLine - 1, startLine - 1 + maxLines);

        let content = sliceLines.join("\n");
        let truncated = startLine - 1 + sliceLines.length < totalLines;
        const utf8Clipped = truncateUtf8Safe(content, QA_MAX_READ_RETURN_BYTES);
        if (utf8Clipped.truncated) {
          content = `${utf8Clipped.text}\n…（单次返回已截断至 64KB，请传入 startLine 分段读取）`;
          truncated = true;
        }

        return {
          ok: true,
          scope,
          fileName: nameCheck.cleanName,
          totalLines,
          startLine,
          endLine: Math.min(totalLines, startLine + sliceLines.length - 1),
          truncated,
          content,
        };
      },
    ),

    kb_qa_temp_write: makeTool(
      [
        "在工作区外的问答专属临时目录（outputs/<fileName>）中生成统计表格、汇总报告或静态可视化 HTML 看板供用户在线预览与下载。",
        "安全铁律：1) 绝对不会修改知识库工作区本身的任何文件；2) 允许后缀：.csv（自动加 UTF-8 BOM 供 Excel 直接打开中文）、.md、.txt、.json、.sql、.html（若写 .html 必须为纯静态单文件内联 HTML+CSS，严禁包含任何 <script>、<iframe>、on* 事件或外链）；3) 单文件 ≤ 4MB，单会话最多 20 个文件。",
      ].join(""),
      {
        fileName: {
          type: "string",
          description: "要生成的临时文件名（不含路径斜杠），如 '知识库核心指标统计.csv'、'各主体风险对比报告.md' 或 '统计总览看板.html'",
        },
        content: {
          type: "string",
          description: "要写入的完整文本内容（UTF-8）",
        },
      },
      ["fileName", "content"],
      (active, args) => {
        const writeRes = writeQaTempOutputFileSync(
          host,
          active.session,
          str(args.fileName),
          str(args.content),
        );
        if (!writeRes.ok) return writeRes;

        const idx = executionLog.generatedFiles.findIndex((f) => f.name === writeRes.file.name);
        if (idx >= 0) {
          executionLog.generatedFiles[idx] = writeRes.file;
        } else {
          executionLog.generatedFiles.push(writeRes.file);
        }

        return {
          ok: true,
          fileName: writeRes.file.name,
          size: writeRes.file.size,
          ext: writeRes.file.ext,
          message: "已写入独立问答临时目录 outputs/，用户可在对话框直接预览或下载，过期将自动清理",
        };
      },
    ),
  };
}
