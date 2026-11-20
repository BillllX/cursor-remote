import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ProjectAction, type ProjectRole, type ProjectSummary } from "../../shared/projectTypes.ts";
import { ProjectStore } from "../src/projects/store/main.ts";
import { ProjectExecutor, type ProjectModelProfile } from "../src/projects/executor.ts";
import type { Adapter, ModelTurn, ToolCall } from "../src/native/types.ts";

type Member = { tenantId: string; role: ProjectRole; revision: number };

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "cr-project-functional-"));
  let now = Date.UTC(2026, 10, 16);
  const store = new ProjectStore(directory, () => now);
  const accounts = ["owner", "admin", "editor", "viewer", "outsider", "other-domain"].map((id) => ({
    id,
    sharingEnabled: true,
    sharingDomain: id === "other-domain" ? "isolated" : "functional-test",
    sandboxVerified: true,
  }));
  store.setAccounts(accounts);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function request<T = Record<string, unknown>>(
    actor: string,
    action: ProjectAction,
    payload: Record<string, unknown> = {},
    workspaceId?: string,
  ): T {
    return store.request(actor, {
      type: "project_request",
      protocol: 1,
      requestId: randomUUID(),
      action,
      payload,
      ...(workspaceId ? { workspaceId } : {}),
    }) as T;
  }
  function mutate<T = Record<string, unknown>>(
    actor: string,
    action: ProjectAction,
    payload: Record<string, unknown> = {},
    workspaceId?: string,
  ): T {
    return request<T>(actor, action, { operationId: randomUUID(), ...payload }, workspaceId);
  }
  const project = mutate<ProjectSummary>("owner", "project_create", { title: "隔离共享项目功能测试" });
  function joinProject(actor: string, role: Exclude<ProjectRole, "owner">) {
    const invitation = mutate<{ inviteId: string }>(
      "owner",
      "project_invite",
      { targetTenantId: actor, role },
      project.workspaceId,
    );
    return mutate(actor, "project_invite_accept", { inviteId: invitation.inviteId });
  }
  const members = () => request<{ items: Member[] }>("owner", "project_members", {}, project.workspaceId).items;
  return {
    directory,
    store,
    accounts,
    project,
    request,
    mutate,
    joinProject,
    members,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function denied(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof Error && "code" in error && error.code === code);
}

function turn(toolCalls: ToolCall[] = [], text = ""): ModelTurn {
  return { text, reasoning: "", reasoningInline: false, toolCalls, usage: { inputTokens: 10, outputTokens: 10 } };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: randomUUID(), name, arguments: JSON.stringify(args) };
}

function execution(f: ReturnType<typeof fixture>, adapter: Adapter, budget = 1000000) {
  const profiles: ProjectModelProfile[] = [
    {
      id: "native:fixture",
      providerId: "fixture",
      budgetBoundVerified: true,
      inputByteMicros: 1,
      outputTokenMicros: 1,
      endpoint: {
        id: "fixture",
        name: "隔离注入适配器",
        baseURL: "https://invalid.invalid",
        apiKey: "fixture-unused",
        model: "fixture",
        adapter: "openai",
        vision: false,
        echoReasoning: false,
        cache: false,
      },
    },
  ];
  const executor = new ProjectExecutor(f.store, profiles, adapter);
  f.mutate(
    "owner",
    "project_config_set",
    {
      expectedConfigRevision: 0,
      patch: {
        dailyBudgetMicros: budget,
        maxRunCostMicros: budget,
        allowedModelIds: ["native:fixture"],
        approvedProviderIds: ["fixture"],
      },
    },
    f.project.workspaceId,
  );
  const chat = f.mutate<{ chatId: string }>(
    "owner",
    "project_chat_create",
    { title: "项目工具循环" },
    f.project.workspaceId,
  );
  const enqueue = () =>
    f.mutate<{ runId: string }>(
      "owner",
      "project_message_send",
      { chatId: chat.chatId, text: "生成修改提案", runAgent: true, modelId: "native:fixture" },
      f.project.workspaceId,
    );
  const status = (runId: string) =>
    f.store.one<{ status: string }>("SELECT status FROM runs WHERE id=?", runId)?.status;
  return { executor, chat, enqueue, status };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "等待项目任务状态超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("共享项目：双账号邀请需接受，非目标账号和不同共享域不能取得访问权", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  const invitation = f.mutate<{ inviteId: string }>(
    "owner",
    "project_invite",
    { targetTenantId: "editor", role: "editor" },
    id,
  );
  denied(() => f.request("editor", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
  assert.equal(
    f.request<{ items: { inviteId: string }[] }>("editor", "project_inbox").items[0]?.inviteId,
    invitation.inviteId,
  );
  denied(() => f.mutate("outsider", "project_invite_accept", { inviteId: invitation.inviteId }), "NOT_ACCESSIBLE");
  f.mutate("editor", "project_invite_accept", { inviteId: invitation.inviteId });
  assert.equal(f.members().find((member) => member.tenantId === "editor")?.role, "editor");
  assert.equal(f.request<{ items: unknown[] }>("editor", "project_inbox").items.length, 0);
  denied(
    () => f.mutate("owner", "project_invite", { targetTenantId: "other-domain", role: "viewer" }, id),
    "NOT_ACCESSIBLE",
  );
});

test("共享项目：四角色管理权限，成员版本冲突和撤权立即生效", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  f.joinProject("admin", "admin");
  f.joinProject("editor", "editor");
  f.joinProject("viewer", "viewer");
  assert.deepEqual(
    f
      .members()
      .map((m) => m.role)
      .sort(),
    ["admin", "editor", "owner", "viewer"],
  );
  for (const actor of ["editor", "viewer"])
    denied(() => f.mutate(actor, "project_invite", { targetTenantId: "outsider", role: "viewer" }, id), "FORBIDDEN");
  denied(() => f.mutate("admin", "project_invite", { targetTenantId: "outsider", role: "admin" }, id), "FORBIDDEN");
  const editor = f.members().find((m) => m.tenantId === "editor")!;
  denied(
    () =>
      f.mutate(
        "owner",
        "project_member_set",
        { targetTenantId: "editor", role: "viewer", expectedMemberRevision: editor.revision + 1 },
        id,
      ),
    "CONFLICT",
  );
  f.mutate(
    "admin",
    "project_member_set",
    { targetTenantId: "editor", role: "viewer", expectedMemberRevision: editor.revision },
    id,
  );
  const changed = f.members().find((m) => m.tenantId === "editor")!;
  assert.equal(changed.role, "viewer");
  f.mutate(
    "admin",
    "project_member_remove",
    { targetTenantId: "editor", expectedMemberRevision: changed.revision },
    id,
  );
  denied(() => f.request("editor", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
  denied(() => f.mutate("owner", "project_leave", {}, id), "FORBIDDEN");
});

test("共享项目：操作幂等重试保持结果，换载荷复用 operationId 拒绝", (t) => {
  const f = fixture(t);
  const payload = { operationId: randomUUID(), title: "仅创建一次" };
  const first = f.request<ProjectSummary>("owner", "project_create", payload);
  assert.deepEqual(f.request("owner", "project_create", payload), first);
  denied(() => f.request("owner", "project_create", { ...payload, title: "改变载荷" }), "IDEMPOTENCY_MISMATCH");
  assert.equal(
    f
      .request<{ items: ProjectSummary[] }>("owner", "project_list")
      .items.filter((p) => p.workspaceId === first.workspaceId).length,
    1,
  );
});

test("共享项目：过期邀请和取消邀请不能接受", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  const expired = f.mutate<{ inviteId: string }>(
    "owner",
    "project_invite",
    { targetTenantId: "editor", role: "editor" },
    id,
  );
  f.advance(86400001);
  denied(() => f.mutate("editor", "project_invite_accept", { inviteId: expired.inviteId }), "INVITE_EXPIRED");
  const revoked = f.mutate<{ inviteId: string }>(
    "owner",
    "project_invite",
    { targetTenantId: "viewer", role: "viewer" },
    id,
  );
  f.mutate("owner", "project_invite_revoke", { inviteId: revoked.inviteId }, id);
  denied(() => f.mutate("viewer", "project_invite_accept", { inviteId: revoked.inviteId }), "NOT_ACCESSIBLE");
});

test("共享项目：租户关闭共享后既有成员访问也被撤销", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  f.joinProject("editor", "editor");
  f.store.setAccounts(f.accounts.map((account) => ({ ...account, sharingEnabled: account.id !== "editor" })));
  denied(() => f.request("editor", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
});

test("共享项目：跨账号上传提交可见、旧版本提交冲突、上传身份和保护路径隔离", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  f.joinProject("editor", "editor");
  f.joinProject("viewer", "viewer");
  const upload = f.store.stageUpload("editor", id, Buffer.from("共享文件第一版\n"));
  denied(
    () =>
      f.mutate(
        "viewer",
        "project_commit",
        { expectedRevision: 0, changes: [{ kind: "put", path: "hello.txt", uploadId: upload.uploadId }] },
        id,
      ),
    "FORBIDDEN",
  );
  denied(
    () =>
      f.mutate(
        "owner",
        "project_commit",
        { expectedRevision: 0, changes: [{ kind: "put", path: "hello.txt", uploadId: upload.uploadId }] },
        id,
      ),
    "NOT_ACCESSIBLE",
  );
  const payload = {
    operationId: randomUUID(),
    expectedRevision: 0,
    changes: [{ kind: "put", path: "hello.txt", uploadId: upload.uploadId }],
  };
  const committed = f.request("editor", "project_commit", payload, id);
  assert.deepEqual(f.request("editor", "project_commit", payload, id), committed);
  const read = f.request<{ text: string; revision: number }>("viewer", "project_file_read", { path: "hello.txt" }, id);
  assert.equal(read.text, "共享文件第一版\n");
  assert.equal(read.revision, 1);
  const second = f.store.stageUpload("owner", id, Buffer.from("第二版"));
  denied(
    () =>
      f.mutate(
        "owner",
        "project_commit",
        { expectedRevision: 0, changes: [{ kind: "put", path: "hello.txt", uploadId: second.uploadId }] },
        id,
      ),
    "CONFLICT",
  );
  assert.equal(f.request<{ text: string }>("editor", "project_file_read", { path: "hello.txt" }, id).text, read.text);
  for (const path of ["AGENTS.md", ".cursor/settings.json", "../escape"]) {
    denied(
      () =>
        f.mutate(
          "owner",
          "project_commit",
          { expectedRevision: 1, changes: [{ kind: "put", path, uploadId: second.uploadId }] },
          id,
        ),
      path === "../escape" ? "BAD_REQUEST" : "FORBIDDEN",
    );
  }
  denied(() => f.store.stageUpload("outsider", id, Buffer.from("越权")), "NOT_ACCESSIBLE");
});

test("共享项目：共享消息跨成员读取，非成员与撤权成员不能读取或幂等重放", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  f.joinProject("editor", "editor");
  f.joinProject("viewer", "viewer");
  const chat = f.mutate<{ chatId: string }>("editor", "project_chat_create", { title: "共享讨论" }, id);
  const payload = { operationId: randomUUID(), chatId: chat.chatId, text: "跨账号可见的共享消息", runAgent: false };
  const sent = f.request<{ messageSeq: number }>("editor", "project_message_send", payload, id);
  assert.deepEqual(f.request("editor", "project_message_send", payload, id), sent);
  const messages = f.request<{ items: { seq: number; actor: string; text: string }[] }>(
    "viewer",
    "project_chat_read",
    { chatId: chat.chatId },
    id,
  ).items;
  assert.equal(messages.filter((m) => m.text === payload.text).length, 1);
  assert.equal(messages.find((m) => m.seq === sent.messageSeq)?.actor, "editor");
  denied(() => f.request("outsider", "project_chat_read", { chatId: chat.chatId }, id), "NOT_ACCESSIBLE");
  const member = f.members().find((m) => m.tenantId === "editor")!;
  f.mutate("owner", "project_member_remove", { targetTenantId: "editor", expectedMemberRevision: member.revision }, id);
  denied(() => f.request("editor", "project_message_send", payload, id), "NOT_ACCESSIBLE");
  denied(() => f.request("editor", "project_chat_read", { chatId: chat.chatId }, id), "NOT_ACCESSIBLE");
});

test("共享项目：归档可读不可写，恢复后可写，删除后不可访问", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  f.joinProject("editor", "editor");
  denied(() => f.mutate("editor", "project_archive", {}, id), "FORBIDDEN");
  f.mutate("owner", "project_archive", {}, id);
  assert.equal(f.request<{ summary: ProjectSummary }>("editor", "project_snapshot", {}, id).summary.state, "archived");
  denied(() => f.mutate("editor", "project_chat_create", { title: "归档后写入" }, id), "PROJECT_UNAVAILABLE");
  f.mutate("owner", "project_restore", {}, id);
  assert.equal(f.request<{ summary: ProjectSummary }>("editor", "project_snapshot", {}, id).summary.state, "active");
  assert.ok(f.mutate<{ chatId: string }>("editor", "project_chat_create", { title: "恢复后写入" }, id).chatId);
  denied(() => f.mutate("owner", "project_delete", {}, id), "CONFLICT");
  f.mutate("owner", "project_archive", {}, id);
  f.mutate("owner", "project_delete", {}, id);
  denied(() => f.request("editor", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
});

test("共享项目：失败提交原子回滚，二进制按字节读取，历史版本可恢复读取", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  const bytes = Buffer.from([0, 255, 254, 128, 42]);
  const upload = f.store.stageUpload("owner", id, bytes);
  denied(
    () =>
      f.mutate(
        "owner",
        "project_commit",
        {
          expectedRevision: 0,
          changes: [
            { kind: "put", path: "data.bin", uploadId: upload.uploadId },
            { kind: "put", path: "missing.txt", uploadId: randomUUID() },
          ],
        },
        id,
      ),
    "NOT_ACCESSIBLE",
  );
  assert.equal(f.request<{ items: unknown[] }>("owner", "project_tree", {}, id).items.length, 0);
  assert.equal(f.request<{ summary: ProjectSummary }>("owner", "project_snapshot", {}, id).summary.revision, 0);
  f.mutate(
    "owner",
    "project_commit",
    { expectedRevision: 0, changes: [{ kind: "put", path: "data.bin", uploadId: upload.uploadId }] },
    id,
  );
  const read = f.request<{ base64: string }>("owner", "project_file_read", { path: "data.bin" }, id);
  assert.deepEqual(Buffer.from(read.base64, "base64"), bytes);
  denied(
    () =>
      f.mutate(
        "owner",
        "project_commit",
        { expectedRevision: 1, changes: [{ kind: "put", path: "reused.bin", uploadId: upload.uploadId }] },
        id,
      ),
    "NOT_ACCESSIBLE",
  );
  f.mutate("owner", "project_commit", { expectedRevision: 1, changes: [{ kind: "delete", path: "data.bin" }] }, id);
  denied(() => f.request("owner", "project_file_read", { path: "data.bin" }, id), "NOT_ACCESSIBLE");
  assert.deepEqual(
    Buffer.from(
      f.request<{ base64: string }>("owner", "project_file_read", { path: "data.bin", revision: 1 }, id).base64,
      "base64",
    ),
    bytes,
  );
});

test("共享项目：大文件走身份绑定票据，撤权与票据过期立即阻断下载", (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  f.joinProject("viewer", "viewer");
  const bytes = Buffer.alloc(70000, 65);
  const upload = f.store.stageUpload("owner", id, bytes);
  f.mutate(
    "owner",
    "project_commit",
    { expectedRevision: 0, changes: [{ kind: "put", path: "large.txt", uploadId: upload.uploadId }] },
    id,
  );
  const ownerRead = f.request<{ ticket: string; text?: string; base64?: string }>(
    "owner",
    "project_file_read",
    { path: "large.txt" },
    id,
  );
  assert.equal(typeof ownerRead.ticket, "string");
  assert.equal(ownerRead.text, undefined);
  assert.equal(ownerRead.base64, undefined);
  assert.deepEqual(f.store.readResource("owner", id, ownerRead.ticket), bytes);
  denied(() => f.store.readResource("viewer", id, ownerRead.ticket), "NOT_ACCESSIBLE");
  const viewerRead = f.request<{ ticket: string }>("viewer", "project_file_read", { path: "large.txt" }, id);
  assert.deepEqual(f.store.readResource("viewer", id, viewerRead.ticket), bytes);
  const member = f.members().find((m) => m.tenantId === "viewer")!;
  f.mutate("owner", "project_member_remove", { targetTenantId: "viewer", expectedMemberRevision: member.revision }, id);
  denied(() => f.store.readResource("viewer", id, viewerRead.ticket), "NOT_ACCESSIBLE");
  const refreshed = f.request<{ ticket: string }>("owner", "project_file_read", { path: "large.txt" }, id);
  f.advance(60001);
  denied(() => f.store.readResource("owner", id, refreshed.ticket), "NOT_ACCESSIBLE");
});

test("项目执行器：真实 native 循环仅提供五种项目工具，提案不改文件，显式应用才生效", async (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  const uploaded = f.store.stageUpload("owner", id, Buffer.from("待替换内容"));
  f.mutate(
    "owner",
    "project_commit",
    { expectedRevision: 0, changes: [{ kind: "put", path: "old.txt", uploadId: uploaded.uploadId }] },
    id,
  );
  let steps = 0;
  const e = execution(f, async (input) => {
    assert.deepEqual(input.tools.map((tool) => tool.name).sort(), [
      "project_list_tree",
      "project_propose_delete",
      "project_propose_write",
      "project_read_file",
      "project_search",
    ]);
    steps += 1;
    if (steps === 1)
      return turn([
        call("project_list_tree", {}),
        call("project_read_file", { path: "old.txt" }),
        call("project_search", { query: "待替换" }),
      ]);
    const results = input.messages.filter((m) => m.role === "tool");
    assert.ok(results.length >= 3);
    assert.ok(results.every((m) => !m.isError));
    if (steps === 2)
      return turn([
        call("project_propose_write", { path: "new.txt", text: "模型提案", expectedBlobHash: null }),
        call("project_propose_delete", { path: "old.txt", expectedBlobHash: uploaded.sha256 }),
      ]);
    input.onText("修改已生成，请确认应用。");
    return turn([], "修改已生成，请确认应用。");
  });
  const { runId } = e.enqueue();
  e.executor.start();
  try {
    await until(() => e.status(runId) === "proposed" || e.status(runId) === "failed");
    assert.equal(e.status(runId), "proposed");
    assert.equal(steps, 3);
    assert.equal(f.request<{ summary: ProjectSummary }>("owner", "project_snapshot", {}, id).summary.revision, 1);
    assert.equal(f.request<{ text: string }>("owner", "project_file_read", { path: "old.txt" }, id).text, "待替换内容");
    denied(() => f.request("owner", "project_file_read", { path: "new.txt" }, id), "NOT_ACCESSIBLE");
    f.mutate("owner", "project_run_apply", { runId, expectedRevision: 1 }, id);
    assert.equal(e.status(runId), "applied");
    assert.equal(f.request<{ text: string }>("owner", "project_file_read", { path: "new.txt" }, id).text, "模型提案");
    denied(() => f.request("owner", "project_file_read", { path: "old.txt" }, id), "NOT_ACCESSIBLE");
  } finally {
    await e.executor.stop();
  }
});

test("项目执行器：人工保存不中断模型，旧基线提案应用冲突且保留人工文件", async (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false,
    steps = 0;
  const e = execution(f, async () => {
    if (++steps === 1) {
      entered = true;
      await gate;
      return turn([call("project_propose_write", { path: "model.txt", text: "模型版本", expectedBlobHash: null })]);
    }
    return turn();
  });
  const { runId } = e.enqueue();
  e.executor.start();
  try {
    await until(() => entered);
    const upload = f.store.stageUpload("owner", id, Buffer.from("人工保存"));
    f.mutate(
      "owner",
      "project_commit",
      { expectedRevision: 0, changes: [{ kind: "put", path: "human.txt", uploadId: upload.uploadId }] },
      id,
    );
    assert.equal(e.status(runId), "running");
    release();
    await until(() => e.status(runId) === "proposed" || e.status(runId) === "failed");
    assert.equal(e.status(runId), "proposed");
    denied(() => f.mutate("owner", "project_run_apply", { runId, expectedRevision: 0 }, id), "CONFLICT");
    assert.equal(f.request<{ text: string }>("owner", "project_file_read", { path: "human.txt" }, id).text, "人工保存");
    denied(() => f.request("owner", "project_file_read", { path: "model.txt" }, id), "NOT_ACCESSIBLE");
  } finally {
    release();
    await e.executor.stop();
  }
});

test("项目执行器：取消后晚到的模型输出和写入提案均不能落入项目", async (t) => {
  const f = fixture(t),
    id = f.project.workspaceId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const e = execution(f, async (input) => {
    entered = true;
    await gate;
    input.onText("取消后晚到的内容");
    return turn([call("project_propose_write", { path: "late.txt", text: "晚到写入", expectedBlobHash: null })]);
  });
  const { runId } = e.enqueue();
  e.executor.start();
  try {
    await until(() => entered);
    f.mutate("owner", "project_run_cancel", { runId }, id);
    release();
    await until(() => !e.executor.running.has(runId));
    assert.equal(e.status(runId), "cancelled");
    const messages = f.request<{ items: { text: string }[] }>(
      "owner",
      "project_chat_read",
      { chatId: e.chat.chatId },
      id,
    ).items;
    assert.ok(messages.every((m) => !m.text.includes("取消后晚到")));
    denied(() => f.request("owner", "project_file_read", { path: "late.txt" }, id), "NOT_ACCESSIBLE");
    denied(() => f.mutate("owner", "project_run_apply", { runId, expectedRevision: 0 }, id), "CONFLICT");
  } finally {
    release();
    await e.executor.stop();
  }
});

test("项目执行器：预算不足在调用模型前停止，未消耗预留正确结算", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const e = execution(
    f,
    async () => {
      calls += 1;
      return turn();
    },
    10,
  );
  const { runId } = e.enqueue();
  e.executor.start();
  try {
    await until(() => e.status(runId) === "failed");
    assert.equal(calls, 0);
    const ledger = f.store.one<{ charged: number; reserved: number; status: string }>(
      "SELECT charged,reserved,status FROM budget_ledger WHERE run=?",
      runId,
    );
    assert.deepEqual({ ...ledger }, { charged: 0, reserved: 0, status: "settled" });
  } finally {
    await e.executor.stop();
  }
});

test("项目执行器：模型调用后费用未知保留预留并阻止预算重复使用", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const e = execution(f, async () => {
    calls += 1;
    throw new Error("模拟发送请求后连接断开，费用未知");
  });
  const { runId } = e.enqueue();
  e.executor.start();
  try {
    await until(() => e.status(runId) === "failed");
    assert.equal(calls, 1);
    const ledger = f.store.one<{ charged: number; reserved: number; status: string }>(
      "SELECT charged,reserved,status FROM budget_ledger WHERE run=?",
      runId,
    );
    assert.deepEqual({ ...ledger }, { charged: 0, reserved: 1000000, status: "pending" });
    denied(() => e.enqueue(), "BUDGET_EXCEEDED");
    const messages = f.request<{ items: { kind: string }[] }>(
      "owner",
      "project_chat_read",
      { chatId: e.chat.chatId },
      f.project.workspaceId,
    ).items;
    assert.equal(messages.filter((message) => message.kind === "user").length, 1);
  } finally {
    await e.executor.stop();
  }
});
