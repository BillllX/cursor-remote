/** 只在上海隔离目录运行：真实 Gateway + 独立 UID 的项目存储服务，无正式数据。 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { PROJECT_CAP, type ProjectAction, type ProjectResult, type ProjectEvent } from "../shared/projectTypes.ts";
const fixture = "/opt/cursor-remote-project-fixture",
  root = process.cwd(),
  port = 18461;
if (!existsSync(join(fixture, "client/settings.json")))
  throw new Error("请先由运维启动 project-isolation-fixture.sh start");
const temp = mkdtempSync(join(tmpdir(), "project-e2e-")),
  state = join(temp, "state");
mkdirSync(state, { mode: 0o700 });
mkdirSync(join(temp, "home"));
const ids = ["project-owner", "project-editor", "project-viewer", "project-outsider"],
  tokens = Object.fromEntries(ids.map((id) => [id, randomBytes(24).toString("hex")]));
writeFileSync(
  join(temp, "tenants.json"),
  JSON.stringify({
    tenants: ids.map((id) => ({
      id,
      name: id,
      token: tokens[id],
      sandbox: true,
      projectSharingEnabled: true,
      projectSharingDomain: "project-fixture",
      projectSandboxVerified: true,
    })),
  }),
  { mode: 0o600 },
);
copyFileSync(join(fixture, "client/settings.json"), join(state, "projects-client.json"));
writeFileSync(join(state, "providers.json"), '{"providers":[]}');
const logPath = join(temp, "gateway.log");
const { openSync, closeSync } = await import("node:fs");
const logFd = openSync(logPath, "w", 0o600);
const gateway = spawn(process.execPath, ["--import", "tsx", "gateway/src/index.ts"], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HOME: join(temp, "home"),
    LANG: "C.UTF-8",
    CURSOR_REMOTE_STATE_DIR: state,
    CURSOR_REMOTE_TENANTS_FILE: join(temp, "tenants.json"),
    CURSOR_API_KEY: "",
    CURSOR_REMOTE_TOKEN: "",
    CURSOR_REMOTE_PASSWORD: "",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(port),
    GATEWAY_PROXY_WEB: "0",
  },
  stdio: ["ignore", logFd, logFd],
});
const sockets: WebSocket[] = [];
let webProcess: ReturnType<typeof spawn> | undefined;
const checks: { name: string; ok: boolean }[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function check(name: string, run: () => Promise<void>) {
  await run();
  checks.push({ name, ok: true });
  console.log("PASS " + name);
}
async function client(id: string, cap = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  sockets.push(ws);
  const waiting = new Map<string, (v: ProjectResult) => void>(),
    events: ProjectEvent[] = [],
    personal: unknown[] = [];
  let readyResolve: () => void;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "ready") readyResolve();
    if (m.type === "project_result") waiting.get(m.requestId)?.(m);
    if (m.type === "project_event") events.push(m);
    if (m.type === "stored_state" || m.type === "stored_digest") personal.push(m);
  });
  await new Promise<void>((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      token: tokens[id],
      client: {
        name: "project-e2e",
        version: "1",
        caps: [...(cap ? [PROJECT_CAP] : []), "stored_digest", "slim_state", "slim_chats"],
      },
    }),
  );
  await Promise.race([
    ready,
    pause(20000).then(() => {
      throw new Error("Gateway ready timeout");
    }),
  ]);
  return {
    ws,
    events,
    personal,
    call: async (action: ProjectAction, payload: Record<string, unknown> = {}, workspaceId?: string) => {
      const requestId = randomUUID();
      const result = new Promise<ProjectResult>((res, rej) => {
        const timeout = setTimeout(() => {
          waiting.delete(requestId);
          rej(new Error("request timeout " + action));
        }, 10000);
        waiting.set(requestId, (r) => {
          clearTimeout(timeout);
          waiting.delete(requestId);
          res(r);
        });
      });
      ws.send(JSON.stringify({ type: "project_request", protocol: 1, requestId, action, workspaceId, payload }));
      return result;
    },
  };
}
function data<T>(result: ProjectResult): T {
  if (!result.ok) throw new Error(result.error.code + ": " + result.error.message);
  return result.data as T;
}
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.status === 200 || r.status === 503) {
        healthy = true;
        break;
      }
    } catch {}
    if (gateway.exitCode !== null) break;
    await pause(100);
  }
  if (!healthy) throw new Error("隔离 Gateway 启动失败：" + readFileSync(logPath, "utf8").slice(-3000));
  const a = await client(ids[0]),
    b = await client(ids[1]),
    v = await client(ids[2]),
    d = await client(ids[3]),
    old = await client(ids[0], false);
  const project = data<{ workspaceId: string; revision: number; title: string }>(
      await a.call("project_create", {
        operationId: randomUUID(),
        title: "上海共享项目端到端 " + randomUUID().slice(0, 8),
      }),
    ),
    id = project.workspaceId;
  await check("双账号独立收件箱邀请与接受", async () => {
    for (const [c, target, role] of [
      [b, ids[1], "editor"],
      [v, ids[2], "viewer"],
    ] as const) {
      const inv = data<{ inviteId: string }>(
        await a.call("project_invite", { operationId: randomUUID(), targetTenantId: target, role }, id),
      );
      assert(
        data<{ items: { inviteId: string }[] }>(await c.call("project_inbox")).items.some(
          (i) => i.inviteId === inv.inviteId,
        ),
      );
      data(await c.call("project_invite_accept", { operationId: randomUUID(), inviteId: inv.inviteId }));
    }
  });
  await check("旧客户端与非成员拒绝", async () => {
    const result = await old.call("project_snapshot", {}, id);
    assert(!result.ok && result.error.code === "CAP_REQUIRED");
    const denied = await d.call("project_snapshot", {}, id);
    assert(!denied.ok && denied.error.code === "NOT_ACCESSIBLE");
  });
  data(await b.call("project_subscribe", { afterEventSeq: 0 }, id));
  let uploadId = "";
  await check("HTTP鉴权上传与原子文件提交", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/upload/projects/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens[ids[1]]}`, "X-Jiebo-Project-Protocol": "1" },
      body: "上海双账号文件",
    });
    assert.equal(res.status, 200);
    const up = (await res.json()) as { data: { uploadId: string } };
    uploadId = up.data.uploadId;
    const commit = data<{ revision: number }>(
      await b.call(
        "project_commit",
        {
          operationId: randomUUID(),
          expectedRevision: 0,
          changes: [{ kind: "put", path: "docs/shared.txt", uploadId }],
        },
        id,
      ),
    );
    assert.equal(commit.revision, 1);
    assert.equal(
      data<{ text: string }>(await a.call("project_file_read", { path: "docs/shared.txt" }, id)).text,
      "上海双账号文件",
    );
  });
  await check("查看者不能提交；旧版本冲突不覆盖", async () => {
    const denied = await v.call(
      "project_commit",
      { operationId: randomUUID(), expectedRevision: 1, changes: [{ kind: "delete", path: "docs/shared.txt" }] },
      id,
    );
    assert(!denied.ok && denied.error.code === "FORBIDDEN");
    const conflict = await a.call(
      "project_commit",
      { operationId: randomUUID(), expectedRevision: 0, changes: [{ kind: "delete", path: "docs/shared.txt" }] },
      id,
    );
    assert(!conflict.ok && conflict.error.code === "CONFLICT");
  });
  await check("共享消息只进项目库及订阅增量", async () => {
    const chat = data<{ chatId: string }>(
      await a.call("project_chat_create", { operationId: randomUUID(), title: "共享会话" }, id),
    );
    data(
      await b.call(
        "project_message_send",
        { operationId: randomUUID(), chatId: chat.chatId, text: "来自编辑者的共享消息", runAgent: false },
        id,
      ),
    );
    const history = data<{ items: { text: string }[] }>(await a.call("project_chat_read", { chatId: chat.chatId }, id));
    assert.equal(history.items[0].text, "来自编辑者的共享消息");
    for (let i = 0; i < 30 && !b.events.some((e) => e.kind === "message_added"); i++) await pause(100);
    assert(b.events.some((e) => e.kind === "message_added"));
    assert(!JSON.stringify(a.personal).includes(chat.chatId));
    assert(!JSON.stringify(b.personal).includes(chat.chatId));
  });
  await check("撤权后旧连接和HTTP上传均拒绝", async () => {
    const members = data<{ items: { tenantId: string; revision: number }[] }>(await a.call("project_members", {}, id));
    const member = members.items.find((m) => m.tenantId === ids[1])!;
    data(
      await a.call(
        "project_member_remove",
        { operationId: randomUUID(), targetTenantId: ids[1], expectedMemberRevision: member.revision },
        id,
      ),
    );
    const denied = await b.call("project_file_read", { path: "docs/shared.txt" }, id);
    assert(!denied.ok && denied.error.code === "NOT_ACCESSIBLE");
    const response = await fetch(`http://127.0.0.1:${port}/upload/projects/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens[ids[1]]}`, "X-Jiebo-Project-Protocol": "1" },
      body: "不应写入",
    });
    assert.equal(response.status, 403);
  });
  if (process.argv.includes("--ui")) {
    await check("浏览器登录、共享项目编辑与查看者读取", async () => {
      webProcess = spawn(process.execPath, ["server.mjs"], {
        cwd: join(root, "web"),
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: "18462",
          NODE_ENV: "production",
          NEXT_PUBLIC_BASE_PATH: "/cursor-remote",
          GATEWAY_WS_URL: `ws://127.0.0.1:${port}`,
        },
        stdio: ["ignore", logFd, logFd],
      });
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch("http://127.0.0.1:18462/cursor-remote/")).ok) break;
        } catch {}
        await pause(100);
      }
      const kit = "/opt/cursor-remote-test/ui-kit";
      const require = createRequire(resolve(kit, "node_modules/index.js"));
      const { chromium } = require("playwright");
      const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu"] });
      const problems: string[] = [];
      let lastPage:
        | {
            screenshot: (options: { path: string; fullPage: boolean }) => Promise<unknown>;
            getByRole: (role: string, options: { name: string }) => { innerText: () => Promise<string> };
          }
        | undefined;
      const inspectSocket = (
        page: {
          on: (
            event: string,
            handler: (socket: { on: (event: string, callback: (frame: { payload: string }) => void) => void }) => void,
          ) => void;
        },
        account: string,
      ) =>
        page.on("websocket", (socket) => {
          socket.on("framereceived", (frame) => {
            try {
              const message = JSON.parse(String(frame.payload));
              if (message.type === "project_access_revoked" || (message.type === "project_result" && !message.ok))
                console.log(
                  JSON.stringify({
                    uiAccount: account,
                    type: message.type,
                    error: message.error,
                    workspaceId: message.workspaceId,
                  }),
                );
            } catch {
              /* 非项目消息不记录。 */
            }
          });
        });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
        await context.addInitScript(
          (token: string) => localStorage.setItem("cursor-remote-token", token),
          tokens[ids[0]],
        );
        const page = await context.newPage();
        lastPage = page;
        inspectSocket(page, "owner");
        page.on("pageerror", (e: Error) => problems.push(e.message));
        page.setDefaultTimeout(20000);
        await page.goto("http://127.0.0.1:18462/cursor-remote/");
        await page.getByRole("button", { name: "共享项目", exact: true }).click();
        const panel = page.getByRole("dialog", { name: "共享项目" });
        await panel.getByRole("button", { name: project.title + " · owner", exact: true }).click();
        await panel.getByLabel("相对路径", { exact: true }).fill("docs/browser.txt");
        await panel.getByLabel("文件内容", { exact: true }).fill("上海浏览器实际保存");
        await panel.getByRole("button", { name: "保存文件", exact: true }).click();
        await panel.getByText("已保存到共享项目", { exact: true }).waitFor();
        assert.equal(
          data<{ text: string }>(await v.call("project_file_read", { path: "docs/browser.txt" }, id)).text,
          "上海浏览器实际保存",
        );
        mkdirSync("/opt/cursor-remote-test/project-shots", { recursive: true });
        await page.screenshot({
          path: "/opt/cursor-remote-test/project-shots/shared-project-owner.png",
          fullPage: true,
        });
        const viewer = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
        await viewer.addInitScript(
          (token: string) => localStorage.setItem("cursor-remote-token", token),
          tokens[ids[2]],
        );
        const vp = await viewer.newPage();
        lastPage = vp;
        inspectSocket(vp, "viewer");
        await vp.goto("http://127.0.0.1:18462/cursor-remote/");
        await vp.getByRole("button", { name: "共享项目", exact: true }).click();
        const view = vp.getByRole("dialog", { name: "共享项目" });
        await view.getByRole("button", { name: project.title + " · viewer", exact: true }).click();
        await view.getByRole("button", { name: "docs/browser.txt", exact: true }).click();
        await view.getByLabel("文件内容", { exact: true }).waitFor();
        await vp.waitForFunction(() =>
          Array.from(document.querySelectorAll("textarea")).some((e) => e.value === "上海浏览器实际保存"),
        );
        assert.equal(await view.getByLabel("文件内容", { exact: true }).inputValue(), "上海浏览器实际保存");
        assert.equal(await view.getByRole("button", { name: "保存文件", exact: true }).isDisabled(), true);
        await vp.screenshot({
          path: "/opt/cursor-remote-test/project-shots/shared-project-viewer.png",
          fullPage: true,
        });
        assert.deepEqual(problems, []);
      } catch (error) {
        console.log(
          "共享页面失败状态：" +
            (await lastPage
              ?.getByRole("dialog", { name: "共享项目" })
              .innerText()
              .catch(() => "<页面已离开>")),
        );
        mkdirSync("/opt/cursor-remote-test/project-shots", { recursive: true });
        await lastPage?.screenshot({
          path: "/opt/cursor-remote-test/project-shots/shared-project-failure.png",
          fullPage: true,
        });
        throw error;
      } finally {
        await browser.close();
      }
    });
  }
  data(await a.call("project_archive", { operationId: randomUUID() }, id));
  console.log(
    JSON.stringify({
      suite: "project-gateway-e2e",
      host: hostname(),
      node: process.version,
      checks,
      storeIdentity: "cr-project-store",
      gatewayIdentity: "cr-test",
      externalModelCalls: false,
      createdProjectId: id,
      finishedAt: new Date().toISOString(),
    }),
  );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.terminate();
  webProcess?.kill("SIGTERM");
  gateway.kill("SIGTERM");
  await Promise.race([new Promise((r) => gateway.once("exit", r)), pause(5000)]);
  if (gateway.exitCode === null) gateway.kill("SIGKILL");
  closeSync(logFd);
  rmSync(temp, { recursive: true, force: true });
}
