import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apnsBadgeFor, apnsPayload } from "../src/assistant/apns.ts";
import { apnsWants, type ApnsSubscription } from "../src/assistant/push.ts";
import { blobsOf, checkBody } from "../src/im/body.ts";
import { ImError } from "../src/im/errors.ts";
import { BLOB_LIMITS, blobMimeOk, sniffImageMime } from "../src/im/http.ts";
import { compareKeys, decodeCursor, encodeCursor, rowKey } from "../src/im/listCursor.ts";
import { dmConvId, imCollapseId, imThreadId, imVisible, parseDmConvId } from "../src/im/ids.ts";
import {
  imAlertFor,
  imPreviewText,
  imReadPush,
  imRecallAlert,
  PUSHED_PER_USER,
  PUSHED_TTL_MS,
  RecentPushes,
  type ImAlertInput,
} from "../src/im/pushRules.ts";
import type { StoredMessage } from "../src/im/store.ts";
import { imTicket, imTicketOk, matchImTicketTenant, signImTicket } from "../src/im/ticket.ts";
import { signMedia } from "../src/media.ts";

const BLOB = "a".repeat(64);
const BLOB2 = "b".repeat(64);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ImError, String(err));
    return err.code;
  }
  assert.fail("应该抛错");
}

describe("会话号", () => {
  test("两个 id 按字符串排序，顺序无关；带短横线的 id 也能无歧义解析", () => {
    assert.equal(dmConvId("bob", "alice"), "dm~alice~bob");
    assert.equal(dmConvId("alice", "bob"), "dm~alice~bob");
    assert.equal(dmConvId("a-b", "a"), "dm~a~a-b");
    assert.deepEqual(parseDmConvId("dm~a~a-b"), ["a", "a-b"]);
    assert.deepEqual(parseDmConvId(dmConvId("x-1-2", "x-1")), ["x-1", "x-1-2"]);
  });

  test("顺序反了、两边相同、格式不对都不认", () => {
    assert.equal(parseDmConvId("dm~bob~alice"), null);
    assert.equal(parseDmConvId("dm~bob~bob"), null);
    assert.equal(parseDmConvId("dm-alice-bob"), null);
    assert.equal(parseDmConvId("dm~Alice~bob"), null);
    assert.equal(parseDmConvId("dm~a~b~c"), null);
    assert.equal(parseDmConvId(42), null);
  });

  test("thread-id 和 collapse-id：collapse-id 只含安全字符、不超过 64 字节、同会话同 seq 稳定", () => {
    const conv = dmConvId("a".repeat(32), "b".repeat(32));
    assert.equal(imThreadId(conv), `im-${conv}`);
    const id = imCollapseId(conv, 123456);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.byteLength(id) <= 64);
    assert.equal(id, imCollapseId(conv, 123456));
    assert.notEqual(id, imCollapseId(conv, 123457));
  });
});

describe("可见性 imHidden", () => {
  test("imHidden 相同才互相可见；缺省等于 false", () => {
    assert.equal(imVisible({}, { imHidden: false }), true);
    assert.equal(imVisible({ imHidden: true }, { imHidden: true }), true);
    assert.equal(imVisible({ imHidden: true }, {}), false);
    assert.equal(imVisible({ imHidden: false }, { imHidden: true }), false);
  });
});

describe("消息体校验", () => {
  test("text：去掉多余字段；空文字 bad_body；超过 8KB too_large", () => {
    assert.deepEqual(checkBody("text", { text: "你好", extra: 1 }), {
      kind: "text",
      body: { text: "你好" },
      blobs: [],
    });
    assert.equal(
      code(() => checkBody("text", { text: "  " })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("text", { text: "字".repeat(2731) })),
      "too_large",
    );
    assert.equal(checkBody("text", { text: "字".repeat(2730) }).kind, "text");
  });

  test("image：blob/thumb 必须是 sha256，宽高正整数，original 布尔", () => {
    const ok = checkBody("image", { blob: BLOB, thumb: BLOB2, w: 10, h: 20, original: false });
    assert.deepEqual(ok.blobs, [
      { sha: BLOB, kind: "image" },
      { sha: BLOB2, kind: "thumb" },
    ]);
    assert.deepEqual(blobsOf("image", ok.body), ok.blobs);
    assert.equal(
      code(() => checkBody("image", { blob: "x", thumb: BLOB2, w: 10, h: 20, original: false })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("image", { blob: BLOB, thumb: BLOB2, w: 0, h: 20, original: false })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("image", { blob: BLOB, thumb: BLOB2, w: 10, h: 20 })),
      "bad_body",
    );
  });

  test("voice：时长 ≤ 60 秒，波形 ≤ 100 个 0..1", () => {
    assert.equal(checkBody("voice", { blob: BLOB, durationMs: 60000, waveform: [0, 0.5, 1] }).kind, "voice");
    assert.equal(
      code(() => checkBody("voice", { blob: BLOB, durationMs: 60001, waveform: [] })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("voice", { blob: BLOB, durationMs: 1000, waveform: new Array(101).fill(0) })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("voice", { blob: BLOB, durationMs: 1000, waveform: [1.5] })),
      "bad_body",
    );
  });

  test("file：文件名不能有斜杠，mime 要像 type/subtype", () => {
    const body = { blob: BLOB, name: "报价.pdf", size: 10, mime: "application/pdf" };
    assert.deepEqual(checkBody("file", body).body, body);
    assert.equal(
      code(() => checkBody("file", { ...body, name: "../x" })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("file", { ...body, mime: "pdf" })),
      "bad_body",
    );
  });

  test("link：只认 http/https；空的可选字段省略；icon 是 blob", () => {
    assert.deepEqual(checkBody("link", { url: "https://example.com/x", title: "", icon: BLOB }), {
      kind: "link",
      body: { url: "https://example.com/x", icon: BLOB },
      blobs: [{ sha: BLOB, kind: "icon" }],
    });
    assert.equal(
      code(() => checkBody("link", { url: "javascript:alert(1)" })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("link", { url: "ftp://example.com" })),
      "bad_body",
    );
  });

  test("location：经纬度范围，name/address 是字符串", () => {
    assert.equal(checkBody("location", { lat: 31.2, lng: 121.4, name: "人民广场", address: "" }).kind, "location");
    assert.equal(
      code(() => checkBody("location", { lat: 91, lng: 0, name: "", address: "" })),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("location", { lat: 0, lng: 0, name: 1, address: "" })),
      "bad_body",
    );
  });

  test("不认识的 kind、body 不是对象", () => {
    assert.equal(
      code(() => checkBody("sticker", {})),
      "bad_body",
    );
    assert.equal(
      code(() => checkBody("text", "hi")),
      "bad_body",
    );
  });
});

describe("附件用途与格式", () => {
  test("blobMimeOk：图片类不收 svg、语音只收 audio/*、file 只要 mime 像样", () => {
    assert.equal(blobMimeOk("image", "image/png"), true);
    assert.equal(blobMimeOk("thumb", "image/svg+xml"), false);
    assert.equal(blobMimeOk("avatar", "application/pdf"), false);
    assert.equal(blobMimeOk("voice", "audio/m4a"), true);
    assert.equal(blobMimeOk("voice", "video/mp4"), false);
    assert.equal(blobMimeOk("file", "image/svg+xml"), true);
    assert.equal(blobMimeOk("file", "pdf"), false);
    assert.equal(BLOB_LIMITS.thumb < BLOB_LIMITS.image && BLOB_LIMITS.image < BLOB_LIMITS.file, true);
  });

  test("sniffImageMime：按文件头认 jpeg/png/gif/webp/heic/avif，svg 和其它认不出", () => {
    const ascii = (text: string) => Buffer.from(text, "latin1");
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
    assert.equal(sniffImageMime(ascii("GIF89a....")), "image/gif");
    assert.equal(sniffImageMime(ascii("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImageMime(ascii("\0\0\0\x18ftypheic")), "image/heic");
    assert.equal(sniffImageMime(ascii("\0\0\0\x18ftypavif")), "image/avif");
    assert.equal(sniffImageMime(ascii("<svg xmlns=")), null);
    assert.equal(sniffImageMime(ascii("%PDF-1.7")), null);
    assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  });
});

describe("推过的通知记录", () => {
  test("每人有上限、按时间过期；take 一次后忘掉", () => {
    const pushes = new RecentPushes(3, 1000);
    for (let seq = 1; seq <= 5; seq += 1) pushes.mark("bob", "dm~a~b", seq, 100 + seq);
    assert.equal(pushes.size("bob"), 3);
    assert.equal(pushes.take("bob", "dm~a~b", 1, 200), false);
    assert.equal(pushes.take("bob", "dm~a~b", 5, 200), true);
    assert.equal(pushes.take("bob", "dm~a~b", 5, 200), false);
    assert.equal(pushes.take("alice", "dm~a~b", 4, 200), false);
    assert.equal(pushes.take("bob", "dm~a~b", 4, 2000), false);
    pushes.mark("bob", "dm~a~b", 9, 5000);
    assert.equal(pushes.size("bob"), 1);
    assert.equal(PUSHED_PER_USER, 500);
    assert.equal(PUSHED_TTL_MS, 10 * 60_000);
  });
});

describe("会话列表游标", () => {
  test("排序：置顶在前、时间倒序、同时间按会话号；游标往返不变，坏游标返回 null", () => {
    const keys = [
      { pin: false, at: 5, convId: "dm~a~c" },
      { pin: true, at: 1, convId: "dm~a~b" },
      { pin: false, at: 9, convId: "dm~a~d" },
      { pin: false, at: 5, convId: "dm~a~b" },
    ];
    assert.deepEqual(
      [...keys].sort(compareKeys).map((key) => key.convId),
      ["dm~a~b", "dm~a~d", "dm~a~b", "dm~a~c"],
    );
    for (const key of keys) assert.deepEqual(decodeCursor(encodeCursor(key)), key);
    assert.deepEqual(rowKey({ pin: true, convId: "dm~a~b" }), { pin: true, at: 0, convId: "dm~a~b" });
    assert.equal(decodeCursor("not-base64-json"), null);
    assert.equal(decodeCursor(Buffer.from('[2,1,"x"]').toString("base64url")), null);
  });
});

describe("下载票据", () => {
  const secret = "s3cret";
  test("签名绑定租户、scope、exp，过期或改任一项都失败", () => {
    const now = 1_800_000_000_000;
    const ticket = imTicket(secret, "alice", "dm~alice~bob", now);
    assert.equal(ticket.exp, now + 2 * 60 * 60_000);
    const exp = String(ticket.exp);
    assert.equal(imTicketOk(secret, "alice", "dm~alice~bob", exp, ticket.sig, now), true);
    assert.equal(imTicketOk(secret, "bob", "dm~alice~bob", exp, ticket.sig, now), false);
    assert.equal(imTicketOk(secret, "alice", "avatars", exp, ticket.sig, now), false);
    assert.equal(imTicketOk(secret, "alice", "dm~alice~bob", String(ticket.exp + 1), ticket.sig, now), false);
    assert.equal(imTicketOk("other", "alice", "dm~alice~bob", exp, ticket.sig, now), false);
    assert.equal(imTicketOk(secret, "alice", "dm~alice~bob", exp, ticket.sig, ticket.exp + 1), false);
  });

  test("按签名找出签发租户；和 /media 预览票据互不通用", () => {
    const ticket = imTicket(secret, "bob", "avatars");
    assert.equal(
      matchImTicketTenant(secret, ["alice", "bob", "carol"], "avatars", String(ticket.exp), ticket.sig),
      "bob",
    );
    assert.equal(matchImTicketTenant(secret, ["alice", "carol"], "avatars", String(ticket.exp), ticket.sig), null);
    assert.notEqual(signImTicket(secret, "bob", "avatars", 1), signMedia(secret, "bob", "avatars", 1));
  });
});

describe("推送规则", () => {
  const row = (kind: StoredMessage["kind"], body: StoredMessage["body"]): StoredMessage => ({
    seq: 7,
    from: "alice",
    at: 1,
    kind,
    body,
    clientId: "c1",
  });
  const base: ImAlertInput = {
    convId: "dm~alice~bob",
    message: row("text", { text: "晚上吃饭" }),
    senderNickname: "爱丽丝",
    notifyPreview: false,
    convUnread: 1,
    badgeParts: { im: 3, assistant: 2 },
    foregroundOnline: false,
    muted: false,
    rejected: false,
  };

  test("前台在线、免打扰、拉黑都不发", () => {
    assert.equal(imAlertFor({ ...base, foregroundOnline: true }), null);
    assert.equal(imAlertFor({ ...base, muted: true }), null);
    assert.equal(imAlertFor({ ...base, rejected: true }), null);
  });

  test("notifyPreview=false：不带正文，未读 >1 时显示条数；角标、thread、collapse、cr", () => {
    const one = imAlertFor(base)!;
    assert.equal(one.title, "爱丽丝");
    assert.equal(one.body, "发来一条消息");
    assert.equal(imAlertFor({ ...base, convUnread: 4 })!.body, "发来 4 条消息");
    assert.equal(one.channel, "im");
    assert.equal(one.priority, 10);
    assert.equal(one.redactLog, true);
    // 角标分部按设备订阅的类别合计：iPhone（助理+聊天）5、只聊天的 iPad 3、只助理的 2
    assert.equal(apnsBadgeFor({ assistant: true, im: true }, one), 5);
    assert.equal(apnsBadgeFor({ assistant: false, im: true }, one), 3);
    assert.equal(apnsBadgeFor({ assistant: true, im: false }, one), 2);
    // 没有 badgeParts 的助理推送照旧带原数
    assert.equal(apnsBadgeFor({ assistant: true, im: true }, { badge: 7 }), 7);
    const payload = apnsPayload(one, 5);
    assert.deepEqual(payload, {
      aps: {
        alert: { title: "爱丽丝", body: "发来一条消息" },
        sound: "default",
        "thread-id": "im-dm~alice~bob",
        badge: 5,
      },
      cr: { kind: "im", convId: "dm~alice~bob", seq: 7 },
    });
    assert.equal(one.collapseId, imCollapseId("dm~alice~bob", 7));
  });

  test("notifyPreview=true：按类型给正文，文字截到 60 字", () => {
    const preview = (kind: StoredMessage["kind"], body: StoredMessage["body"]) =>
      imAlertFor({ ...base, notifyPreview: true, convUnread: 5, message: row(kind, body) })!.body;
    assert.equal(preview("text", { text: "晚上吃饭" }), "晚上吃饭");
    assert.equal(preview("text", { text: "字".repeat(80) }), `${"字".repeat(60)}…`);
    assert.equal(preview("image", { blob: BLOB, thumb: BLOB, w: 1, h: 1, original: false }), "[图片]");
    assert.equal(preview("voice", { blob: BLOB, durationMs: 12400, waveform: [] }), "[语音] 12″");
    assert.equal(preview("file", { blob: BLOB, name: "a.pdf", size: 1, mime: "application/pdf" }), "[文件] a.pdf");
    assert.equal(preview("link", { url: "https://example.com/x" }), "[链接] example.com");
    assert.equal(preview("link", { url: "https://example.com/x", title: "标题" }), "[链接] 标题");
    assert.equal(preview("location", { lat: 0, lng: 0, name: "人民广场", address: "黄浦" }), "[位置] 人民广场");
    assert.equal(imPreviewText(row("location", { lat: 0, lng: 0, name: "", address: "黄浦" })), "[位置] 黄浦");
  });

  test("撤回用同一个 collapse-id；已读是静默推送，aps.badge 按设备订阅的类别合计", () => {
    const recall = imRecallAlert("dm~alice~bob", 7, "爱丽丝", { im: 2 });
    assert.equal(recall.collapseId, imCollapseId("dm~alice~bob", 7));
    assert.equal(recall.body, "撤回了一条消息");
    assert.deepEqual(recall.badgeParts, { im: 2 });
    const read = imReadPush("dm~alice~bob", { im: 0, assistant: 0 });
    assert.equal(read.pushType, "background");
    assert.equal(read.priority, 5);
    assert.deepEqual(read.badgeParts, { im: 0, assistant: 0 });
    assert.deepEqual(apnsPayload(read, apnsBadgeFor({ assistant: true, im: true }, read)), {
      aps: { "content-available": 1, badge: 0 },
      cr: { kind: "im_read", convId: "dm~alice~bob" },
    });
    // badgeParts 在场时不缺省落 aps.badge（合计因设备而异，不能拿一个数硬套所有人）
    assert.deepEqual(apnsPayload(read), {
      aps: { "content-available": 1 },
      cr: { kind: "im_read", convId: "dm~alice~bob" },
    });
  });

  test("助理推送 payload 不变；订阅缺省 assistant=true、im=false", () => {
    assert.deepEqual(apnsPayload({ itemId: "i_1", kind: "reminder", title: "提醒", body: "喝水", chatId: "c" }), {
      aps: { alert: { title: "提醒", body: "喝水" }, sound: "default", "thread-id": "assistant-inbox" },
      cr: { itemId: "i_1", kind: "reminder", chatId: "c" },
    });
    // 两个旗标都没写：缺省 assistant=true、im=false
    const sub: Pick<ApnsSubscription, "assistant" | "im"> = {};
    assert.equal(apnsWants(sub, "assistant"), true);
    assert.equal(apnsWants(sub, "im"), false);
    assert.equal(apnsWants({ ...sub, im: true, assistant: false }, "assistant"), false);
    assert.equal(apnsWants({ ...sub, im: true, assistant: false }, "im"), true);
    assert.equal(apnsWants({ ...sub, im: true }, "im_group"), false);
    assert.equal(apnsWants({ ...sub, im: true, imGroup: true }, "im_group"), true);
  });
});
