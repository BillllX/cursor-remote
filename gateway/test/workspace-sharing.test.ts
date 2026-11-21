import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
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
import { applySharedWorkspaceChanges, askSharedWorkspace, sharedHistoryForClient } from "../src/workspace/shareAsk.ts";
import { sharedHistory, saveSharedTurn } from "../src/workspace/shareHistory.ts";
import { manageSharedWorkspace } from "../src/workspace/shareManage.ts";
import { WorkspaceSharing, workspaceSharingSupported } from "../src/workspace/sharing.ts";
import type { SharedWorkspace, WorkspaceShareRequest } from "../../shared/workspaceShare.ts";

function fixture(t: import("node:test").TestContext, suffix = "") {
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
    member = account("editor" + suffix, "王琳"),
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

test("旧试点台账保留原样，新共享名单使用独立文件", linuxOnly, (t) => {
  const f = fixture(t);
  const oldLedger = join(f.root, "workspace-sharing.json");
  const oldContent = JSON.stringify({ version: 1, workspaces: { demo: { members: [f.other.id] } }, invitations: [] });
  writeFileSync(oldLedger, oldContent);

  assert.deepEqual(f.list(f.other), []);
  f.share([f.member.id]);
  assert.equal(f.list(f.member).length, 1);
  assert.deepEqual(f.list(f.other), []);
  assert.equal(readFileSync(oldLedger, "utf8"), oldContent);
  assert.equal(JSON.parse(readFileSync(join(f.root, "workspace-share-grants.json"), "utf8")).length, 1);
});

test("兼容早期新版共享数组，撤权写回原台账", linuxOnly, (t) => {
  const f = fixture(t);
  f.share([f.member.id]);
  const current = join(f.root, "workspace-share-grants.json");
  const previous = join(f.root, "workspace-sharing.json");
  renameSync(current, previous);

  assert.equal(f.list(f.member).length, 1);
  f.share([]);
  assert.deepEqual(f.list(f.member), []);
  assert.deepEqual(JSON.parse(readFileSync(previous, "utf8")), []);
});

test("共享 Agent 只用授权资料回答，并返回实际读取的来源", linuxOnly, async (t) => {
  const f = fixture(t);
  f.share([f.member.id]);
  const [workspace] = f.list(f.member);
  const req = {
    type: "workspace_share",
    requestId: randomUUID(),
    action: "ask",
    workspace: workspace!.id,
    question: "继续看记录",
    history: [{ question: "先找记录", answer: "找到了" }],
  } as const;
  saveSharedTurn(f.service, f.member, workspace!.id, {
    id: "previous",
    createdAt: Date.now(),
    question: "先找记录",
    answer: "找到了",
    sources: [],
  });
  const deps: NonNullable<Parameters<typeof askSharedWorkspace>[4]> = {
    apiKey: () => "fixture",
    models: async () => ["fixture-model"],
    prompt: async (text, options) => {
      assert.match(text, /先找记录/);
      assert.deepEqual(options.tools, ["mcp"]);
      assert.deepEqual(options.local?.settingSources, []);
      assert.notEqual(options.local?.cwd, f.workspace);
      const tools = options.local?.customTools;
      assert.ok(tools);
      assert.deepEqual(Object.keys(tools).sort(), ["find_shared_files", "list_shared_files", "read_shared_file"]);
      const search = await tools.find_shared_files!.execute({ keyword: "记录" }, {});
      assert.deepEqual(search, { matches: ["资料/记录.txt"], truncated: false });
      const read = tools.read_shared_file!;
      assert.deepEqual(await read.execute({ path: "资料/记录.txt" }, {}), {
        path: "资料/记录.txt",
        content: "原内容",
        more: false,
      });
      assert.match(JSON.stringify(await read.execute({ path: "../private.txt" }, {})), /无法访问/);
      return { id: "run", status: "finished", result: "记录里的原内容" };
    },
  };
  const signal = new AbortController().signal;
  const request = { ...req, history: [...req.history] };
  await assert.rejects(askSharedWorkspace(f.service, f.hidden, request, signal, deps), /不可访问/);
  assert.deepEqual(await askSharedWorkspace(f.service, f.member, request, signal, deps), {
    answer: "记录里的原内容",
    sources: ["资料/记录.txt"],
  });
  assert.equal(f.owner.disk.chats.length, 0);
});

test("共享 Agent 问答期间撤权会阻止后续读取和答案返回", linuxOnly, async (t) => {
  const f = fixture(t);
  f.share([f.other.id]);
  const [workspace] = f.list(f.other);
  await assert.rejects(
    askSharedWorkspace(
      f.service,
      f.other,
      {
        type: "workspace_share",
        requestId: randomUUID(),
        action: "ask",
        workspace: workspace!.id,
        question: "查一下记录",
      },
      new AbortController().signal,
      {
        apiKey: () => "fixture",
        models: async () => ["fixture-model"],
        prompt: async (_text, options) => {
          f.share([]);
          const result = await options.local?.customTools?.read_shared_file?.execute({ path: "资料/记录.txt" }, {});
          assert.match(JSON.stringify(result), /无法访问/);
          return { id: "run", status: "finished", result: "答案不能返回" };
        },
      },
    ),
    /不可访问/,
  );
});

test("共享 Agent 批准后写入原文件并新建文件，拒绝重复确认和其他成员确认", linuxOnly, async (t) => {
  const f = fixture(t, "-approval");
  f.share([f.member.id, f.other.id]);
  const workspace = f.list(f.member)[0]!.id;
  const req = {
    type: "workspace_share",
    requestId: randomUUID(),
    action: "ask",
    workspace,
    question: "更新记录并新建目录及文件",
    confirmWrites: true,
  } as const;
  const answer = await askSharedWorkspace(f.service, f.member, req, new AbortController().signal, {
    apiKey: () => "fixture",
    models: async () => ["fixture-model"],
    prompt: async (_text, options) => {
      const tools = options.local!.customTools!;
      const read = tools.read_shared_file!;
      const change = tools.change_shared_file!;
      assert.match(
        JSON.stringify(await change.execute({ kind: "write", path: "资料/记录.txt", content: "不能盲改" }, {})),
        /无法访问/,
      );
      await read.execute({ path: "资料/记录.txt" }, {});
      assert.match(
        JSON.stringify(await change.execute({ kind: "write", path: "资料/记录.txt", content: "新版" }, {})),
        /planned/,
      );
      assert.match(JSON.stringify(await change.execute({ kind: "mkdir", path: "交付" }, {})), /planned/);
      assert.match(
        JSON.stringify(await change.execute({ kind: "create", path: "交付/说明.md", content: "说明" }, {})),
        /planned/,
      );
      assert.match(
        JSON.stringify(await change.execute({ kind: "create", path: "../越界.md", content: "不要写" }, {})),
        /无法访问/,
      );
      return { id: "run", status: "finished", result: "已准备三项修改" };
    },
  });
  const file = join(f.workspace, "资料", "记录.txt");
  assert.equal(readFileSync(file, "utf8"), "原内容");
  const apply = { ...req, action: "apply" as const, changeId: answer.pending!.id };
  assert.throws(() => applySharedWorkspaceChanges(f.service, f.other, apply), /失效/);
  assert.deepEqual(applySharedWorkspaceChanges(f.service, f.member, apply), {
    applied: ["资料/记录.txt", "交付", "交付/说明.md"],
    failed: [],
  });
  assert.equal(readFileSync(file, "utf8"), "新版");
  assert.equal(readFileSync(join(f.workspace, "交付", "说明.md"), "utf8"), "说明");
  assert.throws(() => applySharedWorkspaceChanges(f.service, f.member, apply), /失效/);
});

test("共享 Agent 直写也保留并发保存的最新版本", linuxOnly, async (t) => {
  const f = fixture(t, "-direct");
  f.share([f.member.id]);
  const workspace = f.list(f.member)[0]!.id;
  const file = join(f.workspace, "资料", "记录.txt");
  const answer = await askSharedWorkspace(
    f.service,
    f.member,
    {
      type: "workspace_share",
      requestId: randomUUID(),
      action: "ask",
      workspace,
      question: "修改记录",
      confirmWrites: false,
    },
    new AbortController().signal,
    {
      apiKey: () => "fixture",
      models: async () => ["fixture-model"],
      prompt: async (_text, options) => {
        const tools = options.local!.customTools!;
        await tools.read_shared_file!.execute({ path: "资料/记录.txt" }, {});
        await tools.change_shared_file!.execute({ kind: "write", path: "资料/记录.txt", content: "旧版基准" }, {});
        writeFileSync(file, "同事的新保存");
        return { id: "run", status: "finished", result: "已准备修改" };
      },
    },
  );
  assert.deepEqual(answer.changes?.applied, []);
  assert.match(answer.changes!.failed[0]!.error, /已被修改/);
  assert.equal(readFileSync(file, "utf8"), "同事的新保存");
});

test("已有共享成员继续上传与读取，管理规则必须由所有者单独授权", linuxOnly, (t) => {
  const f = fixture(t, "-manage");
  f.share([f.member.id, f.other.id]);
  const workspace = f.list(f.member)[0]!.id;
  writeFileSync(join(f.workspace, "AGENTS.md"), "本工作区规则");
  writeFileSync(join(f.owner.workspaceRoot, "AGENTS.md"), "所有者根目录规则");
  const data = Buffer.from([0, 255, 7, 1]);
  f.service.uploadSharedFile(f.member, workspace, "资料/原件.zip", data);
  const fd = f.service.openSharedFile(f.member, workspace, "资料/原件.zip");
  try {
    assert.deepEqual(readFileSync(fd), data);
  } finally {
    closeSync(fd);
  }
  assert.throws(
    () => f.service.uploadSharedFile(f.member, workspace, "资料/原件.zip", Buffer.from("overwrite")),
    /已存在/,
  );
  assert.throws(() => f.service.uploadSharedFile(f.member, workspace, "../越界文件", data), /路径无效/);
  const memoryView: WorkspaceShareRequest = {
    type: "workspace_share",
    requestId: randomUUID(),
    action: "manage",
    workspace,
    section: "memory",
    operation: "list",
  };
  assert.throws(() => manageSharedWorkspace(f.service, f.member, memoryView), /所有者授予/);
  const previous = f.people().memberRevision;
  const fields = { workspace: f.workspace, memberIds: [f.member.id, f.other.id], memberRevision: previous };
  assert.throws(() => f.call(f.owner, "set", { ...fields, managerIds: ["unshared"] }), /只有获共享/);
  f.call(f.owner, "set", { ...fields, managerIds: [f.member.id] });
  assert.equal(f.list(f.member)[0]!.canManage, true);
  assert.equal(f.list(f.other)[0]!.canManage, undefined);
  assert.deepEqual(manageSharedWorkspace(f.service, f.member, memoryView), { rules: "本工作区规则", memory: "" });
  assert.throws(() => manageSharedWorkspace(f.service, f.other, memoryView), /所有者授予/);
  assert.throws(() => f.call(f.owner, "set", fields), /名单已更新/);
  // 旧版客户端更新普通成员时保留已有管理员，直到撤回其共享。
  f.share([f.member.id]);
  assert.equal(f.list(f.member)[0]!.canManage, true);
  f.share([]);
  assert.throws(() => manageSharedWorkspace(f.service, f.member, memoryView), /不可访问/);
  assert.throws(() => f.service.openSharedFile(f.member, workspace, "资料/原件.zip"), /不可访问/);
});

test("共享记录按成员隔离、落盘可恢复，撤权后拒绝历史访问", linuxOnly, (t) => {
  const f = fixture(t, "-history");
  f.share([f.member.id, f.other.id]);
  const workspace = f.list(f.member)[0]!.id;
  const turn = {
    id: "turn-1",
    createdAt: Date.now(),
    question: "我的问题",
    answer: "## 标题\n\n| 指标 | 值 |\n| --- | --- |\n| A | 1 |",
    sources: ["资料/记录.txt"],
  };
  saveSharedTurn(f.service, f.member, workspace, turn);
  saveSharedTurn(f.service, f.member, workspace, turn);
  const reloaded = new WorkspaceSharing(f.root, f.tenantList);
  assert.deepEqual(sharedHistory(reloaded, f.member, workspace), [turn]);
  assert.deepEqual(sharedHistory(reloaded, f.other, workspace), []);
  f.share([]);
  assert.throws(() => sharedHistory(reloaded, f.member, workspace), /不可访问/);
});

test("已有共享记录进入默认会话，分页和新会话各自隔离", linuxOnly, (t) => {
  const f = fixture(t, "-page");
  f.share([f.member.id]);
  const workspace = f.list(f.member)[0]!.id;
  const threadId = randomUUID();
  for (let index = 0; index < 33; index++) {
    saveSharedTurn(f.service, f.member, workspace, {
      id: `legacy-${index}`,
      createdAt: index,
      question: `原问题 ${index}`,
      answer: "原回答",
      sources: [],
    });
  }
  saveSharedTurn(f.service, f.member, workspace, {
    id: "new-turn",
    threadId,
    createdAt: 35,
    question: "另一个话题",
    answer: "新回答",
    sources: [],
  });
  const first = sharedHistoryForClient(f.service, f.member, workspace);
  assert.equal(first.turns[0]?.id, "legacy-3");
  assert.equal(first.hasMore, true);
  assert.ok(first.threads.some((row) => row.id === threadId));
  const older = sharedHistoryForClient(f.service, f.member, workspace, first.turns[0]?.id);
  assert.deepEqual(
    older.turns.map((row) => row.id),
    ["legacy-0", "legacy-1", "legacy-2"],
  );
  assert.equal(older.hasMore, false);
  assert.deepEqual(
    sharedHistoryForClient(f.service, f.member, workspace, undefined, threadId).turns.map((row) => row.id),
    ["new-turn"],
  );
});

test("共享流在撤权后不再发送正文", linuxOnly, async (t) => {
  const f = fixture(t, "-stream");
  f.share([f.member.id]);
  const workspace = f.list(f.member)[0]!.id;
  const visible: string[] = [];
  await assert.rejects(
    askSharedWorkspace(
      f.service,
      f.member,
      {
        type: "workspace_share",
        action: "ask",
        requestId: randomUUID(),
        workspace,
        question: "继续",
      },
      new AbortController().signal,
      {
        apiKey: () => "fixture",
        models: async () => ["fixture-model"],
        prompt: async (_text, _options, _signal, progress) => {
          progress?.({ kind: "text", text: "撤权前" });
          f.share([]);
          progress?.({ kind: "text", text: "撤权后" });
          return { id: "fixture", status: "finished", result: "不可返回" };
        },
      },
      (event) => {
        if (event.kind === "text") visible.push(event.text);
      },
    ),
    /不可访问/,
  );
  assert.deepEqual(visible, ["撤权前"]);
});
