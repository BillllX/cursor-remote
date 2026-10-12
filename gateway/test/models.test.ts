import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listModels } from "../src/chat/models.ts";

const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

describe("listModels", () => {
  test("列表先返回时清掉超时定时器，不留挂着的 Timeout", async () => {
    const before = timeouts();
    const ids = await listModels("key", async () => [{ id: "m1" }, { id: "" }, { id: "m2" }], 60_000);
    assert.deepEqual(ids, ["m1", "m2"]);
    assert.equal(timeouts(), before);
  });
});
