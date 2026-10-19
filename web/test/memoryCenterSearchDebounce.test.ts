import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSearchDebouncer, searchDebounceKey } from "../components/assistant/memoryCenterSearchDebounce";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let nextId = 1;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, row] of [...timers.entries()]) {
        if (row.due <= now) {
          timers.delete(id);
          row.fn();
        }
      }
    },
    clock: {
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++;
        timers.set(id, { due: now + ms, fn });
        return id;
      },
      clearTimeout(id: unknown) {
        timers.delete(id as number);
      },
    },
  };
}

describe("memoryCenterSearchDebounce", () => {
  test("debounce 300ms 只触发一次", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    deb.schedule("a");
    assert.equal(fired.length, 0);
    fc.advance(299);
    assert.equal(fired.length, 0);
    fc.advance(1);
    assert.equal(fired.length, 1);
    assert.equal(fired[0], "a");
  });

  test("连续 schedule 合并为最后一次", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    deb.schedule("a");
    fc.advance(100);
    deb.schedule("b");
    fc.advance(300);
    assert.deepEqual(fired, ["b"]);
  });

  test("flush 取消 timer 且只立即发送一次", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    deb.schedule("wait");
    deb.flush("now");
    assert.deepEqual(fired, ["now"]);
    fc.advance(500);
    assert.deepEqual(fired, ["now"]);
  });

  test("flush 后相同 key 的 schedule 只抑制一次（submit+effect 不双发）", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    const same = searchDebounceKey({ query: "q", scope: "all", kind: "all", state: "all" });
    deb.flush(same);
    deb.schedule(same);
    fc.advance(500);
    assert.deepEqual(fired, [same]);
  });

  test("flush→cancel→schedule 相同 key 300ms 再发一次（新搜索周期）", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    const repeat = searchDebounceKey({ query: "q", scope: "all", kind: "all", state: "all" });
    deb.flush(repeat);
    deb.cancel();
    deb.schedule(repeat);
    assert.deepEqual(fired, [repeat]);
    fc.advance(300);
    assert.deepEqual(fired, [repeat, repeat]);
  });

  test("cancel 清 suppressKey：flush 后 cancel 再 schedule 相同 key 不被误抑制", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    const k = "k";
    deb.flush(k);
    assert.equal(fired.length, 1);
    deb.cancel();
    deb.schedule(k);
    fc.advance(300);
    assert.equal(fired.length, 2);
  });

  test("flush(q/all) 后 schedule(q/personal) 300ms 各发一次", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    const kAll = searchDebounceKey({ query: "q", scope: "all", kind: "all", state: "all" });
    const kPersonal = searchDebounceKey({ query: "q", scope: "personal", kind: "all", state: "all" });
    deb.flush(kAll);
    deb.schedule(kPersonal);
    assert.deepEqual(fired, [kAll]);
    fc.advance(300);
    assert.deepEqual(fired, [kAll, kPersonal]);
  });

  test("inactive→active 模拟：单次 schedule 单次 fire", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    const key = searchDebounceKey({ query: "redis", scope: "all", kind: "all", state: "all" });
    deb.schedule(key);
    fc.advance(300);
    assert.equal(fired.length, 1);
  });

  test("filter 变化重新 schedule 仍只 fire 最新 key", () => {
    const fc = fakeClock();
    const fired: string[] = [];
    const deb = createSearchDebouncer((k) => fired.push(k), 300, fc.clock);
    deb.schedule(searchDebounceKey({ query: "q", scope: "all", kind: "all", state: "all" }));
    fc.advance(100);
    deb.schedule(searchDebounceKey({ query: "q", scope: "notes", kind: "all", state: "all" }));
    fc.advance(300);
    assert.equal(fired.length, 1);
    assert.ok(fired[0].includes("notes"));
  });
});
