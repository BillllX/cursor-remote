import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ServerMessage } from "@shared/protocol";
import {
  applyRunSnapshot,
  historyToTurns,
  mergeHistoryTurns,
  serverTurn,
  settleTurn,
  turnHasOpenTools,
  withLiveTurns,
} from "../lib/chat/turns";
import type { ToolCall, Turn } from "../lib/chat/types";

type Snapshot = Extract<ServerMessage, { type: "run_snapshot" }>;

const tool = (over: Partial<ToolCall> = {}): ToolCall => ({ callId: "c1", name: "Shell", status: "running", ...over });
const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "t1",
  user: "hi",
  assistant: "",
  thinking: "",
  tools: [],
  running: false,
  ...over,
});
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  type: "run_snapshot",
  chatId: "c",
  phase: "running",
  userText: "hi",
  assistant: "",
  ...over,
});

describe("settleTurn", () => {
  test("正常结束：跑着的工具标成 completed，清掉 running/queued/pendingTool", () => {
    const out = settleTurn(
      turn({ running: true, queued: true, pendingTool: { callId: "p", name: "Write" }, tools: [tool()] }),
      "finished",
      1200,
    );
    assert.equal(out.running, false);
    assert.equal(out.queued, false);
    assert.equal(out.pendingTool, undefined);
    assert.equal(out.tools[0].status, "completed");
    assert.equal(out.status, "finished");
    assert.equal(out.durationMs, 1200);
  });

  test("cancelled / Canceled / error：跑着的工具标成 error（状态大小写不敏感）", () => {
    for (const status of ["cancelled", "Canceled", "error"]) {
      const out = settleTurn(turn({ running: true, tools: [tool()] }), status);
      assert.equal(out.tools[0].status, "error", status);
      assert.equal(out.status, status);
    }
  });

  test("已结束的工具不受影响", () => {
    const out = settleTurn(
      turn({ running: true, tools: [tool({ status: "completed" }), tool({ callId: "c2" })] }),
      "error",
    );
    assert.deepEqual(
      out.tools.map((t) => t.status),
      ["completed", "error"],
    );
  });

  test("approval：只停掉 running/queued，工具和待批的 pendingTool 保留", () => {
    const pendingTool = { callId: "p", name: "Write" };
    const out = settleTurn(turn({ running: true, queued: true, pendingTool, tools: [tool()] }), "approval");
    assert.equal(out.running, false);
    assert.equal(out.queued, false);
    assert.equal(out.pendingTool, pendingTool);
    assert.equal(out.tools[0].status, "running");
    assert.equal(out.status, "approval");
  });

  test("不传 status 时按回合已有的 status 判断，status 不变", () => {
    const out = settleTurn(turn({ running: true, status: "cancelled", tools: [tool()] }));
    assert.equal(out.status, "cancelled");
    assert.equal(out.tools[0].status, "error");
  });

  test("durationMs：传 0 也会覆盖，不传保留原值", () => {
    assert.equal(settleTurn(turn({ durationMs: 5 }), "finished", 0).durationMs, 0);
    assert.equal(settleTurn(turn({ durationMs: 5 }), "finished").durationMs, 5);
  });

  test("failed / Failed 与 error 同样算失败：跑着的工具标成 error（与 runMeta 显示“出错”一致）", () => {
    for (const status of ["failed", "Failed"]) {
      const out = settleTurn(turn({ running: true, tools: [tool()] }), status);
      assert.equal(out.tools[0].status, "error", status);
      assert.equal(out.running, false);
      assert.equal(out.status, status);
    }
  });

  test("空闲回合：返回新对象，只更新 status", () => {
    const idle = turn();
    const out = settleTurn(idle, "finished");
    assert.notEqual(out, idle);
    assert.deepEqual(out, { ...idle, status: "finished", durationMs: undefined });
    assert.equal(turnHasOpenTools(out), false);
  });
});

describe("applyRunSnapshot", () => {
  test("找不到回合时按 turnId 新建；phase=done 时直接结算", () => {
    const out = applyRunSnapshot(
      [],
      snapshot({ turnId: "n", phase: "done", status: "finished", assistant: "好了", durationMs: 9 }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "n");
    assert.equal(out[0].assistant, "好了");
    assert.equal(out[0].running, false);
    assert.equal(out[0].status, "finished");
    assert.equal(out[0].durationMs, 9);
  });

  test("没有 turnId 时按用户消息指纹（折叠空白）对上最近的一条，内容只增不减", () => {
    const turns = [turn({ id: "a", user: "同一句" }), turn({ id: "b", user: "同一句", assistant: "已经很长的回答" })];
    const out = applyRunSnapshot(turns, snapshot({ userText: " 同一句 ", assistant: "短" }));
    assert.equal(out[1].assistant, "已经很长的回答");
    assert.equal(out[1].running, true);
    assert.equal(out[0], turns[0]);
  });

  test("排队项追加为 queued 回合，已存在（同 id 或同指纹且在跑/排队）的不重复", () => {
    const turns = [turn({ id: "a", user: "第一句", running: true })];
    const out = applyRunSnapshot(
      turns,
      snapshot({
        turnId: "a",
        userText: "第一句",
        queued: [{ turnId: "a", userText: "x" }, { userText: "第一句" }, { turnId: "q", userText: "第二句" }],
      }),
    );
    assert.deepEqual(
      out.map((t) => [t.id, Boolean(t.queued)]),
      [
        ["a", false],
        ["q", true],
      ],
    );
  });
});

describe("mergeHistoryTurns / withLiveTurns / serverTurn", () => {
  test("historyToTurns 保留回合文件卡片和来源会话信息", () => {
    const [out] = historyToTurns([
      {
        id: "h",
        user: "u",
        assistant: "a",
        files: [{ path: "report.md", kind: "markdown", op: "added", sha: "a".repeat(64), sourceChatId: "child" }],
      },
    ]);
    assert.equal(out.files?.[0].path, "report.md");
    assert.equal(out.files?.[0].sourceChatId, "child");
  });

  test("历史为空返回本地；本地没内容直接用历史", () => {
    const local = [turn({ user: "" })];
    assert.equal(mergeHistoryTurns(local, []), local);
    const incoming = [turn({ id: "h" })];
    assert.equal(mergeHistoryTurns(local, incoming), incoming);
  });

  test("分页旧历史不会删掉稍后收到的委派文件", () => {
    const newest = {
      path: "report.md",
      kind: "markdown" as const,
      op: "added" as const,
      sourceChatId: "child",
      sourceTurnId: "child-turn",
    };
    const local = [turn({ id: "l", user: "问题", files: [newest] })];
    const incoming = [turn({ id: "h", user: "问题", files: [] })];
    assert.deepEqual(mergeHistoryTurns(local, incoming)[0].files, [newest]);
  });

  test("按用户消息对上：取更长的回答、合并工具；本地第一条之前的历史补在前面", () => {
    const local = [
      turn({ id: "l", user: "问题", assistant: "短", tools: [tool({ callId: "x", status: "completed" })] }),
    ];
    const incoming = [
      turn({ id: "old", user: "更早的问题", running: true }),
      turn({ id: "h", user: "问题", assistant: "更长的回答", tools: [tool({ callId: "y", name: "Read" })] }),
    ];
    const out = mergeHistoryTurns(local, incoming);
    assert.deepEqual(
      out.map((t) => t.id),
      ["old", "l"],
    );
    assert.equal(out[0].running, false);
    assert.equal(out[1].assistant, "更长的回答");
    assert.deepEqual(
      out[1].tools.map((t) => [t.callId, t.status]),
      [
        ["x", "completed"],
        ["y", "completed"],
      ],
    );
  });

  test("withLiveTurns：服务端为准，本地在跑的回合替换同 id 的、服务端没有的接在末尾", () => {
    const server = [turn({ id: "a", assistant: "服务端" }), turn({ id: "b" })];
    assert.equal(withLiveTurns([turn({ id: "a" })], server), server);
    const liveA = turn({ id: "a", running: true });
    const liveC = turn({ id: "c", queued: true });
    assert.deepEqual(withLiveTurns([liveA, liveC], server), [liveA, server[1], liveC]);
  });

  test("serverTurn：拒绝没有 id 的行，补齐字符串字段并从工具里提取待办", () => {
    assert.equal(serverTurn({ user: "x" }), null);
    const out = serverTurn({
      id: "s",
      tools: [{ callId: "t", name: "TodoWrite", status: "completed", args: { todos: [{ content: "写测试" }] } }],
    });
    assert.equal(out?.user, "");
    assert.equal(out?.running, false);
    assert.deepEqual(out?.todos, [{ id: "0", content: "写测试", status: "pending" }]);
  });
});
