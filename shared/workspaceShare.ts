export const WORKSPACE_SHARE_CAP = "workspace_share_v1";
export type SharedWorkspace = { id: string; name: string; ownerName: string };
export type SharePerson = { id: string; name: string };
export type SharedFileEntry = { name: string; directory: boolean };
export type WorkspaceShareAction = "list" | "people" | "set" | "files" | "read" | "write";
export type WorkspaceShareRequest = {
  type: "workspace_share";
  requestId: string;
  action: WorkspaceShareAction;
  workspace?: string;
  path?: string;
  memberIds?: string[];
  memberRevision?: string;
  content?: string;
  revision?: string;
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
