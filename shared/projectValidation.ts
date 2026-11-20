import { PROJECT_ACTION_FIELDS, PROJECT_ROLES, ProjectError, type ProjectRequest } from "./projectTypes.ts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const projectIdValid = (v: unknown): v is string =>
  typeof v === "string" && /^wsa_[0-9a-f-]{36}$/i.test(v) && uuid.test(v.slice(4));
export function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export function exact(v: Record<string, unknown>, fields: string[]) {
  if (Object.keys(v).some((k) => !fields.includes(k))) throw new ProjectError("BAD_REQUEST", "包含不支持的字段");
}
export function projectPath(v: unknown, allowEmpty = false): string {
  if (allowEmpty && v === "") return "";
  if (
    typeof v !== "string" ||
    !v ||
    v !== v.normalize("NFC") ||
    new TextEncoder().encode(v).length > 1024 ||
    /[\\:]/.test(v) ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new ProjectError("BAD_REQUEST", "项目路径不合法");
  for (const p of v.split("/")) {
    if (
      !p ||
      p === "." ||
      p === ".." ||
      /[ .]$/.test(p) ||
      new TextEncoder().encode(p).length > 255 ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)
    )
      throw new ProjectError("BAD_REQUEST", "项目路径不合法");
    if (
      [".git", ".jiebo", ".cursor", ".codex", ".cursor-remote"].includes(p.toLowerCase()) ||
      p.toLowerCase() === "agents.md"
    )
      throw new ProjectError("FORBIDDEN", "项目保护路径不可访问");
  }
  return v;
}
export function decodeProjectRequest(v: unknown): ProjectRequest {
  if (!record(v)) throw new ProjectError("BAD_REQUEST");
  exact(v, ["type", "protocol", "requestId", "action", "workspaceId", "payload"]);
  if (
    v.type !== "project_request" ||
    v.protocol !== 1 ||
    typeof v.requestId !== "string" ||
    !uuid.test(v.requestId) ||
    typeof v.action !== "string" ||
    !Object.hasOwn(PROJECT_ACTION_FIELDS, v.action) ||
    !record(v.payload)
  )
    throw new ProjectError("BAD_REQUEST");
  const action = v.action as ProjectRequest["action"];
  const noProject = [
    "project_list",
    "project_inbox",
    "project_create",
    "project_invite_accept",
    "project_migrate_start",
  ];
  if (!noProject.includes(action) && !projectIdValid(v.workspaceId))
    throw new ProjectError("BAD_REQUEST", "缺少项目身份");
  if (v.workspaceId !== undefined && !projectIdValid(v.workspaceId)) throw new ProjectError("BAD_REQUEST");
  const fields = PROJECT_ACTION_FIELDS[action].split(" ").filter(Boolean);
  exact(
    v.payload,
    fields.map((f) => f.replace(/\?$/, "")),
  );
  for (const field of fields) {
    const key = field.replace(/\?$/, "");
    const x = v.payload[key];
    if (x === undefined) {
      if (!field.endsWith("?")) throw new ProjectError("BAD_REQUEST", `缺少字段 ${key}`);
      continue;
    }
    if (
      ["operationId", "inviteId", "chatId", "runId", "proposalId", "migrationId"].includes(key) &&
      (typeof x !== "string" || !uuid.test(x))
    )
      throw new ProjectError("BAD_REQUEST", `${key} 不合法`);
    if (
      /^(expected|after|lastRead)|^(limit|revision)$/.test(key) &&
      (!Number.isSafeInteger(x) || Number(x) < 0 || (key === "limit" && (Number(x) < 1 || Number(x) > 500)))
    )
      throw new ProjectError("BAD_REQUEST", `${key} 不合法`);
    if (
      ["title", "text", "targetTenantId", "modelId", "cursor", "personalWorkspaceId", "sourceMode"].includes(key) &&
      (typeof x !== "string" || x.length > (key === "text" ? 32000 : 4096))
    )
      throw new ProjectError("BAD_REQUEST", `${key} 不合法`);
    if (key === "title" && (typeof x !== "string" || !x.trim() || Array.from(x.trim()).length > 80))
      throw new ProjectError("BAD_REQUEST", "标题为 1–80 字");
    if (key === "role" && !PROJECT_ROLES.includes(x as never)) throw new ProjectError("BAD_REQUEST", "角色不合法");
    if (["pinned", "runAgent"].includes(key) && typeof x !== "boolean") throw new ProjectError("BAD_REQUEST");
    if (key === "text" && typeof x === "string" && new TextEncoder().encode(x).length > 32000)
      throw new ProjectError("LIMIT_EXCEEDED", "文本超过单条消息上限");
    if (key === "path") projectPath(x);
    if (key === "prefix") projectPath(x, true);
    if (key === "patch" && !record(x)) throw new ProjectError("BAD_REQUEST");
    if (key === "changes" && (!Array.isArray(x) || !x.length || x.length > 100)) throw new ProjectError("BAD_REQUEST");
  }
  return v as ProjectRequest;
}
