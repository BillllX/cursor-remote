import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { filePayload } from "./media.ts";
import { keepTurnFiles, mergeUploadedTurns, turnFromTranscript, type RunTool, type RunTranscript } from "./runlog.ts";
import {
  artifactPath,
  artifactsDir,
  checkArtifactQuota,
  computeTurnFiles,
  enforceArtifactQuota,
  FALLBACK_DIFF_LIMIT,
  isSha,
  parseDiffHeader,
  QUOTA_RESCAN_MS,
  readSnapshotDiff,
  readSnapshotFile,
  snapshotTree,
  SNAPSHOT_GONE,
  splitGitDiff,
  storeArtifact,
  toolPaths,
  type TurnBaseline,
} from "./turnFiles.ts";

/**
 * 每轮文件清单冒烟：工具路径提取、带基线的清单与行数、无基线退回、快照存取与配额、合并保护。
 * 全部在系统临时目录里跑，跑完删除。
 */

const root = mkdtempSync(resolve(tmpdir(), "turnfiles-smoke-"));
let passed = 0;
let failed = 0;
function check(ok: boolean, label: string) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@localhost", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tool(name: string, args: unknown, extra: Partial<RunTool> = {}): RunTool {
  return { callId: `c-${Math.random().toString(36).slice(2)}`, name, args, status: "completed", ...extra };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

try {
  // ---------- 工具路径提取 ----------
  const patch = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+export const a = 1;",
    "*** Update File: src/old.ts",
    "@@",
    "-x",
    "+y",
    "*** Delete File: src/gone.ts",
    "*** End Patch",
  ].join("\n");
  const paths = toolPaths([
    tool("Write", { path: "a.txt" }),
    tool("MultiEdit", { paths: ["b.txt", { file_path: "c.txt" }] }),
    tool("ApplyPatch", { patch }),
    tool("apply_patch", patch),
    tool("Delete", { path: "del.txt" }),
    tool("remove_file", { path: "rm.txt" }),
    tool("StrReplace", { path: "err.txt" }, { status: "error" }),
    tool("TodoWrite", { path: "todo.txt" }),
    tool("CreatePlan", { path: "plan.md" }),
    tool("Read", { path: "read.txt" }),
    tool("GenerateImage", { prompt: "猫" }, { result: { imagePath: "img/cat.png" } }),
    tool("edit_file", { uri: "file:///abs/x.md" }),
    tool("Write", { path: "a.txt" }),
  ]);
  check(
    JSON.stringify(paths) ===
      JSON.stringify(["a.txt", "b.txt", "c.txt", "src/new.ts", "src/old.ts", "img/cat.png", "/abs/x.md"]),
    `工具路径：数组、apply_patch、生成图片、uri，排除删除/出错/todo/读 → ${JSON.stringify(paths)}`,
  );

  // ---------- 带基线：git 仓库里聊天目录是子目录 ----------
  const repo = resolve(root, "repo");
  const sub = resolve(repo, "sub");
  mkdirSync(sub, { recursive: true });
  git(repo, ["init", "-q"]);
  writeFileSync(resolve(repo, ".gitignore"), "ignored.log\n");
  writeFileSync(resolve(sub, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(resolve(sub, "keep.md"), "# keep\n");
  writeFileSync(resolve(sub, "d.txt"), "bye\n");
  writeFileSync(resolve(repo, "outside.txt"), "outside\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const indexFile = resolve(repo, ".git", "index");
  const indexBefore = readFileSync(indexFile);
  const stateDir = resolve(root, "state");

  // 本轮改动：改 a.txt，新增 c.ts（工具）和 shell.txt（只有 git 看得到），删 d.txt，写一个 gitignore 的文件，改仓库外的兄弟文件
  writeFileSync(resolve(sub, "a.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(resolve(sub, "c.ts"), "export const c = 1;\nexport const d = 2;\n");
  writeFileSync(resolve(sub, "shell.txt"), "from shell\n");
  writeFileSync(resolve(sub, "ignored.log"), "log line\n");
  unlinkSync(resolve(sub, "d.txt"));
  writeFileSync(resolve(repo, "outside.txt"), "changed\n");

  const baseline: TurnBaseline = { commit: head, ctx: { cwd: repo, env: {} }, prefix: "sub", scope: ["sub"] };
  const files = computeTurnFiles({
    cwd: sub,
    stateDir,
    tools: [
      tool("Write", { path: "c.ts" }),
      tool("StrReplace", { path: resolve(sub, "a.txt") }),
      tool("Write", { path: "ignored.log" }),
      tool("Delete", { path: "d.txt" }),
      tool("Write", { path: "../outside.txt" }),
    ],
    baseline,
    fallbackDiff: (rel) => `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,1 @@\n+log line`,
  });
  const byPath = new Map(files.map((item) => [item.path, item]));
  check(
    JSON.stringify(files.map((item) => item.path)) === JSON.stringify(["c.ts", "a.txt", "ignored.log", "shell.txt"]),
    `基线清单：工具顺序在前、git 多出的追加，排除删除和工作区外 → ${JSON.stringify(files.map((item) => item.path))}`,
  );
  const a = byPath.get("a.txt");
  check(a?.op === "modified" && a.added === 2 && a.removed === 1, `a.txt 修改 +2 -1 → ${JSON.stringify(a)}`);
  const c = byPath.get("c.ts");
  check(c?.op === "added" && c.added === 2 && c.removed === 0, `c.ts 新增 +2 → ${JSON.stringify(c)}`);
  check(byPath.get("shell.txt")?.op === "added", "shell 新建的文件按 git 判成 added");
  const ignored = byPath.get("ignored.log");
  check(ignored?.op === "added" && ignored.added === 1 && Boolean(ignored.diffSha), "gitignore 的新文件退回工作区对照");
  check(
    a?.sha === sha("one\nTWO\nthree\nfour\n") && a.size === Buffer.byteLength("one\nTWO\nthree\nfour\n"),
    "a.txt 的 sha/size 是这一轮结束时的内容",
  );
  check(Boolean(a?.sha && existsSync(artifactPath(stateDir, a.sha)!)), "文件快照落在 artifacts/<sha>");
  const diff = a?.diffSha ? readSnapshotDiff(stateDir, "a.txt", a.diffSha) : null;
  check(Boolean(diff?.content?.includes("+TWO") && diff.content.includes("-two")), "对照文本按 diffSha 能读回");
  check(readFileSync(indexFile).equals(indexBefore), "用户仓库真实 index 没被动过");
  check(git(repo, ["rev-parse", "HEAD"]) === head, "用户仓库 HEAD 没被动过");
  check(
    !readdirSync(tmpdir()).some((name) => name.startsWith(`cursor-remote-turn-${process.pid}-`)),
    "临时 index 用完删掉",
  );

  // 快照与工作区解耦：文件之后被改/删，按 sha 读到的仍是结束时版本
  writeFileSync(resolve(sub, "a.txt"), "later\n");
  const snap = readSnapshotFile(stateDir, "a.txt", a!.sha!);
  check(snap.content === "one\nTWO\nthree\nfour\n" && snap.kind === "text", "工作区之后改了，快照内容不变");

  // git 出错静默退回来源 A
  const broken = computeTurnFiles({
    cwd: sub,
    stateDir,
    tools: [tool("Write", { path: "c.ts" })],
    baseline: { ...baseline, commit: "0".repeat(40) },
    fallbackDiff: () => null,
  });
  check(broken.length === 1 && broken[0].path === "c.ts", "基线 commit 不存在时退回工具路径");

  // ---------- 无基线：非 git 目录 ----------
  const plain = resolve(root, "plain");
  mkdirSync(resolve(plain, "docs"), { recursive: true });
  writeFileSync(resolve(plain, "docs", "x.md"), "# 标题\n正文\n");
  writeFileSync(resolve(plain, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  mkdirSync(resolve(plain, ".git"), { recursive: true });
  writeFileSync(resolve(plain, ".git", "config"), "x");
  const plainFiles = computeTurnFiles({
    cwd: plain,
    stateDir,
    tools: [
      tool("Write", { path: "docs/x.md" }),
      tool("GenerateImage", {}, { result: { output_path: "pic.png" } }),
      tool("Write", { path: ".git/config" }),
      tool("Write", { path: "missing.txt" }),
      tool("Write", { path: "docs" }),
    ],
    baseline: null,
    fallbackDiff: (rel) =>
      rel === "docs/x.md" ? "diff --git a/docs/x.md b/docs/x.md\nnew file\n--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1,2 @@\n+# 标题\n+正文" : null,
  });
  check(
    JSON.stringify(plainFiles.map((item) => item.path)) === JSON.stringify(["docs/x.md", "pic.png"]),
    `无基线：只用工具路径，跳过 .git、不存在和目录 → ${JSON.stringify(plainFiles.map((item) => item.path))}`,
  );
  const md = plainFiles[0];
  check(md?.kind === "markdown" && md.op === "added" && md.added === 2 && md.removed === 0 && Boolean(md.diffSha), "markdown 新文件 +2，带 diffSha");
  const png = plainFiles[1];
  check(png?.kind === "image" && png.op === "modified" && Boolean(png.sha) && png.diffSha == null, "图片有 sha、没有 diffSha，判断不了算 modified");

  // ---------- 快照写入、去重、配额 ----------
  const q = resolve(root, "quota");
  const first = storeArtifact(q, Buffer.from("same"));
  const again = storeArtifact(q, Buffer.from("same"));
  check(first.wrote && !again.wrote && first.sha === again.sha && first.sha === sha("same"), "同内容只写一次");
  const blobs = ["a", "b", "c"].map((ch) => storeArtifact(q, Buffer.alloc(100, ch)).sha);
  const now = Date.now() / 1000;
  utimesSync(resolve(artifactsDir(q), first.sha), now - 400, now - 400);
  blobs.forEach((item, i) => utimesSync(resolve(artifactsDir(q), item), now - 300 + i * 100, now - 300 + i * 100));
  // 读快照会刷新 mtime，最旧的那份因此留下
  readSnapshotFile(q, "x.txt", first.sha);
  const removed = enforceArtifactQuota(q, 250, 150);
  const left = readdirSync(artifactsDir(q)).sort();
  check(
    removed === 2 && left.length === 2 && left.includes(first.sha) && left.includes(blobs[2]),
    `超额按 mtime 从旧删，读过的不先删 → 删 ${removed}，剩 ${left.length}`,
  );
  check(enforceArtifactQuota(q, 10_000, 9_000) === 0, "没超额不删");

  // ---------- sha 校验 ----------
  check(isSha(sha("x")) && !isSha(sha("x").toUpperCase()) && !isSha("abc") && !isSha(`../${sha("x").slice(3)}`), "sha 只认 64 位小写 hex");
  check(artifactPath(q, "../../etc/passwd") === null, "非法 sha 不拼路径");
  check(readSnapshotFile(q, "a.txt", "nope").error === "sha 不合法", "read_file 带非法 sha 报错");
  check(readSnapshotFile(q, "a.txt", "f".repeat(64)).error === SNAPSHOT_GONE, "快照不存在回「历史版本已清理」");

  // ---------- file_content 回显与 url ----------
  const imgSha = png!.sha!;
  const media = filePayload("secret", "t1", "chat1", "pic.png", readSnapshotFile(stateDir, "pic.png", imgSha), false, {
    reqId: "r1",
    sha: imgSha,
  });
  check(
    media.reqId === "r1" && media.sha === imgSha && Boolean(media.url?.includes(`rev=sha%3A${imgSha}`)) && media.headUrl == null,
    "媒体类带 sha：url 走 rev=sha:，不给 headUrl，回显 reqId/sha",
  );
  const plainPayload = filePayload("secret", "t1", "chat1", "a.txt", { path: "a.txt", content: "x", kind: "text" }, false);
  check(!("reqId" in plainPayload) && !("sha" in plainPayload), "请求没带 reqId/sha 就不写键");
  const mdPayload = filePayload("secret", "t1", "chat1", "docs/x.md", readSnapshotFile(stateDir, "docs/x.md", md!.sha!), false, {
    sha: md!.sha,
  });
  check(Boolean(mdPayload.content?.includes("正文") && mdPayload.url?.includes("rev=sha%3A")), "markdown 快照同时给 content 和 sha url");

  // ---------- 配额缓存：没超额且扫描不旧时不碰磁盘 ----------
  const qc = resolve(root, "quota-cache");
  storeArtifact(qc, Buffer.alloc(100, "x"));
  const t0 = Date.now();
  check(checkArtifactQuota(qc, 250, 150, t0) === 0, "首次检查扫一遍目录，没超额");
  // 绕过 storeArtifact 直接塞文件：缓存不知道，十分钟内不重扫
  writeFileSync(resolve(artifactsDir(qc), sha("sneak")), Buffer.alloc(200, "s"));
  check(checkArtifactQuota(qc, 250, 150, t0 + 1000) === 0, "缓存未超额且扫描不旧：不重扫");
  check(checkArtifactQuota(qc, 250, 150, t0 + QUOTA_RESCAN_MS + 1) > 0, "距上次扫描超过 10 分钟：重扫并淘汰");
  storeArtifact(qc, Buffer.alloc(300, "y"));
  check(checkArtifactQuota(qc, 250, 150, t0 + QUOTA_RESCAN_MS + 2) > 0, "storeArtifact 累加进缓存，超额立即扫描淘汰");

  // ---------- 批量 diff 拆分 ----------
  check(parseDiffHeader("diff --git a/with space.txt b/with space.txt") === "with space.txt", "未加引号带空格的路径按长度切");
  check(
    parseDiffHeader('diff --git "a/q\\"uote\\ttab.txt" "b/q\\"uote\\ttab.txt"') === 'q"uote\ttab.txt',
    "加引号的路径还原转义",
  );
  check(parseDiffHeader('diff --git "a/\\344\\270\\255.md" "b/\\344\\270\\255.md"') === "中.md", "八进制转义按 UTF-8 还原");
  const split = splitGitDiff("diff --git a/x b/x\n+1\ndiff --git a/y y b/y y\n-2\n");
  check(split.get("x") === "diff --git a/x b/x\n+1\n" && split.get("y y") === "diff --git a/y y b/y y\n-2\n", "整段输出按 diff --git 头拆开");

  const batch = resolve(root, "batch");
  mkdirSync(batch, { recursive: true });
  git(batch, ["init", "-q"]);
  const names = ["with space.txt", "中文.md", 'q"uote.txt', "a[1].txt", "a1.txt", "plain.ts"];
  for (const name of names) writeFileSync(resolve(batch, name), `old ${name}\n`);
  git(batch, ["add", "-A"]);
  git(batch, ["commit", "-q", "-m", "init"]);
  const batchHead = git(batch, ["rev-parse", "HEAD"]);
  for (const name of names) if (name !== "a1.txt") writeFileSync(resolve(batch, name), `old ${name}\nnew ${name}\n`);
  const batchFiles = computeTurnFiles({
    cwd: batch,
    stateDir,
    tools: [],
    baseline: { commit: batchHead, ctx: { cwd: batch, env: {} }, prefix: "", scope: names },
    fallbackDiff: () => null,
  });
  const batchOk = names
    .filter((name) => name !== "a1.txt")
    .every((name) => {
      const row = batchFiles.find((item) => item.path === name);
      const text = row?.diffSha ? readSnapshotDiff(stateDir, name, row.diffSha).content || "" : "";
      const others = (text.match(/^diff --git /gm) || []).length;
      return row?.added === 1 && row.removed === 0 && others === 1 && text.includes(`+new ${name}`);
    });
  check(
    batchOk && !batchFiles.some((item) => item.path === "a1.txt"),
    `批量 diff：空格/中文/引号/方括号路径各拿到自己的那一段 → ${JSON.stringify(batchFiles.map((item) => item.path))}`,
  );

  // ---------- 无基线：对照文本限量、总预算 ----------
  const many = resolve(root, "many");
  mkdirSync(many, { recursive: true });
  const manyTools = Array.from({ length: 12 }, (_, i) => {
    writeFileSync(resolve(many, `f${i}.txt`), `line ${i}\n`);
    return tool("Write", { path: `f${i}.txt` });
  });
  let fallbackCalls = 0;
  const manyFiles = computeTurnFiles({
    cwd: many,
    stateDir,
    tools: manyTools,
    baseline: null,
    fallbackDiff: (rel) => {
      fallbackCalls += 1;
      return `diff --git a/${rel} b/${rel}\nnew file\n+++ b/${rel}\n+x`;
    },
  });
  check(
    manyFiles.length === 12 &&
      fallbackCalls === FALLBACK_DIFF_LIMIT &&
      manyFiles.filter((item) => item.diffSha).length === FALLBACK_DIFF_LIMIT &&
      manyFiles.every((item) => item.sha),
    `无基线最多 ${FALLBACK_DIFF_LIMIT} 个文件生成对照，其余只给 sha`,
  );
  const starved = computeTurnFiles({ cwd: many, stateDir, tools: manyTools, baseline: null, fallbackDiff: () => null, budgetMs: 0 });
  check(starved.length === 12 && starved.every((item) => !item.sha && !item.diffSha), "总预算用完：照常列清单，不存快照");

  // ---------- 只用于清单的 tree 基线（autoApprove）：工作区是仓库子目录，开始前已有未提交修改 ----------
  const auto = resolve(root, "auto");
  const autoSub = resolve(auto, "app");
  mkdirSync(autoSub, { recursive: true });
  git(auto, ["init", "-q"]);
  writeFileSync(resolve(autoSub, "a.txt"), "1\n2\n");
  writeFileSync(resolve(autoSub, "pre.txt"), "base\n");
  writeFileSync(resolve(auto, "sibling.txt"), "s\n");
  git(auto, ["add", "-A"]);
  git(auto, ["commit", "-q", "-m", "init"]);
  const autoHead = git(auto, ["rev-parse", "HEAD"]);
  // 回合开始前就有的脏改动：子目录里一处、兄弟目录一处
  writeFileSync(resolve(autoSub, "pre.txt"), "base\ndirty before turn\n");
  writeFileSync(resolve(autoSub, "untracked-before.txt"), "u\n");
  writeFileSync(resolve(auto, "sibling.txt"), "s\ndirty\n");
  const autoIndex = resolve(auto, ".git", "index");
  const autoIndexBefore = readFileSync(autoIndex);
  const refsBefore = git(auto, ["for-each-ref"]);
  const autoCtx = { cwd: auto, env: {} };
  const tree = snapshotTree({ ctx: autoCtx, prefix: "app", scope: ["app"] });
  check(Boolean(tree && /^[0-9a-f]{40}$/.test(tree)), "tree 基线建成");
  check(
    readFileSync(autoIndex).equals(autoIndexBefore) &&
      git(auto, ["rev-parse", "HEAD"]) === autoHead &&
      git(auto, ["for-each-ref"]) === refsBefore,
    "建 tree 基线不动 index、HEAD，不加 ref",
  );
  // 本轮：shell 写了新文件、改了 a.txt，工具调用里都没有
  writeFileSync(resolve(autoSub, "shell.txt"), "made by shell\n");
  writeFileSync(resolve(autoSub, "a.txt"), "1\n2\n3\n");
  const autoFiles = computeTurnFiles({
    cwd: autoSub,
    stateDir,
    tools: [],
    baseline: { commit: tree!, ctx: autoCtx, prefix: "app", scope: ["app"] },
    fallbackDiff: () => null,
  });
  const autoPaths = autoFiles.map((item) => item.path).sort();
  check(
    JSON.stringify(autoPaths) === JSON.stringify(["a.txt", "shell.txt"]),
    `tree 基线：shell 写的文件算进来，开始前的未提交修改和兄弟目录不算 → ${JSON.stringify(autoPaths)}`,
  );
  const autoA = autoFiles.find((item) => item.path === "a.txt");
  check(
    autoA?.op === "modified" && autoA.added === 1 && autoA.removed === 0 && autoFiles.find((item) => item.path === "shell.txt")?.op === "added",
    "tree 基线的 op 和行数",
  );
  check(readFileSync(autoIndex).equals(autoIndexBefore), "算清单后 index 仍没动");

  // 非 git 目录走 shadow git 那套 env（GIT_DIR + GIT_WORK_TREE），根目录按文件清单 add
  const loose = resolve(root, "loose");
  const shadow = resolve(root, "shadow.git");
  mkdirSync(loose, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", shadow]);
  writeFileSync(resolve(loose, "keep.txt"), "k\n");
  const shadowCtx = { cwd: loose, env: { GIT_DIR: shadow, GIT_WORK_TREE: loose } };
  const shadowTree = snapshotTree({ ctx: shadowCtx, prefix: "", scope: ["keep.txt"] });
  writeFileSync(resolve(loose, "new.md"), "# n\n");
  const looseFiles = computeTurnFiles({
    cwd: loose,
    stateDir,
    tools: [],
    baseline: { commit: shadowTree!, ctx: shadowCtx, prefix: "", scope: ["keep.txt", "new.md"] },
    fallbackDiff: () => null,
  });
  check(
    Boolean(shadowTree) && looseFiles.length === 1 && looseFiles[0].path === "new.md" && looseFiles[0].op === "added",
    "shadow git（空仓库 read-tree --empty）也能建 tree 基线",
  );
  check(snapshotTree({ ctx: autoCtx, prefix: "app", scope: ["app"] }, 0) === null, "tree 基线超预算就放弃");

  // ---------- 落盘与合并保护 ----------
  const turnFiles = [{ path: "a.txt", kind: "text" as const, op: "modified" as const, sha: a!.sha }];
  const transcript: RunTranscript = {
    turnId: "t1",
    userText: "改一下",
    assistant: "好了",
    thinking: "",
    tools: [],
    phase: "done",
    epoch: 1,
  };
  check(!("files" in turnFromTranscript(transcript)), "没文件时 turn 不写 files 键");
  check(
    JSON.stringify(turnFromTranscript({ ...transcript, files: turnFiles }).files) === JSON.stringify(turnFiles),
    "有文件时 turn 写 files",
  );
  const disk = [
    { id: "t0", user: "前一轮", assistant: "x" },
    { id: "t1", user: "改一下", assistant: "好了", files: turnFiles },
  ];
  const kept = mergeUploadedTurns(disk, [disk[0], { id: "t1", user: "改一下", assistant: "好了，再补一句" }], null).turns;
  check(JSON.stringify((kept[1] as { files?: unknown }).files) === JSON.stringify(turnFiles), "上传回合缺 files 键：保留磁盘的");
  const shorter = mergeUploadedTurns(disk, [{ id: "t1", user: "改一下", assistant: "" }], null).turns;
  check(Boolean((shorter[0] as { files?: unknown }).files), "上传回合更短（留用磁盘正文）时也保留 files");
  const replaced = mergeUploadedTurns(disk, [{ id: "t1", user: "改一下", assistant: "好了", files: [] }], null).turns;
  check(JSON.stringify((replaced[0] as { files?: unknown }).files) === "[]", "上传回合带 files 键：以上传为准");
  const otherId = mergeUploadedTurns(disk, [{ id: "t9", user: "改一下", assistant: "好了，更长的回答" }], null).turns;
  check(!("files" in (otherId[0] as object)), "按用户原文配上的别的回合不借 files");
  const viaKeep = keepTurnFiles(disk, [{ id: "t1", user: "改一下" }, { id: "t2", user: "新的" }]);
  check(
    Boolean((viaKeep[0] as { files?: unknown }).files) && !("files" in (viaKeep[1] as object)),
    "keepTurnFiles 按 id 补回 files（mergeAndCompactChat 用）",
  );
} catch (err) {
  failed += 1;
  console.error("FAIL  冒烟脚本异常", err);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nturnfiles smoke: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
