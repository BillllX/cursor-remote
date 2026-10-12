import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { resolveInside } from "../src/native/confine.ts";
import { isInside, relEscapes } from "../src/pathInside.ts";
import { confinedCwd } from "../src/tenants.ts";
import { workspacePath } from "../src/workspace/files.ts";

describe("relEscapes / isInside", () => {
  test("只有 ..、../ 开头和绝对路径算跑出去", () => {
    assert.equal(relEscapes(".."), true);
    assert.equal(relEscapes("../a"), true);
    assert.equal(relEscapes("/abs"), true);
    assert.equal(relEscapes(""), false);
    assert.equal(relEscapes("a/b"), false);
    assert.equal(relEscapes("..notes.md"), false);
    assert.equal(relEscapes("...x/y"), false);
  });

  test("isInside：根本身算在里面，前缀相同的兄弟目录不算", () => {
    assert.equal(isInside("/w", "/w"), true);
    assert.equal(isInside("/w/..notes.md", "/w"), true);
    assert.equal(isInside("/w/a/b", "/w"), true);
    assert.equal(isInside("/wx", "/w"), false);
    assert.equal(isInside("/", "/w"), false);
  });
});

describe("各处越界判断统一放过 .. 开头的文件名", () => {
  const root = mkdtempSync(join(tmpdir(), "cr-inside-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "..dir"));
  writeFileSync(join(root, "..notes.md"), "x");

  test("workspacePath", () => {
    assert.equal(workspacePath(root, "..notes.md"), "..notes.md");
    assert.equal(workspacePath(root, "../x"), null);
  });

  test("confinedCwd（tenants.ts 的 inside）", () => {
    assert.equal(confinedCwd("..dir", root), join(root, "..dir"));
    assert.equal(confinedCwd("../", root), null);
  });

  test("resolveInside（自研 Agent 的路径围栏）", () => {
    assert.equal(resolveInside(root, "..notes.md").rel, "..notes.md");
    assert.throws(() => resolveInside(root, "../x"), /不在工作区内/);
    symlinkSync(tmpdir(), join(root, "..out"));
    assert.throws(() => resolveInside(root, "..out/a"), /符号链接/);
  });
});
