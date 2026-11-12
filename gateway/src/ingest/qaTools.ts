import type { SDKCustomTool, SDKCustomToolContext, SDKJsonValue } from "@cursor/sdk";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { queryColleagueFreeBusy } from "../assistant/calendarEvents.ts";
import {
  createCalendarProposal,
  createKnowledgeUpdateProposal,
  type ColleagueProposalChannel,
} from "../assistant/proposals.ts";
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
import { extractWorkspaceOfficePreviewSync } from "./officePreview.ts";
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

export const QA_READABLE_TEXT_EXTS = new Set([".html", ".md", ".txt", ".csv", ".json", ".sql"]);

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
    .replace(/&quot;/gi, '"')
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

  const keywords = cleanQuery.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);

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

    const searchableText = item.ext === ".html" ? extractReadableTextFromHtml(readRes.text) : readRes.text;
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
  opts: { startLine?: number; maxLines?: number; rawHtml?: boolean; citePrefix?: string } = {},
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
    const officePreview = extractWorkspaceOfficePreviewSync(workspaceDir, pathCheck.normalizedRel, QA_MAX_READ_RETURN_BYTES);
    if (officePreview) {
      if (log) {
        const citedItem = opts.citePrefix ? `${opts.citePrefix}:${pathCheck.normalizedRel}` : pathCheck.normalizedRel;
        if (!log.citedPaths.includes(citedItem)) {
          log.citedPaths.push(citedItem);
        }
      }
      const lines = officePreview.text.split(/\r?\n/);
      return {
        ok: true,
        relPath: pathCheck.normalizedRel,
        totalLines: lines.length,
        startLine: 1,
        endLine: lines.length,
        truncated: officePreview.truncated,
        content: officePreview.text,
      };
    }
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

  const fullText = ext === ".html" && !opts.rawHtml ? extractReadableTextFromHtml(readRes.text) : readRes.text;

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

  if (log) {
    const citedItem = opts.citePrefix ? `${opts.citePrefix}:${pathCheck.normalizedRel}` : pathCheck.normalizedRel;
    if (!log.citedPaths.includes(citedItem)) {
      log.citedPaths.push(citedItem);
    }
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
 * 构建挂载给 QA Runner 的 9 个受控 customTools（运行在网关进程内，每次调用均实时复核口令、工作区与会话关闭状态）
 */
export function buildQaCustomTools(ctx: {
  host: DropTenantHost;
  getSession: () => { ok: true; session: DropSessionGrant } | { ok: false; error: string };
  executionLog: QaToolExecutionLog;
  isClosed: () => boolean;
  sourceChannel?: ColleagueProposalChannel;
  sourcePeerId?: string;
}): Record<string, SDKCustomTool> {
  const { host, getSession, executionLog, isClosed, sourceChannel = "drop_portal", sourcePeerId } = ctx;

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

  const resolveWorkspaceForTool = (
    active: { session: DropSessionGrant; workspaceDir: string; config: KbWorkspaceConfig },
    requestedWorkspace?: string,
  ):
    | { ok: true; workspaceKey: string; workspaceDir: string; config: KbWorkspaceConfig }
    | { ok: false; error: string } => {
    const reqWs = (requestedWorkspace || "").trim();
    if (!reqWs) {
      return {
        ok: true,
        workspaceKey: active.session.workspaceKey,
        workspaceDir: active.workspaceDir,
        config: active.config,
      };
    }
    const authorized = active.session.authorizedWorkspaces ?? [];
    const matched = authorized.find(
      (w) =>
        w.workspaceId === reqWs || w.workspaceKey === reqWs || w.workspaceKey.toLowerCase() === reqWs.toLowerCase(),
    );
    if (!matched) {
      return {
        ok: false,
        error: `您的通行口令无权访问知识库 "${reqWs}"。当前获权知识库：${
          authorized.length > 0 ? authorized.map((w) => w.workspaceKey).join("、") : active.session.workspaceKey
        }`,
      };
    }
    const wsRef = host.resolveWorkspace(matched.workspaceId);
    if (!wsRef) {
      return { ok: false, error: `知识库工作区 "${matched.workspaceKey}" 已不存在` };
    }
    const kbLoaded = loadKbWorkspaceConfig(wsRef.path, host.workspaceRoot);
    if (!kbLoaded.ok) {
      return { ok: false, error: kbLoaded.error };
    }
    return {
      ok: true,
      workspaceKey: wsRef.key,
      workspaceDir: kbLoaded.workspaceRealPath,
      config: kbLoaded.config,
    };
  };

  return {
    kb_qa_list_files: makeTool(
      "列出知识库工作区白名单分类目录下的所有 HTML 汇总看板、归档文档清单及《归档说明.md》（只读，自动过滤隐藏系统目录；支持通过 workspace 参数查看该同事获权访问的其他知识库）。",
      {
        workspace: {
          type: "string",
          description:
            "可选，指定要查看的获权知识库工作区名称（如 'Fintopia集团' 或 'sannongxin'），留空则查看当前激活知识库。",
        },
        categoryOrDir: {
          type: "string",
          description:
            "可选，指定要查看的一级分类名或子目录相对路径（如 '资产' 或 '资产/洋钱罐（锋泰、瓴岳）'），留空则列出全部白名单分类。",
        },
      },
      [],
      (active, args) => {
        const ws = resolveWorkspaceForTool(active, str(args.workspace));
        if (!ws.ok) return ws;
        return executeKbQaListFiles(ws.workspaceDir, ws.config, str(args.categoryOrDir));
      },
    ),

    kb_qa_search: makeTool(
      "在知识库工作区的 HTML 看板与可读文本档案中按关键词搜索匹配内容片段（只读；支持通过 workspace 参数跨获权知识库检索）。",
      {
        query: {
          type: "string",
          description: "要检索的关键词（支持空格分隔多个词，长度 1–200 字符）",
        },
        workspace: {
          type: "string",
          description: "可选，指定要搜索的获权知识库工作区名称，留空则搜索当前激活知识库。",
        },
        categoryOrDir: {
          type: "string",
          description: "可选，限定搜索的一级分类或子目录相对路径",
        },
      },
      ["query"],
      (active, args) => {
        const ws = resolveWorkspaceForTool(active, str(args.workspace));
        if (!ws.ok) return ws;
        return executeKbQaSearch(ws.workspaceDir, ws.config, str(args.query), str(args.categoryOrDir));
      },
    ),

    kb_qa_read_file: makeTool(
      "安全只读读取知识库工作区内的同名 .html 看板（默认自动提取结构化纯文本与表格数据）或 .md/.csv/.txt/.json/.sql 文件（支持通过 workspace 参数读取获权的其他知识库）。",
      {
        relPath: {
          type: "string",
          description: "知识库内的相对路径，如 '资产/资产.html' 或 '归档说明.md'",
        },
        workspace: {
          type: "string",
          description: "可选，指定文件所属的获权知识库工作区名称，留空则读取当前激活知识库。",
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
      (active, args) => {
        const ws = resolveWorkspaceForTool(active, str(args.workspace));
        if (!ws.ok) return ws;
        const isCrossWs = ws.workspaceKey !== active.session.workspaceKey;
        return executeKbQaReadFile(
          ws.workspaceDir,
          ws.config,
          str(args.relPath),
          {
            startLine: args.startLine !== undefined ? num(args.startLine, 1) : undefined,
            maxLines: args.maxLines !== undefined ? num(args.maxLines, 250) : undefined,
            ...(isCrossWs ? { citePrefix: ws.workspaceKey } : {}),
          },
          executionLog,
        );
      },
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

        const readRes = safeReadQaFileSync(ensured.sessionDir, `${scope}/${nameCheck.cleanName}`, QA_MAX_FILE_BYTES);
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
          description:
            "要生成的临时文件名（不含路径斜杠），如 '知识库核心指标统计.csv'、'各主体风险对比报告.md' 或 '统计总览看板.html'",
        },
        content: {
          type: "string",
          description: "要写入的完整文本内容（UTF-8）",
        },
      },
      ["fileName", "content"],
      (active, args) => {
        const writeRes = writeQaTempOutputFileSync(host, active.session, str(args.fileName), str(args.content));
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

    colleague_calendar_freebusy: makeTool(
      "只读查询主人（Owner）在指定时间段内的日历忙闲状态（私人日程已自动脱敏显示为『忙碌』，公开日程显示标题）。当同事询问『周四下午有空吗』『哪天能约会』时调用。",
      {
        fromIso: {
          type: "string",
          description: "查询起始时间（带时区的 ISO 格式，如 '2026-11-12T09:00:00+08:00' 或日期 '2026-11-12'）",
        },
        toIso: {
          type: "string",
          description: "查询结束时间（带时区的 ISO 格式，如 '2026-11-12T18:00:00+08:00' 或日期 '2026-11-13'）",
        },
      },
      ["fromIso", "toIso"],
      (active, args) => {
        if (active.session.permissions?.calendarFreeBusy === false) {
          return { ok: false, error: "当前通行口令未开启日历忙闲查询权限" };
        }
        return queryColleagueFreeBusy(host, {
          fromIso: str(args.fromIso),
          toIso: str(args.toIso),
        });
      },
    ),

    colleague_propose_calendar_change: makeTool(
      "向主人发起一条『预约会议 / 修改日历安排』申请提案（不直接修改日历，生成审批卡推送给主人，主人点击批准后正式写入日历并通知申请人）。",
      {
        title: {
          type: "string",
          description: "会议或日程主题，如 '与王明过三农鑫风控方案'",
        },
        startIso: {
          type: "string",
          description: "开始时间（带时区的 ISO 格式，如 '2026-11-12T15:00:00+08:00'）",
        },
        endIso: {
          type: "string",
          description: "结束时间（带时区的 ISO 格式，如 '2026-11-12T16:00:00+08:00'）",
        },
        kind: {
          type: "string",
          enum: ["calendar_book", "calendar_reschedule"],
          description: "可选，'calendar_book'（新建预约，默认）或 'calendar_reschedule'（改期）",
        },
        targetEventId: {
          type: "string",
          description: "可选，改期时对应的原日程 ID（如 'ev_xxx'）",
        },
        location: {
          type: "string",
          description: "可选，会议地点或线上会议号",
        },
        notes: {
          type: "string",
          description: "可选，议题说明或补充备注",
        },
      },
      ["title", "startIso", "endIso"],
      (active, args) => {
        if (active.session.permissions?.calendarPropose === false) {
          return { ok: false, error: "当前通行口令未开启发起日历预约提案的权限" };
        }
        const res = createCalendarProposal(host, {
          tokenId: active.session.tokenId,
          proposerName: active.session.submitterName,
          sourceChannel,
          sourcePeerId,
          kind: str(args.kind) === "calendar_reschedule" ? "calendar_reschedule" : "calendar_book",
          targetEventId: str(args.targetEventId) || undefined,
          title: str(args.title),
          startIso: str(args.startIso),
          endIso: str(args.endIso),
          location: str(args.location) || undefined,
          notes: str(args.notes) || undefined,
        });
        if (!res.ok) return res;
        return {
          ok: true,
          proposalId: res.proposal.id,
          status: res.proposal.status,
          conflictWarning: res.conflictWarning,
          message: `已为您提交日程申请（提案号：${res.proposal.id}），等待主人批准后将正式写入日历并通知您。`,
        };
      },
    ),

    colleague_propose_knowledge_update: makeTool(
      "向主人发起一条『更新知识库数据 / 补充业务指标或文档』申请提案（不直接修改知识库，生成审批卡推送给主人，主人点击批准后自动合入知识库并更新 HTML 看板）。",
      {
        summary: {
          type: "string",
          description: "本次知识库更新的简明摘要，如 '更新洋钱罐11月最新撮合规模为18.5亿'",
        },
        content: {
          type: "string",
          description: "要合入知识库的完整结构化内容（Markdown 报告或 CSV 数据文本）",
        },
        workspace: {
          type: "string",
          description: "可选，目标知识库工作区名称（留空则为当前激活知识库）",
        },
        fileName: {
          type: "string",
          description: "可选，建议归档的文件名（如 '202611_洋钱罐最新撮合补充.md'）",
        },
      },
      ["summary", "content"],
      (active, args) => {
        if (active.session.permissions?.kbPropose === false) {
          return { ok: false, error: "当前通行口令未开启发起知识库更新提案的权限" };
        }
        const ws = resolveWorkspaceForTool(active, str(args.workspace));
        if (!ws.ok) return ws;
        const authorizedIds = (active.session.authorizedWorkspaces ?? []).map((w) => w.workspaceId);
        const res = createKnowledgeUpdateProposal(host, {
          tokenId: active.session.tokenId,
          proposerName: active.session.submitterName,
          sourceChannel,
          sourcePeerId,
          workspaceKeyOrId: ws.workspaceKey,
          fileName: str(args.fileName) || undefined,
          content: str(args.content),
          summary: str(args.summary),
          authorizedWorkspaceIds: authorizedIds.length > 0 ? authorizedIds : [active.session.workspaceId],
        });
        if (!res.ok) return res;
        return {
          ok: true,
          proposalId: res.proposal.id,
          status: res.proposal.status,
          targetWorkspace: ws.workspaceKey,
          message: `已生成知识库更新提案（提案号：${res.proposal.id}），等待主人批准后将自动归档入库并更新看板。`,
        };
      },
    ),
  };
}
