// 分页工具与工作区目录/搜索分页单元测试
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { clampPageLimit, parseOffsetCursor, sliceOffsetPage } from "../src/pagination.ts";
import { listWorkspaceDirForClientAsync, searchWorkspaceAsync } from "../src/workspace/files.ts";

describe("gateway pagination helpers", () => {
  test("parseOffsetCursor 处理非法与边界输入", () => {
    assert.equal(parseOffsetCursor(undefined), 0);
    assert.equal(parseOffsetCursor(""), 0);
    assert.equal(parseOffsetCursor("abc"), 0);
    assert.equal(parseOffsetCursor("-10"), 0);
    assert.equal(parseOffsetCursor("42"), 42);
    assert.equal(parseOffsetCursor(" 18 "), 18);
  });

  test("clampPageLimit 夹紧范围", () => {
    assert.equal(clampPageLimit(undefined, 30, 100), 30);
    assert.equal(clampPageLimit(0, 30, 100), 30);
    assert.equal(clampPageLimit(500, 30, 100), 100);
    assert.equal(clampPageLimit(25, 30, 100), 25);
  });

  test("sliceOffsetPage 连续翻页覆盖全集且不重复", () => {
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const collected: string[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    while (pages < 10) {
      const page: ReturnType<typeof sliceOffsetPage<string>> = sliceOffsetPage(items, {
        cursor,
        limit: 4,
        defaultLimit: 4,
        maxLimit: 20,
      });
      collected.push(...page.items);
      pages += 1;
      assert.equal(page.total, 10);
      if (!page.hasMore) {
        assert.equal(page.nextCursor, undefined);
        break;
      }
      assert.ok(page.nextCursor);
      cursor = page.nextCursor;
    }
    assert.equal(pages, 3);
    assert.deepEqual(collected, items);
  });
});

describe("workspace directory & text search pagination", () => {
  const root = mkdtempSync(join(tmpdir(), "jiebo-page-test-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "sub"), { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const name = `file-${String(i).padStart(2, "0")}.txt`;
    writeFileSync(join(root, name), `hello pagination line ${i}\nsecond match pagination ${i}\n`, "utf8");
  }

  test("listWorkspaceDirForClientAsync 按 cursor/limit 完整翻页", async () => {
    const seen: string[] = [];
    let cursor: string | undefined = undefined;
    let guard = 0;
    while (guard < 10) {
      guard += 1;
      const page: Awaited<ReturnType<typeof listWorkspaceDirForClientAsync>> =
        await listWorkspaceDirForClientAsync(root, "", { cursor, limit: 5 });
      seen.push(...page.paths);
      assert.equal(page.total, 13); // 1 subdir + 12 files
      if (!page.hasMore) {
        assert.equal(page.nextCursor, undefined);
        break;
      }
      assert.ok(page.nextCursor);
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 13);
    assert.equal(new Set(seen).size, 13);
    assert.ok(seen.includes("sub/"));
  });

  test("searchWorkspaceAsync 支持扩充上限并完整返回命中列表", async () => {
    const hits = await searchWorkspaceAsync(root, "pagination", { maxHits: 100 });
    assert.equal(hits.length, 24);
    assert.equal(hits.slice(0, 10).length, 10);
    assert.equal(hits.slice(10, 20).length, 10);
    assert.equal(hits.slice(20, 30).length, 4);
  });
});
