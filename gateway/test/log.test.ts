import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { errText, log, logEnabled, slotLog, warnThrottled } from "../src/log.ts";

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

  test("log.with：text 格式在级别标签后加 [t= c=]，只给一个字段时只出一个；子 logger 可再叠加", () => {
    delete process.env.GATEWAY_LOG_LEVEL;
    delete process.env.GATEWAY_LOG_FORMAT;
    const runLog = log.with({ tenant: "billxu", chatId: "c-123" });
    runLog.warn("取消过期运行失败", "boom");
    runLog.error("turn files", 3);
    runLog.info("frame clipped");
    log.with({ tenant: "t1" }).warn("state 落盘失败");
    log.with({ chatId: "c9" }).with({ tenant: "t2" }).warn("x");
    log.with({ tenant: "t1", chatId: "a" }).with({ chatId: "b" }).warn("y");
    log.with({}).warn("plain");
    slotLog({ tenantId: "t3", chatId: "c3" }).error("mcp", "x");
    assert.deepEqual(out, [
      { stream: "stderr", line: "[warn] [t=billxu c=c-123] 取消过期运行失败 boom" },
      { stream: "stderr", line: "[error] [t=billxu c=c-123] turn files 3" },
      { stream: "stdout", line: "[info] [t=billxu c=c-123] frame clipped" },
      { stream: "stderr", line: "[warn] [t=t1] state 落盘失败" },
      { stream: "stderr", line: "[warn] [t=t2 c=c9] x" },
      { stream: "stderr", line: "[warn] [t=t1 c=b] y" },
      { stream: "stderr", line: "[warn] plain" },
      { stream: "stderr", line: "[error] [t=t3 c=c3] mcp x" },
    ]);
  });

  test("子 logger 同样受级别过滤", () => {
    process.env.GATEWAY_LOG_LEVEL = "warn";
    log.with({ tenant: "t" }).info("hidden");
    log.with({ tenant: "t" }).debug("hidden");
    assert.deepEqual(out, []);
  });

  test("GATEWAY_LOG_FORMAT=json：每条一行 JSON，含 level/time/tenant/chatId/msg，输出流不变", (t) => {
    delete process.env.GATEWAY_LOG_LEVEL;
    process.env.GATEWAY_LOG_FORMAT = " JSON ";
    t.after(() => delete process.env.GATEWAY_LOG_FORMAT);
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 2, 3, 4, 5) });
    log.with({ tenant: "t1", chatId: "c1" }).warn("frame dropped", { n: 1 });
    log.info("upload", "/tmp/a");
    log.error(new Error("bad"));
    log.banner("cursor-remote gateway  http://h:1");
    assert.deepEqual(
      out.map((item) => item.stream),
      ["stderr", "stdout", "stderr", "stdout"],
    );
    const rows = out.map((item) => JSON.parse(item.line) as Record<string, unknown>);
    assert.ok(out.every((item) => !item.line.includes("\n")));
    assert.deepEqual(rows[0], {
      level: "warn",
      time: "2026-01-02T03:04:05.000Z",
      tenant: "t1",
      chatId: "c1",
      msg: "frame dropped { n: 1 }",
    });
    assert.deepEqual(rows[1], { level: "info", time: "2026-01-02T03:04:05.000Z", msg: "upload /tmp/a" });
    assert.equal(rows[2].level, "error");
    assert.match(String(rows[2].msg), /^Error: bad\n/);
    assert.deepEqual(rows[3], {
      level: "info",
      time: "2026-01-02T03:04:05.000Z",
      msg: "cursor-remote gateway  http://h:1",
    });
  });

  test("GATEWAY_LOG_FORMAT 其它值按 text", () => {
    delete process.env.GATEWAY_LOG_LEVEL;
    process.env.GATEWAY_LOG_FORMAT = "yaml";
    try {
      log.with({ tenant: "t" }).warn("x");
    } finally {
      delete process.env.GATEWAY_LOG_FORMAT;
    }
    assert.deepEqual(out, [{ stream: "stderr", line: "[warn] [t=t] x" }]);
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
    delete env.GATEWAY_LOG_FORMAT;
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "[info] upload /tmp/a 3\ncursor-remote gateway  http://h:1\n");
    assert.equal(result.stderr, "[warn] frame dropped files\n[error] ws error x\n");
  });
});
