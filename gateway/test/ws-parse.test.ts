import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientSamples } from "../../shared/protocol-fixtures.ts";
import { parseClient } from "../src/ws/parse.ts";

describe("parseClient", () => {
  test("协议金样本里的每条客户端消息都能原样解析", () => {
    assert.ok(clientSamples.length > 0);
    for (const sample of clientSamples) {
      assert.deepEqual(parseClient(JSON.stringify(sample)), sample, sample.type);
    }
  });

  test("不是 JSON、不是对象、没有字符串 type 的都返回 null", () => {
    for (const raw of ["", "{", "not json", "null", "42", '"hello"', "[]", "{}", '{"type":1}', '{"type":null}']) {
      assert.equal(parseClient(raw), null, raw);
    }
  });

  test("只检查 type 是字符串，不校验具体类型（未知 type 交给分发处理）", () => {
    assert.deepEqual(parseClient('{"type":"no_such_type","x":1}'), { type: "no_such_type", x: 1 });
  });
});
