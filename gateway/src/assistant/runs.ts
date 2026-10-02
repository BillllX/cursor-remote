import { postInbox } from "./inbox.ts";
import { assistantPath, newId, readJson, writeJson, type TenantRef } from "./store.ts";

export type RunOrigin = "loop" | "schedule" | "integrator" | "delegate" | "probe";

export type BackgroundRun = {
  runId: string;
  origin: RunOrigin;
  label: string;
  status: "running" | "done" | "failed" | "interrupted";
  startedAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  chatId?: string;
  cwd: string;
  model: string;
};

type RunsFile = { runs: BackgroundRun[] };

const MAX_RUNS = 200;

function file(ref: TenantRef) {
  return assistantPath(ref, "runs.json");
}

export function listRuns(ref: TenantRef, limit = 30): BackgroundRun[] {
  return readJson<RunsFile>(file(ref), { runs: [] }).runs.slice(-limit).reverse();
}

export function runningCount(ref: TenantRef) {
  return readJson<RunsFile>(file(ref), { runs: [] }).runs.filter((run) => run.status === "running").length;
}

export function startRunRecord(ref: TenantRef, input: Omit<BackgroundRun, "runId" | "status" | "startedAt">) {
  const data = readJson<RunsFile>(file(ref), { runs: [] });
  const run: BackgroundRun = { ...input, runId: newId("r"), status: "running", startedAt: Date.now() };
  data.runs = [...data.runs, run].slice(-MAX_RUNS);
  writeJson(file(ref), data);
  return run;
}

export function endRunRecord(
  ref: TenantRef,
  runId: string,
  patch: { status: "done" | "failed"; summary?: string; error?: string },
) {
  const data = readJson<RunsFile>(file(ref), { runs: [] });
  const run = data.runs.find((item) => item.runId === runId);
  if (!run) return;
  Object.assign(run, patch, { endedAt: Date.now() });
  writeJson(file(ref), data);
}

/** 网关启动时：还在 running 的记为中断并进收件箱，不自动重跑，避免重复副作用 */
export function recoverRuns(ref: TenantRef) {
  const data = readJson<RunsFile>(file(ref), { runs: [] });
  const stale = data.runs.filter((run) => run.status === "running");
  if (!stale.length) return 0;
  for (const run of stale) {
    run.status = "interrupted";
    run.endedAt = Date.now();
    run.error = "网关重启，运行被中断";
  }
  writeJson(file(ref), data);
  for (const run of stale) {
    postInbox(ref, {
      kind: "run",
      title: `后台运行被中断：${run.label}`,
      body: "网关重启时这次后台运行还没结束，没有自动重跑。需要的话在会话里再说一次。",
      key: `interrupted:${run.runId}`,
      runId: run.runId,
      chatId: run.chatId,
    });
  }
  return stale.length;
}
