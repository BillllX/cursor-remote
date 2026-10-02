import { createHash } from "node:crypto";
import type { CursorBill, CursorOnDemand } from "../../shared/protocol.ts";

/**
 * 当前 CURSOR_API_KEY 的官方用量和计费。
 *
 * Cursor CLI 的 `/usage` 没有可脚本化的子命令，但它自己就是这么查的：
 * 用 API Key 换 access token（POST /auth/exchange_user_api_key），
 * 再调 DashboardService 的 GetCurrentPeriodUsage / GetPlanInfo / GetHardLimit。
 * Enterprise 没有 planUsage 时，CLI 改走 GetMonthlyBillingCycle +
 * GetAggregatedUsageEvents，按这把 Key 对应的用户统计当前账期。
 * 这里不启动 agent 进程，避免 CLI 把 Key 的登录态写进磁盘。
 */

const ENDPOINT = (process.env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh").replace(/\/$/, "");
const TIMEOUT_MS = 12_000;

type Session = { hash: string; token: string; until: number };
let session: Session | null = null;
let inflight: { hash: string; promise: Promise<CursorBill> } | null = null;

function keyHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function post(url: string, token: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

async function exchange(apiKey: string): Promise<string> {
  const hash = keyHash(apiKey);
  if (session && session.hash === hash && session.until > Date.now()) return session.token;
  const payload = record(
    await post(`${ENDPOINT}/auth/exchange_user_api_key`, apiKey, {}),
  );
  const token = payload && typeof payload.accessToken === "string" ? payload.accessToken : "";
  if (!token) throw new Error("这把 API Key 换不到 Cursor 登录态。");
  session = { hash, token, until: Date.now() + 8 * 60_000 };
  return token;
}

function dash(token: string, method: string, body: unknown): Promise<unknown> {
  return post(`${ENDPOINT}/aiserver.v1.DashboardService/${method}`, token, body);
}

function percent(explicit: unknown, used: unknown, limit: unknown): number {
  const given = num(explicit);
  if (given !== undefined) return given;
  const spent = num(used) ?? 0;
  const cap = num(limit) ?? 0;
  return cap > 0 ? (spent / cap) * 100 : 0;
}

/** 对齐 CLI `/usage` 里 on-demand 那一行。hardLimit 按美元，spend limit 按美分。 */
export function onDemandFrom(period: Record<string, unknown>, hard: Record<string, unknown> | null): CursorOnDemand {
  const spend = record(period.spendLimitUsage) ?? {};
  const usedCents = num(spend.individualUsed) ?? 0;
  const individualLimit = num(spend.individualLimit);
  const fromIndividual = (): CursorOnDemand | undefined => {
    if (individualLimit === undefined) return undefined;
    if (individualLimit > 0) return { kind: "fixed", usedCents, limitCents: individualLimit };
    return { kind: "disabled", usedCents };
  };
  const pooled = num(spend.pooledLimit) ?? 0;
  const hardLimit = hard ? num(hard.hardLimit) : undefined;
  const noUsage = hard?.noUsageBasedAllowed === true;

  if (spend.limitType === "team") {
    const fixed = fromIndividual();
    if (fixed) return fixed;
    if (hard) {
      if (noUsage || (hardLimit ?? 0) <= 0) return { kind: "disabled", usedCents };
      return { kind: "unlimited", usedCents };
    }
    if (pooled > 0) return { kind: "unlimited", usedCents };
    return { kind: "unavailable", usedCents };
  }
  if (!hard) return fromIndividual() ?? { kind: "unavailable", usedCents };
  if (noUsage) return { kind: "disabled", usedCents };
  if ((hardLimit ?? 0) >= 2_147_483_647) return { kind: "unlimited", usedCents };
  if ((hardLimit ?? 0) > 0) return { kind: "fixed", usedCents, limitCents: (hardLimit ?? 0) * 100 };
  return { kind: "disabled", usedCents };
}

function modelsFrom(usage: Record<string, unknown>): CursorBill["models"] {
  const rows = Array.isArray(usage.aggregations) ? usage.aggregations : [];
  const models = rows
    .map((row) => {
      const item = record(row);
      if (!item) return null;
      const name = typeof item.modelIntent === "string" ? item.modelIntent.trim() : "";
      const spendCents = num(item.totalCents);
      if (!name || spendCents === undefined || spendCents <= 0) return null;
      return { name, spendCents };
    })
    .filter((row): row is { name: string; spendCents: number } => Boolean(row))
    .sort((a, b) => b.spendCents - a.spendCents)
    .slice(0, 5);
  return models.length ? models : undefined;
}

function failed(message: string): CursorBill {
  return { ok: false, error: message, fetchedAt: Date.now() };
}

async function load(apiKey: string): Promise<CursorBill> {
  let token: string;
  try {
    token = await exchange(apiKey);
  } catch (err) {
    session = null;
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return failed("这把 API Key 换不到 Cursor 登录态。");
    return failed("暂时连不上 Cursor，账单没取到。");
  }

  const call = (method: string, body: unknown) => dash(token, method, body);
  let periodRaw: unknown;
  let planRaw: unknown;
  let hardRaw: unknown;
  let meRaw: unknown;
  try {
    [periodRaw, planRaw, hardRaw, meRaw] = await Promise.all([
      call("GetCurrentPeriodUsage", {}),
      call("GetPlanInfo", {}),
      call("GetHardLimit", {}).catch(() => null),
      call("GetMe", {}),
    ]);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      session = null;
      try {
        token = await exchange(apiKey);
        [periodRaw, planRaw, hardRaw, meRaw] = await Promise.all([
          dash(token, "GetCurrentPeriodUsage", {}),
          dash(token, "GetPlanInfo", {}),
          dash(token, "GetHardLimit", {}).catch(() => null),
          dash(token, "GetMe", {}),
        ]);
      } catch {
        return failed("Cursor 拒绝了这把 API Key 的用量查询。");
      }
    } else {
      return failed("暂时连不上 Cursor，账单没取到。");
    }
  }

  const period = record(periodRaw) ?? {};
  const planInfo = record(record(planRaw)?.planInfo);
  const hard = record(hardRaw);
  const me = record(meRaw) ?? {};
  const plan = typeof planInfo?.planName === "string" && planInfo.planName ? planInfo.planName : undefined;
  const planUsage = record(period.planUsage);
  const fetchedAt = Date.now();

  if (planUsage) {
    const cycleEnd = num(period.billingCycleEnd) || num(planInfo?.billingCycleEnd);
    const cycleStart = num(period.billingCycleStart);
    return {
      ok: true,
      plan,
      cycleStart: cycleStart && cycleEnd && cycleStart !== cycleEnd ? cycleStart : undefined,
      cycleEnd: cycleEnd || undefined,
      includedPercent: percent(planUsage.totalPercentUsed, planUsage.includedSpend, planUsage.limit),
      autoPercent: num(planUsage.autoPercentUsed) ?? 0,
      apiPercent: num(planUsage.apiPercentUsed) ?? 0,
      onDemand: onDemandFrom(period, hard),
      fetchedAt,
    };
  }

  const teamId = num(me.teamId);
  const userId = num(me.userId);
  if (me.isEnterpriseUser !== true || teamId === undefined || userId === undefined) {
    return {
      ok: true,
      plan,
      error: "这个方案在 Cursor 里没有可显示的用量明细。",
      fetchedAt,
    };
  }

  try {
    const cycle = record(await dash(token, "GetMonthlyBillingCycle", { teamId })) ?? {};
    const cycleStart = num(cycle.startDateEpochMillis);
    const cycleEnd = num(cycle.endDateEpochMillis) || num(planInfo?.billingCycleEnd);
    const usage = record(
      await dash(token, "GetAggregatedUsageEvents", {
        teamId,
        userId,
        startDate: cycleStart,
        endDate: cycleEnd ?? Date.now(),
      }),
    ) ?? {};
    return {
      ok: true,
      plan: plan || "Enterprise",
      cycleStart,
      cycleEnd,
      spendCents: num(usage.totalCostCents) ?? 0,
      inputTokens: num(usage.totalInputTokens) ?? 0,
      outputTokens: num(usage.totalOutputTokens) ?? 0,
      cacheReadTokens: num(usage.totalCacheReadTokens) ?? 0,
      models: modelsFrom(usage),
      fetchedAt,
    };
  } catch {
    return {
      ok: true,
      plan: plan || "Enterprise",
      error: "账期花费暂时没取到。",
      fetchedAt,
    };
  }
}

/** 管理员打开统计时调用。同一把 Key 的并发请求合并成一次。 */
export function cursorBill(apiKey: string): Promise<CursorBill> {
  const trimmed = apiKey.trim();
  if (!trimmed) return Promise.resolve(failed("服务器未配置 CURSOR_API_KEY。"));
  const hash = keyHash(trimmed);
  if (inflight && inflight.hash === hash) return inflight.promise;
  const promise = load(trimmed).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { hash, promise };
  return promise;
}
