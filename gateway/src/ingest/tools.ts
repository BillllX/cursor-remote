import type { SDKCustomTool, SDKCustomToolContext, SDKJsonValue } from "@cursor/sdk";
import { existsSync, linkSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  KB_POLICY_DOC_REL_PATH,
  safeMkdirInWorkspaceSync,
  safeReadWorkspaceTextFileSync,
  safeWriteWorkspaceFileSync,
  validateArchiveTargetRelPath,
  validateKbHtmlRelPath,
  type KbWorkspaceConfig,
} from "./contract.ts";
import { extractWorkspaceOfficePreviewSync } from "./officePreview.ts";
import { validateBatchSourceFile, type DropBatchMeta } from "./staging.ts";

export const MAX_KB_HTML_BYTES = 2 * 1024 * 1024;

export type IngestToolExecutionLog = {
  movedFiles: Array<{ from: string; to: string; category: string }>;
  updatedHtmls: string[];
};

type Args = Record<string, SDKJsonValue>;

const str = (value: SDKJsonValue | undefined): string => (typeof value === "string" ? value : "");

/**
 * 解码 HTML 字符实体（十进制、十六进制、命名实体）与 CSS 反斜杠十六进制转义（如 \68 ttps），并剥离空白与控制字符，
 * 彻底消除通过编码或拆字绕过关键字检查的可能。
 */
function decodeHtmlAndCssEscapesCompact(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&quot;?/gi, '"')
    .replace(/&apos;?/gi, "'")
    .replace(/&amp;?/gi, "&")
    .replace(/&lt;?/gi, "<")
    .replace(/&gt;?/gi, ">")
    .replace(/&colon;?/gi, ":")
    .replace(/&sol;?/gi, "/")
    .replace(/&bsol;?/gi, "\\")
    .replace(/&lpar;?/gi, "(")
    .replace(/&rpar;?/gi, ")")
    .replace(/&tab;?/gi, "")
    .replace(/&newline;?/gi, "")
    .replace(/\/\*|\*\//g, "")
    .replace(/\\(?:\r\n|[\r\n\f])/g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/\\([^\r\n0-9a-f])/gi, "$1")
    .replace(/[\0-\x20\x7f]+/g, "");
}

/**
 * 校验知识库内联 HTML 内容的安全性与基本完整性：
 * 1. 非空且不超过 2MB；
 * 2. 必须包含基本的 HTML 结构标签（`<html` 或 `<!doctype` 或 `<body`）；
 * 3. 严禁包含 `<script`、`<iframe`、`<frame`、`<object`、`<embed`、`<applet`、`<base`、`<form`、`<link`、`<audio`、`<video`、`<source`；
 * 4. 严禁包含内联事件处理器（`onerror=`、`onload=`、`onclick=` 等 `on[a-z]+=`）；
 * 5. 对解码 HTML 实体与 CSS 转义并剥离空白后的文本：
 *    - 严禁包含 `@import`；
 *    - 严禁包含 `javascript:`、`vbscript:`、`http-equiv=refresh`；
 *    - `data:` URI 仅允许 `data:image/(png|jpeg|jpg|gif|webp);base64,`（严禁 `data:text/html`、`data:application/xhtml+xml`、`data:image/svg+xml` 等可执行或主动载荷）；
 *    - 严禁在标签属性（`src`/`href`/`srcset`/`action`/`formaction`/`poster`/`background`）或 CSS `url(...)` 中出现任何 `http:`、`https:` 或 `//` 协议相对外链。
 */
export function validateKbHtmlContentSafety(
  htmlContent: string,
): { ok: true; byteLength: number } | { ok: false; error: string } {
  const trimmed = htmlContent.trim();
  if (!trimmed) {
    return { ok: false, error: "HTML 内容不能为空" };
  }
  const byteLength = Buffer.byteLength(htmlContent, "utf8");
  if (byteLength > MAX_KB_HTML_BYTES) {
    return { ok: false, error: `HTML 体积（${byteLength} bytes）超过单文件 2MB 上限` };
  }
  if (!/(<!doctype\s+html|<html\b|<body\b)/i.test(trimmed)) {
    return { ok: false, error: "HTML 内容缺少基本的文档结构标签（<html> 或 <body>）" };
  }
  if (
    /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|base|form|link|audio|video|source|set|animate|animateTransform|animateMotion|foreignObject)\b/i.test(
      htmlContent,
    )
  ) {
    return {
      ok: false,
      error:
        "知识库 HTML 为纯静态内联看板，严禁包含 <script>、<iframe>、<object>、<embed>、<base>、<form>、<link> 或 SVG <set>/<animate> 动画标签",
    };
  }
  if (/[\s"'/<]on[a-z]{2,32}\s*=/i.test(htmlContent)) {
    return { ok: false, error: "知识库 HTML 严禁包含 on* 内联事件处理属性（如 onerror、onload、onclick）" };
  }

  const decodedCompact = decodeHtmlAndCssEscapesCompact(htmlContent).toLowerCase();

  if (decodedCompact.includes("@import")) {
    return { ok: false, error: "知识库 HTML 严禁包含 CSS @import 外部样式导入" };
  }
  if (decodedCompact.includes("javascript:") || decodedCompact.includes("vbscript:")) {
    return { ok: false, error: "知识库 HTML 严禁包含 javascript: 或 vbscript: 伪协议（含实体/CSS转义形式）" };
  }
  if (/http-equiv=["']?refresh/i.test(decodedCompact)) {
    return { ok: false, error: "知识库 HTML 严禁包含 meta refresh 自动跳转" };
  }
  // 检查所有 data: URI，仅允许纯位图 data:image/(png|jpeg|jpg|gif|webp);base64,
  for (const match of decodedCompact.matchAll(/data:([a-z0-9.+/-]+)/g)) {
    const mime = match[1] || "";
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(mime)) {
      return { ok: false, error: `知识库 HTML 严禁包含非位图 data: URI（检测到 data:${mime}）` };
    }
  }
  if (
    /(?:src|href|srcset|action|formaction|poster|background|cite|data|to|from|values)\s*=\s*["']?(?:https?:|\/\/)/i.test(
      decodedCompact,
    )
  ) {
    return {
      ok: false,
      error: "知识库 HTML 必须为单文件全内联，严禁在 src/href 等属性中引用外部 http(s):// 或 // 资源",
    };
  }
  // 在原始 htmlContent 上提取所有属性原始值（不限属性名），单独解码检查，严禁在任何 HTML/SVG 属性值中出现 http(s): 或 // 外链
  for (const m of htmlContent.matchAll(/\b([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const rawAttrVal = m[2] ?? m[3] ?? m[4] ?? "";
    const decodedAttrVal = decodeHtmlAndCssEscapesCompact(rawAttrVal).toLowerCase();
    if (/(?:https?:|\/\/[a-z0-9.-])/i.test(decodedAttrVal)) {
      return { ok: false, error: `知识库 HTML 属性 "${m[1]}" 严禁引用任何外部网络资源` };
    }
  }
  // 检查每个 <style>...</style> 闭合块内部：开始标签严格要求为 <style> 或 <style type="text/css">（严禁在 <style 开始标签内夹带其他含 > 的属性），结束标签严格为 </style>
  const stylePairs = [
    ...htmlContent.matchAll(/<style(?:\s+type\s*=\s*(?:"text\/css"|'text\/css'))?\s*>([\s\S]*?)<\/style\s*>/gi),
  ];
  const anyRawStyleOpen = (htmlContent.match(/<\s*style/gi) || []).length;
  const anyRawStyleClose = (htmlContent.match(/<\/\s*style/gi) || []).length;
  if (anyRawStyleOpen !== stylePairs.length || anyRawStyleClose !== stylePairs.length) {
    return { ok: false, error: "知识库 HTML 存在畸形、带复杂属性或未闭合的 <style> 标签" };
  }
  for (const m of stylePairs) {
    const cssBlock = decodeHtmlAndCssEscapesCompact(m[1] || "").toLowerCase();
    if (/(?:https?:|\/\/[a-z0-9.-])/i.test(cssBlock)) {
      return { ok: false, error: "知识库 HTML <style> 样式块内严禁引用任何外部网络资源" };
    }
  }

  return { ok: true, byteLength };
}

/**
 * 执行受限的归档文件移动（仅允许将当前批次 `inbox/<batchId>/` 清单内的文件移入 `kb.json` 白名单分类目录）：
 * 1. `allowedSourceRels` 为必传参数，源路径必须属于当前 `batchId` 的 `meta.files` 清单，且真实存在、非符号链接、非 `meta.json`；
 * 2. 目标路径必须通过 `validateArchiveTargetRelPath`（第一级目录在 `allowedCategories` 内、禁止覆盖保留文件或同名 `.html`、后缀合法）；
 * 3. 使用 POSIX `linkSync(src, dst)` + `unlinkSync(src)`：若 `unlinkSync` 失败则立即回滚删除刚创建的 `dst` 硬链接并返回错误，绝不留下源与目标并存的不一致状态。
 */
export function executeIngestMoveFile(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  batchId: string,
  fromRelPath: string,
  toRelPath: string,
  allowedSourceRels: ReadonlySet<string>,
  log?: IngestToolExecutionLog,
): { ok: true; from: string; to: string; category: string } | { ok: false; error: string } {
  const srcCheck = validateBatchSourceFile(workspaceDir, batchId, fromRelPath);
  if (!srcCheck.ok) return srcCheck;

  if (!allowedSourceRels.has(srcCheck.normalizedRel)) {
    return { ok: false, error: `源文件不在当前批次登记清单中：${srcCheck.normalizedRel}` };
  }

  let srcStat;
  try {
    srcStat = lstatSync(srcCheck.absPath);
  } catch {
    return { ok: false, error: `源文件不存在：${srcCheck.normalizedRel}` };
  }
  if (srcStat.isSymbolicLink() || !srcStat.isFile()) {
    return { ok: false, error: "源文件不是合法的普通文件" };
  }

  const dstCheck = validateArchiveTargetRelPath(workspaceDir, config, toRelPath);
  if (!dstCheck.ok) return dstCheck;

  const srcExt = srcCheck.storedName.slice(srcCheck.storedName.lastIndexOf(".")).toLowerCase();
  const dstExt = dstCheck.normalizedRel.slice(dstCheck.normalizedRel.lastIndexOf(".")).toLowerCase();
  if (srcExt !== dstExt) {
    return {
      ok: false,
      error: `移动归档文件时禁止更改文件扩展名（源后缀 "${srcExt}"，目标后缀 "${dstExt}"）`,
    };
  }

  const parentRel = dirname(dstCheck.normalizedRel).replace(/\\/g, "/");
  const mkdirRes = safeMkdirInWorkspaceSync(workspaceDir, parentRel);
  if (!mkdirRes.ok) return mkdirRes;

  const stemRel = dstCheck.normalizedRel.slice(0, dstCheck.normalizedRel.length - dstExt.length);
  let finalRelPath = dstCheck.normalizedRel;
  let finalAbsPath = dstCheck.absPath;
  let linked = false;

  for (let seq = 1; seq <= 200; seq++) {
    const candidateRel = seq === 1 ? dstCheck.normalizedRel : `${stemRel}_${seq}${dstExt}`;
    const candidateCheck = validateArchiveTargetRelPath(workspaceDir, config, candidateRel);
    if (!candidateCheck.ok) return candidateCheck;

    const srcRecheck = validateBatchSourceFile(workspaceDir, batchId, fromRelPath);
    if (!srcRecheck.ok || srcRecheck.absPath !== srcCheck.absPath) {
      return { ok: false, error: "源文件路径复核不一致" };
    }

    try {
      linkSync(srcCheck.absPath, candidateCheck.absPath);
      finalRelPath = candidateCheck.normalizedRel;
      finalAbsPath = candidateCheck.absPath;
      linked = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        continue;
      }
      return { ok: false, error: "移动归档文件失败" };
    }
  }

  if (!linked) {
    return { ok: false, error: "目标位置同名文件过多，无法完成归档移动" };
  }

  try {
    unlinkSync(srcCheck.absPath);
  } catch (unlinkErr) {
    // 若删除 inbox 源文件失败，立即回滚删除目标硬链接，并检查回滚是否成功
    try {
      unlinkSync(finalAbsPath);
      return { ok: false, error: "清理收件箱源文件失败，已回滚本次文件移动" };
    } catch (rollbackErr) {
      return {
        ok: false,
        error: `清理收件箱源文件失败（${unlinkErr instanceof Error ? unlinkErr.message : "ERR"}），且回滚目标硬链接失败（${rollbackErr instanceof Error ? rollbackErr.message : "ERR"}）`,
      };
    }
  }

  const movedRecord = {
    from: srcCheck.normalizedRel,
    to: finalRelPath,
    category: dstCheck.category,
  };
  if (log && !log.movedFiles.some((m) => m.from === movedRecord.from)) {
    log.movedFiles.push(movedRecord);
  }

  return {
    ok: true,
    ...movedRecord,
  };
}

export type IngestHtmlPatch = {
  oldText: string;
  newText: string;
};

/**
 * 执行受限的知识库同名 HTML 更新（支持整页写入 `htmlContent` 或局部增量替换 `patches`）：
 * 1. 目标路径必须满足 `<category>/<category>.html` 或 `<category>/<sub>/<sub>.html`；
 * 2. 若原 HTML 已存在，先通过 `safeReadWorkspaceTextFileSync` 将旧文件内容读入内存快照；
 * 3. 若传入 `patches`，在原 HTML 文本上按序精确替换每个 `oldText -> newText`（避免模型每次重新生成数万字完整 HTML 导致超时）；
 * 4. 对最终完整 HTML 执行 `validateKbHtmlContentSafety` 安全校验；
 * 5. 通过 `safeWriteWorkspaceFileSync` 写入新内容，若失败则用内存快照恢复并校验恢复结果。
 */
export function executeIngestUpdateHtml(
  workspaceDir: string,
  config: KbWorkspaceConfig,
  htmlRelPath: string,
  htmlContent?: string,
  log?: IngestToolExecutionLog,
  now = Date.now(),
  patches?: IngestHtmlPatch[],
): { ok: true; path: string; bytes: number; backedUp: boolean; mode: "full" | "patch" } | { ok: false; error: string } {
  const pathCheck = validateKbHtmlRelPath(workspaceDir, config, htmlRelPath);
  if (!pathCheck.ok) return pathCheck;

  const parentRel = dirname(pathCheck.normalizedRel).replace(/\\/g, "/");
  const mkdirRes = safeMkdirInWorkspaceSync(workspaceDir, parentRel);
  if (!mkdirRes.ok) return mkdirRes;

  let previousHtmlSnapshot: string | null = null;
  if (existsSync(pathCheck.absPath)) {
    const prevRead = safeReadWorkspaceTextFileSync(
      workspaceDir,
      pathCheck.normalizedRel,
      MAX_KB_HTML_BYTES + 64 * 1024,
    );
    if (!prevRead.ok) {
      return { ok: false, error: `读取现有知识库 HTML 失败（${prevRead.error}），已中止更新以保护原文件` };
    }
    previousHtmlSnapshot = prevRead.text;
  }

  let candidateHtml = "";
  let mode: "full" | "patch" = "full";

  if (Array.isArray(patches) && patches.length > 0) {
    mode = "patch";
    if (previousHtmlSnapshot === null) {
      return {
        ok: false,
        error: `目标知识库 HTML（${pathCheck.normalizedRel}）尚不存在，无法使用 patches 增量替换，请传入完整的 htmlContent 创建页面`,
      };
    }
    let working = previousHtmlSnapshot;
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i];
      const oldText = typeof p?.oldText === "string" ? p.oldText : "";
      const newText = typeof p?.newText === "string" ? p.newText : "";
      if (!oldText) {
        return { ok: false, error: `patches[${i}].oldText 不能为空` };
      }
      const idx = working.indexOf(oldText);
      if (idx === -1) {
        return {
          ok: false,
          error: `patches[${i}].oldText 在现有 ${pathCheck.normalizedRel} 中未找到匹配片段（请确认与 read 读取的原文完全一致）`,
        };
      }
      working = `${working.slice(0, idx)}${newText}${working.slice(idx + oldText.length)}`;
    }
    candidateHtml = working;
  } else if (typeof htmlContent === "string" && htmlContent.trim()) {
    candidateHtml = htmlContent;
  } else {
    return {
      ok: false,
      error: "请提供非空的 htmlContent（整页 HTML）或 patches（增量替换片段数组）",
    };
  }

  const contentCheck = validateKbHtmlContentSafety(candidateHtml);
  if (!contentCheck.ok) return contentCheck;

  const metaComment = `<!-- JIEBO_KB_META: ${JSON.stringify({ updatedAt: now, path: pathCheck.normalizedRel })} -->`;
  const cleanedHtml = candidateHtml.replace(/^<!--\s*JIEBO_KB_META:[\s\S]*?-->\r?\n?/i, "");
  const finalHtml = `${metaComment}\n${cleanedHtml}`;

  const writeRes = safeWriteWorkspaceFileSync(workspaceDir, pathCheck.normalizedRel, finalHtml);
  if (!writeRes.ok) {
    if (previousHtmlSnapshot !== null) {
      const rollbackRes = safeWriteWorkspaceFileSync(workspaceDir, pathCheck.normalizedRel, previousHtmlSnapshot);
      if (!rollbackRes.ok) {
        return {
          ok: false,
          error: `${writeRes.error}（且回滚恢复原 HTML 失败：${rollbackRes.error}）`,
        };
      }
    }
    return writeRes;
  }

  if (log && !log.updatedHtmls.includes(pathCheck.normalizedRel)) {
    log.updatedHtmls.push(pathCheck.normalizedRel);
  }

  return {
    ok: true,
    path: pathCheck.normalizedRel,
    bytes: writeRes.size,
    backedUp: previousHtmlSnapshot !== null,
    mode,
  };
}

/**
 * 构建挂载给受限 Ingest Runner 的专用 customTools
 */
export function buildIngestCustomTools(ctx: {
  workspaceDir: string;
  config: KbWorkspaceConfig;
  meta: DropBatchMeta;
  executionLog: IngestToolExecutionLog;
  isClosed?: () => boolean;
}): Record<string, SDKCustomTool> {
  const { workspaceDir, config, meta, executionLog, isClosed } = ctx;
  const allowedSourceRels = new Set(meta.files.map((f) => f.relPath));

  const makeTool = (
    description: string,
    properties: Record<string, SDKJsonValue>,
    required: string[],
    run: (args: Args) => unknown,
  ): SDKCustomTool => ({
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    execute: async (args, _context: SDKCustomToolContext) => {
      if (isClosed?.()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: "当前归档批次运行已结束或超时，禁止继续执行工具" }),
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await run(args ?? {});
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
    ingest_batch_info: makeTool(
      "读取本次待归档批次的完整文件清单（对 .xlsx/.docx/.pptx 自动附带服务端解析的单元格/正文纯文本预览 extractedPreview，免调用 Read 工具）、提交人备注、允许的一级分类目录白名单以及本工作区的《归档说明.md》全文。",
      {},
      [],
      () => {
        const policyRead = safeReadWorkspaceTextFileSync(workspaceDir, KB_POLICY_DOC_REL_PATH, 256 * 1024);
        return {
          ok: true,
          batchId: meta.batchId,
          workspaceTitle: config.title,
          allowedCategories: config.allowedCategories,
          submitterName: meta.submitterName,
          note: meta.note,
          files: meta.files.map((f) => {
            const officePreview = extractWorkspaceOfficePreviewSync(workspaceDir, f.relPath, 16 * 1024);
            return {
              storedName: f.storedName,
              originalName: f.originalName,
              relPath: f.relPath,
              size: f.size,
              ...(officePreview
                ? {
                    extractedFormat: officePreview.format,
                    extractedPreview: officePreview.text,
                    extractedTruncated: officePreview.truncated,
                  }
                : {}),
            };
          }),
          archivePolicyMarkdown: policyRead.ok
            ? policyRead.text
            : "（本工作区未提供 归档说明.md，请按 allowedCategories 分类目录归档）",
        };
      },
    ),

    ingest_move_file: makeTool(
      [
        "将本批次暂存目录（.cursor-remote/uploads/inbox/<batchId>/<文件名>）中的单个文件移动到符合《归档说明.md》的目标分类子目录中。",
        "安全约束：1) fromRelPath 必须是本批次 inbox 登记清单下的文件；2) toRelPath 第一级目录必须属于 allowedCategories 白名单；3) 严禁更改文件扩展名；4) 若目标已存在同名文件会自动添加序号，不会覆盖已有档案。",
      ].join(""),
      {
        fromRelPath: {
          type: "string",
          description: "本批次待归档文件的相对路径，如 .cursor-remote/uploads/inbox/b_xxx/report.xlsx",
        },
        toRelPath: {
          type: "string",
          description: "目标分类归档相对路径，如 资产/洋钱罐（锋泰、瓴岳）/report.xlsx",
        },
      },
      ["fromRelPath", "toRelPath"],
      (args) =>
        executeIngestMoveFile(
          workspaceDir,
          config,
          meta.batchId,
          str(args.fromRelPath),
          str(args.toRelPath),
          allowedSourceRels,
          executionLog,
        ),
    ),

    ingest_update_html: makeTool(
      [
        "更新受影响目录顶层的同名全内联 HTML 知识库页面（路径格式必须为 <分类>/<分类>.html 或 <分类>/<子目录>/<子目录>.html）。",
        "支持两种高效模式：1) 【强烈推荐用于已有大体积 HTML】传入 patches 数组（[{ oldText, newText }]），只替换或插入变更片段，免去整页重写数万字 HTML 耗时；2) 传入 htmlContent 整页 HTML（用于新建尚不存在的看板或重写小体积看板）。",
        "安全约束：最终 HTML 必须为纯静态单文件全内联 HTML+CSS（严禁任何 <script>、<iframe>、on* 事件属性、@import、外链资源或 javascript: 链接）。",
      ].join(""),
      {
        htmlRelPath: {
          type: "string",
          description:
            "同名知识库 HTML 的相对路径，如 资产/资产.html 或 资产/黑龙江三农信融资担保/黑龙江三农信融资担保.html",
        },
        patches: {
          type: "array",
          description:
            "推荐：针对已有 HTML 看板的局部增量替换列表（按顺序将 oldText 替换为 newText），避免重新输出整页数万字 HTML",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description: "原 HTML 中要被替换的精确原文片段（需包含足够的上下文以唯一匹配）",
              },
              newText: {
                type: "string",
                description: "替换后的新 HTML 片段",
              },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
        htmlContent: {
          type: "string",
          description:
            "可选（当目标 HTML 尚不存在或不使用 patches 时提供）：完整的单文件内联 HTML 源码字符串（必须包含 <!DOCTYPE html> 或 <html>，不含任何 <script>）",
        },
      },
      ["htmlRelPath"],
      (args) => {
        const rawPatches = Array.isArray(args.patches) ? args.patches : undefined;
        const parsedPatches: IngestHtmlPatch[] | undefined = rawPatches
          ? rawPatches
              .filter((item): item is Record<string, SDKJsonValue> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
              .map((item) => ({
                oldText: str(item.oldText),
                newText: str(item.newText),
              }))
          : undefined;
        return executeIngestUpdateHtml(
          workspaceDir,
          config,
          str(args.htmlRelPath),
          typeof args.htmlContent === "string" ? args.htmlContent : undefined,
          executionLog,
          Date.now(),
          parsedPatches,
        );
      },
    ),
  };
}
