import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { markdownHeadings, parseCsv, parseNotebook, splitFrontMatter, splitMarkdownDiff } from "../lib/previewFormats";

describe("preview formats", () => {
  test("Markdown 标题生成稳定且去重的锚点，并跳过代码块", () => {
    assert.deepEqual(markdownHeadings("# Hello world\n## Hello world\n```\n# nope\n```"), [
      { depth: 1, text: "Hello world", id: "hello-world" },
      { depth: 2, text: "Hello world", id: "hello-world-1" },
    ]);
  });

  test("拆 front matter", () => {
    assert.deepEqual(splitFrontMatter("---\ntitle: Demo\ndraft: true\n---\n# Body"), {
      frontMatter: [
        ["title", "Demo"],
        ["draft", "true"],
      ],
      body: "# Body",
    });
  });

  test("CSV 支持引号、逗号和双引号转义", () => {
    assert.deepEqual(parseCsv('a,b\n"hello, world","say ""hi"""'), [
      ["a", "b"],
      ["hello, world", 'say "hi"'],
    ]);
  });

  test("Notebook 校验 cells，Markdown diff 拆前后版本", () => {
    assert.equal(parseNotebook('{"cells":[{"cell_type":"code","source":["1+1"]}]}').cells.length, 1);
    assert.match(parseNotebook("{").error || "", /./);
    assert.deepEqual(splitMarkdownDiff("@@ -1 +1 @@\n-old\n+new\n same"), {
      before: "old\nsame",
      after: "new\nsame",
    });
  });
});
