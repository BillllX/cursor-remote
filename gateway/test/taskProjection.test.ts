import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantApproval, AssistantInboxItem } from "../../shared/protocol.ts";
import type { Delegation } from "../src/assistant/delegations.ts";
import type { Schedule } from "../src/assistant/schedules.ts";
import { buildTaskProjection, type ProjectionRun, type TaskProjectionInput } from "../src/assistant/taskProjection.ts";
import type { Todo } from "../src/assistant/todos.ts";

const NOW = Date.parse("2026-10-23T12:00:00+08:00");
const DAY = "2026-10-23";

function input(patch: Partial<TaskProjectionInput> = {}): TaskProjectionInput {
  return {
    todos: [],
    schedules: [],
    delegations: [],
    approvals: [],
    runs: [],
    inbox: [],
    brief: null,
    ...patch,
  };
}

function todo(patch: Partial<Todo> & Pick<Todo, "id" | "text">): Todo {
  return { done: false, createdAt: NOW - 1000, ...patch };
}

function schedule(patch: Partial<Schedule> & Pick<Schedule, "id" | "title">): Schedule {
  return {
    kind: "remind",
    cron: "0 9 * * *",
    tz: "Asia/Shanghai",
    prompt: "提醒",
    enabled: true,
    misfire: "runOnce",
    nextAt: NOW + 1000,
    failCount: 0,
    createdAt: NOW - 2000,
    ...patch,
  };
}

function delegation(patch: Partial<Delegation> & Pick<Delegation, "id" | "title" | "childChatId">): Delegation {
  return {
    workspace: "/workspace/demo",
    task: "完成任务",
    mode: "background",
    status: "running",
    createdAt: NOW - 3000,
    ...patch,
  };
}

function run(patch: Partial<ProjectionRun> & Pick<ProjectionRun, "runId" | "label">): ProjectionRun {
  return {
    origin: "loop",
    status: "running",
    startedAt: NOW - 4000,
    cwd: "/workspace",
    model: "test",
    ...patch,
  };
}

function approval(patch: Partial<AssistantApproval> = {}): AssistantApproval {
  return {
    id: "ap-1",
    chatId: "child-1",
    callId: "call-1",
    tool: "create_workspace",
    summary: "在 /workspace/acme 创建 acme",
    createdAt: NOW - 500,
    expiresAt: NOW + 60_000,
    ...patch,
  };
}

function inboxItem(patch: Partial<AssistantInboxItem> = {}): AssistantInboxItem {
  return {
    id: "i-1",
    kind: "approval",
    title: "待批准",
    body: "请确认",
    createdAt: NOW - 400,
    read: false,
    ...patch,
  };
}

describe("Personal Task 只读投影", () => {
  test("映射状态、注意力和优先级", () => {
    const projection = buildTaskProjection(
      input({
        todos: [
          todo({ id: "late", text: "已逾期待办", due: "2026-10-22" }),
          todo({ id: "done", text: "完成项", done: true, doneAt: NOW - 100 }),
        ],
        schedules: [schedule({ id: "broken", title: "失败日程", failCount: 2, lastStatus: "failed" })],
        runs: [
          run({ runId: "waiting", label: "等用户", status: "waiting_user" }),
          run({ runId: "stalled", label: "停滞", status: "stalled" }),
          run({ runId: "failed", label: "失败", status: "failed", endedAt: NOW - 20, error: "网络错误" }),
        ],
      }),
      { now: NOW, day: DAY },
    );

    const byId = new Map(projection.personalTasks.map((task) => [task.id, task]));
    assert.deepEqual(
      ["todo:late", "schedule:broken", "run:waiting", "run:stalled", "run:failed"].map((id) => [
        byId.get(id)?.phase,
        byId.get(id)?.priority,
      ]),
      Array.from({ length: 5 }, () => ["needs_me", "high"]),
    );
    assert.equal(byId.get("todo:done")?.phase, "completed");
    assert.equal(byId.get("run:failed")?.attention, "网络错误");
  });

  test("可关联的 delegate run 合并到委派 sources，不重复生成任务", () => {
    const item = delegation({ id: "d-1", title: "修登录", childChatId: "child-1" });
    const linked = run({
      runId: "r-linked",
      label: "修登录",
      origin: "delegate",
      chatId: "child-1",
      startedAt: item.createdAt,
    });
    const unrelated = run({ runId: "r-other", label: "整理", origin: "delegate", chatId: "child-2" });
    const tasks = buildTaskProjection(input({ delegations: [item], runs: [linked, unrelated] }), {
      now: NOW,
      day: DAY,
    }).personalTasks;

    assert.equal(
      tasks.some((task) => task.id === "run:r-linked"),
      false,
    );
    assert.equal(
      tasks.some((task) => task.id === "run:r-other"),
      true,
    );
    assert.deepEqual(tasks.find((task) => task.id === "delegation:d-1")?.sources, [
      { kind: "delegation", id: "d-1" },
      { kind: "run", id: "r-linked" },
    ]);
  });

  test("approval 生成可展示最终摘要和现有 approval_answer 动作", () => {
    const cards = buildTaskProjection(
      input({
        approvals: [
          approval(),
          approval({ id: "ap-shell", tool: "shell", summary: "npm test", callId: "call-shell" }),
          approval({ id: "ap-edit", tool: "edit_file", summary: "修改 src/app.ts", callId: "call-edit" }),
          approval({ id: "ap-memory", tool: "workspace_memory", summary: "记录测试命令", callId: "call-memory" }),
          approval({ id: "ap-pref", tool: "work_preferences", summary: "默认中文回复", callId: "call-pref" }),
        ],
      }),
      { now: NOW, day: DAY },
    ).draftCards;

    assert.deepEqual(
      cards.map((card) => [card.preview.kind, card.preview.summary]),
      [
        ["create_workspace", "在 /workspace/acme 创建 acme"],
        ["edit", "修改 src/app.ts"],
        ["workspace_memory", "记录测试命令"],
        ["work_preferences", "默认中文回复"],
        ["shell", "npm test"],
      ],
    );
    assert.deepEqual(
      cards[0]?.actions.map((action) => [action.op, action.args.allow]),
      [
        ["approval_answer", true],
        ["approval_answer", false],
      ],
    );
  });

  test("dayThread 对 approval 稳定去重，按时间排序，并只收当天回执", () => {
    const ap = approval({ delegationId: "d-1" });
    const doneToday = todo({ id: "today", text: "今天完成", done: true, doneAt: NOW - 100 });
    const doneYesterday = todo({
      id: "yesterday",
      text: "昨天完成",
      done: true,
      doneAt: Date.parse("2026-10-22T12:00:00+08:00"),
    });
    const events = buildTaskProjection(
      input({
        approvals: [ap],
        inbox: [
          inboxItem({ delegationId: "d-1" }),
          inboxItem({ id: "i-remind", kind: "reminder", title: "提醒", createdAt: NOW - 50 }),
          inboxItem({ id: "i-read", kind: "reminder", read: true }),
        ],
        todos: [doneToday, doneYesterday],
        brief: { day: DAY, text: "今天先做重要事项" },
      }),
      { now: NOW, day: DAY },
    ).dayThread;

    assert.equal(events.filter((event) => event.kind === "draft" || event.id === "inbox:i-1").length, 1);
    assert.equal(
      events.some((event) => event.id.includes("yesterday")),
      false,
    );
    assert.deepEqual(
      events.map((event) => event.at),
      [...events.map((event) => event.at)].sort((a, b) => b - a),
    );
  });

  test("任务、草稿和事件分别按上限裁剪", () => {
    const projection = buildTaskProjection(
      input({
        todos: Array.from({ length: 8 }, (_, index) => todo({ id: `t-${index}`, text: `任务 ${index}` })),
        approvals: Array.from({ length: 7 }, (_, index) =>
          approval({ id: `ap-${index}`, callId: `call-${index}`, createdAt: NOW - index }),
        ),
        inbox: Array.from({ length: 9 }, (_, index) =>
          inboxItem({
            id: `i-${index}`,
            kind: "reminder",
            createdAt: NOW - 100 - index,
          }),
        ),
      }),
      { now: NOW, day: DAY, limits: { tasks: 3, drafts: 2, events: 4 } },
    );

    assert.equal(projection.personalTasks.length, 3);
    assert.equal(projection.draftCards.length, 2);
    assert.equal(projection.dayThread.length, 4);
  });
});
