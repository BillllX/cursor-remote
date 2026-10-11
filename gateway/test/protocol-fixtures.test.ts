import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { clientSamples, protocolFixturesJson, serverSamples } from "../../shared/protocol-fixtures.ts";
import { loadProtocolTypes, typecheckMessages } from "./protocolTypes.ts";

const types = loadProtocolTypes();

describe("协议金样本", () => {
  test("ServerMessage 每个 type 都有样本", () => {
    const covered = new Set<string>(serverSamples.map((m) => m.type));
    const missing = [...types.server].filter((type) => !covered.has(type));
    assert.deepEqual(missing, [], `shared/protocol-fixtures.ts 的 serverSamples 缺这些 type：${missing.join("、")}`);
  });

  test("ClientMessage 每个 type 都有样本", () => {
    const covered = new Set<string>(clientSamples.map((m) => m.type));
    const missing = [...types.client].filter((type) => !covered.has(type));
    assert.deepEqual(missing, [], `shared/protocol-fixtures.ts 的 clientSamples 缺这些 type：${missing.join("、")}`);
  });

  test("protocol.json 里的样本按 JSON 重新做类型诊断也通过", () => {
    const json = protocolFixturesJson();
    const problems = [
      ...typecheckMessages(
        "ServerMessage",
        json.server.map((message, i) => ({ label: `server[${i}]`, message })),
      ),
      ...typecheckMessages(
        "ClientMessage",
        json.client.map((message, i) => ({ label: `client[${i}]`, message })),
      ),
    ];
    assert.deepEqual(problems, []);
  });

  test("类型诊断能抓到嵌套字段改名、多余属性、类型错、取值越界、缺必填", () => {
    const hello = {
      type: "hello",
      client: { name: "jiebo-ios", version: "dev", maxMessageBytes: 900000, capz: ["sync_chat"] },
    };
    const prompt = {
      type: "prompt",
      text: "hi",
      chatId: "c-1",
      mode: "fast",
      images: [{ data: "x", mime: "image/png" }],
      clientTime: { now: "1", tz: "Asia/Shanghai" },
    };
    const review = { type: "tool_review", chatId: "c-1", turnId: "t-1", reviews: [{ callId: "x" }] };
    const problems = typecheckMessages("ClientMessage", [
      { label: "hello", message: hello },
      { label: "prompt", message: prompt },
      { label: "review", message: review },
    ]);
    const text = (label: string) =>
      problems
        .filter((p) => p.label === label)
        .map((p) => p.problem)
        .join("\n");
    assert.match(text("hello"), /capz"' does not exist in type 'HelloClient'/);
    assert.match(text("prompt"), /"fast"/);
    assert.match(text("prompt"), /mime"' does not exist in type 'PromptImage'/);
    assert.match(text("prompt"), /'string' is not assignable to type 'number'/);
    assert.match(text("review"), /'review' is missing/);
  });

  test("shared/fixtures/protocol.json 与样本一致", () => {
    const path = new URL("../../shared/fixtures/protocol.json", import.meta.url);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.deepStrictEqual(
      onDisk,
      JSON.parse(JSON.stringify(protocolFixturesJson())),
      "protocol.json 过期了，跑 npm run gen:protocol-fixtures 重新生成",
    );
  });
});
