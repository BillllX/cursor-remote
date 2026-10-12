import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 不带 JIEBO_WS_URL 和口令跑：脚本必须在连网关之前就退出 */
function runBare(args: string[]) {
  const env = { ...process.env };
  delete env.JIEBO_WS_URL;
  delete env.CURSOR_REMOTE_TOKEN;
  return spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
}

describe("冒烟脚本", () => {
  test("需要已运行网关的脚本没设 JIEBO_WS_URL 时报错退出，不默认连本机 8787", () => {
    for (const file of [
      "slim-smoke.mjs",
      "resume-smoke.mjs",
      "workspace-smoke.mjs",
      "multidevice-smoke.mjs",
      "ios-smoke.mjs",
      "loop-smoke.mjs",
      "native-e2e.mjs",
    ]) {
      const res = runBare([`scripts/smoke/${file}`]);
      assert.equal(res.status, 2, file);
      assert.match(res.stderr, /缺少 JIEBO_WS_URL/, file);
    }
  });

  test("bench 脚本同样必须设 JIEBO_WS_URL；dialect-bench --plan 不连网关不需要", () => {
    for (const file of ["policy-bench.mjs", "dialect-bench.mjs"]) {
      const res = runBare([`scripts/bench/${file}`]);
      assert.equal(res.status, 2, file);
      assert.match(res.stderr, /缺少 JIEBO_WS_URL/, file);
    }
    assert.equal(runBare(["scripts/bench/dialect-bench.mjs", "--plan"]).status, 0);
  });

  test("run.mjs --only 按参数顺序排，重复的只算一次", () => {
    const res = runBare(["scripts/smoke/run.mjs", "--list", "--only=publish,assistant,slim,publish"]);
    assert.equal(res.status, 0, res.stderr);
    const names = res.stdout
      .split("\n")
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => ["publish", "assistant", "slim"].includes(name));
    assert.deepEqual(names, ["publish", "assistant", "slim"]);
  });
});
