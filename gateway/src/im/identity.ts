import type { ImAuthor } from "../../../shared/protocol.ts";

/** Actor id 只由稳定所有者身份派生，不引用可变的显示名或目录 key。 */
export const assistantActorId = (ownerTenantId: string) => `actor:assistant:${ownerTenantId}`;
export const workspaceActorId = (workspaceId: string) => `actor:workspace:${workspaceId}`;

export function senderKey(author: ImAuthor): string {
  return author.kind === "tenant" ? `tenant:${author.tenantId}` : `actor:${author.actorId}`;
}

/** Actor 消息对所有真人成员都算 incoming。 */
export function isOwnMessage(author: ImAuthor, member: string): boolean {
  return author.kind === "tenant" && author.tenantId === member;
}
