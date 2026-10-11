import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  QUOTA_RESCAN_MS,
  SNAPSHOT_GONE,
  artifactPath,
  canvasPathsFromAssistant,
  checkArtifactQuota,
  computeTurnFiles,
  countDiffLines,
  enforceArtifactQuota,
  isSha,
  isTextKind,
  parseDiffHeader,
  parseNameStatus,
  parseNumstat,
  readArtifact,
  readSnapshotDiff,
  readSnapshotFile,
  sha256,
  splitGitDiff,
  storeArtifact,
  toolPaths,
  toolWritesFiles,
  unquoteGitPath,
  workspaceRel,
} from "../src/turnFiles.ts";

type Tool = Parameters<typeof toolPaths>[0][number];

const tmpRoots: string[] = [];
function tempDir(tag: string) {
  const dir = mkdtempSync(resolve(tmpdir(), `turnfiles-test-${tag}-`));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

let callSeq = 0;
const tool = (name: string, args?: unknown, extra: Partial<Tool> = {}): Tool => ({
  callId: `call-${(callSeq += 1)}`,
  name,
  args,
  status: "completed",
  ...extra,
});

describe("isSha / isTextKind", () => {
  test("只认 64 位小写 hex", () => {
    assert.equal(isSha("a".repeat(64)), true);
    assert.equal(isSha("A".repeat(64)), false);
    assert.equal(isSha("a".repeat(63)), false);
    assert.equal(isSha("a".repeat(40)), false);
    assert.equal(isSha(123), false);
  });

  test("文本类 kind 才有对照文本", () => {
    for (const kind of ["text", "canvas", "markdown", "html", "svg"] as const) assert.equal(isTextKind(kind), true);
    for (const kind of ["image", "pdf", "audio", "video", "binary"] as const) assert.equal(isTextKind(kind), false);
  });
});

describe("toolWritesFiles", () => {
  test("编辑、写入、生成图片类算写文件", () => {
    for (const name of ["edit", "Write", "StrReplace", "apply_patch", "EditNotebook", "createFile", "generate_image"]) {
      assert.equal(toolWritesFiles(name), true, name);
    }
  });

  test("todo、计划、删除和只读工具不算", () => {
    for (const name of [
      "todo_write",
      "TodoWrite",
      "CreatePlan",
      "delete",
      "delete_file",
      "remove",
      "read",
      "grep",
      "shell",
    ]) {
      assert.equal(toolWritesFiles(name), false, name);
    }
  });

  test("按子串匹配：名字里含 edit 的也算（例如 credit）", () => {
    assert.equal(toolWritesFiles("credit_check"), true);
  });
});

describe("toolPaths", () => {
  test("从参数和结果的路径键里收集，按出现顺序去重", () => {
    const paths = toolPaths([
      tool("edit", { path: "a.ts" }),
      tool("write", { file_path: "b.ts" }, { result: { path: "a.ts", outputPath: "c.png" } }),
      tool("edit", { path: "  " }),
    ]);
    assert.deepEqual(paths, ["a.ts", "b.ts", "c.png"]);
  });

  test("跳过失败的调用和非写文件工具", () => {
    const paths = toolPaths([
      tool("edit", { path: "失败.ts" }, { status: "error" }),
      tool("read", { path: "只读.ts" }),
      tool("edit", { path: "ok.ts" }, { status: "running" }),
    ]);
    assert.deepEqual(paths, ["ok.ts"]);
  });

  test("file:// 前缀去掉并做百分号解码；列表键里的字符串和对象都认", () => {
    const paths = toolPaths([
      tool("edit", { path: "file:///w/%E4%B8%AD%20文.ts" }),
      tool("write", { files: ["x.ts", { path: "y.ts" }, 3] }),
    ]);
    assert.deepEqual(paths, ["/w/中 文.ts", "x.ts", "y.ts"]);
  });

  test("apply_patch 正文里的 Add/Update File 行也算，Delete 不算", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "+x",
      "*** Update File:   src/old.ts  ",
      "*** Delete File: gone.ts",
      "*** End Patch",
    ].join("\n");
    assert.deepEqual(toolPaths([tool("apply_patch", { input: patch })]), ["new.ts", "src/old.ts"]);
  });
});

describe("workspaceRel", () => {
  const cwd = "/w";

  test("相对路径和工作区内的绝对路径都转成工作区相对路径", () => {
    assert.equal(workspaceRel(cwd, "a.ts"), "a.ts");
    assert.equal(workspaceRel(cwd, "./src/../b.ts"), "b.ts");
    assert.equal(workspaceRel(cwd, "/w/src/c.ts"), "src/c.ts");
  });

  test("工作区外、工作区本身、空串返回 null", () => {
    assert.equal(workspaceRel(cwd, "/other/a.ts"), null);
    assert.equal(workspaceRel(cwd, "../a.ts"), null);
    assert.equal(workspaceRel(cwd, "/w"), null);
    assert.equal(workspaceRel(cwd, ""), null);
    assert.equal(workspaceRel(cwd, "/wx/a.ts"), null);
  });

  test(".git 目录里的路径排除", () => {
    assert.equal(workspaceRel(cwd, ".git/config"), null);
    assert.equal(workspaceRel(cwd, "sub/.git/HEAD"), null);
    assert.equal(workspaceRel(cwd, ".gitignore"), ".gitignore");
  });

  test("现状：根目录下以 .. 开头的文件名也被当成越界", () => {
    assert.equal(workspaceRel(cwd, "..notes.md"), null);
  });
});

describe("canvasPathsFromAssistant", () => {
  test("markdown 链接和 @ 提及里的 .canvas.tsx，按出现顺序去重", () => {
    const text = "看 [看板](canvases/a.canvas.tsx) 和 @canvases/b.canvas.tsx 再看一次 [又是](./canvases/a.canvas.tsx)";
    assert.deepEqual(canvasPathsFromAssistant(text), ["canvases/a.canvas.tsx", "canvases/b.canvas.tsx"]);
  });

  test("现状：@ 提及后紧跟全角逗号再接文字时，整段被当成路径而认不出", () => {
    assert.deepEqual(canvasPathsFromAssistant("@b.canvas.tsx，再看"), []);
    assert.deepEqual(canvasPathsFromAssistant("@b.canvas.tsx，"), ["b.canvas.tsx"]);
  });

  test("去掉行号、锚点、查询串和结尾标点，并做百分号解码", () => {
    const text =
      "[a](src/x.canvas.tsx:12-20) [b](y.canvas.tsx#L3) [c](z.canvas.tsx?v=1) @w.canvas.tsx。 [d](my%20c.canvas.tsx)";
    assert.deepEqual(canvasPathsFromAssistant(text), [
      "src/x.canvas.tsx",
      "y.canvas.tsx",
      "z.canvas.tsx",
      "my c.canvas.tsx",
      "w.canvas.tsx",
    ]);
  });

  test("http 等外链不算，file:// 去前缀", () => {
    const text = "[外](https://example.com/a.canvas.tsx) [本地](file:///abs/b.canvas.tsx)";
    assert.deepEqual(canvasPathsFromAssistant(text), ["/abs/b.canvas.tsx"]);
  });

  test("不是 canvas 的链接、邮箱和空文本都忽略", () => {
    assert.deepEqual(canvasPathsFromAssistant("[x](a.tsx) mail@example.com @foo"), []);
    assert.deepEqual(canvasPathsFromAssistant(""), []);
  });

  test("现状：不带目录的文件名加 :行号 会被当成 URL scheme 丢掉", () => {
    assert.deepEqual(canvasPathsFromAssistant("[a](x.canvas.tsx:12) @y.canvas.tsx:3"), []);
  });

  test("现状：尖括号包住的带空格路径会在空格处截断，因而认不出", () => {
    assert.deepEqual(canvasPathsFromAssistant("[a](<my dir/a.canvas.tsx>)"), []);
  });
});

describe("git 输出解析", () => {
  test("parseNameStatus 按 NUL 成对拆状态和路径", () => {
    assert.deepEqual(parseNameStatus("M\0a.ts\0A\0dir/b c.ts\0D\0gone.ts\0"), [
      { status: "M", path: "a.ts" },
      { status: "A", path: "dir/b c.ts" },
      { status: "D", path: "gone.ts" },
    ]);
    assert.deepEqual(parseNameStatus(""), []);
  });

  test("parseNumstat：二进制文件的 - 记成 undefined，容忍行首换行", () => {
    const map = parseNumstat("3\t1\tsrc/a.ts\0\n-\t-\timg.png\0garbage\0");
    assert.deepEqual([...map.keys()], ["src/a.ts", "img.png"]);
    assert.deepEqual(map.get("src/a.ts"), { added: 3, removed: 1 });
    assert.deepEqual(map.get("img.png"), { added: undefined, removed: undefined });
  });

  test("unquoteGitPath 还原 C 风格转义和八进制 UTF-8 字节", () => {
    assert.equal(unquoteGitPath('"\\344\\270\\255\\346\\226\\207.txt"'), "中文.txt");
    assert.equal(unquoteGitPath('"a\\tb\\n\\"q\\"\\\\"'), 'a\tb\n"q"\\');
    assert.equal(unquoteGitPath("plain.txt"), "plain.txt");
    assert.equal(unquoteGitPath('"'), '"');
  });

  test("unquoteGitPath：未知转义保留反斜杠", () => {
    assert.equal(unquoteGitPath('"a\\xb"'), "a\\xb");
  });

  test("parseDiffHeader 处理普通、带空格和带引号的路径", () => {
    assert.equal(parseDiffHeader("diff --git a/src/a.ts b/src/a.ts"), "src/a.ts");
    assert.equal(parseDiffHeader("diff --git a/my file.ts b/my file.ts"), "my file.ts");
    assert.equal(parseDiffHeader('diff --git "a/\\344\\270\\255.ts" "b/\\344\\270\\255.ts"'), "中.ts");
    assert.equal(parseDiffHeader("diff --git x/a b/a"), null);
    assert.equal(parseDiffHeader("diff --git a/ab b/abc"), null);
  });

  test("splitGitDiff 按 diff --git 头拆成每个文件的片段", () => {
    const a = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n";
    const b = "diff --git a/b.ts b/b.ts\nnew file mode 100644\n+z\n";
    const map = splitGitDiff(`${a}${b}`);
    assert.deepEqual([...map.keys()], ["a.ts", "b.ts"]);
    assert.equal(map.get("a.ts"), a);
    assert.equal(map.get("b.ts"), b);
    assert.equal(splitGitDiff("没有头").size, 0);
  });

  test("countDiffLines 数 +/- 行，跳过 +++/--- 文件头", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context";
    assert.deepEqual(countDiffLines(diff), { added: 2, removed: 1 });
    assert.deepEqual(countDiffLines(""), { added: 0, removed: 0 });
  });

  test("现状：内容本身以 -- 或 ++ 开头的改动行会被当成文件头漏数", () => {
    const diff = "@@ -1 +1 @@\n--- 旧的 SQL 注释\n+++新的\n+普通";
    assert.deepEqual(countDiffLines(diff), { added: 1, removed: 0 });
  });
});

describe("快照存储", () => {
  test("storeArtifact 按 sha256 存，重复存只刷新不重写", () => {
    const stateDir = tempDir("store");
    const first = storeArtifact(stateDir, Buffer.from("hello"));
    assert.equal(first.sha, sha256("hello"));
    assert.equal(first.wrote, true);
    assert.equal(storeArtifact(stateDir, Buffer.from("hello")).wrote, false);
    assert.equal(readArtifact(stateDir, first.sha)?.toString(), "hello");
    assert.deepEqual(readdirSync(resolve(stateDir, "artifacts")), [first.sha]);
  });

  test("非法 sha 不拼路径，缺失的快照返回 null", () => {
    const stateDir = tempDir("bad");
    assert.equal(artifactPath(stateDir, "../../etc/passwd"), null);
    assert.equal(readArtifact(stateDir, "../x"), null);
    assert.equal(readArtifact(stateDir, "0".repeat(64)), null);
  });

  test("readSnapshotFile 按类型分支：文本给内容，图片只给元数据，含 NUL 的文本判二进制", () => {
    const stateDir = tempDir("read");
    const text = storeArtifact(stateDir, Buffer.from("const a = 1;\n")).sha;
    const png = storeArtifact(stateDir, Buffer.from([0x89, 0x50, 0x4e, 0x47])).sha;
    const bin = storeArtifact(stateDir, Buffer.from([0x61, 0x00, 0x62])).sha;
    assert.deepEqual(readSnapshotFile(stateDir, "a.ts", text), {
      path: "a.ts",
      content: "const a = 1;\n",
      kind: "text",
      mime: "text/plain; charset=utf-8",
      size: 13,
    });
    assert.deepEqual(readSnapshotFile(stateDir, "p.png", png), {
      path: "p.png",
      kind: "image",
      mime: "image/png",
      size: 4,
    });
    assert.equal(readSnapshotFile(stateDir, "b.dat", bin).kind, "binary");
    assert.equal(readSnapshotFile(stateDir, "b.dat", bin).error, "二进制文件，没法预览");
  });

  test("readSnapshotFile：sha 非法、快照已清理、文件超限分别报错", () => {
    const stateDir = tempDir("err");
    assert.equal(readSnapshotFile(stateDir, "a.ts", "nope").error, "sha 不合法");
    assert.equal(readSnapshotFile(stateDir, "a.ts", "f".repeat(64)).error, SNAPSHOT_GONE);
    const big = storeArtifact(stateDir, Buffer.alloc(200_001, 0x61)).sha;
    const res = readSnapshotFile(stateDir, "big.txt", big);
    assert.match(res.error ?? "", /^文件太大/);
    assert.equal(res.content, undefined);
  });

  test("readSnapshotDiff 固定按 text/x-diff 返回", () => {
    const stateDir = tempDir("diff");
    const sha = storeArtifact(stateDir, Buffer.from("+x\n")).sha;
    assert.deepEqual(readSnapshotDiff(stateDir, "a.ts", sha), {
      path: "a.ts",
      content: "+x\n",
      kind: "text",
      mime: "text/x-diff",
      size: 3,
    });
    assert.equal(readSnapshotDiff(stateDir, "a.ts", "x").error, "sha 不合法");
  });
});

describe("快照配额", () => {
  function seed(stateDir: string, specs: Array<{ name: string; size: number; ageMs: number }>) {
    const dir = resolve(stateDir, "artifacts");
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const spec of specs) {
      const file = resolve(dir, spec.name);
      writeFileSync(file, Buffer.alloc(spec.size, 0x61));
      const at = new Date(now - spec.ageMs);
      utimesSync(file, at, at);
    }
    return dir;
  }
  const hex = (c: string) => c.repeat(64);

  test("超过上限时按 mtime 从旧到新删到目标以下", () => {
    const stateDir = tempDir("quota");
    const dir = seed(stateDir, [
      { name: hex("a"), size: 100, ageMs: 30_000 },
      { name: hex("b"), size: 100, ageMs: 20_000 },
      { name: hex("c"), size: 100, ageMs: 10_000 },
    ]);
    assert.equal(enforceArtifactQuota(stateDir, 250, 150), 2);
    assert.deepEqual(readdirSync(dir), [hex("c")]);
  });

  test("没超上限不删；一小时前的残留临时文件顺手清掉，新的留着", () => {
    const stateDir = tempDir("tmpclean");
    const dir = seed(stateDir, [
      { name: hex("a"), size: 10, ageMs: 0 },
      { name: ".old.tmp", size: 10, ageMs: 2 * 60 * 60_000 },
      { name: ".new.tmp", size: 10, ageMs: 0 },
    ]);
    assert.equal(enforceArtifactQuota(stateDir, 1000, 900), 0);
    assert.deepEqual(readdirSync(dir).sort(), [".new.tmp", hex("a")].sort());
  });

  test("目录不存在时返回 0", () => {
    assert.equal(enforceArtifactQuota(tempDir("empty"), 1, 0), 0);
  });

  test("checkArtifactQuota 在缓存没过期时不扫盘，过了重扫间隔才删", () => {
    const stateDir = tempDir("check");
    seed(stateDir, [{ name: hex("a"), size: 10, ageMs: 10_000 }]);
    const now = 1_000_000;
    assert.equal(checkArtifactQuota(stateDir, 100, 50, now), 0);
    seed(stateDir, [{ name: hex("b"), size: 200, ageMs: 0 }]);
    assert.equal(checkArtifactQuota(stateDir, 100, 50, now + 1), 0);
    assert.equal(checkArtifactQuota(stateDir, 100, 50, now + QUOTA_RESCAN_MS), 2);
  });
});

describe("computeTurnFiles（无基线）", () => {
  test("列出工具写过的工作区文件，存快照和对照文本；越界、符号链接、不存在的跳过", () => {
    const cwd = tempDir("cwd");
    const stateDir = tempDir("state");
    writeFileSync(resolve(cwd, "a.ts"), "export const a = 1;\n");
    writeFileSync(resolve(cwd, "pic.png"), Buffer.from([1, 2, 3]));
    writeFileSync(resolve(cwd, "board.canvas.tsx"), "export default () => null;\n");
    symlinkSync(resolve(cwd, "a.ts"), resolve(cwd, "link.ts"));
    const asked: string[] = [];
    const files = computeTurnFiles({
      cwd,
      stateDir,
      tools: [
        tool("edit", { path: "a.ts" }),
        tool("write", { path: "link.ts" }),
        tool("write", { path: "../outside.ts" }),
        tool("write", { path: "missing.ts" }),
        tool("generate_image", { output_path: "pic.png" }),
      ],
      assistantBody: "画好了：[看板](board.canvas.tsx)",
      fallbackDiff: (rel) => {
        asked.push(rel);
        return rel === "a.ts" ? "new file mode 100644\n--- /dev/null\n+++ b/a.ts\n+export const a = 1;\n" : null;
      },
    });
    assert.deepEqual(
      files.map((file) => file.path),
      ["a.ts", "pic.png", "board.canvas.tsx"],
    );
    assert.deepEqual(asked, ["a.ts", "board.canvas.tsx"]);
    const [a, pic, board] = files;
    assert.equal(a.op, "added");
    assert.equal(a.kind, "text");
    assert.equal(a.sha, sha256("export const a = 1;\n"));
    assert.ok(isSha(a.diffSha));
    assert.deepEqual([a.added, a.removed], [1, 0]);
    assert.equal(pic.kind, "image");
    assert.equal(pic.op, "modified");
    assert.equal(pic.diffSha, undefined);
    assert.equal(board.kind, "canvas");
    assert.equal(board.diffSha, undefined);
  });

  test("没有任何写文件工具时返回空清单", () => {
    const files = computeTurnFiles({
      cwd: tempDir("cwd2"),
      stateDir: tempDir("state2"),
      tools: [tool("read", { path: "a.ts" })],
      fallbackDiff: () => null,
    });
    assert.deepEqual(files, []);
  });
});
