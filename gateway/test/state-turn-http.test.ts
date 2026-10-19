import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { handleStateTurn } from "../src/http/routes.ts";
import { getTenant } from "../src/tenants.ts";

const base = mkdtempSync(join(tmpdir(), "cr-state-turn-"));
const token = "state-turn-test-token";
process.env.CURSOR_REMOTE_TENANTS_FILE = join(base, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = token;
process.env.CURSOR_REMOTE_CWD = join(base, "workspace");
process.env.CURSOR_REMOTE_STATE_DIR = join(base, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "state-turn-test-secret";

type Captured = { status: number; headers: Record<string, string>; body: string };

function request(url: string, bearer?: string): Captured {
  const req = {
    url,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  } as IncomingMessage;
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: string) {
      captured.body = body || "";
      return this;
    },
  } as unknown as ServerResponse;
  handleStateTurn(req, res);
  return captured;
}

before(() => {
  const tenant = getTenant("default");
  assert.ok(tenant);
  let hydrated = false;
  const chat = { id: "chat-1" } as Record<string, unknown>;
  Object.defineProperty(chat, "turns", {
    enumerable: true,
    get() {
      hydrated = true;
      return [
        {
          id: "turn-1",
          user: "完整问题",
          assistant: "完整回答",
          running: true,
          tools: [{ name: "shell", status: "running" }],
        },
      ];
    },
  });
  Object.defineProperty(chat, "hydrated", { get: () => hydrated });
  tenant.disk.chats = [chat];
  tenant.disk.chatRevs = { "chat-1": 12 };
  tenant.disk.deletedIds = ["deleted-chat"];
});

after(() => rmSync(base, { recursive: true, force: true }));

describe("GET /state/turn", () => {
  test("无 Bearer 返回 401", () => {
    assert.equal(request("/state/turn?chatId=chat-1&turnId=turn-1").status, 401);
  });

  test("不存在或已删除的回合返回 404", () => {
    assert.equal(request("/state/turn?chatId=missing&turnId=turn-1", token).status, 404);
    assert.equal(request("/state/turn?chatId=deleted-chat&turnId=turn-1", token).status, 404);
  });

  test("返回 hydrate 后的完整回合和 chatRev，非运行会话先 settle", () => {
    const response = request("/state/turn?chatId=chat-1&turnId=turn-1", token);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(JSON.parse(response.body), {
      chatId: "chat-1",
      turnId: "turn-1",
      chatRev: 12,
      turn: {
        id: "turn-1",
        user: "完整问题",
        assistant: "完整回答",
        running: false,
        queued: false,
        tools: [{ name: "shell", status: "error" }],
      },
    });
    const tenant = getTenant("default")!;
    assert.equal((tenant.disk.chats[0] as { hydrated?: boolean }).hydrated, true);
  });

  test("回合 getter 或序列化异常只返回 500", () => {
    const tenant = getTenant("default")!;
    const broken = { id: "turn-broken" } as Record<string, unknown>;
    Object.defineProperty(broken, "body", {
      enumerable: true,
      get() {
        throw new Error("broken getter");
      },
    });
    tenant.disk.chats.push({ id: "chat-broken", turns: [broken] });
    const response = request("/state/turn?chatId=chat-broken&turnId=turn-broken", token);
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), { error: "internal_error" });
  });
});
