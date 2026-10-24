import assert from "node:assert/strict";
import test from "node:test";
import {
  ControlledWebError,
  isPublicAddress,
  readControlledWeb,
  validateControlledURL,
} from "../src/assistant/webRead.ts";

test("受控网页只接受无凭据的标准 http(s) 公网 URL", () => {
  assert.equal(validateControlledURL("https://example.com/path").hostname, "example.com");
  for (const url of [
    "file:///etc/passwd",
    "http://user:pass@example.com",
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
    "https://example.com:8443",
  ]) {
    assert.throws(() => validateControlledURL(url), ControlledWebError);
  }
  for (const address of ["10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of [
    "64:ff9b::192.0.2.1",
    "64:FF9B:0:0:0:0:C000:0201",
    "2002:c000:0201::1",
    "2001:20::1",
    "2001:2f:ffff::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("64:ff9b:1::1"), true, "NAT64 只拒绝精确 /96");
  assert.equal(isPublicAddress("2001:30::1"), true, "ORCHIDv2 只拒绝精确 /28");
  assert.throws(() => validateControlledURL("https://[64:ff9b::c000:201]/"), /私网/);
});

test("每次重定向重新校验 URL，私网目标在发请求前被拒绝", async () => {
  let requests = 0;
  await assert.rejects(
    readControlledWeb("https://example.com", {
      resolve: async (hostname) =>
        hostname === "example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
      request: async () => {
        requests += 1;
        return {
          status: 302,
          headers: { location: "http://internal.example/secret" },
          body: Buffer.alloc(0),
        };
      },
    }),
    /私网/,
  );
  assert.equal(requests, 1);
});

test("连接固定到已验证地址，并只提取受控文本类型", async () => {
  const seen: string[] = [];
  const result = await readControlledWeb("https://example.com/article", {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (_url, address, timeout, maximumBytes) => {
      seen.push(address.address);
      assert.equal(timeout, 10_000);
      assert.equal(maximumBytes, 1_000_000);
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from("<title>示例 &amp; 安全</title><script>恶意指令</script><p>可信事实</p>"),
      };
    },
  });
  assert.deepEqual(seen, ["93.184.216.34"]);
  assert.equal(result.title, "示例 & 安全");
  assert.equal(result.text, "可信事实");

  await assert.rejects(
    readControlledWeb("https://example.com/file", {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from("binary"),
      }),
    }),
    /内容类型/,
  );
});

test("混合 DNS、超大正文与重定向上限均封闭失败", async () => {
  await assert.rejects(
    readControlledWeb("https://example.com", {
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ],
      request: async () => {
        throw new Error("不应连接");
      },
    }),
    /私网/,
  );

  await assert.rejects(
    readControlledWeb("https://example.com", {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.alloc(1_000_001, 65),
      }),
    }),
    /1 MB/,
  );

  let redirects = 0;
  await assert.rejects(
    readControlledWeb("https://example.com", {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => {
        redirects += 1;
        return {
          status: 302,
          headers: { location: `https://example.com/r${redirects}` },
          body: Buffer.alloc(0),
        };
      },
    }),
    /重定向/,
  );
  assert.equal(redirects, 4);
});

test("所有 DNS/重定向/请求共用 wall-clock 总截止，成功后清理 timer", async () => {
  const started = Date.now();
  let timeoutSignal: AbortSignal | undefined;
  await assert.rejects(
    readControlledWeb("https://example.com", {
      wallClockTimeoutMs: 20,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async (_url, _address, socketTimeout, _maximumBytes, signal) => {
        timeoutSignal = signal;
        assert.equal(socketTimeout, 10_000, "总截止不能移除 socket timeout");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    }),
    /网页读取超时/,
  );
  assert.equal(timeoutSignal?.aborted, true);
  assert.ok(Date.now() - started < 500, "测试截止应有界完成");

  let successSignal: AbortSignal | undefined;
  const result = await readControlledWeb("https://example.com", {
    wallClockTimeoutMs: 20,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (_url, _address, _socketTimeout, _maximumBytes, signal) => {
      successSignal = signal;
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("完成"),
      };
    },
  });
  assert.equal(result.text, "完成");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(successSignal?.aborted, false, "成功返回后必须清理 wall-clock timer");
});
