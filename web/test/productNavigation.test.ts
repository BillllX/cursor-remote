import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ASSISTANT_NAV,
  ASSISTANT_SIDEBAR_NAV,
  ASSISTANT_SURFACE,
  PRIMARY_NAV,
  SESSION_TOOLS,
  STATUS_LEGEND,
  WORKSPACE_NAV,
  isAssistantDomainActive,
  statusAriaLabel,
} from "../lib/productNavigation";
import { HELLO_CLIENT } from "../lib/chat/connection";

describe("Web 产品信息架构", () => {
  test("活动栏按助理、协作、工作区提供三个一级域", () => {
    assert.deepEqual(
      PRIMARY_NAV.map((item) => item.id),
      ["assistant", "collab", "workspace"],
    );
    assert.equal(PRIMARY_NAV.find((item) => item.id === "collab")?.icon, "collab");
  });

  test("Web hello 同时声明 IM 群聊与协作能力", () => {
    assert.ok(HELLO_CLIENT.caps?.includes("im"));
    assert.ok(HELLO_CLIENT.caps?.includes("im_group"));
    assert.ok(HELLO_CLIENT.caps?.includes("im_collab"));
  });

  test("工作区承载会话、文件、搜索、Git、记忆和管理", () => {
    assert.deepEqual(
      WORKSPACE_NAV.map((item) => item.id),
      ["chats", "files", "search", "git", "memory", "management"],
    );
    assert.equal(WORKSPACE_NAV[0]?.id, "chats");
    assert.equal(
      WORKSPACE_NAV.some((item) => (item.id as string) === "overview"),
      false,
    );
    assert.equal(WORKSPACE_NAV.find((item) => item.id === "search")?.label, "工作区搜索");
  });

  test("Loop 和终端只属于当前会话工具", () => {
    assert.deepEqual(
      SESSION_TOOLS.map((item) => item.id),
      ["loop", "terminal"],
    );
    assert.equal(
      PRIMARY_NAV.some((item) => (item.id as string) === "loop"),
      false,
    );
  });

  test("助理主导航不把记忆伪装成普通 Tab", () => {
    assert.deepEqual(
      ASSISTANT_NAV.map((item) => item.id),
      ["overview", "inbox", "notify"],
    );
  });

  test("助理侧栏只承载个人助理功能", () => {
    assert.deepEqual(
      ASSISTANT_SIDEBAR_NAV.map((item) => item.id),
      ["chat", "overview", "inbox", "notify", "memory"],
    );
    assert.equal(
      ASSISTANT_SIDEBAR_NAV.some((item) =>
        ["files", "search", "git", "management", "loop", "terminal"].includes(item.id),
      ),
      false,
    );
  });

  test("浮层来源决定当前一级域，工作区记忆不会误点亮助理", () => {
    assert.equal(isAssistantDomainActive(true, false, "assistant"), true);
    assert.equal(isAssistantDomainActive(false, false, "workspace"), false);
    assert.equal(isAssistantDomainActive(false, true, "assistant"), true);
    assert.equal(isAssistantDomainActive(true, true, "workspace"), false);
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
    assert.equal(statusAriaLabel("publishing"), "正在发布");
    assert.equal(statusAriaLabel("succeeded"), "已完成");
    assert.equal(statusAriaLabel("cancelled"), "已取消");
  });
});
