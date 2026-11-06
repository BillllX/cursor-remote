import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mutatingTool, silentAssistantTool, toolKind } from "../lib/chat/toolKinds";
import { filterShellRows, shellRows, workspaceShellRows } from "../lib/chat/tools";
import type { Chat, Turn } from "../lib/chat/types";

describe("toolKind", () => {
  test("MultiEdit 等改文件工具归为 edit", () => {
    for (const name of ["edit", "MultiEdit", "multiedit", "StrReplace", "apply_patch", "EditNotebook"]) {
      assert.equal(toolKind(name), "edit", name);
    }
  });

  test("写入、新建、删除归为 write", () => {
    for (const name of ["Write", "write_file", "createFile", "delete_file", "unlink"]) {
      assert.equal(toolKind(name), "write", name);
    }
  });

  test("名字里只是含 edit/write 子串的不算改写", () => {
    for (const name of ["credit_check", "CreditCheck", "open_editor", "rewriter"]) {
      assert.notEqual(toolKind(name), "edit", name);
      assert.notEqual(toolKind(name), "write", name);
      assert.equal(mutatingTool(name), false, name);
    }
  });

  test("todo、计划、shell、搜索、读取照旧", () => {
    assert.equal(toolKind("TodoWrite"), "other");
    assert.equal(toolKind("CreatePlan"), "other");
    assert.equal(toolKind("Shell"), "shell");
    assert.equal(toolKind("grep"), "search");
    assert.equal(toolKind("read_file"), "read");
    assert.equal(toolKind("x", { glob_pattern: "*.ts" }), "search");
  });

  test("mutatingTool 只认 edit 和 write", () => {
    assert.equal(mutatingTool("MultiEdit"), true);
    assert.equal(mutatingTool("Write"), true);
    assert.equal(mutatingTool("read"), false);
  });

  test("工作区记忆检索和采用续期静默，提议仍可见", () => {
    assert.equal(silentAssistantTool("workspace_memory_search"), true);
    assert.equal(silentAssistantTool("mcp__jiebo__workspace_memory_mark_used"), true);
    assert.equal(silentAssistantTool("workspace_memory_propose"), false);
  });

  test("shellRows 提取 stdout/stderr/exitCode、失败态、执行目录与轮次元数据", () => {
    const turns: Turn[] = [
      {
        id: "t1",
        user: "检查状态并运行构建",
        assistant: "",
        thinking: "",
        running: false,
        tools: [
          {
            callId: "c1",
            name: "Shell",
            args: {
              command: "npm run build",
              working_directory: "/workspace/app",
              description: "构建生产包",
            },
            result: {
              stdout: "Compiling...",
              stderr: "Error: TS2322 type mismatch",
              exitCode: 2,
            },
            status: "completed",
            agent: "builder",
          },
          {
            callId: "c2",
            name: "Shell",
            args: { command: "git status -sb" },
            result: { stdout: "## main", exitCode: 0 },
            status: "completed",
          },
          {
            callId: "c3",
            name: "Shell",
            args: { command: "npm test" },
            result: { stdout: "Running tests..." },
            status: "running",
          },
        ],
      },
    ];

    const rows = shellRows(turns, { chatId: "chat-1", chatTitle: "构建排障" });
    assert.equal(rows.length, 3);

    assert.equal(rows[0]?.command, "npm run build");
    assert.equal(rows[0]?.stdout, "Compiling...");
    assert.equal(rows[0]?.stderr, "Error: TS2322 type mismatch");
    assert.equal(rows[0]?.exitCode, "2");
    assert.equal(rows[0]?.failed, true);
    assert.equal(rows[0]?.running, false);
    assert.equal(rows[0]?.cwd, "/workspace/app");
    assert.equal(rows[0]?.description, "构建生产包");
    assert.equal(rows[0]?.agent, "builder");
    assert.equal(rows[0]?.turnId, "t1");
    assert.equal(rows[0]?.turnIndex, 1);
    assert.equal(rows[0]?.chatTitle, "构建排障");

    assert.equal(rows[1]?.failed, false);
    assert.equal(rows[1]?.exitCode, "0");

    assert.equal(rows[2]?.running, true);
    assert.equal(rows[2]?.failed, false);

    assert.equal(filterShellRows(rows, "failed", "").length, 1);
    assert.equal(filterShellRows(rows, "running", "").length, 1);
    assert.equal(filterShellRows(rows, "succeeded", "").length, 1);
    assert.equal(filterShellRows(rows, "all", "TS2322").length, 1);
    assert.equal(filterShellRows(rows, "all", "构建生产包").length, 1);
  });

  test("workspaceShellRows 仅聚合同一工作区的非助理会话终端记录", () => {
    const chats: Chat[] = [
      {
        id: "c-ws1",
        title: "会话 A",
        cwd: "/root/proj-a",
        turns: [
          {
            id: "t-a",
            user: "ls",
            assistant: "",
            thinking: "",
            running: false,
            tools: [{ callId: "ca", name: "shell", args: { command: "ls -la" }, status: "completed" }],
          },
        ],
      },
      {
        id: "c-ws2",
        title: "会话 B",
        cwd: "/root/proj-b",
        turns: [
          {
            id: "t-b",
            user: "pwd",
            assistant: "",
            thinking: "",
            running: false,
            tools: [{ callId: "cb", name: "shell", args: { command: "pwd" }, status: "completed" }],
          },
        ],
      },
    ];
    const rows = workspaceShellRows(chats, "/root/proj-a", "/root");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.command, "ls -la");
    assert.equal(rows[0]?.chatTitle, "会话 A");
  });
});
