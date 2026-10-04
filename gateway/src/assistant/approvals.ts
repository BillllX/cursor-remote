import type { AssistantApproval } from "../../../shared/protocol.ts";
import { assistantPath, clip, newId, readJson, writeJson, type TenantRef } from "./store.ts";

/**
 * 委派子会话的挂起审批。运行本身在网关内存里等作答；这里落盘的是“谁在等什么”，
 * 让任一设备、父会话和收件箱都能看到并作答，网关重启后也知道哪些审批随运行一起丢了。
 */

export type PendingApproval = AssistantApproval;

export type ApprovalOutcome = "allowed" | "denied" | "expired" | "interrupted" | "cancelled";

type ApprovalsFile = { items: PendingApproval[] };

export const APPROVAL_TTL_MS = 24 * 3_600_000;

/** 不挂在运行上的确认卡（工作区记忆提议、记忆迁移）：可以和运行审批并存，运行收尾也不摘 */
export const STANDING_TOOLS = ["workspace_memory", "work_preferences"] as const;

export function isStandingTool(tool: string) {
  return (STANDING_TOOLS as readonly string[]).includes(tool);
}

function file(ref: TenantRef) {
  return assistantPath(ref, "approvals.json");
}

function read(ref: TenantRef) {
  return readJson<ApprovalsFile>(file(ref), { items: [] });
}

export function listApprovals(ref: TenantRef) {
  return read(ref).items;
}

export function findApproval(ref: TenantRef, chatId: string, callId: string) {
  return read(ref).items.find((item) => item.chatId === chatId && item.callId === callId);
}

export function addApproval(
  ref: TenantRef,
  input: Omit<PendingApproval, "id" | "createdAt" | "expiresAt">,
  now = Date.now(),
  ttlMs = APPROVAL_TTL_MS,
) {
  const data = read(ref);
  // 同一子会话同时只会停在一项运行审批上：新的进来，旧的一定已经结束
  if (isStandingTool(input.tool)) data.items = data.items.filter((item) => item.callId !== input.callId);
  else data.items = data.items.filter((item) => item.chatId !== input.chatId || isStandingTool(item.tool));
  const item: PendingApproval = {
    ...input,
    summary: clip(input.summary, 400),
    id: newId("ap"),
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  data.items.push(item);
  writeJson(file(ref), data);
  return item;
}

/** 作答、超时或运行结束时摘掉；callId 省略时摘掉这个会话的全部运行审批（确认卡不动） */
export function settleApproval(ref: TenantRef, chatId: string, callId?: string) {
  const data = read(ref);
  const gone = data.items.filter(
    (item) => item.chatId === chatId && (callId ? item.callId === callId : !isStandingTool(item.tool)),
  );
  if (!gone.length) return [];
  data.items = data.items.filter((item) => !gone.includes(item));
  writeJson(file(ref), data);
  return gone;
}

/** 网关重启：内存里等着的运行已经没了，落盘的挂起审批全部作废 */
export function recoverApprovals(ref: TenantRef) {
  const data = read(ref);
  if (!data.items.length) return [];
  const stale = data.items;
  writeJson(file(ref), { items: [] });
  return stale;
}

const SUMMARY_KEYS = ["command", "path", "file", "file_path", "filePath", "target_file", "targetFile", "target", "uri", "url", "server", "tool", "toolName", "name"];

/** 只取路径、命令、目标这类白名单字段；参数里的文件内容、补丁一律不落盘、不广播 */
export function summarizeArgs(args: unknown) {
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
    if (parts.length >= 2) break;
  }
  if (!parts.length && Array.isArray(row.paths)) {
    parts.push(row.paths.filter((item): item is string => typeof item === "string").slice(0, 3).join("、"));
  }
  return clip(parts.join(" · "), 400);
}
