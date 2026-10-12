import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearBrowserChatStore, GROUPS_KEY, pushRecent, rememberDeleted, TOKEN_KEY } from "../lib/chat/storage";

// 这三个键只在 storage.ts 内部用、没有导出；写明字面值也顺带钉住存储格式
const CHATS_KEY = "cursor-remote-chats";
const DELETED_KEY = "cursor-remote-deleted";
const RECENT_KEY = "cursor-remote-recent";

/** 只实现被测代码用到的 removeItem；原来的 globalThis.localStorage（Node 默认没有）在 afterEach 里还原 */
function fakeStorage(entries: Record<string, string>, opts: { throws?: boolean } = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    removeItem(key: string) {
      if (opts.throws) throw new Error("SecurityError");
      data.delete(key);
    },
  };
}

describe("clearBrowserChatStore", () => {
  let saved: PropertyDescriptor | undefined;
  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  const install = (store: ReturnType<typeof fakeStorage>) =>
    Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true, writable: true });

  test("清会话、已删除、最近工作区；登录 token 和分组留着", () => {
    const store = fakeStorage({
      [CHATS_KEY]: "1",
      [DELETED_KEY]: "2",
      [RECENT_KEY]: "3",
      [TOKEN_KEY]: "t",
      [GROUPS_KEY]: "g",
    });
    install(store);
    clearBrowserChatStore();
    assert.deepEqual([...store.data.keys()].sort(), [GROUPS_KEY, TOKEN_KEY].sort());
  });

  test("存储不可用（隐私模式抛错）时静默", () => {
    install(fakeStorage({}, { throws: true }));
    assert.doesNotThrow(() => clearBrowserChatStore());
  });
});

describe("pushRecent / rememberDeleted", () => {
  test("pushRecent：提到最前、去重、最多 8 个；空白路径原样返回", () => {
    assert.deepEqual(pushRecent(["a", "b"], "b"), ["b", "a"]);
    const prev = ["a"];
    assert.equal(pushRecent(prev, "  "), prev);
    const many = Array.from({ length: 10 }, (_, i) => `p${i}`);
    assert.deepEqual(pushRecent(many, "new"), ["new", "p0", "p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  test("rememberDeleted：新 id 在最前，最多 200 个", () => {
    const prev = new Set(Array.from({ length: 200 }, (_, i) => `d${i}`));
    const out = rememberDeleted(prev, "x");
    assert.equal(out.size, 200);
    assert.equal([...out][0], "x");
    assert.equal(out.has("d199"), false);
  });

  test("rememberDeleted：满 200 时再记一个已有的 id，会多挤掉一个（现状）", () => {
    const prev = new Set(Array.from({ length: 200 }, (_, i) => `d${i}`));
    const out = rememberDeleted(prev, "d5");
    assert.equal(out.size, 199);
    assert.equal([...out][0], "d5");
    assert.equal(out.has("d199"), false);
  });
});
