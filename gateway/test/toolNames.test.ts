import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isDeleteToolName, isEditToolName, isWriteToolName, toolWords } from "../../shared/toolNames.ts";

describe("shared/toolNames", () => {
  test("toolWords 拆驼峰并小写", () => {
    assert.equal(toolWords("MultiEdit"), "multi_edit");
    assert.equal(toolWords("StrReplace"), "str_replace");
    assert.equal(toolWords("apply_patch"), "apply_patch");
  });

  test("改文件：按单词认 edit/replace/patch 及常见合写名", () => {
    for (const name of [
      "edit",
      "MultiEdit",
      "multiedit",
      "StrReplace",
      "search_replace",
      "apply_patch",
      "EditNotebook",
    ]) {
      assert.equal(isEditToolName(name), true, name);
    }
    for (const name of ["credit_check", "open_editor", "patchwork", "TodoWrite", "write"]) {
      assert.equal(isEditToolName(name), false, name);
    }
  });

  test("写文件：write、createFile；create 后面不跟 file 不算", () => {
    for (const name of ["Write", "write_file", "createFile", "create_files"]) {
      assert.equal(isWriteToolName(name), true, name);
    }
    for (const name of ["rewriter", "CreatePlan", "create_issue", "todo_write"]) {
      assert.equal(isWriteToolName(name), false, name);
    }
  });

  test("删文件按子串认 delete/unlink", () => {
    assert.equal(isDeleteToolName("delete_file"), true);
    assert.equal(isDeleteToolName("Unlink"), true);
    assert.equal(isDeleteToolName("remove_label"), false);
  });
});
