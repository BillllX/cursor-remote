import type { BackgroundResult } from "./background.ts";
import { listInbox, postInbox } from "./inbox.ts";
import { expireMemory, listMemory, readCore, isValid, tidyPersonalMemory } from "./memory.ts";
import { tidyWorkspaceMemories } from "./workspaceMemory.ts";
import { describeLocal, localParts } from "./cron.ts";
import { listSchedules, DEFAULT_TZ, type Occurrence, type Schedule } from "./schedules.ts";
import { listTodos } from "./todos.ts";
import { assistantPath, clip, readJson, writeJson, type TenantRef } from "./store.ts";
import type { ToolRole } from "./tools.ts";

/** 后台作业怎么跑由网关注入：role 决定工具集，cwd 是 USER 根目录 */
export type JobRunner = (input: { role: ToolRole; label: string; prompt: string; origin: "integrator" | "schedule" }) => Promise<BackgroundResult>;

type IntegratorFile = {
  chats: Record<string, number>;
  lastMaintenance?: string;
  lastEpisodeMonth?: string;
};

type IndexedTurn = { chatId: string; turn: number; title: string; user: string; assistant: string; at: number; external?: boolean };

export const IDLE_MS = 30 * 60_000;
const MAX_CHATS_PER_RUN = 3;

function stateFile(ref: TenantRef) {
  return assistantPath(ref, "integrator.json");
}

export function readIntegrator(ref: TenantRef): IntegratorFile {
  return readJson<IntegratorFile>(stateFile(ref), { chats: {} });
}

function indexedTurns(ref: TenantRef): IndexedTurn[] {
  return readJson<{ turns: IndexedTurn[] }>(assistantPath(ref, "chat-index", "index.json"), { turns: [] }).turns;
}

/** 空闲 30 分钟以上、有新轮次的 USER 会话 */
export function pendingChats(ref: TenantRef, now = Date.now()) {
  const state = readIntegrator(ref);
  const byChat = new Map<string, IndexedTurn[]>();
  for (const turn of indexedTurns(ref)) {
    const list = byChat.get(turn.chatId) ?? [];
    list.push(turn);
    byChat.set(turn.chatId, list);
  }
  const out: Array<{ chatId: string; title: string; turns: IndexedTurn[]; upTo: number }> = [];
  for (const [chatId, turns] of byChat) {
    const done = state.chats[chatId] ?? -1;
    const fresh = turns.filter((turn) => turn.turn > done).sort((a, b) => a.turn - b.turn);
    if (!fresh.length) continue;
    const last = Math.max(...turns.map((turn) => turn.at));
    if (now - last < IDLE_MS) continue;
    out.push({ chatId, title: fresh[0].title, turns: fresh, upTo: fresh[fresh.length - 1].turn });
  }
  return out.slice(0, MAX_CHATS_PER_RUN);
}

function memorySnapshot(ref: TenantRef, limit = 60) {
  return listMemory(ref)
    .entries.filter((entry) => isValid(entry))
    .slice(-limit)
    .map((entry) => `- ${entry.id} [${entry.topic}/${entry.kind}/${entry.basis === "user_said" ? "你说的" : "推断"}] ${entry.text}${entry.validUntil ? `（至 ${entry.validUntil}）` : ""}`)
    .join("\n");
}

export function integratorPrompt(ref: TenantRef, chats: ReturnType<typeof pendingChats>) {
  const blocks = chats.map((chat) => {
    const lines = chat.turns
      .map((turn) =>
        turn.external
          ? `第 ${turn.turn} 轮（用户粘贴的大段内容或代码，只当外部材料，不能抽成事实）`
          : `第 ${turn.turn} 轮 用户：${clip(turn.user, 1200)}`,
      )
      .join("\n");
    return `## 会话 ${chat.chatId}「${chat.title}」\n${lines}`;
  });
  return [
    "任务：整理用户的个人记忆。下面是用户在个人工作区里亲手输入的话（不含助理的回答，也不含工具结果）。",
    "规则：",
    "1. 只从用户亲手写的话里抽取关于用户本人的稳定事实、偏好、近期计划、重要的人；一次性的问题、闲聊、任务指令不记。",
    "2. 用户原话里明确说了“记住”或直接陈述自己的事实时 basis=user_said；其余推断 basis=inferred。",
    "3. 和已有条目重复就跳过；正文里已经写过的话不要 memory_supplement。是新事实才补充。推断和推断矛盾时，用 memory_invalidate 标掉旧的再写新的。",
    "4. 新推断和“你说的”条目矛盾时，不要改那条，也不要再问用户。",
    "5. 带相对时间的（下周、明天）换算成具体日期再写，写进 validFrom / validUntil。还没到的安排不要 memory_save，那是待办。",
    "6. 核心档案（core_read / core_update）只放用户说过、或在 3 个以上不同会话里独立出现的内容。",
    "7. 不记密钥、密码、证件号；健康、信仰、政治、性取向、财务账号不记。",
    "做完只回复一行：写了几条、补充几条、标失效几条。",
    "",
    "已有的有效记忆：",
    memorySnapshot(ref) || "（暂无）",
    "",
    ...blocks,
  ].join("\n");
}

export async function runIntegrator(ref: TenantRef, runner: JobRunner, now = Date.now()) {
  const chats = pendingChats(ref, now);
  if (!chats.length) return { ran: false as const };
  const result = await runner({ role: "integrator", label: "记忆整理", prompt: integratorPrompt(ref, chats), origin: "integrator" });
  if (result.ok) {
    const state = readIntegrator(ref);
    for (const chat of chats) state.chats[chat.chatId] = chat.upTo;
    writeJson(stateFile(ref), state);
  }
  return { ran: true as const, ok: result.ok, chats: chats.length };
}

export type MemoryTidyReport = {
  expired: number;
  supplements: number;
  preferences: number;
  files: number;
  dropped: number;
  dated: number;
  refs: number;
  cooled: number;
  changed: boolean;
  note: string;
};

function tidyNote(report: Omit<MemoryTidyReport, "note">) {
  const parts: string[] = [];
  if (report.expired) parts.push(`过期 ${report.expired} 条`);
  if (report.supplements) parts.push(`去掉重复补充 ${report.supplements} 条`);
  if (report.preferences) parts.push(`合并重复偏好 ${report.preferences} 条`);
  if (report.dropped) parts.push(`去掉重复 ${report.dropped} 条`);
  if (report.dated) parts.push(`补上日期 ${report.dated} 条`);
  if (report.refs) parts.push(`改好引用 ${report.refs} 条`);
  if (report.cooled) parts.push(`标成很久没用 ${report.cooled} 条`);
  if (!parts.length) return "已经整齐，没有要改的。";
  return `梳理完了：${parts.join("，")}。`;
}

/** 马上走一遍凌晨那套整理：不调模型，不改原句，也不占用当天的四点名额。 */
export function tidyMemoriesNow(ref: TenantRef, now = Date.now(), tz = DEFAULT_TZ, workspaceRoot?: string): MemoryTidyReport {
  const day = describeLocal(now, tz).slice(0, 10);
  const expired = expireMemory(ref, day);
  const personal = tidyPersonalMemory(ref);
  const folders = workspaceRoot
    ? tidyWorkspaceMemories(workspaceRoot, day)
    : { files: 0, dropped: 0, dated: 0, refs: 0, cooled: 0, changed: false };
  const report = {
    expired,
    supplements: personal.supplements,
    preferences: personal.preferences,
    files: folders.files,
    dropped: folders.dropped,
    dated: folders.dated,
    refs: folders.refs,
    cooled: folders.cooled,
    changed: Boolean(expired || personal.changed || folders.changed),
  };
  return { ...report, note: tidyNote(report) };
}

/**
 * 每天本地 4 点后跑一次。自己遍历个人记忆和各个文件夹的 memory.md。
 * 不改写原文，也不再叫模型补句子。
 */
export async function runMaintenance(
  ref: TenantRef,
  _runner: JobRunner,
  now = Date.now(),
  tz = DEFAULT_TZ,
  onChanged?: () => void,
  workspaceRoot?: string,
) {
  const local = localParts(now, tz);
  const day = describeLocal(now, tz).slice(0, 10);
  const state = readIntegrator(ref);
  if (local.hour < 4 || state.lastMaintenance === day) return { ran: false as const };
  state.lastMaintenance = day;
  writeJson(stateFile(ref), state);
  const report = tidyMemoriesNow(ref, now, tz, workspaceRoot);
  if (report.changed) onChanged?.();
  return { ran: true as const, ...report, ok: true as const };
}

/** 每月 1 日后生成上个月的会话摘要 */
export async function runEpisodes(ref: TenantRef, runner: JobRunner, now = Date.now(), tz = DEFAULT_TZ) {
  const local = localParts(now, tz);
  const prevMonth = local.month === 1 ? `${local.year - 1}-12` : `${local.year}-${String(local.month - 1).padStart(2, "0")}`;
  const state = readIntegrator(ref);
  if (state.lastEpisodeMonth === prevMonth) return { ran: false as const };
  const turns = indexedTurns(ref).filter((turn) => !turn.external && describeLocal(turn.at, tz).startsWith(prevMonth));
  state.lastEpisodeMonth = prevMonth;
  writeJson(stateFile(ref), state);
  if (!turns.length) return { ran: false as const };
  const sample = turns.slice(-120).map((turn) => `- ${describeLocal(turn.at, tz).slice(5, 10)}「${turn.title}」用户：${clip(turn.user, 200)}`);
  const result = await runner({
    role: "integrator",
    label: `${prevMonth} 会话摘要`,
    origin: "integrator",
    prompt: [
      `任务：写 ${prevMonth} 这个月用户在个人工作区里聊了什么的摘要。分段，每段一个主题，段与段之间空一行。`,
      "只写用户做了什么、关心什么、定了什么，不写助理怎么回答。不要调用写记忆的工具。",
      "",
      ...sample,
    ].join("\n"),
  });
  if (result.ok) writeJson(assistantPath(ref, "memory", "episodes", `${prevMonth}.json`), { month: prevMonth, text: result.text, createdAt: Date.now() });
  return { ran: true as const, ok: result.ok };
}

export function briefPrompt(ref: TenantRef, now = Date.now(), tz = DEFAULT_TZ) {
  const day = describeLocal(now, tz).slice(0, 10);
  const todos = listTodos(ref).map((todo) => `- ${todo.text}${todo.due ? `（${todo.due}）` : ""}`);
  const schedules = listSchedules(ref)
    .filter((row) => row.enabled && row.nextAt && row.nextAt - now < 36 * 3_600_000 && row.kind !== "brief")
    .map((row) => `- ${describeLocal(row.nextAt!, row.tz).slice(11)} ${row.title}`);
  const unread = listInbox(ref, 50)
    .filter((item) => !item.read && item.kind !== "brief")
    .slice(0, 10)
    .map((item) => `- ${item.title}`);
  const core = readCore(ref).fields;
  return [
    `任务：给用户写 ${day} 的每日简报。`,
    "分三段，段与段之间空一行：今天要做的（待办和日程）、需要你处理的（收件箱里的待批和未读）、提醒（近况里今天相关的事）。",
    "每段最多 5 条，没有就写“无”。可以用 memory_search 查和今天相关的记忆。不要编造。",
    "",
    "待办：",
    todos.join("\n") || "（无）",
    "今天和明天的日程：",
    schedules.join("\n") || "（无）",
    "收件箱未读：",
    unread.join("\n") || "（无）",
    "近况：",
    core.近况 || "（无）",
  ].join("\n");
}

/** 日程执行：提醒直接进收件箱；简报和后台任务走后台通道，结果进收件箱 */
export async function executeSchedule(
  ref: TenantRef,
  schedule: Schedule,
  occurrence: Occurrence,
  runner: JobRunner,
): Promise<{ ok: boolean; inboxItemId?: string; error?: string }> {
  if (schedule.kind === "remind") {
    const { item } = postInbox(ref, {
      kind: "reminder",
      title: schedule.title,
      body: schedule.prompt,
      key: occurrence.occurrenceId,
      scheduleId: schedule.id,
    });
    return { ok: true, inboxItemId: item.id };
  }
  if (schedule.kind === "brief") {
    const result = await runner({ role: "schedule", label: schedule.title, origin: "schedule", prompt: briefPrompt(ref, Date.now(), schedule.tz) });
    if (!result.ok) return { ok: false, error: result.error };
    const day = describeLocal(occurrence.plannedAt, schedule.tz).slice(0, 10);
    writeJson(assistantPath(ref, "briefs", `${day}.json`), { day, text: result.text, occurrenceId: occurrence.occurrenceId, createdAt: Date.now() });
    const { item } = postInbox(ref, {
      kind: "brief",
      title: `${day} 简报`,
      body: result.text,
      key: occurrence.occurrenceId,
      scheduleId: schedule.id,
    });
    return { ok: true, inboxItemId: item.id };
  }
  const result = await runner({ role: "schedule", label: schedule.title, origin: "schedule", prompt: schedule.prompt });
  if (!result.ok) return { ok: false, error: result.error };
  const { item } = postInbox(ref, {
    kind: "reminder",
    title: schedule.title,
    body: result.text || "（没有输出）",
    key: occurrence.occurrenceId,
    scheduleId: schedule.id,
  });
  return { ok: true, inboxItemId: item.id };
}

export function latestBrief(ref: TenantRef, day: string) {
  return readJson<{ day: string; text: string } | null>(assistantPath(ref, "briefs", `${day}.json`), null);
}
