import type { BackgroundResult } from "./background.ts";
import { listInbox, postInbox } from "./inbox.ts";
import { expireMemory, listMemory, readCore, isValid } from "./memory.ts";
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
    "3. 和已有条目重复就跳过；是补充就用 memory_supplement；推断和推断矛盾时，用 memory_invalidate 标掉旧的再写新的。",
    "4. 新推断和“你说的”条目矛盾时，不要改那条，用 inbox_post 提一句“可能变了”。",
    "5. 带相对时间的（下周、明天）换算成具体日期再写，写进 validFrom / validUntil。",
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

/** 每天本地 4 点后跑一次：过期标失效，再让助理把相对时间和过去的行程改写成具体日期或过去式，重写“近况” */
export async function runMaintenance(ref: TenantRef, runner: JobRunner, now = Date.now(), tz = DEFAULT_TZ) {
  const local = localParts(now, tz);
  const day = describeLocal(now, tz).slice(0, 10);
  const state = readIntegrator(ref);
  if (local.hour < 4 || state.lastMaintenance === day) return { ran: false as const };
  state.lastMaintenance = day;
  writeJson(stateFile(ref), state);
  const expired = expireMemory(ref);
  const entries = listMemory(ref).entries.filter((entry) => !entry.invalidAt);
  const timed = entries.filter((entry) => entry.kind === "事件" || /(明天|后天|下周|下个月|今天|这周|本周|昨天|上周)/.test(entry.text));
  let llm: BackgroundResult | null = null;
  if (timed.length || readCore(ref).fields.近况) {
    llm = await runner({
      role: "integrator",
      label: "时间维护",
      origin: "integrator",
      prompt: [
        `今天是 ${day}（${tz}）。任务：维护记忆里的时间。`,
        "1. 下面条目里的相对时间（明天、下周…）按条目写入日期换算成具体日期；已经过去的行程改写成过去式。做法：memory_invalidate 旧条目（原因“时间改写”），再 memory_save 新条目，basis 保持不变。用户亲口说的条目不能标失效，只能用 memory_supplement 补一句当前状态。",
        "2. 用 core_read 看核心档案，把“近况”里已经过去的事改成过去式或删掉，用 core_update 写回。",
        "做完只回复一行。",
        "",
        timed.map((entry) => `- ${entry.id} [${entry.basis}] 写入于 ${entry.createdAt.slice(0, 10)}：${entry.text}`).join("\n") || "（没有带时间的条目）",
      ].join("\n"),
    });
  }
  return { ran: true as const, expired, ok: llm ? llm.ok : true };
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
