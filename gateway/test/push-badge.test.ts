import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  assistantBadge,
  assistantBadgeCached,
  STATE_INBOX_LIMIT,
  within,
  withinCached,
} from "../src/assistant/badge.ts";
import { addApnsSubscription, listApnsSubscriptions, releaseApnsToken } from "../src/assistant/push.ts";
import { assistantPath, writeJson, type TenantRef } from "../src/assistant/store.ts";

const root = mkdtempSync(resolve(tmpdir(), "cr-push-badge-"));
after(() => rmSync(root, { recursive: true, force: true }));

const ref = (id: string): TenantRef => ({ id, stateDir: resolve(root, id) });
const TOKEN = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const sub = (token: string) => ({ token, bundleId: "ai.jiebo.app", environment: "sandbox", im: true });

describe("APNs 设备转绑", () => {
  test("同一个 token 被某租户订阅后，从其他所有租户摘掉；别的 token 和自己的不动", async () => {
    const alice = ref("alice");
    const bob = ref("bob");
    const carol = ref("carol");
    assert.equal(addApnsSubscription(alice, sub(TOKEN)).ok, true);
    assert.equal(addApnsSubscription(alice, sub(OTHER)).ok, true);
    assert.equal(addApnsSubscription(carol, sub(TOKEN.toUpperCase())).ok, true);
    assert.equal(addApnsSubscription(bob, sub(TOKEN)).ok, true);

    const released = await releaseApnsToken(TOKEN, "bob", [alice, bob, carol, ref("dave")]);
    assert.deepEqual(released.sort(), ["alice", "carol"]);
    assert.deepEqual(
      listApnsSubscriptions(alice).map((item) => item.token),
      [OTHER],
    );
    assert.deepEqual(listApnsSubscriptions(carol), []);
    assert.deepEqual(
      listApnsSubscriptions(bob).map((item) => item.token),
      [TOKEN],
    );
    // 再来一次什么都不改；不合法的 token 直接忽略
    assert.deepEqual(await releaseApnsToken(TOKEN, "bob", [alice, bob, carol]), []);
    assert.deepEqual(await releaseApnsToken("not-hex", "bob", [alice]), []);
  });
});

describe("助理角标", () => {
  test("最近 STATE_INBOX_LIMIT 条里没读的 + 挂起的审批；文件不存在算 0", async () => {
    const empty = ref("empty");
    assert.equal(await assistantBadge(empty), 0);
    const busy = ref("busy");
    const old = Array.from({ length: 5 }, (_, i) => ({ id: `old-${i}`, read: false }));
    const recent = Array.from({ length: STATE_INBOX_LIMIT }, (_, i) => ({ id: `new-${i}`, read: i % 2 === 0 }));
    writeJson(assistantPath(busy, "inbox.json"), { items: [...old, ...recent] });
    writeJson(assistantPath(busy, "approvals.json"), { items: [{ id: "a1" }, { id: "a2" }] });
    // 前面那 5 条没读的超出 App 能看到的范围，不算
    assert.equal(await assistantBadge(busy), STATE_INBOX_LIMIT / 2 + 2);
  });

  test("within：超时或失败返回 undefined，按时完成返回结果", async () => {
    assert.equal(await within(Promise.resolve(7), 50), 7);
    assert.equal(await within(Promise.reject(new Error("x")), 50), undefined);
    assert.equal(await within(new Promise<number>((done) => setTimeout(() => done(1), 200)), 20), undefined);
  });

  test("withinCached：按时完成记下并返回；超时/失败用新鲜缓存顶着，缓存过期才 undefined", async () => {
    const key = "badge-test";
    assert.equal(await withinCached(key, () => Promise.resolve(7), 50), 7);
    // 超时（20ms 上限、50ms 才完成）→ 用刚缓存的 7，不是 undefined
    assert.equal(await withinCached(key, () => new Promise<number>((done) => setTimeout(() => done(9), 50)), 20), 7);
    // 失败也走缓存
    assert.equal(await withinCached(key, () => Promise.reject(new Error("x")), 50), 7);
    // 缓存过期（cacheMs 0）→ undefined（这个分量不带，不能拿旧数硬发）
    assert.equal(
      await withinCached(key, () => new Promise<number>((done) => setTimeout(() => done(9), 50)), 20, 0),
      undefined,
    );
    // 从没成功过也没有缓存
    assert.equal(await withinCached("badge-fresh", () => Promise.reject(new Error("x")), 50), undefined);
  });

  test("assistantBadgeCached：文件不存在算 0；读到的数记进缓存、重复读一致", async () => {
    assert.equal(await assistantBadgeCached(ref("badge-missing"), 500), 0);
    const busy = ref("badge-busy");
    writeJson(assistantPath(busy, "inbox.json"), { items: [{ id: "a1" }, { id: "a2", read: true }] });
    writeJson(assistantPath(busy, "approvals.json"), { items: [{ id: "p1" }] });
    assert.equal(await assistantBadgeCached(busy, 500), 2);
    assert.equal(await assistantBadgeCached(busy, 500), 2);
  });
});
