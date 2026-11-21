export const WORKSPACE_SHARE_CAP = "workspace_share_v1";
export const WORKSPACE_SHARE_ASK_CAP = "workspace_share_ask_v1";
export const WORKSPACE_SHARE_MANAGE_CAP = "workspace_share_manage_v1";
export const WORKSPACE_SHARE_EDIT_CAP = "workspace_share_edit_v1";
export const WORKSPACE_SHARE_ASK_TIMEOUT_MS = 90_000;
export type SharedWorkspace = { id: string; name: string; ownerName: string; canManage?: boolean };
export type SharePerson = { id: string; name: string };
export type SharedFileEntry = { name: string; directory: boolean };
export type WorkspaceShareAction =
  "list" | "people" | "set" | "files" | "read" | "write" | "ask" | "apply" | "cancel" | "manage";
export type WorkspaceShareRequest = {
  type: "workspace_share";
  requestId: string;
  action: WorkspaceShareAction;
  workspace?: string;
  path?: string;
  memberIds?: string[];
  managerIds?: string[];
  memberRevision?: string;
  content?: string;
  revision?: string;
  question?: string;
  section?: "skills" | "schedules" | "memory" | "management";
  operation?: "list" | "propose" | "pause" | "rename";
  parameters?: Record<string, string>;
  model?: string;
  confirmWrites?: boolean;
  changeId?: string;
  discard?: boolean;
  history?: SharedWorkspaceTurn[];
};
export type WorkspaceShareResult = {
  type: "workspace_share_result";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: "CONFLICT" | "UNAVAILABLE" | "INVALID";
};
export type WorkspaceShareChanged = { type: "workspace_share_changed" };

export type SharedWorkspaceTurn = { question: string; answer: string };
export type SharedWorkspaceChange = { path: string; kind: "create" | "write" | "mkdir"; preview: string };
export type SharedWorkspaceApplied = { applied: string[]; failed: { path: string; error: string }[] };
export type SharedWorkspaceAnswer = {
  answer: string;
  sources: string[];
  pending?: { id: string; changes: SharedWorkspaceChange[] };
  changes?: SharedWorkspaceApplied;
};
