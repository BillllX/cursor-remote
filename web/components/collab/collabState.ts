import type { ActorRef, CollabRunState, ImConvRow, ImMessage, ServerMessage } from "@shared/protocol";

export type CollabConnection = "online" | "reconnecting" | "offline";
export type CollabInspectorView = "progress" | "outputs" | "members" | "task";
export type CollabDraft = { text: string; mentions: string[] };
export type CollabRoom = Extract<ImConvRow, { kind: "group" }>;
export type CollabTimelineMessage = ImMessage & { pending?: boolean };

export type CollabUiState = {
  rooms: Record<string, CollabRoom>;
  roomOrder: string[];
  messages: Record<string, CollabTimelineMessage[]>;
  historyLoading: Record<string, boolean>;
  historyLoaded: Record<string, boolean>;
  runs: Record<string, CollabRunState>;
  runOrder: Record<string, string[]>;
  drafts: Record<string, CollabDraft>;
  selectedConvId?: string;
  selectedRunId?: string;
  selectedTaskId?: string;
  inspector: CollabInspectorView;
  connection: CollabConnection;
  error?: string;
  lastSyncAt?: number;
  snapshotSeq: Record<string, number>;
};

export const emptyCollabState = (connection: CollabConnection = "offline"): CollabUiState => ({
  rooms: {},
  roomOrder: [],
  messages: {},
  historyLoading: {},
  historyLoaded: {},
  runs: {},
  runOrder: {},
  drafts: {},
  inspector: "progress",
  connection,
  snapshotSeq: {},
});

export type CollabAction =
  | { type: "connection"; connection: CollabConnection }
  | { type: "rooms"; rooms: CollabRoom[] }
  | { type: "room"; room: CollabRoom }
  | { type: "select_room"; convId?: string }
  | { type: "history_loading"; convId: string }
  | { type: "history"; convId: string; messages: ImMessage[] }
  | { type: "message"; message: ImMessage; unread?: number }
  | { type: "room_update"; convId: string; unread?: number; readSeq?: number }
  | { type: "optimistic_message"; message: CollabTimelineMessage }
  | { type: "ack"; clientId: string; convId: string; seq: number; at: number }
  | { type: "state"; convId: string; snapshotSeq: number; runs: CollabRunState[]; removedRunIds: string[] }
  | { type: "draft"; convId: string; draft: CollabDraft }
  | { type: "select_task"; runId?: string; taskId?: string }
  | { type: "inspector"; inspector: CollabInspectorView }
  | { type: "error"; error?: string }
  | { type: "hydrate"; state: Partial<CollabUiState> }
  | { type: "reset" };

export function isCollabGroupId(convId: string) {
  return convId.startsWith("grp~");
}

export function collabSnapshotKey(tenantId: string) {
  // v3 为 Run 补充 createdAt；旧缓存缺少稳定排序依据，直接隔离迁移。
  return `jiebo-collab-offline-v3:${encodeURIComponent(tenantId)}`;
}

function mergeMessages(current: CollabTimelineMessage[], incoming: CollabTimelineMessage[]): CollabTimelineMessage[] {
  const byClient = new Map<string, CollabTimelineMessage>();
  for (const row of current) byClient.set(row.clientId, row);
  for (const row of incoming) {
    const known = byClient.get(row.clientId);
    if (!known || known.pending || row.seq >= known.seq) byClient.set(row.clientId, row);
  }
  return [...byClient.values()].sort((a, b) => a.seq - b.seq || a.at - b.at);
}

function roomSort(a: CollabRoom, b: CollabRoom) {
  const attentionA = roomAttention(a);
  const attentionB = roomAttention(b);
  if (attentionA !== attentionB) return attentionB - attentionA;
  return (b.last?.at ?? b.activityAt) - (a.last?.at ?? a.activityAt);
}

export function roomAttention(room: CollabRoom) {
  return room.unread > 0 ? 1 : 0;
}

export function collabReducer(state: CollabUiState, action: CollabAction): CollabUiState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.connection };
    case "rooms": {
      const rooms = { ...state.rooms };
      for (const room of action.rooms) if (isCollabGroupId(room.convId)) rooms[room.convId] = room;
      const roomOrder = Object.values(rooms)
        .sort(roomSort)
        .map((room) => room.convId);
      return {
        ...state,
        rooms,
        roomOrder,
        selectedConvId: state.selectedConvId ?? roomOrder[0],
      };
    }
    case "room": {
      if (!isCollabGroupId(action.room.convId)) return state;
      const rooms = { ...state.rooms, [action.room.convId]: action.room };
      const roomOrder = Object.values(rooms)
        .sort(roomSort)
        .map((room) => room.convId);
      return { ...state, rooms, roomOrder, selectedConvId: action.room.convId };
    }
    case "select_room":
      return {
        ...state,
        selectedConvId: action.convId,
        selectedRunId: undefined,
        selectedTaskId: undefined,
        inspector: "progress",
      };
    case "history_loading":
      return {
        ...state,
        historyLoading: { ...state.historyLoading, [action.convId]: true },
      };
    case "history":
      if (!isCollabGroupId(action.convId)) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.convId]: mergeMessages(state.messages[action.convId] ?? [], action.messages),
        },
        historyLoading: { ...state.historyLoading, [action.convId]: false },
        historyLoaded: { ...state.historyLoaded, [action.convId]: true },
      };
    case "message": {
      const convId = action.message.convId;
      if (!isCollabGroupId(convId)) return state;
      const room = state.rooms[convId];
      const rooms = room
        ? {
            ...state.rooms,
            [convId]: {
              ...room,
              last: action.message,
              maxSeq: action.message.seq,
              unread: action.unread ?? room.unread,
            },
          }
        : state.rooms;
      return {
        ...state,
        rooms,
        messages: {
          ...state.messages,
          [convId]: mergeMessages(state.messages[convId] ?? [], [action.message]),
        },
      };
    }
    case "room_update": {
      if (!isCollabGroupId(action.convId)) return state;
      const room = state.rooms[action.convId];
      if (!room) return state;
      return {
        ...state,
        rooms: {
          ...state.rooms,
          [action.convId]: {
            ...room,
            unread: action.unread ?? room.unread,
            readSeq: action.readSeq ?? room.readSeq,
          },
        },
      };
    }
    case "optimistic_message":
      if (!isCollabGroupId(action.message.convId)) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.message.convId]: mergeMessages(state.messages[action.message.convId] ?? [], [action.message]),
        },
      };
    case "ack":
      if (!isCollabGroupId(action.convId)) return state;
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.convId]: (state.messages[action.convId] ?? []).map((row) =>
            row.clientId === action.clientId ? { ...row, seq: action.seq, at: action.at, pending: false } : row,
          ),
        },
      };
    case "state": {
      if (!isCollabGroupId(action.convId)) return state;
      if ((state.snapshotSeq[action.convId] ?? -1) > action.snapshotSeq) return state;
      const runs = { ...state.runs };
      for (const id of action.removedRunIds) delete runs[id];
      for (const run of action.runs) {
        const known = runs[run.runId];
        if (!known || run.version > known.version) runs[run.runId] = run;
        else if (run.version === known.version) {
          const tasks = new Map(known.tasks.map((task) => [task.taskId, task]));
          for (const task of run.tasks) tasks.set(task.taskId, task);
          runs[run.runId] = { ...known, tasks: [...tasks.values()] };
        }
      }
      const knownOrder = state.runOrder[action.convId] ?? [];
      const additions = action.runs.map((run) => run.runId).filter((id) => !knownOrder.includes(id));
      return {
        ...state,
        runs,
        runOrder: {
          ...state.runOrder,
          [action.convId]: [...knownOrder.filter((id) => !action.removedRunIds.includes(id)), ...additions],
        },
        lastSyncAt: Date.now(),
        snapshotSeq: { ...state.snapshotSeq, [action.convId]: action.snapshotSeq },
      };
    }
    case "draft":
      return { ...state, drafts: { ...state.drafts, [action.convId]: action.draft } };
    case "select_task":
      return {
        ...state,
        selectedRunId: action.runId,
        selectedTaskId: action.taskId,
        inspector: action.taskId ? "task" : "progress",
      };
    case "inspector":
      return { ...state, inspector: action.inspector };
    case "error":
      return { ...state, error: action.error };
    case "hydrate": {
      const rooms = Object.fromEntries(
        Object.entries(action.state.rooms ?? {}).filter(([convId]) => isCollabGroupId(convId)),
      );
      const roomOrder = (action.state.roomOrder ?? []).filter((convId) => Boolean(rooms[convId]));
      const messages = Object.fromEntries(
        Object.entries(action.state.messages ?? {}).filter(([convId]) => isCollabGroupId(convId)),
      );
      return {
        ...emptyCollabState(state.connection),
        rooms,
        roomOrder,
        messages,
        runs: action.state.runs ?? {},
        runOrder: action.state.runOrder ?? {},
        drafts: action.state.drafts ?? {},
        snapshotSeq: action.state.snapshotSeq ?? {},
        selectedConvId:
          action.state.selectedConvId && rooms[action.state.selectedConvId]
            ? action.state.selectedConvId
            : roomOrder[0],
      };
    }
    case "reset":
      return emptyCollabState(state.connection);
  }
}

export function collabActionFromServer(message: ServerMessage): CollabAction | undefined {
  switch (message.type) {
    case "im_list":
      return {
        type: "rooms",
        rooms: message.convs.filter((row): row is CollabRoom => row.kind === "group" && isCollabGroupId(row.convId)),
      };
    case "im_group_created":
      return { type: "room", room: message.conv };
    case "im_history":
      return isCollabGroupId(message.convId)
        ? { type: "history", convId: message.convId, messages: message.messages }
        : undefined;
    case "im_message":
      return isCollabGroupId(message.message.convId)
        ? { type: "message", message: message.message, unread: message.unread }
        : undefined;
    case "im_update":
      return message.convId && isCollabGroupId(message.convId)
        ? {
            type: "room_update",
            convId: message.convId,
            unread: message.unread,
            readSeq: message.what === "read" ? message.seq : undefined,
          }
        : undefined;
    case "im_ack":
      return isCollabGroupId(message.convId)
        ? {
            type: "ack",
            clientId: message.clientId,
            convId: message.convId,
            seq: message.seq,
            at: message.at,
          }
        : undefined;
    case "collab_state":
      return isCollabGroupId(message.convId)
        ? {
            type: "state",
            convId: message.convId,
            snapshotSeq: message.snapshotSeq,
            runs: message.runs,
            removedRunIds: message.removedRunIds,
          }
        : undefined;
    case "im_error":
      return { type: "error", error: message.message };
    case "collab_result":
      return message.ok ? { type: "error", error: undefined } : { type: "error", error: message.error };
    default:
      return undefined;
  }
}

export function roomActors(room?: CollabRoom): ActorRef[] {
  return room?.actors ?? [];
}
