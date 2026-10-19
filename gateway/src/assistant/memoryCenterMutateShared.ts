import { dirname } from "node:path";
import { atomicWriteFileSync, sweepStaleTmp } from "../fsAtomic.ts";
import { parseMemoryFileLines, serializeMemoryFileLines, type MemoryFileLines } from "./memoryFileEdit.ts";
import { parseMemoryFile, MEMORY_TMP_RE, type MemoryLine } from "./workspaceMemory.ts";

export type IndexedRow = { row: number; section: string; line: MemoryLine };

export function indexMemoryRowsFromLines(lines: string[]): IndexedRow[] {
  const rows: IndexedRow[] = [];
  let section = "约定";
  for (let row = 0; row < lines.length; row += 1) {
    const head = lines[row].match(/^##\s+(.+?)\s*$/);
    if (head) {
      section = head[1];
      continue;
    }
    const parsed = parseMemoryFile(`## ${section}\n${lines[row]}`)[0];
    if (parsed) rows.push({ row, section, line: parsed });
  }
  return rows;
}

export function writeMemoryView(
  paths: { memory: string },
  view: MemoryFileLines,
  writeFile?: (path: string, data: string | Buffer, mode?: number) => void,
) {
  const content = serializeMemoryFileLines(view);
  if (writeFile) writeFile(paths.memory, content);
  else atomicWriteFileSync(paths.memory, content, { mkdir: true });
  sweepStaleTmp(dirname(paths.memory), { patterns: [MEMORY_TMP_RE] });
}

export { parseMemoryFileLines };
