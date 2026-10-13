import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { ClientMessage, ImBody, ServerMessage } from "../../shared/protocol.ts";
import type { ApnsMessage } from "../src/assistant/apns.ts";
import { ImError } from "../src/im/errors.ts";
import { finishUpload } from "../src/im/http.ts";
import { dmConvId, type ImPeer } from "../src/im/ids.ts";
import { decodeCursor } from "../src/im/listCursor.ts";
import { ImService, RATE_LIMIT_PER_MIN, type ImLiveConn } from "../src/im/service.ts";
import { CLIENT_IDS_PER_CONV, Coalesced, ImStore, UNREAD_CAP } from "../src/im/store.ts";

const root = mkdtempSync(join(tmpdir(), "cr-im-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const AB = dmConvId("alice", "bob");
const SECRET = "im-test-secret";
const SHA = (ch: string) => ch.repeat(64);
type Send = Extract<ClientMessage, { type: "im_send" }>;

let dirCount = 0;

/** 每个用例一份独立的状态目录、假连接和推送记录；alice、bob、erin、fred 正式，carol、dave 是验收账号 */
function setup() {
  const dir = resolve(root, `case-${(dirCount += 1)}`);
  const clock = { now: 1_800_000_000_000 };
  const conns: Array<ImLiveConn & { got: ServerMessage[] }> = [];
  const pushes: Array<{ to: string; message: ApnsMessage }> = [];
  const tenants: ImPeer[] = [
    { id: "alice", name: "Alice" },
    { id: "bob", name: "Bob" },
    { id: "carol", name: "Carol", imHidden: true },
    { id: "dave", name: "Dave", imHidden: true },
    { id: "erin", name: "Erin" },
    { id: "fred", name: "Fred" },
  ];
  const makeStore = () => new ImStore(dir, (id) => resolve(dir, "tenants", id), { retryMs: 20 });
  const make = (store = makeStore()) =>
    new ImService({
      store,
      tenants: () => tenants,
      secret: () => SECRET,
      conns: () => conns,
      push: (to, message) => pushes.push({ to, message }),
      now: () => clock.now,
    });
  const connect = (tenantId: string, foreground = true) => {
    const got: ServerMessage[] = [];
    const conn = { key: Symbol(tenantId), tenantId, foreground, got, send: (m: ServerMessage) => void got.push(m) };
    conns.push(conn);
    return conn;
  };
  let n = 0;
  const text = (to: string, words: string, extra: Partial<Send> = {}): Send => ({
    type: "im_send",
    clientId: `c${(n += 1)}`,
    to,
    kind: "text",
    body: { text: words },
    ...extra,
  });
  const store = makeStore();
  return { dir, clock, conns, pushes, tenants, make, makeStore, connect, text, store, service: make(store) };
}

async function failure(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof ImError, String(err));
    return { code: err.code, message: err.message };
  }
  assert.fail("应该抛错");
}

const code = async (work: Promise<unknown>) => (await failure(work)).code;

const ofType = <T extends ServerMessage["type"]>(list: ServerMessage[], type: T) =>
  list.filter((item): item is Extract<ServerMessage, { type: T }> => item.type === type);

const segLines = (dir: string, convId: string, seg = "00000.jsonl") =>
  readFileSync(resolve(dir, "im/conversations", convId, seg), "utf8")
    .trim()
    .split("\n");

const imageSend = (clientId: string, to: string, blob: string, thumb: string): Send => ({
  type: "im_send",
  clientId,
  to,
  kind: "image",
  body: { blob, thumb, w: 1, h: 1, original: false },
});

/** 直接存附件：图片 + 缩略图（alice 上传） */
async function putImage(store: ImStore, now: number, blob = SHA("a"), thumb = SHA("b"), uploader = "alice") {
  await store.putBlob(blob, Buffer.from("img"), "image/png", "image", uploader, now);
  await store.putBlob(thumb, Buffer.from("th"), "image/jpeg", "thumb", uploader, now);
}

describe("联系人与可见性", () => {
  test("正式用户看不到验收账号，验收账号之间互相可见；昵称缺省是租户名", async () => {
    const { service } = setup();
    const a = await service.contacts("alice");
    assert.deepEqual(a.me, { id: "alice", nickname: "Alice", notifyPreview: false });
    assert.deepEqual(
      a.users.map((u) => u.id),
      ["bob", "erin", "fred"],
    );
    assert.deepEqual(
      (await service.contacts("carol")).users.map((u) => u.id),
      ["dave"],
    );
    assert.ok(a.avatarTicket.sig && a.avatarTicket.exp > 0);
  });

  test("给不可见或不存在的人发、拉黑都回 not_visible", async () => {
    const { service, text } = setup();
    assert.equal(await code(service.send("alice", null, text("carol", "hi"))), "not_visible");
    assert.equal(await code(service.send("alice", null, text("nobody", "hi"))), "not_visible");
    assert.equal(await code(service.send("alice", null, text("alice", "hi"))), "not_visible");
    assert.equal(
      await code(service.block("alice", null, { type: "im_block", tenantId: "carol", on: true })),
      "not_visible",
    );
    assert.equal(await code(service.history("carol", { type: "im_history", convId: AB })), "not_found");
  });
});

describe("发送", () => {
  test("seq 递增；双方在线连接收到 im_message，发件连接只收 ack", async () => {
    const { service, connect, text } = setup();
    const a1 = connect("alice");
    const a2 = connect("alice");
    const b1 = connect("bob");
    const c1 = connect("carol");
    const first = await service.send("alice", a1.key, text("bob", "你好"));
    const second = await service.send("bob", b1.key, { ...text("alice", "在"), to: undefined, convId: AB });
    assert.equal(first.convId, AB);
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.deepEqual(
      ofType(a1.got, "im_message").map((m) => m.message.seq),
      [2],
    );
    assert.deepEqual(
      ofType(a2.got, "im_message").map((m) => m.message.seq),
      [1, 2],
    );
    assert.deepEqual(
      ofType(b1.got, "im_message").map((m) => m.message.seq),
      [1],
    );
    assert.equal(c1.got.length, 0);
    const msg = ofType(b1.got, "im_message")[0];
    assert.deepEqual(msg.message.body, { text: "你好" });
    assert.ok(msg.ticket.sig);
  });

  test("并发发送：seq 不重不漏，同一 clientId 并发重发只存一条", async () => {
    const { service, text, dir } = setup();
    const sends: Promise<{ seq: number; clientId: string }>[] = [];
    for (let i = 0; i < 25; i += 1) {
      sends.push(service.send("alice", null, text("bob", `a${i}`)));
      sends.push(service.send("bob", null, text("alice", `b${i}`)));
    }
    const dup = text("bob", "并发重发");
    sends.push(service.send("alice", null, dup), service.send("alice", null, dup));
    const acks = await Promise.all(sends);
    const seqs = [...new Set(acks.map((ack) => ack.seq))].sort((a, b) => a - b);
    assert.deepEqual(
      seqs,
      Array.from({ length: 51 }, (_, i) => i + 1),
    );
    assert.equal(acks.at(-1)?.seq, acks.at(-2)?.seq);
    const lines = segLines(dir, AB).map((line) => JSON.parse(line) as { seq: number });
    assert.deepEqual(
      lines.map((row) => row.seq),
      seqs,
    );
  });

  test("同一 clientId 重发：不再写入，回之前的 ack；重新投递给在线的对方（客户端按 convId+seq 去重）", async () => {
    const { service, connect, text, dir } = setup();
    const b1 = connect("bob");
    const req = text("bob", "只存一条");
    const ack1 = await service.send("alice", null, req);
    const ack2 = await service.send("alice", null, { ...req, body: { text: "改了也不算" } });
    assert.deepEqual(ack2, ack1);
    const got = ofType(b1.got, "im_message");
    assert.equal(got.length, 2);
    assert.deepEqual(got[1].message, got[0].message);
    assert.equal(segLines(dir, AB).length, 1);
    // 不同发件人用同一个 clientId 互不影响
    assert.equal((await service.send("bob", null, { ...text("alice", "x"), clientId: req.clientId })).seq, 2);
  });

  test("限流：每人每分钟 30 条，重发不计数，一分钟后恢复", async () => {
    const { service, text, clock } = setup();
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i += 1) await service.send("alice", null, text("bob", `第 ${i} 条`));
    const req = text("bob", "超了");
    assert.equal(await code(service.send("alice", null, req)), "rate_limited");
    assert.equal((await service.send("bob", null, text("alice", "别人不受影响"))).seq, RATE_LIMIT_PER_MIN + 1);
    clock.now += 60_001;
    assert.equal((await service.send("alice", null, req)).seq, RATE_LIMIT_PER_MIN + 2);
  });

  test("replyTo 必须是本会话里自己看得见的 seq；附件必须存在", async () => {
    const { service, text } = setup();
    await service.send("alice", null, text("bob", "1"));
    assert.equal((await service.send("alice", null, text("bob", "回复", { replyTo: 1 }))).seq, 2);
    assert.equal(await code(service.send("alice", null, text("bob", "回复", { replyTo: 9 }))), "bad_body");
    assert.equal(await code(service.send("alice", null, imageSend("img-1", "bob", SHA("a"), SHA("b")))), "not_found");
  });
});

describe("热路径不读历史（评审 1）", () => {
  test("会话热起来之后：发送、列表、未读、角标、推送都不读分段文件", async () => {
    const { service, store, text, connect } = setup();
    for (let i = 0; i < 5; i += 1) await service.send("alice", null, text("bob", `预热 ${i}`));
    await service.list("bob");
    connect("bob", false);
    const before = store.segmentReads;
    for (let i = 0; i < 10; i += 1) await service.send("alice", null, text("bob", `热 ${i}`));
    await service.send("bob", null, text("alice", "回"));
    const list = await service.list("bob");
    assert.equal(list.convs[0].unread, 15);
    assert.equal(await service.badge("bob"), 15);
    assert.equal(await service.unread("alice", AB), 1);
    assert.equal(store.segmentReads, before);
  });

  test("meta.json 只存有界小字段：每发一条不重写无界数据（发 300 条后大小不变）", async () => {
    const { service, text, dir, clock, make } = setup();
    const metaFile = resolve(dir, "im/conversations", AB, "meta.json");
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    const sizes: number[] = [];
    for (let i = 1; i <= 300; i += 1) {
      await service.send(i % 3 ? "alice" : "bob", null, text(i % 3 ? "bob" : "alice", `#${i}`));
      if (i === 100 || i === 300) sizes.push(readFileSync(metaFile).length);
      clock.now += 2_001;
    }
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    assert.deepEqual(Object.keys(meta).sort(), [
      "convId",
      "createdAt",
      "lastIncoming",
      "maxSeq",
      "members",
      "visibleMax",
    ]);
    assert.equal(meta.maxSeq, 300);
    assert.deepEqual(meta.visibleMax, { alice: 300, bob: 300 });
    assert.deepEqual(meta.lastIncoming, { alice: 300, bob: 0 });
    assert.ok(sizes[1] - sizes[0] <= 3, `meta.json 随消息数增长：${sizes.join(" → ")}`);
    assert.ok(sizes[1] < 200);
    // 被拒收的 200 条只在内存索引里（重启从 jsonl 重建）
    const restarted = make();
    assert.equal((await restarted.list("bob")).convs[0].maxSeq, 300);
    assert.equal(await restarted.unread("bob", AB), 0);
    assert.equal(await restarted.unread("alice", AB), 100);
  });

  test("连续被拒收时 visibleMax 是 O(1)：存在 meta 里，发送时增量更新", async () => {
    const { store, clock, service } = setup();
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    const conv = await store.serial(AB, () => store.ensure(AB, ["alice", "bob"], clock.now));
    await store.serial(AB, () =>
      store.append(conv, { from: "bob", at: clock.now, kind: "text", body: { text: "先说" }, clientId: "b0" }),
    );
    for (let i = 1; i <= 3000; i += 1) {
      await store.serial(AB, () =>
        store.append(conv, {
          from: "alice",
          at: clock.now + i,
          kind: "text",
          body: { text: `#${i}` },
          clientId: `k${i}`,
          rejectedFor: ["bob"],
        }),
      );
    }
    assert.equal(conv.meta.visibleMax.bob, 1);
    assert.equal(store.visibleMax(conv, "bob"), 1);
    assert.equal(store.visibleMax(conv, "alice"), 3001);
    const started = performance.now();
    let sum = 0;
    for (let i = 0; i < 200_000; i += 1) sum += store.visibleMax(conv, "bob");
    assert.equal(sum, 200_000);
    // 逐个往回找的话 20 万次 × 3000 = 6 亿次比较，远超这个时间
    assert.ok(performance.now() - started < 200, `visibleMax 太慢：${performance.now() - started}ms`);
    assert.equal(await store.isHidden(conv, "bob", 1500), true);
    assert.equal(await store.isHidden(conv, "bob", 1), false);
    assert.equal(await store.anyVisible(conv, "bob", 2, 3001), false);
    assert.equal(await store.anyVisible(conv, "bob", 1, 3001, true), true);
  });

  test("冷启动重建是懒的、异步分段的：首次打开时才扫，扫的期间事件循环照常转", async () => {
    const { store, make, makeStore, clock } = setup();
    const conv = await store.serial(AB, () => store.ensure(AB, ["alice", "bob"], clock.now));
    for (let i = 1; i <= 3500; i += 1) {
      await store.serial(AB, () =>
        store.append(conv, {
          from: "alice",
          at: clock.now + i,
          kind: "text",
          body: { text: `#${i}` },
          clientId: `k${i}`,
        }),
      );
    }
    const cold = makeStore();
    await cold.ready();
    assert.equal(cold.segmentReads, 0);
    const immediates = { n: 0 };
    const spin = () => {
      immediates.n += 1;
      if (immediates.n < 1000) setImmediate(spin);
    };
    setImmediate(spin);
    const opened = await cold.open(AB);
    assert.ok(opened);
    // 从尾段往前：bob 收满 1000 条未读就停；alice 没收到过消息，不用扫（第 0、1 段不读）
    assert.equal(cold.segmentReads, 2);
    assert.ok(immediates.n >= 2, `重建期间事件循环没转：${immediates.n}`);
    assert.equal(await make(cold).unread("bob", AB), 1000);
    assert.equal(await make(cold).unread("alice", AB), 0);
  });
});

describe("用户状态落盘（复审 1、4）", () => {
  const read = (dir: string, file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8"));

  test("拉黑、置顶、免打扰、清空、已读、资料、notifyPreview：await 返回时已经落盘（不用 flush）", async () => {
    const { service, text, dir } = setup();
    await service.send("alice", null, text("bob", "1"));
    await service.send("alice", null, text("bob", "2"));
    await service.block("bob", null, { type: "im_block", tenantId: "erin", on: true });
    assert.deepEqual(read(dir, "tenants/bob/im.json").blocked, ["erin"]);
    await service.settings("bob", null, { type: "im_settings", convId: AB, pin: true, mute: true });
    assert.equal(read(dir, "tenants/bob/im.json").convs[AB].mute, true);
    await service.read("bob", null, { type: "im_read", convId: AB, seq: 1 });
    assert.equal(read(dir, "tenants/bob/im.json").convs[AB].readSeq, 1);
    await service.settings("bob", null, { type: "im_settings", convId: AB, hideBefore: 2 });
    assert.equal(read(dir, "tenants/bob/im.json").convs[AB].hideBefore, 2);
    await service.profile("bob", null, { type: "im_profile", nickname: "鲍勃", notifyPreview: true });
    assert.equal(read(dir, "im/profiles.json").bob.nickname, "鲍勃");
    assert.equal(read(dir, "tenants/bob/im.json").notifyPreview, true);
  });

  test("广播在落盘之后：其他设备收到 im_update 时文件里已经是新值", async () => {
    const { service, connect, text, dir } = setup();
    await service.send("alice", null, text("bob", "1"));
    const seen: unknown[] = [];
    const b2 = connect("bob");
    b2.send = (message) => void seen.push([message.type, read(dir, "tenants/bob/im.json")]);
    await service.read("bob", null, { type: "im_read", convId: AB, seq: 1 });
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    const [readSeen, blockSeen] = seen as Array<
      [string, { convs: Record<string, { readSeq: number }>; blocked: string[] }]
    >;
    assert.equal(readSeen[1].convs[AB].readSeq, 1);
    assert.deepEqual(blockSeen[1].blocked, ["alice"]);
  });

  test("已读不裁剪会话索引：im.json 停在读之前（崩溃）重启后未读回到 2，写上了就是 0", async () => {
    const { service, text, dir, make } = setup();
    await service.send("alice", null, text("bob", "1"));
    await service.send("alice", null, text("bob", "2"));
    await service.settings("bob", null, { type: "im_settings", convId: AB, pin: true });
    const userFile = resolve(dir, "tenants/bob/im.json");
    const stale = readFileSync(userFile, "utf8");
    await service.read("bob", null, { type: "im_read", convId: AB, seq: 2 });
    assert.equal(await make().unread("bob", AB), 0);
    writeFileSync(userFile, stale);
    assert.equal(await make().unread("bob", AB), 2);
  });

  test("写失败：回错误（WS 层回 internal）、内存保留改动、自动重试后落盘", async () => {
    const { service, dir } = setup();
    const userFile = resolve(dir, "tenants/bob/im.json");
    mkdirSync(userFile, { recursive: true });
    await assert.rejects(service.block("bob", null, { type: "im_block", tenantId: "alice", on: true }));
    assert.deepEqual((await service.list("bob")).blocked, ["alice"]);
    rmSync(userFile, { recursive: true });
    for (let i = 0; i < 50 && !existsSync(userFile); i += 1) await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(read(dir, "tenants/bob/im.json").blocked, ["alice"]);
  });

  test("整个进程只挂一个 exit 监听；close() 后不再参与退出补写", async () => {
    const { makeStore } = setup();
    const before = process.listenerCount("exit");
    const stores = Array.from({ length: 20 }, () => makeStore());
    for (const store of stores) {
      store.setProfile("alice", { nickname: "x" }).catch(() => undefined);
      await store.flush();
    }
    assert.ok(process.listenerCount("exit") - before <= 1);
    for (const store of stores) store.close();
  });
});

describe("被拉黑隐藏的消息不能被探测（评审 2）", () => {
  test("replyTo / recall / read / hideBefore：隐藏的 seq 与不存在的 seq 同错误码同文案，上限按自己可见的 maxSeq", async () => {
    const { service, text, connect } = setup();
    await service.send("alice", null, text("bob", "拉黑前"));
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    const hidden = await service.send("alice", null, text("bob", "被拒收"));
    assert.equal(hidden.seq, 2);
    assert.equal(hidden.rejected, true);

    const replyHidden = await failure(service.send("bob", null, text("alice", "回", { replyTo: 2 })));
    const replyMissing = await failure(service.send("bob", null, text("alice", "回", { replyTo: 99 })));
    assert.deepEqual(replyHidden, replyMissing);

    const recallHidden = await failure(service.recall("bob", null, { type: "im_recall", convId: AB, seq: 2 }));
    const recallMissing = await failure(service.recall("bob", null, { type: "im_recall", convId: AB, seq: 99 }));
    assert.deepEqual(recallHidden, { code: "not_found", message: "消息不存在" });
    assert.deepEqual(recallMissing, recallHidden);
    // 看得见的别人的消息才是 forbidden
    assert.equal(await code(service.recall("bob", null, { type: "im_recall", convId: AB, seq: 1 })), "forbidden");

    const b2 = connect("bob");
    await service.read("bob", null, { type: "im_read", convId: AB, seq: 2 });
    assert.deepEqual(ofType(b2.got, "im_update"), [{ type: "im_update", what: "read", convId: AB, seq: 1 }]);
    const list = await service.list("bob");
    assert.equal(list.convs[0].readSeq, 1);
    assert.equal(list.convs[0].maxSeq, 1);

    const cleared = await service.settings("bob", null, { type: "im_settings", convId: AB, hideBefore: 2 });
    assert.equal(cleared.hideBefore, 1);
    // alice 看得见自己那条（rejected），她的 hideBefore 可以到 2
    const mine = await service.settings("alice", null, { type: "im_settings", convId: AB, hideBefore: 2 });
    assert.equal(mine.hideBefore, 2);
  });
});

describe("附件用途（评审 3）", () => {
  test("按字段核对用途：file 当缩略图 / 图片、svg 文件当图片、file 当头像都拒；file 的 mime 和大小以记录为准", async () => {
    const { service, store, clock } = setup();
    await putImage(store, clock.now);
    await store.putBlob(SHA("c"), Buffer.from("%PDF-1"), "application/pdf", "file", "alice", clock.now);
    await store.putBlob(SHA("d"), Buffer.from("<svg/>"), "image/svg+xml", "file", "alice", clock.now);
    assert.equal(await code(service.send("alice", null, imageSend("i1", "bob", SHA("a"), SHA("c")))), "bad_body");
    assert.equal(await code(service.send("alice", null, imageSend("i2", "bob", SHA("c"), SHA("b")))), "bad_body");
    assert.equal(await code(service.send("alice", null, imageSend("i3", "bob", SHA("d"), SHA("b")))), "bad_body");
    // 原图不能当缩略图（各用途分开上传）
    assert.equal(await code(service.send("alice", null, imageSend("i4", "bob", SHA("a"), SHA("a")))), "bad_body");
    assert.equal((await service.send("alice", null, imageSend("i5", "bob", SHA("a"), SHA("b")))).seq, 1);
    assert.equal(await code(service.profile("alice", null, { type: "im_profile", avatar: SHA("c") })), "bad_body");
    const file: Send = {
      type: "im_send",
      clientId: "f-1",
      to: "bob",
      kind: "file",
      body: { blob: SHA("d"), name: "x.png", size: 1, mime: "image/png" },
    };
    await service.send("alice", null, file);
    const last = (await service.history("bob", { type: "im_history", convId: AB })).messages.at(-1);
    assert.deepEqual(last?.body, { blob: SHA("d"), name: "x.png", size: 6, mime: "image/svg+xml" });
    assert.equal(await service.canDownload("bob", AB, SHA("d")), "image/svg+xml");
  });

  test("转发：对方能引用自己看得见的消息里的附件；无关的人不能", async () => {
    const { service, store, clock } = setup();
    await putImage(store, clock.now);
    await service.send("alice", null, imageSend("i1", "bob", SHA("a"), SHA("b")));
    assert.equal((await service.send("bob", null, imageSend("fw", "fred", SHA("a"), SHA("b")))).seq, 1);
    assert.equal(await code(service.send("erin", null, imageSend("x", "fred", SHA("a"), SHA("b")))), "not_found");
  });
});

describe("发送可恢复（评审 4）", () => {
  test("追加失败：回错误，同 clientId 重试成功且只存一条", async () => {
    const { service, store, text, dir, connect } = setup();
    const b1 = connect("bob");
    const real = store.append.bind(store);
    store.append = async () => {
      store.append = real;
      throw new Error("磁盘满");
    };
    const req = text("bob", "重试");
    await assert.rejects(service.send("alice", null, req), /磁盘满/);
    const ack = await service.send("alice", null, req);
    assert.equal(ack.seq, 1);
    assert.equal(segLines(dir, AB).length, 1);
    assert.equal(ofType(b1.got, "im_message").length, 1);
  });

  test("消息行已提交但没来得及写附件引用和投递就崩溃：同 clientId 重发补上引用、补投递", async () => {
    const { service, store, clock, connect } = setup();
    await putImage(store, clock.now);
    const conv = await store.serial(AB, () => store.ensure(AB, ["alice", "bob"], clock.now));
    const body: ImBody = { blob: SHA("a"), thumb: SHA("b"), w: 1, h: 1, original: false };
    await store.serial(AB, () =>
      store.append(conv, { from: "alice", at: clock.now, kind: "image", body, clientId: "crash-1" }),
    );
    assert.deepEqual(await store.refsIn(SHA("a"), AB), []);
    const b1 = connect("bob");
    const ack = await service.send("alice", null, imageSend("crash-1", "bob", SHA("a"), SHA("b")));
    assert.equal(ack.seq, 1);
    assert.equal(ofType(b1.got, "im_message")[0]?.message.seq, 1);
    assert.deepEqual(await store.refsIn(SHA("a"), AB), [{ seq: 1, kind: "image" }]);
    assert.equal(await service.canDownload("bob", AB, SHA("a")), "image/png");
  });

  test("meta.json 没写上（停在旧版本）：重启按 jsonl 修复 maxSeq、未读、去重", async () => {
    const { service, text, dir, make } = setup();
    const metaFile = resolve(dir, "im/conversations", AB, "meta.json");
    await service.send("alice", null, text("bob", "1"));
    const stale = readFileSync(metaFile, "utf8");
    const req = text("bob", "2");
    await service.send("alice", null, req);
    await service.send("alice", null, text("bob", "3"));
    writeFileSync(metaFile, stale);
    const restarted = make();
    assert.equal(await restarted.unread("bob", AB), 3);
    assert.equal((await restarted.send("alice", null, req)).seq, 2);
    assert.equal((await restarted.send("alice", null, text("bob", "4"))).seq, 4);
    assert.equal(JSON.parse(readFileSync(metaFile, "utf8")).maxSeq, 4);
    // meta.json 整个丢了也能接上
    rmSync(metaFile);
    assert.equal((await make().send("alice", null, text("bob", "5"))).seq, 5);
  });

  test("撤回已提交但 meta 没写上：重启后撤回的不算未读；半行被补换行隔开", async () => {
    const { service, text, dir, make } = setup();
    const metaFile = resolve(dir, "im/conversations", AB, "meta.json");
    const ack = await service.send("alice", null, text("bob", "撤回我"));
    const stale = readFileSync(metaFile, "utf8");
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: ack.seq });
    writeFileSync(metaFile, stale);
    const seg = resolve(dir, "im/conversations", AB, "00000.jsonl");
    writeFileSync(seg, `${readFileSync(seg, "utf8")}{"seq":2,"from":"ali`);
    const restarted = make();
    assert.equal(await restarted.unread("bob", AB), 0);
    assert.equal((await restarted.send("alice", null, text("bob", "新的"))).seq, 2);
    const msgs = (await restarted.history("bob", { type: "im_history", convId: AB })).messages;
    assert.deepEqual(
      msgs.map((m) => [m.seq, m.recalled ?? false]),
      [
        [1, true],
        [2, false],
      ],
    );
  });
});

describe("冷启动去重（评审 5）", () => {
  test("2500 条跨 3 段：重启后最近 2000 个 clientId 都能去重", async () => {
    const { store, make, clock, dir } = setup();
    const conv = await store.serial(AB, () => store.ensure(AB, ["alice", "bob"], clock.now));
    for (let i = 1; i <= 2500; i += 1) {
      await store.serial(AB, () =>
        store.append(conv, {
          from: "alice",
          at: clock.now + i,
          kind: "text",
          body: { text: `#${i}` },
          clientId: `k${i}`,
        }),
      );
    }
    assert.deepEqual(
      readdirSync(resolve(dir, "im/conversations", AB))
        .filter((name) => name.endsWith(".jsonl"))
        .sort(),
      ["00000.jsonl", "00001.jsonl", "00002.jsonl"],
    );
    const restarted = make();
    const resend = (clientId: string) =>
      restarted.send("alice", null, { type: "im_send", clientId, to: "bob", kind: "text", body: { text: "重发" } });
    const oldest = 2500 - CLIENT_IDS_PER_CONV + 1;
    assert.equal((await resend(`k${oldest}`)).seq, oldest);
    assert.equal((await resend("k999")).seq, 999);
    assert.equal((await resend("k2500")).seq, 2500);
    assert.equal(segLines(dir, AB, "00002.jsonl").length, 500);
  });
});

describe("上传归位与残留（复审 6）", () => {
  const leftovers = (dir: string) =>
    readdirSync(resolve(dir, "im/blobs")).filter((name) => name.startsWith(".upload-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  test("归位成功、校验不过、归位中途抛错：临时文件都删掉", async () => {
    const { store, dir, clock } = setup();
    const opts = { kind: "image" as const, mime: "image/png", tenantId: "alice", now: clock.now };
    const ok = await finishUpload(store, await store.ingest(png, 1024), opts);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.mime, "image/png");
    const notImage = await finishUpload(store, await store.ingest(Buffer.from("<svg/>"), 1024), opts);
    assert.equal(notImage.status, 400);
    const empty = await finishUpload(store, await store.ingest(Buffer.alloc(0), 1024), opts);
    assert.equal(empty.status, 400);
    store.commitBlob = async () => {
      throw new Error("磁盘满");
    };
    await assert.rejects(finishUpload(store, await store.ingest(Buffer.concat([png, png]), 1024), opts), /磁盘满/);
    assert.deepEqual(leftovers(dir), []);
  });

  test("先写 meta 再 rename：rename 失败时没有字节的 meta 不算存在", async () => {
    const { store, dir, clock, makeStore } = setup();
    const upload = await store.ingest(png, 1024);
    mkdirSync(resolve(dir, "im/blobs", upload.sha, "occupied"), { recursive: true });
    await assert.rejects(
      finishUpload(store, upload, { kind: "image", mime: "image/png", tenantId: "alice", now: clock.now }),
    );
    assert.ok(existsSync(resolve(dir, "im/blobs", `${upload.sha}.json`)));
    assert.deepEqual(leftovers(dir), []);
    assert.equal(await store.blobMeta(upload.sha), null);
    assert.equal(await makeStore().blobMeta(upload.sha), null);
  });

  test("启动时后台清理：过期临时文件、没有 meta 的 blob、没有字节的 meta；新的不动", async () => {
    const { store, dir, clock, makeStore } = setup();
    await store.putBlob(SHA("a"), Buffer.from("keep"), "image/png", "image", "alice", clock.now);
    const blobs = resolve(dir, "im/blobs");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const stale = [".upload-1-aaaa.tmp", SHA("b"), `${SHA("c")}.json`];
    for (const name of stale) {
      writeFileSync(resolve(blobs, name), "x");
      utimesSync(resolve(blobs, name), old, old);
    }
    writeFileSync(resolve(blobs, ".upload-2-bbbb.tmp"), "正在上传");
    const cold = makeStore();
    await cold.ready();
    await cold.sweeping;
    const left = readdirSync(blobs).sort();
    assert.deepEqual(left, [".upload-2-bbbb.tmp", SHA("a"), `${SHA("a")}.json`].sort());
  });
});

describe("下载鉴权（评审 6）", () => {
  test("已撤回、被拒收、双方不再可见、票据挪到别的会话：都不授权", async () => {
    const { service, store, clock, tenants } = setup();
    await putImage(store, clock.now);
    await store.putBlob(SHA("e"), Buffer.from("img2"), "image/png", "image", "alice", clock.now);
    const ack = await service.send("alice", null, imageSend("i1", "bob", SHA("a"), SHA("b")));
    assert.equal(await service.canDownload("bob", AB, SHA("a")), "image/png");
    assert.equal(await service.canDownload("bob", AB, SHA("b")), "image/jpeg");
    assert.equal(await service.canDownload("bob", dmConvId("bob", "erin"), SHA("a")), null);
    assert.equal(await service.canDownload("carol", AB, SHA("a")), null);
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: ack.seq });
    assert.equal(await service.canDownload("bob", AB, SHA("a")), null);
    assert.equal(await service.canDownload("alice", AB, SHA("a")), null);

    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    await service.send("alice", null, imageSend("i2", "bob", SHA("e"), SHA("b")));
    assert.equal(await service.canDownload("bob", AB, SHA("e")), null);
    assert.equal(await service.canDownload("alice", AB, SHA("e")), "image/png");
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: false });
    assert.equal(await service.canDownload("bob", AB, SHA("e")), null);

    await service.send("alice", null, imageSend("i3", "bob", SHA("e"), SHA("b")));
    assert.equal(await service.canDownload("bob", AB, SHA("e")), "image/png");
    const bob = tenants.find((item) => item.id === "bob")!;
    bob.imHidden = true;
    assert.equal(await service.canDownload("bob", AB, SHA("e")), null);
    assert.equal(await service.canDownload("alice", AB, SHA("e")), null);
  });

  test("头像：可见用户的当前头像才授权，按 kind=avatar 的 mime 返回", async () => {
    const { service, store, clock } = setup();
    await store.putBlob(SHA("d"), Buffer.from("png"), "image/png", "avatar", "alice", clock.now);
    assert.equal(await code(service.profile("bob", null, { type: "im_profile", avatar: SHA("d") })), "not_found");
    await service.profile("alice", null, { type: "im_profile", avatar: SHA("d") });
    assert.equal((await service.contacts("bob")).users[0].avatar, SHA("d"));
    assert.equal(await service.canDownload("bob", "avatars", SHA("d")), "image/png");
    assert.equal(await service.canDownload("carol", "avatars", SHA("d")), null);
    await service.profile("alice", null, { type: "im_profile", avatar: null });
    assert.equal(await service.canDownload("bob", "avatars", SHA("d")), null);
  });
});

describe("拉黑", () => {
  test("被拉黑方 ack 成功但 rejected；对方收不到、不推送、历史和列表都看不到、不计未读", async () => {
    const { service, connect, text, pushes } = setup();
    await service.send("alice", null, text("bob", "拉黑前"));
    const update = await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    assert.deepEqual(update.blocked, ["alice"]);
    const a1 = connect("alice");
    const a2 = connect("alice");
    const b1 = connect("bob", false);
    pushes.length = 0;
    const ack = await service.send("alice", a1.key, text("bob", "拉黑后"));
    assert.equal(ack.rejected, true);
    assert.equal(ack.seq, 2);
    assert.equal(b1.got.length, 0);
    assert.equal(pushes.length, 0);
    assert.equal(ofType(a2.got, "im_message")[0].message.rejected, true);
    assert.deepEqual(
      (await service.history("bob", { type: "im_history", convId: AB })).messages.map((m) => m.seq),
      [1],
    );
    assert.deepEqual((await service.history("bob", { type: "im_history", convId: AB, after: 1 })).messages, []);
    const bobRow = (await service.list("bob")).convs[0];
    assert.equal(bobRow.last?.seq, 1);
    assert.equal(bobRow.maxSeq, 1);
    assert.equal(bobRow.unread, 1);
    assert.deepEqual(
      (await service.history("alice", { type: "im_history", convId: AB })).messages.map((m) => [
        m.seq,
        m.rejected ?? false,
      ]),
      [
        [1, false],
        [2, true],
      ],
    );
    assert.equal((await service.send("alice", null, { ...text("bob", "x"), clientId: ack.clientId })).rejected, true);
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: false });
    assert.equal((await service.send("alice", null, text("bob", "解除后"))).rejected, undefined);
    assert.deepEqual(
      (await service.history("bob", { type: "im_history", convId: AB })).messages.map((m) => m.seq),
      [1, 3],
    );
  });
});

describe("撤回", () => {
  test("仅发件人、2 分钟内；双方收到 im_update，撤回后没有 body", async () => {
    const { service, connect, text, clock } = setup();
    const b1 = connect("bob");
    const a1 = connect("alice");
    const ack = await service.send("alice", null, text("bob", "说错了"));
    assert.equal(await code(service.recall("bob", null, { type: "im_recall", convId: AB, seq: ack.seq })), "forbidden");
    clock.now += 119_000;
    const update = await service.recall("alice", a1.key, { type: "im_recall", convId: AB, seq: ack.seq });
    assert.deepEqual(update, { type: "im_update", what: "recall", convId: AB, seq: 1 });
    assert.deepEqual(ofType(b1.got, "im_update"), [update]);
    assert.equal(ofType(a1.got, "im_update").length, 0);
    const msg = (await service.history("bob", { type: "im_history", convId: AB })).messages[0];
    assert.equal(msg.recalled, true);
    assert.equal(msg.body, undefined);
    assert.equal(await service.unread("bob", AB), 0);
    const late = await service.send("alice", null, text("bob", "晚了"));
    clock.now += 120_001;
    assert.equal(
      await code(service.recall("alice", null, { type: "im_recall", convId: AB, seq: late.seq })),
      "recall_expired",
    );
    assert.equal(await code(service.recall("alice", null, { type: "im_recall", convId: AB, seq: 99 })), "not_found");
  });

  test("撤回记录追加在原消息那一段，重启后仍是撤回", async () => {
    const { service, make, text, dir } = setup();
    const ack = await service.send("alice", null, text("bob", "a"));
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: ack.seq });
    assert.equal(JSON.parse(segLines(dir, AB)[1]).op, "recall");
    const again = await make().history("bob", { type: "im_history", convId: AB });
    assert.equal(again.messages[0].recalled, true);
  });
});

describe("历史分页", () => {
  test("默认最新一页；before 往前翻；after 往后翻；limit 最大 50；hideBefore 之前的不返回", async () => {
    const { service, text, clock } = setup();
    for (let i = 1; i <= 120; i += 1) {
      await service.send(i % 2 ? "alice" : "bob", null, text(i % 2 ? "bob" : "alice", `#${i}`));
      clock.now += 2_001;
    }
    const seqs = (m: { messages: { seq: number }[] }) => m.messages.map((x) => x.seq);
    const history = (extra: Partial<Extract<ClientMessage, { type: "im_history" }>> = {}, who = "alice") =>
      service.history(who, { type: "im_history", convId: AB, ...extra });
    const latest = await history();
    assert.deepEqual(
      seqs(latest),
      Array.from({ length: 30 }, (_, i) => 91 + i),
    );
    assert.equal(latest.more, true);
    const page = await history({ before: 91, limit: 10 });
    assert.deepEqual(seqs(page), [81, 82, 83, 84, 85, 86, 87, 88, 89, 90]);
    assert.equal(page.before, 91);
    assert.equal((await history({ limit: 500 })).messages.length, 50);
    const fwd = await history({ after: 115 });
    assert.deepEqual(seqs(fwd), [116, 117, 118, 119, 120]);
    assert.equal(fwd.more, false);
    assert.equal(fwd.after, 115);
    const fwdMore = await history({ after: 0, limit: 5 });
    assert.deepEqual(seqs(fwdMore), [1, 2, 3, 4, 5]);
    assert.equal(fwdMore.more, true);
    const first = await history({ before: 4 });
    assert.deepEqual(seqs(first), [1, 2, 3]);
    assert.equal(first.more, false);

    await service.settings("alice", null, { type: "im_settings", convId: AB, hideBefore: 100 });
    const hidden = await history({ limit: 50 });
    assert.deepEqual(
      seqs(hidden),
      Array.from({ length: 20 }, (_, i) => 101 + i),
    );
    assert.equal(hidden.more, false);
    assert.deepEqual(seqs(await history({ after: 3, limit: 2 })), [101, 102]);
    assert.equal((await history({ before: 4 }, "bob")).messages.length, 3);
    await service.settings("alice", null, { type: "im_settings", convId: AB, hideBefore: 5 });
    assert.equal((await service.list("alice")).convs[0].hideBefore, 100);
    assert.equal(await code(history({ before: -1 })), "bad_body");
  });

  test("跨 1000 条分段读写", async () => {
    const { store, make, clock, dir, service } = setup();
    const conv = await store.serial(AB, () => store.ensure(AB, ["alice", "bob"], clock.now));
    for (let i = 1; i <= 1003; i += 1) {
      await store.serial(AB, () =>
        store.append(conv, {
          from: "alice",
          at: clock.now + i,
          kind: "text",
          body: { text: `#${i}` },
          clientId: `k${i}`,
        }),
      );
    }
    assert.equal(
      (await service.history("bob", { type: "im_history", convId: AB, before: 1002, limit: 3 })).messages.length,
      3,
    );
    const files = readdirSync(resolve(dir, "im/conversations", AB)).sort();
    // 第 0 段封闭时写了可见性摘要
    assert.deepEqual(files, ["00000.jsonl", "00000.sum.json", "00001.jsonl", "meta.json"]);
    assert.deepEqual(JSON.parse(readFileSync(resolve(dir, "im/conversations", AB, "00000.sum.json"), "utf8")), {
      visible: { alice: 1000, bob: 1000 },
      incoming: { alice: 0, bob: 1000 },
    });
    const reloaded = make();
    const page = await reloaded.history("bob", { type: "im_history", convId: AB, after: 998, limit: 10 });
    assert.deepEqual(
      page.messages.map((m) => m.seq),
      [999, 1000, 1001, 1002, 1003],
    );
    // 未读封顶 1000（客户端显示 999+）；重启前后一致
    assert.equal(await service.unread("bob", AB), 1000);
    assert.equal(await reloaded.unread("bob", AB), 1000);
    await reloaded.read("bob", null, { type: "im_read", convId: AB, seq: 1001 });
    assert.equal(await reloaded.unread("bob", AB), 2);
  });
});

describe("会话列表分页（评审 8）", () => {
  test("置顶在前、再按最后一条时间倒序；cursor 串起来不重不漏；坏 cursor 回 bad_body", async () => {
    const { service, text, clock } = setup();
    for (const peer of ["bob", "erin", "fred"]) {
      await service.send("alice", null, text(peer, `给 ${peer}`));
      clock.now += 1000;
    }
    await service.settings("alice", null, { type: "im_settings", convId: dmConvId("alice", "bob"), pin: true });
    const page1 = await service.list("alice", { limit: 2 });
    assert.deepEqual(
      page1.convs.map((row) => row.peer),
      ["bob", "fred"],
    );
    assert.equal(page1.more, true);
    assert.ok(page1.cursor);
    const page2 = await service.list("alice", { limit: 2, cursor: page1.cursor });
    assert.deepEqual(
      page2.convs.map((row) => row.peer),
      ["erin"],
    );
    assert.equal(page2.more, false);
    assert.equal(page2.cursor, undefined);
    const all = await service.list("alice");
    assert.equal(all.convs.length, 3);
    assert.equal(all.more, false);
    assert.equal(await code(service.list("alice", { cursor: "不是游标" })), "bad_body");
    assert.equal(await code(service.list("alice", { limit: 0 })), "bad_body");
  });

  test("回包的 cursor 就是最后一行的排序键", async () => {
    const { service, text } = setup();
    await service.send("alice", null, text("bob", "1"));
    await service.send("alice", null, text("erin", "2"));
    const page = await service.list("alice", { limit: 1 });
    assert.deepEqual(decodeCursor(page.cursor ?? ""), {
      pin: false,
      at: page.convs[0].last?.at,
      convId: page.convs[0].convId,
    });
  });
});

describe("已读、未读与设置", () => {
  test("未读只算别人发的；im_read 推进 readSeq、只发给自己其他连接，并发静默推送带角标", async () => {
    const { service, connect, text, pushes } = setup();
    await service.send("alice", null, text("bob", "1"));
    await service.send("alice", null, text("bob", "2"));
    await service.send("bob", null, text("alice", "3"));
    assert.equal(await service.unread("bob", AB), 2);
    assert.equal(await service.unread("alice", AB), 1);
    assert.equal((await service.list("bob")).convs[0].unread, 2);
    const b1 = connect("bob");
    const b2 = connect("bob");
    const a1 = connect("alice");
    pushes.length = 0;
    assert.equal(await service.read("bob", b1.key, { type: "im_read", convId: AB, seq: 1 }), null);
    assert.equal(await service.unread("bob", AB), 1);
    assert.deepEqual(ofType(b2.got, "im_update"), [{ type: "im_update", what: "read", convId: AB, seq: 1 }]);
    assert.equal(b1.got.length, 0);
    assert.equal(a1.got.length, 0);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].to, "bob");
    assert.equal(pushes[0].message.pushType, "background");
    assert.equal(pushes[0].message.badge, 1);
    await service.read("bob", b1.key, { type: "im_read", convId: AB, seq: 1 });
    assert.equal(pushes.length, 1);
    await service.read("bob", b1.key, { type: "im_read", convId: AB, seq: 999 });
    assert.equal((await service.list("bob")).convs[0].readSeq, 3);
    assert.equal(await service.badge("bob"), 0);
  });

  test("置顶、免打扰同步到自己所有连接；拉黑列表随 im_list 下发", async () => {
    const { service, connect } = setup();
    const a1 = connect("alice");
    const a2 = connect("alice");
    const update = await service.settings("alice", a1.key, { type: "im_settings", convId: AB, pin: true, mute: true });
    assert.deepEqual(update, { type: "im_update", what: "settings", convId: AB, pin: true, mute: true, hideBefore: 0 });
    assert.deepEqual(ofType(a2.got, "im_update"), [update]);
    await service.block("alice", null, { type: "im_block", tenantId: "bob", on: true });
    assert.deepEqual((await service.list("alice")).blocked, ["bob"]);
    assert.equal(
      await code(service.settings("alice", null, { type: "im_settings", convId: "dm~bob~carol", pin: true })),
      "not_found",
    );
  });

  test("资料：昵称广播给可见用户，偏好只给自己", async () => {
    const t = setup();
    const service = t.service;
    const a1 = t.connect("alice");
    const a2 = t.connect("alice");
    const b1 = t.connect("bob");
    const c1 = t.connect("carol");
    const prefs = await service.profile("alice", a1.key, {
      type: "im_profile",
      nickname: "  爱丽丝 ",
      notifyPreview: true,
    });
    assert.deepEqual(prefs.me, { id: "alice", nickname: "爱丽丝", notifyPreview: true });
    assert.deepEqual(ofType(a2.got, "im_update")[0].what, "prefs");
    const toBob = ofType(b1.got, "im_update");
    assert.equal(toBob.length, 1);
    assert.deepEqual(toBob[0].user, { id: "alice", nickname: "爱丽丝" });
    assert.ok(toBob[0].avatarTicket?.sig);
    assert.equal(c1.got.length, 0);
    await service.profile("alice", a1.key, { type: "im_profile", notifyPreview: false });
    assert.equal(ofType(b1.got, "im_update").length, 1);
    assert.equal(await code(service.profile("alice", null, { type: "im_profile", nickname: " " })), "bad_body");
    assert.equal(await code(service.profile("alice", null, { type: "im_profile", avatar: SHA("d") })), "not_found");
  });
});

describe("推送决策", () => {
  test("收件人有前台连接不推；切到后台推，正文不含内容；免打扰不推；打开预览后带正文和角标", async () => {
    const { service, connect, text, pushes } = setup();
    const b1 = connect("bob");
    await service.send("alice", null, text("bob", "秘密内容一"));
    assert.equal(pushes.length, 0);
    b1.foreground = false;
    await service.send("alice", null, text("bob", "秘密内容二"));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].to, "bob");
    assert.equal(pushes[0].message.title, "Alice");
    assert.equal(pushes[0].message.body, "发来 2 条消息");
    assert.equal(pushes[0].message.badge, 2);
    assert.ok(!JSON.stringify(pushes[0]).includes("秘密内容"));
    await service.profile("bob", null, { type: "im_profile", notifyPreview: true });
    await service.send("alice", null, text("bob", "秘密内容三"));
    assert.equal(pushes[1].message.body, "秘密内容三");
    assert.equal(pushes[1].message.badge, 3);
    assert.equal(pushes[1].message.threadId, `im-${AB}`);
    await service.settings("bob", null, { type: "im_settings", convId: AB, mute: true });
    await service.send("alice", null, text("bob", "免打扰"));
    assert.equal(pushes.length, 2);
    assert.equal(await service.unread("bob", AB), 4);
  });

  test("撤回只替换确实推过 alert 的通知：同 collapse-id；前台收到后退后台再撤回不发；免打扰、被拒收、重启后都不发", async () => {
    const { service, connect, text, pushes, make } = setup();
    const pushed = await service.send("alice", null, text("bob", "推过的"));
    assert.equal(pushes.length, 1);
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: pushed.seq });
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].message.body, "撤回了一条消息");
    assert.equal(pushes[1].message.collapseId, pushes[0].message.collapseId);
    assert.equal(pushes[1].message.badge, 0);

    const b1 = connect("bob");
    const quiet = await service.send("alice", null, text("bob", "前台收到的"));
    b1.foreground = false;
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: quiet.seq });
    assert.equal(pushes.length, 2);

    await service.settings("bob", null, { type: "im_settings", convId: AB, mute: true });
    const muted = await service.send("alice", null, text("bob", "免打扰"));
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: muted.seq });
    assert.equal(pushes.length, 2);
    await service.settings("bob", null, { type: "im_settings", convId: AB, mute: false });

    const beforeRestart = await service.send("alice", null, text("bob", "重启前推过"));
    assert.equal(pushes.length, 3);
    await make().recall("alice", null, { type: "im_recall", convId: AB, seq: beforeRestart.seq });
    assert.equal(pushes.length, 3);

    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    const rejected = await service.send("alice", null, text("bob", "被拒收"));
    await service.recall("alice", null, { type: "im_recall", convId: AB, seq: rejected.seq });
    assert.equal(pushes.length, 3);
  });

  test("没有任何在线连接也推；不在线的收件人拉黑了就不推", async () => {
    const { service, text, pushes } = setup();
    await service.send("alice", null, text("bob", "1"));
    assert.equal(pushes.length, 1);
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    await service.send("alice", null, text("bob", "2"));
    assert.equal(pushes.length, 1);
  });
});

describe("合并写的退出窗口（第三轮 1）", () => {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const within = <T>(work: Promise<T>, ms = 500) =>
    Promise.race([work, sleep(ms).then(() => assert.fail(`${ms}ms 内没写`))]);

  test("loop 刚退出、finally 还没清 running 时来的 save() 也会写", async () => {
    const data = { v: 0 };
    const writes: string[] = [];
    const writer = new Coalesced(
      "测试",
      () => ({ file: "x", data: { ...data } }),
      10_000,
      async (_file, text) => {
        writes.push(text);
      },
    );
    data.v = 1;
    let second: Promise<void> | undefined;
    // 第一轮写完 → 等待者的 then 先于 loop 的 finally 运行：正好落在退出窗口里
    await writer.save().then(() => {
      data.v = 2;
      second = writer.save();
    });
    await within(second as Promise<void>);
    assert.deepEqual(writes, ['{"v":1}', '{"v":2}']);
    assert.equal(writer.dirty, false);
    writer.close();
  });

  test("连续写失败：每次的等待者都立即 reject、不堆积；改动留着，恢复后自动重试写上", async () => {
    const data = { v: 0 };
    const writes: string[] = [];
    let broken = true;
    const writer = new Coalesced(
      "测试",
      () => ({ file: "x", data: { ...data } }),
      10,
      async (_file, text) => {
        if (broken) throw new Error("磁盘满");
        writes.push(text);
      },
    );
    for (let i = 1; i <= 20; i += 1) {
      data.v = i;
      await assert.rejects(within(writer.save()));
      assert.equal(writer.pending, 0);
    }
    broken = false;
    for (let i = 0; i < 50 && writer.dirty; i += 1) await sleep(10);
    assert.deepEqual(writes, ['{"v":20}']);
    writer.close();
  });
});

describe("规模：内存和首次打开只和未读窗口 + 最近一两段有关（第三轮 2）", () => {
  type Row = { seq: number; from: string; rejectedFor?: string[]; kind?: string; body?: unknown };

  /** 直接写分段、meta.json、im.json（不经过 append，造几万条也快） */
  function writeConv(
    dir: string,
    rows: Row[],
    reads: Record<string, number>,
    opts: { sums?: boolean; legacyMeta?: boolean } = {},
  ) {
    const convDir = resolve(dir, "im/conversations", AB);
    mkdirSync(convDir, { recursive: true });
    const segments = new Map<number, string[]>();
    const visibleMax: Record<string, number> = { alice: 0, bob: 0 };
    const lastIncoming: Record<string, number> = { alice: 0, bob: 0 };
    for (const row of rows) {
      const line = JSON.stringify({
        seq: row.seq,
        from: row.from,
        at: 1_800_000_000_000 + row.seq,
        kind: row.kind ?? "text",
        body: row.body ?? { text: `#${row.seq}` },
        clientId: `k${row.seq}`,
        ...(row.rejectedFor ? { rejectedFor: row.rejectedFor } : {}),
      });
      const index = Math.floor((row.seq - 1) / 1000);
      segments.set(index, [...(segments.get(index) ?? []), line]);
      for (const member of ["alice", "bob"]) {
        if (row.rejectedFor?.includes(member)) continue;
        visibleMax[member] = row.seq;
        if (row.from !== member) lastIncoming[member] = row.seq;
      }
    }
    for (const [index, lines] of segments) {
      writeFileSync(resolve(convDir, `${String(index).padStart(5, "0")}.jsonl`), `${lines.join("\n")}\n`);
    }
    const maxSeq = rows[rows.length - 1]?.seq ?? 0;
    if (opts.sums) {
      const lastIndex = Math.floor((maxSeq - 1) / 1000);
      for (let index = 0; index < lastIndex; index += 1) {
        const sum = { visible: { alice: 0, bob: 0 }, incoming: { alice: 0, bob: 0 } };
        for (const row of rows.slice(index * 1000, index * 1000 + 1000)) {
          for (const member of ["alice", "bob"] as const) {
            if (row.rejectedFor?.includes(member)) continue;
            sum.visible[member] += 1;
            if (row.from !== member) sum.incoming[member] += 1;
          }
        }
        writeFileSync(resolve(convDir, `${String(index).padStart(5, "0")}.sum.json`), JSON.stringify(sum));
      }
    }
    writeFileSync(
      resolve(convDir, "meta.json"),
      JSON.stringify({
        convId: AB,
        members: ["alice", "bob"],
        maxSeq,
        createdAt: 1,
        visibleMax,
        ...(opts.legacyMeta ? {} : { lastIncoming }),
      }),
    );
    for (const [member, readSeq] of Object.entries(reads)) {
      mkdirSync(resolve(dir, "tenants", member), { recursive: true });
      writeFileSync(
        resolve(dir, "tenants", member, "im.json"),
        JSON.stringify({
          convs: { [AB]: { readSeq, pin: false, mute: false, hideBefore: 0 } },
          blocked: [],
          notifyPreview: false,
        }),
      );
    }
  }

  const chat = (count: number) =>
    Array.from({ length: count }, (_, i): Row => ({ seq: i + 1, from: i % 2 ? "bob" : "alice" }));

  test("2 万条、双方都读到尾：重启后第一次 im_list / 角标只读最后 1–2 段", async () => {
    const { dir, makeStore, make } = setup();
    writeConv(dir, chat(20_000), { alice: 20_000, bob: 20_000 });
    const store = makeStore();
    const service = make(store);
    const list = await service.list("bob");
    assert.equal(list.convs[0].maxSeq, 20_000);
    assert.equal(list.convs[0].unread, 0);
    assert.equal(await service.badge("alice"), 0);
    assert.ok(store.segmentReads <= 2, `读了 ${store.segmentReads} 段`);
    // 第一次发送才往前补去重表；之后照常
    const resend = await service.send("alice", null, {
      type: "im_send",
      clientId: "k18001",
      to: "bob",
      kind: "text",
      body: { text: "重发" },
    });
    assert.equal(resend.seq, 18_001);
    assert.ok(store.segmentReads <= 4, `读了 ${store.segmentReads} 段`);
  });

  test("5000 条从没读过：未读报 1000（封顶，客户端显示 999+），不扫全部历史", async () => {
    const { dir, makeStore, make } = setup();
    writeConv(dir, chat(5_000), { alice: 5_000 });
    const store = makeStore();
    const service = make(store);
    const list = await service.list("bob");
    assert.equal(list.convs[0].unread, UNREAD_CAP);
    assert.equal(await service.badge("bob"), UNREAD_CAP);
    assert.ok(store.segmentReads <= 3, `读了 ${store.segmentReads} 段`);
    // 读到 4990：剩下 bob 收到的 5 条
    await service.read("bob", null, { type: "im_read", convId: AB, seq: 4_990 });
    assert.equal(await service.unread("bob", AB), 5);
    assert.ok(store.segmentReads <= 3);
  });

  test("很早以前被拒收的一条：重启后对拉黑方仍不存在（replyTo、recall、下载、历史）", async () => {
    const { dir, makeStore, make, clock } = setup();
    const seed = makeStore();
    await putImage(seed, clock.now);
    const image = { blob: SHA("a"), thumb: SHA("b"), w: 1, h: 1, original: false };
    const rows = chat(3_000);
    rows[4] = { seq: 5, from: "alice", rejectedFor: ["bob"], kind: "image", body: image };
    writeConv(dir, rows, { alice: 3_000, bob: 3_000 });
    await seed.addBlobRef(SHA("a"), { convId: AB, seq: 5, kind: "image" });
    seed.close();
    const store = makeStore();
    const service = make(store);
    const missing = await failure(service.send("bob", null, { ...imageSend("r1", "alice", SHA("a"), SHA("b")) }));
    assert.equal(missing.code, "not_found");
    const hidden = await failure(
      service.send("bob", null, {
        type: "im_send",
        clientId: "r2",
        to: "alice",
        kind: "text",
        body: { text: "x" },
        replyTo: 5,
      }),
    );
    const absent = await failure(
      service.send("bob", null, {
        type: "im_send",
        clientId: "r3",
        to: "alice",
        kind: "text",
        body: { text: "x" },
        replyTo: 99_999,
      }),
    );
    assert.deepEqual(hidden, absent);
    assert.equal(await code(service.recall("bob", null, { type: "im_recall", convId: AB, seq: 5 })), "not_found");
    assert.equal(await service.canDownload("bob", AB, SHA("a")), null);
    assert.equal(await service.canDownload("alice", AB, SHA("a")), "image/png");
    const page = await service.history("bob", { type: "im_history", convId: AB, before: 8 });
    assert.deepEqual(
      page.messages.map((m) => m.seq),
      [1, 2, 3, 4, 6, 7],
    );
  });

  test("没有对自己可见消息的会话不进 im_list；校验失败的发送不留下空会话", async () => {
    const { service, text, dir } = setup();
    const AE = dmConvId("alice", "erin");
    assert.equal(await code(service.send("alice", null, text("erin", "回", { replyTo: 1 }))), "bad_body");
    assert.equal(await code(service.send("alice", null, imageSend("i1", "erin", SHA("e"), SHA("f")))), "not_found");
    assert.equal(existsSync(resolve(dir, "im/conversations", AE)), false);
    assert.deepEqual((await service.list("alice")).convs, []);
    assert.deepEqual((await service.list("erin")).convs, []);
    // 被拒收的会话：发件人能看到，拉黑方的列表里没有
    await service.block("bob", null, { type: "im_block", tenantId: "alice", on: true });
    await service.send("alice", null, text("bob", "被拒收"));
    assert.deepEqual(
      (await service.list("alice")).convs.map((c) => c.convId),
      [AB],
    );
    assert.deepEqual((await service.list("bob")).convs, []);
  });

  test("拉黑后对方发了 3 万条：拉黑方看最新历史只读 1–2 段，往前、往后翻都跳过全不可见的段（第四轮 1）", async () => {
    const { dir, makeStore, make } = setup();
    const rows: Row[] = [
      ...chat(20),
      ...Array.from({ length: 30_000 }, (_, i): Row => ({ seq: 21 + i, from: "alice", rejectedFor: ["bob"] })),
      ...chat(20).map((row) => ({ ...row, seq: row.seq + 30_020 })),
    ];
    writeConv(dir, rows, { alice: 30_040, bob: 30_040 });
    const convDir = resolve(dir, "im/conversations", AB);
    // 摘要文件没有时第一次用到从分段重建并写回
    const warm = makeStore();
    const warmed = await make(warm).history("bob", { type: "im_history", convId: AB, before: 30_021 });
    assert.equal(warmed.messages.length, 20);
    assert.equal(readdirSync(convDir).filter((name) => name.endsWith(".sum.json")).length, 30);
    warm.close();

    const store = makeStore();
    const service = make(store);
    // 打开会话：只读最后两段（双方都读到尾，未读重建不往前读）
    await store.open(AB);
    assert.ok(store.segmentReads <= 2, `打开读了 ${store.segmentReads} 段`);
    const opened = store.segmentReads;
    const latest = await service.history("bob", { type: "im_history", convId: AB });
    assert.deepEqual(
      latest.messages.map((m) => m.seq),
      [...Array.from({ length: 10 }, (_, i) => 11 + i), ...Array.from({ length: 20 }, (_, i) => 30_021 + i)],
    );
    assert.equal(latest.more, true);
    assert.ok(store.segmentReads - opened <= 1, `历史读了 ${store.segmentReads - opened} 段`);
    const older = await service.history("bob", { type: "im_history", convId: AB, before: 11 });
    assert.deepEqual(
      older.messages.map((m) => m.seq),
      Array.from({ length: 10 }, (_, i) => 1 + i),
    );
    assert.equal(older.more, false);
    const forward = await service.history("bob", { type: "im_history", convId: AB, after: 20, limit: 5 });
    assert.deepEqual(
      forward.messages.map((m) => m.seq),
      [30_021, 30_022, 30_023, 30_024, 30_025],
    );
    assert.equal(forward.more, true);
    assert.ok(store.segmentReads - opened <= 1, `历史读了 ${store.segmentReads - opened} 段`);
    // 发件人自己照常看到被拒收的
    const mine = await service.history("alice", { type: "im_history", convId: AB, before: 30_021, limit: 3 });
    assert.deepEqual(
      mine.messages.map((m) => [m.seq, m.rejected]),
      [
        [30_018, true],
        [30_019, true],
        [30_020, true],
      ],
    );
  });

  test("未读恰好 1000 条 + 前面都是自己发的：重启后不算封顶，对方撤回 60 条 → 940（第四轮 3）", async () => {
    const { dir, make } = setup();
    const rows = Array.from({ length: 3_000 }, (_, i): Row => ({ seq: i + 1, from: i < 2_000 ? "alice" : "bob" }));
    writeConv(dir, rows, { bob: 3_000 });
    const service = make();
    assert.equal(await service.unread("alice", AB), 1_000);
    for (let seq = 2_941; seq <= 3_000; seq += 1)
      await service.recall("bob", null, { type: "im_recall", convId: AB, seq });
    assert.equal(await service.unread("alice", AB), 940);
    assert.equal(await make().unread("alice", AB), 940);
  });

  test("尾部 1500 条对方未读：封顶 1000，撤回 60 条后往前补，仍是 1000；读到一半数对（第四轮 3）", async () => {
    const { dir, make } = setup();
    const rows = Array.from({ length: 2_000 }, (_, i): Row => ({ seq: i + 1, from: i < 500 ? "alice" : "bob" }));
    writeConv(dir, rows, { bob: 2_000 });
    const service = make();
    assert.equal(await service.unread("alice", AB), UNREAD_CAP);
    for (let seq = 1_941; seq <= 2_000; seq += 1)
      await service.recall("bob", null, { type: "im_recall", convId: AB, seq });
    assert.equal(await service.unread("alice", AB), UNREAD_CAP);
    // 再撤回 500 条：实际剩 1500 - 560 = 940，补完确认更早已经没有了
    for (let seq = 1_441; seq <= 1_940; seq += 1)
      await service.recall("bob", null, { type: "im_recall", convId: AB, seq });
    assert.equal(await service.unread("alice", AB), 940);
    await service.read("alice", null, { type: "im_read", convId: AB, seq: 1_000 });
    // 1001–2000 是 bob 的 1000 条，撤回了 1441–2000 的 560 条
    assert.equal(await service.unread("alice", AB), 440);
  });

  /** bob 读到 7，alice 发的 8–10 未读；然后 bob 拉黑 alice，alice 又发了 3 万条（都被拒收） */
  const blockedFlood = () => [
    ...chat(7),
    ...[8, 9, 10].map((seq): Row => ({ seq, from: "alice" })),
    ...Array.from({ length: 30_000 }, (_, i): Row => ({ seq: 11 + i, from: "alice", rejectedFor: ["bob"] })),
  ];

  test("B 早期 3 条未读、拉黑 A 后 A 发 3 万条（摘要已存在）：重启后首次 im_list 未读 3，只读少数几段（第五轮 1）", async () => {
    for (const legacyMeta of [false, true]) {
      // legacyMeta：meta 里没有 lastIncoming（旧版），只能拿 maxSeq 当上界，靠摘要跳段
      const { dir, makeStore, make } = setup();
      writeConv(dir, blockedFlood(), { alice: 30_010, bob: 7 }, { sums: true, legacyMeta });
      const store = makeStore();
      const list = await make(store).list("bob");
      assert.equal(list.convs[0].unread, 3);
      assert.equal(list.convs[0].maxSeq, 10);
      assert.ok(store.segmentReads <= 3, `legacyMeta=${legacyMeta} 读了 ${store.segmentReads} 段`);
    }
  });

  test("摘要缺失时才读分段：读过一次写回摘要，下次重启只读少数几段（第五轮 1）", async () => {
    const { dir, makeStore, make } = setup();
    writeConv(dir, blockedFlood(), { alice: 30_010, bob: 7 }, { legacyMeta: true });
    const first = makeStore();
    assert.equal(await make(first).unread("bob", AB), 3);
    assert.ok(first.segmentReads > 20, `没有摘要时应该读分段重建：${first.segmentReads}`);
    first.close();
    const second = makeStore();
    assert.equal(await make(second).unread("bob", AB), 3);
    assert.ok(second.segmentReads <= 3, `读了 ${second.segmentReads} 段`);
  });

  test("摘要不合法（越界、非整数、缺字段、成员不全或多出、incoming > visible）：从 jsonl 重建（第五轮 3）", async () => {
    const bad: unknown[] = [
      { visible: { alice: 1000, bob: -1 }, incoming: { alice: 0, bob: 0 } },
      { visible: { alice: 1000, bob: 1001 }, incoming: { alice: 0, bob: 0 } },
      { visible: { alice: 1000, bob: 0.5 }, incoming: { alice: 0, bob: 0 } },
      { visible: { alice: 1000, bob: 0 } },
      { visible: { alice: 1000 }, incoming: { alice: 0 } },
      { visible: { alice: 1000, bob: 0, carol: 0 }, incoming: { alice: 0, bob: 0, carol: 0 } },
      { visible: { alice: 1000, bob: 0 }, incoming: { alice: 0, bob: 5 } },
      "不是对象",
    ];
    const rows = [
      ...Array.from({ length: 1_000 }, (_, i): Row => ({ seq: i + 1, from: "alice" })),
      ...Array.from({ length: 2_000 }, (_, i): Row => ({ seq: 1_001 + i, from: "alice", rejectedFor: ["bob"] })),
    ];
    for (const sum of bad) {
      const { dir, make } = setup();
      writeConv(dir, rows, { alice: 3_000 }, { sums: true });
      const file = resolve(dir, "im/conversations", AB, "00000.sum.json");
      writeFileSync(file, JSON.stringify(sum));
      assert.equal(await make().unread("bob", AB), 1_000, JSON.stringify(sum));
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
        visible: { alice: 1_000, bob: 1_000 },
        incoming: { alice: 0, bob: 1_000 },
      });
    }
  });

  test("并发发现同一段摘要缺失：只读一次分段（第五轮 4）", async () => {
    const { dir, makeStore, make } = setup();
    const rows = [
      ...chat(20),
      ...Array.from({ length: 5_000 }, (_, i): Row => ({ seq: 21 + i, from: "alice", rejectedFor: ["bob"] })),
      ...chat(20).map((row) => ({ ...row, seq: row.seq + 5_020 })),
    ];
    writeConv(dir, rows, { alice: 5_040, bob: 5_040 });
    const store = makeStore();
    const service = make(store);
    await store.open(AB);
    const before = store.segmentReads;
    const pages = await Promise.all(
      Array.from({ length: 5 }, () => service.history("bob", { type: "im_history", convId: AB, before: 5_021 })),
    );
    for (const page of pages) assert.equal(page.messages.length, 20);
    // 已封闭的 0–4 段每段最多读一次（第 4 段打开时已在缓存里）
    assert.ok(store.segmentReads - before <= 5, `读了 ${store.segmentReads - before} 段`);
  });
});

describe("第四轮：全局重建名额、引用缓存预算、空会话清理", () => {
  test("多个用户同时 im_list：整个 store 同时进行的会话重建不超过 4 个，同一会话共享一次重建", async () => {
    const { service, text, tenants, makeStore, make } = setup();
    for (let i = 1; i <= 6; i += 1) tenants.push({ id: `u${i}`, name: `U${i}` });
    const people = tenants.filter((item) => !item.imHidden).map((item) => item.id);
    for (const [i, a] of people.entries()) {
      for (const b of people.slice(i + 1)) await service.send(a, null, text(b, "嗨"));
    }
    const store = makeStore();
    const cold = make(store);
    const lists = await Promise.all(people.map((id) => cold.list(id)));
    for (const list of lists) assert.equal(list.convs.length, people.length - 1);
    assert.ok(store.peakRebuilds <= 4, `同时重建了 ${store.peakRebuilds} 个`);
    assert.ok(store.peakRebuilds >= 2, "应该有并发重建");
    // 每个会话只扫一次尾段
    assert.equal(store.segmentReads, (people.length * (people.length - 1)) / 2);
  });

  test("引用缓存按总条数限额：超了淘汰最久没用的 blob，用到时重新加载", async () => {
    const { dir, clock } = setup();
    const store = new ImStore(dir, (id) => resolve(dir, "tenants", id), { retryMs: 20, refBudget: 5_000 });
    await putImage(store, clock.now);
    await store.putBlob(SHA("c"), Buffer.from("img2"), "image/png", "image", "alice", clock.now);
    for (let seq = 1; seq <= 3_000; seq += 1) await store.addBlobRef(SHA("a"), { convId: AB, seq, kind: "image" });
    assert.equal(store.cachedRefs, 3_000);
    for (let seq = 1; seq <= 3_000; seq += 1) await store.addBlobRef(SHA("c"), { convId: AB, seq, kind: "image" });
    assert.ok(store.cachedRefs <= 5_000, `缓存了 ${store.cachedRefs} 条`);
    assert.equal((await store.refsIn(SHA("a"), AB)).length, 3_000);
    assert.ok(store.cachedRefs <= 5_000, `缓存了 ${store.cachedRefs} 条`);
    assert.equal((await store.refsIn(SHA("c"), AB)).length, 3_000);
    store.close();
  });

  test("新会话的第一条追加失败：不留下 maxSeq=0 的空会话目录，重试照常建", async () => {
    const { service, store, text, dir } = setup();
    const AE = dmConvId("alice", "erin");
    const real = store.append.bind(store);
    store.append = async () => {
      store.append = real;
      throw new Error("磁盘满");
    };
    const req = text("erin", "第一条");
    await assert.rejects(service.send("alice", null, req), /磁盘满/);
    assert.equal(existsSync(resolve(dir, "im/conversations", AE)), false);
    assert.deepEqual((await service.list("alice")).convs, []);
    assert.equal((await service.send("alice", null, req)).seq, 1);
    assert.equal(existsSync(resolve(dir, "im/conversations", AE, "meta.json")), true);
    assert.equal((await service.list("erin")).convs.length, 1);
  });
});

describe("第五轮：追加报错但其实写上了", () => {
  test("新会话的第一条 appendFile 写完了却报错：不删目录，按已提交处理，同 clientId 重试拿到原 ack", async () => {
    const { service, store, text, dir } = setup();
    const AE = dmConvId("alice", "erin");
    const convDir = resolve(dir, "im/conversations", AE);
    const real = store.append.bind(store);
    store.append = async (_conv, row) => {
      store.append = real;
      appendFileSync(resolve(convDir, "00000.jsonl"), `${JSON.stringify({ seq: 1, ...row })}\n`);
      throw new Error("写完了但报错");
    };
    const req = text("erin", "第一条");
    await assert.rejects(service.send("alice", null, req), /写完了但报错/);
    assert.equal(existsSync(convDir), true);
    assert.equal(segLines(dir, AE).length, 1);
    const ack = await service.send("alice", null, req);
    assert.equal(ack.seq, 1);
    assert.equal(segLines(dir, AE).length, 1);
    assert.equal(await service.unread("erin", AE), 1);
    assert.equal(JSON.parse(readFileSync(resolve(convDir, "meta.json"), "utf8")).maxSeq, 1);
    assert.equal((await service.send("alice", null, text("erin", "第二条"))).seq, 2);
  });
});

describe("附件引用日志（第三轮 3）", () => {
  test("一个 blob 被引用 3000 次：<sha>.json 大小不变，引用只追加一行，重复的不再写", async () => {
    const { store, clock, dir, makeStore } = setup();
    await putImage(store, clock.now);
    const json = resolve(dir, "im/blobs", `${SHA("a")}.json`);
    const log = resolve(dir, "im/blobs", `${SHA("a")}.refs.jsonl`);
    const size = statSync(json).size;
    for (let seq = 1; seq <= 3000; seq += 1) await store.addBlobRef(SHA("a"), { convId: AB, seq, kind: "image" });
    assert.equal(statSync(json).size, size);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3000);
    const logSize = statSync(log).size;
    for (let seq = 1; seq <= 100; seq += 1) await store.addBlobRef(SHA("a"), { convId: AB, seq, kind: "image" });
    assert.equal(statSync(log).size, logSize);
    const cold = makeStore();
    assert.equal((await cold.refsIn(SHA("a"), AB)).length, 3000);
    await cold.addBlobRef(SHA("a"), { convId: AB, seq: 7, kind: "image" });
    assert.equal(statSync(log).size, logSize);
    // 按 seq 升序保存（查询不排序），补写的旧 seq 插在正确位置
    const list = await cold.refsIn(SHA("a"), AB);
    assert.equal(list[list.length - 1].seq, 3000);
    assert.ok(list.every((ref, i) => i === 0 || list[i - 1].seq <= ref.seq));
  });

  test("旧格式 <sha>.json 里的 refs：第一次读时搬进引用日志，json 里不再有", async () => {
    const { store, clock, dir, makeStore } = setup();
    await putImage(store, clock.now);
    const json = resolve(dir, "im/blobs", `${SHA("a")}.json`);
    const legacy = { ...JSON.parse(readFileSync(json, "utf8")), refs: [{ convId: AB, seq: 3, kind: "image" }] };
    writeFileSync(json, JSON.stringify(legacy));
    const cold = makeStore();
    assert.ok(await cold.blobMeta(SHA("a")));
    assert.equal("refs" in JSON.parse(readFileSync(json, "utf8")), false);
    assert.deepEqual(await cold.refsIn(SHA("a"), AB), [{ seq: 3, kind: "image" }]);
    assert.deepEqual(await makeStore().refsIn(SHA("a"), AB), [{ seq: 3, kind: "image" }]);
  });
});

describe("资料并发更新（第三轮 4）", () => {
  test("并发改昵称和换头像：两个都保住", async () => {
    const { store, clock, make, dir } = setup();
    await store.putBlob(SHA("c"), Buffer.from("avatar"), "image/png", "avatar", "bob", clock.now);
    store.close();
    // 新进程：查头像 blob 要读盘（异步），昵称那个请求先到先写
    const service = make();
    await Promise.all([
      service.profile("bob", null, { type: "im_profile", avatar: SHA("c") }),
      service.profile("bob", null, { type: "im_profile", nickname: "鲍勃" }),
    ]);
    const saved = JSON.parse(readFileSync(resolve(dir, "im/profiles.json"), "utf8")).bob;
    assert.deepEqual(saved, { nickname: "鲍勃", avatar: SHA("c") });
    const contacts = await make().contacts("alice");
    const bob = contacts.users.find((user) => user.id === "bob");
    assert.equal(bob?.nickname, "鲍勃");
    assert.equal(bob?.avatar, SHA("c"));
  });
});
