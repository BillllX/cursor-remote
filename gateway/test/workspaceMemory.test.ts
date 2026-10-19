import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { after, describe, test } from "node:test";
import { estimateTokens } from "../src/assistant/store.ts";
import { withFileLockSync } from "../src/fsAtomic.ts";
import {
  appendMemoryLines,
  effectiveMemoryState,
  formatMemoryLine,
  listProposals,
  markWorkspaceMemoryUsed,
  memoryTextMatch,
  parseMemoryFile,
  proposeWorkspaceMemory,
  planMemoryInjection,
  renderMemoryFile,
  restoreCards,
  searchWorkspaceMemory,
} from "../src/assistant/workspaceMemory.ts";

const root = mkdtempSync(join(tmpdir(), "cr-wsmem-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("appendMemoryLines", () => {
  test("保守近似去重：统一标点、空格和安全同义表达，但保留关键参数差异", () => {
    assert.deepEqual(memoryTextMatch("构建前运行：npm   run test。", "构建前运行 npm run test"), {
      matchKind: "normalized_exact",
      similarity: 1,
    });
    assert.deepEqual(memoryTextMatch("网关失败后检查配置并且重新启动服务。", "网关失败后检查配置以及重启服务"), {
      matchKind: "normalized_exact",
      similarity: 1,
    });
    const chineseTypo = memoryTextMatch(
      "网关启动失败时先检查环境变量配置是否完整并查看连接池状态然后重启服务同时保留日志供后续排查",
      "网关启动失败时先检查环境变量配置是否完整并查看连接池壮态然后重启服务同时保留日志供后续排察",
    );
    assert.equal(chineseTypo?.matchKind, "high_similarity");
    assert.ok((chineseTypo?.similarity ?? 0) >= 0.97);
    assert.equal(memoryTextMatch("使用 --port 3000 启动 gateway 服务", "使用 --port 3001 启动 gateway 服务"), null);
    assert.equal(memoryTextMatch("修改 src/a/config.ts 后运行构建", "修改 src/b/config.ts 后运行构建"), null);
    assert.equal(memoryTextMatch("认证模块会丢 refresh token，需要重登", "认证模块会丢 access token，需要重登"), null);
    assert.equal(
      memoryTextMatch(
        "发布流程必须在合并完成后检查所有服务状态并保留审计记录",
        "发布流程必须再合并完成后检查所有服务状态并保留审计记录",
      ),
      null,
    );
    assert.equal(
      memoryTextMatch(
        "依赖缓存统一放在 node_modules 并由包管理器维护",
        "依赖缓存统一放在 nodemodules 并由包管理器维护",
      ),
      null,
    );
  });

  test("中文语义翻转与中文数字变化均绝不近似合并", () => {
    const opposites = [
      [
        "部署完成后必须保留缓存并等待所有后台任务结束再关闭服务",
        "部署完成后不得保留缓存并等待所有后台任务结束再关闭服务",
      ],
      ["生产环境允许启用调试日志以便定位长期存在的连接问题", "生产环境禁止启用调试日志以便定位长期存在的连接问题"],
      ["网关启动时需要开启请求签名校验并记录所有失败原因", "网关启动时无需开启请求签名校验并记录所有失败原因"],
      ["迁移期间启用旧协议兼容并保留完整审计记录直到结束", "迁移期间禁用旧协议兼容并保留完整审计记录直到结束"],
      [
        "网关监听八千零八十端口并将每帧限制为三十二兆字节以避免阻塞",
        "网关监听八千零八十一端口并将每帧限制为三十二兆字节以避免阻塞",
      ],
      ["失败后最多重试三次并等待十秒再记录最终错误供后续排查", "失败后最多重试四次并等待十秒再记录最终错误供后续排查"],
      ["传输层把每帧大小限制为三十二兆字节并保留完整校验信息", "传输层把每帧大小限制为三十二千字节并保留完整校验信息"],
    ];
    for (const [left, right] of opposites) assert.equal(memoryTextMatch(left, right), null, `${left} / ${right}`);
  });

  test("批内规范化同义重复只写一条", () => {
    const dir = join(root, "batch-dedupe");
    assert.equal(
      appendMemoryLines(dir, [
        { section: "坑", text: "网关启动失败时先检查环境变量配置是否完整再重新启动服务", refs: [] },
        { section: "坑", text: "网关启动失败时先检查环境变量配置是否完整再重启服务。", refs: [] },
      ]),
      1,
    );
  });

  test("已有 .gitignore 保留原内容并精确追加锁目录规则", () => {
    const dir = join(root, "existing-ignore");
    mkdirSync(join(dir, ".jiebo"), { recursive: true });
    writeFileSync(join(dir, ".jiebo/.gitignore"), "keep-me\n");
    appendMemoryLines(dir, [{ section: "约定", text: "锁规则测试", refs: [] }]);
    assert.equal(readFileSync(join(dir, ".jiebo/.gitignore"), "utf8"), "keep-me\nmemory-audit.jsonl\n.memory.md.lock/\n");
  });

  test("写 memory.md 时顺手清掉同目录一小时前的 memory.md 临时文件，别的文件不碰", () => {
    const dir = join(root, "w1");
    const jiebo = join(dir, ".jiebo");
    mkdirSync(jiebo, { recursive: true });
    const old = Date.now() / 1000 - 2 * 3600;
    const put = (name: string, stale: boolean) => {
      writeFileSync(join(jiebo, name), "x");
      if (stale) utimesSync(join(jiebo, name), old, old);
    };
    put("memory.md.123.0a1b2c3d.tmp", true);
    put("memory.md.124.0a1b2c3d.tmp", false);
    put("notes.md.125.0a1b2c3d.tmp", true);
    put("memory.md.tmp", true);
    assert.equal(appendMemoryLines(dir, [{ section: "约定", text: "用 npm run check 验证", refs: [] }]), 1);
    assert.deepEqual(readdirSync(jiebo).sort(), [
      ".gitignore",
      "memory.md",
      "memory.md.124.0a1b2c3d.tmp",
      "memory.md.tmp",
      "notes.md.125.0a1b2c3d.tmp",
    ]);
  });

  test("pinned 元数据写入后能解析回来，普通条目不被自动置顶", () => {
    const dir = join(root, "pinned-roundtrip");
    assert.equal(
      appendMemoryLines(dir, [
        { section: "约定", text: "人工置顶", refs: [], pinned: true },
        { section: "约定", text: "普通提议", refs: [] },
      ]),
      2,
    );
    const text = readFileSync(join(dir, ".jiebo/memory.md"), "utf8");
    assert.match(text, /人工置顶 <!-- pinned=1 -->/);
    assert.doesNotMatch(text, /普通提议.*pinned=1/);
    assert.deepEqual(
      parseMemoryFile(text).map((line) => line.pinned),
      [true, undefined],
    );
  });

  test("生命周期与未知元数据 parse/format 向后兼容且保留人工顺序", () => {
    const raw = "- 条目 <!-- owner=alice id=x state=cold foo=bar used=2026-10-01 uses=2 expires=2026-12-01 -->";
    const parsed = parseMemoryFile(`## 约定\n${raw}`)[0];
    assert.equal(parsed.state, "cold");
    assert.equal(parsed.used, "2026-10-01");
    assert.equal(parsed.uses, 2);
    assert.equal(parsed.expires, "2026-12-01");
    assert.deepEqual(parsed.meta, { owner: "alice", foo: "bar" });
    assert.equal(formatMemoryLine(parsed), raw);
  });
});

function child(script: string) {
  return new Promise<void>((accept, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? accept() : reject(new Error(`child ${code}: ${stderr}`))));
  });
}

describe("cross-process write protection", () => {
  test("多个进程并发 append 不丢条目", async () => {
    const dir = join(root, "parallel-append");
    const module = new URL("../src/assistant/workspaceMemory.ts", import.meta.url).href;
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        child(
          `const {appendMemoryLines}=await import(${JSON.stringify(module)});appendMemoryLines(${JSON.stringify(dir)},[{section:"约定",text:${JSON.stringify(`并发唯一条目 ${index}`)},refs:[]}]);`,
        ),
      ),
    );
    assert.equal(parseMemoryFile(readFileSync(join(dir, ".jiebo/memory.md"), "utf8")).length, 8);
  });

  test("append 与 mark_used 并发不覆盖彼此", async () => {
    const base = join(root, "parallel-mark");
    const cwd = join(base, "project");
    const tenant = { id: "parallel-mark", stateDir: join(root, "state-parallel-mark"), workspaceRoot: base };
    appendMemoryLines(cwd, [{ section: "约定", text: "原条目", id: "stable", refs: [] }]);
    const module = new URL("../src/assistant/workspaceMemory.ts", import.meta.url).href;
    await Promise.all([
      child(
        `const m=await import(${JSON.stringify(module)});m.appendMemoryLines(${JSON.stringify(cwd)},[{section:"约定",text:"并发新增条目",refs:[]}]);`,
      ),
      child(
        `const m=await import(${JSON.stringify(module)});m.markWorkspaceMemoryUsed(${JSON.stringify(tenant)},${JSON.stringify(cwd)},"stable","2026-10-18");`,
      ),
    ]);
    const text = readFileSync(join(cwd, ".jiebo/memory.md"), "utf8");
    assert.match(text, /并发新增条目/);
    assert.match(text, /id=stable used=2026-10-18 uses=1/);
  });

  test("并发确认提议不丢 proposal", async () => {
    const base = join(root, "parallel-proposals");
    const cwd = join(base, "project");
    const tenant = { id: "parallel-proposals", stateDir: join(root, "state-parallel-proposals"), workspaceRoot: base };
    mkdirSync(cwd, { recursive: true });
    const module = new URL("../src/assistant/workspaceMemory.ts", import.meta.url).href;
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        child(
          `const m=await import(${JSON.stringify(module)});const r=m.proposeWorkspaceMemory(${JSON.stringify(tenant)},{chatId:"chat-${index}",cwd:${JSON.stringify(cwd)},section:"约定",text:${JSON.stringify(`队列唯一提议 ${index}`)}},{confirm:true});if(!r.ok)throw new Error(r.error);`,
        ),
      ),
    );
    assert.equal(listProposals({ id: tenant.id, stateDir: tenant.stateDir }).proposals.length, 6);
  });

  test("answerCard 等待 memory 锁时不持有 store 锁", async () => {
    const base = join(root, "answer-lock-order");
    const cwd = join(base, "project");
    const stateDir = join(root, "state-answer-lock-order");
    const tenant = { id: "answer-lock-order", stateDir, workspaceRoot: base };
    const store = join(stateDir, "assistant", "workspace-memory.json");
    mkdirSync(join(cwd, ".jiebo"), { recursive: true });
    mkdirSync(resolve(store, ".."), { recursive: true });
    writeFileSync(
      store,
      JSON.stringify({
        proposals: [
          {
            id: "p1",
            kind: "workspace",
            chatId: "chat",
            dir: "project",
            section: "约定",
            text: "批准路径并发写入",
            refs: [],
            createdAt: Date.now(),
            cardId: "card",
          },
        ],
        cards: [
          {
            callId: "card",
            chatId: "chat",
            tool: "workspace_memory",
            summary: "test",
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        ],
      }),
    );
    const module = new URL("../src/assistant/workspaceMemory.ts", import.meta.url).href;
    let proc: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    withFileLockSync(join(cwd, ".jiebo/.memory.md"), () => {
      proc = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--eval",
          `const m=await import(${JSON.stringify(module)});const r=m.answerCard(${JSON.stringify(tenant)},"chat","card",true);if(!r?.ok)throw new Error(r?.error);`,
        ],
        { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", "ignore", "pipe"] },
      );
      exited = new Promise<void>((accept, reject) => {
        let stderr = "";
        proc!.stderr!.on("data", (chunk) => (stderr += chunk));
        proc!.on("error", reject);
        proc!.on("exit", (code) => (code === 0 ? accept() : reject(new Error(`answer child ${code}: ${stderr}`))));
      });
      const deadline = Date.now() + 5_000;
      let processing = false;
      while (Date.now() < deadline) {
        try {
          processing = Boolean(JSON.parse(readFileSync(store, "utf8")).cards[0]?.processingToken);
        } catch {
          // atomic rename window
        }
        if (processing) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.equal(processing, true);
      assert.equal(existsSync(`${store}.lock`), false);
      const queued = proposeWorkspaceMemory(
        tenant,
        { chatId: "other", cwd, section: "约定", text: "store 锁仍可立即获取" },
        { confirm: true },
      );
      assert.equal(queued.ok, true);
    });
    await exited;
    assert.match(readFileSync(join(cwd, ".jiebo/memory.md"), "utf8"), /批准路径并发写入/);
  });

  test("stale lock 可恢复，live lock 有界超时且源文件不变，异常会释放锁", () => {
    const file = join(root, "locks", "state.json");
    mkdirSync(`${file}.lock`, { recursive: true });
    writeFileSync(
      join(`${file}.lock`, "owner.json"),
      JSON.stringify({ pid: 999_999_999, host: hostname(), token: "dead" }),
    );
    const old = Date.now() / 1000 - 60;
    utimesSync(`${file}.lock`, old, old);
    assert.equal(
      withFileLockSync(file, () => "recovered", { staleMs: 10, timeoutMs: 100 }),
      "recovered",
    );

    const freshDead = join(root, "locks", "fresh-dead.json");
    mkdirSync(`${freshDead}.lock`);
    writeFileSync(
      join(`${freshDead}.lock`, "owner.json"),
      JSON.stringify({ pid: 999_999_998, host: hostname(), token: "fresh-dead" }),
    );
    assert.equal(
      withFileLockSync(freshDead, () => "recovered-now", { staleMs: 60_000, timeoutMs: 100 }),
      "recovered-now",
    );

    const incomplete = join(root, "locks", "incomplete.json");
    mkdirSync(`${incomplete}.lock`);
    assert.throws(
      () => withFileLockSync(incomplete, () => "must-not-run", { staleMs: 60_000, timeoutMs: 20, retryMs: 2 }),
      /等待文件锁超时/,
    );
    rmSync(`${incomplete}.lock`, { recursive: true });

    writeFileSync(file, "original");
    mkdirSync(`${file}.lock`);
    writeFileSync(
      join(`${file}.lock`, "owner.json"),
      JSON.stringify({ pid: process.pid, host: hostname(), token: "live" }),
    );
    assert.throws(
      () => withFileLockSync(file, () => writeFileSync(file, "changed"), { timeoutMs: 20, retryMs: 2 }),
      /等待文件锁超时/,
    );
    assert.equal(readFileSync(file, "utf8"), "original");
    rmSync(`${file}.lock`, { recursive: true });

    withFileLockSync(
      file,
      () => {
        assert.throws(
          () => withFileLockSync(file, () => writeFileSync(file, "changed"), { timeoutMs: 20 }),
          /不能重入文件锁/,
        );
        assert.equal(readFileSync(file, "utf8"), "original");
      },
      { timeoutMs: 100 },
    );
    assert.throws(
      () =>
        withFileLockSync(file, () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(
      withFileLockSync(file, () => "released"),
      "released",
    );
  });

  test("foreign host 锁即使过期也不抢占，释放竞争不会删除新 owner", () => {
    const foreign = join(root, "locks", "foreign.json");
    writeFileSync(foreign, "original");
    mkdirSync(`${foreign}.lock`);
    writeFileSync(
      join(`${foreign}.lock`, "owner.json"),
      JSON.stringify({ pid: 123, host: "other-host.invalid", token: "foreign" }),
    );
    const old = Date.now() / 1000 - 60;
    utimesSync(`${foreign}.lock`, old, old);
    assert.throws(
      () =>
        withFileLockSync(foreign, () => writeFileSync(foreign, "changed"), { staleMs: 10, timeoutMs: 20, retryMs: 2 }),
      /等待文件锁超时/,
    );
    assert.equal(readFileSync(foreign, "utf8"), "original");
    assert.equal(JSON.parse(readFileSync(join(`${foreign}.lock`, "owner.json"), "utf8")).token, "foreign");
    rmSync(`${foreign}.lock`, { recursive: true });

    const swapped = join(root, "locks", "swapped.json");
    const displaced = `${swapped}.old-owner`;
    withFileLockSync(swapped, () => {
      renameSync(`${swapped}.lock`, displaced);
      mkdirSync(`${swapped}.lock`);
      writeFileSync(
        join(`${swapped}.lock`, "owner.json"),
        JSON.stringify({ pid: process.pid, host: hostname(), token: "new-owner" }),
      );
    });
    assert.equal(JSON.parse(readFileSync(join(`${swapped}.lock`, "owner.json"), "utf8")).token, "new-owner");
    rmSync(`${swapped}.lock`, { recursive: true });
    rmSync(displaced, { recursive: true });
  });
});

describe("proposeWorkspaceMemory dedupe", () => {
  test("同时检查 memory 与 pending，并只返回安全匹配元数据", () => {
    const base = join(root, "propose-dedupe");
    const cwd = join(base, "project");
    const tenant = { id: "propose-dedupe", stateDir: join(root, "state-propose-dedupe"), workspaceRoot: base };
    mkdirSync(cwd, { recursive: true });
    appendMemoryLines(cwd, [{ section: "命令", text: "构建前运行 npm run test", id: "safe-id", refs: [] }]);
    const duplicate = proposeWorkspaceMemory(
      tenant,
      { chatId: "c1", cwd, section: "命令", text: "构建前运行：NPM   RUN TEST。" },
      { confirm: true },
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.matchedId, "safe-id");
    assert.equal(duplicate.matchKind, "normalized_exact");
    assert.equal("text" in duplicate, false);

    assert.equal(
      proposeWorkspaceMemory(
        tenant,
        { chatId: "c1", cwd, section: "坑", text: "队列中较长的唯一故障处理方式需要保留", refs: "" },
        { confirm: true },
      ).ok,
      true,
    );
    const pending = proposeWorkspaceMemory(
      tenant,
      { chatId: "c2", cwd, section: "坑", text: "队列中较长的唯一故障处理方式需要保留。" },
      { confirm: true },
    );
    assert.equal(pending.duplicate, true);
    assert.match(pending.matchedId || "", /^wm_/);

    const noIdDir = join(base, "no-id");
    mkdirSync(noIdDir);
    appendMemoryLines(noIdDir, [{ section: "约定", text: "没有稳定编号的人工记忆条目", refs: [] }]);
    const noId = proposeWorkspaceMemory(
      tenant,
      { chatId: "c3", cwd: noIdDir, section: "约定", text: "没有稳定编号的人工记忆条目。" },
      { confirm: true },
    );
    assert.equal(noId.duplicate, true);
    assert.equal(noId.matchedId, undefined);
  });
});

describe("workspace memory symlink boundary", () => {
  test(".jiebo、memory、gitignore、lock 任一 symlink 都拒绝且外部字节不变", () => {
    const base = join(root, "symlink-scope");
    const tenant = { id: "symlink-scope", stateDir: join(root, "state-symlink-scope"), workspaceRoot: base };
    const external = join(root, "symlink-external");
    mkdirSync(external, { recursive: true });

    const jieboLinkDir = join(base, "jiebo-link");
    mkdirSync(jieboLinkDir, { recursive: true });
    const externalMemory = join(external, "memory.md");
    writeFileSync(externalMemory, "EXTERNAL-JIEBO");
    symlinkSync(external, join(jieboLinkDir, ".jiebo"));
    assert.throws(() => appendMemoryLines(jieboLinkDir, [{ section: "约定", text: "不能写", refs: [] }]), /符号链接/);
    assert.equal(renderMemoryFile(jieboLinkDir, 200, "", base), "");
    assert.equal(readFileSync(externalMemory, "utf8"), "EXTERNAL-JIEBO");

    const memoryLinkDir = join(base, "memory-link");
    mkdirSync(join(memoryLinkDir, ".jiebo"), { recursive: true });
    const externalLine = join(external, "memory-target.md");
    writeFileSync(externalLine, "## 约定\n- 外部内容 <!-- id=outside -->\n");
    symlinkSync(externalLine, join(memoryLinkDir, ".jiebo/memory.md"));
    assert.throws(
      () => appendMemoryLines(memoryLinkDir, [{ section: "约定", text: "不能替换", refs: [] }]),
      /符号链接/,
    );
    assert.equal(renderMemoryFile(memoryLinkDir, 200, "外部内容", base), "");
    assert.deepEqual(searchWorkspaceMemory(tenant, memoryLinkDir, "外部内容"), []);
    assert.equal(markWorkspaceMemoryUsed(tenant, memoryLinkDir, "outside").ok, false);
    assert.equal(readFileSync(externalLine, "utf8"), "## 约定\n- 外部内容 <!-- id=outside -->\n");

    const ignoreLinkDir = join(base, "ignore-link");
    mkdirSync(join(ignoreLinkDir, ".jiebo"), { recursive: true });
    const externalIgnore = join(external, "ignore-target");
    writeFileSync(externalIgnore, "KEEP-IGNORE");
    symlinkSync(externalIgnore, join(ignoreLinkDir, ".jiebo/.gitignore"));
    assert.throws(
      () => appendMemoryLines(ignoreLinkDir, [{ section: "约定", text: "不能写 ignore", refs: [] }]),
      /符号链接/,
    );
    assert.equal(renderMemoryFile(ignoreLinkDir, 200, "", base), "");
    assert.equal(readFileSync(externalIgnore, "utf8"), "KEEP-IGNORE");

    const lockLinkDir = join(base, "lock-link");
    mkdirSync(join(lockLinkDir, ".jiebo"), { recursive: true });
    const externalLock = join(external, "lock-target");
    writeFileSync(externalLock, "KEEP-LOCK");
    symlinkSync(externalLock, join(lockLinkDir, ".jiebo/.memory.md.lock"));
    assert.throws(() => appendMemoryLines(lockLinkDir, [{ section: "约定", text: "不能锁", refs: [] }]), /符号链接/);
    assert.equal(renderMemoryFile(lockLinkDir, 200, "", base), "");
    assert.equal(readFileSync(externalLock, "utf8"), "KEEP-LOCK");
  });
});

test("restoreCards 清理遗留 transient 与 processing 标记", () => {
  const stateDir = join(root, "state-restore-transient");
  const ref = { id: "restore-transient", stateDir };
  const store = join(stateDir, "assistant", "workspace-memory.json");
  mkdirSync(resolve(store, ".."), { recursive: true });
  writeFileSync(
    store,
    JSON.stringify({
      proposals: [
        {
          id: "transient",
          kind: "workspace",
          chatId: "chat",
          dir: "project",
          section: "约定",
          text: "崩溃占位",
          refs: [],
          createdAt: Date.now(),
          transient: true,
        },
        {
          id: "queued",
          kind: "workspace",
          chatId: "chat",
          dir: "project",
          section: "约定",
          text: "正常排队",
          refs: [],
          createdAt: Date.now(),
          cardId: "card",
        },
      ],
      cards: [
        {
          callId: "card",
          chatId: "chat",
          tool: "workspace_memory",
          summary: "test",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          processingToken: "crashed",
          processingAt: Date.now(),
        },
      ],
    }),
  );
  restoreCards(ref);
  const restored = listProposals(ref);
  assert.equal(
    restored.proposals.some((item) => item.transient),
    false,
  );
  assert.equal(restored.cards[0].processingToken, undefined);
});

function memoryFixture(name: string, text: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, ".jiebo"), { recursive: true });
  writeFileSync(join(dir, ".jiebo/memory.md"), text);
  return dir;
}

describe("renderMemoryFile", () => {
  test("skip reasons 超过 40 条时 skippedReasonsTruncated", () => {
    const lines = ["## 约定", ...Array.from({ length: 55 }, (_, i) => `- 冷 ${i} <!-- state=cold -->`)].join("\n");
    const dir = memoryFixture("many-cold-skips", lines);
    const plan = planMemoryInjection(dir, 80, "");
    assert.ok(plan);
    assert.equal(plan!.diagnostics.skippedReasonsTruncated, true);
    assert.ok((plan!.diagnostics.skippedReasons?.length ?? 0) <= 40);
    assert.ok((plan!.diagnostics.coldUnrelatedSkipped ?? 0) >= 55);
  });

  test("planMemoryInjection 与 render 诊断字段一致（空 query）", () => {
    const dir = memoryFixture("diag-empty-query", ["## 约定", "- 条目一", "- 条目二"].join("\n"));
    const budget = 200;
    const plan = planMemoryInjection(dir, budget, "");
    const rendered = renderMemoryFile(dir, budget, "");
    assert.ok(plan);
    for (const key of ["总数", "纳入", "因预算跳过", "hot命中", "cold召回", "pinned命中"] as const) {
      const field =
        key === "总数"
          ? plan!.diagnostics.total
          : key === "纳入"
            ? plan!.diagnostics.selected
            : key === "因预算跳过"
              ? plan!.diagnostics.skippedBudget
              : key === "hot命中"
                ? plan!.diagnostics.hotSelected
                : key === "cold召回"
                  ? plan!.diagnostics.coldRecalled
                  : plan!.diagnostics.pinnedSelected;
      assert.match(rendered, new RegExp(`${key}=${field}`));
    }
  });

  test("文件后部的 pinned 会越过早期条目，且仍受预算约束", () => {
    const dir = memoryFixture(
      "pinned-priority",
      ["## 约定", "- 早期普通条目一", "- 早期普通条目二", "- 后部人工置顶 <!-- pinned=1 -->"].join("\n"),
    );
    const budget = estimateTokens("- 后部人工置顶");
    const rendered = renderMemoryFile(dir, budget);
    assert.match(rendered, /后部人工置顶/);
    assert.doesNotMatch(rendered, /早期普通条目/);
    assert.match(
      rendered,
      /总数=3 纳入=1 因预算跳过=2 hot命中=1 cold召回=0 done或expired跳过=0 pinned命中=1 相关命中=0/,
    );
  });

  test("query 相关的后部条目会越过不相关的早期条目", () => {
    const dir = memoryFixture(
      "relevant-priority",
      ["## 决定", "- 早期无关内容", "- 仍然无关内容", "- 登录缓存使用 Redis"].join("\n"),
    );
    const rendered = renderMemoryFile(dir, estimateTokens("- 登录缓存使用 Redis"), "登录缓存");
    assert.match(rendered, /登录缓存使用 Redis/);
    assert.doesNotMatch(rendered, /早期无关|仍然无关/);
    assert.match(rendered, /pinned命中=0 相关命中=1/);
  });

  test("无 query 时按 section 轮转，并在各 section 内优先较新条目", () => {
    const dir = memoryFixture(
      "diverse-newest",
      [
        "## 约定",
        "- 约定旧条目 <!-- at=2026-01-01 -->",
        "- 约定新条目 <!-- at=2026-10-01 -->",
        "## 命令",
        "- 命令旧条目 <!-- at=2026-01-01 -->",
        "- 命令新条目 <!-- at=2026-10-01 -->",
      ].join("\n"),
    );
    const budget = estimateTokens("- 约定新条目") + estimateTokens("- 命令新条目");
    const rendered = renderMemoryFile(dir, budget);
    assert.match(rendered, /约定新条目/);
    assert.match(rendered, /命令新条目/);
    assert.doesNotMatch(rendered, /旧条目/);
    const itemTokens = rendered
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .reduce((sum, line) => sum + estimateTokens(line), 0);
    assert.ok(itemTokens <= budget);
    assert.match(rendered, /总数=4 纳入=2 因预算跳过=0 hot命中=2 cold召回=0/);
  });

  test("诊断允许 pinned 与相关命中重叠，但不泄露 query 原文", () => {
    const query = "private-query-marker";
    const dir = memoryFixture(
      "diagnostics",
      ["## 坑", `- 命中 private-query-marker <!-- pinned=1 -->`, "- 普通条目"].join("\n"),
    );
    const rendered = renderMemoryFile(dir, 100, query);
    assert.match(
      rendered,
      /总数=2 纳入=2 因预算跳过=0 hot命中=2 cold召回=0 done或expired跳过=0 pinned命中=1 相关命中=1 选择策略=/,
    );
    assert.equal(rendered.split(query).length - 1, 1, "query 只应出现在记忆正文，不应由诊断重复泄露");
  });

  test("cold 只在 query 相关时召回，done/expired 永不常驻", () => {
    const dir = memoryFixture(
      "lifecycle-render",
      [
        "## 约定",
        "- 热条目",
        "- 冷门 Redis 缓存约定 <!-- state=cold -->",
        "- 已完成 Redis 迁移 <!-- state=done -->",
        "- 已过期 Redis 临时方案 <!-- expires=2020-01-01 -->",
      ].join("\n"),
    );
    const normal = renderMemoryFile(dir, 200);
    assert.match(normal, /热条目/);
    assert.doesNotMatch(normal, /冷门|已完成|已过期/);
    assert.doesNotMatch(renderMemoryFile(dir, 200, "Redis"), /冷门 Redis 缓存约定/);
    const queried = renderMemoryFile(dir, 200, "Redis 缓存");
    assert.match(queried, /冷门 Redis 缓存约定/);
    assert.doesNotMatch(queried, /已完成 Redis|已过期 Redis/);
    assert.match(queried, /cold召回=1 done或expired跳过=2/);
  });

  test("真实长 query 不挤掉分区 anchor，普通词不召回 cold", () => {
    const dir = memoryFixture(
      "section-anchors",
      [
        "## 约定",
        "- 登录缓存统一使用 Redis 集群",
        "- 登录缓存键使用租户前缀",
        "## 命令",
        "- 发布前运行 npm run check",
        "## 坑",
        "- 连接池耗尽时不要直接重启数据库",
        "## runbook",
        "- 告警后先查看网关和数据库指标",
        "## 决定",
        "- 认证令牌采用短期访问令牌",
        "## 进行中",
        "- 正在迁移旧版登录接口",
        "## 冷藏",
        "- 修改工作规则文件之前先测试一下这个流程 <!-- state=cold -->",
      ].join("\n"),
    );
    const query = "请帮我修改一下这个项目之前的登录缓存规则文件，然后测试 Redis 相关工作是否正常";
    const rendered = renderMemoryFile(dir, 600, query);
    for (const expected of ["约定：", "命令：", "坑：", "runbook：", "决定：", "进行中："]) {
      assert.match(rendered, new RegExp(expected));
    }
    assert.doesNotMatch(rendered, /修改工作规则文件之前先测试一下这个流程/);
  });
});

describe("workspace memory lifecycle and retrieval", () => {
  test("effective lifecycle 保持旧人工行 hot，并遵循日期、使用、pinned 与终态优先级", () => {
    const day = "2026-10-18";
    assert.equal(effectiveMemoryState({ section: "约定", text: "旧人工", refs: [] }, day), "hot");
    assert.equal(effectiveMemoryState({ section: "约定", text: "旧日期", refs: [], at: "2026-01-01" }, day), "cold");
    assert.equal(
      effectiveMemoryState(
        { section: "约定", text: "近期两次用", refs: [], state: "cold", used: "2026-10-01", uses: 2 },
        day,
      ),
      "hot",
    );
    assert.equal(
      effectiveMemoryState(
        { section: "约定", text: "近期两次用", refs: [], state: "cold", used: "2026-10-01", uses: 2 },
        "2026-12-01",
      ),
      "cold",
    );
    assert.equal(
      effectiveMemoryState({ section: "约定", text: "陈旧两次用", refs: [], used: "2020-01-01", uses: 2 }, day),
      "cold",
    );
    assert.equal(
      effectiveMemoryState({ section: "约定", text: "陈旧显式热", refs: [], state: "hot", at: "2020-01-01" }, day),
      "cold",
    );
    assert.equal(
      effectiveMemoryState({ section: "约定", text: "置顶", refs: [], pinned: true, at: "2020-01-01" }, day),
      "hot",
    );
    assert.equal(
      effectiveMemoryState({ section: "约定", text: "完成置顶", refs: [], pinned: true, state: "done" }, day),
      "done",
    );
    assert.equal(
      effectiveMemoryState({ section: "约定", text: "过期置顶", refs: [], pinned: true, expires: "2026-10-01" }, day),
      "expired",
    );
  });

  test("search 仅查 cwd 祖先链，含终态且本身不更新 uses", () => {
    const base = join(root, "scope");
    const tenant = { id: "scope", stateDir: join(root, "state-scope"), workspaceRoot: base };
    const cwd = resolve(base, "project", "repo");
    mkdirSync(resolve(cwd, ".jiebo"), { recursive: true });
    mkdirSync(resolve(base, "project", ".jiebo"), { recursive: true });
    mkdirSync(resolve(base, ".jiebo"), { recursive: true });
    mkdirSync(resolve(base, "sibling", ".jiebo"), { recursive: true });
    writeFileSync(resolve(base, ".jiebo/memory.md"), "## 约定\n- Redis USER 根内容 <!-- id=user-root -->\n");
    writeFileSync(
      resolve(base, "project", ".jiebo/memory.md"),
      "## 决定\n- Redis 父层决定 <!-- id=parent state=done uses=3 -->\n",
    );
    writeFileSync(
      resolve(cwd, ".jiebo/memory.md"),
      "## 坑\n- Redis 当前层坑 <!-- id=child state=cold uses=0 refs=missing.ts -->\n",
    );
    writeFileSync(resolve(base, "sibling", ".jiebo/memory.md"), "## 约定\n- Redis 兄弟秘密 <!-- id=sibling -->\n");
    const hits = searchWorkspaceMemory(tenant, cwd, "Redis");
    assert.deepEqual(
      hits.map((hit) => hit.id),
      ["child", "parent"],
    );
    assert.equal(hits[0].effectiveState, "cold");
    assert.deepEqual(hits[0].missingRefs, ["missing.ts"]);
    assert.equal(hits[1].effectiveState, "done");
    assert.match(readFileSync(resolve(cwd, ".jiebo/memory.md"), "utf8"), /uses=0/);
    assert.deepEqual(searchWorkspaceMemory(tenant, resolve(base, "sibling"), "当前层"), []);
  });

  test("mark_used 定点更新并保留未知 meta、人工注释、顺序，两次后 cold 晋升", () => {
    const base = join(root, "mark");
    const tenant = { id: "mark", stateDir: join(root, "state-mark"), workspaceRoot: base };
    const cwd = resolve(base, "project");
    mkdirSync(resolve(cwd, ".jiebo"), { recursive: true });
    const path = resolve(cwd, ".jiebo/memory.md");
    writeFileSync(
      path,
      [
        "# 人工标题",
        "## 约定",
        "- 前一条",
        "- 要采用 <!-- owner=alice id=stable state=cold uses=0 note=人工 -->",
        "<!-- 文件尾注释 -->",
        "",
      ].join("\n"),
    );
    assert.deepEqual(markWorkspaceMemoryUsed(tenant, cwd, "stable", "2026-10-18"), {
      ok: true,
      id: "stable",
      used: "2026-10-18",
      uses: 1,
    });
    const once = readFileSync(path, "utf8");
    assert.match(once, /owner=alice id=stable state=cold uses=1 note=人工 used=2026-10-18/);
    assert.match(once, /^# 人工标题[\s\S]*<!-- 文件尾注释 -->\n$/);
    assert.equal(searchWorkspaceMemory(tenant, cwd, "采用")[0].uses, 1);
    assert.deepEqual(markWorkspaceMemoryUsed(tenant, cwd, "stable", "2026-10-18"), {
      ok: true,
      id: "stable",
      used: "2026-10-18",
      uses: 2,
    });
    assert.equal(searchWorkspaceMemory(tenant, cwd, "采用")[0].effectiveState, "hot");
    assert.equal(markWorkspaceMemoryUsed(tenant, cwd, "missing").ok, false);
  });
});
