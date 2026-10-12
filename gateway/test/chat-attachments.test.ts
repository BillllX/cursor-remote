import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { expandAttachments, sanitizeImages } from "../src/chat/attachments.ts";

describe("sanitizeImages", () => {
  const data = "A".repeat(32);
  test("只留支持的类型与合理大小，去掉 data URL 前缀", () => {
    const out = sanitizeImages([
      { data: `data:image/png;base64,${data}`, mimeType: "image/png" },
      { data, mimeType: "image/bmp" },
      { data: "short", mimeType: "image/jpeg" },
    ]);
    assert.deepEqual(out, [{ data, mimeType: "image/png" }]);
  });
  test("最多 5 张；空或缺省返回空数组", () => {
    const many = Array.from({ length: 7 }, () => ({ data, mimeType: "image/webp" }));
    assert.equal(sanitizeImages(many).length, 5);
    assert.deepEqual(sanitizeImages(undefined), []);
    assert.deepEqual(sanitizeImages([]), []);
  });
});

describe("expandAttachments", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cr-attach-"));
  after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(cwd, "dir"));
  writeFileSync(join(cwd, "dir", "b.txt"), "b");

  test("文件展开成内容，@ 引用里的行号区间会去掉", () => {
    const out = expandAttachments(cwd, ["a.ts:3-5"]);
    assert.equal(out, "File a.ts:\n```\nexport const a = 1;\n\n```");
  });
  test("目录列出文件清单", () => {
    const out = expandAttachments(cwd, ["dir/"]);
    assert.match(out, /^Folder dir\/ \(1 files\):\n- dir\/b\.txt$/);
  });
  test("工作区外、不存在的引用直接跳过", () => {
    assert.equal(expandAttachments(cwd, ["../etc/passwd", "missing.ts"]), "");
  });
});
