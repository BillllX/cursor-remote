export type KbBoardShortcut = {
  path: string;
  title: string;
  category: string;
  level: "category" | "subject";
};

/**
 * 从工作区文件树清单中识别同名 `<目录>/<目录>.html` 知识库看板。
 * 顶层分类看板置顶，子目录主体看板紧随其后。
 */
export function extractKbBoardShortcuts(paths: string[], query: string): KbBoardShortcut[] {
  const q = query.trim().toLowerCase();
  const topBoards: KbBoardShortcut[] = [];
  const subBoards: KbBoardShortcut[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    if (!raw || raw.endsWith("/") || !raw.toLowerCase().endsWith(".html")) continue;
    const parts = raw.split("/").filter(Boolean);
    if (parts.length !== 2 && parts.length !== 3) continue;
    if (parts.some((part) => part.startsWith("."))) continue;

    const parentDir = parts[parts.length - 2];
    const fileName = parts[parts.length - 1];
    if (fileName.toLowerCase() !== `${parentDir.toLowerCase()}.html`) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (q && !raw.toLowerCase().includes(q)) continue;

    if (parts.length === 2) {
      topBoards.push({
        path: raw,
        title: `${parts[0]}（总览看板）`,
        category: parts[0],
        level: "category",
      });
    } else {
      subBoards.push({
        path: raw,
        title: parts[1],
        category: parts[0],
        level: "subject",
      });
    }
  }

  topBoards.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  subBoards.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  return [...topBoards, ...subBoards];
}
