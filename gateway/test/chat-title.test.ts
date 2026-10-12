import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.ts";

// providers.json 从状态目录读：指到空的临时目录，免得读到本机真实配置
const dir = mkdtempSync(join(tmpdir(), "cr-title-"));
process.env.CURSOR_REMOTE_STATE_DIR = dir;
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "missing-tenants.json");
after(() => rmSync(dir, { recursive: true, force: true }));

const { fallbackChatTitle, sanitizeChatTitle, titleChat } = await import("../src/chat/title.ts");
const { chatNameKey, createGatewayState, forgetChatName, markChatNamed } = await import("../src/runtime/state.ts");
type Deps = NonNullable<Parameters<typeof titleChat>[5]>;

const tenant = (id: string) => ({ id, name: id, stateDir: dir }) as Parameters<typeof titleChat>[1];
const ws = {} as WebSocket;

function harness(over: Partial<Deps> = {}) {
  const sent: ServerMessage[] = [];
  const calls: string[] = [];
  const state = createGatewayState();
  const deps: Partial<Deps> = {
    state,
    cursorApiKey: "",
    cursor: () => async () => {
      calls.push("cursor");
      return "Cursor 标题";
    },
    external: (model) =>
      model.startsWith("fake:")
        ? async (text) => {
            calls.push(`external:${model}:${text}`);
            return "第三方标题";
          }
        : null,
    emit: (_ws, message) => sent.push(message),
    ...over,
  };
  return { sent, calls, state, deps };
}

describe("titleChat", () => {
  test("有 Cursor 密钥：只用 Cursor 模型，不看会话模型", async () => {
    const h = harness({ cursorApiKey: "k" });
    await titleChat(ws, tenant("t1"), "c1", "帮我写个脚本", "fake:m1", h.deps);
    assert.deepEqual(h.calls, ["cursor"]);
    assert.deepEqual(h.sent, [{ type: "chat_title", chatId: "c1", title: "Cursor 标题" }]);
  });

  test("有 Cursor 密钥但起标题失败：不退回首条消息", async () => {
    const h = harness({
      cursorApiKey: "k",
      cursor: () => async () => {
        throw new Error("boom");
      },
    });
    await titleChat(ws, tenant("t1"), "c1", "帮我写个脚本", "", h.deps);
    assert.deepEqual(h.sent, []);
    assert.equal(h.state.namedChats.size, 0);
  });

  test("没有 Cursor 密钥：用会话当前的第三方模型", async () => {
    const h = harness();
    await titleChat(ws, tenant("t1"), "c1", "帮我写个脚本", "fake:m1", h.deps);
    assert.deepEqual(h.calls, ["external:fake:m1:帮我写个脚本"]);
    assert.deepEqual(h.sent, [{ type: "chat_title", chatId: "c1", title: "第三方标题" }]);
  });

  test("没有 Cursor 密钥，第三方失败、返回空或「新对话」、或不是第三方模型：退回首条消息前几个字", async () => {
    const failing = [
      async () => {
        throw new Error("down");
      },
      async () => "",
      async () => "新对话",
    ];
    for (const ask of failing) {
      const h = harness({ external: () => ask });
      await titleChat(ws, tenant("t1"), "c1", "把首页的按钮改成蓝色然后部署到测试环境", "fake:m1", h.deps);
      assert.deepEqual(h.sent, [{ type: "chat_title", chatId: "c1", title: "把首页的按钮改成蓝色然后部署到测" }]);
    }
    const h = harness();
    await titleChat(ws, tenant("t1"), "c1", "  \n 看看日志 \n第二行", "composer-1", h.deps);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.sent, [{ type: "chat_title", chatId: "c1", title: "看看日志" }]);
  });

  test("只有图片没有文字、也没有可用模型时不起标题", async () => {
    const h = harness();
    await titleChat(ws, tenant("t1"), "c1", "", "", h.deps);
    assert.deepEqual(h.sent, []);
  });

  test("已命名按租户 + 会话记：同 id 的另一个租户照样起标题，同一个不再起", async () => {
    const h = harness();
    await titleChat(ws, tenant("t1"), "c1", "一", "fake:m1", h.deps);
    await titleChat(ws, tenant("t1"), "c1", "二", "fake:m1", h.deps);
    await titleChat(ws, tenant("t2"), "c1", "三", "fake:m1", h.deps);
    assert.equal(h.sent.length, 2);
    assert.ok(h.state.namedChats.has(chatNameKey("t1", "c1")));
    assert.ok(h.state.namedChats.has(chatNameKey("t2", "c1")));
  });
});

describe("namedChats 清理", () => {
  test("会话删除时清掉；超过上限淘汰最早的", () => {
    const state = createGatewayState();
    markChatNamed(state, "t1", "a");
    markChatNamed(state, "t1", "b");
    forgetChatName(state, "t1", "a");
    assert.deepEqual([...state.namedChats], [chatNameKey("t1", "b")]);
    for (const id of ["c", "d", "e"]) markChatNamed(state, "t1", id, 3);
    assert.deepEqual(
      [...state.namedChats],
      ["c", "d", "e"].map((id) => chatNameKey("t1", id)),
    );
  });

  test("tombstoneChat 删会话时清掉进程内的 namedChats", async () => {
    const { gatewayState } = await import("../src/runtime/state.ts");
    const { tombstoneChat } = await import("../src/sync/storedState.ts");
    const { emptyDisk } = await import("../src/tenants.ts");
    const t = { id: "t9", name: "t9", stateDir: dir, workspaceRoot: dir, disk: emptyDisk() } as never;
    markChatNamed(gatewayState, "t9", "gone");
    tombstoneChat(t, "gone");
    assert.equal(gatewayState.namedChats.has(chatNameKey("t9", "gone")), false);
  });
});

describe("标题文本", () => {
  test("sanitizeChatTitle 去掉思考块、引号、前缀和结尾标点", () => {
    assert.equal(sanitizeChatTitle("<think>想一想</think>\n「修复登录」。"), "修复登录");
    assert.equal(sanitizeChatTitle("标题：部署脚本\n解释"), "部署脚本");
  });

  test("fallbackChatTitle 取第一行非空文字的前 16 个字", () => {
    assert.equal(fallbackChatTitle("# 读一下 README"), "读一下 README");
    assert.equal(fallbackChatTitle("一二三四五六七八九十一二三四五六七八九十"), "一二三四五六七八九十一二三四五六");
    assert.equal(fallbackChatTitle(""), "");
  });
});
