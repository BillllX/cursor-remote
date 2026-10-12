// @ 提及与补全：光标处的提及、引用片段拆分、候选列表、提及芯片

export function attachedFiles(text: string) {
  return [...text.matchAll(/@([^\s]+)/g)].map((match) => match[1]);
}

export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const match = upto.match(/(^|[\s])@([^\s]*)$/);
  if (!match) return null;
  const query = match[2];
  return { query, start: caret - query.length - 1 };
}

export function parseCite(language?: string): { path: string; line: number } | null {
  if (!language) return null;
  const numbered = /^(\d+):\d+:(.+)$/.exec(language);
  if (numbered) return { line: Number(numbered[1]), path: numbered[2] };
  const fileLine = /^(.+):(\d+)$/.exec(language);
  if (fileLine && (fileLine[1].includes("/") || isFileMention(fileLine[1]))) {
    return { path: fileLine[1], line: Number(fileLine[2]) };
  }
  return null;
}

export function splitCiteParts(text: string) {
  const re = /@([^\s@:，。；、！？,;!?)]+)(?::(\d+)(?:-(\d+))?)?/g;
  const parts: { value: string; path?: string; line?: number; endLine?: number }[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ value: text.slice(last, match.index) });
    parts.push({
      value: match[0],
      path: match[1],
      line: match[2] ? Number(match[2]) : undefined,
      endLine: match[3] ? Number(match[3]) : undefined,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ value: text.slice(last) });
  return parts.length ? parts : [{ value: text }];
}

export function escapeRe(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionChips(text: string) {
  return splitCiteParts(text).flatMap((part, index) =>
    part.path && isFileMention(part.path)
      ? [
          {
            key: `${index}-${part.value}`,
            token: part.value,
            path: part.path,
            line: part.line,
            endLine: part.endLine,
          },
        ]
      : [],
  );
}

export function isFileMention(token: string) {
  return (
    /^diff$/i.test(token) ||
    token.endsWith("/") ||
    /[./:]/.test(token) ||
    /^(readme|license|makefile|dockerfile|changelog|gemfile|procfile|jenkinsfile)(\.[a-z0-9]+)?$/i.test(token)
  );
}

function mentionExtras(paths: string[], query: string): string[] {
  const q = query.toLowerCase();
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return ["Diff", ...[...dirs].sort()].filter((item) => !q || item.toLowerCase().includes(q)).slice(0, 16);
}

export function mentionHits(paths: string[], query: string, remote: string[] = []): string[] {
  const q = query.toLowerCase();
  const files = [...remote, ...paths].filter((path) => {
    if (!q) return true;
    const base = path.split("/").pop() || path;
    return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...mentionExtras(paths, query), ...files]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= 40) break;
  }
  return out;
}

export function isOpenableMention(path: string) {
  return !/^diff$/i.test(path) && !path.endsWith("/");
}

export function stripMention(text: string, token: string) {
  return text.replace(new RegExp(`(^|\\s)${escapeRe(token)}(?=\\s|$)`), "$1").replace(/[ \t]{2,}/g, " ");
}
