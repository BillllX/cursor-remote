import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { appendMemoryLines } from "../src/assistant/workspaceMemory.ts";

const root = mkdtempSync(join(tmpdir(), "cr-wsmem-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("appendMemoryLines", () => {
  test("写 memory.md 时顺手清掉同目录一小时前的 memory.md 临时文件，别的文件不碰", () => {
    const dir = join(root, "w1");
    const jiebo = join(dir, ".jiebo");
    mkdirSync(jiebo, { recursive: true });
    const old = Date.now() / 1000 - 2 * 3600;
    const put = (name: string, stale: boolean) => {
      writeFileSync(join(jiebo, name), "x");
      if (stale) utimesSync(join(jiebo, name), old, old);
    };
    put("memory.md.123.0a1b2c3d.tmp", true);
    put("memory.md.124.0a1b2c3d.tmp", false);
    put("notes.md.125.0a1b2c3d.tmp", true);
    put("memory.md.tmp", true);
    assert.equal(appendMemoryLines(dir, [{ section: "约定", text: "用 npm run check 验证", refs: [] }]), 1);
    assert.deepEqual(readdirSync(jiebo).sort(), [
      ".gitignore",
      "memory.md",
      "memory.md.124.0a1b2c3d.tmp",
      "memory.md.tmp",
      "notes.md.125.0a1b2c3d.tmp",
    ]);
  });
});
