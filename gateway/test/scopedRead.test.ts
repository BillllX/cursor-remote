import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test, after, describe } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFileAtScope,
  relPathHasSymlink,
  scopedReadErrnoResult,
  scopedReadPlatformAllowed,
  scopedReadSupported,
} from "../src/assistant/scopedRead.ts";

const root = mkdtempSync(join(tmpdir(), "cr-scoped-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("scopedRead platform", () => {
  test("非 Linux 平台 fail closed", () => {
    assert.equal(scopedReadPlatformAllowed("darwin"), false);
    assert.equal(scopedReadPlatformAllowed("linux"), true);
    assert.equal(scopedReadSupported("darwin"), false);
  });

  test("Linux 上 O_NOFOLLOW 可用", () => {
    if (process.platform !== "linux") return;
    assert.equal(scopedReadSupported("linux"), true);
  });
});

describe("scopedRead errors", () => {
  test("EACCES 映射为 eacces 而非空文件", () => {
    const mapped = scopedReadErrnoResult("EACCES");
    assert.equal(mapped.code, "eacces");
    assert.match(mapped.message, /权限/);
    assert.equal(scopedReadErrnoResult("EPERM").code, "eacces");
    assert.equal(scopedReadErrnoResult("EIO").code, "eio");
  });

  test("ENOENT 映射为 enoent", () => {
    if (process.platform !== "linux") return;
    const dir = join(root, "enoent");
    mkdirSync(dir, { recursive: true });
    const read = readFileAtScope(dir, "missing.md", 1000);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.code, "enoent");
  });

  test("缺少 .jiebo 目录不是符号链接", () => {
    const dir = join(root, "no-jiebo");
    mkdirSync(dir, { recursive: true });
    assert.equal(relPathHasSymlink(dir, ".jiebo/memory.md"), false);
    assert.equal(relPathHasSymlink(dir, ".cursor/rules/a.md"), false);
    if (process.platform === "linux") {
      const read = readFileAtScope(dir, ".jiebo/memory.md", 1000);
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.code, "enoent");
    }
    writeFileSync(join(dir, ".jiebo"), "not-a-directory");
    assert.equal(relPathHasSymlink(dir, ".jiebo/memory.md"), true);
  });
});

describe("scopedRead intermediate symlinks", () => {
  test(".cursor 与 .jiebo 指向外部", () => {
    if (process.platform !== "linux") return;
    const base = join(root, "mid-link");
    const outside = join(root, "mid-out");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "memory.md"), "leak");
    writeFileSync(join(outside, "a.md"), "leak");
    const ws = join(base, "ws");
    mkdirSync(ws, { recursive: true });
    symlinkSync(outside, join(ws, ".jiebo"));
    symlinkSync(outside, join(ws, ".cursor"));
    assert.equal(relPathHasSymlink(ws, ".jiebo/memory.md"), true);
    assert.equal(relPathHasSymlink(ws, ".cursor/rules/a.md"), true);
  });
});
