"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ClientMessage, ServerMessage } from "@shared/protocol";
import {
  collabActionFromServer,
  collabSnapshotKey,
  collabReducer,
  emptyCollabState,
  type CollabDraft,
  type CollabUiState,
} from "./collabState";
import { pushCollabRoute, readCollabRoute, replaceCollabRoute } from "./collabNavigation";

const DEFAULT_ROOM_TITLE = "小驳协作群";
const DRAFT_PREFIX = "jiebo-collab-draft:";

type Send = (message: ClientMessage) => void;

export function useCollabState({
  active,
  connected,
  unlocked,
  send,
  onDomainChange,
}: {
  active: boolean;
  connected: boolean;
  unlocked: boolean;
  send: Send;
  onDomainChange: (active: boolean) => void;
}) {
  const initialRoute = useRef(
    typeof window === "undefined" ? { active: false } : readCollabRoute(window.location.search),
  );
  const [state, dispatch] = useReducer(
    collabReducer,
    emptyCollabState(connected ? "online" : "offline"),
    (base): CollabUiState => ({
      ...base,
      selectedConvId: initialRoute.current.convId,
      selectedRunId: initialRoute.current.runId,
      selectedTaskId: initialRoute.current.taskId,
      inspector: initialRoute.current.taskId ? "task" : "progress",
    }),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const createRequestedRef = useRef(false);
  const tenantIdRef = useRef("");

  const syncRoom = useCallback(
    (convId: string, cursor?: string) => {
      const known = (stateRef.current.runOrder[convId] ?? [])
        .map((runId) => stateRef.current.runs[runId])
        .filter(Boolean)
        .map((run) => ({ runId: run.runId, version: run.version }));
      send({ type: "collab_sync", convId, known, cursor });
    },
    [send],
  );

  const handleServer = useCallback(
    (message: ServerMessage) => {
      if (message.type === "ready") {
        const tenantId = message.tenantId || "";
        if (tenantId && tenantId !== tenantIdRef.current) {
          tenantIdRef.current = tenantId;
          createRequestedRef.current = false;
          try {
            const cached = JSON.parse(
              localStorage.getItem(collabSnapshotKey(tenantId)) || "null",
            ) as Partial<CollabUiState> | null;
            dispatch({ type: "hydrate", state: cached ?? {} });
          } catch {
            dispatch({ type: "reset" });
          }
          if (initialRoute.current.convId) {
            dispatch({ type: "select_room", convId: initialRoute.current.convId });
          }
          if (initialRoute.current.taskId) {
            dispatch({
              type: "select_task",
              runId: initialRoute.current.runId,
              taskId: initialRoute.current.taskId,
            });
          }
        }
      }
      if (message.type === "auth" && !message.ok) {
        if (tenantIdRef.current) localStorage.removeItem(collabSnapshotKey(tenantIdRef.current));
        tenantIdRef.current = "";
        dispatch({ type: "reset" });
      }
      const action = collabActionFromServer(message);
      if (action) dispatch(action);
      if (message.type === "collab_state" && message.more && message.cursor) {
        syncRoom(message.convId, message.cursor);
      }
      if (message.type === "im_list") {
        const rooms = message.convs.filter((row) => row.kind === "group");
        if (!rooms.some((room) => room.isDefault) && !createRequestedRef.current) {
          createRequestedRef.current = true;
          send({ type: "im_group_create", title: DEFAULT_ROOM_TITLE, isDefault: true });
        }
      }
    },
    [send, syncRoom],
  );

  useEffect(() => {
    const tenantId = tenantIdRef.current;
    if (!tenantId) return;
    try {
      const messages = Object.fromEntries(
        Object.entries(state.messages).map(([convId, rows]) => [convId, rows.slice(-100)]),
      );
      localStorage.setItem(
        collabSnapshotKey(tenantId),
        JSON.stringify({
          rooms: state.rooms,
          roomOrder: state.roomOrder,
          messages,
          runs: state.runs,
          runOrder: state.runOrder,
          drafts: state.drafts,
          snapshotSeq: state.snapshotSeq,
          selectedConvId: state.selectedConvId,
        }),
      );
    } catch {
      // 配额或隐私模式下退化为内存状态。
    }
  }, [
    state.drafts,
    state.messages,
    state.roomOrder,
    state.rooms,
    state.runOrder,
    state.runs,
    state.selectedConvId,
    state.snapshotSeq,
  ]);

  useEffect(() => {
    dispatch({
      type: "connection",
      connection: connected && unlocked ? "online" : unlocked ? "reconnecting" : "offline",
    });
    if (!active || !connected || !unlocked) return;
    send({ type: "im_list", limit: 100 });
    const convId = stateRef.current.selectedConvId;
    if (convId) syncRoom(convId);
  }, [active, connected, send, syncRoom, unlocked]);

  useEffect(() => {
    if (!active || !connected || !unlocked || !state.selectedConvId) return;
    const convId = state.selectedConvId;
    if (!state.historyLoaded[convId] && !state.historyLoading[convId]) {
      dispatch({ type: "history_loading", convId });
      send({ type: "im_history", convId, limit: 50 });
    }
    syncRoom(convId);
    const room = state.rooms[convId];
    if (room?.maxSeq && room.readSeq < room.maxSeq) {
      send({ type: "im_read", convId, seq: room.maxSeq });
    }
  }, [
    active,
    connected,
    send,
    state.historyLoaded,
    state.historyLoading,
    state.rooms,
    state.selectedConvId,
    syncRoom,
    unlocked,
  ]);

  useEffect(() => {
    const onPopState = () => {
      const route = readCollabRoute(window.location.search);
      onDomainChange(route.active);
      dispatch({ type: "select_room", convId: route.convId });
      if (route.taskId) {
        dispatch({ type: "select_task", runId: route.runId, taskId: route.taskId });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onDomainChange]);

  useEffect(() => {
    if (!active) return;
    replaceCollabRoute({
      active: true,
      convId: state.selectedConvId,
      runId: state.selectedRunId,
      taskId: state.selectedTaskId,
    });
  }, [active, state.selectedConvId, state.selectedRunId, state.selectedTaskId]);

  useEffect(() => {
    const convId = state.selectedConvId;
    if (!convId || state.drafts[convId]) return;
    try {
      const saved = JSON.parse(
        localStorage.getItem(`${DRAFT_PREFIX}${encodeURIComponent(tenantIdRef.current)}:${convId}`) || "null",
      ) as CollabDraft | null;
      if (saved && typeof saved.text === "string" && Array.isArray(saved.mentions)) {
        dispatch({ type: "draft", convId, draft: saved });
      }
    } catch {
      // 坏草稿不阻塞协作页面。
    }
  }, [state.drafts, state.selectedConvId]);

  const selectRoom = useCallback((convId: string) => {
    pushCollabRoute({ active: true, convId });
    dispatch({ type: "select_room", convId });
  }, []);

  const selectTask = useCallback((runId?: string, taskId?: string) => {
    pushCollabRoute({
      active: true,
      convId: stateRef.current.selectedConvId,
      runId,
      taskId,
    });
    dispatch({ type: "select_task", runId, taskId });
  }, []);

  const updateDraft = useCallback((convId: string, draft: CollabDraft) => {
    dispatch({ type: "draft", convId, draft });
    try {
      localStorage.setItem(
        `${DRAFT_PREFIX}${encodeURIComponent(tenantIdRef.current)}:${convId}`,
        JSON.stringify(draft),
      );
    } catch {
      // 浏览器禁止存储时仍保留当前会话内草稿。
    }
  }, []);

  const sendMessage = useCallback(
    (convId: string) => {
      const draft = stateRef.current.drafts[convId];
      const text = draft?.text.trim() ?? "";
      if (!text || !connected || !unlocked) return;
      const clientId = crypto.randomUUID();
      dispatch({
        type: "optimistic_message",
        message: {
          convId,
          seq: Number.MAX_SAFE_INTEGER,
          from: tenantIdRef.current || "me",
          author: { kind: "tenant", tenantId: tenantIdRef.current || "me" },
          at: Date.now(),
          kind: "text",
          body: { text },
          clientId,
          pending: true,
        },
      });
      send({
        type: "im_send",
        convId,
        clientId,
        kind: "text",
        body: { text },
        mentions: (draft?.mentions ?? []).map((actorId) => ({ actorId })),
      });
      updateDraft(convId, { text: "", mentions: draft?.mentions ?? [] });
    },
    [connected, send, unlocked, updateDraft],
  );

  const operate = useCallback(
    (
      convId: string,
      op: "cancel_run" | "cancel_task" | "retry_task" | "retry_publish" | "answer_approval",
      runId?: string,
      taskId?: string,
      allow?: boolean,
    ) => {
      if (!connected || !unlocked) return;
      send({
        type: "collab_op",
        convId,
        requestId: crypto.randomUUID(),
        op,
        runId,
        taskId,
        allow,
      });
    },
    [connected, send, unlocked],
  );

  const createGroup = useCallback(
    (title: string, actorIds: string[]) => {
      if (connected && unlocked) send({ type: "im_group_create", title, actorIds });
    },
    [connected, send, unlocked],
  );

  const updateGroup = useCallback(
    (convId: string, patch: { title?: string; actorIds?: string[]; archived?: boolean }) => {
      if (connected && unlocked) send({ type: "im_group_update", convId, ...patch });
    },
    [connected, send, unlocked],
  );

  return {
    state,
    dispatch,
    handleServer,
    selectRoom,
    selectTask,
    updateDraft,
    sendMessage,
    operate,
    createGroup,
    updateGroup,
  };
}
