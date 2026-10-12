import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isMutatingTool,
  parseShellDelta,
  pathFromTool,
  presentToolArgs,
  shellPublishes,
  snapshotFromResult,
  summarizeToolArgs,
  toolEscapesWorkspace,
} from "../src/chat/tools.ts";

describe("snapshotFromResult", () => {
  test("字符串结果当作 stdout", () => {
    assert.deepEqual(snapshotFromResult("hi"), { stdout: "hi" });
  });
  test("优先取 value / result 里的输出，空串变 undefined", () => {
    assert.deepEqual(snapshotFromResult({ value: { output: "o", stderr: "" } }), { stdout: "o", stderr: undefined });
    assert.deepEqual(snapshotFromResult({ result: { text: "t", stderr: "e" } }), { stdout: "t", stderr: "e" });
  });
  test("非对象、空串返回空", () => {
    assert.deepEqual(snapshotFromResult(""), {});
    assert.deepEqual(snapshotFromResult(42), {});
  });
});

describe("parseShellDelta", () => {
  test("callId 依次回落 call_id / toolCallId / id", () => {
    assert.deepEqual(parseShellDelta({ call_id: "c1", chunk: "x" }), { callId: "c1", stream: "stdout", chunk: "x" });
    assert.equal(parseShellDelta({ id: "c2", data: "y" })?.callId, "c2");
  });
  test("只有 stderr 时判为 stderr 流", () => {
    assert.deepEqual(parseShellDelta({ callId: "c", stderr: "boom" }), {
      callId: "c",
      stream: "stderr",
      chunk: "boom",
    });
  });
  test("没有内容返回 null", () => {
    assert.equal(parseShellDelta({ callId: "c" }), null);
    assert.equal(parseShellDelta({ callId: "c", chunk: "" }), null);
  });
});

describe("summarizeToolArgs / presentToolArgs", () => {
  test("只保留白名单字段，过长 prompt 截到 500 字", () => {
    const out = summarizeToolArgs({ path: "a.ts", secret: "s", prompt: "p".repeat(600) }) as Record<string, unknown>;
    assert.equal(out.path, "a.ts");
    assert.equal("secret" in out, false);
    assert.equal(out.prompt, `${"p".repeat(500)}\n…`);
  });
  test("没有白名单字段时原样返回；非对象原样返回", () => {
    const args = { other: 1 };
    assert.equal(summarizeToolArgs(args), args);
    assert.equal(summarizeToolArgs("x"), "x");
    assert.equal(summarizeToolArgs(null), null);
  });
  test("提问工具保留 questions 与选项（支持嵌套 args），丢掉无效项", () => {
    const shown = presentToolArgs("AskQuestion", {
      args: {
        title: "选一个",
        questions: [
          {
            id: "q1",
            prompt: "颜色？",
            allow_multiple: true,
            options: [{ id: "r", label: "红" }, { label: "" }, null],
          },
          { prompt: "" },
        ],
      },
    });
    assert.deepEqual(shown, {
      title: "选一个",
      questions: [{ id: "q1", prompt: "颜色？", allowMultiple: true, options: [{ id: "r", label: "红" }] }],
    });
  });
  test("提问工具没有有效问题时退回通用摘要", () => {
    assert.deepEqual(presentToolArgs("ask_question", { title: "t", questions: [] }), { title: "t" });
  });
});

describe("pathFromTool / isMutatingTool / shellPublishes", () => {
  test("路径字段按 path、file、target、file_path 的顺序取第一个非空的", () => {
    assert.equal(pathFromTool({ file: "", target: "b", file_path: "c" }), "b");
    assert.equal(pathFromTool(null), "");
  });
  test("写入类工具与会改文件的 shell 命令算写入", () => {
    assert.equal(isMutatingTool("Write", {}), true);
    assert.equal(isMutatingTool("StrReplace", {}), true);
    assert.equal(isMutatingTool("edit_file", {}), true);
    assert.equal(isMutatingTool("Shell", { command: "git commit -m x" }), true);
    assert.equal(isMutatingTool("Shell", { command: "ls -la" }), false);
    assert.equal(isMutatingTool("TodoWrite", {}), false);
    assert.equal(isMutatingTool("ReadFile", {}), false);
  });
  test("shell 里调用 jiebo-publish（含带路径）才算发布", () => {
    assert.equal(shellPublishes("Shell", { command: "jiebo-publish start" }), true);
    assert.equal(shellPublishes("bash", { command: "cd x && /usr/local/bin/jiebo-publish stop" }), true);
    assert.equal(shellPublishes("Shell", { command: "echo myjiebo-publish" }), false);
    assert.equal(shellPublishes("Write", { command: "jiebo-publish start" }), false);
  });
});

describe("toolEscapesWorkspace", () => {
  const cwd = "/work/space";
  test("路径参数在工作区外算越界，工作区内不算", () => {
    assert.equal(toolEscapesWorkspace(cwd, "Write", { path: "../other/a.ts" }), true);
    assert.equal(toolEscapesWorkspace(cwd, "Write", { path: "src/a.ts" }), false);
  });
  test("shell 的 working_directory 是根本身不算越界，跑到外面算", () => {
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "ls", working_directory: "." }), false);
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "ls", working_directory: "/work/space" }), false);
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "ls", working_directory: "/tmp" }), true);
  });
  test("重定向到工作区外的绝对路径算越界，/dev/* 不算", () => {
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "echo x > /etc/passwd" }), true);
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "echo x | tee -a /tmp/log" }), true);
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "echo x 2>/dev/null" }), false);
    assert.equal(toolEscapesWorkspace(cwd, "Shell", { command: "echo x > /work/space/out.txt" }), false);
  });
});
