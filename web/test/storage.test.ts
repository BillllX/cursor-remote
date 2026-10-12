import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  clearBrowserChatStore,
  forgetActiveChat,
  GROUPS_KEY,
  pushRecent,
  readActiveChat,
  rememberDeleted,
  TOKEN_KEY,
  writeActiveChat,
} from "../lib/chat/storage";

// 这几个键只在 storage.ts 内部用、没有导出；写明字面值也顺带钉住存储格式
const CHATS_KEY = "cursor-remote-chats";
const DELETED_KEY = "cursor-remote-deleted";
const RECENT_KEY = "cursor-remote-recent";
const ACTIVE_KEY = "cursor-remote-active";

/** 只实现被测代码用到的方法；原来的 globalThis.localStorage（Node 默认没有）在 afterEach 里还原 */
function fakeStorage(entries: Record<string, string>, opts: { throws?: boolean } = {}) {
  const data = new Map(Object.entries(entries));
  const guard = () => {
    if (opts.throws) throw new Error("SecurityError");
  };
  return {
    data,
    getItem(key: string) {
      guard();
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      guard();
      data.set(key, value);
    },
    removeItem(key: string) {
      guard();
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

  test("清会话、已删除、最近工作区；登录 token、分组、上次选中的会话留着（每次加载都会调，刷新要能落回原会话）", () => {
    const store = fakeStorage({
      [CHATS_KEY]: "1",
      [DELETED_KEY]: "2",
      [RECENT_KEY]: "3",
      [ACTIVE_KEY]: "4",
      [TOKEN_KEY]: "t",
      [GROUPS_KEY]: "g",
    });
    install(store);
    clearBrowserChatStore();
    assert.deepEqual([...store.data.keys()].sort(), [ACTIVE_KEY, GROUPS_KEY, TOKEN_KEY].sort());
    forgetActiveChat();
    assert.deepEqual([...store.data.keys()].sort(), [GROUPS_KEY, TOKEN_KEY].sort());
  });

  test("存储不可用（隐私模式抛错）时静默", () => {
    install(fakeStorage({}, { throws: true }));
    assert.doesNotThrow(() => clearBrowserChatStore());
    assert.doesNotThrow(() => writeActiveChat("c1"));
    assert.doesNotThrow(() => forgetActiveChat());
    assert.equal(readActiveChat(), "");
  });

  test("readActiveChat / writeActiveChat：写入后能读回，空 id 不覆盖", () => {
    const store = fakeStorage({});
    install(store);
    assert.equal(readActiveChat(), "");
    writeActiveChat("c1");
    assert.equal(readActiveChat(), "c1");
    writeActiveChat("");
    assert.equal(store.data.get(ACTIVE_KEY), "c1");
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

  test("rememberDeleted：满 200 时再记一个已有的 id，只是提到最前，一个也不挤掉", () => {
    const prev = new Set(Array.from({ length: 200 }, (_, i) => `d${i}`));
    const out = rememberDeleted(prev, "d5");
    assert.equal(out.size, 200);
    assert.equal([...out][0], "d5");
    assert.equal(out.has("d199"), true);
    assert.deepEqual([...out].slice(1, 6), ["d0", "d1", "d2", "d3", "d4"]);
  });

  test("rememberDeleted：未满时记已有 id 不改变大小", () => {
    const out = rememberDeleted(new Set(["a", "b", "c"]), "b");
    assert.deepEqual([...out], ["b", "a", "c"]);
  });
});
