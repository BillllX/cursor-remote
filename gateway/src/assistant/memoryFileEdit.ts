/** 行级编辑 .jiebo/memory.md，保真 EOL、首尾空行与 final newline（禁止整文件 trim）。 */

export type MemoryFileLines = {
  eol: "\n" | "\r\n";
  lines: string[];
  hadTrailingNewline: boolean;
};

export function parseMemoryFileLines(text: string): MemoryFileLines {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /(?:\r\n|\n)$/.test(text);
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return { eol, lines, hadTrailingNewline };
}

export function serializeMemoryFileLines(view: MemoryFileLines): string {
  if (!view.lines.length && !view.hadTrailingNewline) return "";
  let out = view.lines.join(view.eol);
  if (view.hadTrailingNewline) out += view.eol;
  return out;
}

/** 在 section 末尾插入一行（section 不存在则最小 append）。 */
export function insertLineInSectionLines(lines: string[], section: string, formattedLine: string) {
  const header = `## ${section}`;
  let at = lines.findIndex((row) => row.trim() === header);
  if (at < 0) {
    lines.push(header);
    at = lines.length - 1;
  }
  let end = at + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
  lines.splice(end, 0, formattedLine);
}

/** 除 [from, to) 行外，序列化结果应与原文一致（字节级，除改动行内容外）。 */
export function assertBytePreservationExceptLines(
  beforeText: string,
  afterText: string,
  changedRows: number[],
  formattedReplacements: Map<number, string>,
) {
  const before = parseMemoryFileLines(beforeText);
  const after = parseMemoryFileLines(afterText);
  if (before.eol !== after.eol) throw new Error("EOL 风格被改变");
  if (before.hadTrailingNewline !== after.hadTrailingNewline) throw new Error("final newline 被改变");
  const max = Math.max(before.lines.length, after.lines.length);
  for (let i = 0; i < max; i += 1) {
    if (changedRows.includes(i)) {
      const expect = formattedReplacements.get(i);
      if (expect !== undefined && after.lines[i] !== expect) {
        throw new Error(`行 ${i} 内容不符预期`);
      }
      continue;
    }
    if (before.lines[i] !== after.lines[i]) {
      throw new Error(`行 ${i} 被意外修改：${JSON.stringify(before.lines[i])} -> ${JSON.stringify(after.lines[i])}`);
    }
  }
}
