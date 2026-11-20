import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBodyStore } from "../src/chatBodies.ts";
import { emptyDisk, type Tenant } from "../src/tenants.ts";
import { migrateWorkspaceAgent, removeWorkspaceAgent } from "../src/workspace/agents.ts";
import { WorkspaceSharing, workspaceSharingSupported } from "../src/workspace/sharing.ts";
import type { SharedWorkspace, WorkspaceShareRequest } from "../../shared/workspaceShare.ts";

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workspace-share-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function account(id: string, name: string, imHidden = false): Tenant {
    const stateDir = join(root, id),
      workspaceRoot = join(stateDir, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    return {
      id,
      name,
      imHidden,
      stateDir,
      workspaceRoot,
      stateFile: join(stateDir, "state.json"),
      tokenHash: Buffer.alloc(32),
      admin: false,
      sandbox: true,
      disk: emptyDisk(),
      bodies: createBodyStore(stateDir, (turns) => turns),
    };
  }
  const owner = account("owner", "刘青"),
    member = account("editor", "王琳"),
    other = account("other", "王琳"),
    hidden = account("hidden", "隐藏", true);
  const tenantList = () => [owner, member, other, hidden];
  const service = new WorkspaceSharing(root, tenantList);
  const workspace = join(owner.workspaceRoot, "月度汇报");
  mkdirSync(join(workspace, "资料"), { recursive: true });
  writeFileSync(join(workspace, "资料", "记录.txt"), "原内容");
  function call<T>(
    actor: Tenant,
    action: WorkspaceShareRequest["action"],
    args: Partial<WorkspaceShareRequest> = {},
  ): T {
    return service.handle(actor, { ...args, type: "workspace_share", requestId: randomUUID(), action }) as T;
  }
  const list = (actor: Tenant) => call<{ items: SharedWorkspace[] }>(actor, "list").items;
  const people = () =>
    call<{ people: { id: string; name: string }[]; memberRevision: string }>(owner, "people", { workspace });
  const share = (memberIds: string[]) =>
    call(owner, "set", { workspace, memberIds, memberRevision: people().memberRevision });
  return { root, owner, member, other, hidden, workspace, service, tenantList, call, list, people, share };
}

const linuxOnly = { skip: !workspaceSharingSupported() };

test("按名字选人即时共享原目录，同名账号不会串权，撤销后拒绝读写", linuxOnly, (t) => {
  const f = fixture(t);
  assert.deepEqual(f.people().people, [
    { id: "editor", name: "王琳" },
    { id: "other", name: "王琳" },
  ]);
  assert.deepEqual(f.list(f.member), []);
  f.share([f.member.id]);
  const [row] = f.list(f.member);
  assert.deepEqual(row, { id: row.id, name: "月度汇报", ownerName: "刘青" });
  assert.deepEqual(f.list(f.other), []);
  assert.deepEqual(f.list(f.hidden), []);
  assert.throws(() => f.call(f.other, "read", { workspace: row.id, path: "资料/记录.txt" }), /不可访问/);
  const { content, revision } = f.call<{ content: string; revision: string }>(f.member, "read", {
    workspace: row.id,
    path: "资料/记录.txt",
  });
  assert.equal(content, "原内容");
  f.call(f.member, "write", { workspace: row.id, path: "资料/记录.txt", revision, content: "编辑者更新" });
  assert.equal(readFileSync(join(f.workspace, "资料", "记录.txt"), "utf8"), "编辑者更新");
  assert.throws(
    () => f.service.saveOwnedFile(f.owner, f.workspace, "资料/记录.txt", "所有者旧草稿", revision),
    /已被修改/,
  );
  const latest = f.call<{ revision: string }>(f.member, "read", { workspace: row.id, path: "资料/记录.txt" });
  assert.ok(f.service.saveOwnedFile(f.owner, f.workspace, "资料/记录.txt", "所有者更新", latest.revision));
  assert.throws(
    () =>
      f.call(f.member, "write", {
        workspace: row.id,
        path: "资料/记录.txt",
        revision: latest.revision,
        content: "编辑者旧草稿",
      }),
    /已被修改/,
  );
  f.share([]);
  assert.deepEqual(f.list(f.member), []);
  assert.throws(() => f.call(f.member, "read", { workspace: row.id, path: "资料/记录.txt" }), /不可访问/);
  assert.throws(
    () => f.call(f.member, "write", { workspace: row.id, path: "资料/记录.txt", revision, content: "撤权后修改" }),
    /不可访问/,
  );
  assert.equal(readFileSync(join(f.workspace, "资料", "记录.txt"), "utf8"), "所有者更新");
});

test("改名保留共享关系，卸下旧目录后同名新目录不会继承授权", linuxOnly, (t) => {
  const f = fixture(t);
  f.share([f.member.id]);
  const [previous] = f.list(f.member);
  const renamed = join(f.owner.workspaceRoot, "新名字");
  renameSync(f.workspace, renamed);
  migrateWorkspaceAgent(f.owner, "月度汇报", "新名字", renamed);
  assert.deepEqual(f.list(f.member), [{ ...previous, name: "新名字" }]);
  removeWorkspaceAgent(f.owner, "新名字");
  renameSync(renamed, join(f.root, "moved"));
  mkdirSync(renamed);
  assert.deepEqual(f.list(f.member), []);
  assert.throws(() => f.call(f.member, "files", { workspace: previous.id, path: "" }), /不可访问/);
});

test("共享范围排除个人根目录、隐藏文件、软硬链接，旧成员名单不能覆盖最新授权", linuxOnly, (t) => {
  const f = fixture(t);
  const stale = f.people().memberRevision;
  assert.throws(() => f.call(f.owner, "people", { workspace: f.owner.workspaceRoot }), /不可访问/);
  assert.throws(
    () => f.call(f.owner, "set", { workspace: f.workspace, memberIds: [f.hidden.id], memberRevision: stale }),
    /不可用/,
  );
  f.share([f.member.id]);
  assert.throws(
    () => f.call(f.owner, "set", { workspace: f.workspace, memberIds: [f.other.id], memberRevision: stale }),
    /名单已更新/,
  );
  const [row] = f.list(f.member);
  const privateFile = join(f.owner.workspaceRoot, "private.txt");
  writeFileSync(privateFile, "个人文件");
  writeFileSync(join(f.workspace, ".env"), "配置");
  symlinkSync(privateFile, join(f.workspace, "link.txt"));
  linkSync(privateFile, join(f.workspace, "hard.txt"));
  const files = f.call<{ items: { name: string }[] }>(f.member, "files", { workspace: row.id, path: "" });
  assert.deepEqual(
    files.items.map((e) => e.name),
    ["资料", "hard.txt"],
  );
  for (const path of ["../private.txt", ".env", "link.txt", "hard.txt"]) {
    assert.throws(() => f.call(f.member, "read", { workspace: row.id, path }));
  }
});
