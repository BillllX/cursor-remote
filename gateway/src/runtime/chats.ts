// 会话 id 与助理会话的纯函数
import { resolve } from "node:path";
import { confinedCwd, type Tenant } from "../tenants.ts";

export function chatIdOf(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

/** 每个租户唯一的个人助理会话：编号固定、工作目录固定在 USER 根目录、不能删除 */
export function assistantChatIdOf(tenant: Tenant) {
  return `assistant-${tenant.id}`;
}

export function isAssistantChat(tenant: Tenant | null | undefined, chatId: string) {
  return Boolean(tenant && chatId && chatId === assistantChatIdOf(tenant));
}

export function assistantCwd(tenant: Tenant) {
  return confinedCwd(tenant.workspaceRoot, tenant.workspaceRoot) || resolve(tenant.workspaceRoot);
}
