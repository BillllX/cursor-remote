import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { postInbox } from "./inbox.ts";
import { audit, detectSensitive, isValid, listMemory, memoryFiles, migrateMemoryShapeV2, readCore, workPreferenceLines, type MemoryEntry } from "./memory.ts";
import { assistantDir, assistantPath, clip, newId, readJson, writeJson, type TenantRef } from "./store.ts";
import { listProposals, openCard, WORK_PREF_TOOL, WORKSPACE_MEMORY_TOOL, type Proposal, type Section, type WorkspaceRoot } from "./workspaceMemory.ts";

/**
 * 记忆 v1 → v2（两条线分层）。每个租户只跑一次，靠 memory/schema.json 的 version 判断，可重入。
 * 1. 先把 core.json、entries.json 备份到 memory/backup-v1/（已有备份不覆盖）。
 * 2. 核心档案补「工作偏好」一栏；老推断条目记作出现过一次（不再常驻，检索照旧）。
 * 3. 只出确认卡、不自动搬：
 *    - 根目录 AGENTS.md 等里的通用工作习惯、你说过的跨项目工作习惯 → 「工作偏好」候选；
 *    - 个人记忆里提到某个子工作区 / 仓库的项目知识 → 那个目录的 .jiebo/memory.md 候选，批准后原条目标失效（可恢复）。
 */

export const MEMORY_SCHEMA_VERSION = 2;
export const MIGRATION_CARD_TTL_MS = 14 * 24 * 3_600_000;

type SchemaFile = { version: number; migratedAt?: string; report?: MigrationReport };

export type MigrationReport = {
  backedUp: string[];
  inferredDemoted: number;
  coreChanged: boolean;
  workPrefCandidates: number;
  workspaceCandidates: Record<string, number>;
};

const WORK_HABIT_RE =
  /(中文|英文|语言|回复|回答|emoji|表情|注释|测试|提交信息|commit|代码风格|缩进|格式化|命名|一次配好|直接照做|先跑|评审|review|简洁|结论先行)/i;
const PERSONA_RE = /(语气|可爱|活泼|人设|名字|叫你|称呼)/;
const LIFE_RE = /(住在|家住|家庭住址|家里|老婆|老公|妻子|丈夫|孩子|女儿|儿子|父母|生日|手机号|电话|身体|过敏|吃素|宠物)/;

function schemaFile(ref: TenantRef) {
  return assistantPath(ref, "memory", "schema.json");
}

export function memorySchemaVersion(ref: TenantRef) {
  return readJson<SchemaFile>(schemaFile(ref), { version: 1 }).version || 1;
}

function readText(path: string) {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function sentences(text: string) {
  return text
    .replace(/^---[\s\S]*?---/, "")
    .split(/[。\n；;！!]/)
    .map((line) => line.replace(/^[\s#>*\-•\d.、]+/, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 120);
}

/** 根目录的规则文件里，像“通用工作习惯”而不是人设的句子 */
function rootHabits(root: string) {
  const files = [".cursorrules", "AGENTS.md"].map((name) => resolve(root, name));
  const rulesDir = resolve(root, ".cursor/rules");
  try {
    for (const name of readdirSync(rulesDir).sort()) if (/\.(md|mdc)$/i.test(name)) files.push(resolve(rulesDir, name));
  } catch {
    // no rules dir
  }
  const out: string[] = [];
  for (const file of files) {
    for (const line of sentences(readText(file))) {
      if (WORK_HABIT_RE.test(line) && !PERSONA_RE.test(line)) out.push(line);
    }
  }
  return out;
}

/** 子工作区和它下面的 git 仓库，按名字长度降序，长名优先匹配 */
function knownDirs(root: string) {
  const out: { name: string; dir: string }[] = [];
  const isDir = (path: string) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  let top: string[] = [];
  try {
    top = readdirSync(root).filter((name) => !name.startsWith(".") && name !== "node_modules" && isDir(resolve(root, name)));
  } catch {
    return out;
  }
  for (const name of top) {
    out.push({ name, dir: name });
    try {
      for (const child of readdirSync(resolve(root, name))) {
        if (child.startsWith(".") || child === "node_modules") continue;
        if (isDir(resolve(root, name, child)) && existsSync(resolve(root, name, child, ".git"))) {
          out.push({ name: child, dir: `${name}/${child}` });
        }
      }
    } catch {
      // unreadable workspace
    }
  }
  return out.filter((row) => row.name.length >= 4).sort((a, b) => b.name.length - a.name.length);
}

function matchDir(text: string, dirs: { name: string; dir: string }[]) {
  const hay = text.toLowerCase();
  return dirs.find((row) => {
    const at = hay.indexOf(row.name.toLowerCase());
    if (at < 0) return false;
    const before = hay[at - 1] ?? " ";
    const after = hay[at + row.name.length] ?? " ";
    return !/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after);
  });
}

function sectionOf(entry: MemoryEntry): Section {
  if (/(流程|步骤|命令|怎么推送|如何部署)/.test(entry.text)) return "命令";
  if (/(踩过|坑|别再|小心)/.test(entry.text)) return "坑";
  if (entry.kind === "决定" || entry.kind === "事件") return "决定";
  return "约定";
}

function backup(ref: TenantRef) {
  const dir = assistantPath(ref, "memory", "backup-v1");
  const files = memoryFiles(ref);
  const done: string[] = [];
  mkdirSync(dir, { recursive: true });
  for (const [name, path] of [["entries.json", files.entries], ["core.json", files.core]] as const) {
    const target = resolve(dir, name);
    if (!existsSync(path) || existsSync(target)) continue;
    copyFileSync(path, target);
    done.push(`memory/backup-v1/${name}`);
  }
  return done;
}

export function migrateMemory(tenant: WorkspaceRoot): MigrationReport | null {
  const ref = { id: tenant.id, stateDir: tenant.stateDir };
  if (!existsSync(assistantDir(ref))) return null;
  if (memorySchemaVersion(ref) >= MEMORY_SCHEMA_VERSION) return null;

  const backedUp = backup(ref);
  const shape = migrateMemoryShapeV2(ref);
  const assistantChat = `assistant-${tenant.id}`;
  const now = Date.now();

  const have = new Set(workPreferenceLines(ref));
  const prefs: Proposal[] = [];
  const addPref = (text: string, memoryId?: string) => {
    const line = clip(text.replace(/^用户(希望|要求|习惯)?/, "").trim(), 120);
    if (!line || have.has(line) || prefs.some((item) => item.text === line)) return;
    if (detectSensitive(ref, line) || LIFE_RE.test(line)) return;
    prefs.push({ id: newId("wm"), kind: "work_pref", chatId: assistantChat, dir: "", section: "工作偏好", text: line, refs: [], createdAt: now, memoryId });
  };
  for (const line of rootHabits(tenant.workspaceRoot)) addPref(line);
  const core = readCore(ref);
  for (const line of sentences(core.fields["偏好"] || "")) {
    if (WORK_HABIT_RE.test(line) && !PERSONA_RE.test(line)) addPref(line);
  }

  const dirs = knownDirs(tenant.workspaceRoot);
  const byDir = new Map<string, Proposal[]>();
  for (const entry of listMemory(ref).entries) {
    if (!isValid(entry)) continue;
    const hit = matchDir(`${entry.text} ${(entry.supplements ?? []).join(" ")}`, dirs);
    if (hit) {
      const text = [entry.text, ...(entry.supplements ?? [])].join("；");
      // 同一条里混着生活信息的整条留在个人记忆，不往工作区搬
      if (detectSensitive(ref, text) || LIFE_RE.test(text)) continue;
      const rows = byDir.get(hit.dir) ?? [];
      rows.push({
        id: newId("wm"),
        kind: "workspace",
        chatId: assistantChat,
        dir: hit.dir,
        section: sectionOf(entry),
        text: clip(text, 300),
        refs: [],
        createdAt: now,
        memoryId: entry.id,
      });
      byDir.set(hit.dir, rows);
      continue;
    }
    if (entry.basis === "user_said" && WORK_HABIT_RE.test(entry.text) && !PERSONA_RE.test(entry.text)) addPref(entry.text, entry.id);
  }
  // 上次迁移中途退出时已经出过的卡不再重复出
  const pending = listProposals(ref).proposals;
  const fresh = (item: Proposal) => !pending.some((row) => row.kind === item.kind && row.dir === item.dir && row.text === item.text);
  prefs.splice(0, prefs.length, ...prefs.filter(fresh));
  for (const [dir, rows] of byDir) {
    const kept = rows.filter(fresh);
    if (kept.length) byDir.set(dir, kept);
    else byDir.delete(dir);
  }

  if (prefs.length) {
    openCard(ref, {
      chatId: assistantChat,
      tool: WORK_PREF_TOOL,
      items: prefs,
      ttlMs: MIGRATION_CARD_TTL_MS,
      origin: "migration",
      title: `记忆升级：整理出 ${prefs.length} 条工作偏好，等你确认`,
      note: "「工作偏好」会带进所有工作区的会话（含委派），其余个人记忆仍只在助理这里。批准后写进记忆页的「工作偏好」一栏；来自个人记忆条目的那条会标失效（可在记忆页恢复）。根目录 AGENTS.md 不会被改。",
    });
  }
  for (const [dir, rows] of byDir) {
    openCard(ref, {
      chatId: assistantChat,
      tool: WORKSPACE_MEMORY_TOOL,
      items: rows,
      ttlMs: MIGRATION_CARD_TTL_MS,
      origin: "migration",
      title: `记忆升级：${rows.length} 条记忆更像 ${dir} 的项目知识，等你确认`,
      note: `批准后写进 ${dir}/.jiebo/memory.md（之后在这个目录里的会话和委派都看得到），原个人记忆标失效（可在记忆页恢复）。拒绝就原样留在个人记忆里。`,
    });
  }

  const report: MigrationReport = {
    backedUp,
    inferredDemoted: shape.inferred,
    coreChanged: shape.coreChanged,
    workPrefCandidates: prefs.length,
    workspaceCandidates: Object.fromEntries([...byDir].map(([dir, rows]) => [dir, rows.length])),
  };
  if (shape.inferred || prefs.length || byDir.size) {
    postInbox(ref, {
      kind: "memory",
      title: "记忆升级到分层版",
      body: [
        "个人记忆（关于你）和工作区记忆（关于项目）分开了：",
        "- 新增「工作偏好」一栏：只放你亲口说的跨项目习惯，会带进所有工作区的会话。",
        "- 子工作区的会话会按目录一层层读规则和 .jiebo/memory.md；根目录 AGENTS.md 仍只给助理。",
        shape.inferred ? `- ${shape.inferred} 条推断出来的记忆不再每轮自动带上，需要时照样能搜到；你确认过或再次出现就会恢复常驻。` : "",
        prefs.length || byDir.size ? "- 有几项建议搬家的内容在待批里，批不批都不会丢数据。" : "",
        backedUp.length ? `- 升级前的数据备份在网关的 ${backedUp.join("、")}。` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      key: "memory-migrate:v2",
      read: false,
    });
  }
  writeJson(schemaFile(ref), { version: MEMORY_SCHEMA_VERSION, migratedAt: new Date().toISOString(), report } satisfies SchemaFile);
  audit(ref, { id: "*", op: "migrate_v2", actor: "maintenance", text: JSON.stringify(report) });
  return report;
}
