import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, test } from "node:test";
import { loginBlocked, noteLoginFail, noteLoginOk, peerIp, sweepExpiredLoginHits } from "../src/auth/login.ts";
import { gatewayState, type LoginHit } from "../src/runtime/state.ts";

const req = (remoteAddress: string, forwarded?: string) =>
  ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  }) as unknown as IncomingMessage;

describe("peerIp", () => {
  test("只有来自本机（反代）时才信 x-forwarded-for，取最后一跳", () => {
    assert.equal(peerIp(req("127.0.0.1", "1.1.1.1, 2.2.2.2")), "2.2.2.2");
    assert.equal(peerIp(req("::1", " 3.3.3.3 ")), "3.3.3.3");
    assert.equal(peerIp(req("8.8.8.8", "1.1.1.1")), "8.8.8.8");
  });

  test("本机来源但没有转发头时用对端地址；拿不到地址返回 unknown", () => {
    assert.equal(peerIp(req("127.0.0.1")), "127.0.0.1");
    assert.equal(peerIp(req("127.0.0.1", " , ")), "127.0.0.1");
    assert.equal(peerIp(req("")), "unknown");
    assert.equal(peerIp(undefined), "unknown");
  });
});

describe("登录失败限流", () => {
  afterEach(() => gatewayState.loginHits.clear());

  test("连续失败 8 次后封禁，成功登录清掉记录", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 7; i += 1) noteLoginFail(ip);
    assert.equal(loginBlocked(ip), false);
    noteLoginFail(ip);
    assert.equal(loginBlocked(ip), true);
    assert.equal(loginBlocked("10.0.0.2"), false);
    noteLoginOk(ip);
    assert.equal(loginBlocked(ip), false);
  });

  test("计数窗口过期后重新计数", () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 7; i += 1) noteLoginFail(ip);
    gatewayState.loginHits.get(ip)!.resetAt = Date.now() - 1;
    noteLoginFail(ip);
    assert.equal(gatewayState.loginHits.get(ip)?.count, 1);
    assert.equal(loginBlocked(ip), false);
  });

  test("过期条目惰性清掉：查询时删，表长了以后失败时顺手扫", () => {
    const hits = new Map<string, LoginHit>();
    const t0 = 1_000_000;
    noteLoginFail("a", hits, t0);
    assert.equal(loginBlocked("a", hits, t0 + 11 * 60_000), false);
    assert.equal(hits.has("a"), false);

    for (let i = 0; i < 600; i += 1) noteLoginFail(`old-${i}`, hits, t0);
    assert.equal(hits.size, 600, "都还在计数窗口里，一条不删");
    const later = t0 + 11 * 60_000;
    noteLoginFail("new", hits, later);
    assert.deepEqual([...hits.keys()], ["new"]);
  });

  test("封禁期内的条目即使计数窗口过了也不清，限速不变", () => {
    const hits = new Map<string, LoginHit>();
    const t0 = 1_000_000;
    for (let i = 0; i < 8; i += 1) noteLoginFail("b", hits, t0 + i * 60_000);
    // 第 8 次在 t0+7min，封到 t0+17min；计数窗口在 t0+10min 就过了
    sweepExpiredLoginHits(hits, t0 + 12 * 60_000);
    assert.equal(loginBlocked("b", hits, t0 + 12 * 60_000), true);
    assert.equal(loginBlocked("b", hits, t0 + 18 * 60_000), false);
    assert.equal(hits.size, 0);
  });

  test("条目数超上限时淘汰最久没失败过的", () => {
    const hits = new Map<string, LoginHit>();
    const t0 = 1_000_000;
    for (const ip of ["a", "b", "c", "d"]) noteLoginFail(ip, hits, t0, 2);
    assert.deepEqual([...hits.keys()], ["c", "d"]);
    noteLoginFail("c", hits, t0 + 1, 2);
    noteLoginFail("e", hits, t0 + 2, 2);
    assert.deepEqual([...hits.keys()], ["c", "e"]);
  });

  test("全表扫过期条目按时间节流：上次扫完不到 60 秒不再扫", () => {
    const hits = new Map<string, LoginHit>();
    const t0 = 1_000_000;
    const min = 60_000;
    // 第 512 条时扫过一次（t0）
    for (let i = 0; i < 600; i += 1) noteLoginFail(`old-${i}`, hits, t0);
    for (let i = 0; i < 600; i += 1) noteLoginFail(`mid-${i}`, hits, t0 + 30_000);
    assert.equal(hits.size, 1200, "离上次扫不到 60 秒，表再长也不扫");
    noteLoginFail("a1", hits, t0 + 10 * min + 1_000);
    assert.equal(hits.size, 601, "old-* 过期被扫掉，mid-* 还在窗口里");
    noteLoginFail("a2", hits, t0 + 10 * min + 31_000);
    assert.equal(hits.size, 602, "mid-* 已过期，但离上次扫只有 30 秒，不扫");
    noteLoginFail("a3", hits, t0 + 11 * min + 2_000);
    assert.deepEqual([...hits.keys()], ["a1", "a2", "a3"]);
  });
});
