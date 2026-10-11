#!/usr/bin/env node
// 把当前不符合 Prettier 的文件写进 .prettierignore 的「遗留文件」区块，老文件豁免、新文件必须合规。
// 可重复运行：只重写区块内容，区块外的忽略规则原样保留；已经格式化好的文件会自动从名单里掉出去。
// 检查范围取自 package.json 的 format:check 脚本，两处不会写岔。
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoreFile = resolve(root, ".prettierignore");
const tmpIgnore = resolve(root, ".prettierignore.baseline.tmp");
const BEGIN = "# >>> 遗留文件：格式化后从这里删掉";
const END = "# <<< 遗留文件";

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const patterns = [...String(pkg.scripts?.["format:check"] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (!patterns.length) {
  console.error("package.json 的 format:check 里没找到带双引号的文件范围");
  process.exit(1);
}

const text = readFileSync(ignoreFile, "utf8");
const lines = text.split("\n");
const begin = lines.findIndex((line) => line.startsWith(BEGIN));
const end = lines.findIndex((line, i) => i > begin && line.startsWith(END));
if (begin < 0 || end < 0) {
  console.error(`.prettierignore 里缺少「${BEGIN}」…「${END}」区块`);
  process.exit(1);
}
const before = lines.slice(0, begin + 1);
const after = lines.slice(end);

// 忽略文件里的路径相对于忽略文件所在目录，临时文件必须放在仓库根
writeFileSync(tmpIgnore, [...before, ...after].join("\n"));
let result;
try {
  result = spawnSync(
    resolve(root, "node_modules/.bin/prettier"),
    [
      "--list-different",
      "--no-error-on-unmatched-pattern",
      "--ignore-path",
      ".gitignore",
      "--ignore-path",
      ".prettierignore.baseline.tmp",
      ...patterns,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} finally {
  rmSync(tmpIgnore, { force: true });
}
if (result.error) throw result.error;
// 0：全部合规；1：有不合规；2：有文件解析失败（也算遗留），其余视为 prettier 本身出错
if (![0, 1, 2].includes(result.status ?? -1)) {
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

const legacy = new Set();
for (const line of result.stdout.split("\n")) {
  const file = line.trim();
  if (file) legacy.add(file);
}
for (const line of result.stderr.split("\n")) {
  const match = /^\[error\] ([^:]+): /.exec(line);
  if (match) legacy.add(match[1]);
}
const sorted = [...legacy].sort();
const old = new Set(lines.slice(begin + 1, end).filter((line) => line && !line.startsWith("#")));

writeFileSync(ignoreFile, [...before, ...sorted, ...after].join("\n"));

const added = sorted.filter((file) => !old.has(file));
const removed = [...old].filter((file) => !legacy.has(file));
console.log(`遗留文件 ${sorted.length} 个（新增 ${added.length}，已合规移出 ${removed.length}）`);
for (const file of added) console.log(`  + ${file}`);
for (const file of removed) console.log(`  - ${file}`);
