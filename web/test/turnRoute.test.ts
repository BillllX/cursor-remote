import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { gatewayUrl } from "../lib/chat/connection";
import { gatewayHttp } from "../lib/gatewayHttp";

const savedHttp = process.env.GATEWAY_HTTP_URL;
const savedWs = process.env.GATEWAY_WS_URL;

afterEach(() => {
  if (savedHttp == null) delete process.env.GATEWAY_HTTP_URL;
  else process.env.GATEWAY_HTTP_URL = savedHttp;
  if (savedWs == null) delete process.env.GATEWAY_WS_URL;
  else process.env.GATEWAY_WS_URL = savedWs;
});

describe("turn API 网关地址", () => {
  test("GATEWAY_WS_URL 只取 origin，不把 /bridge 拼进 HTTP 路径", () => {
    delete process.env.GATEWAY_HTTP_URL;
    process.env.GATEWAY_WS_URL = "wss://example.test/base/bridge?x=1";
    assert.equal(gatewayHttp(), "https://example.test");
  });

  test("显式 HTTP 地址优先；无配置时和网页 gatewayUrl 选同一个 origin", () => {
    process.env.GATEWAY_HTTP_URL = "http://gateway.internal:9000/";
    assert.equal(gatewayHttp(), "http://gateway.internal:9000");
    delete process.env.GATEWAY_HTTP_URL;
    delete process.env.GATEWAY_WS_URL;
    const expected = new URL(gatewayUrl());
    expected.protocol = expected.protocol === "wss:" ? "https:" : "http:";
    assert.equal(gatewayHttp(), expected.origin);
  });
});
