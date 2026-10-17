import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { TurnFile } from "../../shared/protocol.ts";
import { createDelegation } from "../src/assistant/delegations.ts";
import { createBodyStore } from "../src/chatBodies.ts";
import { attachDelegatedFiles, mergeTurnFiles } from "../src/delegationFiles.ts";
import { gatewayState } from "../src/runtime/state.ts";
import type { Slot } from "../src/runtime/types.ts";
import { emptyDisk, saveDiskNow, type Tenant } from "../src/tenants.ts";

const roots: string[] = [];

afterEach(() => {
  gatewayState.conns.clear();
  gatewayState.liveByTenant.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tenant(): Tenant {
  const root = mkdtempSync(join(tmpdir(), "delegated-files-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const stateDir = join(root, "state");
  mkdirSync(workspaceRoot);
  mkdirSync(stateDir);
  return {
    id: "tenant-a",
    name: "tenant-a",
    tokenHash: Buffer.alloc(32),
    admin: false,
    sandbox: false,
    workspaceRoot,
    stateDir,
    stateFile: join(stateDir, "state.json"),
    disk: emptyDisk(),
    bodies: createBodyStore(stateDir, (turns) => turns),
  };
}

const childFiles: TurnFile[] = [{ path: "result.md", kind: "markdown", op: "added", sha: "a".repeat(64) }];

describe("委派子文件回填父 turn", () => {
  test("按 sourceChatId/sourceTurnId/path 幂等，并保留父回合自己的文件", () => {
    const local: TurnFile = { path: "local.md", kind: "markdown", op: "modified" };
    const delegated = { ...childFiles[0], sourceChatId: "child", sourceTurnId: "child-turn" };
    assert.deepEqual(mergeTurnFiles([local, delegated], [delegated]), [local, delegated]);
    assert.equal(mergeTurnFiles([local], [delegated, delegated]).length, 2);
  });

  test("父回合与委派文件合并后仍限制为 40 项", () => {
    const base = Array.from({ length: 30 }, (_, index) => ({
      path: `parent-${index}.md`,
      kind: "markdown" as const,
      op: "modified" as const,
    }));
    const incoming = Array.from({ length: 30 }, (_, index) => ({
      path: `child-${index}.md`,
      kind: "markdown" as const,
      op: "added" as const,
      sourceChatId: "child",
      sourceTurnId: "child-turn",
    }));
    const merged = mergeTurnFiles(base, incoming);
    assert.equal(merged.length, 40);
    assert.equal(merged.filter((file) => file.sourceChatId === "child").length, 30);
  });

  test("首次落父 turn 推进 chatRev，重复完成不再改盘", () => {
    const t = tenant();
    t.disk.chats = [
      {
        id: "parent",
        title: "父会话",
        cwd: t.workspaceRoot,
        turns: [{ id: "parent-turn", user: "委派", assistant: "处理中", files: [] }],
      },
    ];
    createDelegation(t, {
      parentChatId: "parent",
      parentTurnId: "parent-turn",
      childChatId: "child",
      workspace: "demo",
      title: "任务",
      task: "生成结果",
      mode: "foreground",
    });
    const child = { chatId: "child", delegationId: "child" } as Slot;
    const first = attachDelegatedFiles(t, child, "child-turn", childFiles);
    assert.equal(first?.files[0].sourceChatId, "child");
    assert.equal(first?.files[0].sourceTurnId, "child-turn");
    const rev = t.disk.rev;
    assert.equal(t.disk.chatRevs.parent, rev);
    assert.equal(attachDelegatedFiles(t, child, "child-turn", childFiles), null);
    assert.equal(t.disk.rev, rev);
    saveDiskNow(t);
  });
});
