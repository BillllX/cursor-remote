import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractKbBoardShortcuts } from "../lib/kbWorkspace.ts";

describe("知识库 HTML 看板快捷入口", () => {
  const paths = [
    "资产/资产.html",
    "资金/资金.HTML",
    "资产/洋钱罐/洋钱罐.html",
    "资产/洋钱罐/原始报表.xlsx",
    "资产/名称不匹配.html",
    "资产/过深/专题/专题.html",
    ".jiebo/.jiebo.html",
    "资产/资产.html",
  ];

  test("只识别一级和二级目录的同名 HTML，并将顶层看板排在前面", () => {
    assert.deepEqual(extractKbBoardShortcuts(paths, ""), [
      {
        path: "资产/资产.html",
        title: "资产（总览看板）",
        category: "资产",
        level: "category",
      },
      {
        path: "资金/资金.HTML",
        title: "资金（总览看板）",
        category: "资金",
        level: "category",
      },
      {
        path: "资产/洋钱罐/洋钱罐.html",
        title: "洋钱罐",
        category: "资产",
        level: "subject",
      },
    ]);
  });

  test("搜索同时匹配分类、专题和路径，且不返回不合规 HTML", () => {
    assert.deepEqual(
      extractKbBoardShortcuts(paths, "洋钱罐").map((board) => board.path),
      ["资产/洋钱罐/洋钱罐.html"],
    );
    assert.deepEqual(extractKbBoardShortcuts(paths, "名称不匹配"), []);
  });
});
