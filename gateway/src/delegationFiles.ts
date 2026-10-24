import type { TurnFile } from "../../shared/protocol.ts";
import { getDelegation } from "./assistant/delegations.ts";
import { chatIdOf } from "./runtime/chats.ts";
import { liveSlotsOf } from "./runtime/state.ts";
import type { Slot } from "./runtime/types.ts";
import { turnIdOf } from "./runlog.ts";
import { broadcastDigest } from "./sync/storedState.ts";
import { persistTenant } from "./runtime/slots.ts";
import type { Tenant } from "./tenants.ts";
import { MAX_TURN_FILES } from "./turnFiles.ts";

function fileKey(file: TurnFile) {
  return file.sourceChatId
    ? `delegated:${file.sourceChatId}\0${file.sourceTurnId || ""}\0${file.path}`
    : `local:${file.path}`;
}

/** 同一来源子回合、同一路径只保留最后一份；本地文件与委派文件互不覆盖。 */
export function mergeTurnFiles(base: TurnFile[], incoming: TurnFile[]): TurnFile[] {
  const out = base.slice();
  const indexes = new Map(out.map((file, index) => [fileKey(file), index]));
  for (const file of incoming) {
    const key = fileKey(file);
    const at = indexes.get(key);
    if (at == null) {
      indexes.set(key, out.length);
      out.push(file);
    } else {
      out[at] = file;
    }
  }
  if (out.length <= MAX_TURN_FILES) return out;
  // 委派交付物是父会话里唯一能发现子工作区产物的入口，超限时优先保住它们。
  const incomingKeys = new Set(incoming.map(fileKey));
  return [
    ...out.filter((file) => incomingKeys.has(fileKey(file))),
    ...out.filter((file) => !incomingKeys.has(fileKey(file))),
  ].slice(0, MAX_TURN_FILES);
}

function sameFiles(a: TurnFile[], b: TurnFile[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 子委派完成后把快照引用挂回发起委派的父 turn。
 * 返回值只在内容首次变化时存在，调用方据此广播 turn_files。
 */
export function attachDelegatedFiles(
  tenant: Tenant,
  childSlot: Slot,
  childTurnId: string,
  files: TurnFile[],
): { chatId: string; turnId: string; files: TurnFile[] } | null {
  if (!files.length || !childSlot.delegationId || !childTurnId) return null;
  const delegation = getDelegation(tenant, childSlot.delegationId);
  if (delegation?.notifyPolicy === "collab_only") return null;
  const chatId = delegation?.parentChatId || "";
  const turnId = delegation?.parentTurnId || "";
  if (!chatId || !turnId) return null;
  const delegated = files.map((file) =>
    file.sourceChatId
      ? file
      : {
          ...file,
          sourceChatId: childSlot.chatId,
          sourceTurnId: childTurnId,
        },
  );

  let changed = false;
  let merged: TurnFile[] | undefined;
  const parentSlot = liveSlotsOf(tenant).get(chatId);
  if (parentSlot?.transcript?.turnId === turnId) {
    const previous = parentSlot.transcript.files || [];
    const next = mergeTurnFiles(previous, delegated);
    if (!sameFiles(previous, next)) {
      parentSlot.transcript.files = next;
      changed = true;
    }
    merged = next;
  }

  const chatAt = tenant.disk.chats.findIndex((chat) => chatIdOf(chat) === chatId);
  const chat = chatAt >= 0 ? tenant.disk.chats[chatAt] : undefined;
  if (chat && typeof chat === "object") {
    const row = chat as Record<string, unknown>;
    const turns = Array.isArray(row.turns) ? row.turns : [];
    const turnAt = turns.findIndex((turn) => turnIdOf(turn) === turnId);
    const turn = turnAt >= 0 ? turns[turnAt] : undefined;
    if (turn && typeof turn === "object") {
      const previous = Array.isArray((turn as { files?: unknown }).files) ? (turn as { files: TurnFile[] }).files : [];
      const next = mergeTurnFiles(previous, delegated);
      merged = next;
      if (!sameFiles(previous, next)) {
        const nextTurns = turns.slice();
        nextTurns[turnAt] = { ...(turn as Record<string, unknown>), files: next };
        const chats = tenant.disk.chats.slice();
        chats[chatAt] = { ...row, turns: nextTurns };
        tenant.disk.chats = chats;
        tenant.disk.rev += 1;
        tenant.disk.chatRevs[chatId] = tenant.disk.rev;
        persistTenant(tenant);
        broadcastDigest(tenant);
        changed = true;
      }
    }
  }
  return changed && merged ? { chatId, turnId, files: merged } : null;
}
