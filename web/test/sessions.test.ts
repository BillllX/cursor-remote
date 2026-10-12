import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatMeta, mergeSlimChats, metaKey, shortPadTitle, stopOrphanRuns, usableDraft } from "../lib/chat/sessions";
import type { Chat, Turn } from "../lib/chat/types";

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "t1",
  user: "hi",
  assistant: "",
  thinking: "",
  tools: [],
  running: false,
  ...over,
});
const chat = (over: Partial<Chat> = {}): Chat => ({ id: "c1", title: "标题", turns: [], ...over });

describe("mergeSlimChats", () => {
  test("本地没有的服务端会话：正文为空，记下对齐快照", () => {
    const synced = new Map<string, string>();
    const out = mergeSlimChats([], [chat({ id: "a", title: "A", preview: "最后一条" })], new Set(), synced);
    assert.deepEqual(out, [{ id: "a", title: "A", preview: "最后一条", turns: [] }]);
    assert.equal(synced.get("a"), JSON.stringify({ id: "a", title: "A" }));
  });

  test("服务端标题不是字符串时回落为“新对话”；草稿与 runMark 不跟网关走", () => {
    const row = { id: "a", title: 42, draft: "旧草稿", draftImages: [], runMark: 3 } as unknown as Chat;
    const out = mergeSlimChats([], [row], new Set(), new Map());
    assert.deepEqual(out, [{ id: "a", title: "新对话", turns: [] }]);
  });

  test("跳过非法行、已删除的和重复 id（先到的为准）", () => {
    const remote = [
      null,
      { title: "无 id" },
      chat({ id: "gone" }),
      chat({ id: "a", title: "第一个" }),
      chat({ id: "a", title: "第二个" }),
    ] as unknown as Chat[];
    const out = mergeSlimChats([], remote, new Set(["gone"]), new Map());
    assert.deepEqual(
      out.map((c) => [c.id, c.title]),
      [["a", "第一个"]],
    );
  });

  test("本地没改过（快照一致）：元数据跟服务端，正文和草稿留本地", () => {
    const local = chat({ id: "a", title: "旧", turns: [turn()], draft: "写了一半" });
    const synced = new Map([["a", metaKey(local)]]);
    const out = mergeSlimChats([local], [chat({ id: "a", title: "新", model: "m2" })], new Set(), synced);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "新");
    assert.equal(out[0].model, "m2");
    assert.equal(out[0].turns, local.turns);
    assert.equal(out[0].draft, "写了一半");
    assert.equal(synced.get("a"), metaKey(out[0]));
  });

  test("本地改过：三方合并，只保留本地改过的字段", () => {
    const before = chat({ id: "a", title: "旧", model: "m1", cwd: "/w" });
    const local = chat({ id: "a", title: "我改的", model: "m1", cwd: "/w", turns: [turn()] });
    const remote = chat({ id: "a", title: "旧", model: "m2", cwd: "/w", preview: "p" });
    const synced = new Map([["a", metaKey(before)]]);
    const [out] = mergeSlimChats([local], [remote], new Set(), synced);
    assert.equal(out.title, "我改的");
    assert.equal(out.model, "m2");
    assert.equal(out.preview, "p");
    assert.equal(out.turns, local.turns);
    // 快照记的是服务端版本：本地仍算“改过”，下一轮上传
    assert.equal(synced.get("a"), metaKey({ ...remote, turns: [] }));
  });

  test("本地删掉的字段在三方合并里也删掉", () => {
    const before = chat({ id: "a", cwd: "/w", model: "m1" });
    const local = chat({ id: "a", model: "m1" });
    const remote = chat({ id: "a", cwd: "/w", model: "m1" });
    const [out] = mergeSlimChats([local], [remote], new Set(), new Map([["a", metaKey(before)]]));
    assert.equal("cwd" in out, false);
  });

  test("本地有、从没对齐过：本地元数据优先，补上 preview 和缺的 agentId，不记快照", () => {
    const local = chat({ id: "a", title: "本地", turns: [turn()] });
    const synced = new Map<string, string>();
    const [out] = mergeSlimChats(
      [local],
      [chat({ id: "a", title: "远端", preview: "p", agentId: "ag" })],
      new Set(),
      synced,
    );
    assert.equal(out.title, "本地");
    assert.equal(out.preview, "p");
    assert.equal(out.agentId, "ag");
    assert.equal(synced.has("a"), false);
  });

  test("只在本地的会话：没对齐过的保留在末尾；对齐过的、boot、已删除的丢掉", () => {
    const fresh = chat({ id: "fresh" });
    const out = mergeSlimChats(
      [fresh, chat({ id: "old" }), chat({ id: "boot" }), chat({ id: "del" })],
      [chat({ id: "r" })],
      new Set(["del"]),
      new Map([["old", "{}"]]),
    );
    assert.deepEqual(
      out.map((c) => c.id),
      ["r", "fresh"],
    );
  });
});

describe("chatMeta / metaKey", () => {
  test("去掉正文、preview、草稿和服务端字段，previewTabs 只留 path/line", () => {
    const raw = {
      ...chat({ turns: [turn()], preview: "p", draft: "d", draftImages: [] }),
      runMark: 1,
      clipped: true,
      previewTabs: [{ path: "a.ts", line: 3, extra: 1 }],
    } as unknown as Chat;
    assert.deepEqual(chatMeta(raw), { id: "c1", title: "标题", previewTabs: [{ path: "a.ts", line: 3 }] });
  });

  test("metaKey 与正文无关", () => {
    assert.equal(metaKey(chat({ turns: [turn()] })), metaKey(chat()));
  });
});

describe("stopOrphanRuns", () => {
  test("还在跑/排队的回合收尾为 cancelled，跑着的工具标成 error", () => {
    const running = turn({ running: true, tools: [{ callId: "x", name: "Shell", status: "running" }] });
    const [out] = stopOrphanRuns([chat({ turns: [running, turn({ id: "t2" })] })]);
    assert.equal(out.turns[0].running, false);
    assert.equal(out.turns[0].status, "cancelled");
    assert.equal(out.turns[0].tools[0].status, "error");
  });

  test("keepIds 里的会话原样返回", () => {
    const keep = chat({ id: "k", turns: [turn({ running: true })] });
    const [out] = stopOrphanRuns([keep], ["k"]);
    assert.equal(out, keep);
  });
});

describe("usableDraft / shortPadTitle", () => {
  test("草稿和某条已发出的用户消息相同就不再恢复", () => {
    assert.equal(usableDraft({ draft: " 你好 ", turns: [{ user: "你好" }] }), "");
    assert.equal(usableDraft({ draft: " 新的 ", turns: [{ user: "你好" }] }), " 新的 ");
  });

  test("短标题：中文首句优先（去掉 @ 引用），否则取标题最后一段，超长截断", () => {
    assert.equal(shortPadTitle(undefined), "新对话");
    assert.equal(shortPadTitle("x", "看看 @src/a.ts 这个文件"), "看看 这个文件");
    assert.equal(shortPadTitle("web/components/chat-"), "chat");
    assert.equal(shortPadTitle("a".repeat(40)), `${"a".repeat(32)}…`);
  });
});
