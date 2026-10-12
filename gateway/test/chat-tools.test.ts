import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  isMutatingTool,
  parseShellDelta,
  pathFromTool,
  presentToolArgs,
  shellPublishes,
  snapshotFromResult,
  summarizeToolArgs,
  realOf,
  toolEscapesWorkspace,
} from "../src/chat/tools.ts";
import { shellWriteTargets } from "../src/chat/shellWrites.ts";

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
    assert.equal(isMutatingTool("MultiEdit", {}), true);
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
  const shell = (command: string) => toolEscapesWorkspace(cwd, "Shell", { command });
  test("写入类命令的目标是工作区外的绝对路径或 ~ 路径算越界", () => {
    for (const command of [
      "cp a /etc/x",
      "cp -r src/ dist/ /opt/out",
      "cp -t /etc a b",
      "cp --target-directory=/etc a",
      "cp -vt /etc a",
      "install -m 755 bin /usr/local/bin/tool",
      "ln -s ./a /etc/b",
      "rm -rf /var/lib/other",
      "rm a /etc/b",
      "rmdir /opt/x",
      "touch ~/x",
      "mkdir -p ~/.config/x",
      "chmod 777 /etc/passwd",
      "chown -R root:root /srv",
      "truncate -s 0 /var/log/x.log",
      "sed -i 's/a/b/' /etc/hosts",
      "sed -i.bak -e s/a/b/ /etc/hosts",
      "sed --in-place 's/a/b/' ~/f",
      "dd if=/dev/zero of=/root/disk bs=1M",
      "sudo cp a /etc/x",
      "FOO=1 rm /etc/x",
      "cd sub && cp a /etc/x",
      "ls; rm /etc/x",
      "bash -c 'rm -rf /etc/x'",
      'cp a "/etc/with space"',
      "rm /work/space/../other/x",
      "cp a /work/spacex/y",
      "echo $(rm /etc/x)",
    ]) {
      assert.equal(shell(command), true, command);
    }
  });
  test("读取类、工作区内、/dev 和相对路径不算越界", () => {
    for (const command of [
      "cp /etc/x ./",
      "cp /etc/hosts local/hosts",
      "cat /etc/passwd",
      "ls -la /usr/bin",
      "grep -r foo /etc",
      "sed -n 1p /etc/hosts",
      "sed 's/a/b/' /etc/hosts > out.txt",
      "dd if=/etc/hosts of=copy",
      "rm -rf build node_modules",
      "rm /work/space/tmp.txt",
      "mkdir -p /work/space",
      "cp a b 2>/dev/null",
      "rm -f /dev/null",
      "chmod +x ./run.sh",
      "ln -s /usr/lib/x ./x",
      "git rm --cached /etc/x",
      "echo 'rm -rf /etc/x'",
      "# rm /etc/x",
      "cat > notes.md <<'EOF'\nrm -rf /etc/x\ncp a /etc/y\nEOF\nls",
      "cat <<-EOF > notes.md\n\trm /etc/x\n\tEOF\nls",
      "npm install --prefix ./tools",
      "mv $HOME/x ./",
      "cp a $OUT/b",
      "rm -rf ../sibling",
    ]) {
      assert.equal(shell(command), false, command);
    }
  });
  test("写入命令检查放过 /tmp、os.tmpdir() 及其子路径和 /dev 下的设备，按路径前缀而不是字符串前缀", () => {
    const tmp = tmpdir();
    for (const command of [
      "mkdir -p /tmp/x",
      "rm -rf /tmp/x",
      "mv a.txt /tmp/a.txt",
      "cp a /tmp",
      `touch ${tmp}/y`,
      `rm -rf ${tmp}/build`,
      "dd if=/dev/zero of=/dev/null",
      "truncate -s 0 /dev/shm/x",
    ]) {
      assert.equal(shell(command), false, command);
    }
    for (const command of [
      "mkdir -p /tmpfoo/x",
      "rm -rf /tmp/../etc",
      `touch ${tmp}x/y`,
      "rm -rf /dev/../etc",
      "rm -rf /devices/x",
      "rm -rf /dev",
    ]) {
      assert.equal(shell(command), true, command);
    }
  });
  test("重定向和 tee 的检查不受这条放行影响：/tmp 仍算越界", () => {
    assert.equal(shell("echo x > /tmp/out"), true);
    assert.equal(shell("echo x | tee /tmp/log"), true);
  });
});

describe("shellWriteTargets 包装命令和会删源的命令", () => {
  test("包装命令按各自的选项跳过，带值选项的值不当命令", () => {
    for (const command of [
      "sudo -u root rm /etc/x",
      "sudo -uroot rm /etc/x",
      "sudo -E -u root -- rm /etc/x",
      "sudo --user=root rm /etc/x",
      "doas -u root rm /etc/x",
      "env -u FOO rm /etc/x",
      "env FOO=1 rm /etc/x",
      "env -i FOO=1 BAR=2 rm /etc/x",
      "env -C /srv rm /etc/x",
      "env -S 'rm /etc/x'",
      "nice -n 5 rm /etc/x",
      "nice -5 rm /etc/x",
      "ionice -c 3 -n 7 rm /etc/x",
      "timeout 5 rm /etc/x",
      "timeout -s KILL 5 rm /etc/x",
      "timeout -- 5 rm /etc/x",
      "timeout -s KILL -- 5 rm /etc/x",
      "timeout --signal=KILL -k 2 5s rm /etc/x",
      "xargs -I {} rm /etc/x",
      "xargs -0 -n 1 -P 4 rm /etc/x",
      "find . | xargs -d '\\n' rm /etc/x",
      "time -f %e rm /etc/x",
      "stdbuf -o L rm /etc/x",
      "nohup nice -n 5 sudo -u root rm /etc/x",
      "command -p rm /etc/x",
      "exec -a name rm /etc/x",
    ]) {
      assert.deepEqual(shellWriteTargets(command), ["/etc/x"], command);
    }
  });
  test("认不出的包装选项：后面每个非选项词都当命令开头试一遍", () => {
    assert.deepEqual(shellWriteTargets("sudo --weird value rm /etc/x"), ["/etc/x"]);
    assert.deepEqual(shellWriteTargets("timeout --weird 5 rm /etc/x"), ["/etc/x"]);
    assert.deepEqual(shellWriteTargets("sudo --weird ls /etc"), []);
  });
  test("mv 的源和目标都算写入；rsync 只有 --remove-source-files 才算源", () => {
    assert.deepEqual(shellWriteTargets("mv /etc/x ./"), ["/etc/x", "./"]);
    assert.deepEqual(shellWriteTargets("mv -t ./dst /etc/a /etc/b"), ["/etc/a", "/etc/b", "./dst"]);
    assert.deepEqual(shellWriteTargets("mv -f a"), []);
    assert.deepEqual(shellWriteTargets("rsync -a /etc/ ./backup/"), ["./backup/"]);
    assert.deepEqual(shellWriteTargets("rsync -a --exclude /x src/ /srv/out"), ["/srv/out"]);
    assert.deepEqual(shellWriteTargets("rsync -a --remove-source-files /etc/x ./"), ["/etc/x", "./"]);
    assert.deepEqual(shellWriteTargets("install -m 644 /etc/x ./x"), ["./x"]);
  });
  test("toolEscapesWorkspace 拦 mv 把工作区外的文件挪进来", () => {
    assert.equal(toolEscapesWorkspace("/work/space", "Shell", { command: "mv /etc/passwd ./" }), true);
    assert.equal(toolEscapesWorkspace("/work/space", "Shell", { command: "sudo -u root rm /etc/x" }), true);
    assert.equal(toolEscapesWorkspace("/work/space", "Shell", { command: "mv a b" }), false);
  });
});

describe("toolEscapesWorkspace 按真实路径判断符号链接", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-fence-"));
  const ws = join(dir, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  symlinkSync("/etc", join(dir, "etc-link"));
  symlinkSync("/etc", join(ws, "out"));
  symlinkSync(join(ws, "src"), join(ws, "inner"));
  symlinkSync(ws, join(dir, "ws-link"));
  symlinkSync(join(ws, "loop-b"), join(ws, "loop-a"));
  symlinkSync(join(ws, "loop-a"), join(ws, "loop-b"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const shell = (cwd: string, command: string, working_directory?: string) =>
    toolEscapesWorkspace(cwd, "Shell", { command, working_directory });

  test("临时目录里链到 /etc 的链接不算临时位置", () => {
    assert.equal(shell(ws, `rm ${dir}/etc-link/x`), true);
    assert.equal(shell(ws, `touch ${dir}/etc-link/new/deeper`), true);
    assert.equal(shell(ws, `rm ${dir}/plain/x`), false);
  });
  test("工作区里链到外面的链接，绝对路径和相对路径都算越界", () => {
    assert.equal(shell(ws, `rm ${ws}/out/x`), true);
    assert.equal(shell(ws, "rm out/x"), true);
    assert.equal(shell(ws, "rm x", "out"), true);
    assert.equal(shell(ws, `rm ${ws}/inner/x`), false);
    assert.equal(shell(ws, "rm -rf src/x inner/y"), false);
  });
  test("工作区根本身经链接访问也按真实路径认", () => {
    assert.equal(shell(join(dir, "ws-link"), `rm ${ws}/src/x`), false);
    assert.equal(shell(join(dir, "ws-link"), "rm out/x"), true);
  });
  test("realpath 失败（循环链接、不存在）不抛", () => {
    assert.doesNotThrow(() => shell(ws, `rm ${ws}/loop-a/x`));
    assert.equal(realOf(join(ws, "missing/a/b")), join(realOf(ws), "missing/a/b"));
    assert.equal(realOf(join(ws, "inner/new")), join(realOf(ws), "src/new"));
  });
});
