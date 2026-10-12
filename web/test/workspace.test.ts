import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_ASSISTANT_NAME } from "@shared/protocol";
import type { Chat } from "../lib/chat/types";
import {
  duplicateNamesOf,
  gitLetterOf,
  inWorkspaceRoot,
  normPath,
  preferChatCwd,
  recentWorkspacesOf,
  relToCwd,
  sameCwd,
  sameFile,
  workspaceChoicesOf,
  workspaceGroupsOf,
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

const chat = (id: string, cwd?: string, touchedAt?: number): Chat => ({ id, title: id, turns: [], cwd, touchedAt });

describe("工作区分组与新对话候选", () => {
  test("recentWorkspacesOf：按对话顺序去重，跳过根外目录；根显示助理名，已知工作区用目录里的名字", () => {
    const got = recentWorkspacesOf(
      [chat("1", "/r/a"), chat("2", "/r/a/"), chat("3"), chat("4", "/elsewhere"), chat("5", "/r/b")],
      "/r",
      [{ path: "/r/a", name: "甲" }],
      "助理",
    );
    assert.deepEqual(got, [
      { path: "/r/a", name: "甲", user: false },
      { path: "/r", name: "助理", user: true },
      { path: "/r/b", name: "b", user: false },
    ]);
    assert.deepEqual(recentWorkspacesOf([chat("1")], "", [], "助理"), []);
  });

  test("workspaceGroupsOf：对话归到所在工作区，根目录不成组，按最近动过排序且同时间保持原顺序", () => {
    const groups = workspaceGroupsOf(
      "/r",
      "/r/a",
      [
        { path: "/r", name: "根", user: true },
        { path: "/r/a", name: "a" },
        { path: "/r/b", name: "b" },
        { path: "/r/c", name: "c" },
      ],
      "助理",
      [chat("1", "/r/a", 5), chat("2", "/r/b/", 9), chat("3", "/r/new", 7), chat("4", undefined, 99)],
    );
    assert.deepEqual(
      groups.map((g) => [g.path, g.name, g.touched, g.chats.map((c) => c.id)]),
      [
        ["/r/b", "b", 9, ["2"]],
        ["/r/new", "new", 7, ["3"]],
        ["/r/a", "a", 5, ["1"]],
        ["/r/c", "c", 0, []],
      ],
    );
  });

  test("workspaceGroupsOf：工作区目录还没到时，用根目录兜底（根本身不成组）", () => {
    const groups = workspaceGroupsOf("", "/r", [], "助理", [chat("1", "/r/x", 1), chat("2")]);
    assert.deepEqual(
      groups.map((g) => [g.path, g.name, g.user]),
      [["/r/x", "x", false]],
    );
  });

  test("duplicateNamesOf：只返回出现不止一次的名字", () => {
    const groups = workspaceGroupsOf(
      "/r",
      "",
      [
        { path: "/r/a/app", name: "app" },
        { path: "/r/b/app", name: "app" },
        { path: "/r/c", name: "c" },
      ],
      "助理",
      [],
    );
    assert.deepEqual([...duplicateNamesOf(groups)], ["app"]);
  });

  test("workspaceChoicesOf：按名字或路径过滤（忽略大小写），最近用过的在前、其次按最近动过，重名标 dup", () => {
    const groups = workspaceGroupsOf(
      "/r",
      "",
      [
        { path: "/r/x/App", name: "App" },
        { path: "/r/y/app2", name: "App" },
        { path: "/r/z", name: "z" },
      ],
      "助理",
      [chat("1", "/r/y/app2", 3), chat("2", "/r/y/app2", 8), chat("3", "/r/z", 5)],
    );
    const items = [
      { path: "/r/x/App", name: "App" },
      { path: "/r/y/app2", name: "App" },
      { path: "/r/z", name: "z" },
    ];
    const all = workspaceChoicesOf("", [{ path: "/r/z/", name: "z" }], groups, items);
    assert.deepEqual(
      all.map((c) => [c.path, c.recent, c.chats, c.touched, c.dup]),
      [
        ["/r/z", true, 1, 5, false],
        ["/r/y/app2", false, 2, 8, true],
        ["/r/x/App", false, 0, 0, true],
      ],
    );
    assert.deepEqual(
      workspaceChoicesOf("  APP2 ", [], groups, items).map((c) => c.path),
      ["/r/y/app2"],
    );
  });
});
