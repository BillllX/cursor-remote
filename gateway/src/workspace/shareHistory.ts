import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync, withFileLockSync } from "../fsAtomic.ts";
import type { Tenant } from "../tenants.ts";
import type { SharedWorkspaceAnswer, SharedWorkspaceTurn } from "../../../shared/workspaceShare.ts";
import { WorkspaceShareError, type WorkspaceSharing } from "./sharing.ts";

export type SavedSharedTurn = SharedWorkspaceTurn &
  SharedWorkspaceAnswer & { id: string; createdAt: number; threadId?: string };
export function sharedThreadId(value: unknown) {
  if (value === undefined || value === "default") return "default";
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new WorkspaceShareError("共享会话标识无效");
  return value;
}
function fileFor(actor: Tenant, workspace: string) {
  const key = createHash("sha256").update(workspace).digest("hex");
  return join(actor.stateDir, "shared-chats", `${key}.json`);
}
function read(file: string): SavedSharedTurn[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(value)) throw new Error("共享会话记录格式异常");
    return value as SavedSharedTurn[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export function sharedHistory(sharing: WorkspaceSharing, actor: Tenant, workspace: string) {
  sharing.resolveMember(actor, workspace);
  return read(fileFor(actor, workspace));
}
export function saveSharedTurn(sharing: WorkspaceSharing, actor: Tenant, workspace: string, turn: SavedSharedTurn) {
  sharing.resolveMember(actor, workspace);
  const file = fileFor(actor, workspace);
  return withFileLockSync(file, () => {
    const turns = read(file);
    if (!turns.some((item) => item.id === turn.id)) turns.push(turn);
    atomicWriteFileSync(file, JSON.stringify(turns), { mode: 0o600, fsync: true });
    return turn;
  });
}
export function updateSharedTurn(
  sharing: WorkspaceSharing,
  actor: Tenant,
  workspace: string,
  changeId: string,
  changes?: SharedWorkspaceAnswer["changes"],
) {
  sharing.resolveMember(actor, workspace);
  const file = fileFor(actor, workspace);
  withFileLockSync(file, () => {
    const turns = read(file).map((turn) =>
      turn.pending?.id === changeId ? { ...turn, pending: undefined, changes } : turn,
    );
    atomicWriteFileSync(file, JSON.stringify(turns), { mode: 0o600, fsync: true });
  });
}
