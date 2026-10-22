import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantState, ServerMessage } from "@shared/protocol";
import { serverSamples } from "@shared/protocol-fixtures";
import {
  appendDraftMention,
  applyAssistantMessage,
  applyLoopMessage,
  applyReadyRuns,
  applyServerMessage,
  applySession,
  chatsToFlush,
  commitSync,
  loopsFromReady,
  markUnread,
  patchOpenTurnIn,
  patchRunningTurnIn,
  serverChatId,
  type LoopRow,
} from "../lib/chat/reducer";
import type { Chat, ToolCall, Turn } from "../lib/chat/types";

type Msg<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

const CHAT = "c-7f3a9e21";
const ctx = { activeId: CHAT };

/** 取协议金样本（深拷贝，改字段不污染共享样本） */
function sample<T extends ServerMessage["type"]>(type: T, pick: (msg: Msg<T>) => boolean = () => true): Msg<T> {
  const found = serverSamples.find((msg): msg is Msg<T> => msg.type === type && pick(msg as Msg<T>));
  assert.ok(found, `缺少 ${type} 金样本`);
  return structuredClone(found);
}

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({ callId: "c1", name: "shell", status: "running", ...over });
const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "t1",
  user: "hi",
  assistant: "",
  thinking: "",
  tools: [],
  running: false,
  ...over,
});
const chat = (over: Partial<Chat> = {}): Chat => ({ id: CHAT, title: "新对话", turns: [], ...over });
const runningChats = (over: Partial<Turn> = {}): Chat[] => [
  chat({ turns: [turn({ id: "t0", assistant: "旧", running: false }), turn({ running: true, ...over })] }),
  chat({ id: "other", turns: [turn({ id: "o1", running: true })] }),
];
const lastTurn = (chats: Chat[], id = CHAT) => {
  const turns = chats.find((item) => item.id === id)!.turns;
  return turns[turns.length - 1];
};

describe("serverChatId", () => {
  test("消息带 chatId 用消息的，没带用当前会话", () => {
    assert.equal(serverChatId(sample("text-delta"), "x"), CHAT);
    assert.equal(
      serverChatId(
        sample("status", (msg) => !msg.chatId),
        "x",
      ),
      "x",
    );
  });
});

describe("patchRunningTurnIn / patchOpenTurnIn", () => {
  test("updater 原样返回时沿用原数组", () => {
    const chats = runningChats();
    assert.equal(
      patchRunningTurnIn(chats, CHAT, (item) => item),
      chats,
    );
    assert.equal(
      patchOpenTurnIn(chats, CHAT, (item) => item),
      chats,
    );
  });

  test("只改目标会话的最后一个 running 回合，别的会话保持原引用", () => {
    const chats = runningChats();
    const next = patchRunningTurnIn(chats, CHAT, (item) => ({ ...item, task: "x" }));
    assert.notEqual(next, chats);
    assert.equal(lastTurn(next).task, "x");
    assert.equal(next[0].turns[0], chats[0].turns[0]);
    assert.equal(next[1], chats[1]);
  });

  test("patchOpenTurnIn 也认还有未结束工具、但已不 running 的回合", () => {
    const chats = [chat({ turns: [turn({ tools: [tool()] })] })];
    const next = patchOpenTurnIn(chats, CHAT, (item) => ({ ...item, error: "x" }));
    assert.equal(lastTurn(next).error, "x");
  });
});

describe("applyServerMessage", () => {
  test("未知消息类型、未知 chatId 都返回同一引用", () => {
    const chats = runningChats();
    assert.equal(applyServerMessage(chats, sample("pong"), ctx), chats);
    assert.equal(applyServerMessage(chats, { ...sample("text-delta"), chatId: "nope" }, ctx), chats);
    assert.equal(applyServerMessage(chats, { ...sample("done"), chatId: "nope" }, ctx), chats);
    assert.equal(applyServerMessage(chats, { ...sample("checkpoints"), chatId: "nope" }, ctx), chats);
  });

  test("text-delta：追加到 running 回合；重复消息就重复追加（网关不去重）", () => {
    const msg = sample("text-delta");
    const once = applyServerMessage(runningChats({ assistant: "前" }), msg, ctx);
    assert.equal(lastTurn(once).assistant, `前${msg.text}`);
    const twice = applyServerMessage(once, msg, ctx);
    assert.equal(lastTurn(twice).assistant, `前${msg.text}${msg.text}`);
    assert.equal(twice[0].turns[0].assistant, "旧");
  });

  test("text-delta：回合结束后才到的迟到增量不改状态", () => {
    const chats = [chat({ turns: [turn({ assistant: "完" })] })];
    assert.equal(applyServerMessage(chats, sample("text-delta"), ctx), chats);
  });

  test("text-delta 不带 chatId 时记到 activeId", () => {
    const { chatId: _drop, ...msg } = sample("text-delta");
    const next = applyServerMessage(runningChats(), msg as ServerMessage, { activeId: "other" });
    assert.equal(lastTurn(next, "other").assistant, msg.text);
    assert.equal(lastTurn(next).assistant, "");
  });

  test("thinking-delta：追加到 thinking", () => {
    const msg = sample("thinking-delta");
    const next = applyServerMessage(runningChats({ thinking: "a" }), msg, ctx);
    assert.equal(lastTurn(next).thinking, `a${msg.text}`);
    assert.equal(lastTurn(next).assistant, "");
  });

  test("tool-started：新增工具；同 callId 重复开始只留一条", () => {
    const msg = sample("tool-started");
    const once = applyServerMessage(runningChats(), msg, ctx);
    assert.deepEqual(lastTurn(once).tools, [
      {
        callId: msg.callId,
        name: msg.name,
        args: msg.args,
        status: "running",
        parentCallId: msg.parentCallId,
        agent: msg.agent,
        model: msg.model,
      },
    ]);
    const twice = applyServerMessage(once, msg, ctx);
    assert.equal(lastTurn(twice).tools.length, 1);
  });

  test("tool-started：todo 工具顺带更新回合待办", () => {
    const msg = {
      ...sample("tool-started"),
      name: "todo_write",
      args: { todos: [{ id: "a", content: "写测试", status: "pending" }] },
    };
    const next = applyServerMessage(runningChats(), msg, ctx);
    assert.deepEqual(lastTurn(next).todos, [{ id: "a", content: "写测试", status: "pending" }]);
  });

  test("tool-completed：合并开始时的 args / review，结束状态以完成消息为准", () => {
    const msg = sample("tool-completed");
    const started = tool({ callId: msg.callId, name: msg.name, args: { path: "a" }, review: "accepted" });
    const next = applyServerMessage(runningChats({ tools: [started] }), msg, ctx);
    const done = lastTurn(next).tools[0];
    assert.equal(done.status, msg.status);
    assert.deepEqual(done.args, { path: "a" });
    assert.equal(done.review, "accepted");
    assert.deepEqual(done.result, msg.result);
  });

  test("tool-completed：没见过开始（乱序）也补一条", () => {
    const msg = sample("tool-completed");
    const next = applyServerMessage(runningChats(), msg, ctx);
    assert.equal(lastTurn(next).tools.length, 1);
    assert.equal(lastTurn(next).tools[0].callId, msg.callId);
  });

  test("tool-completed：已标 error 的工具不被迟到的 completed 覆盖，返回同一引用", () => {
    const msg = { ...sample("tool-completed"), status: "completed" as const };
    const chats = runningChats({ tools: [tool({ callId: msg.callId, status: "error" })] });
    assert.equal(applyServerMessage(chats, msg, ctx), chats);
  });

  test("tool-output：按 callId 累加输出；没见过的 callId 补一条 shell", () => {
    const chunk = sample("tool-output", (msg) => Boolean(msg.chunk));
    const once = applyServerMessage(runningChats(), chunk, ctx);
    assert.equal(lastTurn(once).tools[0].name, "shell");
    assert.deepEqual(lastTurn(once).tools[0].result, { stdout: "", stderr: chunk.chunk });
    const twice = applyServerMessage(once, chunk, ctx);
    assert.equal(lastTurn(twice).tools.length, 1);
    assert.deepEqual(lastTurn(twice).tools[0].result, { stdout: "", stderr: `${chunk.chunk}${chunk.chunk}` });
    const full = sample("tool-output", (msg) => msg.stdout != null);
    const replaced = applyServerMessage(twice, full, ctx);
    assert.deepEqual(lastTurn(replaced).tools[0].result, { stdout: full.stdout, stderr: full.stderr });
  });

  test("task / approval：写到 running 回合", () => {
    const task = sample("task");
    assert.equal(lastTurn(applyServerMessage(runningChats(), task, ctx)).task, task.text);
    const approval = sample("approval");
    assert.deepEqual(lastTurn(applyServerMessage(runningChats(), approval, ctx)).pendingTool, {
      callId: approval.callId,
      name: approval.name,
      args: approval.args,
    });
  });

  test("error：收尾回合并记下错误；没有进行中的回合时返回同一引用", () => {
    const msg = sample("error", (item) => Boolean(item.chatId));
    const next = applyServerMessage(runningChats({ tools: [tool()] }), msg, ctx);
    const settled = lastTurn(next);
    assert.equal(settled.running, false);
    assert.equal(settled.error, msg.message);
    assert.equal(settled.tools[0].status, "error");
    const idle = [chat({ turns: [turn()] })];
    assert.equal(applyServerMessage(idle, msg, ctx), idle);
  });

  test("done：收尾并记时长；重复的 done 不再改状态", () => {
    const msg = { ...sample("done"), status: "finished" };
    const once = applyServerMessage(runningChats({ tools: [tool()] }), msg, ctx);
    assert.equal(lastTurn(once).running, false);
    assert.equal(lastTurn(once).durationMs, msg.durationMs);
    assert.equal(lastTurn(once).tools[0].status, "completed");
    assert.equal(applyServerMessage(once, msg, ctx), once);
  });

  test("done：助手说已拒绝写入时，把写类工具标成 rejected", () => {
    const msg = { ...sample("done"), status: "finished" };
    const chats = runningChats({ assistant: "已拒绝写入", tools: [tool({ name: "write", status: "completed" })] });
    const next = applyServerMessage(chats, msg, ctx);
    assert.equal(lastTurn(next).tools[0].review, "rejected");
  });

  test("status RUNNING：没有 turnId，不改变任何具体回合", () => {
    const msg = { ...sample("status", (item) => Boolean(item.chatId)), status: "RUNNING", message: undefined };
    const queued = [
      chat({
        turns: [
          turn({ id: "done", status: "finished" }),
          turn({ id: "queued-1", queued: true }),
          turn({ id: "queued-2", queued: true }),
        ],
      }),
    ];
    assert.equal(applyServerMessage(queued, msg, ctx), queued);
    const running = runningChats();
    assert.equal(applyServerMessage(running, msg, ctx), running);
    const settled = [chat({ turns: [turn({ id: "done", status: "finished" })] })];
    assert.equal(applyServerMessage(settled, msg, ctx), settled);
  });

  test("status 终态：CANCELLED 收尾成 cancelled，未结束工具标 error", () => {
    const msg = { ...sample("status", (item) => Boolean(item.chatId)), status: "CANCELLED", message: undefined };
    const next = applyServerMessage(runningChats({ tools: [tool()] }), msg, ctx);
    assert.equal(lastTurn(next).running, false);
    assert.equal(lastTurn(next).status, "cancelled");
    assert.equal(lastTurn(next).tools[0].status, "error");
  });

  test("status 其它（如 QUEUED 金样本）不改状态", () => {
    const chats = runningChats();
    assert.equal(
      applyServerMessage(
        chats,
        sample("status", (item) => Boolean(item.chatId)),
        ctx,
      ),
      chats,
    );
  });

  test("status 消息带“已拒绝写入”：最后一个相关回合的写类工具标 rejected", () => {
    const msg = { type: "status", chatId: CHAT, status: "IDLE", message: "已拒绝写入 a.md" } as const;
    const chats = [chat({ turns: [turn({ tools: [tool({ name: "write", status: "completed" })] })] })];
    const next = applyServerMessage(chats, msg, ctx);
    assert.equal(lastTurn(next).tools[0].review, "rejected");
  });

  test("run_meta：更新回合模型/模式和会话策略；策略已相同时不新建会话对象", () => {
    const msg = sample("run_meta");
    const next = applyServerMessage(runningChats(), msg, ctx);
    assert.equal(lastTurn(next).model, msg.model);
    assert.equal(lastTurn(next).mode, msg.mode);
    assert.equal(next[0].policy, msg.policy);
    const idle = [chat({ policy: msg.policy, turns: [turn()] })];
    assert.equal(applyServerMessage(idle, msg, ctx), idle);
  });

  test("policy：带 chatId 改对应会话，不带改当前会话；相同返回同一引用", () => {
    const msg = sample("policy");
    const next = applyServerMessage(runningChats(), msg, ctx);
    assert.equal(next[0].policy, msg.policy);
    assert.equal(applyServerMessage(next, msg, ctx), next);
    const toActive = applyServerMessage(runningChats(), { type: "policy", policy: "baseline" }, { activeId: "other" });
    assert.equal(toActive[1].policy, "baseline");
    assert.equal(toActive[0].policy, undefined);
  });

  test("chat_title：只给未命名会话起名；空标题、已命名都返回同一引用", () => {
    const msg = sample("chat_title");
    const next = applyServerMessage([chat()], msg, ctx);
    assert.equal(next[0].title, msg.title);
    assert.equal(applyServerMessage(next, { ...msg, title: "别的" }, ctx), next);
    const untitled = [chat()];
    assert.equal(applyServerMessage(untitled, { ...msg, title: "  " }, ctx), untitled);
  });

  test("checkpoints：替换会话检查点", () => {
    const msg = sample("checkpoints");
    const next = applyServerMessage([chat()], msg, ctx);
    assert.deepEqual(next[0].checkpoints, msg.items);
  });

  // mergeHistoryTurns / applyRunSnapshot 对非空输入总是新建数组，重复到达只能保证内容幂等
  test("history：并入 Cursor 端历史；重复到达内容不变；空历史返回同一引用", () => {
    const msg = sample("history");
    const next = applyServerMessage([chat()], msg, ctx);
    assert.ok(next[0].turns.length > 0);
    assert.deepEqual(applyServerMessage(next, msg, ctx), next);
    const empty = [chat()];
    assert.equal(applyServerMessage(empty, { ...msg, turns: [] }, ctx), empty);
    assert.equal(applyServerMessage(empty, { ...msg, chatId: "nope" }, ctx), empty);
  });

  test("run_snapshot：按快照补齐回合；重复到达内容不变", () => {
    const msg = { ...sample("run_snapshot"), queued: undefined };
    const next = applyServerMessage([chat()], msg, ctx);
    assert.equal(next[0].turns.length, 1);
    assert.equal(next[0].turns[0].user, msg.userText);
    assert.deepEqual(applyServerMessage(next, msg, ctx), next);
  });

  test("workspace_renamed：改名目录及其子目录下的会话跟着搬；无关会话保持原引用", () => {
    const msg = sample("workspace_renamed");
    const chats = [
      chat({ cwd: msg.from }),
      chat({ id: "sub", cwd: `${msg.from}/deck` }),
      chat({ id: "far", cwd: "/workspace/demo/notes" }),
    ];
    const next = applyServerMessage(chats, msg, ctx);
    assert.equal(next[0].cwd, msg.path);
    assert.equal(next[1].cwd, `${msg.path}/deck`);
    assert.equal(next[2], chats[2]);
    assert.equal(applyServerMessage(next, msg, ctx), next);
  });
});

describe("markUnread", () => {
  test("标未读；已未读或未知会话返回同一引用", () => {
    const chats = [chat()];
    const next = markUnread(chats, CHAT);
    assert.equal(next[0].unread, true);
    assert.equal(markUnread(next, CHAT), next);
    assert.equal(markUnread(chats, "nope"), chats);
  });
});

describe("applyReadyRuns", () => {
  test("网关不在跑的回合收尾；在跑的保留；排队会话等待带 turnId 的快照定位", () => {
    const msg: Msg<"ready"> = { ...sample("ready"), runningChatIds: ["live"], queuedChatIds: ["wait"] };
    const chats = [
      chat({ id: "orphan", turns: [turn({ running: true })] }),
      chat({ id: "live", turns: [turn({ running: true })] }),
      chat({ id: "wait", turns: [turn({ user: "排队这条" }), turn({ id: "t2", user: "" })] }),
    ];
    const next = applyReadyRuns(chats, msg);
    assert.equal(next[0].turns[0].running, false);
    assert.equal(next[1], chats[1]);
    assert.equal(next[2], chats[2]);
  });

  test("网关说在跑的会话之外没有可收尾的、也没有排队要补时，内容不变", () => {
    const msg: Msg<"ready"> = { ...sample("ready"), runningChatIds: [CHAT], queuedChatIds: [] };
    const chats = [chat({ turns: [turn({ running: true })] })];
    assert.equal(applyReadyRuns(chats, msg), chats);
  });
});

describe("chatsToFlush", () => {
  test("本地有排队、没在跑、网关没在排队的会话才续发", () => {
    const chats = [
      chat({ id: "a", turns: [turn({ queued: true })] }),
      chat({ id: "b", turns: [turn({ running: true }), turn({ id: "t2", queued: true })] }),
      chat({ id: "c", turns: [turn({ queued: true })] }),
      chat({ id: "d", turns: [turn()] }),
    ];
    assert.deepEqual(chatsToFlush(chats, ["c"]), ["a"]);
    assert.deepEqual(chatsToFlush(chats), ["a", "c"]);
  });

  test("要用 applyReadyRuns 之后的列表算：网关不认识的排队回合已被收尾，不能再续发；网关在跑的会话照常续发", () => {
    const msg: Msg<"ready"> = { ...sample("ready"), runningChatIds: ["live"], queuedChatIds: [] };
    const chats = [
      chat({ id: "orphan", turns: [turn(), turn({ id: "t2", queued: true })] }),
      chat({ id: "live", turns: [turn(), turn({ id: "t2", queued: true })] }),
    ];
    // 读到 applyReadyRuns 之前的旧列表会续发 orphan，而界面上这条已显示为停止
    assert.deepEqual(chatsToFlush(chats, msg.queuedChatIds), ["orphan", "live"]);
    const next = applyReadyRuns(chats, msg);
    assert.equal(next[0].turns[1].queued, false);
    assert.deepEqual(chatsToFlush(next, msg.queuedChatIds), ["live"]);
  });
});

describe("commitSync", () => {
  /** 模拟 React 已有待渲染更新时的行为：updater 先排队，渲染（flush）时才执行 */
  function deferredState<T>(initial: T) {
    let state = initial;
    const queue: Array<T | ((prev: T) => T)> = [];
    return {
      set: (value: T | ((prev: T) => T)) => queue.push(value),
      flush() {
        for (const item of queue.splice(0)) state = typeof item === "function" ? (item as (prev: T) => T)(state) : item;
        return state;
      },
    };
  }

  test("updater 被推迟时，旧写法紧接着读 ref 是旧值；commitSync 立刻可见，渲染后结果一致", () => {
    const old = { current: [1] };
    const oldState = deferredState(old.current);
    oldState.set((prev) => {
      const next = [...prev, 2];
      old.current = next;
      return next;
    });
    assert.deepEqual(old.current, [1]);

    const ref = { current: [1] };
    const state = deferredState(ref.current);
    commitSync(ref, state.set, (prev) => [...prev, 2]);
    assert.deepEqual(ref.current, [1, 2]);
    commitSync(ref, state.set, (prev) => [...prev, 3]);
    assert.deepEqual(ref.current, [1, 2, 3]);
    assert.deepEqual(state.flush(), [1, 2, 3]);
  });

  test("没有变化（返回同一引用）时不调用 set", () => {
    const ref = { current: [1] };
    let calls = 0;
    const out = commitSync(
      ref,
      () => calls++,
      (prev) => prev,
    );
    assert.equal(out, ref.current);
    assert.equal(calls, 0);
  });

  test("tool-started 后紧接着 tool-completed：同步提交后能从 ref 找到 running 回合里开始时的 args", () => {
    const ref = { current: [chat({ id: CHAT, turns: [turn({ running: true })] })] };
    const state = deferredState(ref.current);
    const started = { ...sample("tool-started"), chatId: CHAT };
    commitSync(ref, state.set, (prev) => applyServerMessage(prev, started, ctx));
    commitSync(ref, state.set, (prev) =>
      applyServerMessage(prev, { ...sample("tool-completed"), chatId: CHAT, callId: started.callId }, ctx),
    );
    const running = ref.current.find((item) => item.id === CHAT)?.turns.find((item) => item.running);
    assert.deepEqual(running?.tools.find((item) => item.callId === started.callId)?.args, started.args);
  });
});

describe("applySession", () => {
  test("金样本：三个字段都是字符串（网关从不省略，“没有”用空串）", () => {
    const msg = sample("session");
    for (const key of ["chatId", "agentId", "cwd"] as const) assert.equal(typeof msg[key], "string", key);
  });

  test("带 chatId：写调用方算好的 cwd 和 agentId", () => {
    const msg = sample("session");
    const next = applySession([chat({ cwd: "/old" })], msg, "other", "/picked");
    assert.equal(next[0].cwd, "/picked");
    assert.equal(next[0].agentId, msg.agentId);
    const keepCwd = applySession([chat({ cwd: "/old" })], { ...msg, agentId: "" }, "other");
    assert.equal(keepCwd[0].cwd, "/old");
    assert.equal(keepCwd[0].agentId, undefined);
  });

  test("不带 chatId：只给当前会话补 cwd；已有 cwd 时返回同一引用", () => {
    const msg = { ...sample("session"), chatId: "" };
    const next = applySession([chat()], msg, CHAT);
    assert.equal(next[0].cwd, msg.cwd);
    assert.equal(applySession(next, msg, CHAT), next);
    const bare = [chat()];
    assert.equal(applySession(bare, { ...msg, cwd: "" }, CHAT), bare);
  });
});

describe("appendDraftMention", () => {
  test("补 @路径 到草稿末尾；已有同一路径或未知会话返回同一引用", () => {
    const chats = [chat({ draft: "看看" })];
    const next = appendDraftMention(chats, CHAT, "a.png");
    assert.equal(next[0].draft, "看看 @a.png ");
    assert.equal(appendDraftMention(next, CHAT, "a.png"), next);
    assert.equal(appendDraftMention(chats, "nope", "a.png"), chats);
  });
});

describe("loopsFromReady / applyLoopMessage", () => {
  const loopRow = (): LoopRow => ({ chatId: CHAT, status: "running", goal: "g", intervalSec: 60, tick: 1 });

  test("ready 的循环列表只留在跑的", () => {
    const loops = sample("ready").loops || [];
    const rows = [...loops, { ...loops[0], chatId: "stopped", status: "stopped" as const }];
    const next = loopsFromReady(rows);
    assert.deepEqual(Object.keys(next), [CHAT]);
    assert.deepEqual(loopsFromReady(undefined), {});
  });

  test("loop_state 写整行并保留上次 tickStatus；没 chatId 返回同一引用", () => {
    const msg = sample("loop_state");
    const prev: Record<string, LoopRow> = { [CHAT]: { ...loopRow(), tickStatus: "ok" } };
    const next = applyLoopMessage(prev, msg);
    assert.equal(next[CHAT].tick, msg.tick);
    assert.equal(next[CHAT].tickStatus, "ok");
    assert.equal(applyLoopMessage(prev, { ...msg, chatId: "" }), prev);
  });

  test("loop_tick 只更新已知循环；未知 chatId 返回同一引用；stopped 停掉", () => {
    const tick = sample("loop_tick");
    const known: Record<string, LoopRow> = { [CHAT]: loopRow() };
    const next = applyLoopMessage(known, tick);
    assert.equal(next[CHAT].tickStatus, tick.status);
    assert.equal(next[CHAT].lastSummary, tick.summary);
    assert.equal(next[CHAT].status, "running");
    assert.equal(applyLoopMessage(known, { ...tick, status: "stopped" })[CHAT].status, "stopped");
    const empty: Record<string, LoopRow> = {};
    assert.equal(applyLoopMessage(empty, tick), empty);
    assert.equal(applyLoopMessage(known, sample("pong")), known);
  });
});

describe("applyAssistantMessage", () => {
  const base = (): AssistantState => sample("assistant_state").state;

  test("还没拿到助理状态时 inbox / delegation 消息不建状态", () => {
    assert.equal(applyAssistantMessage(null, sample("inbox_item")), null);
    assert.equal(applyAssistantMessage(null, sample("delegation_state")), null);
  });

  test("inbox_item：同 id 去重并置顶", () => {
    const msg = sample("inbox_item");
    const once = applyAssistantMessage(base(), msg)!;
    const twice = applyAssistantMessage(once, msg)!;
    assert.equal(twice.inbox[0].id, msg.item.id);
    assert.equal(twice.inbox.filter((row) => row.id === msg.item.id).length, 1);
  });

  test("delegation_state：awaiting 时挂上审批，否则清掉这条委托的审批", () => {
    const msg = sample("delegation_state");
    const awaiting = applyAssistantMessage(base(), { ...msg, delegation: { ...msg.delegation, status: "awaiting" } })!;
    assert.equal(awaiting.delegations[0].id, msg.delegation.id);
    assert.equal(awaiting.approvals.filter((row) => row.delegationId === msg.delegation.id).length, 1);
    const finished = applyAssistantMessage(awaiting, { ...msg, delegation: { ...msg.delegation, status: "done" } })!;
    assert.equal(finished.approvals.filter((row) => row.delegationId === msg.delegation.id).length, 0);
    assert.equal(finished.delegations.filter((row) => row.id === msg.delegation.id).length, 1);
  });

  test("其它消息返回同一引用", () => {
    const state = base();
    assert.equal(applyAssistantMessage(state, sample("pong")), state);
  });
});
