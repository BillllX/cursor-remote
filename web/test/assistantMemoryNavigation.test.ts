import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assistantMemoryEntryText,
  initialAssistantMemoryNavigation,
  openAssistantMemoryNavigation,
  revisitAssistantMemoryNavigation,
} from "../components/assistant/assistantMemoryNavigation";

describe("助理面板记忆入口状态机", () => {
  test("助理入口固定到 personal，工作区入口固定到本轮 workspace scope", () => {
    const initial = initialAssistantMemoryNavigation();
    const assistant = openAssistantMemoryNavigation(initial, "assistant", "workspace/ignored");
    assert.deepEqual(assistant, { source: "assistant", target: "personal", request: 1 });
    assert.deepEqual(assistantMemoryEntryText(assistant), {
      label: "个人记忆",
      ariaLabel: "打开个人记忆",
    });

    const workspace = openAssistantMemoryNavigation(assistant, "workspace", "projects/app");
    assert.deepEqual(workspace, { source: "workspace", target: "projects/app", request: 2 });
    assert.deepEqual(assistantMemoryEntryText(workspace), {
      label: "记忆工作台",
      ariaLabel: "打开当前工作区的记忆工作台",
    });
  });

  test("从其它 Tab 返回或重复点击时保留目标，并递增本地重定位请求", () => {
    const opened = openAssistantMemoryNavigation(
      initialAssistantMemoryNavigation(),
      "workspace",
      "projects/app",
    );
    const revisited = revisitAssistantMemoryNavigation(opened);
    const repeated = revisitAssistantMemoryNavigation(revisited);
    assert.equal(revisited.target, "projects/app");
    assert.equal(revisited.source, "workspace");
    assert.equal(revisited.request, opened.request + 1);
    assert.equal(repeated.request, opened.request + 2);
  });
});
