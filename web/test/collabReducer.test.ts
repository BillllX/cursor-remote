import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CollabRunState, ImConvRow, ImMessage } from "@shared/protocol";
import {
  collabActionFromServer,
  collabReducer,
  collabSnapshotKey,
  emptyCollabState,
  type CollabRoom,
} from "../components/collab/collabState";

const room = (patch: Partial<CollabRoom> = {}): CollabRoom =>
  ({
    kind: "group",
    convId: "grp~default",
    title: "小驳协作群",
    actors: [
      {
        kind: "assistant",
        actorId: "actor:assistant:me",
        ownerTenantId: "me",
        displayName: "小驳",
      },
    ],
    memberCount: 1,
    activityAt: 1,
    unread: 0,
    readSeq: 0,
    maxSeq: 0,
    pin: false,
    mute: false,
    hideBefore: 0,
    ticket: { exp: 1, sig: "x" },
    ...patch,
  }) as Extract<ImConvRow, { kind: "group" }>;

const run = (version: number, status: CollabRunState["status"] = "running"): CollabRunState => ({
  runId: "run-1",
  version,
  status,
  tasks: [
    {
      taskId: "task-1",
      version,
      workspaceId: "workspace-1",
      attempt: 1,
      attempts: [{ attempt: 1, status: version > 1 ? "succeeded" : "running", startedAt: 1 }],
      status: version > 1 ? "succeeded" : "running",
      summary: version > 1 ? "测试通过" : "正在测试",
    },
  ],
});

describe("collab reducer", () => {
  test("群列表选择默认群并保留状态语义", () => {
    const state = collabReducer(emptyCollabState(), {
      type: "rooms",
      rooms: [room({ unread: 2 })],
    });
    assert.equal(state.selectedConvId, "grp~default");
    assert.equal(state.rooms["grp~default"]?.unread, 2);
  });

  test("collab_state 只接受更高 run version，状态变化不新增消息", () => {
    let state = collabReducer(emptyCollabState(), {
      type: "state",
      convId: "grp~default",
      snapshotSeq: 2,
      runs: [run(2, "completed")],
      removedRunIds: [],
    });
    state = collabReducer(state, {
      type: "state",
      convId: "grp~default",
      snapshotSeq: 1,
      runs: [run(1)],
      removedRunIds: [],
    });
    assert.equal(state.runs["run-1"]?.version, 2);
    assert.equal(state.runs["run-1"]?.tasks[0]?.status, "succeeded");
    assert.deepEqual(state.messages, {});
  });

  test("历史和实时消息按 clientId 去重，ack 原位确认乐观消息", () => {
    const pending: ImMessage & { pending: boolean } = {
      convId: "grp~default",
      snapshotSeq: 1,
      seq: Number.MAX_SAFE_INTEGER,
      from: "me",
      author: { kind: "tenant", tenantId: "me" },
      at: 10,
      kind: "text",
      body: { text: "修复测试" },
      clientId: "client-1",
      pending: true,
    };
    let state = collabReducer(emptyCollabState(), { type: "optimistic_message", message: pending });
    state = collabReducer(state, {
      type: "ack",
      convId: "grp~default",
      snapshotSeq: 2,
      clientId: "client-1",
      seq: 3,
      at: 11,
    });
    const stored = { ...pending, seq: 3, at: 11 };
    delete stored.pending;
    state = collabReducer(state, {
      type: "history",
      convId: "grp~default",
      messages: [stored],
    });
    assert.equal(state.messages["grp~default"]?.length, 1);
    assert.equal(state.messages["grp~default"]?.[0]?.pending, undefined);
    assert.equal(state.messages["grp~default"]?.[0]?.seq, 3);
  });

  test("removedRunIds 清除重连后已删除的运行", () => {
    let state = collabReducer(emptyCollabState(), {
      type: "state",
      convId: "grp~default",
      runs: [run(1)],
      removedRunIds: [],
    });
    state = collabReducer(state, {
      type: "state",
      convId: "grp~default",
      runs: [],
      removedRunIds: ["run-1"],
    });
    assert.equal(state.runs["run-1"], undefined);
    assert.deepEqual(state.runOrder["grp~default"], []);
  });

  test("只接收 grp~ 群数据，DM 列表、历史和实时消息绝不进入协作缓存", () => {
    const dmMessage: ImMessage = {
      convId: "dm~alice~bob",
      seq: 1,
      from: "bob",
      author: { kind: "tenant", tenantId: "bob" },
      at: 1,
      kind: "text",
      body: { text: "private" },
      clientId: "dm-1",
    };
    assert.equal(collabActionFromServer({ type: "im_message", message: dmMessage, unread: 1 }), undefined);
    assert.equal(
      collabActionFromServer({
        type: "im_history",
        convId: dmMessage.convId,
        messages: [dmMessage],
        more: false,
        ticket: { exp: 1, sig: "x" },
      }),
      undefined,
    );
    const state = collabReducer(emptyCollabState(), { type: "message", message: dmMessage });
    assert.deepEqual(state.messages, {});
  });

  test("离线 snapshot key 按 tenant 隔离，hydrate 切账号不会保留上一账号群", () => {
    assert.notEqual(collabSnapshotKey("alice"), collabSnapshotKey("bob"));
    let state = collabReducer(emptyCollabState(), { type: "rooms", rooms: [room()] });
    state = collabReducer(state, {
      type: "hydrate",
      state: { rooms: { "grp~bob": room({ convId: "grp~bob", title: "Bob" }) }, roomOrder: ["grp~bob"] },
    });
    assert.equal(state.rooms["grp~default"], undefined);
    assert.equal(state.rooms["grp~bob"]?.title, "Bob");
  });

  test("默认群依赖 stable isDefault 标记，重命名后标记仍保留", () => {
    const renamed = room({ title: "重命名后的群", isDefault: true });
    const state = collabReducer(emptyCollabState(), { type: "rooms", rooms: [renamed] });
    assert.equal(state.rooms[renamed.convId]?.isDefault, true);
    assert.equal(state.rooms[renamed.convId]?.title, "重命名后的群");
  });
});
