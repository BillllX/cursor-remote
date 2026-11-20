import { randomUUID } from "node:crypto";
import { ProjectError, type ProjectRequest } from "../../../shared/projectTypes.ts";
import { projectFiles } from "./files.ts";
import type { ProjectStoreCore } from "./store/core.ts";
export type ProjectRun = {
  id: string;
  project: string;
  chat: string;
  actor: string;
  base: number;
  root: string;
  generation: number;
  status: string;
  patch: string;
  model: string;
  rules: string;
  created: number;
  error: string | null;
};
/** 与调用方的权限变更或恢复事务一起写入。只有已领取的任务可能产生外部费用。 */
export function finishProjectRun(s: ProjectStoreCore, run: ProjectRun, status: "cancelled" | "interrupted" | "failed") {
  s.exec("UPDATE runs SET status=?,generation=generation+1 WHERE id=?", status, run.id);
  s.exec("UPDATE messages SET status=? WHERE run=? AND status='running'", status, run.id);
  if (run.status === "queued") {
    s.exec("UPDATE budget_ledger SET reserved=0,status='settled' WHERE run=? AND status='reserved'", run.id);
  } else if (run.status === "running") {
    s.exec("UPDATE budget_ledger SET status='pending' WHERE run=? AND status='reserved'", run.id);
  }
  s.event(run.project, "run_" + status, { runId: run.id, chatId: run.chat });
}

export function cancelProjectRuns(s: ProjectStoreCore, id: string, actor?: string) {
  const where = "SELECT * FROM runs WHERE project=? AND status IN ('queued','running','proposed','conflict')";
  const runs =
    actor === undefined ? s.all<ProjectRun>(where, id) : s.all<ProjectRun>(where + " AND actor=?", id, actor);
  for (const run of runs) finishProjectRun(s, run, "cancelled");
}

export function enqueueProjectRun(s: ProjectStoreCore, actor: string, id: string, chat: string, model: string) {
  const { p } = s.access(actor, id, "editor", true),
    cfg = JSON.parse(p.config),
    catalog = s.models.get(model);
  if (
    !catalog ||
    !Array.isArray(cfg.allowedModelIds) ||
    !cfg.allowedModelIds.includes(model) ||
    !Array.isArray(cfg.approvedProviderIds) ||
    !cfg.approvedProviderIds.includes(catalog.providerId)
  )
    throw new ProjectError("ENGINE_UNAVAILABLE");
  if (
    s.one(
      "SELECT id FROM runs WHERE project=? AND chat=? AND status IN ('queued','running','proposed','conflict')",
      id,
      chat,
    )
  )
    throw new ProjectError("CONFLICT", "当前对话还有未结束的项目任务");
  if ((s.one<{ n: number }>("SELECT count(*) n FROM runs WHERE project=? AND status='queued'", id)?.n || 0) >= 20)
    throw new ProjectError("LIMIT_EXCEEDED");
  const max = Number(cfg.maxRunCostMicros || 0),
    daily = Number(cfg.dailyBudgetMicros || 0),
    day = new Date(s.clock()).toISOString().slice(0, 10);
  const used =
    s.one<{ n: number }>(
      "SELECT coalesce(sum(charged+CASE WHEN status IN ('reserved','pending') THEN reserved ELSE 0 END),0) n FROM budget_ledger WHERE project=? AND day=?",
      id,
      day,
    )?.n || 0;
  if (!Number.isSafeInteger(max) || max <= 0 || max + used > daily) throw new ProjectError("BUDGET_EXCEEDED");
  const runId = randomUUID();
  s.exec(
    "INSERT INTO runs(id,project,chat,actor,base,root,status,model,rules,created) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
    runId,
    id,
    chat,
    actor,
    p.revision,
    p.root,
    model,
    p.rules,
    s.clock(),
  );
  s.exec("INSERT INTO budget_ledger VALUES(?,?,?,?,?,?,0,'reserved')", randomUUID(), id, runId, runId, day, max);
  s.event(id, "run_queued", { runId, chatId: chat });
  return runId;
}
export function projectRuns(s: ProjectStoreCore, actor: string, r: ProjectRequest): unknown {
  const id = r.workspaceId!,
    { m } = s.access(actor, id, "editor", true),
    run = s.one<ProjectRun>("SELECT * FROM runs WHERE id=? AND project=?", String(r.payload.runId), id);
  if (!run) throw new ProjectError("NOT_ACCESSIBLE");
  if (r.action === "project_run_cancel") {
    const author = s.one<{ role: string }>(
      "SELECT role FROM members WHERE project=? AND tenant=? AND status='active'",
      id,
      run.actor,
    );
    if (actor !== run.actor && m.role !== "owner" && !(m.role === "admin" && author?.role !== "owner"))
      throw new ProjectError("FORBIDDEN");
    if (["applied", "failed", "cancelled", "interrupted"].includes(run.status)) return { status: run.status };
    finishProjectRun(s, run, "cancelled");
    return { status: "cancelled" };
  }
  if (actor !== run.actor && m.role !== "owner") throw new ProjectError("FORBIDDEN");
  s.access(run.actor, id, "editor", true);
  if (!["proposed", "conflict"].includes(run.status)) throw new ProjectError("CONFLICT");
  if (run.base !== r.payload.expectedRevision || run.base !== s.project(id).revision)
    throw new ProjectError("CONFLICT", "项目已更新，请重新比较提案", s.project(id).revision);
  const patch = JSON.parse(run.patch) as { kind: string; path: string; blobHash?: string; size?: number }[];
  const changes = patch.map((change) => {
    if (change.kind === "delete") return { kind: "delete", path: change.path };
    if (!change.blobHash) throw new ProjectError("STORAGE_CORRUPT");
    const bytes = s.objects.read(change.blobHash);
    if (bytes.length !== change.size) throw new ProjectError("STORAGE_CORRUPT");
    const uploadId = randomUUID();
    s.exec(
      "INSERT INTO uploads VALUES(?,?,?,?,?,?,NULL)",
      uploadId,
      id,
      run.actor,
      change.blobHash,
      bytes.length,
      s.clock() + 1800000,
    );
    return { kind: "put", path: change.path, uploadId };
  });
  const result = changes.length
    ? projectFiles(s, run.actor, {
        ...r,
        action: "project_commit",
        payload: { operationId: r.payload.operationId, expectedRevision: run.base, changes },
      })
    : { revision: run.base };
  s.exec("UPDATE runs SET status='applied' WHERE id=?", run.id);
  s.event(id, "run_applied", { runId: run.id });
  return result;
}
