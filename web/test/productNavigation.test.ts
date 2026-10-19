import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ASSISTANT_NAV,
  ASSISTANT_SURFACE,
  PRIMARY_NAV,
  SESSION_TOOLS,
  STATUS_LEGEND,
  WORKSPACE_NAV,
  statusAriaLabel,
} from "../lib/productNavigation";

describe("Web 产品信息架构", () => {
  test("活动栏只有助理与工作区两个一级域", () => {
    assert.deepEqual(
      PRIMARY_NAV.map((item) => item.id),
      ["assistant", "workspace"],
    );
  });

  test("工作区承载会话、文件、搜索、Git、记忆和管理", () => {
    assert.deepEqual(
      WORKSPACE_NAV.map((item) => item.id),
      ["chats", "files", "search", "git", "memory", "management"],
    );
    assert.equal(WORKSPACE_NAV[0]?.id, "chats");
    assert.equal(WORKSPACE_NAV.some((item) => (item.id as string) === "overview"), false);
    assert.equal(WORKSPACE_NAV.find((item) => item.id === "search")?.label, "工作区搜索");
  });

  test("Loop 和终端只属于当前会话工具", () => {
    assert.deepEqual(
      SESSION_TOOLS.map((item) => item.id),
      ["loop", "terminal"],
    );
    assert.equal(PRIMARY_NAV.some((item) => (item.id as string) === "loop"), false);
  });

  test("助理主导航不把记忆伪装成普通 Tab", () => {
    assert.deepEqual(
      ASSISTANT_NAV.map((item) => item.id),
      ["overview", "inbox", "notify"],
    );
  });

  test("助理统一使用单层浮窗，记忆在同一壳内扩展", () => {
    assert.deepEqual(ASSISTANT_SURFACE, {
      mode: "floating",
      memoryMode: "same-shell-wide",
    });
  });

  test("状态图例都有非颜色语义和 aria 文案", () => {
    for (const entry of Object.values(STATUS_LEGEND)) {
      assert.ok(entry.label);
      assert.ok(entry.symbol);
    }
    assert.equal(statusAriaLabel("unread", 3), "未读 3");
    assert.equal(statusAriaLabel("attention", 3), "需要处理 3");
    assert.equal(statusAriaLabel("running"), "运行中");
  });
});
