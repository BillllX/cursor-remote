export type MarkdownHeading = { depth: number; text: string; id: string };

export function slugHeading(text: string, used = new Map<string, number>()) {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~[\]()]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}\-_]/gu, "") || "section";
  const count = used.get(base) || 0;
  used.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

export function markdownHeadings(source: string): MarkdownHeading[] {
  const used = new Map<string, number>();
  let fenced = false;
  const out: MarkdownHeading[] = [];
  for (const line of source.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const hit = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!hit) continue;
    const text = hit[2].replace(/!\[[^\]]*]\([^)]*\)|\[([^\]]+)]\([^)]*\)/g, "$1").trim();
    out.push({ depth: hit[1].length, text, id: slugHeading(text, used) });
  }
  return out;
}

export function markdownHeadingIdsByLine(source: string) {
  const ids = new Map<number, string>();
  const headings = markdownHeadings(source);
  let headingIndex = 0;
  let fenced = false;
  source.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.test(line)) {
      const heading = headings[headingIndex++];
      if (heading) ids.set(index + 1, heading.id);
    }
  });
  return ids;
}

export function splitFrontMatter(source: string) {
  if (!source.startsWith("---\n")) return { body: source, frontMatter: [] as Array<[string, string]> };
  const end = source.indexOf("\n---", 4);
  if (end < 0) return { body: source, frontMatter: [] as Array<[string, string]> };
  const rows = source
    .slice(4, end)
    .split("\n")
    .map((line) => {
      const colon = line.indexOf(":");
      return colon > 0 ? ([line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as [string, string]) : null;
    })
    .filter((row): row is [string, string] => Boolean(row));
  return { body: source.slice(end + 4).replace(/^\n/, ""), frontMatter: rows };
}

export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i <= source.length; i += 1) {
    const char = source[i] ?? "\n";
    if (quoted && char === '"' && source[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  return rows;
}

export type NotebookCell = { cell_type?: string; source?: string[] | string; outputs?: unknown[] };

export function parseNotebook(source: string): { cells: NotebookCell[]; error?: string } {
  try {
    const value = JSON.parse(source) as { cells?: unknown };
    if (!Array.isArray(value.cells)) return { cells: [], error: "Notebook 没有 cells" };
    return { cells: value.cells.filter((cell): cell is NotebookCell => Boolean(cell && typeof cell === "object")) };
  } catch (error) {
    return { cells: [], error: error instanceof Error ? error.message : "Notebook 格式错误" };
  }
}

export function splitMarkdownDiff(diff: string) {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split("\n")) {
    if (/^(diff |index |--- |\+\+\+ |@@)/.test(line) || line === "\\ No newline at end of file") continue;
    if (!line.startsWith("+")) before.push(line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line);
    if (!line.startsWith("-")) after.push(line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line);
  }
  return { before: before.join("\n"), after: after.join("\n") };
}
