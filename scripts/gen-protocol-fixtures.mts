// 由 shared/protocol-fixtures.ts 生成 shared/fixtures/protocol.json（iOS 契约测试读它）。
// 用法：npm run gen:protocol-fixtures
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { protocolFixturesJson } from "../shared/protocol-fixtures.ts";

const out = fileURLToPath(new URL("../shared/fixtures/protocol.json", import.meta.url));
const data = protocolFixturesJson();
const options = (await prettier.resolveConfig(out)) ?? {};
const text = await prettier.format(JSON.stringify(data, null, 2), { ...options, filepath: out });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(`已写入 shared/fixtures/protocol.json：server ${data.server.length} 条，client ${data.client.length} 条`);
