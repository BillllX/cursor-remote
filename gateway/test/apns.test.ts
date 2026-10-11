import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { apnsConfig, apnsHost, resetApnsCache } from "../src/assistant/apns.ts";

const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const rsaPem = generateKeyPairSync("rsa", { modulusLength: 1024 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

describe("apnsConfig(customEnv)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "cr-apns-test-"));
  const realError = console.error;
  const saved = { team: process.env.APNS_TEAM_ID, override: process.env.APNS_HOST_OVERRIDE };
  let errors: string[] = [];

  beforeEach(() => {
    resetApnsCache();
    errors = [];
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  });
  afterEach(() => {
    console.error = realError;
    for (const [key, value] of [
      ["APNS_TEAM_ID", saved.team],
      ["APNS_HOST_OVERRIDE", saved.override],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("没配全返回 null，不报错", () => {
    assert.equal(apnsConfig({}), null);
    assert.equal(apnsConfig({ APNS_TEAM_ID: "T", APNS_KEY_ID: "K" }), null);
    assert.equal(apnsConfig({ APNS_TEAM_ID: "T", APNS_KEY_ID: " ", APNS_PRIVATE_KEY: ecPem }), null);
    assert.deepEqual(errors, []);
  });

  test("只读传入的 env，不读 process.env；内联私钥支持 \\n 转义，字段去空格", () => {
    process.env.APNS_TEAM_ID = "FROM_PROCESS";
    const config = apnsConfig({
      APNS_TEAM_ID: " TEAM ",
      APNS_KEY_ID: "KEY",
      APNS_PRIVATE_KEY: ecPem.replace(/\n/g, "\\n"),
      APNS_BUNDLE_ID: " com.example.app ",
      APNS_DEFAULT_ENV: " sandbox ",
    });
    assert.ok(config);
    assert.equal(config.teamId, "TEAM");
    assert.equal(config.keyId, "KEY");
    assert.equal(config.bundleId, "com.example.app");
    assert.equal(config.defaultEnv, "sandbox");
    assert.equal(config.key.asymmetricKeyType, "ec");
  });

  test("私钥文件路径；默认环境 production；同一配置命中缓存", () => {
    const file = resolve(dir, "key.p8");
    writeFileSync(file, ecPem);
    const env = { APNS_TEAM_ID: "T", APNS_KEY_ID: "K", APNS_PRIVATE_KEY_PATH: file, APNS_DEFAULT_ENV: "dev" };
    const first = apnsConfig(env);
    assert.ok(first);
    assert.equal(first.defaultEnv, "production");
    assert.equal(first.bundleId, undefined);
    assert.equal(apnsConfig({ ...env }), first);
  });

  test("坏私钥和非 EC 私钥返回 null，同一配置只报一次错", () => {
    const bad = { APNS_TEAM_ID: "T", APNS_KEY_ID: "K", APNS_PRIVATE_KEY: "garbage" };
    assert.equal(apnsConfig(bad), null);
    assert.equal(apnsConfig(bad), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /apns: 私钥读取失败/);
    assert.equal(apnsConfig({ ...bad, APNS_PRIVATE_KEY: rsaPem }), null);
    assert.equal(errors.length, 2);
    assert.match(errors[1], /不是 EC 私钥/);
  });

  test("apnsHost 默认读 APNS_HOST_OVERRIDE（调用时）", () => {
    delete process.env.APNS_HOST_OVERRIDE;
    assert.equal(apnsHost("sandbox"), "https://api.sandbox.push.apple.com");
    process.env.APNS_HOST_OVERRIDE = "127.0.0.1:9";
    assert.equal(apnsHost("production"), "https://127.0.0.1:9");
    assert.equal(apnsHost("production", ""), "https://api.push.apple.com");
  });
});
