import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { WebSocket } from "ws";
import type { ImConvRow, ImMessage, ServerMessage } from "../../shared/protocol.ts";
import { decodeCursor } from "../src/im/listCursor.ts";
import { gatewayState } from "../src/runtime/state.ts";
import type { Conn } from "../src/runtime/types.ts";
import { frameFor, shrinkMessage } from "../src/ws/frame.ts";

const IOS_LIMIT = 900 * 1024;
const ios = {} as WebSocket;
gatewayState.conns.set(ios, { maxMessageBytes: IOS_LIMIT } as Conn);
after(() => gatewayState.conns.delete(ios));

const ticket = { exp: 1, sig: "s" };
const msg = (seq: number, text: string): ImMessage => ({
  convId: "dm~a~b",
  seq,
  from: "a",
  at: seq,
  kind: "text",
  body: { text },
  clientId: `c${seq}`,
});

describe("shrinkMessage：im_history", () => {
  const history = (after?: number): Extract<ServerMessage, { type: "im_history" }> => ({
    type: "im_history",
    convId: "dm~a~b",
    messages: Array.from({ length: 50 }, (_, i) => msg(i + 1, "字".repeat(8000))),
    more: false,
    ticket,
    ...(after !== undefined ? { after } : {}),
  });

  test("默认翻页：从最旧的开始丢，more=true，留下的是最新的连续一段", () => {
    const frame = frameFor(ios, history());
    assert.ok(frame);
    assert.ok(Buffer.byteLength(frame) <= IOS_LIMIT);
    const out = JSON.parse(frame) as Extract<ServerMessage, { type: "im_history" }>;
    assert.equal(out.more, true);
    assert.ok(out.messages.length > 0 && out.messages.length < 50);
    assert.equal(out.messages.at(-1)?.seq, 50);
    const seqs = out.messages.map((m) => m.seq);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, i) => 51 - seqs.length + i),
    );
  });

  test("after 翻页：从最新的开始丢，接着 after=最后一条还能拿到丢掉的", () => {
    const out = shrinkMessage(history(0), 300_000) as Extract<ServerMessage, { type: "im_history" }>;
    assert.equal(out.more, true);
    assert.equal(out.messages[0].seq, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 300_000);
  });

  test("没超限的原样发出", () => {
    const small: ServerMessage = {
      type: "im_history",
      convId: "dm~a~b",
      messages: [msg(1, "hi")],
      more: false,
      ticket,
    };
    assert.equal(frameFor(ios, small), JSON.stringify(small));
  });
});

describe("shrinkMessage：im_list", () => {
  const row = (i: number, text: string): ImConvRow => ({
    convId: `dm~a~u${i}`,
    peer: `u${i}`,
    last: msg(i, text),
    unread: 1,
    readSeq: 0,
    maxSeq: i,
    pin: false,
    mute: false,
    hideBefore: 0,
    ticket,
  });

  type ImList = Extract<ServerMessage, { type: "im_list" }>;
  const list = (count: number, more = false): ImList => ({
    type: "im_list",
    convs: Array.from({ length: count }, (_, i) => row(i + 1, "字".repeat(2700))),
    blocked: [],
    more,
  });

  test("截短 last 正文就装得下：会话行一个不少，more 不变", () => {
    const frame = frameFor(ios, list(200));
    assert.ok(frame);
    const out = JSON.parse(frame) as ImList;
    assert.equal(out.convs.length, 200);
    assert.equal(out.more, false);
    assert.equal(out.cursor, undefined);
    const text = (out.convs[0].last?.body as { text: string }).text;
    assert.ok(text.length < 200 && text.startsWith("字"));
  });

  test("截短还不够：保留前面装得下的行，more=true，cursor 指向最后保留那行", () => {
    const budget = 40 * 1024;
    const out = shrinkMessage(list(100, false), budget) as ImList;
    assert.ok(out);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= budget);
    assert.ok(out.convs.length > 0 && out.convs.length < 100);
    assert.deepEqual(
      out.convs.map((item) => item.convId),
      list(out.convs.length).convs.map((item) => item.convId),
    );
    assert.equal(out.more, true);
    const last = out.convs.at(-1)!;
    assert.deepEqual(decodeCursor(out.cursor ?? ""), { pin: last.pin, at: last.last?.at, convId: last.convId });
  });

  test("一行都装不下才放弃", () => {
    assert.equal(shrinkMessage(list(3), 200), null);
  });
});
