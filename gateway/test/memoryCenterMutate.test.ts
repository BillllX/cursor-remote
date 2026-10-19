import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import * as service from "../src/assistant/service.ts";
import { memoryLineRevision } from "../src/assistant/memoryRevision.ts";
import { assertBytePreservationExceptLines, parseMemoryFileLines } from "../src/assistant/memoryFileEdit.ts";
import { memoryCenterGet } from "../src/assistant/memoryCenter.ts";
import { memoryCenterMutate, parseMemoryCenterMutateArgs } from "../src/assistant/memoryCenterMutate.ts";
import { parseMemoryFile } from "../src/assistant/workspaceMemory.ts";

const root = mkdtempSync(join(tmpdir(), "cr-mcm-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tenant(id: string, workspaceRoot: string) {
  const stateDir = join(root, `state-${id}`);
  mkdirSync(stateDir, { recursive: true });
  return { id, name: id, stateDir, workspaceRoot };
}

function seedMemory(base: string, rel: string, body: string) {
  const dir = join(base, rel, ".jiebo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.md"), body);
}

describe("memory_center_mutate", () => {
  test("parse args 判别联合", () => {
    assert.equal(parseMemoryCenterMutateArgs({ scope: "ws", mutation: { action: "create", section: "约定", text: "x" } }).ok, true);
    assert.equal(parseMemoryCenterMutateArgs({ scope: "", mutation: { action: "create", section: "约定", text: "x" } }).ok, false);
  });

  test("仅有 memory.md 的 .gitignore 在 mutate 后补 audit 与 lock", () => {
    const base = join(root, "mc-ignore-md");
    const jiebo = join(base, "ws", ".jiebo");
    mkdirSync(jiebo, { recursive: true });
    writeFileSync(join(jiebo, "memory.md"), "# 工作区记忆\n## 约定\n");
    writeFileSync(join(jiebo, ".gitignore"), "memory.md\n");
    const t = tenant("mc-ignore-md", base);
    const created = memoryCenterMutate(t, ["ws"], {
      scope: "ws",
      mutation: { action: "create", section: "约定", text: "补 ignore" },
    });
    assert.equal(created.ok, true);
    assert.equal(
      readFileSync(join(jiebo, ".gitignore"), "utf8"),
      "memory.md\nmemory-audit.jsonl\n.memory.md.lock/\n",
    );
  });

  test("create / update / conflict / delete 与保真注释", async () => {
    const base = join(root, "mut");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "ws",
      [
        "# 工作区记忆",
        "<!-- 人工头注释 -->",
        "## 约定",
        "- 旧条目 <!-- id=wm_old from=user at=2026-01-01 -->",
        "## 坑",
        "- 保留 <!-- id=wm_keep custom=1 at=2026-01-02 -->",
      ].join("\n"),
    );
    const t = tenant("mut", base);
    const workspaces = ["ws"];

    const created = memoryCenterMutate(t, workspaces, {
      scope: "ws",
      mutation: { action: "create", section: "命令", text: "新命令记忆", refs: ["src/a.ts"] },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.data.action, "create");
    assert.ok(created.data.item?.id);

    const fileAfterCreate = readFileSync(join(base, "ws", ".jiebo", "memory.md"), "utf8");
    assert.match(fileAfterCreate, /人工头注释/);
    assert.match(fileAfterCreate, /wm_keep/);
    assert.match(fileAfterCreate, /custom=1/);

    const id = created.data.item!.id!;
    const rev = created.data.item!.revision;
    const updated = memoryCenterMutate(t, workspaces, {
      scope: "ws",
      mutation: { action: "update", id, revision: rev, patch: { text: "新命令记忆（改）" } },
    });
    assert.equal(updated.ok, true);

    const stale = memoryCenterMutate(t, workspaces, {
      scope: "ws",
      mutation: { action: "update", id, revision: rev, patch: { text: "不应写入" } },
    });
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.code, "conflict");
    assert.ok(stale.detail);

    const lines = parseMemoryFile(readFileSync(join(base, "ws", ".jiebo", "memory.md"), "utf8"));
    const line = lines.find((row) => row.id === id)!;
    const del = memoryCenterMutate(t, workspaces, {
      scope: "ws",
      mutation: { action: "delete", id, revision: memoryLineRevision(line) },
    });
    assert.equal(del.ok, true);
    assert.equal(del.data.deletedId, id);
  });

  test("保真：除目标行外字节结构不变", () => {
    const base = join(root, "fid");
    mkdirSync(base, { recursive: true });
    const before = ["# 头", "", "## 约定", "- keep", "", "## 坑", "- touch <!-- id=wm_t1 from=user at=2026-01-01 -->"].join("\n") + "\n";
    seedMemory(base, "wsf", before);
    const t = tenant("fid", base);
    const lines = parseMemoryFile("## 坑\n- touch <!-- id=wm_t1 from=user at=2026-01-01 -->");
    const id = lines[0].id!;
    const rev = memoryLineRevision(lines[0]);
    const updated = memoryCenterMutate(t, ["wsf"], {
      scope: "wsf",
      mutation: { action: "update", id, revision: rev, patch: { text: "touch2" } },
    });
    assert.equal(updated.ok, true);
    const after = readFileSync(join(base, "wsf", ".jiebo", "memory.md"), "utf8");
    const rowIdx = parseMemoryFileLines(before).lines.findIndex((l) => l.includes("wm_t1"));
    assert.ok(rowIdx >= 0);
    assertBytePreservationExceptLines(before, after, [rowIdx], new Map([[rowIdx, parseMemoryFileLines(after).lines[rowIdx]!]]));
  });

  test("personal scope 与 pinned+done 拒绝", () => {
    const base = join(root, "pin");
    mkdirSync(base, { recursive: true });
    seedMemory(
      base,
      "ws2",
      "## 约定\n- x <!-- id=wm_p1 pinned=1 state=hot from=user at=2026-01-01 -->",
    );
    const t = tenant("pin", base);
    const lines = parseMemoryFile(readFileSync(join(base, "ws2", ".jiebo", "memory.md"), "utf8"));
    const id = lines[0].id!;
    const rev = memoryLineRevision(lines[0]);
    const bad = memoryCenterMutate(t, ["ws2"], {
      scope: "ws2",
      mutation: { action: "set_state", id, revision: rev, state: "done" },
    });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.code, "invalid_input");

    const personal = memoryCenterMutate(t, ["ws2"], {
      scope: "personal",
      mutation: { action: "create", section: "约定", text: "nope" },
    });
    assert.equal(personal.ok, false);
    if (personal.ok) return;
    assert.equal(personal.code, "invalid_scope");
  });

  test("CRLF：两次 create、update 后 detail/get 与磁盘条目一致", () => {
    const base = join(root, "crlf");
    mkdirSync(base, { recursive: true });
    const crlfBody = ["# 头", "## 约定", "- seed <!-- id=wm_seed from=user at=2026-01-01 -->"].join("\r\n") + "\r\n";
    seedMemory(base, "crlfws", crlfBody);
    const t = tenant("crlf", base);
    const ws = ["crlfws"];
    assert.equal(parseMemoryFile(readFileSync(join(base, "crlfws", ".jiebo", "memory.md"), "utf8")).length, 1);

    const c1 = memoryCenterMutate(t, ws, {
      scope: "crlfws",
      mutation: { action: "create", section: "命令", text: "first" },
    });
    assert.equal(c1.ok, true);
    if (!c1.ok) return;
    assert.equal(c1.data.detail.items.length, 2);

    const c2 = memoryCenterMutate(t, ws, {
      scope: "crlfws",
      mutation: { action: "create", section: "坑", text: "second" },
    });
    assert.equal(c2.ok, true);
    if (!c2.ok) return;
    assert.equal(c2.data.detail.items.length, 3);
    const ids = new Set(c2.data.detail.items.map((row) => row.id));
    assert.equal(ids.size, 3);

    const newId = c2.data.item!.id!;
    const rev = c2.data.item!.revision;
    const upd = memoryCenterMutate(t, ws, {
      scope: "crlfws",
      mutation: { action: "update", id: newId, revision: rev, patch: { text: "second-edited" } },
    });
    assert.equal(upd.ok, true);
    if (!upd.ok) return;
    assert.equal(upd.data.detail.items.length, 3);
    assert.ok(upd.data.detail.items.some((row) => row.text === "second-edited"));

    const got = memoryCenterGet(t, ws, "crlfws");
    assert.equal(got.mode, "detail");
    if (got.mode !== "detail") return;
    assert.equal(got.detail.items.length, parseMemoryFile(readFileSync(join(base, "crlfws", ".jiebo", "memory.md"), "utf8")).length);
    for (const row of got.detail.items) {
      assert.ok(ids.has(row.id) || row.id === "wm_seed");
    }
    const disk = readFileSync(join(base, "crlfws", ".jiebo", "memory.md"), "utf8");
    assert.match(disk, /\r\n/);
  });

  test("handleOp 接入", async () => {
    const base = join(root, "hop");
    mkdirSync(base, { recursive: true });
    seedMemory(base, "hopws", "## 约定\n- t <!-- id=wm_h1 from=user at=2026-01-01 -->");
    const t = tenant("hop", base);
    service.startAssistant({
      tenants: () => [{ ...t, name: "测试" }],
      publish: () => {},
      globalStateDir: join(root, "global-hop"),
      delegate: async () => "",
      workspaces: () => ["hopws"],
      createWorkspace: async () => "",
      appUrl: () => "https://example/",
    });
    const r = await service.handleOp({ ...t, name: "测试" }, "memory_center_mutate", {
      scope: "hopws",
      mutation: { action: "create", section: "约定", text: "via op" },
    });
    assert.equal(r.ok, true);
  });
});
