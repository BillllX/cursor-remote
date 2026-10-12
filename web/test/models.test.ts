import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hasUsableModel } from "../lib/models";

describe("hasUsableModel", () => {
  test("有 Cursor 密钥就算有可用模型", () => {
    assert.equal(hasUsableModel(true, ["composer-2.5"]), true);
    assert.equal(hasUsableModel(true, []), true);
  });

  test("没有密钥时，列表里有第三方模型（provider:model）也算有", () => {
    assert.equal(hasUsableModel(false, ["composer-2.5", "fake:m1"]), true);
  });

  test("没有密钥、只有网关兜底的 Cursor 默认模型：没有可用模型", () => {
    assert.equal(hasUsableModel(false, ["composer-2.5"]), false);
    assert.equal(hasUsableModel(false, []), false);
  });
});
