import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectError,
  type ProjectPrincipal,
  type ProjectRole,
  type ProjectSummary,
  type ProjectEvent,
  type ProjectRequest,
} from "../../../../shared/projectTypes.ts";
import { initializeProjectSchema } from "./schema.ts";
import { canonical, hashBytes, ProjectObjects } from "./objects.ts";
export type ProjectRow = {
  id: string;
  owner: string;
  title: string;
  state: ProjectSummary["state"];
  root: string;
  revision: number;
  authz: number;
  config_revision: number;
  seq: number;
  config: string;
  rules: string;
  created: number;
  deleted_at: number | null;
};
export type MemberRow = {
  project: string;
  tenant: string;
  role: ProjectRole;
  status: string;
  revision: number;
  joined: number;
};
export const rank = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export class ProjectStoreCore {
  readonly db: DatabaseSync;
  readonly objects: ProjectObjects;
  readonly models = new Map<string, { providerId: string; inputByteMicros: number; outputTokenMicros: number }>();
  readonly accounts = new Map<string, ProjectPrincipal>();
  constructor(
    readonly directory: string,
    readonly clock: () => number = Date.now,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "projects.sqlite"));
    initializeProjectSchema(this.db);
    for (const name of ["projects.sqlite", "projects.sqlite-wal", "projects.sqlite-shm"]) {
      try {
        chmodSync(join(directory, name), 0o600);
      } catch {
        /* SQLite 可能未创建 WAL。 */
      }
    }
    this.objects = new ProjectObjects(join(directory, "blobs"));
  }
  close() {
    this.db.close();
  }
  setAccounts(accounts: ProjectPrincipal[]) {
    this.accounts.clear();
    for (const account of accounts) this.accounts.set(account.id, { ...account });
  }
  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  exec(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  tx<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  principal(id: string) {
    const a = this.accounts.get(id);
    if (!a?.sharingEnabled || !a.sharingDomain || !a.sandboxVerified)
      throw new ProjectError("NOT_ACCESSIBLE", "项目不可访问");
    return a;
  }
  project(id: string) {
    const p = this.one<ProjectRow>("SELECT * FROM projects WHERE id=?", id);
    if (!p || p.state === "deleted") throw new ProjectError("NOT_ACCESSIBLE", "项目不可访问");
    return p;
  }
  access(actor: string, id: string, minimum: ProjectRole = "viewer", write = false) {
    const account = this.principal(actor),
      p = this.project(id),
      owner = this.principal(p.owner);
    const m = this.one<MemberRow>("SELECT * FROM members WHERE project=? AND tenant=? AND status='active'", id, actor);
    if (!m || account.sharingDomain !== owner.sharingDomain || (p.state === "deleting" && p.owner !== actor))
      throw new ProjectError("NOT_ACCESSIBLE", "项目不可访问");
    if (p.state === "creating" || p.state === "recovering") throw new ProjectError("PROJECT_UNAVAILABLE");
    if (rank[m.role] < rank[minimum]) throw new ProjectError("FORBIDDEN", "项目角色不允许此操作");
    if (write && p.state !== "active") throw new ProjectError("PROJECT_UNAVAILABLE", "项目当前不可写");
    return { p, m };
  }
  summary(p: ProjectRow, role: ProjectRole): ProjectSummary {
    return {
      workspaceId: p.id,
      title: p.title,
      ownerTenantId: p.owner,
      role,
      state: p.state,
      revision: p.revision,
      authzRevision: p.authz,
      configRevision: p.config_revision,
      eventSeq: p.seq,
    };
  }
  event(id: string, kind: string, payload: unknown) {
    const p = this.project(id);
    const seq = p.seq + 1;
    if (!Number.isSafeInteger(seq)) throw new ProjectError("LIMIT_EXCEEDED");
    const raw = JSON.stringify(payload);
    if (Buffer.byteLength(raw) > 60000) throw new ProjectError("LIMIT_EXCEEDED", "事件过大");
    this.exec("UPDATE projects SET seq=? WHERE id=?", seq, id);
    this.exec("INSERT INTO events VALUES(?,?,?,?,?)", id, seq, kind, raw, this.clock());
    return seq;
  }
  events(actor: string, id: string, after: number, limit = 100): ProjectEvent[] {
    const { p } = this.access(actor, id);
    const first = this.one<{ seq: number }>("SELECT min(seq) AS seq FROM events WHERE project=?", id);
    if (after > p.seq || (first?.seq && after < first.seq - 1)) throw new ProjectError("RESYNC_REQUIRED");
    return this.all<{ seq: number; kind: string; payload: string }>(
      "SELECT * FROM events WHERE project=? AND seq>? ORDER BY seq LIMIT ?",
      id,
      after,
      Math.min(limit, 100),
    ).map((e) => ({
      type: "project_event",
      workspaceId: id,
      eventSeq: e.seq,
      kind: e.kind,
      revision: p.revision,
      authzRevision: p.authz,
      payload: JSON.parse(e.payload),
    }));
  }
  bumpAuthz(id: string) {
    this.exec("UPDATE projects SET authz=authz+1 WHERE id=?", id);
  }
  audit(actor: string, req: ProjectRequest, id: string | null) {
    this.exec(
      "INSERT INTO audit(project,actor,action,operation,created) VALUES(?,?,?,?,?)",
      id,
      actor,
      req.action,
      String(req.payload.operationId || ""),
      this.clock(),
    );
  }
  idempotent<T>(actor: string, req: ProjectRequest, run: () => T): T {
    const operation = req.payload.operationId;
    if (!operation) return run();
    const scope = req.workspaceId || req.action,
      hash = hashBytes(canonical({ action: req.action, workspaceId: req.workspaceId ?? null, payload: req.payload }));
    const prior = this.one<{ request_hash: string; result: string }>(
      "SELECT * FROM operations WHERE scope=? AND actor=? AND operation=?",
      scope,
      actor,
      String(operation),
    );
    if (prior) {
      if (prior.request_hash !== hash) throw new ProjectError("IDEMPOTENCY_MISMATCH");
      return JSON.parse(prior.result) as T;
    }
    const count = this.one<{ n: number }>("SELECT count(*) AS n FROM operations WHERE scope=?", scope)?.n || 0;
    if (count >= 100000) throw new ProjectError("LIMIT_EXCEEDED");
    const result = run();
    this.exec(
      "INSERT INTO operations VALUES(?,?,?,?,?)",
      scope,
      actor,
      String(operation),
      hash,
      JSON.stringify(result),
    );
    this.audit(actor, req, req.workspaceId || null);
    return result;
  }
  create(actor: string, title: string) {
    if (
      (this.one<{ n: number }>("SELECT count(*) n FROM projects WHERE owner=? AND state!='deleted'", actor)?.n || 0) >=
      100
    )
      throw new ProjectError("LIMIT_EXCEEDED");
    const id = `wsa_${randomUUID()}`,
      root = this.objects.tree([]),
      now = this.clock();
    this.exec(
      "INSERT INTO projects(id,owner,title,state,root,created) VALUES(?,?,?,'active',?,?)",
      id,
      actor,
      title.trim(),
      root,
      now,
    );
    this.exec("INSERT INTO members VALUES(?,?,'owner','active',0,?)", id, actor, now);
    this.exec("INSERT INTO revisions VALUES(?,0,?,?,?,?)", id, root, actor, "[]", now);
    this.event(id, "project_created", {});
    return this.summary(this.project(id), "owner");
  }
  list(actor: string) {
    return this.all<ProjectRow & { role: ProjectRole }>(
      "SELECT p.*,m.role FROM projects p JOIN members m ON p.id=m.project WHERE m.tenant=? AND m.status='active' AND p.state!='deleted' ORDER BY p.id",
      actor,
    )
      .filter((p) => {
        try {
          this.access(actor, p.id);
          return true;
        } catch {
          return false;
        }
      })
      .map((p) => this.summary(p, p.role));
  }
  cursor(actor: string, id: string, last: string, revision: number) {
    return Buffer.from(JSON.stringify({ actor, id, last, revision })).toString("base64url");
  }
}
