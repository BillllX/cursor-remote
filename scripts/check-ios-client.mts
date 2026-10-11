// 检查 iOS ClientMessage 编码出来的 JSON 是否对得上 shared/protocol.ts 的 ClientMessage：
// 每条写成 `satisfies ClientMessage` 交给 TS 编译器做完整诊断（含嵌套字段和多余属性）。
// 用法：tsx scripts/check-ios-client.mts <ios-client.json>（由 scripts/check-ios-protocol.sh 调用）
import { readFileSync } from "node:fs";
import { loadProtocolTypes, typecheckMessages } from "../gateway/test/protocolTypes.ts";

const file = process.argv[2];
if (!file) {
  console.error("用法：tsx scripts/check-ios-client.mts <ios-client.json>");
  process.exit(1);
}

const rows = JSON.parse(readFileSync(file, "utf8")) as { case: string; message: unknown }[];
const { client } = loadProtocolTypes();
const sent = new Set<string>();
for (const row of rows) {
  const type = (row.message as { type?: unknown })?.type;
  if (typeof type === "string") sent.add(type);
}

const problems = typecheckMessages(
  "ClientMessage",
  rows.map((row) => ({ label: `iOS .${row.case}`, message: row.message })),
);

const unsent = [...client].filter((type) => !sent.has(type));
if (unsent.length) console.log(`提示：iOS ClientMessage 没有这些 type（TS 有）：${unsent.join("、")}`);

if (problems.length) {
  for (const { label, problem } of problems) console.error(`❌ ${label}：${problem}`);
  console.error(`iOS client 类型检查失败：${problems.length} 处`);
  process.exit(1);
}
console.log(`iOS client 类型检查通过：${rows.length} 条，覆盖 TS ClientMessage ${sent.size}/${client.size} 个 type ✅`);
