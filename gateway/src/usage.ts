import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stateDir } from "./tenants.js";

/**
 * P9：每租户使用计量。官方账单按当前 API Key 走 cursorBill.ts（CLI /usage 的同一接口）。
 * 这里仍是网关自计量的相对消耗，用来比较各租户：
 * turns/runs/toolCalls/runMs 是硬指标；inChars/outChars 按字符累计，
 * estTokens = chars/4 是粗估（UI 必须标注「估算」）。
 *
 * 口径说明（评审共识，均为可接受的近似）：
 * - turns：prompt 分发即计，含排队/无 key 被拒/纯图（纯图 inChars 计 0）；
 * - runs：按 finishRun 完成次数计，含 cancelled/error；confirm-writes 被拦截的
 *   首次运行手动收尾不经 finishRun，「拦截+重放」计 1 次；titleChat 起标题计 1 次；
 * - toolCalls：只计已完成的工具调用（run 中断时未完成的 openTools 不计）；
 * - inChars：仅用户原文，不含 system prompt/工作区规则/工具结果回灌；
 * - outChars：text + thinking + 标题，不含工具调用参数（写文件参数是输出大头，未计）。
 *
 * 持久化：stateDir/usage.json，2s 节流写盘（密集事件不推迟落盘）+ SIGTERM/SIGINT/exit 兜底 flush。
 * 文件损坏/缺字段时容错为零值——统计丢了不影响主流程。
 */

export type UsageRec = {
  turns: number;
  runs: number;
  toolCalls: number;
  runMs: number;
  inChars: number;
  outChars: number;
  /** 第三方模型（自研 Agent）接口返回的真实 token，与上面的字符估算分开记 */
  modelInTokens: number;
  modelOutTokens: number;
  modelCacheTokens: number;
  firstSeenAt: number;
  lastActiveAt: number;
};

type UsageFile = {
  version: number;
  tenants: Record<string, Partial<UsageRec>>;
};

const recs = new Map<string, UsageRec>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hooksArmed = false;

function usageFile(): string {
  return resolve(stateDir(), "usage.json");
}

function blankRec(now: number): UsageRec {
  return {
    turns: 0,
    runs: 0,
    toolCalls: 0,
    runMs: 0,
    inChars: 0,
    outChars: 0,
    modelInTokens: 0,
    modelOutTokens: 0,
    modelCacheTokens: 0,
    firstSeenAt: now,
    lastActiveAt: now,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const file = usageFile();
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, "utf8")) as UsageFile;
    const rows = raw && typeof raw === "object" ? raw.tenants : null;
    if (!rows || typeof rows !== "object") return;
    for (const [id, row] of Object.entries(rows)) {
      if (!row || typeof row !== "object") continue;
      const now = Date.now();
      recs.set(id, {
        turns: num(row.turns),
        runs: num(row.runs),
        toolCalls: num(row.toolCalls),
        runMs: num(row.runMs),
        inChars: num(row.inChars),
        outChars: num(row.outChars),
        modelInTokens: num(row.modelInTokens),
        modelOutTokens: num(row.modelOutTokens),
        modelCacheTokens: num(row.modelCacheTokens),
        firstSeenAt: num(row.firstSeenAt) || now,
        lastActiveAt: num(row.lastActiveAt) || now,
      });
    }
  } catch {
    // 损坏的统计文件不值得 crash——从零开始
  }
}

function armHooks(): void {
  if (hooksArmed) return;
  hooksArmed = true;
  // systemctl restart 走 SIGTERM：flush 后再退，别丢最后 2s 的计量
  // 和 tenants.ts 的落盘监听共用信号：最后一个跑的监听者负责 exit
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      flushUsage();
      if (process.listenerCount(signal) === 0) process.exit(0);
    });
  }
  process.on("exit", () => flushUsage());
}

/** 取（或建）租户计量行；每次调用顺手 touch lastActiveAt */
export function usageRec(tenantId: string): UsageRec {
  load();
  armHooks();
  let rec = recs.get(tenantId);
  if (!rec) {
    rec = blankRec(Date.now());
    recs.set(tenantId, rec);
    scheduleSave(); // 新租户首行值得尽快落盘（否则纯浏览的租户重启后无痕迹）
  }
  rec.lastActiveAt = Date.now();
  return rec;
}

export function noteTurn(tenantId: string, chars: number): void {
  const rec = usageRec(tenantId);
  rec.turns += 1;
  rec.inChars += Math.max(0, chars);
  scheduleSave();
}

export function noteOutput(tenantId: string, chars: number): void {
  const rec = usageRec(tenantId);
  rec.outChars += Math.max(0, chars);
  scheduleSave();
}

export function noteRun(tenantId: string, durationMs?: number): void {
  const rec = usageRec(tenantId);
  rec.runs += 1;
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
    rec.runMs += durationMs;
  }
  scheduleSave();
}

export function noteModelTokens(tenantId: string, input: number, output: number, cacheRead: number): void {
  const rec = usageRec(tenantId);
  rec.modelInTokens += num(input);
  rec.modelOutTokens += num(output);
  rec.modelCacheTokens += num(cacheRead);
  scheduleSave();
}

export function noteToolCall(tenantId: string): void {
  const rec = usageRec(tenantId);
  rec.toolCalls += 1;
  scheduleSave();
}

/** 只读快照（admin_stats 用）：不 touch lastActiveAt——查询本身不算租户活动 */
export function usageSnapshot(tenantId: string): UsageRec {
  load();
  return recs.get(tenantId) ?? blankRec(0);
}

export function flushUsage(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!loaded) return;
  try {
    const file = usageFile();
    mkdirSync(stateDir(), { recursive: true });
    const payload: UsageFile = {
      version: 1,
      tenants: Object.fromEntries(recs.entries()),
    };
    // tmp + rename 原子替换：避免 SIGKILL/断电写一半损坏整份计量（load 虽容错但会丢全部历史）
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(payload)); // 某些挂载盘 rename 不可靠：回退直写，别让计量永久停更
    }
  } catch {
    // 磁盘满/权限——统计丢了不影响主流程
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushUsage();
  }, 2_000);
  saveTimer.unref?.();
}
