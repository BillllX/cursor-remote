import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { WebSocket } from "ws";
import type { HistoryTurn, ServerMessage } from "../../shared/protocol.ts";
import { gatewayState } from "../src/runtime/state.ts";
import type { Conn } from "../src/runtime/types.ts";
import { fitCanvasVersions, fitTurnFiles, fitTurnsFromEnd, frameFor, shrinkMessage } from "../src/ws/frame.ts";

// iOS 在 hello 里声明的单条消息接收上限
const IOS_LIMIT = 900 * 1024;
const CLIPPED_NOTE = "\n\n…（内容过长，这台设备只显示前一部分，完整版见网页端）";

/** frameFor 只读 conns 里的 maxMessageBytes，用假 socket 登记一条连接即可 */
function fakeConn(maxMessageBytes: number): WebSocket {
  const sock = {} as WebSocket;
  gatewayState.conns.set(sock, { maxMessageBytes } as Conn);
  return sock;
}

const ios = fakeConn(IOS_LIMIT);
const web = fakeConn(0);
const unknownSock = {} as WebSocket;
after(() => gatewayState.conns.clear());

const bytes = (text: string) => Buffer.byteLength(text);
const big = (n: number, ch = "x") => ch.repeat(n);

function frameOf(sock: WebSocket, message: ServerMessage) {
  const frame = frameFor(sock, message);
  assert.notEqual(frame, null, "不应被丢弃");
  return { frame: frame as string, parsed: JSON.parse(frame as string) as ServerMessage };
}

describe("frameFor：未声明上限的连接不裁", () => {
  const huge: ServerMessage = { type: "file_content", path: "a.txt", content: big(3 * 1024 * 1024) };
  test("maxMessageBytes=0 的网页连接原样发出", () => {
    assert.equal(frameFor(web, huge), JSON.stringify(huge));
  });
  test("conns 里没有的 socket 也按不限处理", () => {
    assert.equal(frameFor(unknownSock, huge), JSON.stringify(huge));
  });
  test("stored_state 再大也原样发", () => {
    const state: ServerMessage = { type: "stored_state", chats: [{ id: "c", body: big(2 * 1024 * 1024) }] };
    assert.equal(frameFor(web, state), JSON.stringify(state));
  });
});

describe("fitTurnsFromEnd：数组边界计入预算", () => {
  test("预算恰好等于方括号加单条 JSON 时不会意外返回空页", () => {
    const turn = { id: "t", user: "q", assistant: "a" };
    const budget = Buffer.byteLength(JSON.stringify(turn)) + 2;
    assert.deepEqual(fitTurnsFromEnd([turn], budget, 40), [turn]);
  });

  test("history 的超大回合只能 clip，不会标成可 HTTP 回取的 deferred", () => {
    const [turn] = fitTurnsFromEnd([{ id: "t", user: "q", assistant: big(10_000) }], 500, 40) as HistoryTurn[];
    assert.equal(turn.clipped, true);
    assert.equal(turn.deferred, undefined);
  });
});

describe("frameFor：iOS 900KB 上限", () => {
  test("未超限的消息原样发出（含 UTF-16×3 粗估超限但实际字节未超的情况）", () => {
    const small: ServerMessage = { type: "text-delta", chatId: "c", text: "hello" };
    assert.equal(frameFor(ios, small), JSON.stringify(small));
    // 40 万个 ASCII 字符：length×3 > 900KB，但 UTF-8 只有约 400KB
    const ascii: ServerMessage = { type: "text-delta", chatId: "c", text: big(400_000) };
    assert.equal(frameFor(ios, ascii), JSON.stringify(ascii));
  });

  test("file_content 有 url：去掉正文改走 HTTP，其余字段保留", () => {
    const msg: ServerMessage = {
      type: "file_content",
      path: "doc.md",
      kind: "markdown",
      url: "/media/x",
      content: big(2 * 1024 * 1024),
      reqId: "r1",
    };
    const { frame, parsed } = frameOf(ios, msg);
    assert.ok(bytes(frame) <= IOS_LIMIT);
    assert.equal(parsed.type, "file_content");
    if (parsed.type !== "file_content") return;
    assert.equal(parsed.content, undefined);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.url, "/media/x");
    assert.equal(parsed.reqId, "r1");
  });

  test("file_content 纯文本：正文截短并带提示，多字节字符不超限", () => {
    const content = big(800_000, "中");
    const msg: ServerMessage = { type: "file_content", path: "a.txt", kind: "text", content };
    const { frame, parsed } = frameOf(ios, msg);
    assert.ok(bytes(frame) <= IOS_LIMIT);
    if (parsed.type !== "file_content") assert.fail("类型变了");
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.content?.endsWith(CLIPPED_NOTE));
    const kept = parsed.content!.slice(0, -CLIPPED_NOTE.length);
    assert.ok(kept.length > 0 && content.startsWith(kept));
  });

  test("file_content diff：即使 kind 不是 text 也截短正文", () => {
    const msg: ServerMessage = {
      type: "file_content",
      path: "a.png",
      kind: "image",
      diff: true,
      content: big(1_200_000),
    };
    const { parsed } = frameOf(ios, msg);
    if (parsed.type !== "file_content") assert.fail("类型变了");
    assert.ok(parsed.content?.endsWith(CLIPPED_NOTE));
    assert.equal(parsed.error, undefined);
  });

  test("file_content 非文本且没有 url：去掉正文并报“文件太大”", () => {
    const msg: ServerMessage = {
      type: "file_content",
      path: "a.bin",
      kind: "image",
      size: 5_000_000,
      content: big(1_200_000),
    };
    const { parsed } = frameOf(ios, msg);
    if (parsed.type !== "file_content") assert.fail("类型变了");
    assert.equal(parsed.content, undefined);
    assert.equal(parsed.truncated, true);
    assert.match(parsed.error || "", /文件太大/);
  });

  test("search_hits：按预算保留前面的命中，单条正文截到 400 字", () => {
    const hits = Array.from({ length: 5000 }, (_, i) => ({ path: `src/f${i}.ts`, line: i, text: big(600) }));
    const msg: ServerMessage = { type: "search_hits", query: "x", hits };
    const { frame, parsed } = frameOf(ios, msg);
    assert.ok(bytes(frame) <= IOS_LIMIT);
    if (parsed.type !== "search_hits") assert.fail("类型变了");
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.hits.length > 0 && parsed.hits.length < hits.length);
    assert.deepEqual(
      parsed.hits.map((hit) => hit.path),
      hits.slice(0, parsed.hits.length).map((hit) => hit.path),
    );
    assert.ok(parsed.hits.every((hit) => hit.text.length === 401 && hit.text.endsWith("…")));
  });

  test("history：从最后一条往前装，最多 40 条", () => {
    const turns: HistoryTurn[] = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      user: `q${i}`,
      assistant: big(30_000),
    }));
    const msg: ServerMessage = { type: "history", chatId: "c", turns };
    const { frame, parsed } = frameOf(ios, msg);
    assert.ok(bytes(frame) <= IOS_LIMIT);
    if (parsed.type !== "history") assert.fail("类型变了");
    assert.ok(parsed.turns.length > 0 && parsed.turns.length <= 40);
    assert.equal(parsed.turns.at(-1)?.id, "t99");
    const ids = parsed.turns.map((turn) => turn.id);
    assert.deepEqual(
      ids,
      turns.slice(100 - ids.length).map((turn) => turn.id),
    );
  });

  test("history：单条超预算的 turn 截短并打 clipped", () => {
    const turns: HistoryTurn[] = [{ id: "only", user: "q", assistant: big(2 * 1024 * 1024) }];
    const { parsed } = frameOf(ios, { type: "history", chatId: "c", turns });
    if (parsed.type !== "history") assert.fail("类型变了");
    const turn = parsed.turns[0] as HistoryTurn & { clipped?: boolean };
    assert.equal(turn.id, "only");
    assert.equal(turn.clipped, true);
    assert.ok(turn.assistant.endsWith("…（过长已截断）"));
  });

  test("files：截短路径清单并标 truncated，删除状态优先保留", () => {
    const paths = Array.from({ length: 40_000 }, (_, i) => `packages/module-${i}/src/index-${i}.ts`);
    const status: Record<string, string> = { "gone.ts": "D", [paths[0]]: "M" };
    const msg: ServerMessage = { type: "files", query: "", paths, status };
    const { frame, parsed } = frameOf(ios, msg);
    assert.ok(bytes(frame) <= IOS_LIMIT);
    if (parsed.type !== "files") assert.fail("类型变了");
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.paths.length > 0 && parsed.paths.length < paths.length);
    assert.deepEqual(parsed.paths, paths.slice(0, parsed.paths.length));
    assert.equal(parsed.status?.["gone.ts"], "D");
    assert.equal(parsed.status?.[paths[0]], "M");
  });

  test("stored_state / stored_chat / chat_turns 超限直接丢弃，不截正文", () => {
    const body = big(1024 * 1024);
    const dropped: ServerMessage[] = [
      { type: "stored_state", chats: [{ id: "c", body }] },
      { type: "stored_chat", chat: { id: "c", body } },
      { type: "chat_turns", chatId: "c", turns: [{ body }], from: 0, hasMore: false, total: 1 },
    ];
    for (const msg of dropped) {
      assert.equal(frameFor(ios, msg), null, msg.type);
      assert.equal(shrinkMessage(msg, IOS_LIMIT), null, msg.type);
    }
  });

  test("其余类型（如工具结果）逐级截短长字符串，保住消息本身", () => {
    const msg: ServerMessage = {
      type: "tool-completed",
      chatId: "c",
      callId: "k",
      name: "Shell",
      status: "completed",
      result: { stdout: big(2 * 1024 * 1024), exitCode: 0 },
    };
    const { frame, parsed } = frameOf(ios, msg);
    assert.ok(bytes(frame) <= IOS_LIMIT);
    if (parsed.type !== "tool-completed") assert.fail("类型变了");
    assert.equal(parsed.callId, "k");
    const result = parsed.result as { stdout: string; exitCode: number };
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${big(64 * 1024)}…（过长已截断）`);
  });

  test("turn_files / canvas_versions 按完整行裁切，不截坏 path、sha 和来源字段", () => {
    const files = Array.from({ length: 20_000 }, (_, i) => ({
      path: `generated/${i}-${big(80)}.md`,
      kind: "markdown" as const,
      op: "added" as const,
      sha: "a".repeat(64),
      sourceChatId: "child-chat",
      sourceTurnId: "child-turn",
    }));
    const turn = fitTurnFiles({ type: "turn_files", chatId: "parent", turnId: "turn", files }, 20_000);
    assert.ok(turn && turn.files.length > 0 && turn.files.length < files.length);
    assert.deepEqual(turn?.files, files.slice(0, turn.files.length));

    const versions = Array.from({ length: 1000 }, (_, i) => ({
      sha: i.toString(16).padStart(64, "0"),
      htmlSha: "b".repeat(64),
      createdAt: i,
      shareUrl: `https://example.com/${big(100)}/${i}`,
    }));
    const canvas = fitCanvasVersions({ type: "canvas_versions", chatId: "c", path: "a.canvas.tsx", versions }, 20_000);
    assert.ok(canvas.versions.length > 0 && canvas.versions.length < versions.length);
    assert.deepEqual(canvas.versions, versions.slice(0, canvas.versions.length));
  });

  test("字符串截到 1KB 仍超限（海量短字段）就丢弃", () => {
    const msg: ServerMessage = {
      type: "tool-completed",
      chatId: "c",
      callId: "k",
      name: "Shell",
      status: "completed",
      result: Array.from({ length: 200_000 }, (_, i) => `row-${i}`),
    };
    assert.equal(frameFor(ios, msg), null);
  });
});
