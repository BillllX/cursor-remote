import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import * as service from "../src/assistant/service.ts";
import { saveMemory } from "../src/assistant/memory.ts";
import {
  MAX_MEMORY_FILE_BYTES,
  MAX_RESPONSE_JSON_BYTES,
  MAX_SEARCH_HITS,
  discoverScopesForTest,
  memoryCenterGet,
  memoryCenterSearch,
  setScopeFileReaderForTest,
} from "../src/assistant/memoryCenter.ts";
import * as scopedRead from "../src/assistant/scopedRead.ts";
import { scopedReadPlatformAllowed, scopedReadSupported } from "../src/assistant/scopedRead.ts";
import { planMemoryInjection, renderMemoryFile } from "../src/assistant/workspaceMemory.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mcenter-"));
after(() => rmSync(root, { recursive: true, force: true }));

const SENTINEL = "MC_SYMLINK_LEAK_SENTINEL_9f3c2a1b";

function tenant(id: string, workspaceRoot: string) {
  const stateDir = join(root, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  return { id, stateDir, workspaceRoot: resolve(workspaceRoot) };
}

function memoryFixture(base: string, rel: string, text: string) {
  const dir = join(base, rel);
  mkdirSync(join(dir, ".jiebo"), { recursive: true });
  writeFileSync(join(dir, ".jiebo/memory.md"), text);
  return dir;
}

describe("memory center security", () => {
  test("Linux 才启用安全读取", () => {
    assert.equal(scopedReadPlatformAllowed("darwin"), false);
    if (process.platform === "linux") assert.equal(scopedReadSupported(), true);
  });

  test(".jiebo / .cursor 中间链接不可读 memory", () => {
    if (process.platform !== "linux") return;
    const base = join(root, "mid");
    const outside = join(root, "mid-out");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "memory.md"), SENTINEL);
    const ws = join(base, "ws");
    mkdirSync(ws, { recursive: true });
    symlinkSync(outside, join(ws, ".jiebo"));
    const t = tenant("mid", base);
    const detail = memoryCenterGet(t, ["ws"], "ws");
    const blob = JSON.stringify(detail);
    assert.doesNotMatch(blob, new RegExp(SENTINEL));
    assert.equal(detail.mode, "detail");
    if (detail.mode !== "detail") return;
    assert.match(detail.detail.scope.error ?? "", /符号链接|不安全|路径/);
  });

  test("AGENTS / rules 目录 / memory 链接不泄露哨兵", () => {
    const base = join(root, "symlink-all");
    const outside = join(root, "symlink-outside");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), SENTINEL);
    writeFileSync(join(outside, "AGENTS.md"), SENTINEL);
    const ws = join(base, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    symlinkSync(join(outside, "AGENTS.md"), join(ws, "AGENTS.md"));
    mkdirSync(join(ws, ".cursor"), { recursive: true });
    symlinkSync(outside, join(ws, ".cursor/rules"));
    symlinkSync(join(outside, "secret.md"), join(ws, ".jiebo/memory.md"));
    const t = tenant("symlink-all", base);
    const detail = memoryCenterGet(t, ["ws"], "ws");
    const search = memoryCenterSearch(t, ["ws"], { query: "SENTINEL" });
    const blob = JSON.stringify(detail) + JSON.stringify(search.ok ? search.data : "");
    assert.doesNotMatch(blob, new RegExp(SENTINEL));
    assert.equal(detail.mode, "detail");
    if (detail.mode === "detail") {
      assert.match(detail.detail.scope.error ?? "", /符号链接|不安全|无法/);
    }
  });

  test("scope 内链接到 USER 根外部不泄露", () => {
    const base = join(root, "scope-escape");
    const outside = join(root, "scope-escape-out");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "AGENTS.md"), SENTINEL);
    const ws = join(base, "host");
    mkdirSync(join(ws, ".jiebo"), { recursive: true });
    writeFileSync(join(ws, ".jiebo/memory.md"), "## 约定\n- ok");
    symlinkSync(outside, join(ws, "escape-link"));
    const t = tenant("scope-escape", base);
    const overview = memoryCenterGet(t, ["host"]);
    const blob = JSON.stringify(overview);
    assert.doesNotMatch(blob, new RegExp(SENTINEL));
  });
});

describe("memory center caps", () => {
  test("1.1MB memory 文件标记超限且局部降级", () => {
    const base = join(root, "big-mem");
    mkdirSync(base, { recursive: true });
    const t = tenant("big-mem", base);
    const dir = join(base, "heavy");
    mkdirSync(join(dir, ".jiebo"), { recursive: true });
    const body = `- ${"大".repeat(200)}\n`.repeat(Math.ceil((1.1 * 1024 * 1024) / 400));
    writeFileSync(join(dir, ".jiebo/memory.md"), `## 约定\n${body}`);
    const detail = memoryCenterGet(t, ["heavy"], "heavy");
    assert.equal(detail.mode, "detail");
    if (detail.mode !== "detail") return;
    assert.match(detail.detail.scope.error ?? "", new RegExp(`${MAX_MEMORY_FILE_BYTES}|超过`));
    const good = memoryCenterGet(t, ["heavy"], "personal");
    assert.equal(good.mode, "detail");
  });

  test("超大规则与最终 JSON bytes cap", () => {
    const base = join(root, "big-rules");
    mkdirSync(base, { recursive: true });
    const t = tenant("big-rules", base);
    const dir = join(base, "rules");
    mkdirSync(join(dir, ".jiebo"), { recursive: true });
    writeFileSync(join(dir, ".jiebo/memory.md"), "## 约定\n- x");
    writeFileSync(join(dir, "AGENTS.md"), "A".repeat(20_000));
    mkdirSync(join(dir, ".cursor/rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor/rules/a.md"), "B".repeat(20_000));
    writeFileSync(join(dir, ".cursor/rules/b.md"), "C".repeat(20_000));
    const detail = memoryCenterGet(t, ["rules"], "rules");
    const bytes = Buffer.byteLength(JSON.stringify(detail), "utf8");
    assert.ok(bytes <= MAX_RESPONSE_JSON_BYTES);
    assert.equal(detail.mode, "detail");
    if (detail.mode !== "detail") return;
    assert.ok(detail.detail.rules.every((rule) => rule.body.length <= 8_000));
  });

  test("坏 UTF-8 memory 给出明确 error", () => {
    const base = join(root, "bad-utf8");
    mkdirSync(base, { recursive: true });
    const t = tenant("bad-utf8", base);
    const dir = join(base, "broken");
    mkdirSync(join(dir, ".jiebo"), { recursive: true });
    writeFileSync(join(dir, ".jiebo/memory.md"), Buffer.from([0xff, 0xfe, 0xfd]));
    const detail = memoryCenterGet(t, ["broken"], "broken");
    assert.equal(detail.mode, "detail");
    if (detail.mode !== "detail") return;
    assert.match(detail.detail.scope.error ?? "", /UTF-8/);
    const okScope = memoryCenterGet(t, ["broken"], "personal");
    assert.equal(okScope.mode, "detail");
  });

  test("EACCES 时 scope degraded 且 personal 仍正常", () => {
    if (process.platform !== "linux") return;
    const base = join(root, "eacces-mc");
    mkdirSync(base, { recursive: true });
    const t = tenant("eacces-mc", base);
    memoryFixture(base, "deny", "## 约定\n- a");
    setScopeFileReaderForTest((scopeDir: string, rel: string, maxBytes: number) => {
      if (rel.includes("memory.md")) {
        return { ok: false as const, code: "eacces", message: "没有读取权限。" };
      }
      return scopedRead.readFileAtScope(scopeDir, rel, maxBytes);
    });
    try {
      const detail = memoryCenterGet(t, ["deny"], "deny");
      assert.equal(detail.mode, "detail");
      if (detail.mode !== "detail") return;
      assert.equal(detail.detail.scope.health, "degraded");
      assert.match(detail.detail.scope.error ?? "", /权限/);
      const personal = memoryCenterGet(t, ["deny"], "personal");
      assert.equal(personal.mode, "detail");
    } finally {
      setScopeFileReaderForTest(null);
    }
  });

  test("visit 上限后哨兵 scope 不可发现", () => {
    const base = join(root, "visit-cap");
    mkdirSync(base, { recursive: true });
    const t = tenant("visit-cap", base);
    const ws = join(base, "wide");
    mkdirSync(ws, { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      mkdirSync(join(ws, `d${i}`));
    }
    memoryFixture(base, "wide/sentinel-scope", `## 约定\n- ${SENTINEL}`);
    writeFileSync(join(ws, "sentinel-scope", "AGENTS.md"), "# x");
    const discovered = discoverScopesForTest(t, ["wide"], { maxVisitedDirs: 4, maxVisitedPerWorkspace: 4 });
    const ids = [...discovered.scopes.keys()];
    assert.ok(!ids.includes("wide/sentinel-scope"));
    assert.equal(discovered.truncated, true);
  });

  test("宽浅无信号树仍消耗 visit 并 truncated", () => {
    const base = join(root, "no-signal");
    mkdirSync(base, { recursive: true });
    const t = tenant("no-signal", base);
    const ws = join(base, "flat");
    mkdirSync(ws, { recursive: true });
    for (let i = 0; i < 30; i += 1) mkdirSync(join(ws, `empty${i}`));
    const discovered = discoverScopesForTest(t, ["flat"], { maxVisitedDirs: 8, maxVisitedPerWorkspace: 8 });
    assert.equal(discovered.truncated, true);
  });
});

describe("memory center search", () => {
  test("31+ 混合来源全局 truncated", () => {
    const base = join(root, "mix-search");
    mkdirSync(base, { recursive: true });
    const t = tenant("mix-search", base);
    const ref = { id: t.id, stateDir: t.stateDir };
    for (let i = 0; i < 15; i += 1) {
      saveMemory(ref, { topic: "偏好", text: `personal-alpha-${i}`, basis: "user_said" }, "page");
    }
    const corePath = join(t.stateDir, "assistant", "memory", "core.json");
    mkdirSync(join(t.stateDir, "assistant", "memory"), { recursive: true });
    writeFileSync(
      corePath,
      JSON.stringify({
        rev: 1,
        fields: {
          关于我: "",
          偏好: "",
          近况: "",
          人物: "",
          工作偏好: Array.from({ length: 12 }, (_, i) => `- wp-alpha-${i}`).join("\n"),
        },
      }),
    );
    const lines = Array.from({ length: 20 }, (_, i) => `- ws-alpha-${i}`).join("\n");
    memoryFixture(base, "many", `## 约定\n${lines}`);
    const result = memoryCenterSearch(t, ["many"], { query: "alpha" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.hits.length, MAX_SEARCH_HITS);
    assert.equal(result.data.truncated, true);
    const kinds = new Set(result.data.hits.map((hit) => hit.kind));
    assert.ok(kinds.size >= 2);
  });
});

describe("memory center diagnostics", () => {
  test(">40 skip reasons 时 truncated 为 true 且 render 数字一致", () => {
    const dir = memoryFixture(
      root,
      "many-skips",
      ["## 约定", ...Array.from({ length: 50 }, (_, i) => `- 冷条目 ${i} <!-- state=cold -->`), "- 热条目"].join("\n"),
    );
    const plan = planMemoryInjection(dir, 50, "热条目");
    assert.ok(plan);
    assert.equal(plan!.diagnostics.skippedReasonsTruncated, true);
    assert.ok((plan!.diagnostics.coldUnrelatedSkipped ?? 0) >= 40);
    const rendered = renderMemoryFile(dir, 50, "热条目");
    assert.match(rendered, new RegExp(`done或expired跳过=${plan!.diagnostics.terminalSkipped}`));
    assert.match(rendered, new RegExp(`因预算跳过=${plan!.diagnostics.skippedBudget}`));
  });
});

describe("memory center protocol", () => {
  test("overview 与两层树", () => {
    const base = join(root, "ov2");
    mkdirSync(base, { recursive: true });
    const t = tenant("ov2", base);
    memoryFixture(base, "alpha", ["## 约定", "- alpha"].join("\n"));
    memoryFixture(base, "alpha/pkg", ["## 坑", "- pkg"].join("\n"));
    writeFileSync(join(base, "alpha/pkg/AGENTS.md"), "# p");
    const data = memoryCenterGet(t, ["alpha"]);
    assert.equal(data.mode, "overview");
    if (data.mode !== "overview") return;
    assert.ok(data.overview.scopes.some((row) => row.id === "alpha/pkg"));
  });

  test("搜索 reasons 为稳定 code", () => {
    const base = join(root, "search-code");
    mkdirSync(base, { recursive: true });
    const t = tenant("search-code", base);
    memoryFixture(base, "sc", "## 命令\n- 部署 Redis <!-- id=wm_sc1 from=user at=2026-01-01 -->");
    const hit = memoryCenterSearch(t, ["sc"], { query: "Redis" });
    assert.equal(hit.ok, true);
    if (!hit.ok) return;
    assert.ok(hit.data.hits[0]?.reasons.includes("text"));
    assert.equal(hit.data.hits[0]?.reasons.some((r) => r.includes("匹配")), false);
  });

  test("assistant op typed 返回", async () => {
    const base = join(root, "op2");
    mkdirSync(base, { recursive: true });
    const t = tenant("op2", base);
    service.startAssistant({
      tenants: () => [{ ...t, name: "测试" }],
      publish: () => {},
      globalStateDir: join(root, "global"),
      delegate: async () => "",
      workspaces: () => ["op2"],
      createWorkspace: async () => "",
      appUrl: () => "https://example/",
    });
    memoryFixture(base, "op2", ["## 约定", "- op"].join("\n"));
    const got = await service.handleOp({ ...t, name: "测试" }, "memory_center_get", {});
    assert.equal(got.ok, true);
    assert.equal((got.data as { mode: string }).mode, "overview");
  });
});
