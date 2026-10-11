import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, test } from "node:test";
import { loginBlocked, noteLoginFail, noteLoginOk, peerIp } from "../src/auth/login.ts";
import { loginHits } from "../src/runtime/state.ts";

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
  afterEach(() => loginHits.clear());

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
    loginHits.get(ip)!.resetAt = Date.now() - 1;
    noteLoginFail(ip);
    assert.equal(loginHits.get(ip)?.count, 1);
    assert.equal(loginBlocked(ip), false);
  });
});
