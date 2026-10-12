import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test, type TestContext } from "node:test";
import { atomicWriteFileSync, sweepStaleTmp } from "../src/fsAtomic.ts";
import { sweepStateTmp } from "../src/tenants.ts";

describe("atomicWriteFileSync", () => {
  const root = mkdtempSync(resolve(tmpdir(), "cr-fsatomic-test-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const freshDir = () => {
    const dir = resolve(root, `d${(n += 1)}`);
    mkdirSync(dir);
    return dir;
  };

  test("写入新文件，目录里不留临时文件", () => {
    const dir = freshDir();
    const file = resolve(dir, "state.json");
    atomicWriteFileSync(file, JSON.stringify({ a: 1 }));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });
    assert.deepEqual(readdirSync(dir), ["state.json"]);
  });

  test("覆盖已有文件；Buffer 原样写入", () => {
    const dir = freshDir();
    const file = resolve(dir, "blob");
    writeFileSync(file, "old content that is longer");
    atomicWriteFileSync(file, Buffer.from([0, 1, 2, 255]));
    assert.deepEqual([...readFileSync(file)], [0, 1, 2, 255]);
    atomicWriteFileSync(file, "短");
    assert.equal(readFileSync(file, "utf8"), "短");
    assert.deepEqual(readdirSync(dir), ["blob"]);
  });

  test("encoding 生效", () => {
    const dir = freshDir();
    const file = resolve(dir, "b64");
    atomicWriteFileSync(file, Buffer.from("hello").toString("base64"), { encoding: "base64" });
    assert.equal(readFileSync(file, "utf8"), "hello");
  });

  test("父目录不存在：默认抛 ENOENT，mkdir: true 时自动创建", () => {
    const dir = freshDir();
    const file = resolve(dir, "a", "b", "x.json");
    assert.throws(() => atomicWriteFileSync(file, "{}"), { code: "ENOENT" });
    atomicWriteFileSync(file, "{}", { mkdir: true });
    assert.equal(readFileSync(file, "utf8"), "{}");
  });

  test("rename 失败时抛原错误、删掉临时文件、旧目标不受影响", () => {
    const dir = freshDir();
    const target = resolve(dir, "occupied");
    mkdirSync(target);
    writeFileSync(resolve(target, "keep"), "x");
    assert.throws(
      () => atomicWriteFileSync(target, "data"),
      (err: NodeJS.ErrnoException) => {
        return typeof err.code === "string" && err.code !== "ENOENT";
      },
    );
    assert.deepEqual(readdirSync(dir), ["occupied"]);
    assert.deepEqual(readdirSync(target), ["keep"]);
  });

  test("mode 作用在新文件上（fsync 与否都一样）", { skip: process.platform === "win32" }, () => {
    const dir = freshDir();
    const plain = resolve(dir, "plain");
    const synced = resolve(dir, "synced");
    writeFileSync(plain, "old", { mode: 0o644 });
    atomicWriteFileSync(plain, "secret", { mode: 0o600 });
    atomicWriteFileSync(synced, "secret", { mode: 0o600, fsync: true });
    assert.equal(statSync(plain).mode & 0o777, 0o600);
    assert.equal(statSync(synced).mode & 0o777, 0o600);
    assert.equal(readFileSync(synced, "utf8"), "secret");
    assert.deepEqual(readdirSync(dir).sort(), ["plain", "synced"]);
  });

  test("连续多次写同一文件不留残留，内容是最后一次", () => {
    const dir = freshDir();
    const file = resolve(dir, "loop.json");
    for (let i = 0; i < 50; i += 1) atomicWriteFileSync(file, JSON.stringify({ i }), { fsync: i % 2 === 0 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { i: 49 });
    assert.deepEqual(readdirSync(dir), ["loop.json"]);
  });
});

describe("sweepStaleTmp / sweepStateTmp", () => {
  const root = mkdtempSync(resolve(tmpdir(), "cr-sweep-test-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const HOUR = 60 * 60_000;
  const now = Date.now();
  let n = 0;
  const freshDir = () => {
    const dir = resolve(root, `d${(n += 1)}`);
    mkdirSync(dir);
    return dir;
  };
  /** 建文件并把 mtime 设到 ageMs 之前 */
  const put = (dir: string, name: string, ageMs: number) => {
    const file = resolve(dir, name);
    writeFileSync(file, "x");
    const at = (now - ageMs) / 1000;
    utimesSync(file, at, at);
    return file;
  };

  test("只删超过 1 小时且名字匹配的：原子写临时文件、旧版固定名", () => {
    const dir = freshDir();
    for (const name of [
      "state.json.12345.0a1b2c3d.tmp",
      "usage.json.9.ffffffff.tmp",
      "state.json.tmp",
      "usage.json.tmp",
      "loops.json.4242.tmp",
      "loops.json.tmp",
    ]) {
      put(dir, name, 2 * HOUR);
    }
    put(dir, "state.json.777.deadbeef.tmp", 10 * 60_000);
    for (const name of ["state.json", "usage.json", "loops.json", "notes.tmp", "x.json.tmp", "a.1.xyz.tmp"]) {
      put(dir, name, 2 * HOUR);
    }
    const removed = sweepStaleTmp(dir, { now });
    assert.deepEqual(removed.sort(), [
      "loops.json.4242.tmp",
      "loops.json.tmp",
      "state.json.12345.0a1b2c3d.tmp",
      "state.json.tmp",
      "usage.json.9.ffffffff.tmp",
      "usage.json.tmp",
    ]);
    assert.deepEqual(readdirSync(dir).sort(), [
      "a.1.xyz.tmp",
      "loops.json",
      "notes.tmp",
      "state.json",
      "state.json.777.deadbeef.tmp",
      "usage.json",
      "x.json.tmp",
    ]);
  });

  test("不递归、不删目录和符号链接；目录不存在返回空", { skip: process.platform === "win32" }, () => {
    const dir = freshDir();
    const sub = resolve(dir, "workspace");
    mkdirSync(sub);
    put(sub, "state.json.tmp", 2 * HOUR);
    mkdirSync(resolve(dir, "x.json.1.0a1b2c3d.tmp"));
    const outside = put(root, "outside.1.0a1b2c3d.tmp", 2 * HOUR);
    symlinkSync(outside, resolve(dir, "link.1.0a1b2c3d.tmp"));
    assert.deepEqual(sweepStaleTmp(dir, { now }), []);
    assert.deepEqual(readdirSync(sub), ["state.json.tmp"]);
    assert.deepEqual(readFileSync(outside, "utf8"), "x");
    assert.deepEqual(sweepStaleTmp(resolve(dir, "missing"), { now }), []);
  });

  test("patterns 与 maxAgeMs 可覆盖", () => {
    const dir = freshDir();
    put(dir, "a.json.tmp", 5 * 60_000);
    put(dir, "state.json.tmp", 5 * 60_000);
    assert.deepEqual(sweepStaleTmp(dir, { now, maxAgeMs: 60_000, patterns: [/\.json\.tmp$/] }).sort(), [
      "a.json.tmp",
      "state.json.tmp",
    ]);
  });

  test("sweepStateTmp：各目录顶层 + native-sessions/，重复目录只扫一次，工作区不碰", () => {
    const global = freshDir();
    const tenant = resolve(global, "tenants", "t1");
    const sessions = resolve(tenant, "native-sessions");
    const workspace = resolve(tenant, "workspace");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    put(global, "usage.json.tmp", 2 * HOUR);
    put(global, "loops.json.1.tmp", 2 * HOUR);
    put(tenant, "state.json.tmp", 2 * HOUR);
    put(sessions, "c1.json.tmp", 2 * HOUR);
    put(sessions, "c2.json.3.0a1b2c3d.tmp", 2 * HOUR);
    put(sessions, "c3.json", 2 * HOUR);
    put(workspace, "state.json.tmp", 2 * HOUR);
    put(workspace, "foo.json.1.0a1b2c3d.tmp", 2 * HOUR);
    assert.equal(sweepStateTmp([global, tenant, `${tenant}/`], [workspace], now), 5);
    assert.deepEqual(readdirSync(global).sort(), ["tenants"]);
    assert.deepEqual(readdirSync(tenant).sort(), ["native-sessions", "workspace"]);
    assert.deepEqual(readdirSync(sessions), ["c3.json"]);
    assert.deepEqual(readdirSync(workspace).sort(), ["foo.json.1.0a1b2c3d.tmp", "state.json.tmp"]);
  });
  /** 单租户布局：状态目录 state、工作区 ws，各放一份过期临时文件；warn 走 stderr，记下条数 */
  const overlap = (t: TestContext) => {
    const warns = t.mock.method(console, "error", () => {});
    return { warns: () => warns.mock.callCount() };
  };

  test("状态目录与工作区是同一目录：跳过不删，只 warn 一次", (t) => {
    const { warns } = overlap(t);
    const dir = freshDir();
    mkdirSync(resolve(dir, "native-sessions"));
    put(dir, "state.json.tmp", 2 * HOUR);
    put(dir, "notes.json.1.0a1b2c3d.tmp", 2 * HOUR);
    put(resolve(dir, "native-sessions"), "c1.json.tmp", 2 * HOUR);
    assert.equal(sweepStateTmp([dir, dir], [`${dir}/`], now), 0);
    assert.deepEqual(readdirSync(dir).sort(), ["native-sessions", "notes.json.1.0a1b2c3d.tmp", "state.json.tmp"]);
    assert.deepEqual(readdirSync(resolve(dir, "native-sessions")), ["c1.json.tmp"]);
    assert.equal(warns(), 1);
  });

  test("符号链接别名：工作区或状态目录是对方的链接，都跳过", { skip: process.platform === "win32" }, (t) => {
    const { warns } = overlap(t);
    const real = freshDir();
    const alias = resolve(root, `alias${n}`);
    symlinkSync(real, alias);
    put(real, "usage.json.tmp", 2 * HOUR);
    assert.equal(sweepStateTmp([real], [alias], now), 0);
    assert.equal(sweepStateTmp([alias], [real], now), 0);
    assert.deepEqual(readdirSync(real), ["usage.json.tmp"]);
    assert.equal(warns(), 2);
  });

  test("状态目录在工作区里面：跳过不删", (t) => {
    const { warns } = overlap(t);
    const workspace = freshDir();
    const state = resolve(workspace, ".cursor-remote");
    mkdirSync(state);
    put(state, "state.json.tmp", 2 * HOUR);
    put(workspace, "state.json.tmp", 2 * HOUR);
    assert.equal(sweepStateTmp([state], [workspace], now), 0);
    assert.deepEqual(readdirSync(state), ["state.json.tmp"]);
    assert.deepEqual(readdirSync(workspace).sort(), [".cursor-remote", "state.json.tmp"]);
    assert.equal(warns(), 1);
  });

  test("线上布局：工作区在状态目录里面（/var/lib/cursor-remote 与其下 workspace）照常清顶层，不跳过", (t) => {
    const { warns } = overlap(t);
    const state = freshDir();
    const workspace = resolve(state, "workspace");
    const sibling = resolve(state, "workspace-old");
    mkdirSync(workspace);
    mkdirSync(sibling);
    put(state, "state.json.tmp", 2 * HOUR);
    put(state, "usage.json.4.0a1b2c3d.tmp", 2 * HOUR);
    put(workspace, "state.json.tmp", 2 * HOUR);
    assert.equal(sweepStateTmp([state], [workspace, sibling], now), 2);
    assert.deepEqual(readdirSync(state).sort(), ["workspace", "workspace-old"]);
    assert.deepEqual(readdirSync(workspace), ["state.json.tmp"]);
    assert.equal(warns(), 0);
  });
});
