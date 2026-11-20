import { randomUUID } from "node:crypto";
import { ProjectError, type ProjectRequest, type ProjectRole } from "../../../shared/projectTypes.ts";
import { type MemberRow, type ProjectStoreCore, rank } from "./store/core.ts";
type Invite = {
  id: string;
  project: string;
  target: string;
  inviter: string;
  role: ProjectRole;
  status: string;
  expires: number;
};
function manageable(self: MemberRow, target: MemberRow | undefined, role?: ProjectRole) {
  if (target?.role === "owner" || role === "owner" || target?.tenant === self.tenant)
    throw new ProjectError("FORBIDDEN");
  if (self.role !== "owner" && (rank[self.role] < rank.admin || target?.role === "admin" || role === "admin"))
    throw new ProjectError("FORBIDDEN");
}
export function projectMembership(s: ProjectStoreCore, actor: string, r: ProjectRequest): unknown {
  const a = r.payload,
    id = r.workspaceId || "";
  if (r.action === "project_inbox")
    return {
      items: s
        .all<Invite>(
          "SELECT * FROM invites WHERE target=? AND status='pending' AND expires>? ORDER BY id",
          actor,
          s.clock(),
        )
        .filter((i) => {
          try {
            const p = s.project(i.project);
            return p.state === "active" && s.principal(p.owner).sharingDomain === s.principal(actor).sharingDomain;
          } catch {
            return false;
          }
        })
        .map((i) => ({
          inviteId: i.id,
          workspaceId: i.project,
          title: s.project(i.project).title,
          role: i.role,
          inviterId: i.inviter,
          expiresAt: i.expires,
        })),
    };
  if (r.action === "project_invite_accept") {
    const inv = s.one<Invite>("SELECT * FROM invites WHERE id=?", String(a.inviteId));
    if (!inv || inv.target !== actor) throw new ProjectError("NOT_ACCESSIBLE");
    if (inv.status === "accepted") {
      const { m } = s.access(actor, inv.project);
      return { workspaceId: inv.project, role: m.role };
    }
    if (inv.status !== "pending") throw new ProjectError("NOT_ACCESSIBLE");
    if (inv.expires <= s.clock()) throw new ProjectError("INVITE_EXPIRED");
    const { p, m: inviter } = s.access(inv.inviter, inv.project, "admin", true);
    if (s.principal(actor).sharingDomain !== s.principal(p.owner).sharingDomain)
      throw new ProjectError("NOT_ACCESSIBLE");
    manageable(inviter, undefined, inv.role);
    const old = s.one<MemberRow>("SELECT * FROM members WHERE project=? AND tenant=?", inv.project, actor);
    if (old?.status === "active") throw new ProjectError("CONFLICT");
    s.exec(
      "INSERT INTO members VALUES(?,?,?,'active',0,?) ON CONFLICT(project,tenant) DO UPDATE SET role=excluded.role,status='active',revision=members.revision+1,joined=excluded.joined",
      inv.project,
      actor,
      inv.role,
      s.clock(),
    );
    s.exec("UPDATE invites SET status='accepted' WHERE id=?", inv.id);
    s.bumpAuthz(inv.project);
    s.event(inv.project, "member_joined", { tenantId: actor });
    return { workspaceId: inv.project, role: inv.role };
  }
  const { p, m } = s.access(actor, id, "viewer", !["project_members"].includes(r.action));
  if (r.action === "project_members")
    return {
      items: s
        .all<MemberRow>("SELECT * FROM members WHERE project=? AND status='active' ORDER BY tenant", id)
        .map((x) => ({ tenantId: x.tenant, role: x.role, revision: x.revision })),
    };
  if (r.action === "project_invite") {
    const target = s.principal(String(a.targetTenantId));
    if (target.sharingDomain !== s.principal(p.owner).sharingDomain) throw new ProjectError("NOT_ACCESSIBLE");
    const member = s.one<MemberRow>(
      "SELECT * FROM members WHERE project=? AND tenant=? AND status='active'",
      id,
      target.id,
    );
    if (member) throw new ProjectError("CONFLICT");
    manageable(m, undefined, a.role as ProjectRole);
    if (target.id === actor) throw new ProjectError("FORBIDDEN");
    const recent =
      s.one<{ n: number }>("SELECT count(*) n FROM invites WHERE inviter=? AND created>?", actor, s.clock() - 60000)
        ?.n || 0;
    if (recent >= 10) throw new ProjectError("RATE_LIMITED");
    s.exec("UPDATE invites SET status='revoked' WHERE project=? AND target=? AND status='pending'", id, target.id);
    const inviteId = randomUUID(),
      expiresAt = s.clock() + 86400000;
    s.exec(
      "INSERT INTO invites VALUES(?,?,?,?,?,'pending',?,?)",
      inviteId,
      id,
      target.id,
      actor,
      String(a.role),
      expiresAt,
      s.clock(),
    );
    s.event(id, "invitation_created", { inviteId });
    return { inviteId, expiresAt };
  }
  if (r.action === "project_invite_revoke") {
    const inv = s.one<Invite>("SELECT * FROM invites WHERE id=? AND project=?", String(a.inviteId), id);
    if (!inv) throw new ProjectError("NOT_ACCESSIBLE");
    if (inv.inviter !== actor && m.role !== "owner") throw new ProjectError("FORBIDDEN");
    s.exec("UPDATE invites SET status='revoked' WHERE id=? AND status='pending'", inv.id);
    s.event(id, "invitation_revoked", {});
    return { revoked: true };
  }
  const targetId = r.action === "project_leave" ? actor : String(a.targetTenantId),
    target = s.one<MemberRow>("SELECT * FROM members WHERE project=? AND tenant=? AND status='active'", id, targetId);
  if (!target) throw new ProjectError("NOT_ACCESSIBLE");
  if (r.action === "project_leave") {
    if (m.role === "owner") throw new ProjectError("FORBIDDEN");
  } else {
    manageable(m, target, r.action === "project_member_set" ? (a.role as ProjectRole) : undefined);
    if (target.revision !== a.expectedMemberRevision) throw new ProjectError("CONFLICT");
  }
  if (r.action === "project_member_set")
    s.exec("UPDATE members SET role=?,revision=revision+1 WHERE project=? AND tenant=?", String(a.role), id, targetId);
  else
    s.exec(
      "UPDATE members SET status=?,revision=revision+1 WHERE project=? AND tenant=?",
      r.action === "project_leave" ? "left" : "revoked",
      id,
      targetId,
    );
  s.exec(
    "UPDATE runs SET status='cancelled',generation=generation+1 WHERE project=? AND actor=? AND status IN ('queued','running','proposed','conflict')",
    id,
    targetId,
  );
  s.bumpAuthz(id);
  s.event(id, "membership_changed", { tenantId: targetId });
  return { changed: true };
}
