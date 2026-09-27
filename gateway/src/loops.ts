import { mkdirSync, renameSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentMode, LoopState, LoopTick, LoopTickStatus } from "../../shared/protocol.ts";
import { stateDir } from "./tenants.ts";

/**
 * 产品 Loop 调度（docs/IDE.md L2）。
 * 内存 + stateDir/loops.json。到点调用 dispatch；会话在跑或没人在线则顺延，不占拍数。
 * 回复最后一行是 LOOP_DONE，或达到 maxTicks，就停止。
 */

type StoredLoop = LoopState & {
  tenantId: string;
  model?: string;
  mode?: AgentMode;
  gen: number;
};

export type LoopJob = {
  tenantId: string;
  chatId: string;
  text: string;
  model?: string;
  mode?: AgentMode;
};

export type LoopHooks = {
  /** 返回顺延原因；false 表示现在可以发 */
  busy: (tenantId: string, chatId: string) => false | string;
  /** error === "offline" 表示没有在线连接，本拍顺延且不占拍数 */
  dispatch: (job: LoopJob) => Promise<{ text: string; error?: string }>;
  publish: (tenantId: string, message: ({ type: "loop_state" } & LoopState) | ({ type: "loop_tick" } & LoopTick)) => void;
};

const loops = new Map<string, StoredLoop>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let hooks: LoopHooks | null = null;

function key(tenantId: string, chatId: string) {
  return `${tenantId}\0${chatId}`;
}

function wire(row: StoredLoop): LoopState {
  return {
    chatId: row.chatId,
    status: row.status,
    goal: row.goal,
    intervalSec: row.intervalSec,
    tick: row.tick,
    maxTicks: row.maxTicks,
    lastSummary: row.lastSummary,
    nextAt: row.nextAt,
  };
}

function file() {
  return resolve(stateDir(), "loops.json");
}

function persist() {
  const path = file();
  const tmp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify({
    loops: [...loops.values()].map((row) => ({
      tenantId: row.tenantId,
      chatId: row.chatId,
      status: row.status === "running" ? "armed" : row.status,
      goal: row.goal,
      intervalSec: row.intervalSec,
      tick: row.tick,
      maxTicks: row.maxTicks,
      lastSummary: row.lastSummary,
      nextAt: row.nextAt,
      model: row.model,
      mode: row.mode,
    })),
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch (err) {
    console.error("loops.json 写入失败：", err instanceof Error ? err.message : err);
  }
}

function load() {
  const path = file();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { loops?: unknown };
    const rows = Array.isArray(raw.loops) ? raw.loops : [];
    for (const item of rows) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const tenantId = typeof rec.tenantId === "string" ? rec.tenantId : "";
      const chatId = typeof rec.chatId === "string" ? rec.chatId.trim() : "";
      const goal = typeof rec.goal === "string" ? rec.goal : "";
      const intervalSec = typeof rec.intervalSec === "number" ? rec.intervalSec : 0;
      if (!tenantId || !chatId || !goal || intervalSec < 30) continue;
      if (rec.status === "stopped") continue;
      const row: StoredLoop = {
        tenantId,
        chatId,
        status: "armed",
        goal,
        intervalSec,
        tick: typeof rec.tick === "number" ? rec.tick : 0,
        maxTicks: typeof rec.maxTicks === "number" ? rec.maxTicks : undefined,
        lastSummary: typeof rec.lastSummary === "string" ? rec.lastSummary : undefined,
        nextAt: typeof rec.nextAt === "number" ? rec.nextAt : Date.now() + intervalSec * 1000,
        model: typeof rec.model === "string" ? rec.model : undefined,
        mode: rec.mode === "agent" || rec.mode === "plan" || rec.mode === "ask" ? rec.mode : undefined,
        gen: 1,
      };
      loops.set(key(tenantId, chatId), row);
    }
  } catch (err) {
    console.error("loops.json 读取失败：", err instanceof Error ? err.message : err);
  }
}

function clearTimer(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function schedule(row: StoredLoop) {
  const id = key(row.tenantId, row.chatId);
  clearTimer(id);
  const delay = Math.max(0, (row.nextAt ?? Date.now()) - Date.now());
  const gen = row.gen;
  const timer = setTimeout(() => {
    timers.delete(id);
    void fire(id, gen);
  }, delay);
  timer.unref?.();
  timers.set(id, timer);
}

function publishTick(row: StoredLoop, status: LoopTickStatus, summary: string) {
  hooks?.publish(row.tenantId, { type: "loop_tick", chatId: row.chatId, tick: row.tick, status, summary });
}

function publishState(row: StoredLoop) {
  hooks?.publish(row.tenantId, { type: "loop_state", ...wire(row) });
}

function promptFor(row: StoredLoop) {
  return [
    row.goal,
    "",
    `上一拍摘要：${row.lastSummary || "（还没有）"}`,
    `这是第 ${row.tick + 1} 拍。若目标已经完成，回复最后一行只写 LOOP_DONE。`,
  ].join("\n");
}

function summaryOf(text: string) {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.slice(0, 80) || "本拍没有文本";
}

function endsDone(text: string) {
  const last = text.trim().split(/\r?\n/).filter((line) => line.trim()).pop()?.trim();
  return last === "LOOP_DONE";
}

async function fire(id: string, gen: number) {
  const row = loops.get(id);
  if (!row || row.gen !== gen || !hooks) return;
  const defer = hooks.busy(row.tenantId, row.chatId);
  if (defer) {
    row.lastSummary = defer;
    row.nextAt = Date.now() + 5000;
    row.status = "armed";
    persist();
    publishTick(row, "skipped", row.lastSummary);
    publishState(row);
    schedule(row);
    return;
  }
  row.status = "running";
  const tick = row.tick + 1;
  persist();
  publishState(row);
  let result: { text: string; error?: string };
  try {
    result = await hooks.dispatch({
      tenantId: row.tenantId,
      chatId: row.chatId,
      text: promptFor({ ...row, tick: row.tick }),
      model: row.model,
      mode: row.mode,
    });
  } catch (err) {
    result = { text: "", error: err instanceof Error ? err.message : "Loop 本拍失败" };
  }
  const current = loops.get(id);
  if (!current || current.gen !== gen) return;
  if (result.error === "offline" || result.error === "deferred") {
    current.status = "armed";
    current.lastSummary = result.error === "offline" ? "没有在线连接，本拍顺延。" : "没能马上开跑，本拍顺延。";
    current.nextAt = Date.now() + (result.error === "offline" ? 15_000 : 5_000);
    persist();
    publishTick(current, "skipped", current.lastSummary);
    publishState(current);
    schedule(current);
    return;
  }
  current.tick = tick;
  const failed = Boolean(result.error);
  current.lastSummary = failed ? result.error!.slice(0, 200) : summaryOf(result.text);
  const done = !failed && endsDone(result.text);
  const hitMax = current.maxTicks != null && current.tick >= current.maxTicks;
  if (done || hitMax) {
    current.status = "stopped";
    current.lastSummary = done ? "模型标记 LOOP_DONE。" : `已到 ${current.maxTicks} 拍，停止。`;
    current.nextAt = undefined;
    clearTimer(id);
    loops.delete(id);
    persist();
    publishTick(current, "stopped", current.lastSummary);
    publishState(current);
    return;
  }
  current.status = "armed";
  current.nextAt = Date.now() + current.intervalSec * 1000;
  persist();
  publishTick(current, failed ? "error" : "ran", current.lastSummary);
  publishState(current);
  schedule(current);
}

export function bindLoops(next: LoopHooks) {
  hooks = next;
  if (loops.size === 0) load();
  for (const row of loops.values()) schedule(row);
}

export function startLoop(input: {
  tenantId: string;
  chatId: string;
  goal: string;
  intervalSec: number;
  maxTicks?: number;
  model?: string;
  mode?: AgentMode;
}): { state: LoopState } | { error: string } {
  const chatId = input.chatId.trim();
  const goal = input.goal.trim();
  if (!chatId) return { error: "Loop 需要 chatId。" };
  if (!goal) return { error: "Loop 需要一段目标。" };
  if (goal.length > 4000) return { error: "Loop 目标超过 4000 字。" };
  if (!Number.isInteger(input.intervalSec) || input.intervalSec < 30 || input.intervalSec > 86_400) {
    return { error: "Loop 间隔要在 30 秒到 24 小时之间。" };
  }
  if (
    input.maxTicks != null &&
    (!Number.isInteger(input.maxTicks) || input.maxTicks < 1 || input.maxTicks > 100)
  ) {
    return { error: "Loop 最多 1 到 100 拍。" };
  }
  const id = key(input.tenantId, chatId);
  const prev = loops.get(id);
  const row: StoredLoop = {
    tenantId: input.tenantId,
    chatId,
    status: "armed",
    goal,
    intervalSec: input.intervalSec,
    tick: 0,
    maxTicks: input.maxTicks,
    model: input.model?.trim() || undefined,
    mode: input.mode,
    lastSummary: "已开始，等待下一拍。",
    nextAt: Date.now() + input.intervalSec * 1000,
    gen: (prev?.gen ?? 0) + 1,
  };
  loops.set(id, row);
  persist();
  if (hooks) schedule(row);
  return { state: wire(row) };
}

export function stopLoop(tenantId: string, chatId: string): LoopState | null {
  const id = key(tenantId, chatId.trim());
  const row = loops.get(id);
  if (!row) return null;
  row.gen += 1;
  row.status = "stopped";
  row.lastSummary = "已停止。";
  row.nextAt = undefined;
  clearTimer(id);
  loops.delete(id);
  persist();
  return wire(row);
}

export function loopsForTenant(tenantId: string): LoopState[] {
  return [...loops.values()].filter((row) => row.tenantId === tenantId && row.status !== "stopped").map(wire);
}
