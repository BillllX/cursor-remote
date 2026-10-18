import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mutatingTool, silentAssistantTool, toolKind } from "../lib/chat/toolKinds";

describe("toolKind", () => {
  test("MultiEdit 等改文件工具归为 edit", () => {
    for (const name of ["edit", "MultiEdit", "multiedit", "StrReplace", "apply_patch", "EditNotebook"]) {
      assert.equal(toolKind(name), "edit", name);
    }
  });

  test("写入、新建、删除归为 write", () => {
    for (const name of ["Write", "write_file", "createFile", "delete_file", "unlink"]) {
      assert.equal(toolKind(name), "write", name);
    }
  });

  test("名字里只是含 edit/write 子串的不算改写", () => {
    for (const name of ["credit_check", "CreditCheck", "open_editor", "rewriter"]) {
      assert.notEqual(toolKind(name), "edit", name);
      assert.notEqual(toolKind(name), "write", name);
      assert.equal(mutatingTool(name), false, name);
    }
  });

  test("todo、计划、shell、搜索、读取照旧", () => {
    assert.equal(toolKind("TodoWrite"), "other");
    assert.equal(toolKind("CreatePlan"), "other");
    assert.equal(toolKind("Shell"), "shell");
    assert.equal(toolKind("grep"), "search");
    assert.equal(toolKind("read_file"), "read");
    assert.equal(toolKind("x", { glob_pattern: "*.ts" }), "search");
  });

  test("mutatingTool 只认 edit 和 write", () => {
    assert.equal(mutatingTool("MultiEdit"), true);
    assert.equal(mutatingTool("Write"), true);
    assert.equal(mutatingTool("read"), false);
  });

  test("工作区记忆检索和采用续期静默，提议仍可见", () => {
    assert.equal(silentAssistantTool("workspace_memory_search"), true);
    assert.equal(silentAssistantTool("mcp__jiebo__workspace_memory_mark_used"), true);
    assert.equal(silentAssistantTool("workspace_memory_propose"), false);
  });
});
