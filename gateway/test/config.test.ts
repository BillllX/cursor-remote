import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import { ENV_SPECS, apnsEnv, gatewayEnv, loadDotEnv, type EnvName } from "../src/config.ts";

/** 临时改 process.env，跑完原样还原（原来没有的键删掉） */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ALL_UNSET = Object.fromEntries(ENV_SPECS.map((spec) => [spec.name, undefined])) as Record<
  EnvName,
  string | undefined
>;

describe("config 默认值", () => {
  test("全部未设置", () => {
    withEnv(ALL_UNSET, () => {
      assert.equal(gatewayEnv.gatewayPort(), 8787);
      assert.equal(gatewayEnv.gatewayHost(), "127.0.0.1");
      assert.equal(gatewayEnv.webOrigin(), "http://127.0.0.1:3000");
      assert.equal(gatewayEnv.proxyWeb(), true);
      assert.equal(gatewayEnv.logLevel(), "info");
      assert.equal(gatewayEnv.cursorApiKey(), "");
      assert.equal(gatewayEnv.defaultModel(), "composer-2.5");
      assert.equal(gatewayEnv.cursorApiEndpoint(), "https://api2.cursor.sh");
      assert.equal(gatewayEnv.stateDir(), resolve(homedir(), ".cursor-remote"));
      // sandboxMasks 原表达式 env.CURSOR_REMOTE_STATE_DIR || ""：未设置不套默认目录
      assert.equal(gatewayEnv.stateDirOverride(), "");
      assert.equal(gatewayEnv.tenantsFile(), "");
      assert.equal(gatewayEnv.singleTenantToken(), "");
      assert.equal(gatewayEnv.singleTenantName(), "default");
      assert.equal(gatewayEnv.singleTenantCwd(), `${homedir()}/Projects`);
      assert.equal(gatewayEnv.singleTenantSandbox(), true);
      assert.equal(gatewayEnv.mediaSecret(), "");
      assert.equal(gatewayEnv.gitAuthorName(), "cursor-remote");
      assert.equal(gatewayEnv.gitAuthorEmail(), "cursor-remote@localhost");
      assert.equal(gatewayEnv.gitCommitterName(), undefined);
      assert.equal(gatewayEnv.gitCommitterEmail(), undefined);
      assert.equal(gatewayEnv.publishHost(), undefined);
      assert.equal(gatewayEnv.publishScheme(), undefined);
      assert.equal(gatewayEnv.publishPortMin(), 20000);
      assert.equal(gatewayEnv.publishPortMax(), 20999);
      assert.equal(gatewayEnv.publishListenMs(), 45_000);
      assert.equal(gatewayEnv.apnsHostOverride(), undefined);
    });
  });

  test("空串和未设置一样走默认（publish 数字除外）", () => {
    const empty = Object.fromEntries(ENV_SPECS.map((spec) => [spec.name, ""]));
    withEnv(empty, () => {
      assert.equal(gatewayEnv.gatewayPort(), 8787);
      assert.equal(gatewayEnv.gatewayHost(), "127.0.0.1");
      assert.equal(gatewayEnv.proxyWeb(), true);
      assert.equal(gatewayEnv.defaultModel(), "composer-2.5");
      assert.equal(gatewayEnv.singleTenantSandbox(), true);
      assert.equal(gatewayEnv.gitCommitterName(), undefined);
      // 原 numberEnv：Number("") 是 0，是有限数，不回退
      assert.equal(gatewayEnv.publishPortMin(), 0);
      assert.equal(gatewayEnv.publishListenMs(), 0);
      // 原表达式用 ??，空串原样保留
      assert.equal(gatewayEnv.publishHost(), "");
      assert.equal(gatewayEnv.publishScheme(), "");
    });
  });

  test("ENV_SPECS 名字不重复", () => {
    const names = ENV_SPECS.map((spec) => spec.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("数字解析", () => {
  test("GATEWAY_PORT 与原 Number(x || 8787) 一致", () => {
    for (const [value, expected] of [
      ["9000", 9000],
      [" 9000 ", 9000],
      ["0", 0],
      ["0x10", 16],
    ] as const) {
      withEnv({ GATEWAY_PORT: value }, () => assert.equal(gatewayEnv.gatewayPort(), expected));
    }
    withEnv({ GATEWAY_PORT: "abc" }, () => assert.ok(Number.isNaN(gatewayEnv.gatewayPort())));
  });

  test("JIEBO_PUBLISH_* 与原 numberEnv 一致：非有限数回退默认", () => {
    for (const [value, expected] of [
      ["21000", 21000],
      ["1e3", 1000],
      ["abc", 20000],
      ["Infinity", 20000],
      ["  ", 0],
    ] as const) {
      withEnv({ JIEBO_PUBLISH_PORT_MIN: value }, () => assert.equal(gatewayEnv.publishPortMin(), expected));
    }
    withEnv({ JIEBO_PUBLISH_PORT_MAX: "x", JIEBO_PUBLISH_LISTEN_MS: "5000" }, () => {
      assert.equal(gatewayEnv.publishPortMax(), 20999);
      assert.equal(gatewayEnv.publishListenMs(), 5000);
    });
  });
});

describe("布尔解析", () => {
  test("只有 0/false/off/no（不分大小写、不去空格）算假", () => {
    for (const value of ["0", "false", "FALSE", "off", "Off", "no", "NO"]) {
      withEnv({ GATEWAY_PROXY_WEB: value, CURSOR_REMOTE_SANDBOX: value }, () => {
        assert.equal(gatewayEnv.proxyWeb(), false, value);
        assert.equal(gatewayEnv.singleTenantSandbox(), false, value);
      });
    }
    for (const value of ["1", "true", "yes", " 0", "0 ", "nope", "disabled"]) {
      withEnv({ GATEWAY_PROXY_WEB: value, CURSOR_REMOTE_SANDBOX: value }, () => {
        assert.equal(gatewayEnv.proxyWeb(), true, value);
        assert.equal(gatewayEnv.singleTenantSandbox(), true, value);
      });
    }
  });
});

describe("字符串与组合", () => {
  test("去空格和回退链", () => {
    withEnv(
      {
        CURSOR_API_KEY: "  key  ",
        CURSOR_API_ENDPOINT: "http://x/",
        CURSOR_REMOTE_TOKEN: "",
        CURSOR_REMOTE_PASSWORD: " pw ",
        CURSOR_REMOTE_NAME: "   ",
        CURSOR_REMOTE_TENANTS_FILE: " /t.json ",
        GIT_AUTHOR_NAME: "",
        CURSOR_REMOTE_GIT_NAME: "bot",
        GIT_AUTHOR_EMAIL: "a@b",
        GATEWAY_LOG_LEVEL: " DEBUG ",
      },
      () => {
        assert.equal(gatewayEnv.cursorApiKey(), "key");
        assert.equal(gatewayEnv.cursorApiEndpoint(), "http://x");
        assert.equal(gatewayEnv.singleTenantToken(), "pw");
        assert.equal(gatewayEnv.singleTenantName(), "default");
        assert.equal(gatewayEnv.tenantsFile(), "/t.json");
        assert.equal(gatewayEnv.gitAuthorName(), "bot");
        assert.equal(gatewayEnv.gitAuthorEmail(), "a@b");
        assert.equal(gatewayEnv.logLevel(), "debug");
      },
    );
    withEnv({ CURSOR_API_KEY: "   ", GATEWAY_LOG_LEVEL: "verbose" }, () => {
      assert.equal(gatewayEnv.cursorApiKey(), "");
      assert.equal(gatewayEnv.logLevel(), "info");
    });
  });

  test("apnsEnv 可读传入的 env 对象", () => {
    const vars = apnsEnv({ APNS_TEAM_ID: "T", APNS_DEFAULT_ENV: "sandbox" });
    assert.equal(vars.teamId, "T");
    assert.equal(vars.defaultEnv, "sandbox");
    assert.equal(vars.keyId, undefined);
  });
});

describe("调用时读取", () => {
  test("访问器不拍快照，每次调用读当前 process.env", () => {
    withEnv({ GATEWAY_PORT: "1111", APNS_TEAM_ID: "A", CURSOR_REMOTE_STATE_DIR: "/one" }, () => {
      assert.equal(gatewayEnv.gatewayPort(), 1111);
      assert.equal(apnsEnv().teamId, "A");
      assert.equal(gatewayEnv.stateDir(), "/one");
      process.env.GATEWAY_PORT = "2222";
      process.env.APNS_TEAM_ID = "B";
      process.env.CURSOR_REMOTE_STATE_DIR = "/two";
      assert.equal(gatewayEnv.gatewayPort(), 2222);
      assert.equal(apnsEnv().teamId, "B");
      assert.equal(gatewayEnv.stateDir(), "/two");
      assert.equal(gatewayEnv.stateDirOverride(), "/two");
    });
  });
});

describe("loadDotEnv", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cr-config-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("只补缺不覆盖，支持引号和注释，缺文件跳过", () => {
    const first = resolve(dir, "a.env");
    const second = resolve(dir, "b.env");
    writeFileSync(
      first,
      [
        "# 注释",
        "",
        "CR_TEST_NEW=from-file",
        "CR_TEST_KEEP=from-file",
        "CR_TEST_EMPTY=from-file",
        'CR_TEST_DQ="quoted value"',
        "CR_TEST_SQ='single'",
        "  CR_TEST_SPACED  =  padded  ",
        "CR_TEST_EQ=a=b",
        "not a pair",
      ].join("\n"),
    );
    writeFileSync(second, "CR_TEST_NEW=second\nCR_TEST_SECOND=only-second\n");
    const keys = [
      "CR_TEST_NEW",
      "CR_TEST_KEEP",
      "CR_TEST_EMPTY",
      "CR_TEST_DQ",
      "CR_TEST_SQ",
      "CR_TEST_SPACED",
      "CR_TEST_EQ",
      "CR_TEST_SECOND",
    ];
    const vars: Record<string, string | undefined> = Object.fromEntries(keys.map((key) => [key, undefined]));
    vars.CR_TEST_KEEP = "from-env";
    vars.CR_TEST_EMPTY = "";
    withEnv(vars, () => {
      loadDotEnv([resolve(dir, "missing.env"), first, second]);
      assert.equal(process.env.CR_TEST_NEW, "from-file");
      assert.equal(process.env.CR_TEST_KEEP, "from-env");
      assert.equal(process.env.CR_TEST_EMPTY, "");
      assert.equal(process.env.CR_TEST_DQ, "quoted value");
      assert.equal(process.env.CR_TEST_SQ, "single");
      assert.equal(process.env.CR_TEST_SPACED, "padded");
      assert.equal(process.env.CR_TEST_EQ, "a=b");
      assert.equal(process.env.CR_TEST_SECOND, "only-second");
    });
    for (const key of keys) assert.equal(process.env[key], undefined, `${key} 应已还原`);
  });
});
