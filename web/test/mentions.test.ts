import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isFileMention,
  mentionAt,
  mentionChips,
  mentionHits,
  parseCite,
  splitCiteParts,
  stripMention,
} from "../lib/chat/mentions";

const PATHS = ["src/a.ts", "src/lib/b.ts", "README.md"];

describe("mentionHits", () => {
  test("空查询：先 Diff 和目录（排序、带 /），再文件", () => {
    assert.deepEqual(mentionHits(PATHS, ""), ["Diff", "src/", "src/lib/", "src/a.ts", "src/lib/b.ts", "README.md"]);
  });

  test("按子串过滤目录和文件", () => {
    assert.deepEqual(mentionHits(PATHS, "lib"), ["src/lib/", "src/lib/b.ts"]);
  });

  test("大小写不敏感", () => {
    assert.deepEqual(mentionHits(PATHS, "READ"), ["README.md"]);
  });

  test("Diff 也参与过滤", () => {
    assert.deepEqual(mentionHits(PATHS, "d"), ["Diff", "README.md"]);
  });

  test("远端搜索结果排在本地文件前面并去重；目录只从本地路径推出", () => {
    assert.deepEqual(mentionHits(["src/a.ts"], "", ["src/a.ts", "x/y.ts"]), ["Diff", "src/", "src/a.ts", "x/y.ts"]);
  });

  test("最多 40 条", () => {
    const many = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const out = mentionHits(many, "");
    assert.equal(out.length, 40);
    assert.equal(out[0], "Diff");
    assert.equal(out[39], "f38.ts");
  });

  test("Diff 加目录最多 16 条", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, "0")}/x.ts`);
    const out = mentionHits(deep, "");
    assert.equal(out.filter((item) => item === "Diff" || item.endsWith("/")).length, 16);
  });
});

describe("mentionAt", () => {
  test("光标前的 @ 词", () => {
    assert.deepEqual(mentionAt("hello @src/a", 12), { query: "src/a", start: 6 });
    assert.deepEqual(mentionAt("@ab", 3), { query: "ab", start: 0 });
    assert.deepEqual(mentionAt("@", 1), { query: "", start: 0 });
  });

  test("光标在中间时只看光标之前", () => {
    assert.deepEqual(mentionAt("see @abc def", 8), { query: "abc", start: 4 });
  });

  test("@ 前不是空白、或光标前已有空格时不算", () => {
    assert.equal(mentionAt("mail@x", 6), null);
    assert.equal(mentionAt("@abc ", 5), null);
  });
});

describe("引用解析", () => {
  test("isFileMention：带 . / : 的、目录、diff 和常见无扩展名文件", () => {
    for (const yes of ["diff", "Diff", "src/", "a.ts", "README", "Makefile", "x:1"])
      assert.equal(isFileMention(yes), true, yes);
    for (const no of ["foo", "小驳"]) assert.equal(isFileMention(no), false, no);
  });

  test("splitCiteParts：拆出 @path:line-end", () => {
    assert.deepEqual(splitCiteParts("see @a.ts:12-14 now"), [
      { value: "see " },
      { value: "@a.ts:12-14", path: "a.ts", line: 12, endLine: 14 },
      { value: " now" },
    ]);
    assert.deepEqual(splitCiteParts(""), [{ value: "" }]);
  });

  test("mentionChips：只留像文件的提及", () => {
    assert.deepEqual(mentionChips("look @src/a.ts:3 and @foo"), [
      { key: "1-@src/a.ts:3", token: "@src/a.ts:3", path: "src/a.ts", line: 3, endLine: undefined },
    ]);
  });

  test("parseCite：行号:列:路径 与 路径:行号 两种写法", () => {
    assert.deepEqual(parseCite("12:1:src/a.ts"), { line: 12, path: "src/a.ts" });
    assert.deepEqual(parseCite("src/a.ts:5"), { path: "src/a.ts", line: 5 });
    assert.deepEqual(parseCite("README:3"), { path: "README", line: 3 });
    assert.equal(parseCite("foo:3"), null);
    assert.equal(parseCite("ts"), null);
    assert.equal(parseCite(undefined), null);
  });

  test("stripMention：删掉整词并收拢多余空格", () => {
    assert.equal(stripMention("fix @a.ts please", "@a.ts"), "fix please");
    assert.equal(stripMention("@a.ts", "@a.ts"), "");
    assert.equal(stripMention("x @a.tsx", "@a.ts"), "x @a.tsx");
  });
});
