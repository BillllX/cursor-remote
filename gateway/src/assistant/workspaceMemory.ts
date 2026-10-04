import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
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
import { assistantPath, clip, estimateTokens, newId, readJson, writeJson, type TenantRef } from "./store.ts";

/**
 * 工作区记忆（“事”这条线）：
 * - 规则：从 cwd 往上走到 USER 根目录，每层读 .cursorrules、AGENTS.md、.cursor/rules/*、.jiebo/memory.md，近层放后面；
 *   USER 根目录那层属于助理（人设），只在根目录会话里读。
 * - .jiebo/memory.md 由机器维护、人可以改：每条一行，行尾注释记来源和引用的路径，引用失效就标“待核实”。
 * - 写入只走“提议 → 线程空闲时合成一张确认卡 → 用户批准”，不直接写。
 * - 会话摘要索引只存每个工作区线程的一行摘要，供助理只读查询；整理者不读。
 */

export type WorkspaceRoot = { id: string; stateDir: string; workspaceRoot: string };

export const MEMORY_FILE = ".jiebo/memory.md";
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
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
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

export type MemoryLine = { section: string; text: string; id?: string; from?: string; at?: string; refs: string[] };

const META_RE = /\s*<!--\s*(.*?)\s*-->\s*$/;

export function parseMemoryFile(text: string): MemoryLine[] {
  const out: MemoryLine[] = [];
  let section = "约定";
  for (const raw of text.split("\n")) {
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
    });
  }
  return out;
}

function formatLine(line: MemoryLine) {
  const meta = [
    line.id ? `id=${line.id}` : "",
    line.from ? `from=${line.from}` : "",
    line.at ? `at=${line.at}` : "",
    line.refs.length ? `refs=${line.refs.join(",")}` : "",
  ].filter(Boolean);
  return `- ${line.text}${meta.length ? ` <!-- ${meta.join(" ")} -->` : ""}`;
}

const FILE_HEAD = [
  "# 工作区记忆",
  "",
  "<!-- 接驳维护：每条一行，可以手改或删。行尾注释是来源和引用的路径，引用的文件没了会标“待核实”。这里不放个人信息。 -->",
].join("\n");

/** 默认不进版本库：.jiebo/ 下放一份只忽略 memory.md 的 .gitignore；已有的不动，删掉它就会被提交 */
function ensureIgnored(dir: string) {
  const ignore = resolve(dir, ".jiebo", ".gitignore");
  if (existsSync(ignore)) return;
  writeTextAtomic(ignore, "# 接驳的工作区记忆默认不进版本库；想跟代码一起提交就删掉这个文件\nmemory.md\n");
}

/** 写回时保留人手加的行和顺序，只在对应小节末尾追加新行 */
export function appendMemoryLines(dir: string, lines: MemoryLine[]) {
  const path = resolve(dir, MEMORY_FILE);
  const current = readText(path);
  if (!current) ensureIgnored(dir);
  const known = new Set(parseMemoryFile(current).map((line) => line.text));
  const fresh = lines.filter((line) => line.text && !known.has(line.text));
  if (!fresh.length) return 0;
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
    rows.splice(end, 0, formatLine(line));
  }
  writeTextAtomic(path, `${rows.join("\n").trim()}\n`);
  return fresh.length;
}

/** 渲染进提示词：引用的路径不存在了就标待核实；超预算的留在文件里 */
export function renderMemoryFile(dir: string, budget: number) {
  const lines = parseMemoryFile(readText(resolve(dir, MEMORY_FILE)));
  if (!lines.length) return "";
  const out: string[] = [];
  let used = 0;
  let skipped = 0;
  let section = "";
  for (const line of lines) {
    const missing = line.refs.filter((ref) => !existsSync(resolve(dir, ref)));
    const text = `- ${line.text}${missing.length ? `（待核实：引用的 ${missing.join("、")} 不在了）` : ""}`;
    const cost = estimateTokens(text);
    if (used + cost > budget) {
      skipped += 1;
      continue;
    }
    if (line.section !== section) {
      section = line.section;
      out.push(`${section}：`);
    }
    out.push(text);
    used += cost;
  }
  if (skipped) out.push(`（还有 ${skipped} 条没放进来，见 ${MEMORY_FILE}）`);
  return out.join("\n");
}

// ---------- 分层规则 ----------

function layerText(dir: string, depth: number) {
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
  const memory = renderMemoryFile(dir, depth <= 1 ? LAYER_TOKEN_BUDGET.workspace : LAYER_TOKEN_BUDGET.repo);
  if (memory) chunks.push(`### ${MEMORY_FILE}\n${memory}`);
  return chunks.join("\n\n");
}

/**
 * 按层拼规则：远层在前、近层在后，越近越优先；超出总上限时先砍远层。
 * cwd 在子工作区里时，USER 根目录那层不读（那是助理的人设）。
 */
export function layeredRules(root: string, cwd: string, cap = RULES_CHAR_CAP) {
  const base = realOr(root);
  const dirs = layerDirs(root, cwd);
  if (!dirs.length) return "";
  const layers = dirs
    .map((dir, i) => {
      const text = layerText(dir, dir === base ? 0 : i + 1);
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
export function workspaceContext(tenant: WorkspaceRoot, cwd: string) {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  return [renderWorkPreferences(ref), layeredRules(tenant.workspaceRoot, cwd)].filter(Boolean).join("\n\n");
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
};

export type Card = {
  callId: string;
  chatId: string;
  tool: typeof WORKSPACE_MEMORY_TOOL | typeof WORK_PREF_TOOL;
  summary: string;
  createdAt: number;
  expiresAt: number;
  origin?: "migration";
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
function leaksPersonal(ref: TenantRef, text: string) {
  const needles: string[] = [];
  for (const entry of listMemory(ref).entries) {
    if (!isValid(entry)) continue;
    needles.push(entry.text.replace(/^(用户|他|她)(的)?/, "").replace(/[。.!！]$/, ""));
  }
  const core = readCore(ref);
  for (const key of PERSONAL_CORE_FIELDS) needles.push(...core.fields[key].split(/[。\n；;]/));
  return needles.map((item) => item.trim()).some((needle) => needle.length >= 8 && text.includes(needle));
}

export type ProposeInput = { chatId: string; cwd: string; path?: string; section: string; text: string; refs?: string };

export function proposeWorkspaceMemory(tenant: WorkspaceRoot, input: ProposeInput) {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const base = realOr(tenant.workspaceRoot);
  const cwd = realOr(input.cwd);
  const target = realOr(resolve(cwd, input.path?.trim() || "."));
  if (!within(cwd, target) || !within(base, target) || target === base) {
    return { ok: false, error: "只能记进当前工作区或它下面的目录，不能记到 USER 根目录或工作区外面。" };
  }
  if (!isDir(target)) return { ok: false, error: `没有这个目录：${input.path}` };
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
  const data = readStore(ref);
  const queued = data.proposals.filter((item) => item.chatId === input.chatId && !item.cardId);
  if (queued.length >= MAX_QUEUED_PER_CHAT) return { ok: false, error: `这个线程攒了 ${MAX_QUEUED_PER_CHAT} 条待确认，先等用户确认。` };
  const inFile = parseMemoryFile(readText(resolve(target, MEMORY_FILE))).some((line) => line.text === text);
  const pending = data.proposals.some((item) => item.dir === dir && item.text === text);
  if (inFile || pending) return { ok: true, duplicate: true, note: "已经记过或已在等确认。" };
  data.proposals.push({ id: newId("wm"), kind: "workspace", chatId: input.chatId, dir, section, text, refs, createdAt: Date.now() });
  writeStore(ref, data);
  return { ok: true, queued: queued.length + 1, note: "先攒着，线程空闲后合成一张确认卡请用户批准，批准了才写进 .jiebo/memory.md。" };
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

/** 新开一张确认卡：落盘 + 挂起审批（客户端渲染）+ 收件箱（推送） */
export function openCard(
  ref: TenantRef,
  input: { chatId: string; tool: Card["tool"]; items: Proposal[]; ttlMs?: number; title: string; note?: string; origin?: Card["origin"] },
) {
  if (!input.items.length) return null;
  const ttlMs = input.ttlMs ?? CARD_TTL_MS;
  const data = readStore(ref);
  const now = Date.now();
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
  writeStore(ref, data);
  addApproval(ref, { chatId: card.chatId, callId: card.callId, tool: card.tool, summary: card.summary }, now, ttlMs);
  postInbox(ref, {
    kind: "approval",
    title: input.title,
    body: cardInboxBody(input.items, ttlMs, input.note),
    key: `approval:${card.chatId}:${card.callId}`,
    chatId: card.chatId,
  });
  return card;
}

/** 把这个线程攒下的提议合成一张卡；没有就什么都不做 */
export function flushChat(ref: TenantRef, chatId: string) {
  const items = readStore(ref).proposals.filter((item) => item.chatId === chatId && !item.cardId);
  if (!items.length) return null;
  const dirs = [...new Set(items.map((item) => item.dir))];
  return openCard(ref, {
    chatId,
    tool: WORKSPACE_MEMORY_TOOL,
    items,
    title: `有 ${items.length} 条工作区记忆等你确认（${dirs.join("、")}）`,
  });
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
  const hasQueued = readStore(ref).proposals.some((item) => item.chatId === chatId && !item.cardId);
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

/** 作答确认卡。不是这类卡返回 null，调用方继续按别的审批处理 */
export function answerCard(tenant: WorkspaceRoot, chatId: string, callId: string, allow: boolean): CardAnswer | null {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  const data = readStore(ref);
  const card = data.cards.find((item) => item.callId === callId && item.chatId === chatId);
  if (!card) return null;
  const items = data.proposals.filter((item) => item.cardId === callId);
  let written = 0;
  const errors: string[] = [];
  if (allow) {
    const base = realOr(tenant.workspaceRoot);
    const byDir = new Map<string, Proposal[]>();
    const landed = new Set<string>();
    for (const item of items) {
      if (item.kind === "work_pref") {
        const result = addWorkPreference(ref, item.text, "page");
        if (result.ok) {
          written += 1;
          landed.add(item.id);
        } else errors.push(result.error);
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
        written += appendMemoryLines(
          abs,
          rows.map((row) => ({ section: row.section, text: row.text, id: row.id, from: row.chatId, at: today(), refs: row.refs })),
        );
        for (const row of rows) landed.add(row.id);
      } catch (err) {
        errors.push(`写 ${dir}/${MEMORY_FILE} 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const item of items) {
      if (!item.memoryId || !landed.has(item.id)) continue;
      const reason = item.kind === "work_pref" ? "已移到「工作偏好」" : `已移到工作区记忆 ${item.dir}/${MEMORY_FILE}`;
      invalidateMemory(ref, item.memoryId, reason, "page");
    }
  }
  data.cards = data.cards.filter((item) => item.callId !== callId);
  data.proposals = data.proposals.filter((item) => item.cardId !== callId);
  writeStore(ref, data);
  settleApproval(ref, chatId, callId);
  return errors.length ? { ok: written > 0, error: errors.join(" "), written } : { ok: true, written };
}

/** 过期的卡作废：提议丢掉，原数据不动 */
export function expireCards(ref: TenantRef, now = Date.now()) {
  const data = readStore(ref);
  const dead = data.cards.filter((card) => card.expiresAt <= now);
  if (!dead.length) return 0;
  const ids = new Set(dead.map((card) => card.callId));
  data.cards = data.cards.filter((card) => !ids.has(card.callId));
  data.proposals = data.proposals.filter((item) => !item.cardId || !ids.has(item.cardId));
  writeStore(ref, data);
  for (const card of dead) settleApproval(ref, card.chatId, card.callId);
  return dead.length;
}

/** 网关重启：挂起审批被清空了，把还没过期的卡挂回去；重启前攒着没出卡的直接出卡 */
export function restoreCards(ref: TenantRef, now = Date.now()) {
  expireCards(ref, now);
  const data = readStore(ref);
  for (const card of data.cards) {
    addApproval(ref, { chatId: card.chatId, callId: card.callId, tool: card.tool, summary: card.summary }, now, card.expiresAt - now);
  }
  const chats = [...new Set(data.proposals.filter((item) => !item.cardId).map((item) => item.chatId))];
  for (const chatId of chats) flushChat(ref, chatId);
  return data.cards.length + chats.length;
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
  const own = layerText(dir, 1);
  if (own) layers.push({ dir: rel, text: own });
  try {
    for (const child of readdirSync(dir).sort()) {
      if (child.startsWith(".") || child === "node_modules") continue;
      const abs = resolve(dir, child);
      if (!isDir(abs)) continue;
      const text = layerText(abs, 2);
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
