import { projectRuns } from "../runs.ts";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectError, type ProjectRequest } from "../../../../shared/projectTypes.ts";
import { decodeProjectRequest } from "../../../../shared/projectValidation.ts";
import { projectMembership } from "../membership.ts";
import { projectFiles, stageProjectUpload, setProjectSigningKey, readProjectResource } from "../files.ts";
import { projectChats } from "../chats.ts";
import { projectLifecycle } from "../lifecycle.ts";
import { ProjectStoreCore } from "./core.ts";
export class ProjectStore extends ProjectStoreCore {
  constructor(directory: string, clock: () => number = Date.now) {
    super(directory, clock);
    const keyFile = join(directory, "resource.key");
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    setProjectSigningKey(this, readFileSync(keyFile));
  }
  stageUpload(actor: string, id: string, bytes: Buffer) {
    return stageProjectUpload(this, actor, id, bytes);
  }
  readResource(actor: string, id: string, ticket: string) {
    return readProjectResource(this, actor, id, ticket);
  }
  request(actor: string, input: unknown): unknown {
    const r = decodeProjectRequest(input);
    this.principal(actor);
    // 先验证当前授权，再查幂等结果，防止撤权后通过旧 operationId 读取项目。
    if (r.workspaceId) {
      const editor = ["project_commit", "project_chat_create", "project_message_send", "project_run_apply"];
      const admin = ["project_invite", "project_config_set", "project_rules_propose"];
      const owner = ["project_rules_approve", "project_archive", "project_restore", "project_delete", "project_export"];
      const minimum = owner.includes(r.action)
        ? "owner"
        : admin.includes(r.action)
          ? "admin"
          : editor.includes(r.action)
            ? "editor"
            : "viewer";
      this.access(actor, r.workspaceId, minimum, editor.includes(r.action) || admin.includes(r.action));
      if (
        r.action === "project_config_set" &&
        this.access(actor, r.workspaceId).m.role !== "owner" &&
        Object.keys(r.payload.patch as object).some((k) => k !== "title")
      )
        throw new ProjectError("FORBIDDEN");
    }
    if (r.action === "project_invite_accept") {
      const inv = this.one<{ target: string; status: string; project: string }>(
        "SELECT * FROM invites WHERE id=?",
        String(r.payload.inviteId),
      );
      if (!inv || inv.target !== actor) throw new ProjectError("NOT_ACCESSIBLE");
      if (inv.status === "accepted") this.access(actor, inv.project);
    }
    try {
      return this.tx(() => this.idempotent(actor, r, () => this.dispatch(actor, r)));
    } catch (e) {
      if ((e as { code?: string })?.code === "STORAGE_CORRUPT" && r.workspaceId) {
        this.exec("UPDATE projects SET state='recovering',authz=authz+1 WHERE id=?", r.workspaceId);
      }
      throw e;
    }
  }
  private dispatch(actor: string, r: ProjectRequest): unknown {
    const a = r.payload,
      id = r.workspaceId!;
    if (r.action === "project_create") return this.create(actor, String(a.title));
    if (r.action === "project_list") {
      const list = this.list(actor),
        after = String(a.cursor || "");
      const items = list.filter((p) => p.workspaceId > after).slice(0, Math.min(Number(a.limit || 50), 100));
      return {
        items,
        nextCursor: items.length === Math.min(Number(a.limit || 50), 100) ? items.at(-1)!.workspaceId : null,
      };
    }
    if (
      [
        "project_inbox",
        "project_invite",
        "project_invite_accept",
        "project_invite_revoke",
        "project_members",
        "project_member_set",
        "project_member_remove",
        "project_leave",
      ].includes(r.action)
    )
      return projectMembership(this, actor, r);
    if (["project_tree", "project_file_read", "project_commit"].includes(r.action)) return projectFiles(this, actor, r);
    if (r.action === "project_snapshot") {
      const { p, m } = this.access(actor, id);
      return {
        summary: this.summary(p, m.role),
        eventSeq: p.seq,
        chatSummaries: this.all(
          "SELECT id AS chatId,title,seq AS lastMessageSeq FROM chats WHERE project=? ORDER BY created LIMIT 100",
          id,
        ),
        runs: this.all(
          "SELECT id AS runId,chat AS chatId,actor,status,base AS baseRevision,error FROM runs WHERE project=? ORDER BY created DESC LIMIT 30",
          id,
        ),
        config: m.role === "owner" ? JSON.parse(p.config) : undefined,
      };
    }
    if (r.action === "project_subscribe" || r.action === "project_event_read")
      return {
        items: this.events(actor, id, Number(a.afterEventSeq), Number(a.limit || 100)),
        eventSeq: this.project(id).seq,
      };
    if (r.action === "project_unsubscribe") return { unsubscribed: true };
    if (
      [
        "project_chat_create",
        "project_chat_read",
        "project_message_send",
        "project_read_set",
        "project_pin_set",
      ].includes(r.action)
    )
      return projectChats(this, actor, r);
    if (
      [
        "project_config_set",
        "project_rules_propose",
        "project_rules_approve",
        "project_archive",
        "project_restore",
        "project_delete",
        "project_export",
      ].includes(r.action)
    )
      return projectLifecycle(this, actor, r);
    if (r.action.startsWith("project_run_")) return projectRuns(this, actor, r);
    if (r.action.startsWith("project_migrate_"))
      throw new ProjectError("PROJECT_UNAVAILABLE", "迁移必须先完成备份、旧路径封禁和门户撤销验证");
    throw new ProjectError("BAD_REQUEST");
  }
}
