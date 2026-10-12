import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  SEGMENT_TURNS,
  bodySummary,
  chatMeta,
  createBodyStore,
  dropRemovedBodies,
  evictBodies,
  hydrateChat,
  isBodyLoaded,
  persistBodies,
  previewOfTurns,
  segmentHashes,
  slimChat,
  type BodyInfo,
} from "../src/chatBodies.ts";

const tmpRoots: string[] = [];
function tempStateDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "chatbodies-test-"));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const identity = (turns: unknown[]) => turns;
const makeTurns = (n: number, tag = "t") =>
  Array.from({ length: n }, (_, i) => ({ user: `${tag}-问${i}`, assistant: `${tag}-答${i}` }));

describe("previewOfTurns", () => {
  test("取最后一条非空 user", () => {
    assert.equal(previewOfTurns([{ user: "第一" }, { user: "第二", assistant: "答" }]), "第二");
  });

  test("跳过只有空白的 user，也跳过非对象条目", () => {
    assert.equal(previewOfTurns([{ user: "有内容" }, { user: "   " }, null, "字符串", 3]), "有内容");
  });

  test("没有 user 时倒序找 assistant", () => {
    assert.equal(previewOfTurns([{ assistant: "早" }, { assistant: "晚" }, { user: "" }]), "晚");
  });

  test("截到 100 个 UTF-16 码元，不 trim 原文", () => {
    const long = ` ${"字".repeat(150)}`;
    const preview = previewOfTurns([{ user: long }]);
    assert.equal(preview.length, 100);
    assert.ok(preview.startsWith(" 字"));
  });

  test("空数组或全空返回空串", () => {
    assert.equal(previewOfTurns([]), "");
    assert.equal(previewOfTurns([{ user: 1 }, { assistant: null }]), "");
  });
});

describe("isBodyLoaded / bodySummary / chatMeta", () => {
  test("非对象或没有 turns 键视为已装载", () => {
    assert.equal(isBodyLoaded(null), true);
    assert.equal(isBodyLoaded("x"), true);
    assert.equal(isBodyLoaded({}), true);
    assert.equal(isBodyLoaded({ turns: [] }), true);
  });

  test("bodySummary：没有 turns 或不是数组时为 null", () => {
    assert.equal(bodySummary(null), null);
    assert.equal(bodySummary({ id: "a" }), null);
    assert.equal(bodySummary({ id: "a", turns: "x" }), null);
    assert.deepEqual(bodySummary({ turns: [{ user: "嗨" }, { assistant: "好" }] }), { count: 2, preview: "嗨" });
  });

  test("chatMeta 去掉 turns，其余字段浅拷贝", () => {
    const nested = { a: 1 };
    const meta = chatMeta({ id: "c", turns: [1], nested });
    assert.deepEqual(Object.keys(meta), ["id", "nested"]);
    assert.equal(meta.nested, nested);
  });
});

describe("persistBodies / hydrateChat 往返", () => {
  test("正文按 SEGMENT_TURNS 分段落盘，文件名是内容 sha1，state 行只留描述", () => {
    const stateDir = tempStateDir();
    const store = createBodyStore(stateDir, identity);
    const turns = makeTurns(SEGMENT_TURNS + 50);
    const [row] = persistBodies(store, [{ id: "c1", title: "标题", turns }]) as Array<Record<string, unknown>>;
    assert.equal("turns" in row, false);
    assert.equal(row.title, "标题");
    const body = row.body as BodyInfo;
    assert.equal(body.count, SEGMENT_TURNS + 50);
    assert.equal(body.preview, `t-问${SEGMENT_TURNS + 49}`);
    assert.equal(body.segs.length, 2);
    for (const [i, hash] of body.segs.entries()) {
      const text = readFileSync(resolve(stateDir, "chats", "c1", `${hash}.json`), "utf8");
      assert.equal(sha1(text), hash);
      assert.equal(Buffer.byteLength(text), body.sizes[i]);
    }
  });

  test("新进程装回：读 turns 前不碰磁盘，读时还原原文并对每段调用 settle", () => {
    const stateDir = tempStateDir();
    const turns = makeTurns(SEGMENT_TURNS * 2 + 1);
    const [row] = persistBodies(createBodyStore(stateDir, identity), [{ id: "c1", turns }]);
    const settled: number[] = [];
    const store = createBodyStore(stateDir, (rows) => {
      settled.push(rows.length);
      return rows;
    });
    const chat = hydrateChat(store, JSON.parse(JSON.stringify(row))) as Record<string, unknown>;
    assert.equal("body" in chat, false);
    assert.equal(isBodyLoaded(chat), false);
    assert.deepEqual(bodySummary(chat), { count: turns.length, preview: `t-问${turns.length - 1}` });
    assert.equal(settled.length, 0);
    assert.deepEqual(chat.turns, turns);
    assert.equal(isBodyLoaded(chat), true);
    assert.deepEqual(settled, [SEGMENT_TURNS, SEGMENT_TURNS, 1]);
  });

  test("没有 id、id 重复、turns 不是数组的会话原样内联", () => {
    const store = createBodyStore(tempStateDir(), identity);
    const rows = persistBodies(store, [
      null,
      { title: "无 id", turns: [{ user: "a" }] },
      { id: "dup", turns: [{ user: "b" }] },
      { id: "dup", turns: [{ user: "c" }] },
      { id: "bad", turns: "不是数组" },
      { id: "meta-only" },
    ]) as Array<Record<string, unknown> | null>;
    assert.equal(rows[0], null);
    assert.deepEqual(rows[1], { title: "无 id", turns: [{ user: "a" }] });
    assert.ok(rows[2]?.body);
    assert.deepEqual(rows[3], { id: "dup", turns: [{ user: "c" }] });
    assert.deepEqual(rows[4], { id: "bad", turns: "不是数组" });
    assert.deepEqual(rows[5], { id: "meta-only" });
  });

  test("判脏靠引用：同样的 turn 对象再写一次不会重写分段", () => {
    const stateDir = tempStateDir();
    const store = createBodyStore(stateDir, identity);
    const turns = makeTurns(3);
    const [row] = persistBodies(store, [{ id: "c1", turns }]) as Array<{ body: BodyInfo }>;
    const seg = resolve(stateDir, "chats", "c1", `${row.body.segs[0]}.json`);
    rmSync(seg);
    persistBodies(store, [{ id: "c1", turns: turns.slice() }]);
    assert.equal(existsSync(seg), false);
  });

  test("只改后一段：前一段哈希不变，写盘后旧分段被清掉", () => {
    const stateDir = tempStateDir();
    const store = createBodyStore(stateDir, identity);
    const turns = makeTurns(SEGMENT_TURNS + 1);
    const chats = [{ id: "c1", turns }];
    const [first] = persistBodies(store, chats) as Array<{ body: BodyInfo }>;
    dropRemovedBodies(store, chats);
    const next = { id: "c1", turns: [...turns.slice(0, SEGMENT_TURNS), { user: "改过", assistant: "" }] };
    const [second] = persistBodies(store, [next]) as Array<{ body: BodyInfo }>;
    assert.equal(second.body.segs[0], first.body.segs[0]);
    assert.notEqual(second.body.segs[1], first.body.segs[1]);
    assert.equal(second.body.preview, "改过");
    dropRemovedBodies(store, [next]);
    const files = readdirSync(resolve(stateDir, "chats", "c1")).sort();
    assert.deepEqual(files, second.body.segs.map((hash) => `${hash}.json`).sort());
  });

  test("id 含路径字符时目录名换成哈希，不会逃出 chats 目录", () => {
    const stateDir = tempStateDir();
    const store = createBodyStore(stateDir, identity);
    const id = "../越界";
    persistBodies(store, [{ id, turns: [{ user: "x" }] }]);
    assert.deepEqual(readdirSync(resolve(stateDir, "chats")), [`x.${sha1(id)}`]);
    assert.equal(existsSync(resolve(stateDir, "越界")), false);
  });

  test("分段损坏：没改动时沿用旧描述；有改动时先把目录复制到 chats-broken/", (t) => {
    const warn = t.mock.method(console, "error", () => {});
    const stateDir = tempStateDir();
    const [row] = persistBodies(createBodyStore(stateDir, identity), [{ id: "c1", turns: makeTurns(2) }]) as Array<{
      body: BodyInfo;
    }>;
    writeFileSync(resolve(stateDir, "chats", "c1", `${row.body.segs[0]}.json`), "坏数据");
    const store = createBodyStore(stateDir, identity);
    const chat = hydrateChat(store, JSON.parse(JSON.stringify(row))) as { id: string; turns: unknown[] };
    assert.deepEqual(chat.turns, []);
    assert.ok(warn.mock.callCount() >= 1);
    const [kept] = persistBodies(store, [chat]) as Array<{ body: BodyInfo }>;
    assert.deepEqual(kept.body, row.body);
    assert.equal(existsSync(resolve(stateDir, "chats-broken")), false);
    chat.turns = [{ user: "新的" }];
    const [rewritten] = persistBodies(store, [chat]) as Array<{ body: BodyInfo }>;
    assert.equal(rewritten.body.count, 1);
    const broken = readdirSync(resolve(stateDir, "chats-broken"));
    assert.equal(broken.length, 1);
    assert.ok(broken[0].startsWith("c1-"));
  });
});

describe("segmentHashes / slimChat", () => {
  test("已装载会话的分段哈希与落盘文件名一致；0 条返回 null", () => {
    const store = createBodyStore(tempStateDir(), identity);
    const chat = { id: "c1", turns: makeTurns(SEGMENT_TURNS + 1) };
    const [row] = persistBodies(store, [chat]) as Array<{ body: BodyInfo }>;
    assert.deepEqual(segmentHashes(store, chat), row.body.segs);
    assert.equal(segmentHashes(store, { id: "e", turns: [] }), null);
    assert.equal(segmentHashes(store, { id: "n" }), null);
    assert.equal(segmentHashes(store, null), null);
  });

  test("没装回的会话直接用描述里的哈希，不读磁盘", () => {
    const stateDir = tempStateDir();
    const [row] = persistBodies(createBodyStore(stateDir, identity), [{ id: "c1", turns: makeTurns(1) }]) as Array<{
      body: BodyInfo;
    }>;
    rmSync(resolve(stateDir, "chats"), { recursive: true });
    const store = createBodyStore(stateDir, identity);
    const chat = hydrateChat(store, JSON.parse(JSON.stringify(row)));
    assert.deepEqual(segmentHashes(store, chat), row.body.segs);
    assert.equal(isBodyLoaded(chat), false);
  });

  test("slimChat 丢掉草稿和客户端写回的 preview，换成服务端算的预览和分段哈希", () => {
    const store = createBodyStore(tempStateDir(), identity);
    const turns = [{ user: "真预览" }];
    const slim = slimChat(store, { id: "c1", title: "t", draft: "d", draftImages: [1], preview: "旧值", turns });
    assert.deepEqual(slim, { id: "c1", title: "t", preview: "真预览", segHashes: [sha1(JSON.stringify(turns))] });
  });

  test("slimChat：空会话给 turns: []，非对象原样返回", () => {
    const store = createBodyStore(tempStateDir(), identity);
    assert.deepEqual(slimChat(store, { id: "c1", preview: "旧值", turns: [] }), { id: "c1", turns: [] });
    assert.deepEqual(slimChat(store, { id: "c2" }), { id: "c2", turns: [] });
    assert.equal(slimChat(store, 7), 7);
  });
});

describe("dropRemovedBodies / evictBodies", () => {
  test("删掉已不存在会话的目录，首次还会清掉上次崩溃遗留的陌生目录", () => {
    const stateDir = tempStateDir();
    const store = createBodyStore(stateDir, identity);
    mkdirSync(resolve(stateDir, "chats", "stray"), { recursive: true });
    const a = { id: "a", turns: makeTurns(1) };
    const b = { id: "b", turns: makeTurns(1) };
    persistBodies(store, [a, b]);
    dropRemovedBodies(store, [a]);
    assert.deepEqual(readdirSync(resolve(stateDir, "chats")), ["a"]);
  });

  test("超过常驻条数时换出最久没用的会话，再读能从磁盘装回", () => {
    const store = createBodyStore(tempStateDir(), identity);
    const chats = Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, turns: makeTurns(1, `c${i}`) }));
    const rows = persistBodies(store, chats);
    evictBodies(store, chats, rows);
    const evicted = chats.filter((chat) => !isBodyLoaded(chat)).map((chat) => chat.id);
    assert.deepEqual(evicted.sort(), ["c0", "c1"]);
    assert.deepEqual(chats[0].turns, makeTurns(1, "c0"));
    assert.equal(isBodyLoaded(chats[0]), true);
  });
});
