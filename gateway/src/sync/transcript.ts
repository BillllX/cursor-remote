// 运行中正文（transcript）的定时落盘、断线补快照与上传保护
import type { WebSocket } from "ws";
import { assistantName } from "../assistant/service.ts";
import {
  clipSnapshot,
  diskSnapshot,
  markFromTranscript,
  mergeUploadedTurns,
  readRunMark,
  snapshotMessage,
  upsertTranscriptTurn,
} from "../runlog.ts";
import { chatIdOf, isAssistantChat } from "../runtime/chats.ts";
import { persistTenant } from "../runtime/slots.ts";
import { conns, liveSlotsOf } from "../runtime/state.ts";
import type { Slot } from "../runtime/types.ts";
import { getTenant, type Tenant } from "../tenants.ts";
import { mirrorRun, queuedRows, send } from "../ws/send.ts";
import { broadcastDigest, MAX_STORED_CHATS, mergeAndCompactChat } from "./storedState.ts";

export function stopRunFlush(slot: Slot) {
  if (!slot.runFlush) return;
  clearTimeout(slot.runFlush);
  slot.runFlush = undefined;
}

function armRunFlush(slot: Slot) {
  stopRunFlush(slot);
  slot.runFlush = setTimeout(() => {
    slot.runFlush = undefined;
    const transcript = slot.transcript;
    if (!transcript || transcript.epoch !== slot.epoch || transcript.phase !== "running") return;
    flushTranscript(slot, false);
    if (slot.transcript?.phase === "running" && slot.transcript.epoch === slot.epoch) armRunFlush(slot);
  }, 3_000);
}

export function openTranscript(
  slot: Slot,
  turnId: string | undefined,
  userText: string,
  epoch: number,
  images?: Array<{ data: string; mimeType: string }>,
) {
  slot.transcript = {
    turnId: turnId?.trim() || crypto.randomUUID(),
    userText,
    images: images?.length ? images : undefined,
    assistant: "",
    thinking: "",
    tools: [],
    phase: "running",
    epoch,
    startedAt: Date.now(),
  };
  slot.turnBase = undefined;
  armRunFlush(slot);
  mirrorRun(slot, true);
}

export function continueTranscript(slot: Slot, epoch: number) {
  if (!slot.transcript) return;
  slot.transcript.epoch = epoch;
  slot.transcript.phase = "running";
  slot.transcript.awaitingApproval = undefined;
  slot.transcript.status = undefined;
  armRunFlush(slot);
}

export function flushTranscript(slot: Slot, broadcast: boolean) {
  const tenant = getTenant(slot.tenantId);
  const transcript = slot.transcript;
  if (!tenant || !transcript) return;
  if (transcript.epoch !== slot.epoch) return;
  if (tenant.disk.deletedIds.includes(slot.chatId)) return;
  const mark = markFromTranscript(transcript);
  let chat = tenant.disk.chats.find((item) => chatIdOf(item) === slot.chatId);
  if (!chat) {
    if (tenant.disk.chats.length >= MAX_STORED_CHATS) return;
    chat = { id: slot.chatId, title: "新对话", turns: [], cwd: slot.cwd };
    tenant.disk.chats = [...tenant.disk.chats, chat];
  }
  if (!chat || typeof chat !== "object") return;
  const row = chat as Record<string, unknown>;
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const stamped = {
    ...row,
    turns: upsertTranscriptTurn(turns, transcript),
    runMark: mark,
  };
  // transcript 里的工具没有保留标记，也可能带着未截断的正文
  const next = mergeAndCompactChat(chat, stamped);
  tenant.disk.chats = tenant.disk.chats.map((item) => (item === chat ? next : item));
  if (broadcast && transcript.phase === "done") {
    tenant.disk.rev += 1;
    tenant.disk.chatRevs[slot.chatId] = tenant.disk.rev;
  }
  persistTenant(tenant);
  if (broadcast && transcript.phase === "done") {
    broadcastDigest(tenant);
  }
}

export function emitRunSnapshots(ws: WebSocket, tenant: Tenant) {
  const limit = conns.get(ws)?.maxMessageBytes ?? 0;
  const covered = new Set<string>();
  for (const slot of liveSlotsOf(tenant).values()) {
    if (slot.transcript && slot.transcript.epoch === slot.epoch) {
      covered.add(slot.chatId);
      const queued = queuedRows(slot);
      const full = snapshotMessage(slot.chatId, slot.transcript, queued);
      const clipped = clipSnapshot(full, limit);
      if (clipped.type === "run_snapshot" && clipped.clipped) flushTranscript(slot, false);
      send(ws, clipped);
      continue;
    }
    if (!slot.pending.length) continue;
    covered.add(slot.chatId);
    send(ws, {
      type: "run_snapshot",
      chatId: slot.chatId,
      phase: "done",
      userText: "",
      assistant: "",
      queued: queuedRows(slot),
    });
  }
  for (const chat of tenant.disk.chats) {
    const id = chatIdOf(chat);
    const mark = readRunMark(chat);
    if (!id || !mark || covered.has(id)) continue;
    const turns =
      chat && typeof chat === "object" && Array.isArray((chat as { turns?: unknown }).turns)
        ? (chat as { turns: unknown[] }).turns
        : [];
    const full = diskSnapshot(id, mark, turns, mark.phase === "running");
    send(ws, clipSnapshot(full, limit));
  }
}

export function protectChatUpload(tenant: Tenant, chatId: string, incoming: unknown, turnsProvided: boolean): unknown {
  if (!incoming || typeof incoming !== "object") return incoming;
  const prev = tenant.disk.chats.find((item) => chatIdOf(item) === chatId);
  const slot = liveSlotsOf(tenant).get(chatId);
  const transcript = slot?.transcript && slot.transcript.epoch === slot.epoch ? slot.transcript : null;
  let baseTurns: unknown[] =
    prev && typeof prev === "object" && Array.isArray((prev as { turns?: unknown }).turns)
      ? (prev as { turns: unknown[] }).turns
      : [];
  if (transcript) baseTurns = upsertTranscriptTurn(baseTurns, transcript);
  const mark = transcript ? markFromTranscript(transcript) : readRunMark(prev);
  const row = { ...(incoming as Record<string, unknown>) };
  if (isAssistantChat(tenant, chatId)) {
    row.title = assistantName(tenant);
    row.assistant = true;
  }
  if (!turnsProvided) {
    if (baseTurns.length || mark) row.turns = baseTurns;
    if (mark) row.runMark = mark;
    return row;
  }
  const incomingTurns = Array.isArray(row.turns) ? row.turns : [];
  const merged = mergeUploadedTurns(baseTurns, incomingTurns, mark);
  row.turns = transcript ? upsertTranscriptTurn(merged.turns, transcript) : merged.turns;
  const stillRunning = Boolean(transcript && transcript.phase === "running");
  if (merged.clearMark && !stillRunning) {
    delete row.runMark;
    if (slot?.transcript?.phase === "done") {
      stopRunFlush(slot);
      slot.transcript = undefined;
    }
  } else if (mark) {
    row.runMark = mark;
  }
  return row;
}
