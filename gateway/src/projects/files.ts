import { projectPage } from "./page.ts";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { PROJECT_LIMITS, ProjectError, type ProjectRequest } from "../../../shared/projectTypes.ts";
import { exact, projectPath, record } from "../../../shared/projectValidation.ts";
import { type ProjectStoreCore } from "./store/core.ts";
type Upload = {
  id: string;
  project: string;
  actor: string;
  hash: string;
  size: number;
  expires: number;
  consumed: string | null;
};
export function stageProjectUpload(s: ProjectStoreCore, actor: string, id: string, bytes: Buffer) {
  s.access(actor, id, "editor", true);
  if (bytes.length > PROJECT_LIMITS.fileBytes) throw new ProjectError("LIMIT_EXCEEDED");
  return s.tx(() => {
    s.access(actor, id, "editor", true);
    const quota = s.one<{ n: number; bytes: number }>(
      "SELECT count(*) n,coalesce(sum(size),0) bytes FROM uploads WHERE project=? AND actor=? AND consumed IS NULL AND expires>?",
      id,
      actor,
      s.clock(),
    )!;
    if (quota.n >= 5 || quota.bytes + bytes.length > 100 * 1024 * 1024) throw new ProjectError("LIMIT_EXCEEDED");
    const hash = s.objects.put(bytes),
      uploadId = randomUUID(),
      expiresAt = s.clock() + PROJECT_LIMITS.uploadTtl;
    s.exec("INSERT OR IGNORE INTO objects VALUES(?,?,?)", hash, bytes.length, s.clock());
    s.exec("INSERT INTO uploads VALUES(?,?,?,?,?,?,NULL)", uploadId, id, actor, hash, bytes.length, expiresAt);
    return { uploadId, sha256: hash, size: bytes.length, expiresAt };
  });
}
export function projectFiles(s: ProjectStoreCore, actor: string, r: ProjectRequest): unknown {
  const id = r.workspaceId!,
    a = r.payload,
    { p } = s.access(actor, id, r.action === "project_commit" ? "editor" : "viewer", r.action === "project_commit");
  const rev = Number(a.revision ?? p.revision),
    version = s.one<{ root: string }>("SELECT root FROM revisions WHERE project=? AND revision=?", id, rev);
  if (!version) throw new ProjectError("NOT_ACCESSIBLE");
  const entries = s.objects.entries(version.root);
  if (r.action === "project_tree") {
    const prefix = String(a.prefix || "");
    const after = a.cursor ? decodeCursor(s, actor, id, String(a.cursor), rev) : "";
    const selected = entries.filter(
      (e) =>
        (!prefix || e.path === prefix || e.path.startsWith(prefix + "/")) &&
        (!after || Buffer.compare(Buffer.from(e.path), Buffer.from(after)) > 0),
    );
    const limit = Math.min(Number(a.limit || 200), 500),
      items = projectPage(selected.slice(0, limit));
    return {
      items,
      revision: rev,
      nextCursor: selected.length > items.length ? encodeCursor(s, actor, id, items.at(-1)!.path, rev) : null,
    };
  }
  if (r.action === "project_file_read") {
    const path = projectPath(a.path),
      file = entries.find((e) => e.path === path && e.kind === "file");
    if (!file?.blobHash) throw new ProjectError("NOT_ACCESSIBLE");
    const bytes = s.objects.read(file.blobHash),
      meta = { path, revision: rev, blobHash: file.blobHash, size: bytes.length };
    if (bytes.length > 60000) return { ...meta, ticket: issueTicket(s, actor, id, file.blobHash, rev, p.authz) };
    const text = bytes.toString("utf8");
    return Buffer.from(text).equals(bytes) ? { ...meta, text } : { ...meta, base64: bytes.toString("base64") };
  }
  if (a.expectedRevision !== p.revision) {
    const changed = new Set(
      s
        .all<{ paths: string }>(
          "SELECT paths FROM revisions WHERE project=? AND revision>? ORDER BY revision",
          id,
          Number(a.expectedRevision),
        )
        .flatMap((v) => JSON.parse(v.paths) as string[]),
    );
    throw new ProjectError("CONFLICT", "项目已更新，请比较后重新提交", p.revision, [...changed].slice(0, 100));
  }
  const changes = a.changes as unknown[],
    next = new Map(entries.map((e) => [e.path, e])),
    seen: string[] = [],
    consumed: string[] = [];
  for (const c of changes) {
    if (!record(c) || !["put", "delete", "mkdir"].includes(String(c.kind))) throw new ProjectError("BAD_REQUEST");
    exact(c, c.kind === "put" ? ["kind", "path", "uploadId"] : ["kind", "path"]);
    const path = projectPath(c.path);
    if (seen.some((x) => x === path || x.startsWith(path + "/") || path.startsWith(x + "/")))
      throw new ProjectError("BAD_REQUEST", "提交包含重叠路径");
    seen.push(path);
    if (c.kind === "delete") {
      if (!next.has(path)) throw new ProjectError("NOT_ACCESSIBLE");
      for (const key of next.keys()) if (key === path || key.startsWith(path + "/")) next.delete(key);
    } else if (c.kind === "mkdir") {
      if (next.has(path)) throw new ProjectError("CONFLICT");
      next.set(path, { path, kind: "dir" });
    } else {
      if (typeof c.uploadId !== "string" || consumed.includes(c.uploadId)) throw new ProjectError("BAD_REQUEST");
      const u = s.one<Upload>(
        "SELECT * FROM uploads WHERE id=? AND project=? AND actor=? AND consumed IS NULL AND expires>?",
        c.uploadId,
        id,
        actor,
        s.clock(),
      );
      if (!u) throw new ProjectError("NOT_ACCESSIBLE");
      const verified = s.objects.read(u.hash);
      if (verified.length !== u.size) throw new ProjectError("STORAGE_CORRUPT");
      if (next.get(path)?.kind === "dir") throw new ProjectError("CONFLICT");
      next.set(path, { path, kind: "file", blobHash: u.hash, size: u.size });
      consumed.push(u.id);
    }
  }
  // 规范树中显式保留父目录，大小写与类型冲突由对象层统一检查。
  for (const path of [...next.keys()]) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      const dir = parts.join("/");
      if (!next.has(dir)) next.set(dir, { path: dir, kind: "dir" });
      parts.pop();
    }
  }
  const root = s.objects.tree([...next.values()]);
  const prior = s.all<{ root: string }>("SELECT root FROM revisions WHERE project=?", id),
    hashes = new Set<string>();
  let history = 0;
  for (const tree of [...prior.map((v) => v.root), root])
    for (const e of s.objects.entries(tree))
      if (e.blobHash && !hashes.has(e.blobHash)) {
        hashes.add(e.blobHash);
        history += e.size || 0;
      }
  if (history > PROJECT_LIMITS.historyBytes) throw new ProjectError("LIMIT_EXCEEDED", "项目历史空间已满");
  const revision = p.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new ProjectError("LIMIT_EXCEEDED");
  s.exec("INSERT OR IGNORE INTO objects VALUES(?,?,?)", root, s.objects.read(root).length, s.clock());
  s.exec("INSERT INTO revisions VALUES(?,?,?,?,?,?)", id, revision, root, actor, JSON.stringify(seen), s.clock());
  s.exec("UPDATE projects SET root=?,revision=? WHERE id=?", root, revision, id);
  for (const uid of consumed) s.exec("UPDATE uploads SET consumed=? WHERE id=?", String(a.operationId), uid);
  const eventSeq = s.event(id, "files_changed", { paths: seen, revision });
  return { revision, rootHash: root, eventSeq };
}
// 票据/游标密钥在规范存储内创建，普通租户不能读取，重启后保持稳定。
const keys = new WeakMap<ProjectStoreCore, Buffer>();
export function setProjectSigningKey(s: ProjectStoreCore, key: Buffer) {
  keys.set(s, key);
}
function sign(s: ProjectStoreCore, v: unknown) {
  const key = keys.get(s);
  if (!key) throw new ProjectError("PROJECT_UNAVAILABLE");
  const data = Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${data}.${createHmac("sha256", key).update(data).digest("base64url")}`;
}
function verify(s: ProjectStoreCore, token: string): Record<string, unknown> {
  const [data, mac, ...extra] = token.split(".");
  if (!data || !mac || extra.length) throw new ProjectError("NOT_ACCESSIBLE");
  const key = keys.get(s);
  if (!key) throw new ProjectError("PROJECT_UNAVAILABLE");
  const expected = createHmac("sha256", key).update(data).digest(),
    got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new ProjectError("NOT_ACCESSIBLE");
  try {
    const v = JSON.parse(Buffer.from(data, "base64url").toString());
    if (!record(v)) throw new Error();
    return v;
  } catch {
    throw new ProjectError("NOT_ACCESSIBLE");
  }
}
function encodeCursor(s: ProjectStoreCore, actor: string, id: string, last: string, revision: number) {
  return sign(s, { kind: "cursor", actor, id, last, revision });
}
function decodeCursor(s: ProjectStoreCore, actor: string, id: string, token: string, revision: number) {
  const v = verify(s, token);
  if (v.kind !== "cursor" || v.actor !== actor || v.id !== id || v.revision !== revision || typeof v.last !== "string")
    throw new ProjectError("RESYNC_REQUIRED");
  return v.last;
}
export function issueTicket(
  s: ProjectStoreCore,
  actor: string,
  id: string,
  hash: string,
  revision: number,
  authz: number,
) {
  return sign(s, { kind: "media", actor, id, hash, revision, authz, expires: s.clock() + 60000 });
}
export function readProjectResource(s: ProjectStoreCore, actor: string, id: string, token: string) {
  const { p } = s.access(actor, id),
    t = verify(s, token);
  if (
    t.kind !== "media" ||
    t.actor !== actor ||
    t.id !== id ||
    t.authz !== p.authz ||
    Number(t.expires) < s.clock() ||
    typeof t.hash !== "string"
  )
    throw new ProjectError("NOT_ACCESSIBLE");
  const rev = s.one<{ root: string }>(
    "SELECT root FROM revisions WHERE project=? AND revision=?",
    id,
    Number(t.revision),
  );
  if (!rev || !s.objects.entries(rev.root).some((e) => e.blobHash === t.hash)) throw new ProjectError("NOT_ACCESSIBLE");
  return s.objects.read(t.hash);
}
