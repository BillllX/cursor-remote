import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { armPerfLive, keepPerfTurns, makePerfTurn, makePerfTurns } from "../lib/chat/perfSeed";
import { createStableActions } from "../lib/chat/stableActions";
import { estimateTurnHeight, LIVE_TAIL_TURNS, planTurnRows } from "../lib/chat/threadRows";
import type { Turn } from "../lib/chat/types";

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "t1",
  user: "hi",
  assistant: "ok",
  thinking: "",
  tools: [],
  running: false,
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => turn({ id: `t${i}`, user: `q${i}` }));

describe("planTurnRows", () => {
  test("普通回合逐个输出，只有最后一个 isLast", () => {
    const rows = planTurnRows(many(3));
    assert.deepEqual(
      rows.map((r) => r.turn.id),
      ["t0", "t1", "t2"],
    );
    assert.deepEqual(
      rows.map((r) => r.isLast),
      [false, false, true],
    );
    assert.ok(rows.every((r) => !r.hideUser));
  });

  test("行里放的是原回合对象（引用不变，memo 才能命中）", () => {
    const turns = many(4);
    const rows = planTurnRows(turns);
    rows.forEach((r, i) => assert.equal(r.turn, turns[i]));
  });

  test("用户消息和前一个有效回合相同则 hideUser（忽略首尾空白）", () => {
    const rows = planTurnRows([turn({ id: "a", user: "重试这句" }), turn({ id: "b", user: "  重试这句 " })]);
    assert.equal(rows[0].hideUser, false);
    assert.equal(rows[1].hideUser, true);
  });

  test("空用户消息不算重复", () => {
    const rows = planTurnRows([turn({ id: "a", user: "" }), turn({ id: "b", user: "" })]);
    assert.equal(rows[1].hideUser, false);
  });

  test("被后一轮取代的失败回合不输出，hideUser 跳过它找前一个有效回合", () => {
    const failed = turn({ id: "b", user: "同一句", assistant: "", error: "boom" });
    const rows = planTurnRows([turn({ id: "a", user: "同一句" }), failed, turn({ id: "c", user: "同一句" })]);
    assert.deepEqual(
      rows.map((r) => r.turn.id),
      ["a", "c"],
    );
    // c 的前一个有效回合是 a，用户消息相同
    assert.equal(rows[1].hideUser, true);
  });

  test("isLast 按原始列表末尾算：最后一个被取代时，倒数第二个也不是 isLast", () => {
    const rows = planTurnRows([
      turn({ id: "a", user: "x" }),
      turn({ id: "b", user: "y", assistant: "", error: "e" }),
      turn({ id: "c", user: "y" }),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.turn.id, r.isLast]),
      [
        ["a", false],
        ["c", true],
      ],
    );
  });

  test("deferrable：末尾 LIVE_TAIL_TURNS 个不启用，更早且已结算的才启用", () => {
    const rows = planTurnRows(many(LIVE_TAIL_TURNS + 3));
    assert.deepEqual(
      rows.map((r) => r.deferrable),
      [true, true, true, ...Array(LIVE_TAIL_TURNS).fill(false)],
    );
  });

  test("deferrable：运行中、排队中、等审批的旧回合不启用", () => {
    const turns = many(LIVE_TAIL_TURNS + 4);
    turns[0] = turn({ id: "run", running: true });
    turns[1] = turn({ id: "queue", queued: true });
    turns[2] = turn({ id: "pend", pendingTool: { callId: "c", name: "shell" } });
    const rows = planTurnRows(turns);
    assert.deepEqual(
      rows.slice(0, 4).map((r) => r.deferrable),
      [false, false, false, true],
    );
  });

  test("短列表整体都在末尾保护区内", () => {
    assert.ok(planTurnRows(many(LIVE_TAIL_TURNS)).every((r) => !r.deferrable));
    assert.deepEqual(planTurnRows([]), []);
  });

  test("流式期间旧回合的行数据逐项相同（只有末轮 turn 引用变）", () => {
    const base = many(20);
    const before = planTurnRows(base);
    const streamed = base.slice();
    streamed[19] = { ...base[19], assistant: base[19].assistant + "更多" };
    const after = planTurnRows(streamed);
    for (let i = 0; i < 19; i += 1) {
      assert.equal(after[i].turn, before[i].turn);
      assert.equal(after[i].hideUser, before[i].hideUser);
      assert.equal(after[i].isLast, before[i].isLast);
      assert.equal(after[i].deferrable, before[i].deferrable);
    }
    assert.notEqual(after[19].turn, before[19].turn);
  });
});

describe("estimateTurnHeight", () => {
  test("内容越多估得越高，且有上下限", () => {
    const small = estimateTurnHeight(turn({ assistant: "ok" }), false);
    const big = estimateTurnHeight(turn({ assistant: "这是一行很长的中文回答。".repeat(200) }), false);
    assert.ok(big > small);
    assert.ok(small >= 80);
    assert.equal(estimateTurnHeight(turn({ assistant: "x\n".repeat(5000) }), false), 4000);
  });

  test("隐藏用户气泡时更矮；带工具卡、图片更高", () => {
    const base = turn({ user: "一句话问题", assistant: "回答" });
    assert.ok(estimateTurnHeight(base, true) < estimateTurnHeight(base, false));
    const withTool = { ...base, tools: [{ callId: "c", name: "read_file", status: "completed" as const }] };
    assert.ok(estimateTurnHeight(withTool, false) > estimateTurnHeight(base, false));
    const withImage = { ...base, images: [{ mimeType: "image/png", data: "" }] };
    assert.ok(estimateTurnHeight(withImage, false) > estimateTurnHeight(base, false));
  });

  test("同一回合同一输入结果稳定（占位高度不会让行样式每次都变）", () => {
    const t = makePerfTurn(7);
    assert.equal(estimateTurnHeight(t, false), estimateTurnHeight(t, false));
  });
});

describe("createStableActions（稳定回调）", () => {
  test("包装函数引用不变，调用时转给最新实现，参数和返回值原样透传", () => {
    const calls: string[] = [];
    let latest = {
      open: (path: string, line?: number) => {
        calls.push(`v1:${path}:${line}`);
        return 1;
      },
      stop: (id: string) => calls.push(`v1:stop:${id}`),
    };
    const stable = createStableActions(() => latest, ["open", "stop"]);
    const open = stable.open;
    assert.equal(stable.open(" a.ts", 3), 1);
    // 模拟下一次渲染换了新闭包：旧的包装函数引用还是它，但要调到新实现（不会拿到过期闭包）
    latest = {
      open: (path: string, line?: number) => {
        calls.push(`v2:${path}:${line}`);
        return 2;
      },
      stop: (id: string) => calls.push(`v2:stop:${id}`),
    };
    assert.equal(stable.open, open);
    assert.equal(open("b.ts", 9), 2);
    stable.stop("c1");
    assert.deepEqual(calls, ["v1: a.ts:3", "v2:b.ts:9", "v2:stop:c1"]);
  });

  test("只暴露指定的键", () => {
    const stable = createStableActions(() => ({ a: () => 1, b: () => 2 }), ["a"]);
    assert.deepEqual(Object.keys(stable), ["a"]);
  });
});

describe("makePerfTurns（测量造数据）", () => {
  test("count 个已结束回合 + 末尾一个运行中回合，id 唯一且带 perf- 前缀", () => {
    const turns = makePerfTurns(240);
    assert.equal(turns.length, 241);
    assert.equal(new Set(turns.map((t) => t.id)).size, 241);
    assert.ok(turns.every((t) => t.id.startsWith("perf-")));
    assert.equal(turns.filter((t) => t.running).length, 1);
    assert.equal(turns[240].running, true);
    assert.equal(turns[240].id, "perf-live");
  });

  test("第 2 轮带图，第 3 轮用户文本能被“第 3 个问题”唯一命中", () => {
    const turns = makePerfTurns(240).slice(0, 240);
    assert.equal(turns[1].images?.length, 1);
    assert.equal(turns.filter((t) => t.user.includes("第 3 个问题")).length, 1);
    assert.equal(turns.filter((t) => t.user.includes("第 200 个问题")).length, 1);
  });

  test("keepPerfTurns：服务端正文覆盖后，合成回合按原顺序接回末尾，真实回合以服务端为准", () => {
    const seeded = makePerfTurns(3);
    const real = turn({ id: "real-old", user: "旧" });
    const local = [real, ...seeded];
    const server = [turn({ id: "real-old", user: "服务端版本" }), turn({ id: "real-new" })];
    const out = keepPerfTurns(local, server);
    assert.deepEqual(
      out.map((t) => t.id),
      ["real-old", "real-new", "perf-0001", "perf-0002", "perf-0003", "perf-live"],
    );
    assert.equal(out[0].user, "服务端版本");
    // 合成回合是原对象，memo 仍然命中
    assert.equal(out[2], seeded[0]);
  });

  test("keepPerfTurns：本地没有合成回合时原样返回 merged（引用不变）", () => {
    const merged = [turn({ id: "a" })];
    assert.equal(keepPerfTurns([turn({ id: "b" })], merged), merged);
  });
});

describe("armPerfLive", () => {
  test("合成的运行中回合被结算后重新置为运行中；已在跑时返回原数组", () => {
    const turns = makePerfTurns(2);
    assert.equal(armPerfLive(turns), turns);
    const settled = turns.map((t) => (t.id === "perf-live" ? { ...t, running: false, status: "finished" } : t));
    const armed = armPerfLive(settled);
    assert.notEqual(armed, settled);
    assert.equal(armed[armed.length - 1].running, true);
    // 其余回合对象保持原引用
    assert.equal(armed[0], settled[0]);
  });

  test("没有合成回合时返回原数组", () => {
    const turns = [turn({ id: "x" })];
    assert.equal(armPerfLive(turns), turns);
  });
});
