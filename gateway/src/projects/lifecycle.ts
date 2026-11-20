import { randomUUID } from "node:crypto";
import { ProjectError, type ProjectRequest } from "../../../shared/projectTypes.ts";
import { exact, record } from "../../../shared/projectValidation.ts";
import type { ProjectStoreCore } from "./store/core.ts";
export function projectLifecycle(s: ProjectStoreCore, actor: string, r: ProjectRequest): unknown {
  const id = r.workspaceId!,
    a = r.payload,
    { p, m } = s.access(actor, id);
  if (r.action === "project_config_set") {
    s.access(actor, id, "admin", true);
    const patch = a.patch;
    if (!record(patch)) throw new ProjectError("BAD_REQUEST");
    exact(patch, ["title", "dailyBudgetMicros", "maxRunCostMicros", "allowedModelIds", "approvedProviderIds"]);
    if (m.role !== "owner" && Object.keys(patch).some((k) => k !== "title")) throw new ProjectError("FORBIDDEN");
    if (p.config_revision !== a.expectedConfigRevision) throw new ProjectError("CONFLICT");
    for (const k of ["dailyBudgetMicros", "maxRunCostMicros"])
      if (k in patch && (!Number.isSafeInteger(patch[k]) || Number(patch[k]) < 0))
        throw new ProjectError("BAD_REQUEST");
    for (const k of ["allowedModelIds", "approvedProviderIds"])
      if (
        k in patch &&
        (!Array.isArray(patch[k]) ||
          (patch[k] as unknown[]).length > 20 ||
          !(patch[k] as unknown[]).every((v) => typeof v === "string" && v.length <= 200))
      )
        throw new ProjectError("BAD_REQUEST");
    if (
      patch.title !== undefined &&
      (typeof patch.title !== "string" || !patch.title.trim() || Array.from(patch.title.trim()).length > 80)
    )
      throw new ProjectError("BAD_REQUEST");
    s.exec(
      "UPDATE projects SET title=?,config=?,config_revision=config_revision+1 WHERE id=?",
      String(patch.title ?? p.title).trim(),
      JSON.stringify({ ...JSON.parse(p.config), ...patch }),
      id,
    );
    s.event(id, "config_changed", {});
    return { configRevision: p.config_revision + 1 };
  }
  if (r.action === "project_rules_propose") {
    s.access(actor, id, "admin", true);
    const proposalId = randomUUID();
    s.exec(
      "INSERT INTO proposals VALUES(?,?,?,?,?,'pending')",
      proposalId,
      id,
      actor,
      String(a.text),
      p.config_revision,
    );
    s.event(id, "rules_proposed", { proposalId });
    return { proposalId };
  }
  s.access(actor, id, "owner");
  if (r.action === "project_rules_approve") {
    if (p.state !== "active") throw new ProjectError("PROJECT_UNAVAILABLE");
    const proposal = s.one<{ text: string; revision: number }>(
      "SELECT * FROM proposals WHERE id=? AND project=? AND status='pending'",
      String(a.proposalId),
      id,
    );
    if (!proposal) throw new ProjectError("NOT_ACCESSIBLE");
    if (p.config_revision !== a.expectedConfigRevision || proposal.revision !== p.config_revision)
      throw new ProjectError("CONFLICT");
    s.exec("UPDATE projects SET rules=?,config_revision=config_revision+1 WHERE id=?", proposal.text, id);
    s.exec("UPDATE proposals SET status='approved' WHERE id=?", String(a.proposalId));
    s.event(id, "rules_approved", {});
    return { configRevision: p.config_revision + 1 };
  }
  if (r.action === "project_export") {
    const revision = Number(a.revision ?? p.revision),
      v = s.one<{ root: string }>("SELECT root FROM revisions WHERE project=? AND revision=?", id, revision);
    if (!v) throw new ProjectError("NOT_ACCESSIBLE");
    const exportId = randomUUID();
    s.exec("INSERT INTO exports VALUES(?,?,?,'completed',?)", exportId, id, v.root, s.clock());
    return {
      exportId,
      workspaceId: id,
      revision,
      rootHash: v.root,
      manifest: s.objects.entries(v.root),
      history: s.all(
        "SELECT chat,seq,kind,actor,text,status,created FROM messages WHERE project=? ORDER BY chat,seq",
        id,
      ),
      format: "project-export-v1",
    };
  }
  let state: string;
  if (r.action === "project_archive") {
    if (p.state !== "active") throw new ProjectError("CONFLICT");
    state = "archived";
  } else if (r.action === "project_delete") {
    if (p.state !== "archived") throw new ProjectError("CONFLICT");
    state = "deleting";
  } else if (r.action === "project_restore") {
    if (p.state !== "archived" && p.state !== "deleting") throw new ProjectError("CONFLICT");
    if (p.state === "deleting" && p.deleted_at !== null && s.clock() - p.deleted_at > 30 * 86400000)
      throw new ProjectError("NOT_ACCESSIBLE");
    state = p.state === "archived" ? "active" : "archived";
    if (p.state === "deleting")
      s.exec("UPDATE members SET status='revoked',revision=revision+1 WHERE project=? AND role!='owner'", id);
  } else throw new ProjectError("BAD_REQUEST");
  s.exec(
    "UPDATE projects SET state=?,authz=authz+1,deleted_at=? WHERE id=?",
    state,
    state === "deleting" ? s.clock() : null,
    id,
  );
  s.exec("UPDATE invites SET status='revoked' WHERE project=? AND status='pending'", id);
  s.exec(
    "UPDATE runs SET status='cancelled',generation=generation+1 WHERE project=? AND status IN ('queued','running','proposed','conflict')",
    id,
  );
  s.event(id, "project_state_changed", { state });
  return { state, authzRevision: p.authz + 1 };
}
