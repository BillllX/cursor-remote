import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { ensureSafePathInWorkspace, fileExtension } from "./contract.ts";

const MAX_OFFICE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_TEXT_BYTES = 24 * 1024;
const MAX_XLSX_SHEETS = 10;
const MAX_XLSX_ROWS_PER_SHEET = 80;
const MAX_XLSX_COLS_PER_ROW = 30;

type ZipEntryInfo = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

/**
 * 使用 O_NOFOLLOW | O_NONBLOCK 安全读取工作区内二进制文件（带 TOCTOU 复核）
 */
function safeReadWorkspaceBinaryFileSync(
  workspaceDir: string,
  relPath: string,
  maxBytes = MAX_OFFICE_FILE_BYTES,
): { ok: true; buffer: Buffer; absPath: string } | { ok: false; error: string } {
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
    if (!st.isFile() || st.nlink > 1) {
      return { ok: false, error: "目标文件不是单硬链接普通文件" };
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
    return { ok: true, buffer: buf.subarray(0, offset), absPath: second.absPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "读取二进制文件失败" };
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

/**
 * 解析 ZIP Central Directory 条目列表（防 Zip Bomb，不依赖外部命令）
 */
function parseZipCentralDirectory(buf: Buffer): Map<string, ZipEntryInfo> | null {
  if (buf.length < 22) return null;
  const minSearchOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minSearchOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buf.length || totalEntries > 2000) return null;

  const entries = new Map<string, ZipEntryInfo>();
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (pos + 46 <= cdEnd) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + fileNameLen > cdEnd) break;
    const name = buf.subarray(pos + 46, pos + 46 + fileNameLen).toString("utf8");
    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos += 46 + fileNameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 从 ZIP Buffer 中安全解压单个 XML/文本条目（限制最大解压体积 MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES）
 */
function readZipEntryUtf8(buf: Buffer, entry: ZipEntryInfo, maxOutBytes = MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES): string | null {
  if (entry.uncompressedSize > maxOutBytes || entry.compressedSize > buf.length) return null;
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buf.length) return null;

  const rawSlice = buf.subarray(dataStart, dataEnd);
  try {
    if (entry.compressionMethod === 0) {
      if (rawSlice.length > maxOutBytes) return null;
      return rawSlice.toString("utf8");
    }
    if (entry.compressionMethod === 8) {
      const inflated = inflateRawSync(rawSlice, { maxOutputLength: maxOutBytes });
      return inflated.toString("utf8");
    }
    return null;
  } catch {
    return null;
  }
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractXmlTagTexts(xmlBlock: string, localTagName: string): string {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localTagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${localTagName}>`, "g");
  const parts: string[] = [];
  for (const m of xmlBlock.matchAll(re)) {
    parts.push(decodeXmlEntities(m[1] || ""));
  }
  return parts.join("");
}

function parseXmlAttr(attrs: string, attrName: string): string {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? "") : "";
}

/**
 * 解析 .xlsx 工作簿中的工作表名称与前若干行单元格数据
 */
function extractXlsxPreviewFromZip(buf: Buffer, entries: Map<string, ZipEntryInfo>): string | null {
  // 1. 解析 sharedStrings.xml
  const sharedStrings: string[] = [];
  const ssEntry = entries.get("xl/sharedStrings.xml");
  if (ssEntry) {
    const ssXml = readZipEntryUtf8(buf, ssEntry);
    if (ssXml) {
      const siRe = /<(?:[A-Za-z0-9_]+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?si>/g;
      for (const m of ssXml.matchAll(siRe)) {
        sharedStrings.push(extractXmlTagTexts(m[1] || "", "t"));
      }
    }
  }

  // 2. 解析 workbook.xml 与 workbook.xml.rels 获取工作表真实名称与路径映射
  const relMap = new Map<string, string>();
  const wbRelsEntry = entries.get("xl/_rels/workbook.xml.rels");
  if (wbRelsEntry) {
    const relsXml = readZipEntryUtf8(buf, wbRelsEntry, 512 * 1024);
    if (relsXml) {
      for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const attrs = m[1] || "";
        const id = parseXmlAttr(attrs, "Id");
        const target = parseXmlAttr(attrs, "Target");
        if (id && target) {
          const normalized = target.startsWith("/")
            ? target.slice(1)
            : target.startsWith("xl/")
              ? target
              : `xl/${target.replace(/^\.\//, "")}`;
          relMap.set(id, normalized);
        }
      }
    }
  }

  const sheetsToRead: Array<{ title: string; entryPath: string }> = [];
  const wbEntry = entries.get("xl/workbook.xml");
  if (wbEntry) {
    const wbXml = readZipEntryUtf8(buf, wbEntry, 512 * 1024);
    if (wbXml) {
      for (const m of wbXml.matchAll(/<(?:[A-Za-z0-9_]+:)?sheet\b([^>]*)\/?>/g)) {
        const attrs = m[1] || "";
        const name = parseXmlAttr(attrs, "name");
        const rId = parseXmlAttr(attrs, "r:id") || parseXmlAttr(attrs, "id");
        const targetPath = (rId && relMap.get(rId)) || `xl/worksheets/sheet${sheetsToRead.length + 1}.xml`;
        if (entries.has(targetPath)) {
          sheetsToRead.push({ title: name || `Sheet${sheetsToRead.length + 1}`, entryPath: targetPath });
        }
      }
    }
  }

  if (sheetsToRead.length === 0) {
    const fallbackNames = [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const entryPath of fallbackNames) {
      sheetsToRead.push({ title: entryPath.replace(/^xl\/worksheets\/|\.xml$/g, ""), entryPath });
    }
  }

  if (sheetsToRead.length === 0) return null;

  const outLines: string[] = [];
  for (const sheet of sheetsToRead.slice(0, MAX_XLSX_SHEETS)) {
    const entry = entries.get(sheet.entryPath);
    if (!entry) continue;
    const xml = readZipEntryUtf8(buf, entry);
    if (!xml) continue;

    outLines.push(`### 工作表：${sheet.title}`);
    let rowCount = 0;
    const rowRe = /<(?:[A-Za-z0-9_]+:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?row>/g;
    for (const rm of xml.matchAll(rowRe)) {
      if (rowCount >= MAX_XLSX_ROWS_PER_SHEET) {
        outLines.push(`…（该工作表后续行已省略，仅展示前 ${MAX_XLSX_ROWS_PER_SHEET} 行非空行）`);
        break;
      }
      const rowXml = rm[2] || "";
      const cells: string[] = [];
      const cellRe = /<(?:[A-Za-z0-9_]+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?c>)/g;
      let colCount = 0;
      for (const cm of rowXml.matchAll(cellRe)) {
        if (colCount >= MAX_XLSX_COLS_PER_ROW) break;
        const cAttrs = cm[1] || "";
        const cBody = cm[2] || "";
        if (!cBody) continue;
        const cellRef = parseXmlAttr(cAttrs, "r");
        const cellType = parseXmlAttr(cAttrs, "t");
        let val = "";
        if (cellType === "inlineStr") {
          val = extractXmlTagTexts(cBody, "t");
        } else {
          const vMatch = /<(?:[A-Za-z0-9_]+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?v>/.exec(cBody);
          const rawV = vMatch ? decodeXmlEntities(vMatch[1] || "").trim() : "";
          if (cellType === "s") {
            const idx = Number.parseInt(rawV, 10);
            val = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : rawV;
          } else {
            val = rawV;
          }
        }
        const cleaned = val.replace(/\r?\n/g, " ").trim();
        if (cleaned) {
          cells.push(cellRef ? `${cellRef}: ${cleaned}` : cleaned);
          colCount += 1;
        }
      }
      if (cells.length > 0) {
        outLines.push(cells.join(" | "));
        rowCount += 1;
      }
    }
    if (rowCount === 0) {
      outLines.push("（空工作表）");
    }
    outLines.push("");
  }

  return outLines.join("\n").trim();
}

/**
 * 解析 .docx 文档中的正文段落与表格文本
 */
function extractDocxPreviewFromZip(buf: Buffer, entries: Map<string, ZipEntryInfo>): string | null {
  const docEntry = entries.get("word/document.xml");
  if (!docEntry) return null;
  const xml = readZipEntryUtf8(buf, docEntry);
  if (!xml) return null;

  const paragraphs: string[] = [];
  const pRe = /<(?:[A-Za-z0-9_]+:)?p\b(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?p>/g;
  for (const pm of xml.matchAll(pRe)) {
    const text = extractXmlTagTexts(pm[1] || "", "t").replace(/\s+/g, " ").trim();
    if (text) {
      paragraphs.push(text);
      if (paragraphs.length >= 200) break;
    }
  }
  return paragraphs.length > 0 ? paragraphs.join("\n") : null;
}

/**
 * 解析 .pptx 幻灯片中的文本摘要
 */
function extractPptxPreviewFromZip(buf: Buffer, entries: Map<string, ZipEntryInfo>): string | null {
  const slidePaths = [...entries.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 30);
  if (slidePaths.length === 0) return null;

  const lines: string[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const entry = entries.get(slidePaths[i]);
    if (!entry) continue;
    const xml = readZipEntryUtf8(buf, entry);
    if (!xml) continue;
    const text = extractXmlTagTexts(xml, "t").replace(/\s+/g, " ").trim();
    if (text) {
      lines.push(`[Slide ${i + 1}] ${text}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function clipUtf8Text(text: string, maxBytes = MAX_PREVIEW_TEXT_BYTES): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const buf = Buffer.from(text, "utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: `${buf.subarray(0, end).toString("utf8")}\n…（内容预览已截断至 ${Math.round(maxBytes / 1024)}KB）`,
    truncated: true,
  };
}

/**
 * 提取工作区内办公文档（.xlsx / .docx / .pptx）的可读结构化纯文本摘要：
 * - 纯 Node 内存解析（基于内置 zlib.inflateRawSync），无需调用外部 Python/Shell，也无需模型尝试调用不支持二进制的内置 Read 工具；
 * - 若文件不是上述 Office Open XML 格式或解析失败，返回 null。
 */
export function extractWorkspaceOfficePreviewSync(
  workspaceDir: string,
  relPath: string,
  maxPreviewBytes = MAX_PREVIEW_TEXT_BYTES,
): { ok: true; text: string; truncated: boolean; format: "xlsx" | "docx" | "pptx" } | null {
  const ext = fileExtension(relPath);
  if (ext !== ".xlsx" && ext !== ".docx" && ext !== ".pptx") {
    return null;
  }
  const readRes = safeReadWorkspaceBinaryFileSync(workspaceDir, relPath, MAX_OFFICE_FILE_BYTES);
  if (!readRes.ok) return null;

  const entries = parseZipCentralDirectory(readRes.buffer);
  if (!entries) return null;

  let rawText: string | null = null;
  let format: "xlsx" | "docx" | "pptx" = "xlsx";
  if (ext === ".xlsx") {
    format = "xlsx";
    rawText = extractXlsxPreviewFromZip(readRes.buffer, entries);
  } else if (ext === ".docx") {
    format = "docx";
    rawText = extractDocxPreviewFromZip(readRes.buffer, entries);
  } else if (ext === ".pptx") {
    format = "pptx";
    rawText = extractPptxPreviewFromZip(readRes.buffer, entries);
  }

  if (!rawText) return null;
  const clipped = clipUtf8Text(rawText, maxPreviewBytes);
  return {
    ok: true,
    text: clipped.text,
    truncated: clipped.truncated,
    format,
  };
}
