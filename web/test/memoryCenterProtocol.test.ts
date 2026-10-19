import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAssistantOpMessage } from "@shared/assistantOp";
import { serverSamples } from "@shared/protocol-fixtures";
import type { AssistantResultMessage } from "@shared/protocol";
import {
  applyMemoryCenterResult,
  initialMemoryCenterData,
  registerPending,
} from "../components/assistant/memoryCenterReducer";

describe("memory center protocol integration", () => {
  test("buildAssistantOpMessage 带 reqId", () => {
    const get = buildAssistantOpMessage("memory_center_get");
    const search = buildAssistantOpMessage("memory_center_search", { query: "redis" });
    assert.ok(get.reqId);
    assert.ok(search.reqId);
    assert.equal(get.op, "memory_center_get");
    assert.equal(search.args?.query, "redis");
  });

  test("fixtures assistant_result 可被 reducer 消费", () => {
    const getSample = serverSamples.find(
      (row) => row.type === "assistant_result" && row.op === "memory_center_get" && row.ok,
    ) as AssistantResultMessage | undefined;
    const searchSample = serverSamples.find(
      (row) => row.type === "assistant_result" && row.op === "memory_center_search" && row.ok,
    ) as AssistantResultMessage | undefined;
    assert.ok(getSample?.reqId);
    assert.ok(searchSample?.reqId);

    let data = registerPending(initialMemoryCenterData(), { reqId: getSample!.reqId!, kind: "overview" });
    const got = applyMemoryCenterResult(data, { ...getSample!, reqId: getSample!.reqId! });
    assert.ok(got?.overview);

    data = registerPending(initialMemoryCenterData(), { reqId: searchSample!.reqId!, kind: "search" });
    const hit = applyMemoryCenterResult(data, searchSample!);
    assert.ok(hit?.search?.hits);
  });
});
