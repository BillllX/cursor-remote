import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeProjectRequest, projectPath } from "../../shared/projectValidation.ts";
import { type ProjectRequest, type ProjectAction } from "../../shared/projectTypes.ts";
import { ProjectObjects } from "../src/projects/store/objects.ts";
import { ProjectStore } from "../src/projects/store/main.ts";

type TestResult = {
  workspaceId: string;
  inviteId: string;
  revision: number;
  items: { path: string }[];
  nextCursor: string;
  ticket: string;
  text: string;
};
const accounts = ["owner", "editor", "viewer", "admin", "outsider"].map((id) => ({
  id,
  sharingEnabled: true,
  sharingDomain: "security-test",
  sandboxVerified: true,
}));
function request(action: ProjectAction, payload: Record<string, unknown> = {}, workspaceId?: string): ProjectRequest {
  return {
    type: "project_request",
    protocol: 1,
    requestId: randomUUID(),
    action,
    ...(workspaceId ? { workspaceId } : {}),
    payload,
  };
}
function denied(fn: () => unknown, ...codes: string[]) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof Error && "code" in error && codes.includes(String(error.code)),
  );
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "project-security-"));
  let store = new ProjectStore(directory);
  store.setAccounts(accounts);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (actor: string, action: ProjectAction, payload: Record<string, unknown> = {}, id?: string) =>
    store.request(actor, request(action, payload, id)) as TestResult;
  const create = () =>
    call("owner", "project_create", { operationId: randomUUID(), title: "安全隔离测试" }).workspaceId as string;
  const add = (id: string, actor: string, role: string) => {
    const inv = call("owner", "project_invite", { operationId: randomUUID(), targetTenantId: actor, role }, id);
    call(actor, "project_invite_accept", { operationId: randomUUID(), inviteId: inv.inviteId });
  };
  return {
    directory,
    get store() {
      return store;
    },
    call,
    create,
    add,
    restart() {
      store.close();
      store = new ProjectStore(directory);
      store.setAccounts(accounts);
    },
  };
}

test("请求身份不能由载荷、额外字段或旧协议注入", () => {
  const r = request("project_create", { operationId: randomUUID(), title: "安全测试" });
  for (const field of ["principal", "ownerTenantId", "tenantId", "actor", "sharingDomain", "caps"]) {
    denied(() => decodeProjectRequest({ ...r, [field]: "owner" }), "BAD_REQUEST");
    denied(() => decodeProjectRequest({ ...r, payload: { ...r.payload, [field]: "owner" } }), "BAD_REQUEST");
  }
  denied(() => decodeProjectRequest({ ...r, protocol: 0 }), "BAD_REQUEST");
});

test("保护路径、穿越、Windows 路径和非规范 Unicode 被拒绝", () => {
  for (const path of [
    "../x",
    "/etc/passwd",
    "x//y",
    "x/./y",
    "x/../y",
    "C:\\temp",
    "x\\y",
    "x\u0000y",
    "x.",
    "x ",
    "nul",
    "a/COM1.txt",
    "e\u0301.txt",
    ".git/config",
    "a/AGENTS.md",
    ".CURSOR/a",
    ".codex/a",
    ".jiebo/a",
    ".cursor-remote/a",
  ]) {
    denied(() => projectPath(path), "BAD_REQUEST", "FORBIDDEN");
  }
});

test("对象内容损坏、符号链接和硬链接均停止读取", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "project-object-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const objects = new ProjectObjects(directory);
  for (const mode of ["corrupt", "symlink", "hardlink"]) {
    const hash = objects.put(Buffer.from(mode)),
      path = objects.path(hash),
      external = join(directory, `external-${mode}`);
    if (mode === "corrupt") writeFileSync(path, "篡改");
    else {
      unlinkSync(path);
      writeFileSync(external, mode);
      if (mode === "symlink") symlinkSync(external, path);
      else linkSync(external, path);
    }
    denied(() => objects.read(hash), "STORAGE_CORRUPT");
  }
});

test("未知、关闭共享、未验证沙箱与跨域身份均不可访问", (t) => {
  const f = fixture(t),
    id = f.create();
  denied(() => f.call("missing", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
  denied(() => f.call("outsider", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
  f.add(id, "editor", "editor");
  for (const patch of [{ sharingEnabled: false }, { sandboxVerified: false }, { sharingDomain: "different" }]) {
    f.store.setAccounts(accounts.map((a) => (a.id === "editor" ? { ...a, ...patch } : a)));
    denied(() => f.call("editor", "project_snapshot", {}, id), "NOT_ACCESSIBLE");
  }
});

test("viewer 无法上传、提升角色；admin 无法授予 owner 或 admin", (t) => {
  const f = fixture(t),
    id = f.create();
  f.add(id, "viewer", "viewer");
  f.add(id, "admin", "admin");
  denied(() => f.store.stageUpload("viewer", id, Buffer.from("x")), "FORBIDDEN");
  for (const [actor, role] of [
    ["viewer", "editor"],
    ["admin", "admin"],
    ["admin", "owner"],
  ]) {
    denied(
      () => f.call(actor!, "project_invite", { operationId: randomUUID(), targetTenantId: "outsider", role }, id),
      "FORBIDDEN",
    );
  }
  denied(
    () =>
      f.call(
        "viewer",
        "project_member_set",
        { operationId: randomUUID(), targetTenantId: "viewer", role: "owner", expectedMemberRevision: 0 },
        id,
      ),
    "FORBIDDEN",
  );
});

test("幂等键重用不同载荷失败且重启保持单一结果", (t) => {
  const f = fixture(t),
    operationId = randomUUID();
  const first = f.call("owner", "project_create", { operationId, title: "原始项目" });
  assert.deepEqual(f.call("owner", "project_create", { operationId, title: "原始项目" }), first);
  denied(() => f.call("owner", "project_create", { operationId, title: "替换项目" }), "IDEMPOTENCY_MISMATCH");
  f.restart();
  assert.deepEqual(f.call("owner", "project_create", { operationId, title: "原始项目" }), first);
});

test("撤权后不得通过已成功请求的幂等缓存恢复访问", (t) => {
  const f = fixture(t),
    id = f.create();
  f.add(id, "editor", "editor");
  const payload = { operationId: randomUUID(), title: "撤权前对话" };
  f.call("editor", "project_chat_create", payload, id);
  f.call(
    "owner",
    "project_member_remove",
    { operationId: randomUUID(), targetTenantId: "editor", expectedMemberRevision: 0 },
    id,
  );
  denied(() => f.call("editor", "project_chat_create", payload, id), "NOT_ACCESSIBLE");
  denied(() => f.call("editor", "project_event_read", { afterEventSeq: 0 }, id), "NOT_ACCESSIBLE");
  denied(() => f.store.stageUpload("editor", id, Buffer.from("x")), "NOT_ACCESSIBLE");
  f.restart();
  denied(() => f.call("editor", "project_chat_create", payload, id), "NOT_ACCESSIBLE");
});

test("上传凭证绑定项目与上传者，不能用 blob hash 代替", (t) => {
  const f = fixture(t),
    a = f.create(),
    b = f.create();
  f.add(a, "editor", "editor");
  const upload = f.store.stageUpload("owner", a, Buffer.from("项目 A 机密"));
  const commit = (actor: string, id: string, change: unknown) =>
    f.call(actor, "project_commit", { operationId: randomUUID(), expectedRevision: 0, changes: [change] }, id);
  denied(
    () => commit("owner", b, { kind: "put", path: "stolen.txt", uploadId: upload.uploadId }),
    "NOT_ACCESSIBLE",
    "BAD_REQUEST",
    "FORBIDDEN",
  );
  denied(
    () => commit("editor", a, { kind: "put", path: "stolen.txt", uploadId: upload.uploadId }),
    "NOT_ACCESSIBLE",
    "BAD_REQUEST",
    "FORBIDDEN",
  );
  denied(() => commit("owner", b, { kind: "put", path: "stolen.txt", blobHash: upload.sha256 }), "BAD_REQUEST");
  commit("owner", a, { kind: "put", path: "ok.txt", uploadId: upload.uploadId });
  assert.equal(f.call("owner", "project_file_read", { path: "ok.txt" }, a).text, "项目 A 机密");
});

test("相同基础版本竞争提交只允许一次成功，重启无半提交", (t) => {
  const f = fixture(t),
    id = f.create();
  const one = f.store.stageUpload("owner", id, Buffer.from("first"));
  const two = f.store.stageUpload("owner", id, Buffer.from("second"));
  const first = {
    operationId: randomUUID(),
    expectedRevision: 0,
    changes: [{ kind: "put", path: "first.txt", uploadId: one.uploadId }],
  };
  const second = {
    operationId: randomUUID(),
    expectedRevision: 0,
    changes: [{ kind: "put", path: "second.txt", uploadId: two.uploadId }],
  };
  const peer = new ProjectStore(f.directory);
  peer.setAccounts(accounts);
  try {
    f.call("owner", "project_commit", first, id);
    denied(() => peer.request("owner", request("project_commit", second, id)), "CONFLICT");
  } finally {
    peer.close();
  }
  f.restart();
  assert.equal(f.call("owner", "project_file_read", { path: "first.txt" }, id).text, "first");
  denied(() => f.call("owner", "project_file_read", { path: "second.txt" }, id), "NOT_ACCESSIBLE", "BAD_REQUEST");
});

test("保护路径提交失败不消耗版本", (t) => {
  const f = fixture(t),
    id = f.create(),
    upload = f.store.stageUpload("owner", id, Buffer.from("x"));
  for (const path of ["../outside", "AGENTS.md", ".cursor/rules/a", ".git/config"]) {
    denied(
      () =>
        f.call(
          "owner",
          "project_commit",
          {
            operationId: randomUUID(),
            expectedRevision: 0,
            changes: [{ kind: "put", path, uploadId: upload.uploadId }],
          },
          id,
        ),
      "BAD_REQUEST",
      "FORBIDDEN",
    );
  }
  f.call(
    "owner",
    "project_commit",
    {
      operationId: randomUUID(),
      expectedRevision: 0,
      changes: [{ kind: "put", path: "safe.txt", uploadId: upload.uploadId }],
    },
    id,
  );
});

test("已暂存对象损坏时拒绝提交且版本保持不变", (t) => {
  const f = fixture(t),
    id = f.create(),
    upload = f.store.stageUpload("owner", id, Buffer.from("safe"));
  writeFileSync(join(f.directory, "blobs", upload.sha256.slice(0, 2), upload.sha256), "tampered");
  denied(
    () =>
      f.call(
        "owner",
        "project_commit",
        {
          operationId: randomUUID(),
          expectedRevision: 0,
          changes: [{ kind: "put", path: "bad.txt", uploadId: upload.uploadId }],
        },
        id,
      ),
    "STORAGE_CORRUPT",
  );
  assert.equal(f.store.one<{ revision: number }>("SELECT revision FROM projects WHERE id=?", id)?.revision, 0);
});

test("非可信工具路径不能作为项目身份传入", (t) => {
  const f = fixture(t),
    id = f.create();
  for (const field of ["cwd", "root", "workspacePath", "principal", "ownerTenantId"]) {
    denied(
      () => f.store.request("outsider", { ...request("project_snapshot", {}, id), [field]: "owner" } as ProjectRequest),
      "BAD_REQUEST",
    );
  }
  denied(() => f.store.request("owner", request("project_snapshot", {}, "../../tenants/owner")), "BAD_REQUEST");
});

test("已接受邀请撤权后重放不得返回成功或重获成员身份", (t) => {
  const f = fixture(t),
    id = f.create();
  const inv = f.call(
    "owner",
    "project_invite",
    { operationId: randomUUID(), targetTenantId: "editor", role: "editor" },
    id,
  );
  const accept = { operationId: randomUUID(), inviteId: inv.inviteId };
  f.call("editor", "project_invite_accept", accept);
  f.call(
    "owner",
    "project_member_remove",
    { operationId: randomUUID(), targetTenantId: "editor", expectedMemberRevision: 0 },
    id,
  );
  denied(() => f.call("editor", "project_invite_accept", accept), "NOT_ACCESSIBLE");
  denied(() => f.call("editor", "project_invite_accept", { ...accept, operationId: randomUUID() }), "NOT_ACCESSIBLE");
});

test("过期上传不能发布且失败不消耗版本", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "project-expiry-security-"));
  let now = Date.now();
  const store = new ProjectStore(directory, () => now);
  store.setAccounts(accounts);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = (
    store.request("owner", request("project_create", { operationId: randomUUID(), title: "过期测试" })) as TestResult
  ).workspaceId;
  const upload = store.stageUpload("owner", id, Buffer.from("expired"));
  now += 31 * 60000;
  denied(
    () =>
      store.request(
        "owner",
        request(
          "project_commit",
          {
            operationId: randomUUID(),
            expectedRevision: 0,
            changes: [{ kind: "put", path: "expired.txt", uploadId: upload.uploadId }],
          },
          id,
        ),
      ),
    "NOT_ACCESSIBLE",
  );
  assert.equal((store.request("owner", request("project_tree", {}, id)) as TestResult).revision, 0);
});

test("大文件票据绑定身份与项目，篡改和撤权后重放失败", (t) => {
  const f = fixture(t),
    id = f.create(),
    other = f.create();
  f.add(id, "viewer", "viewer");
  const bytes = Buffer.alloc(60001, 65),
    upload = f.store.stageUpload("owner", id, bytes);
  f.call(
    "owner",
    "project_commit",
    {
      operationId: randomUUID(),
      expectedRevision: 0,
      changes: [{ kind: "put", path: "large.bin", uploadId: upload.uploadId }],
    },
    id,
  );
  const { ticket } = f.call("viewer", "project_file_read", { path: "large.bin" }, id);
  assert.equal(typeof ticket, "string");
  assert.deepEqual(f.store.readResource("viewer", id, ticket), bytes);
  denied(() => f.store.readResource("owner", id, ticket), "NOT_ACCESSIBLE");
  denied(() => f.store.readResource("owner", other, ticket), "NOT_ACCESSIBLE");
  const [body, mac] = ticket.split(".");
  const forged =
    Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), actor: "owner" })).toString(
      "base64url",
    ) +
    "." +
    mac;
  denied(() => f.store.readResource("owner", id, forged), "NOT_ACCESSIBLE");
  f.call(
    "owner",
    "project_member_remove",
    { operationId: randomUUID(), targetTenantId: "viewer", expectedMemberRevision: 0 },
    id,
  );
  denied(() => f.store.readResource("viewer", id, ticket), "NOT_ACCESSIBLE");
  f.add(id, "viewer", "viewer");
  denied(() => f.store.readResource("viewer", id, ticket), "NOT_ACCESSIBLE");
});

test("树分页游标不可跨身份、跨项目或修改位置复用", (t) => {
  const f = fixture(t),
    id = f.create(),
    other = f.create();
  f.add(id, "viewer", "viewer");
  f.call(
    "owner",
    "project_commit",
    {
      operationId: randomUUID(),
      expectedRevision: 0,
      changes: [
        { kind: "mkdir", path: "a" },
        { kind: "mkdir", path: "b" },
      ],
    },
    id,
  );
  const page = f.call("owner", "project_tree", { limit: 1 }, id);
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  for (const [actor, target] of [
    ["viewer", id],
    ["owner", other],
  ]) {
    denied(
      () => f.call(actor!, "project_tree", { limit: 1, cursor: page.nextCursor }, target),
      "RESYNC_REQUIRED",
      "NOT_ACCESSIBLE",
    );
  }
  denied(
    () => f.call("owner", "project_tree", { cursor: page.nextCursor + "tamper" }, id),
    "RESYNC_REQUIRED",
    "NOT_ACCESSIBLE",
  );
  assert.equal(f.call("owner", "project_tree", { limit: 1, cursor: page.nextCursor }, id).items[0].path, "b");
});

test("两个独立进程同时提交同一基础版本仅一个成功", async (t) => {
  const f = fixture(t),
    id = f.create();
  const source = `
    import { ProjectStore } from './gateway/src/projects/store/main.ts';
    const [directory, accountsJson, requestJson] = process.argv.slice(1);
    const store = new ProjectStore(directory); store.setAccounts(JSON.parse(accountsJson));
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      try { const result = store.request('owner', JSON.parse(requestJson)); process.stdout.write(JSON.stringify({ok:true,result})+'\\n'); }
      catch(error) { process.stdout.write(JSON.stringify({ok:false,code:error.code})+'\\n'); }
      finally { store.close(); process.stdin.destroy(); }
    });
  `;
  const children = ["a", "b"].map((path) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        source,
        f.directory,
        JSON.stringify(accounts),
        JSON.stringify(
          request(
            "project_commit",
            { operationId: randomUUID(), expectedRevision: 0, changes: [{ kind: "mkdir", path }] },
            id,
          ),
        ),
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    t.after(() => child.kill());
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exit = once(child, "exit");
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("子进程未准备好：" + errors)), 10000);
      child.stdout.on("data", () => {
        if (output.includes("READY\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    return { child, ready, exit, output: () => output, errors: () => errors };
  });
  await Promise.all(children.map((c) => c.ready));
  for (const c of children) c.child.stdin.write("go\n");
  const outcomes = await Promise.all(
    children.map(async (c) => {
      const [code] = await c.exit;
      assert.equal(code, 0, c.errors());
      return JSON.parse(c.output().trim().split("\n").at(-1)!);
    }),
  );
  assert.equal(outcomes.filter((x) => x.ok).length, 1);
  assert.deepEqual(
    outcomes.filter((x) => !x.ok).map((x) => x.code),
    ["CONFLICT"],
  );
  f.restart();
  const tree = f.call("owner", "project_tree", {}, id);
  assert.equal(tree.revision, 1);
  assert.equal(tree.items.length, 1);
});

test("IPC 验签拒绝伪造身份、错误密钥、过期时间及重复 nonce", async () => {
  const { signProjectEnvelope, verifyProjectEnvelope } = await import("../src/projects/ipc.ts");
  const key = Buffer.alloc(32, 7),
    now = Date.now(),
    seen = new Map<string, number>();
  const command = { principal: "owner", method: "health" as const, timestamp: now, nonce: randomUUID() };
  const envelope = signProjectEnvelope(command, key);
  assert.equal(verifyProjectEnvelope(envelope, key, seen, now).principal, "owner");
  denied(() => verifyProjectEnvelope(envelope, key, seen, now), "NOT_ACCESSIBLE");
  denied(
    () =>
      verifyProjectEnvelope(
        signProjectEnvelope({ ...command, nonce: randomUUID() }, Buffer.alloc(32, 8)),
        key,
        seen,
        now,
      ),
    "NOT_ACCESSIBLE",
  );
  denied(
    () =>
      verifyProjectEnvelope(
        { ...envelope, body: Buffer.from(JSON.stringify({ ...command, principal: "outsider" })).toString("base64url") },
        key,
        new Map(),
        now,
      ),
    "NOT_ACCESSIBLE",
  );
  for (const delta of [-30001, 30001])
    denied(
      () =>
        verifyProjectEnvelope(
          signProjectEnvelope({ ...command, timestamp: now + delta, nonce: randomUUID() }, key),
          key,
          seen,
          now,
        ),
      "NOT_ACCESSIBLE",
    );
});

test("未来时间戳的合法 IPC 签名不能在 nonce 清理后重放", async () => {
  const { signProjectEnvelope, verifyProjectEnvelope } = await import("../src/projects/ipc.ts");
  const key = Buffer.alloc(32, 7),
    now = Date.now(),
    seen = new Map<string, number>();
  const envelope = signProjectEnvelope(
    { principal: "owner", method: "health", timestamp: now + 29000, nonce: randomUUID() },
    key,
  );
  verifyProjectEnvelope(envelope, key, seen, now);
  verifyProjectEnvelope(
    signProjectEnvelope({ principal: "owner", method: "health", timestamp: now + 31000, nonce: randomUUID() }, key),
    key,
    seen,
    now + 31000,
  );
  denied(() => verifyProjectEnvelope(envelope, key, seen, now + 31000), "NOT_ACCESSIBLE");
});

test("真实 Unix 服务拒绝未签名与伪造身份，并在重启后拒绝重放", async (t) => {
  const { startProjectService } = await import("../src/projects/service.ts");
  const { signProjectEnvelope, ProjectStoreClient } = await import("../src/projects/ipc.ts");
  const { createConnection } = await import("node:net");
  const directory = mkdtempSync(join(tmpdir(), "project-ipc-security-"));
  const socketPath = join(directory, "service.sock"),
    keyFile = join(directory, "key"),
    accountsFile = join(directory, "accounts.json");
  const key = Buffer.alloc(32, 11);
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(accountsFile, JSON.stringify(accounts), { mode: 0o600 });
  const options = { directory: join(directory, "data"), socketPath, keyFile, accountsFile };
  let service = await startProjectService(options);
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const raw = (envelope: unknown) =>
    new Promise<{ ok: boolean; error?: { code: string }; data?: unknown }>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let body = "";
      socket.setTimeout(5000, () => socket.destroy(new Error("安全测试 IPC 超时")));
      socket.on("connect", () => socket.end(JSON.stringify(envelope) + "\n"));
      socket.on("data", (chunk) => {
        body += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
  const unsigned = await raw({ principal: "owner", method: "health" });
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.error?.code, "NOT_ACCESSIBLE");
  const signed = signProjectEnvelope(
    { principal: "owner", method: "health", timestamp: Date.now(), nonce: randomUUID() },
    key,
  );
  assert.equal((await raw(signed)).ok, true);
  assert.equal((await raw(signed)).error?.code, "NOT_ACCESSIBLE");
  await service.close();
  service = await startProjectService(options);
  assert.equal((await raw(signed)).error?.code, "NOT_ACCESSIBLE");
  const client = new ProjectStoreClient({ socketPath, keyFile });
  const created = await client.call<TestResult>("owner", "request", {
    request: request("project_create", { operationId: randomUUID(), title: "Unix 安全验证" }),
  });
  await assert.rejects(
    client.call("outsider", "request", {
      request: { ...request("project_snapshot", {}, created.workspaceId), principal: "owner" },
    }),
    (e: unknown) => e instanceof Error && "code" in e && e.code === "BAD_REQUEST",
  );
  await assert.rejects(
    client.call("outsider", "request", { request: request("project_snapshot", {}, created.workspaceId) }),
    (e: unknown) => e instanceof Error && "code" in e && e.code === "NOT_ACCESSIBLE",
  );
  writeFileSync(
    accountsFile,
    JSON.stringify(accounts.map((a) => (a.id === "owner" ? { ...a, sharingEnabled: false } : a))),
  );
  await assert.rejects(
    client.call("owner", "request", { request: request("project_snapshot", {}, created.workspaceId) }),
    (e: unknown) => e instanceof Error && "code" in e && e.code === "NOT_ACCESSIBLE",
  );
});

test("真实 Unix 服务接受协议允许的最大文件并原样读取", async (t) => {
  const { startProjectService } = await import("../src/projects/service.ts");
  const { ProjectStoreClient } = await import("../src/projects/ipc.ts");
  const { PROJECT_LIMITS } = await import("../../shared/projectTypes.ts");
  const dir = mkdtempSync(join(tmpdir(), "project-ipc-upload-"));
  const socketPath = join(dir, "store.sock"),
    keyFile = join(dir, "key"),
    accountsFile = join(dir, "accounts.json");
  writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  writeFileSync(accountsFile, JSON.stringify(accounts), { mode: 0o600 });
  const service = await startProjectService({ directory: join(dir, "data"), socketPath, keyFile, accountsFile });
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const client = new ProjectStoreClient({ socketPath, keyFile });
  const { workspaceId } = await client.call<TestResult>("owner", "request", {
    request: request("project_create", { operationId: randomUUID(), title: "文件边界" }),
  });
  const bytes = Buffer.alloc(PROJECT_LIMITS.fileBytes, 129);
  const { uploadId, size } = await client.call<{ uploadId: string; size: number }>("owner", "upload", {
    workspaceId,
    base64: bytes.toString("base64"),
  });
  assert.equal(size, bytes.length);
  await client.call("owner", "request", {
    request: request(
      "project_commit",
      { operationId: randomUUID(), expectedRevision: 0, changes: [{ kind: "put", path: "large.bin", uploadId }] },
      workspaceId,
    ),
  });
  const { ticket } = await client.call<TestResult>("owner", "request", {
    request: request("project_file_read", { path: "large.bin" }, workspaceId),
  });
  const { base64 } = await client.call<{ base64: string }>("owner", "resource", { workspaceId, ticket });
  assert.ok(bytes.equals(Buffer.from(base64, "base64")));
});
