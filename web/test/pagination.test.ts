import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ImConvRow, ImMessage } from "@shared/protocol";
import { collabReducer, emptyCollabState, type CollabRoom } from "../components/collab/collabState";
import {
  applyMemoryCenterResult,
  initialMemoryCenterData,
  registerPending,
} from "../components/assistant/memoryCenterReducer";

const makeRoom = (id: string, activityAt: number): CollabRoom =>
  ({
    kind: "group",
    convId: id,
    title: `协作群 ${id}`,
    actors: [],
    memberCount: 2,
    activityAt,
    unread: 0,
    readSeq: 0,
    maxSeq: 10,
    pin: false,
    mute: false,
    hideBefore: 0,
    ticket: { exp: 1, sig: "x" },
  }) as Extract<ImConvRow, { kind: "group" }>;

const makeMessage = (convId: string, seq: number): ImMessage => ({
  convId,
  seq,
  clientId: `c-${seq}`,
  from: "me",
  kind: "text",
  body: { text: `msg-${seq}` },
  at: seq * 1000,
});

describe("web pagination reducers", () => {
  test("collabReducer rooms 分页追加与去重保留 roomsHasMore/roomsCursor", () => {
    let state = emptyCollabState();
    state = collabReducer(state, { type: "rooms_loading" });
    assert.equal(state.roomsLoading, true);

    state = collabReducer(state, {
      type: "rooms",
      rooms: [makeRoom("grp~2", 200), makeRoom("grp~1", 100)],
      more: true,
      cursor: "c-2",
    });
    assert.equal(state.roomOrder.length, 2);
    assert.equal(state.roomsHasMore, true);
    assert.equal(state.roomsCursor, "c-2");
    assert.equal(state.roomsLoading, false);

    state = collabReducer(state, {
      type: "rooms",
      rooms: [makeRoom("grp~1", 100), makeRoom("grp~0", 50)],
      more: false,
      cursor: undefined,
    });
    assert.deepEqual(state.roomOrder, ["grp~2", "grp~1", "grp~0"]);
    assert.equal(state.roomsHasMore, false);
    assert.equal(state.roomsCursor, undefined);
  });

  test("collabReducer history 顶部翻页保留更早消息并更新 historyHasMore", () => {
    let state = emptyCollabState();
    state = collabReducer(state, {
      type: "history",
      convId: "grp~1",
      messages: [makeMessage("grp~1", 4), makeMessage("grp~1", 5)],
      more: true,
    });
    assert.equal(state.historyHasMore?.["grp~1"], true);
    assert.deepEqual(
      (state.messages["grp~1"] ?? []).map((m) => m.seq),
      [4, 5],
    );

    state = collabReducer(state, { type: "history_loading_older", convId: "grp~1" });
    assert.equal(state.historyLoadingOlder?.["grp~1"], true);

    state = collabReducer(state, {
      type: "history",
      convId: "grp~1",
      messages: [makeMessage("grp~1", 1), makeMessage("grp~1", 2), makeMessage("grp~1", 3)],
      more: false,
      before: 4,
    });
    assert.equal(state.historyHasMore?.["grp~1"], false);
    assert.equal(state.historyLoadingOlder?.["grp~1"], false);
    assert.deepEqual(
      (state.messages["grp~1"] ?? []).map((m) => m.seq),
      [1, 2, 3, 4, 5],
    );
  });

  test("memoryCenterReducer scope detail 支持 append 翻页去重", () => {
    let data = initialMemoryCenterData();
    data = registerPending(data, { reqId: "r1", kind: "scope", scopeId: "ws/a" }, { replaceSameKind: true });
    const first = applyMemoryCenterResult(data, {
      type: "assistant_result",
      reqId: "r1",
      op: "memory_center_get",
      ok: true,
      data: {
        mode: "detail",
        payloadTruncated: false,
        detail: {
          scope: {
            id: "ws/a",
            kind: "workspace_memory",
            label: "A",
            layer: "L2",
            memoryCount: 2,
            hot: 2,
            cold: 0,
            done: 0,
            expired: 0,
            pinned: 0,
            missingRefs: 0,
            ruleFileCount: 0,
            tokenBudget: 400,
            injectionSelected: 2,
            injectionSkipped: 0,
            pendingCount: 0,
          },
          items: [
            {
              id: "m1",
              kind: "workspace_memory",
              layer: "L2",
              scopeId: "ws/a",
              text: "第一条",
              refs: [],
              missingRefs: [],
              effectiveState: "hot",
              pinned: false,
              truncated: false,
              revision: "v1",
            },
          ],
          rules: [],
          diagnostics: null,
          itemsTruncated: false,
          rulesTruncated: false,
          rulesPayloadTruncated: false,
          itemsTotal: 2,
          itemsHasMore: true,
          itemsNextCursor: "1",
        },
      },
    });
    assert.ok(first);
    data = first;
    assert.equal(data.detail?.items.length, 1);
    assert.equal(data.detail?.itemsHasMore, true);

    data = registerPending(
      data,
      { reqId: "r2", kind: "scope", scopeId: "ws/a", append: true },
      { replaceSameKind: true },
    );
    const second = applyMemoryCenterResult(data, {
      type: "assistant_result",
      reqId: "r2",
      op: "memory_center_get",
      ok: true,
      data: {
        mode: "detail",
        payloadTruncated: false,
        detail: {
          scope: data.detail!.scope,
          items: [
            {
              id: "m2",
              kind: "workspace_memory",
              layer: "L2",
              scopeId: "ws/a",
              text: "第二条",
              refs: [],
              missingRefs: [],
              effectiveState: "hot",
              pinned: false,
              truncated: false,
              revision: "v2",
            },
          ],
          rules: [],
          diagnostics: null,
          itemsTruncated: false,
          rulesTruncated: false,
          rulesPayloadTruncated: false,
          itemsTotal: 2,
          itemsHasMore: false,
          itemsNextCursor: undefined,
        },
      },
    });
    assert.ok(second);
    data = second;
    assert.deepEqual(
      data.detail?.items.map((i) => i.id),
      ["m1", "m2"],
    );
    assert.equal(data.detail?.itemsHasMore, false);
  });
});
