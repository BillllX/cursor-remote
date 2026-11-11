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

  test("工作区按竖向层级承载会话及独立浮层功能（知识库看板、定时自动化、技能工厂、规则记忆、文件、搜索、Git、工作区设置）", () => {
    assert.deepEqual(
      WORKSPACE_NAV.map((item) => item.id),
      ["chats", "kb", "schedules", "skills", "memory", "files", "search", "git", "management"],
    );
    assert.equal(WORKSPACE_NAV[0]?.id, "chats");
    assert.equal(
      WORKSPACE_NAV.some((item) => (item.id as string) === "overview"),
      false,
    );
    assert.equal(WORKSPACE_NAV.find((item) => item.id === "kb")?.label, "知识库与看板");
    assert.equal(WORKSPACE_NAV.find((item) => item.id === "schedules")?.label, "定时与自动化");
    assert.equal(WORKSPACE_NAV.find((item) => item.id === "skills")?.label, "技能工厂");
    assert.equal(WORKSPACE_NAV.find((item) => item.id === "memory")?.label, "规则与记忆");
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

  test("助理主导航聚焦日常总览与收件箱，不把记忆与一次性通知开关混入普通 Tab", () => {
    assert.deepEqual(
      ASSISTANT_NAV.map((item) => item.id),
      ["overview", "inbox"],
    );
  });

  test("助理侧栏按竖向承载对话、今日待办、收件箱、个人记忆与独立技能工厂", () => {
    assert.deepEqual(
      ASSISTANT_SIDEBAR_NAV.map((item) => item.id),
      ["chat", "overview", "inbox", "memory", "skills"],
    );
    assert.equal(
      ASSISTANT_SIDEBAR_NAV.some((item) =>
        ["files", "search", "git", "management", "loop", "terminal", "notify"].includes(item.id),
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
