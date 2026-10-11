import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  askDisallowedTools,
  defaultPolicy,
  isPlane,
  isPolicyProtectedPath,
  parsePolicy,
  planDisallowedTools,
  toolCategory,
  toolFingerprint,
} from "../../shared/policy.ts";

describe("parsePolicy / defaultPolicy / isPlane", () => {
  test("只认 baseline 和 plane，其余回落到 fallback", () => {
    assert.equal(parsePolicy("plane"), "plane");
    assert.equal(parsePolicy("baseline"), "baseline");
    assert.equal(parsePolicy("PLANE"), "baseline");
    assert.equal(parsePolicy(" plane"), "baseline");
    assert.equal(parsePolicy(undefined), "baseline");
    assert.equal(parsePolicy(1), "baseline");
    assert.equal(parsePolicy("x", "plane"), "plane");
  });

  test("defaultPolicy 读 CURSOR_REMOTE_POLICY 环境变量", () => {
    const saved = process.env.CURSOR_REMOTE_POLICY;
    try {
      process.env.CURSOR_REMOTE_POLICY = "plane";
      assert.equal(defaultPolicy(), "plane");
      process.env.CURSOR_REMOTE_POLICY = "bogus";
      assert.equal(defaultPolicy(), "baseline");
      delete process.env.CURSOR_REMOTE_POLICY;
      assert.equal(defaultPolicy(), "baseline");
    } finally {
      if (saved === undefined) delete process.env.CURSOR_REMOTE_POLICY;
      else process.env.CURSOR_REMOTE_POLICY = saved;
    }
  });

  test("isPlane 只对 plane 为真", () => {
    assert.equal(isPlane("plane"), true);
    assert.equal(isPlane("baseline"), false);
    assert.equal(isPlane(undefined), false);
    assert.equal(isPlane("Plane"), false);
  });
});

describe("禁用工具清单", () => {
  test("ask 模式禁掉写文件、shell、mcp、子代理", () => {
    const tools = askDisallowedTools();
    for (const name of ["edit", "delete", "shell", "mcp", "task", "applyAgentDiff", "generateImage"]) {
      assert.ok(tools.includes(name), name);
    }
  });

  test("plan 模式只禁写文件，shell 仍可用", () => {
    assert.deepEqual(planDisallowedTools(), ["edit", "delete", "applyAgentDiff"]);
    assert.ok(!planDisallowedTools().includes("shell"));
  });

  test("每次返回新数组，调用方改了也不影响下一次", () => {
    const first = askDisallowedTools();
    first.length = 0;
    assert.ok(askDisallowedTools().length > 0);
  });
});

describe("isPolicyProtectedPath", () => {
  test(".cursor 下三份策略文件受保护，大小写不敏感", () => {
    assert.equal(isPolicyProtectedPath(".cursor/hooks.json"), true);
    assert.equal(isPolicyProtectedPath(".cursor/sandbox.json"), true);
    assert.equal(isPolicyProtectedPath("sub/dir/.cursor/permissions.json"), true);
    assert.equal(isPolicyProtectedPath(".Cursor/HOOKS.JSON"), true);
  });

  test("反斜杠、开头斜杠和 ./ 前缀都能识别", () => {
    assert.equal(isPolicyProtectedPath("sub\\.cursor\\hooks.json"), true);
    assert.equal(isPolicyProtectedPath("///.cursor/hooks.json"), true);
    assert.equal(isPolicyProtectedPath("./.cursor/hooks.json"), true);
  });

  test("其它文件和相似名字不受保护", () => {
    assert.equal(isPolicyProtectedPath(".cursor/rules.json"), false);
    assert.equal(isPolicyProtectedPath(".cursor/hooks.json.bak"), false);
    assert.equal(isPolicyProtectedPath("x.cursor/hooks.json"), false);
    assert.equal(isPolicyProtectedPath("hooks.json"), false);
    assert.equal(isPolicyProtectedPath(""), false);
  });
});

describe("toolCategory", () => {
  test("写文件类工具归为 write", () => {
    for (const name of ["Write", "StrReplace", "apply_patch", "applyPatch", "EditNotebook", "delete_file", "edit"]) {
      assert.equal(toolCategory(name), "write", name);
    }
    assert.equal(toolCategory("edit_file"), "write");
  });

  test("edit 必须是独立单词：粘连在别的字母里不算", () => {
    assert.equal(toolCategory("multiedit"), "other");
    assert.equal(toolCategory("MultiEdit"), "other");
  });

  test("shell / terminal / command 归为 shell", () => {
    assert.equal(toolCategory("shell"), "shell");
    assert.equal(toolCategory("run_terminal_cmd"), "shell");
    assert.equal(toolCategory("Bash"), "shell");
    assert.equal(toolCategory("runCommand"), "shell");
  });

  test("读和搜索类归为 other", () => {
    for (const name of ["read", "read_file", "grep", "glob", "ls", "task", ""]) {
      assert.equal(toolCategory(name), "other", name);
    }
  });
});

describe("toolFingerprint", () => {
  test("按 path > file > target > file_path 取第一个非空字符串", () => {
    assert.equal(toolFingerprint("edit", { file: "b.ts", path: "a.ts" }), "write:edit:a.ts:");
    assert.equal(toolFingerprint("edit", { path: "", file: "b.ts" }), "write:edit:b.ts:");
    assert.equal(toolFingerprint("edit", { path: 3, file_path: "c.ts" }), "write:edit:c.ts:");
  });

  test("命令截到 120 个字符", () => {
    const command = "x".repeat(200);
    assert.equal(toolFingerprint("shell", { command }), `shell:shell::${"x".repeat(120)}`);
  });

  test("参数不是对象时只留类别和工具名", () => {
    assert.equal(toolFingerprint("grep"), "other:grep::");
    assert.equal(toolFingerprint("shell", "ls -la"), "shell:shell::");
    assert.equal(toolFingerprint("shell", null), "shell:shell::");
  });
});
