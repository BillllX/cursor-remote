import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { gatewayEnv } from "../config.ts";
import { atomicWriteFileSync, sweepStaleTmp, withFileLockSync } from "../fsAtomic.ts";
import { isInside } from "../pathInside.ts";
import { addApproval, settleApproval } from "./approvals.ts";
import { postInbox } from "./inbox.ts";
import {
  addWorkPreference,
  detectSecret,
  invalidateMemory,
  isValid,
  listMemory,
  PERSONAL_CORE_FIELDS,
  readCore,
  renderWorkPreferences,
  splitTerms,
} from "./memory.ts";
import { isValidCalendarDateUtc } from "../../../shared/calendarDateUtc.ts";
import type { InjectionDiagnostics, MemoryInjectionReason, MemoryInjectionSkipReason } from "../../../shared/protocol.ts";
import { assistantPath, clip, estimateTokens, newId, readJson, writeJson, type TenantRef } from "./store.ts";

/**
 * 工作区记忆（“事”这条线）：
 * - 规则：从 cwd 往上走到 USER 根目录，每层读 .cursorrules、AGENTS.md、.cursor/rules/*、.jiebo/memory.md，近层放后面；
 *   USER 根目录那层属于助理（人设），只在根目录会话里读。
 * - .jiebo/memory.md 由机器维护、人可以改：每条一行，行尾注释记来源和引用的路径，引用失效就标“待核实”。
 * - 写入默认直接落进 .jiebo/memory.md（过密钥、个人信息、越界检查；文件人可以改可以删）；
 *   设了 WORKSPACE_MEMORY_CONFIRM=1 才走“提议 → 线程空闲时合成一张确认卡 → 用户批准”。
 * - 会话摘要索引只存每个工作区线程的一行摘要，供助理只读查询；整理者不读。
 */

export type WorkspaceRoot = { id: string; stateDir: string; workspaceRoot: string };

export const MEMORY_FILE = ".jiebo/memory.md";
export const MEMORY_TMP_RE = /^memory\.md\.\d+\.[0-9a-f]{8}\.tmp$/;
export const SECTIONS = ["约定", "命令", "坑", "决定", "进行中"] as const;
export type Section = (typeof SECTIONS)[number];
export const RULES_CHAR_CAP = 16_000;
/** 机器维护的 .jiebo/memory.md 每层的常驻预算：子工作区层 / 更深的仓库层 */
export const LAYER_TOKEN_BUDGET = { workspace: 600, repo: 800 } as const;
export const IDLE_FLUSH_MS = 10 * 60_000;
export const CARD_TTL_MS = 7 * 24 * 3_600_000;
export const MAX_QUEUED_PER_CHAT = 20;
export const WORKSPACE_MEMORY_TOOL = "workspace_memory";
export const WORK_PREF_TOOL = "work_preferences";
export const MEMORY_COLD_AFTER_DAYS = 90;
export const MEMORY_RECENT_USE_DAYS = 30;
export const MEMORY_SEARCH_LIMIT = 12;

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const posix = (path: string) => path.split(sep).join("/");

function realOr(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(root: string, path: string) {
  return isInside(path, root);
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type SafeMemoryPaths = { dir: string; jiebo: string; memory: string; ignore: string; lockTarget: string; lockDir: string };

export function rejectSymlink(path: string) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`工作区记忆路径不能是符号链接：${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** memory 相关路径统一做真实路径与 symlink 检查；调用者提供作用域根，不能只信字符串 resolve。 */
export function safeMemoryPaths(dir: string, allowedRoot = dir): SafeMemoryPaths {
  const root = realpathSync(allowedRoot);
  const target = realpathSync(dir);
  if (!within(root, target)) throw new Error(`工作区记忆目录越界：${dir}`);
  const jiebo = resolve(target, ".jiebo");
  const memory = resolve(jiebo, "memory.md");
  const ignore = resolve(jiebo, ".gitignore");
  const lockTarget = resolve(jiebo, ".memory.md");
  const lockDir = `${lockTarget}.lock`;
  for (const path of [jiebo, memory, ignore, lockTarget, lockDir]) rejectSymlink(path);
  if (existsSync(jiebo)) {
    const actualJiebo = realpathSync(jiebo);
    if (!within(target, actualJiebo)) throw new Error(`工作区记忆目录越界：${jiebo}`);
  }
  return { dir: target, jiebo, memory, ignore, lockTarget, lockDir };
}

function readText(path: string) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return "";
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function writeTextAtomic(path: string, text: string) {
  atomicWriteFileSync(path, text, { mkdir: true });
}

/** 从根目录下第一层一直到 cwd 的各层目录；cwd 就是根目录时只有根目录这一层 */
export function layerDirs(root: string, cwd: string) {
  const base = realOr(root);
  const target = realOr(cwd);
  if (!within(base, target)) return [];
  if (target === base) return [base];
  const parts = relative(base, target).split(sep).filter(Boolean);
  const out: string[] = [];
  let cur = base;
  for (const part of parts) {
    cur = resolve(cur, part);
    out.push(cur);
  }
  return out;
}

// ---------- .jiebo/memory.md ----------

export type MemoryLine = {
  section: string;
  text: string;
  id?: string;
  from?: string;
  at?: string;
  refs: string[];
  state?: "hot" | "cold" | "done";
  used?: string;
  uses?: number;
  expires?: string;
  /** 人工置顶；只有显式的行尾 pinned=1 才启用，机器提议默认不置顶 */
  pinned?: boolean;
  /** 保留人工添加且本版本不认识的元数据；formatLine 不会吞掉它。 */
  meta?: Record<string, string>;
  metaOrder?: string[];
};

const META_RE = /\s*<!--\s*(.*?)\s*-->\s*$/;
const KNOWN_META = new Set(["id", "from", "at", "refs", "pinned", "state", "used", "uses", "expires"]);

function validDate(value: string | undefined) {
  return value && isValidCalendarDateUtc(value) ? value : undefined;
}

function validState(value: string | undefined): MemoryLine["state"] {
  return value === "hot" || value === "cold" || value === "done" ? value : undefined;
}

export function parseMemoryFile(text: string): MemoryLine[] {
  const out: MemoryLine[] = [];
  let section = "约定";
  for (const rawLine of text.split("\n")) {
    const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const head = raw.match(/^##\s+(.+?)\s*$/);
    if (head) {
      section = head[1];
      continue;
    }
    const item = raw.match(/^\s*[-*]\s+(.+)$/);
    if (!item) continue;
    let body = item[1];
    const meta: Record<string, string> = {};
    const m = body.match(META_RE);
    if (m) {
      body = body.slice(0, m.index).trim();
      for (const pair of m[1].split(/\s+/)) {
        const at = pair.indexOf("=");
        if (at > 0) meta[pair.slice(0, at)] = pair.slice(at + 1);
      }
    }
    if (!body) continue;
    out.push({
      section,
      text: body,
      id: meta.id,
      from: meta.from,
      at: meta.at,
      refs: meta.refs ? meta.refs.split(",").filter(Boolean) : [],
      pinned: meta.pinned === "1" || undefined,
      state: validState(meta.state),
      used: validDate(meta.used),
      uses: /^\d+$/.test(meta.uses || "") ? Number(meta.uses) : undefined,
      expires: validDate(meta.expires),
      meta: Object.fromEntries(Object.entries(meta).filter(([key]) => !KNOWN_META.has(key))),
      metaOrder: Object.keys(meta),
    });
  }
  return out;
}

export function formatMemoryLine(line: MemoryLine) {
  const values: Record<string, string | undefined> = {
    id: line.id,
    from: line.from,
    at: line.at,
    refs: line.refs.length ? line.refs.join(",") : undefined,
    pinned: line.pinned ? "1" : undefined,
    state: line.state,
    used: line.used,
    uses: line.uses === undefined ? undefined : String(line.uses),
    expires: line.expires,
    ...line.meta,
  };
  const defaultOrder = ["id", "from", "at", "refs", "pinned", "state", "used", "uses", "expires"];
  const order = [...new Set([...(line.metaOrder ?? []), ...defaultOrder, ...Object.keys(line.meta ?? {})])];
  const meta = order.flatMap((key) => (values[key] === undefined ? [] : [`${key}=${values[key]}`]));
  return `- ${line.text}${meta.length ? ` <!-- ${meta.join(" ")} -->` : ""}`;
}

export type EffectiveMemoryState = "hot" | "cold" | "done" | "expired";

function daysBefore(day: string, days: number) {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

/** 不改文件的统一生命周期视图；无日期的人工旧条目保持 hot。 */
export function effectiveMemoryState(line: MemoryLine, day = today()): EffectiveMemoryState {
  if (line.state === "done") return "done";
  if (line.expires && line.expires < day) return "expired";
  const recentlyUsed = Boolean(line.used && line.used >= daysBefore(day, MEMORY_RECENT_USE_DAYS));
  if (line.pinned) return "hot";
  if (line.state === "cold") return recentlyUsed && (line.uses ?? 0) >= 2 ? "hot" : "cold";
  const lastActivity = line.used || line.at;
  if (lastActivity && lastActivity < daysBefore(day, MEMORY_COLD_AFTER_DAYS)) return "cold";
  // 显式 hot 也只在活动仍新鲜时有效；无日期的人工旧行继续保持兼容。
  if (line.state === "hot") return "hot";
  return "hot";
}

const FILE_HEAD = [
  "# 工作区记忆",
  "",
  "<!-- 接驳维护：每条一行，可以手改或删。行尾注释是来源和引用的路径，引用的文件没了会标“待核实”。这里不放个人信息。 -->",
].join("\n");

/** 计算 .jiebo/.gitignore 目标内容；无需变更时返回 null。 */
export function planMemoryJieboGitignore(dir: string, allowedRoot = dir): { path: string; content: string } | null {
  const { ignore } = safeMemoryPaths(dir, allowedRoot);
  const lockRule = ".memory.md.lock/";
  if (existsSync(ignore)) {
    const current = readFileSync(ignore, "utf8");
    const lines = current.split(/\r?\n/);
    let patch = current;
    if (!lines.includes("memory-audit.jsonl")) {
      patch = `${patch}${patch && !patch.endsWith("\n") ? "\n" : ""}memory-audit.jsonl\n`;
    }
    if (!lines.includes(lockRule)) {
      patch = `${patch}${patch.endsWith("\n") ? "" : "\n"}${lockRule}\n`;
    }
    if (patch === current) return null;
    return { path: ignore, content: patch };
  }
  return {
    path: ignore,
    content: `# 接驳的工作区记忆默认不进版本库；想跟代码一起提交就删掉这个文件\nmemory.md\nmemory-audit.jsonl\n${lockRule}\n`,
  };
}

/** 默认不进版本库：.jiebo/ 下放一份只忽略 memory.md 的 .gitignore；已有的不动，删掉它就会被提交 */
export function ensureMemoryJieboGitignore(
  dir: string,
  allowedRoot = dir,
  writeFile?: (path: string, data: string | Buffer, mode?: number) => void,
) {
  const plan = planMemoryJieboGitignore(dir, allowedRoot);
  if (!plan) return;
  if (writeFile) writeFile(plan.path, plan.content);
  else writeTextAtomic(plan.path, plan.content);
}

export type MemoryMatch = {
  matchedId?: string;
  matchKind: "normalized_exact" | "high_similarity";
  similarity: number;
};

const SIMILARITY_THRESHOLD = 0.94;
const HAN_SIMILARITY_THRESHOLD = 0.97;
const POLARITY_RE =
  /不允许|未启用|未开启|不得|不能|不可|不应|不必|无需|不要|禁止|禁用|停用|关闭|必须|务必|应当|需要|允许|启用|开启|否|不|未|无|非|勿|莫|别/g;

/** 常见标点、大小写和空白不承载语义；NFKC 同时统一全角字符。 */
export function normalizeMemoryText(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/重新启动|再次启动/g, "重启")
    .replace(/并且|以及/g, "和")
    // 保留 . / \ - _ 等代码标识符边界；只折叠空白与自然语言标点。
    .replace(/[\s,，。!！?？:：;；'"“”‘’`()（）[\]{}<>《》、]+/g, "");
}

function criticalTokens(text: string) {
  // 数字（含中文数字）、路径和 flags 往往正是命令/配置差异；集合不同就绝不做近似合并。
  const unit = "毫秒|分钟|小时|千字节|兆字节|吉字节|端口|字节|次数|帧|次|遍|个|秒|天|kb|mb|gb|tb|%";
  const number = "(?:\\b\\d+(?:\\.\\d+)*|[〇零一二两三四五六七八九十百千万亿]+)";
  return [
    ...text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .matchAll(new RegExp(`--?[\\w.-]+|(?:[./~][\\w.@%+~/-]+)|(?:${unit})?${number}(?:${unit})?`, "g")),
  ]
    .map((match) => match[0])
    .sort();
}

function polarityTokens(text: string) {
  return [...text.normalize("NFKC").matchAll(POLARITY_RE)].map((match) => match[0]).sort();
}

function hanRatio(text: string) {
  const meaningful = [...text].filter((char) => /[\p{Letter}\p{Number}]/u.test(char));
  if (!meaningful.length) return 0;
  return meaningful.filter((char) => /\p{Script=Han}/u.test(char)).length / meaningful.length;
}

const SAFE_HAN_TYPO_GROUPS = ["状壮", "查察", "已以", "的地得", "做作"];

function isSafeHanTypo(left: string, right: string) {
  const a = [...left];
  const b = [...right];
  if (a.length !== b.length || a.length < 24) return false;
  let changed = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue;
    changed += 1;
    if (changed > 2 || !SAFE_HAN_TYPO_GROUPS.some((group) => group.includes(a[index]) && group.includes(b[index]))) return false;
  }
  return changed > 0;
}

function canonicalSafeHanTypos(text: string) {
  let out = text;
  for (const group of SAFE_HAN_TYPO_GROUPS) {
    const canonical = [...group][0];
    for (const variant of [...group].slice(1)) out = out.split(variant).join(canonical);
  }
  return out;
}

function grams(text: string) {
  const chars = [...text];
  const size = chars.length < 6 ? 2 : 3;
  return new Set(chars.slice(0, Math.max(0, chars.length - size + 1)).map((_, index) => chars.slice(index, index + size).join("")));
}

function terms(text: string) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const out = normalized.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? [];
  return new Set(
    out.flatMap((term) => {
      if (!/^\p{Script=Han}+$/u.test(term) || [...term].length < 3) return [term];
      const chars = [...term];
      return chars.slice(0, -1).map((char, index) => char + chars[index + 1]);
    }),
  );
}

function dice(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const value of left) if (right.has(value)) common += 1;
  return common / (left.size + right.size - common);
}

/**
 * 保守近似：关键 token 与语义极性必须完全相同；规范化后先精确匹配，否则仅长度 >= 16
 * 且 3-gram Dice(75%) + term Jaccard(25%) >= 0.94 才算重复。高 Han 占比文本提高到
 * 0.97；极性、数字、路径、flag 的细微变化已由前置硬守卫拒绝。已知中文错字只在
 * 长度 >= 24、等长且最多两个形近/同音误字时参与评分归一化，最终仍必须达到阈值。
 */
export function memoryTextMatch(left: string, right: string): Omit<MemoryMatch, "matchedId"> | null {
  if (criticalTokens(left).join("\0") !== criticalTokens(right).join("\0")) return null;
  if (polarityTokens(left).join("\0") !== polarityTokens(right).join("\0")) return null;
  const a = normalizeMemoryText(left);
  const b = normalizeMemoryText(right);
  if (a === b) return { matchKind: "normalized_exact", similarity: 1 };
  if (Math.min([...a].length, [...b].length) < 16) return null;
  const mostlyHan = Math.min(hanRatio(a), hanRatio(b)) >= 0.6;
  const safeTypo = mostlyHan && isSafeHanTypo(a, b);
  const scoreA = safeTypo ? canonicalSafeHanTypos(a) : a;
  const scoreB = safeTypo ? canonicalSafeHanTypos(b) : b;
  const similarity = 0.75 * dice(grams(scoreA), grams(scoreB)) + 0.25 * jaccard(terms(scoreA), terms(scoreB));
  const threshold = mostlyHan ? HAN_SIMILARITY_THRESHOLD : SIMILARITY_THRESHOLD;
  return similarity >= threshold
    ? { matchKind: "high_similarity", similarity: Number(similarity.toFixed(3)) }
    : null;
}

function findMemoryMatch(text: string, candidates: { text: string; id?: string }[]): MemoryMatch | null {
  for (const candidate of candidates) {
    const match = memoryTextMatch(text, candidate.text);
    if (match) return { ...(candidate.id ? { matchedId: candidate.id } : {}), ...match };
  }
  return null;
}

export type AppendMemoryItemResult = {
  status: "written" | "duplicate" | "skipped";
  match?: MemoryMatch;
};

export type AppendMemoryResult = {
  written: number;
  items: AppendMemoryItemResult[];
};

function appendMemoryLinesUnlocked(dir: string, lines: MemoryLine[], allowedRoot: string): AppendMemoryResult {
  const { memory: path } = safeMemoryPaths(dir, allowedRoot);
  const current = readText(path);
  ensureMemoryJieboGitignore(dir, allowedRoot);
  const known = parseMemoryFile(current).map((line) => ({ text: line.text, id: line.id }));
  const fresh: MemoryLine[] = [];
  const items: AppendMemoryItemResult[] = [];
  for (const line of lines) {
    if (!line.text) {
      items.push({ status: "skipped" });
      continue;
    }
    const match = findMemoryMatch(line.text, [...known, ...fresh.map((row) => ({ text: row.text, id: row.id }))]);
    if (match) {
      items.push({ status: "duplicate", match });
      continue;
    }
    fresh.push(line);
    items.push({ status: "written" });
  }
  if (!fresh.length) return { written: 0, items };
  const rows = (current || FILE_HEAD).split("\n");
  for (const line of fresh) {
    const header = `## ${line.section}`;
    let at = rows.findIndex((row) => row.trim() === header);
    if (at < 0) {
      if (rows[rows.length - 1]?.trim()) rows.push("");
      rows.push(header);
      at = rows.length - 1;
    }
    let end = at + 1;
    while (end < rows.length && !/^##\s+/.test(rows[end])) end += 1;
    while (end > at + 1 && !rows[end - 1].trim()) end -= 1;
    rows.splice(end, 0, formatMemoryLine(line));
  }
  writeTextAtomic(path, `${rows.join("\n").trim()}\n`);
  // 这是用户工作区，只清自己这个文件名的残留临时文件，不在启动时扫
  sweepStaleTmp(dirname(path), { patterns: [MEMORY_TMP_RE] });
  return { written: fresh.length, items };
}

/** 写回时在跨进程锁内重新读取；保留人工行和顺序，只在对应小节末尾追加。 */
export function appendMemoryLinesDetailed(dir: string, lines: MemoryLine[], allowedRoot = dir) {
  if (!existsSync(dir)) {
    if (resolve(allowedRoot) !== resolve(dir)) {
      const root = realpathSync(allowedRoot);
      if (!within(root, resolve(dir))) throw new Error(`工作区记忆目录越界：${dir}`);
    }
    mkdirSync(dir, { recursive: true });
  }
  const paths = safeMemoryPaths(dir, allowedRoot);
  return withFileLockSync(paths.lockTarget, () => appendMemoryLinesUnlocked(paths.dir, lines, allowedRoot));
}

/** 兼容既有同步 API；需要逐项落地信息的批准/迁移路径使用 detailed 版本。 */
export function appendMemoryLines(dir: string, lines: MemoryLine[], allowedRoot = dir) {
  return appendMemoryLinesDetailed(dir, lines, allowedRoot).written;
}

export type RankedMemoryLine = {
  line: MemoryLine;
  index: number;
  relevance: number;
  highConfidence: boolean;
  coldEligible: boolean;
  effectiveState: EffectiveMemoryState;
  text: string;
  cost: number;
};

export const INJECTION_STRATEGY = "pinned>分节anchor>高置信相关>分节轮转";
export const INJECTION_DIAGNOSTIC_CAP = 40;

export type MemoryInjectionPlan = {
  lines: MemoryLine[];
  sectionOrder: string[];
  ranked: RankedMemoryLine[];
  selected: RankedMemoryLine[];
  selectedReasons: Map<number, MemoryInjectionReason>;
  diagnostics: InjectionDiagnostics;
};

function injectionReasonFor(row: RankedMemoryLine, pinned: RankedMemoryLine[], anchors: RankedMemoryLine[], relevant: RankedMemoryLine[]) {
  if (row.line.pinned) return "pinned" as const;
  if (anchors.some((item) => item.index === row.index)) return "section_anchor" as const;
  if (relevant.some((item) => item.index === row.index)) return "relevant" as const;
  return "rotation" as const;
}

function formatInjectionDiagnosticsLine(diagnostics: InjectionDiagnostics) {
  return `（记忆诊断：总数=${diagnostics.total} 纳入=${diagnostics.selected} 因预算跳过=${diagnostics.skippedBudget} hot命中=${diagnostics.hotSelected} cold召回=${diagnostics.coldRecalled} done或expired跳过=${diagnostics.terminalSkipped} pinned命中=${diagnostics.pinnedSelected} 相关命中=${diagnostics.relevantSelected} 选择策略=${diagnostics.strategy}）`;
}

/** 与 renderMemoryFile 共用：结构化注入选择 + 诊断，供 UI 与提示词对齐。 */
export function planMemoryInjection(dir: string, budget: number, query = "", allowedRoot = dir): MemoryInjectionPlan | null {
  let paths: SafeMemoryPaths;
  try {
    paths = safeMemoryPaths(dir, allowedRoot);
  } catch {
    return null;
  }
  const lines = parseMemoryFile(readText(paths.memory));
  if (!lines.length) return null;
  const terms = memoryInjectionTerms(query);
  const ranked: RankedMemoryLine[] = lines.map((line, index) => {
    const missing = line.refs.filter((ref) => !existsSync(resolve(dir, ref)));
    const text = `- ${line.text}${missing.length ? `（待核实：引用的 ${missing.join("、")} 不在了）` : ""}`;
    const relevance = injectionRelevance(line, terms);
    return {
      line,
      index,
      relevance: relevance.score,
      highConfidence: relevance.highConfidence,
      coldEligible: relevance.coldEligible,
      effectiveState: effectiveMemoryState(line),
      text,
      cost: estimateTokens(text),
    };
  });
  const resident = ranked.filter((row) => row.effectiveState === "hot" || (row.effectiveState === "cold" && row.coldEligible));
  const pinned = resident.filter((row) => row.line.pinned).sort(newerFirst);
  const sectionOrder = [...new Set(lines.map((line) => line.section))];
  const anchoredSections = new Set(pinned.map((row) => row.line.section));
  const anchors = sectionOrder.flatMap((section) => {
    if (anchoredSections.has(section)) return [];
    const choices = resident
      .filter((row) => row.line.section === section && !row.line.pinned)
      .sort(
        (a, b) =>
          Number(b.effectiveState === "hot") - Number(a.effectiveState === "hot") ||
          Number(b.highConfidence) - Number(a.highConfidence) ||
          b.relevance - a.relevance ||
          newerFirst(a, b),
      );
    return choices[0] ? [choices[0]] : [];
  });
  const reserved = new Set([...pinned, ...anchors].map((row) => row.index));
  const relevant = resident
    .filter((row) => !reserved.has(row.index) && row.highConfidence)
    .sort((a, b) => b.relevance - a.relevance || newerFirst(a, b));
  const relevantIds = new Set(relevant.map((row) => row.index));
  const remainder = diverseNewest(resident.filter((row) => !reserved.has(row.index) && !relevantIds.has(row.index)));
  const candidates = [...pinned, ...anchors, ...relevant, ...remainder];
  const selected: RankedMemoryLine[] = [];
  const selectedReasons = new Map<number, MemoryInjectionReason>();
  let used = 0;
  let skippedBudget = 0;
  let coldUnrelatedSkipped = 0;
  const allSkippedReasons: Array<{ id: string | null; reason: MemoryInjectionSkipReason }> = [];
  for (const row of candidates) {
    if (used + row.cost > budget) {
      skippedBudget += 1;
      allSkippedReasons.push({ id: row.line.id ?? null, reason: "budget" });
      continue;
    }
    selected.push(row);
    selectedReasons.set(row.index, injectionReasonFor(row, pinned, anchors, relevant));
    used += row.cost;
  }
  for (const row of ranked) {
    if (row.effectiveState === "done" || row.effectiveState === "expired") {
      allSkippedReasons.push({ id: row.line.id ?? null, reason: "terminal" });
      continue;
    }
    if (row.effectiveState === "cold" && !row.coldEligible) {
      coldUnrelatedSkipped += 1;
      allSkippedReasons.push({ id: row.line.id ?? null, reason: "cold_unrelated" });
    }
  }
  const selectedIdsTruncated = selected.length > INJECTION_DIAGNOSTIC_CAP;
  const skippedReasonsTruncated = allSkippedReasons.length > INJECTION_DIAGNOSTIC_CAP;
  const selectedIds = selected.slice(0, INJECTION_DIAGNOSTIC_CAP).map((row) => ({
    id: row.line.id ?? null,
    reason: selectedReasons.get(row.index) ?? "rotation",
  }));
  const diagnostics: InjectionDiagnostics = {
    total: lines.length,
    selected: selected.length,
    skippedBudget,
    hotSelected: selected.filter((row) => row.effectiveState === "hot").length,
    coldRecalled: selected.filter((row) => row.effectiveState === "cold").length,
    terminalSkipped: ranked.filter((row) => row.effectiveState === "done" || row.effectiveState === "expired").length,
    coldUnrelatedSkipped,
    pinnedSelected: selected.filter((row) => row.line.pinned).length,
    relevantSelected: selected.filter((row) => row.relevance > 0).length,
    strategy: INJECTION_STRATEGY,
    selectedIds,
    skippedReasons: allSkippedReasons.slice(0, INJECTION_DIAGNOSTIC_CAP),
    selectedIdsTruncated,
    skippedReasonsTruncated,
    truncated: selectedIdsTruncated || skippedReasonsTruncated,
  };
  return { lines, sectionOrder, ranked, selected, selectedReasons, diagnostics };
}

function memoryRelevance(line: MemoryLine, terms: string[]) {
  if (!terms.length) return 0;
  const text = line.text.toLowerCase();
  const section = line.section.toLowerCase();
  const refs = line.refs.join(" ").toLowerCase();
  return terms.reduce(
    (score, term) => score + (text.includes(term) ? 3 : 0) + (section.includes(term) ? 2 : 0) + (refs.includes(term) ? 1 : 0),
    0,
  );
}

const INJECTION_STOP_TERMS = [
  "麻烦",
  "帮忙",
  "帮我",
  "请问",
  "请",
  "一下",
  "这个",
  "那个",
  "之前",
  "之后",
  "时候",
  "里面",
  "相关",
  "工作",
  "规则",
  "文件",
  "修改",
  "测试",
  "项目",
  "问题",
  "需要",
  "进行",
  "如何",
  "怎么",
  "然后",
] as const;
const INJECTION_STOP_SET = new Set<string>(INJECTION_STOP_TERMS);

/** 自动注入只取明确词块，不使用所有中文二字滑窗；显式 search 仍沿用宽召回 splitTerms。 */
function memoryInjectionTerms(query: string) {
  let cleaned = query.normalize("NFKC").toLocaleLowerCase();
  for (const stop of [...INJECTION_STOP_TERMS].sort((a, b) => b.length - a.length)) cleaned = cleaned.split(stop).join(" ");
  const terms = cleaned.match(/[a-z0-9_.~/-]{2,}|[\p{Script=Han}]{2,8}/gu) ?? [];
  return [...new Set(terms.filter((term) => !INJECTION_STOP_SET.has(term)))];
}

function injectionRelevance(line: MemoryLine, terms: string[]) {
  const text = line.text.toLocaleLowerCase();
  const section = line.section.toLocaleLowerCase();
  const refs = line.refs.join(" ").toLocaleLowerCase();
  const textHits = terms.filter((term) => text.includes(term));
  const refHits = terms.filter((term) => refs.includes(term));
  const sectionHits = terms.filter((term) => section.includes(term));
  const strongText = textHits.some((term) => /[a-z0-9_.~/-]/i.test(term) || [...term].length >= 4);
  const strongRef = refHits.some((term) => /[./~_-]/.test(term) || /[a-z0-9]/i.test(term));
  return {
    score: textHits.length * 3 + sectionHits.length * 2 + refHits.length,
    highConfidence: strongRef || strongText || textHits.length >= 2,
    // cold 比 hot 更保守：至少两个独立正文词块，或路径/refs 强命中。
    coldEligible: strongRef || textHits.length >= 2,
  };
}

function newerFirst(a: RankedMemoryLine, b: RankedMemoryLine) {
  const aAt = a.line.at ? Date.parse(a.line.at) : Number.NaN;
  const bAt = b.line.at ? Date.parse(b.line.at) : Number.NaN;
  const dated = (Number.isNaN(bAt) ? 0 : bAt) - (Number.isNaN(aAt) ? 0 : aAt);
  return dated || b.index - a.index;
}

function diverseNewest(rows: RankedMemoryLine[]) {
  const sections: string[] = [];
  const queues = new Map<string, RankedMemoryLine[]>();
  for (const row of rows) {
    if (!queues.has(row.line.section)) sections.push(row.line.section);
    queues.set(row.line.section, [...(queues.get(row.line.section) ?? []), row]);
  }
  for (const queue of queues.values()) queue.sort(newerFirst);
  const out: RankedMemoryLine[] = [];
  for (let round = 0; ; round += 1) {
    let added = false;
    for (const section of sections) {
      const row = queues.get(section)?.[round];
      if (row) {
        out.push(row);
        added = true;
      }
    }
    if (!added) return out;
  }
}

/** 渲染进提示词：置顶 → query 相关 → 分节轮转；引用失效标待核实，超预算的留在文件里。 */
export function renderMemoryFile(dir: string, budget: number, query = "", allowedRoot = dir) {
  const plan = planMemoryInjection(dir, budget, query, allowedRoot);
  if (!plan) return "";
  const out: string[] = [];
  for (const section of plan.sectionOrder) {
    const rows = plan.selected.filter((row) => row.line.section === section);
    if (!rows.length) continue;
    out.push(`${section}：`, ...rows.map((row) => row.text));
  }
  out.push(formatInjectionDiagnosticsLine(plan.diagnostics));
  return out.join("\n");
}

export type WorkspaceMemorySearchHit = {
  id: string | null;
  layer: string;
  section: string;
  text: string;
  refs: string[];
  missingRefs: string[];
  state: MemoryLine["state"] | null;
  effectiveState: EffectiveMemoryState;
  at: string | null;
  used: string | null;
  uses: number;
  expires: string | null;
};

type SearchRow = WorkspaceMemorySearchHit & { score: number; depth: number; index: number };

function searchableDirs(tenant: WorkspaceRoot, cwd: string) {
  const base = realOr(tenant.workspaceRoot);
  const target = realOr(cwd);
  if (!within(base, target) || target === base) return [];
  const dirs: string[] = [];
  let cur = target;
  while (cur !== base) {
    dirs.push(cur);
    cur = dirname(cur);
  }
  return dirs;
}

/** 只检索当前 cwd 的祖先链，明确排除 USER 根和兄弟工作区；检索本身不续期。 */
export function searchWorkspaceMemory(tenant: WorkspaceRoot, cwd: string, query: string, limit = MEMORY_SEARCH_LIMIT) {
  const terms = splitTerms(query);
  if (!terms.length) return [];
  const base = realOr(tenant.workspaceRoot);
  const rows: SearchRow[] = [];
  // 一次 search 只读一次个人记忆，避免逐行重复解析同一批 needles。
  const personalNeedles = readPersonalNeedles({ id: tenant.id, stateDir: tenant.stateDir });
  for (const [depth, dir] of searchableDirs(tenant, cwd).entries()) {
    let memoryPath: string;
    try {
      memoryPath = safeMemoryPaths(dir, base).memory;
    } catch {
      continue;
    }
    const lines = parseMemoryFile(readText(memoryPath));
    for (const [index, line] of lines.entries()) {
      const score = memoryRelevance(line, terms);
      if (score <= 0 || detectSecret(line.text) || leaksPersonal({ id: tenant.id, stateDir: tenant.stateDir }, line.text, personalNeedles)) continue;
      rows.push({
        id: line.id ?? null,
        layer: posix(relative(base, dir)),
        section: line.section,
        text: line.text,
        refs: line.refs,
        missingRefs: line.refs.filter((ref) => !existsSync(resolve(dir, ref))),
        state: line.state ?? null,
        effectiveState: effectiveMemoryState(line),
        at: line.at ?? null,
        used: line.used ?? null,
        uses: line.uses ?? 0,
        expires: line.expires ?? null,
        score,
        depth,
        index,
      });
    }
  }
  return rows
    .sort((a, b) => b.score - a.score || a.depth - b.depth || (b.used || b.at || "").localeCompare(a.used || a.at || "") || b.index - a.index)
    .slice(0, Math.max(1, Math.min(limit, MEMORY_SEARCH_LIMIT)))
    .map(({ score: _score, depth: _depth, index: _index, ...hit }) => hit);
}

function setMetaValue(inner: string, key: string, value: string) {
  const re = new RegExp(`(^|\\s)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=\\S+`);
  if (re.test(inner)) return inner.replace(re, (_all, prefix: string) => `${prefix}${key}=${value}`);
  const trailing = inner.match(/\s*$/)?.[0] ?? "";
  const body = inner.slice(0, inner.length - trailing.length);
  return `${body}${body && !/\s$/.test(body) ? " " : ""}${key}=${value}${trailing}`;
}

function updateUsageOnRawLine(raw: string, day: string) {
  const comment = /<!--([\s\S]*?)-->(\s*)$/.exec(raw);
  if (!comment || comment.index === undefined) return null;
  const parsedUses = /(?:^|\s)uses=(\d+)(?=\s|$)/.exec(comment[1]);
  let inner = setMetaValue(comment[1], "used", day);
  inner = setMetaValue(inner, "uses", String(Number(parsedUses?.[1] ?? 0) + 1));
  return `${raw.slice(0, comment.index)}<!--${inner}-->${comment[2]}`;
}

/**
 * 真正采用 search 结果后才调用：按稳定 id 定点更新 used/uses。
 * 无 id、重复 id、done/expired 都拒绝，不重排或重新 format 文件。
 */
export function markWorkspaceMemoryUsed(tenant: WorkspaceRoot, cwd: string, id: string, day = today()) {
  if (!id.trim()) return { ok: false, error: "这条记忆没有稳定 id，不能安全续期。" };
  const base = realOr(tenant.workspaceRoot);
  const matches: { path: string; lockTarget: string; row: number; line: MemoryLine; raw: string[] }[] = [];
  for (const dir of searchableDirs(tenant, cwd)) {
    let paths: SafeMemoryPaths;
    try {
      paths = safeMemoryPaths(dir, base);
    } catch {
      continue;
    }
    const path = paths.memory;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      // no memory file at this layer
    }
    if (!text) continue;
    const raw = text.split("\n");
    let section = "约定";
    for (let row = 0; row < raw.length; row += 1) {
      const head = raw[row].match(/^##\s+(.+?)\s*$/);
      if (head) {
        section = head[1];
        continue;
      }
      const parsed = parseMemoryFile(`## ${section}\n${raw[row]}`)[0];
      if (parsed?.id === id) matches.push({ path, lockTarget: paths.lockTarget, row, line: parsed, raw });
    }
  }
  if (!matches.length) return { ok: false, error: "当前工作区祖先链上没有这个 id；无 id 的人工条目不能 mark_used。" };
  if (matches.length > 1) return { ok: false, error: "这个 id 在祖先链上不唯一，为避免改错没有更新。" };
  const match = matches[0];
  return withFileLockSync(match.lockTarget, () => {
    try {
      safeMemoryPaths(dirname(dirname(match.path)), base);
    } catch {
      return { ok: false, error: "工作区记忆路径在加锁后变成了不安全的符号链接，没有更新。" };
    }
    const raw = readFileSync(match.path, "utf8").split("\n");
    const hits = raw
      .map((line, row) => ({ row, line: parseMemoryFile(`## 约定\n${line}`)[0] }))
      .filter((item) => item.line?.id === id);
    if (hits.length !== 1) return { ok: false, error: "加锁后目标 id 不再唯一或已不存在，没有更新。" };
    const current = hits[0];
    const state = effectiveMemoryState(current.line, day);
    if (state === "done" || state === "expired") return { ok: false, error: `${state} 条目只可检索，不能续期。` };
    const updated = updateUsageOnRawLine(raw[current.row], day);
    if (!updated) return { ok: false, error: "目标行没有可安全更新的元数据注释。" };
    raw[current.row] = updated;
    writeTextAtomic(match.path, raw.join("\n"));
    sweepStaleTmp(dirname(match.path), { patterns: [MEMORY_TMP_RE] });
    return { ok: true, id, used: day, uses: (current.line.uses ?? 0) + 1 };
  });
}

// ---------- 分层规则 ----------

function layerText(dir: string, depth: number, query = "", allowedRoot = dir) {
  const chunks: string[] = [];
  const take = (rel: string) => {
    const text = readText(resolve(dir, rel));
    if (text) chunks.push(`### ${rel}\n${text}`);
  };
  take(".cursorrules");
  take("AGENTS.md");
  const rulesDir = resolve(dir, ".cursor/rules");
  if (isDir(rulesDir)) {
    try {
      for (const name of readdirSync(rulesDir).sort()) {
        if (/\.(md|mdc)$/i.test(name)) take(`.cursor/rules/${name}`);
      }
    } catch {
      // no rules directory
    }
  }
  const memory = renderMemoryFile(dir, depth <= 1 ? LAYER_TOKEN_BUDGET.workspace : LAYER_TOKEN_BUDGET.repo, query, allowedRoot);
  if (memory) chunks.push(`### ${MEMORY_FILE}\n${memory}`);
  return chunks.join("\n\n");
}

/**
 * 按层拼规则：远层在前、近层在后，越近越优先；超出总上限时先砍远层。
 * cwd 在子工作区里时，USER 根目录那层不读（那是助理的人设）。
 */
export function layeredRules(root: string, cwd: string, cap = RULES_CHAR_CAP, query = "") {
  const base = realOr(root);
  const dirs = layerDirs(root, cwd);
  if (!dirs.length) return "";
  const layers = dirs
    .map((dir, i) => {
      const text = layerText(dir, dir === base ? 0 : i + 1, query, base);
      const label = dir === base ? "USER 根目录" : posix(relative(base, dir));
      return text ? { label, text } : null;
    })
    .filter((row): row is { label: string; text: string } => Boolean(row));
  if (!layers.length) return "";
  const single = layers.length === 1;
  const kept: string[] = new Array(layers.length).fill("");
  let left = cap;
  for (let i = layers.length - 1; i >= 0 && left > 0; i -= 1) {
    const block = single ? layers[i].text : `## 层：${layers[i].label}\n${layers[i].text}`;
    kept[i] = block.length > left ? `${block.slice(0, left)}\n（这一层太长，后面截掉了）` : block;
    left -= block.length;
  }
  const body = kept.filter(Boolean).join("\n\n");
  return single ? body : `下面按目录分层，越靠后越具体；冲突时以靠后的为准，且只在那一层目录内生效。\n\n${body}`;
}

/** 一次会话拿到的工作区上下文：W0 工作偏好 + 各层规则 */
export function workspaceContext(tenant: WorkspaceRoot, cwd: string, query = "") {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  return [renderWorkPreferences(ref), layeredRules(tenant.workspaceRoot, cwd, RULES_CHAR_CAP, query)].filter(Boolean).join("\n\n");
}

// ---------- 提议与确认卡 ----------

export type Proposal = {
  id: string;
  kind: "workspace" | "work_pref";
  chatId: string;
  /** 目标目录，相对 USER 根目录；工作偏好为空 */
  dir: string;
  section: string;
  text: string;
  refs: string[];
  createdAt: number;
  cardId?: string;
  /** 迁移时从哪条个人记忆搬过来：批准后那条标失效 */
  memoryId?: string;
  /** 直写在 store 中的短期占位；防止释放 store 锁后等待 memory 锁时并发重复。 */
  transient?: boolean;
};

export type Card = {
  callId: string;
  chatId: string;
  tool: typeof WORKSPACE_MEMORY_TOOL | typeof WORK_PREF_TOOL;
  summary: string;
  createdAt: number;
  expiresAt: number;
  origin?: "migration";
  /** answerCard 两阶段提交占位；崩溃后超过 30 秒可由下一次作答接管。 */
  processingToken?: string;
  processingAt?: number;
};

type StoreFile = { proposals: Proposal[]; cards: Card[] };

function storeFile(ref: TenantRef) {
  return assistantPath(ref, "workspace-memory.json");
}
function readStore(ref: TenantRef): StoreFile {
  const data = readJson<StoreFile>(storeFile(ref), { proposals: [], cards: [] });
  return { proposals: Array.isArray(data.proposals) ? data.proposals : [], cards: Array.isArray(data.cards) ? data.cards : [] };
}
function writeStore(ref: TenantRef, data: StoreFile) {
  writeJson(storeFile(ref), data);
}

function withStoreTransaction<T>(ref: TenantRef, fn: (data: StoreFile) => { value: T; changed?: boolean }) {
  const file = storeFile(ref);
  return withFileLockSync(file, () => {
    const data = readStore(ref);
    const result = fn(data);
    if (result.changed) writeStore(ref, data);
    return result.value;
  });
}

export function listProposals(ref: TenantRef) {
  return readStore(ref);
}

function cleanLine(text: string) {
  return clip(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<!--|-->/g, " ")
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    300,
  );
}

/** 个人记忆里的句子出现在提议里：多半是把“人”的信息写进了“事”，拒掉 */
function readPersonalNeedles(ref: TenantRef) {
  const needles: string[] = [];
  for (const entry of listMemory(ref).entries) {
    if (!isValid(entry)) continue;
    needles.push(entry.text.replace(/^(用户|他|她)(的)?/, "").replace(/[。.!！]$/, ""));
  }
  const core = readCore(ref);
  for (const key of PERSONAL_CORE_FIELDS) needles.push(...core.fields[key].split(/[。\n；;]/));
  return needles.map((item) => item.trim()).filter((needle) => needle.length >= 8);
}

export function leaksPersonal(ref: TenantRef, text: string, cachedNeedles?: string[]) {
  return (cachedNeedles ?? readPersonalNeedles(ref)).some((needle) => text.includes(needle));
}

export type ProposeInput = { chatId: string; cwd: string; path?: string; section: string; text: string; refs?: string };
export type ProposeResult = {
  ok: boolean;
  error?: string;
  duplicate?: boolean;
  matchedId?: string;
  matchKind?: MemoryMatch["matchKind"];
  similarity?: number;
  written?: number;
  queued?: number;
  note?: string;
};

/** 默认直接写；env 里要求确认时退回“攒着出确认卡”。 */
export function memoryNeedsConfirm() {
  return gatewayEnv.workspaceMemoryConfirm();
}

export function proposeWorkspaceMemory(
  tenant: WorkspaceRoot,
  input: ProposeInput,
  opts: { confirm?: boolean } = {},
): ProposeResult {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const base = realOr(tenant.workspaceRoot);
  const cwd = realOr(input.cwd);
  const target = realOr(resolve(cwd, input.path?.trim() || "."));
  if (!within(cwd, target) || !within(base, target) || target === base) {
    return { ok: false, error: "只能记进当前工作区或它下面的目录，不能记到 USER 根目录或工作区外面。" };
  }
  if (!isDir(target)) return { ok: false, error: `没有这个目录：${input.path}` };
  let targetMemory: SafeMemoryPaths;
  try {
    targetMemory = safeMemoryPaths(target, base);
  } catch (err) {
    return { ok: false, error: `工作区记忆路径不安全：${err instanceof Error ? err.message : String(err)}` };
  }
  const text = cleanLine(input.text || "");
  if (!text) return { ok: false, error: "内容为空。" };
  if (detectSecret(text)) return { ok: false, error: "内容像密钥或密码，按规则不记。" };
  if (leaksPersonal(ref, text)) return { ok: false, error: "这条像是用户的个人信息，工作区记忆不放个人信息。" };
  const section = (SECTIONS as readonly string[]).includes(input.section) ? input.section : "约定";
  const refs = (input.refs || "")
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter((item) => item && !item.includes("..") && !item.startsWith("/"))
    .slice(0, 5);
  const dir = posix(relative(base, target));
  const duplicateNote = "已经记过或已在等确认。继续手上的事，最后照常给用户写汇报。";
  const candidatesInFile = () =>
    parseMemoryFile(readText(targetMemory.memory)).map((line) => ({
      text: line.text,
      id: line.id,
    }));
  const reserve = (confirm: boolean) =>
    withStoreTransaction<{ result?: ProposeResult; id?: string }>(ref, (data) => {
      const cutoff = Date.now() - 30_000;
      const before = data.proposals.length;
      data.proposals = data.proposals.filter((item) => !item.transient || item.createdAt >= cutoff);
      const cleaned = data.proposals.length !== before;
      const queued = data.proposals.filter((item) => item.chatId === input.chatId && !item.cardId && !item.transient);
      if (queued.length >= MAX_QUEUED_PER_CHAT) {
        return {
          changed: cleaned,
          value: { result: { ok: false, error: `这个线程攒了 ${MAX_QUEUED_PER_CHAT} 条待确认，先等用户确认。` } },
        };
      }
      const pendingCandidates = data.proposals
        .filter((item) => item.kind === "workspace" && item.dir === dir)
        .map((item) => ({ text: item.text, id: item.id }));
      const match = findMemoryMatch(text, [...candidatesInFile(), ...pendingCandidates]);
      if (match) {
        return {
          changed: cleaned,
          value: { result: { ok: true, duplicate: true, ...match, note: duplicateNote } },
        };
      }
      const id = newId("wm");
      data.proposals.push({
        id,
        kind: "workspace",
        chatId: input.chatId,
        dir,
        section,
        text,
        refs,
        createdAt: Date.now(),
        transient: !confirm || undefined,
      });
      return {
        changed: true,
        value: confirm
          ? {
              result: {
                ok: true,
                queued: queued.length + 1,
                note: "先攒着，线程空闲后合成一张确认卡请用户批准，批准了才写进 .jiebo/memory.md。不用等它，继续手上的事，最后照常给用户写汇报。",
              },
            }
          : { id },
      };
    });

  const reserved = reserve(Boolean(opts.confirm));
  if (reserved.result) return reserved.result;
  const id = reserved.id!;
  // 锁顺序：直写绝不同时持有 store 与 memory 锁；store 占位 → memory 写入 → store 清占位。
  try {
    const appended = appendMemoryLinesDetailed(target, [{ section, text, id, from: input.chatId, at: today(), refs }], base);
    const item = appended.items[0];
    if (item?.status === "duplicate") {
      return { ok: true, duplicate: true, ...item.match, note: duplicateNote };
    }
    return { ok: true, written: appended.written, note: `已写进 ${dir}/${MEMORY_FILE}。继续手上的事，最后照常给用户写汇报。` };
  } catch (err) {
    return { ok: false, error: `写 ${dir}/${MEMORY_FILE} 失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try {
      withStoreTransaction(ref, (data) => {
        const kept = data.proposals.filter((item) => item.id !== id || !item.transient);
        const changed = kept.length !== data.proposals.length;
        data.proposals = kept;
        return { value: undefined, changed };
      });
    } catch {
      // 已完成的直写不能被占位清理失败覆盖；30 秒后下次事务会回收该占位。
    }
  }
}

function cardSummary(items: Proposal[]) {
  const head = items[0]?.kind === "work_pref" ? "工作偏好" : items[0]?.dir || "";
  const body = items.map((item) => clip(item.text, 60)).join("；");
  return clip(`${head} · ${items.length} 条：${body}`, 400);
}

function cardInboxBody(items: Proposal[], ttlMs: number, note?: string) {
  const days = Math.round(ttlMs / 86_400_000);
  const lines = items.map((item) =>
    item.kind === "work_pref" ? `- ${item.text}` : `- [${item.section}] ${item.text}${item.refs.length ? `（引用 ${item.refs.join("、")}）` : ""}`,
  );
  return [...(note ? [note, ""] : []), ...lines, "", `在待批里点“批准”或“拒绝”。${days} 天没答复就作废，原数据不受影响。`].join("\n");
}

function addCardToStore(data: StoreFile, input: Parameters<typeof openCard>[1], now = Date.now()) {
  const ttlMs = input.ttlMs ?? CARD_TTL_MS;
  const card: Card = {
    callId: crypto.randomUUID(),
    chatId: input.chatId,
    tool: input.tool,
    summary: cardSummary(input.items),
    createdAt: now,
    expiresAt: now + ttlMs,
    origin: input.origin,
  };
  const ids = new Set(input.items.map((item) => item.id));
  const known = new Set(data.proposals.map((item) => item.id));
  data.proposals = [
    ...data.proposals.map((item) => (ids.has(item.id) ? { ...item, cardId: card.callId } : item)),
    ...input.items.filter((item) => !known.has(item.id)).map((item) => ({ ...item, cardId: card.callId })),
  ];
  data.cards.push(card);
  return { card, ttlMs };
}

function publishCard(ref: TenantRef, input: Parameters<typeof openCard>[1], card: Card, ttlMs: number) {
  addApproval(ref, { chatId: card.chatId, callId: card.callId, tool: card.tool, summary: card.summary }, card.createdAt, ttlMs);
  postInbox(ref, {
    kind: "approval",
    title: input.title,
    body: cardInboxBody(input.items, ttlMs, input.note),
    key: `approval:${card.chatId}:${card.callId}`,
    chatId: card.chatId,
  });
}

/** 新开一张确认卡：落盘 + 挂起审批（客户端渲染）+ 收件箱（推送） */
export function openCard(
  ref: TenantRef,
  input: { chatId: string; tool: Card["tool"]; items: Proposal[]; ttlMs?: number; title: string; note?: string; origin?: Card["origin"] },
) {
  if (!input.items.length) return null;
  const added = withStoreTransaction(ref, (data) => {
    const result = addCardToStore(data, input);
    return { value: result, changed: true };
  });
  publishCard(ref, input, added.card, added.ttlMs);
  return added.card;
}

/** 把这个线程攒下的提议合成一张卡；没有就什么都不做 */
export function flushChat(ref: TenantRef, chatId: string) {
  const result = withStoreTransaction(ref, (data) => {
    const items = data.proposals.filter((item) => item.chatId === chatId && !item.cardId && !item.transient);
    if (!items.length) return { value: null };
    const dirs = [...new Set(items.map((item) => item.dir))];
    const input = {
      chatId,
      tool: WORKSPACE_MEMORY_TOOL,
      items,
      title: `有 ${items.length} 条工作区记忆等你确认（${dirs.join("、")}）`,
    } satisfies Parameters<typeof openCard>[1];
    return { value: { ...addCardToStore(data, input), input }, changed: true };
  });
  if (!result) return null;
  publishCard(ref, result.input, result.card, result.ttlMs);
  return result.card;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function cancelFlush(ref: TenantRef, chatId: string) {
  const key = `${ref.id}:${chatId}`;
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

/** 回合结束：线程空闲这么久还没新回合，就把攒的提议合成确认卡 */
export function scheduleFlush(ref: TenantRef, chatId: string, onChange: () => void, delayMs = IDLE_FLUSH_MS) {
  const hasQueued = readStore(ref).proposals.some((item) => item.chatId === chatId && !item.cardId && !item.transient);
  if (!hasQueued) return false;
  cancelFlush(ref, chatId);
  const key = `${ref.id}:${chatId}`;
  const timer = setTimeout(() => {
    timers.delete(key);
    if (flushChat(ref, chatId)) onChange();
  }, delayMs);
  timer.unref?.();
  timers.set(key, timer);
  return true;
}

export type CardAnswer = { ok: boolean; error?: string; written?: number };
const CARD_PROCESSING_STALE_MS = 30_000;
type CardClaim =
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "busy" }
  | { kind: "claimed"; card: Card; items: Proposal[] };

/** 作答确认卡。不是这类卡返回 null，调用方继续按别的审批处理 */
export function answerCard(tenant: WorkspaceRoot, chatId: string, callId: string, allow: boolean): CardAnswer | null {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const processingToken = crypto.randomUUID();
  const claimedAt = Date.now();
  const claim = withStoreTransaction<CardClaim>(ref, (data) => {
    const card = data.cards.find((item) => item.callId === callId && item.chatId === chatId);
    if (!card) return { value: { kind: "missing" as const } };
    if (card.expiresAt <= claimedAt) {
      data.cards = data.cards.filter((item) => item.callId !== callId);
      data.proposals = data.proposals.filter((item) => item.cardId !== callId);
      return {
        changed: true,
        value: { kind: "expired" as const },
      };
    }
    if (card.processingToken && claimedAt - (card.processingAt ?? claimedAt) < CARD_PROCESSING_STALE_MS) {
      return { value: { kind: "busy" as const } };
    }
    card.processingToken = processingToken;
    card.processingAt = claimedAt;
    return {
      changed: true,
      value: {
        kind: "claimed" as const,
        card: { ...card },
        items: data.proposals.filter((item) => item.cardId === callId).map((item) => ({ ...item })),
      },
    };
  });
  if (claim.kind === "missing") return null;
  if (claim.kind === "expired") {
    settleApproval(ref, chatId, callId);
    return allow ? { ok: false, error: "这张卡已过期作废，原数据没动。" } : { ok: true, written: 0 };
  }
  if (claim.kind === "busy") return { ok: false, error: "这张卡正在由另一个进程处理，请稍后重试。" };

  const { card, items } = claim;
  let written = 0;
  const errors: string[] = [];
  const retry: Proposal[] = [];
  const landed = new Set<string>();
  if (allow) {
    const base = realOr(tenant.workspaceRoot);
    const byDir = new Map<string, Proposal[]>();
    for (const item of items) {
      if (item.kind === "work_pref") {
        const preference = addWorkPreference(ref, item.text, "page");
        if (preference.ok) {
          written += 1;
          landed.add(item.id);
        } else errors.push(preference.error);
        continue;
      }
      byDir.set(item.dir, [...(byDir.get(item.dir) ?? []), item]);
    }
    for (const [dir, rows] of byDir) {
      const abs = realOr(resolve(base, dir));
      if (!dir || !within(base, abs) || abs === base || !isDir(abs)) {
        errors.push(`目录 ${dir} 不在了，没写。`);
        continue;
      }
      try {
        const appended = appendMemoryLinesDetailed(
          abs,
          rows.map((row) => ({ section: row.section, text: row.text, id: row.id, from: row.chatId, at: today(), refs: row.refs })),
          base,
        );
        written += appended.written;
        appended.items.forEach((result, index) => {
          // duplicate 也只在锁内确认已有等价持久化行（或本批更早已写入）后才算落地。
          if (result.status === "written" || result.status === "duplicate") landed.add(rows[index].id);
        });
      } catch (err) {
        errors.push(`写 ${dir}/${MEMORY_FILE} 失败：${err instanceof Error ? err.message : String(err)}`);
        retry.push(...rows);
      }
    }
  }

  const retryInput = retry.length
    ? ({
        chatId,
        tool: card.tool,
        items: retry.map(({ cardId: _, ...item }) => item),
        title: `有 ${retry.length} 条工作区记忆上次没写成，再确认一次`,
        note: `上次写 ${[...new Set(retry.map((row) => row.dir).filter(Boolean))].join("、") || "工作区记忆"} 失败，请再确认一次。`,
        origin: card.origin,
      } satisfies Parameters<typeof openCard>[1])
    : undefined;
  let retryPublish: { input: Parameters<typeof openCard>[1]; card: Card; ttlMs: number } | undefined;
  const finalized = withStoreTransaction(ref, (data) => {
    const current = data.cards.find((item) => item.callId === callId && item.chatId === chatId);
    if (!current || current.processingToken !== processingToken) return { value: false };
    data.cards = data.cards.filter((item) => item.callId !== callId);
    data.proposals = data.proposals.filter((item) => item.cardId !== callId);
    if (retryInput) retryPublish = { input: retryInput, ...addCardToStore(data, retryInput) };
    return { value: true, changed: true };
  });
  if (!finalized) return { ok: false, error: "确认卡处理状态已变化；已落地内容会在下次重试时安全去重。", written };

  for (const item of items) {
    if (!item.memoryId || !landed.has(item.id)) continue;
    const reason = item.kind === "work_pref" ? "已移到「工作偏好」" : `已移到工作区记忆 ${item.dir}/${MEMORY_FILE}`;
    invalidateMemory(ref, item.memoryId, reason, "page");
  }
  settleApproval(ref, chatId, callId);
  if (retryPublish) {
    publishCard(ref, retryPublish.input, retryPublish.card, retryPublish.ttlMs);
    errors.push("没写成的已重新出卡，可以再批准一次。");
  }
  const result = errors.length ? { ok: written > 0, error: errors.join(" "), written } : { ok: true, written };
  return result;
}

/** 过期的卡作废：提议丢掉，原数据不动 */
export function expireCards(ref: TenantRef, now = Date.now()) {
  const dead = withStoreTransaction(ref, (data) => {
    const expired = data.cards.filter(
      (card) =>
        card.expiresAt <= now &&
        (!card.processingToken || now - (card.processingAt ?? now) >= CARD_PROCESSING_STALE_MS),
    );
    if (!expired.length) return { value: [] };
    const ids = new Set(expired.map((card) => card.callId));
    data.cards = data.cards.filter((card) => !ids.has(card.callId));
    data.proposals = data.proposals.filter((item) => !item.cardId || !ids.has(item.cardId));
    return { value: expired, changed: true };
  });
  for (const card of dead) settleApproval(ref, card.chatId, card.callId);
  return dead.length;
}

/** 网关重启：挂起审批被清空了，把还没过期的卡挂回去；重启前攒着没出卡的直接出卡 */
export function restoreCards(ref: TenantRef, now = Date.now()) {
  const actions = withStoreTransaction(ref, (data) => {
    const proposalCount = data.proposals.length;
    data.proposals = data.proposals.filter((item) => !item.transient);
    const hadProcessing = data.cards.some((card) => card.processingToken || card.processingAt);
    if (hadProcessing) {
      data.cards = data.cards.map(({ processingToken: _token, processingAt: _at, ...card }) => card);
    }
    const dead = data.cards.filter((card) => card.expiresAt <= now);
    const deadIds = new Set(dead.map((card) => card.callId));
    if (dead.length) {
      data.cards = data.cards.filter((card) => !deadIds.has(card.callId));
      data.proposals = data.proposals.filter((item) => !item.cardId || !deadIds.has(item.cardId));
    }
    const existing = data.cards.map((card) => ({ ...card }));
    const chats = [...new Set(data.proposals.filter((item) => !item.cardId && !item.transient).map((item) => item.chatId))];
    const created: { input: Parameters<typeof openCard>[1]; card: Card; ttlMs: number }[] = [];
    for (const chatId of chats) {
      const items = data.proposals.filter((item) => item.chatId === chatId && !item.cardId && !item.transient);
      const dirs = [...new Set(items.map((item) => item.dir))];
      const input = {
        chatId,
        tool: WORKSPACE_MEMORY_TOOL,
        items,
        title: `有 ${items.length} 条工作区记忆等你确认（${dirs.join("、")}）`,
      } satisfies Parameters<typeof openCard>[1];
      created.push({ input, ...addCardToStore(data, input, now) });
    }
    return {
      value: { dead, existing, created },
      changed: Boolean(dead.length || created.length || proposalCount !== data.proposals.length || hadProcessing),
    };
  });
  for (const card of actions.dead) settleApproval(ref, card.chatId, card.callId);
  const stillActive = (card: Card) =>
    withStoreTransaction(ref, (data) => ({
      value: data.cards.some(
        (current) => current.callId === card.callId && current.chatId === card.chatId && current.expiresAt > Date.now(),
      ),
    }));
  for (const card of actions.existing) {
    if (!stillActive(card)) continue;
    addApproval(ref, { chatId: card.chatId, callId: card.callId, tool: card.tool, summary: card.summary }, now, card.expiresAt - now);
  }
  for (const action of actions.created) {
    if (stillActive(action.card)) publishCard(ref, action.input, action.card, action.ttlMs);
  }
  return actions.existing.length + actions.created.length;
}

// ---------- 工作区线程摘要索引 ----------

export type ThreadSummary = { chatId: string; dir: string; title: string; ask: string; lastAsk: string; outcome: string; turns: number; at: number };

type ThreadFile = { threads: ThreadSummary[] };
const MAX_THREADS = 800;

function threadFile(ref: TenantRef) {
  return assistantPath(ref, "workspace-index.json");
}

function summarize(text: string, max: number) {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (detectSecret(plain)) return "（含疑似密钥，没收录）";
  return clip(plain, max);
}

/** 工作区会话每轮结束更新一行：第一问、最近一问、最近结论；不存全文 */
export function noteWorkspaceThread(
  tenant: WorkspaceRoot,
  row: { chatId: string; cwd: string; title: string; user: string; assistant: string },
) {
  if (!row.user.trim()) return;
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const base = realOr(tenant.workspaceRoot);
  const cwd = realOr(row.cwd);
  if (!within(base, cwd) || cwd === base) return;
  const data = readJson<ThreadFile>(threadFile(ref), { threads: [] });
  const at = data.threads.findIndex((item) => item.chatId === row.chatId);
  const prev = at >= 0 ? data.threads[at] : undefined;
  const lastPara = row.assistant.trim().split(/\n{2,}/).filter(Boolean);
  const next: ThreadSummary = {
    chatId: row.chatId,
    dir: posix(relative(base, cwd)),
    title: clip(row.title, 60),
    ask: prev?.ask || summarize(row.user, 160),
    lastAsk: summarize(row.user, 160),
    outcome: summarize(lastPara[0] || "", 240),
    turns: (prev?.turns ?? 0) + 1,
    at: Date.now(),
  };
  if (at >= 0) data.threads.splice(at, 1);
  data.threads.push(next);
  data.threads = data.threads.slice(-MAX_THREADS);
  writeJson(threadFile(ref), data);
}

export function dropWorkspaceThread(ref: TenantRef, chatId: string) {
  const data = readJson<ThreadFile>(threadFile(ref), { threads: [] });
  const kept = data.threads.filter((item) => item.chatId !== chatId);
  if (kept.length !== data.threads.length) writeJson(threadFile(ref), { threads: kept });
}

/** 彻底删除记忆时一并抹掉摘要里的相关片段 */
export function scrubWorkspaceIndex(ref: TenantRef, needles: string[]) {
  const data = readJson<ThreadFile>(threadFile(ref), { threads: [] });
  let changed = 0;
  for (const thread of data.threads) {
    for (const field of ["title", "ask", "lastAsk", "outcome"] as const) {
      let value = thread[field];
      for (const needle of needles) if (needle && value.includes(needle)) value = value.split(needle).join("［已抹掉］");
      if (value !== thread[field]) {
        thread[field] = value;
        changed += 1;
      }
    }
  }
  if (changed) writeJson(threadFile(ref), data);
  return changed;
}

/** 助理只读查看某个子工作区：各层规则与工作区记忆（含下一层仓库），加最近的线程摘要 */
export function readWorkspaceMemory(tenant: WorkspaceRoot, workspace: string, query = "") {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const base = realOr(tenant.workspaceRoot);
  const name = workspace.replace(/^\.\//, "").replace(/\/+$/, "");
  const dir = realOr(resolve(base, name));
  if (!name || name.includes("..") || !within(base, dir) || dir === base || !isDir(dir)) {
    return { ok: false, error: `没有这个子工作区：${workspace}` };
  }
  const rel = posix(relative(base, dir));
  const layers: { dir: string; text: string }[] = [];
  const own = layerText(dir, 1, query, base);
  if (own) layers.push({ dir: rel, text: own });
  try {
    for (const child of readdirSync(dir).sort()) {
      if (child.startsWith(".") || child === "node_modules") continue;
      const abs = resolve(dir, child);
      if (!isDir(abs)) continue;
      const text = layerText(abs, 2, query, base);
      if (text) layers.push({ dir: `${rel}/${child}`, text });
    }
  } catch {
    // unreadable workspace
  }
  const threads = readJson<ThreadFile>(threadFile(ref), { threads: [] }).threads.filter(
    (item) => item.dir === rel || item.dir.startsWith(`${rel}/`),
  );
  const terms = splitTerms(query);
  const scored = terms.length
    ? threads
        .map((item) => {
          const hay = `${item.title} ${item.ask} ${item.lastAsk} ${item.outcome}`.toLowerCase();
          return { item, score: terms.filter((term) => hay.includes(term)).length };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || b.item.at - a.item.at)
        .map((row) => row.item)
    : [...threads].sort((a, b) => b.at - a.at);
  let budget = 8000;
  const outLayers = layers.map((layer) => {
    const text = layer.text.slice(0, Math.max(budget, 0));
    budget -= text.length;
    return { dir: layer.dir, text };
  }).filter((layer) => layer.text);
  return {
    ok: true,
    workspace: rel,
    layers: outLayers,
    threads: scored.slice(0, 8).map((item) => ({
      chatId: item.chatId,
      dir: item.dir,
      title: item.title,
      ask: item.ask,
      lastAsk: item.lastAsk,
      outcome: item.outcome,
      turns: item.turns,
      at: new Date(item.at).toISOString(),
    })),
  };
}
