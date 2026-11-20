import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const sourceScope = ["gateway", "shared", "scripts", "web", "package.json", "package-lock.json"];
const files: string[] = [];
function collect(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (
      ["node_modules", ".next", ".git"].includes(entry.name) ||
      entry.name.startsWith(".env") ||
      entry.name.endsWith(".tsbuildinfo")
    )
      continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if (entry.isFile()) files.push(child);
  }
}
for (const scope of sourceScope) {
  if (scope.endsWith(".json")) files.push(scope);
  else collect(scope);
}
const digest = createHash("sha256");
for (const file of files.sort())
  digest
    .update(file)
    .update("\0")
    .update(createHash("sha256").update(readFileSync(file)).digest())
    .update("\0");

// 仅创建安全测试自有的临时数据，不读取或修改线上租户和环境文件。
console.log(
  JSON.stringify({
    suite: "shared-project-security",
    testAuthorModel: "gpt-6-astra",
    execution:
      "real ProjectStore, two-process SQLite contention and real Unix socket service with temporary accounts/storage; no external model API",
    host: hostname(),
    sourceCommit: process.env.PROJECT_TEST_COMMIT ?? null,
    worktreeContentSha256: digest.digest("hex"),
    worktreeHashScope: sourceScope,
    worktreeHashExcludes: ["node_modules", ".next", ".git", ".env*", "*.tsbuildinfo", "symlinks"],
    worktreeHashedFiles: files.length,
    node: process.version,
    startedAt: new Date().toISOString(),
    command: "node --import tsx --test gateway/test/project-security.test.ts",
  }),
);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "gateway/test/project-security.test.ts"], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) console.error(result.error);
console.log(
  JSON.stringify({
    suite: "shared-project-security",
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
  }),
);
process.exitCode = result.status ?? 1;
