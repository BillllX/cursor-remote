import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ASSISTANT_NAME } from "@shared/protocol";
import {
  gitLetterOf,
  inWorkspaceRoot,
  normPath,
  preferChatCwd,
  relToCwd,
  sameCwd,
  sameFile,
  workspaceLabel,
} from "../lib/chat/workspace";

describe("工作区归属", () => {
  test("normPath：反斜杠转正斜杠，去掉末尾 /", () => {
    assert.equal(normPath("C:\\a\\b\\"), "C:/a/b");
    assert.equal(normPath("/a/b///"), "/a/b");
  });

  test("sameCwd：空值视同空串，忽略末尾 /", () => {
    assert.equal(sameCwd(undefined, ""), true);
    assert.equal(sameCwd("/a/", "/a"), true);
    assert.equal(sameCwd("/a", "/b"), false);
  });

  test("inWorkspaceRoot：根本身或其子目录；前缀相同的兄弟目录不算", () => {
    assert.equal(inWorkspaceRoot("/root/proj", "/root"), true);
    assert.equal(inWorkspaceRoot("/root", "/root/"), true);
    assert.equal(inWorkspaceRoot("/rootx", "/root"), false);
    assert.equal(inWorkspaceRoot("", "/root"), false);
    assert.equal(inWorkspaceRoot("/root", ""), false);
  });

  test("preferChatCwd：缺一边取另一边；相同或本地更深时保留本地，否则用服务端的", () => {
    assert.equal(preferChatCwd(undefined, "/x"), "/x");
    assert.equal(preferChatCwd("/x", undefined), "/x");
    assert.equal(preferChatCwd("/a/", "/a"), "/a/");
    assert.equal(preferChatCwd("/r/p", "/r"), "/r/p");
    assert.equal(preferChatCwd("/r", "/r/p"), "/r/p");
    assert.equal(preferChatCwd("/a", "/b"), "/b");
  });

  test("workspaceLabel：根显示助理名，根下显示相对路径，其它显示最后一段", () => {
    assert.equal(workspaceLabel("", "/r"), DEFAULT_ASSISTANT_NAME);
    assert.equal(workspaceLabel("", ""), "工作区");
    assert.equal(workspaceLabel("/x/y", ""), "y");
    assert.equal(workspaceLabel("/r", "/r/"), DEFAULT_ASSISTANT_NAME);
    assert.equal(workspaceLabel("/r", "/r", "助理"), "助理");
    assert.equal(workspaceLabel("/r/a/b", "/r"), "a/b");
    assert.equal(workspaceLabel("/other/z/", "/r"), "z");
  });
});

describe("文件路径", () => {
  test("relToCwd：工作区内转相对路径，根本身为空串", () => {
    assert.equal(relToCwd("/r/a/b.ts", "/r"), "a/b.ts");
    assert.equal(relToCwd("/r", "/r/"), "");
    assert.equal(relToCwd("./a/", ""), "a");
    assert.equal(relToCwd("x\\y", ""), "x/y");
    assert.equal(relToCwd("/other/a.ts", "/r"), "/other/a.ts");
  });

  test("sameFile：绝对路径与相对路径按后缀整段匹配", () => {
    assert.equal(sameFile("/r/a.ts", "a.ts"), true);
    assert.equal(sameFile("/r/a.ts", "/r/a.ts"), true);
    assert.equal(sameFile("/r/ab.ts", "b.ts"), false);
    assert.equal(sameFile("/r/a.ts", "a.ts", "/r"), true);
    assert.equal(sameFile("/r/a.ts", "/s/a.ts"), false);
  });

  test("gitLetterOf：先按相对路径、再按原路径查，最后按后缀匹配", () => {
    assert.equal(gitLetterOf("/r/a.ts", { "a.ts": "M" }, "/r"), "M");
    assert.equal(gitLetterOf("/r/x/a.ts", { "x/a.ts": "A" }), "A");
    assert.equal(gitLetterOf("/r/x/a.ts", { "y/a.ts": "A" }), undefined);
  });
});
