import assert from "node:assert/strict";
import test from "node:test";
import {
  filterFolderItems,
  firstConfirmKey,
  listStatusWord,
  lowRiskBulk,
  openingDestination,
  suggestionOutcomeLabel,
} from "../components/assistant/memoryCenterCopy";
import type { MemoryCenterSuggestionEntry, WorkspaceMemoryItem } from "@shared/protocol";

function item(partial: Partial<WorkspaceMemoryItem> & Pick<WorkspaceMemoryItem, "text">): WorkspaceMemoryItem {
  return {
    id: partial.id ?? "1",
    kind: "workspace_memory",
    layer: "L2",
    scopeId: "app",
    text: partial.text,
    refs: [],
    missingRefs: partial.missingRefs ?? [],
    effectiveState: partial.effectiveState ?? "hot",
    pinned: partial.pinned,
    state: partial.state,
    revision: "r",
  };
}

test("列表只在需要留意时写状态", () => {
  assert.equal(listStatusWord(item({ text: "正在用" })), null);
  assert.equal(listStatusWord(item({ text: "钉", pinned: true })), "始终带上");
  assert.equal(listStatusWord(item({ text: "缺", missingRefs: ["a.ts"], pinned: true })), "待你确认");
  assert.equal(listStatusWord(item({ text: "冷", effectiveState: "cold" })), "很久没用");
  assert.equal(listStatusWord(item({ text: "完", effectiveState: "done" })), "已办完");
});

test("会用到的不混进已办完和已过期", () => {
  const rows = [
    item({ id: "a", text: "用" }),
    item({ id: "b", text: "完", effectiveState: "done" }),
    item({ id: "c", text: "过", effectiveState: "expired" }),
  ];
  assert.deepEqual(
    filterFolderItems(rows, "useful").map((row) => row.id),
    ["a"],
  );
  assert.deepEqual(
    filterFolderItems(rows, "done").map((row) => row.id),
    ["b"],
  );
});

test("建议按钮按结果起名，缺引用不进批量", () => {
  assert.equal(suggestionOutcomeLabel("missing_ref"), "引用已经处理");
  assert.equal(suggestionOutcomeLabel("duplicate"), "合成一条");
  const entries = [
    { id: "1", risk: "low", kind: "duplicate" },
    { id: "2", risk: "low", kind: "missing_ref" },
    { id: "3", risk: "medium", kind: "stale_hot" },
  ] as MemoryCenterSuggestionEntry[];
  assert.deepEqual(
    lowRiskBulk(entries).map((row) => row.id),
    ["1"],
  );
});

test("从工作区打开停在这个文件夹，个人入口停在记得的我，技能工厂已独立不再混入记忆中心", () => {
  assert.equal(openingDestination("personal").destination, "me");
  assert.equal(openingDestination(undefined).destination, "me");
  assert.deepEqual(openingDestination("cursor-remote"), { destination: "folder", folderId: "cursor-remote" });
});

test("有待确认时默认选中最上面一条", () => {
  const rows = [item({ id: "a", text: "普通" }), item({ id: "b", text: "待确认", missingRefs: ["x"] })];
  assert.equal(
    firstConfirmKey(rows, (row) => row.id ?? ""),
    "b",
  );
});
