import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { errText, log, logEnabled, warnThrottled } from "../src/log.ts";

type Captured = { stream: "stdout" | "stderr"; line: string };

describe("log 级别过滤与输出流", () => {
  const savedLevel = process.env.GATEWAY_LOG_LEVEL;
  const realLog = console.log;
  const realError = console.error;
  let out: Captured[] = [];

  beforeEach(() => {
    out = [];
    console.log = (...args: unknown[]) => void out.push({ stream: "stdout", line: args.join(" ") });
    console.error = (...args: unknown[]) => void out.push({ stream: "stderr", line: args.join(" ") });
  });
  afterEach(() => {
    console.log = realLog;
    console.error = realError;
    if (savedLevel === undefined) delete process.env.GATEWAY_LOG_LEVEL;
    else process.env.GATEWAY_LOG_LEVEL = savedLevel;
  });

  function emitAll() {
    log.debug("d", 1);
    log.info("frame clipped", "files", 10, "->", 5);
    log.warn("frame dropped", "files", 10, ">", 5);
    log.error("upload", "boom");
  }

  test("默认 info：debug 不输出，info→stdout，warn/error→stderr，带级别标签", () => {
    delete process.env.GATEWAY_LOG_LEVEL;
    emitAll();
    assert.deepEqual(out, [
      { stream: "stdout", line: "[info] frame clipped files 10 -> 5" },
      { stream: "stderr", line: "[warn] frame dropped files 10 > 5" },
      { stream: "stderr", line: "[error] upload boom" },
    ]);
  });

  test("debug 级别全部输出，debug 走 stdout", () => {
    process.env.GATEWAY_LOG_LEVEL = "debug";
    emitAll();
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], { stream: "stdout", line: "[debug] d 1" });
  });

  test("warn / error 级别", () => {
    process.env.GATEWAY_LOG_LEVEL = "warn";
    emitAll();
    assert.deepEqual(
      out.map((item) => item.line.split(" ")[0]),
      ["[warn]", "[error]"],
    );
    out = [];
    process.env.GATEWAY_LOG_LEVEL = "error";
    emitAll();
    assert.deepEqual(
      out.map((item) => item.line.split(" ")[0]),
      ["[error]"],
    );
    assert.equal(logEnabled("warn"), false);
  });

  test("非法级别按 info；级别在调用时读取", () => {
    process.env.GATEWAY_LOG_LEVEL = "loud";
    assert.equal(logEnabled("debug"), false);
    assert.equal(logEnabled("info"), true);
    process.env.GATEWAY_LOG_LEVEL = "debug";
    assert.equal(logEnabled("debug"), true);
  });

  test("横幅原样输出，不受级别限制", () => {
    process.env.GATEWAY_LOG_LEVEL = "error";
    log.banner("cursor-remote gateway  http://127.0.0.1:8787");
    assert.deepEqual(out, [{ stream: "stdout", line: "cursor-remote gateway  http://127.0.0.1:8787" }]);
  });

  test("warnThrottled：同 key 窗口内只 warn 一次，其余降为 debug；不同 key 互不影响", (t) => {
    process.env.GATEWAY_LOG_LEVEL = "debug";
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    warnThrottled("t.a", 1000, "写盘失败", "x");
    warnThrottled("t.a", 1000, "写盘失败", "y");
    warnThrottled("t.b", 1000, "别的失败");
    t.mock.timers.tick(1000);
    warnThrottled("t.a", 1000, "写盘失败", "z");
    assert.deepEqual(
      out.map((item) => item.line),
      ["[warn] 写盘失败 x", "[debug] 写盘失败 y", "[warn] 别的失败", "[warn] 写盘失败 z"],
    );
    out = [];
    process.env.GATEWAY_LOG_LEVEL = "info";
    warnThrottled("t.a", 1000, "静默");
    assert.deepEqual(out, []);
  });

  test("errText：Error 只留 code 与 message，不带堆栈", () => {
    const fsErr = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    assert.equal(errText(fsErr), "ENOSPC disk full");
    assert.equal(errText(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })), "ENOENT: no such file");
    assert.equal(errText(new Error("bad")), "bad");
    assert.equal(errText("plain"), "plain");
  });

  test("对象和 Error 按 util.format 展开成单行前缀", () => {
    delete process.env.GATEWAY_LOG_LEVEL;
    log.warn("agent missing, opening a new one", { chatId: "c1" });
    log.error(new Error("bad"));
    assert.equal(out[0].line, "[warn] agent missing, opening a new one { chatId: 'c1' }");
    assert.match(out[1].line, /^\[error\] Error: bad\n/);
  });
});

describe("log 真实输出流", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cr-log-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("info 写进 stdout，warn/error 写进 stderr", () => {
    const script = resolve(dir, "emit.mts");
    const logUrl = pathToFileURL(resolve(import.meta.dirname, "../src/log.ts")).href;
    writeFileSync(
      script,
      [
        `import { log } from ${JSON.stringify(logUrl)};`,
        `log.debug("hidden");`,
        `log.info("upload", "/tmp/a", 3);`,
        `log.warn("frame dropped", "files");`,
        `log.error("ws error", "x");`,
        `log.banner("cursor-remote gateway  http://h:1");`,
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GATEWAY_LOG_LEVEL;
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "[info] upload /tmp/a 3\ncursor-remote gateway  http://h:1\n");
    assert.equal(result.stderr, "[warn] frame dropped files\n[error] ws error x\n");
  });
});
