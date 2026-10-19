import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cancelTurnBodyRequest, startTurnBodyRequest } from "../lib/chat/turnBodyRequest";

describe("超大回合请求协调", () => {
  test("同 key 去重；点击另一回合会取消旧请求并启动新请求", () => {
    const first = startTurnBodyRequest(null, "chat-a:turn-1");
    assert.equal(first.started, true);
    assert.equal(startTurnBodyRequest(first.request, "chat-a:turn-1").started, false);

    const second = startTurnBodyRequest(first.request, "chat-a:turn-2");
    assert.equal(first.request.controller.signal.aborted, true);
    assert.equal(second.started, true);
    assert.equal(second.canceledKey, "chat-a:turn-1");
    assert.equal(second.request.controller.signal.aborted, false);
  });

  test("切换会话取消当前请求并返回需清理的 loading key", () => {
    const current = startTurnBodyRequest(null, "chat-a:turn-1").request;
    assert.equal(cancelTurnBodyRequest(current), "chat-a:turn-1");
    assert.equal(current.controller.signal.aborted, true);
    assert.equal(cancelTurnBodyRequest(null), undefined);
  });
});
