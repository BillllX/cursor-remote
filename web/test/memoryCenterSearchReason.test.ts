import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  formatMemoryCenterSearchReasons,
  isMemoryCenterSearchMatchReason,
  MEMORY_CENTER_SEARCH_REASON_LABEL,
} from "@shared/memoryCenterSearchReason";

describe("memory center search reason labels", () => {
  test("已知 code 映射中文", () => {
    assert.equal(formatMemoryCenterSearchReasons(["text", "ref"]), "正文匹配 · 引用匹配");
    assert.equal(MEMORY_CENTER_SEARCH_REASON_LABEL.section, "分节匹配");
  });

  test("isMemoryCenterSearchMatchReason 判别", () => {
    assert.equal(isMemoryCenterSearchMatchReason("pinned"), true);
    assert.equal(isMemoryCenterSearchMatchReason("正文匹配"), false);
  });
});
