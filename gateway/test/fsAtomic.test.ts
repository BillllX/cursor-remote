import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import { atomicWriteFileSync } from "../src/fsAtomic.ts";

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
