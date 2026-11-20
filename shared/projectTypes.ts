/** 共享项目使用独立身份和消息命名空间，不能作为个人 cwd 使用。 */
export const PROJECT_CAP = "shared_workspaces_v1";
export const PROJECT_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type ProjectState = "creating" | "active" | "archived" | "deleting" | "deleted" | "recovering";
export type ProjectPrincipal = {
  id: string;
  sharingEnabled: boolean;
  sharingDomain: string | null;
  sandboxVerified: boolean;
};
export type ProjectSummary = {
  workspaceId: string;
  title: string;
  ownerTenantId: string;
  role: ProjectRole;
  state: ProjectState;
  revision: number;
  authzRevision: number;
  configRevision: number;
  eventSeq: number;
};
export type ProjectEntry = { path: string; kind: "file" | "dir"; blobHash?: string; size?: number };
export type ProjectErrorCode =
  | "BAD_REQUEST"
  | "CAP_REQUIRED"
  | "NOT_ACCESSIBLE"
  | "FORBIDDEN"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "INVITE_EXPIRED"
  | "PROJECT_UNAVAILABLE"
  | "ENGINE_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "RESYNC_REQUIRED"
  | "STORAGE_CORRUPT"
  | "INTERNAL";
export const PROJECT_ACTION_FIELDS = {
  project_list: "cursor? limit?",
  project_inbox: "cursor? limit?",
  project_create: "operationId title",
  project_invite: "operationId targetTenantId role",
  project_invite_accept: "operationId inviteId",
  project_invite_revoke: "operationId inviteId",
  project_snapshot: "",
  project_subscribe: "afterEventSeq",
  project_unsubscribe: "",
  project_event_read: "afterEventSeq limit?",
  project_tree: "prefix? cursor? limit? revision?",
  project_file_read: "path revision?",
  project_commit: "operationId expectedRevision changes",
  project_members: "cursor? limit?",
  project_member_set: "operationId targetTenantId role expectedMemberRevision",
  project_member_remove: "operationId targetTenantId expectedMemberRevision",
  project_leave: "operationId",
  project_chat_create: "operationId title",
  project_chat_read: "chatId afterMessageSeq? limit?",
  project_message_send: "operationId chatId text runAgent modelId?",
  project_read_set: "operationId chatId lastReadMessageSeq",
  project_pin_set: "operationId chatId pinned",
  project_run_cancel: "operationId runId",
  project_run_apply: "operationId runId expectedRevision",
  project_config_set: "operationId expectedConfigRevision patch",
  project_rules_propose: "operationId text",
  project_rules_approve: "operationId proposalId expectedConfigRevision",
  project_archive: "operationId",
  project_restore: "operationId",
  project_delete: "operationId",
  project_export: "operationId revision?",
  project_migrate_start: "operationId personalWorkspaceId sourceMode",
  project_migrate_status: "migrationId",
} as const;
export type ProjectAction = keyof typeof PROJECT_ACTION_FIELDS;
export type ProjectRequest = {
  type: "project_request";
  protocol: 1;
  requestId: string;
  action: ProjectAction;
  workspaceId?: string;
  payload: Record<string, unknown>;
};
export type ProjectResult =
  | { type: "project_result"; requestId: string; ok: true; data: unknown }
  | {
      type: "project_result";
      requestId: string;
      ok: false;
      error: { code: ProjectErrorCode; message: string; currentRevision?: number; changedPaths?: string[] };
    };
export type ProjectEvent = {
  type: "project_event";
  workspaceId: string;
  eventSeq: number;
  kind: string;
  revision: number;
  authzRevision: number;
  payload: unknown;
};
export type ProjectNotice =
  { type: "project_access_revoked"; workspaceId: string } | { type: "project_summary_changed"; workspaceId: string };

export class ProjectError extends Error {
  constructor(
    public code: ProjectErrorCode,
    message: string = code,
    public currentRevision?: number,
    public changedPaths?: string[],
  ) {
    super(message);
  }
}
export const PROJECT_LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  entries: 10000,
  currentBytes: 1024 ** 3,
  historyBytes: 5 * 1024 ** 3,
  changes: 100,
  uploadTtl: 30 * 60000,
  eventPage: 100,
  eventBytes: 65536,
} as const;
