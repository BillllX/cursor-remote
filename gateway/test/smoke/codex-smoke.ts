// Codex CLI 真实二进制端到端冒烟验证（使用已登录的 ~/.codex/auth.json 或 CODEX_API_KEY）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { codexModelIds, codexRoute, hasCodexAuth, runCodexChat } from "../../src/chat/codexRunner.ts";
import { slotOf } from "../../src/runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../../src/runtime/state.ts";
import type { Conn } from "../../src/runtime/types.ts";
import { allTenants } from "../../src/tenants.ts";

const dir = mkdtempSync(join(tmpdir(), "cr-codex-smoke-"));
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "missing-tenants.json");
process.env.CURSOR_REMOTE_TOKEN = "codex-smoke-token";
process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "codex-smoke-secret";
process.env.CURSOR_REMOTE_SANDBOX = "0";

async function main() {
  try {
    if (!hasCodexAuth()) {
      console.log("SKIP smoke:codex — 未检测到 CODEX_API_KEY 或 ~/.codex/auth.json");
      return;
    }
    const tenant = allTenants()[0];
    const models = codexModelIds(tenant);
    assert.ok(models.length > 0, "codexModelIds 应返回至少 1 个可用模型");
    const chosen = models[0];
    const route = codexRoute(chosen);
    assert.ok(route, `codexRoute 应识别 ${chosen}`);

    const frames: Array<Record<string, unknown>> = [];
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (raw: string) => {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
      },
    } as unknown as WebSocket;

    gatewayState.wsTenant.set(ws, tenant.id);
    const conn: Conn = {
      cwd: tenant.workspaceRoot,
      model: chosen,
      authed: true,
      ip: "127.0.0.1",
      tenant,
      slots: liveSlotsOf(tenant),
      ws,
      maxMessageBytes: 0,
      caps: new Set(),
      policy: "baseline",
    };
    gatewayState.conns.set(ws, conn);
    const slot = slotOf(conn, "smoke-codex-chat");
    const epoch = ++slot.epoch;
    slot.finished = false;

    await runCodexChat(ws, conn, slot, route, {
      prompt: "请只回复数字 2，不要任何多余文字。",
      userText: "1+1等于几",
      images: [],
      history: [],
      epoch,
      cwd: tenant.workspaceRoot,
      mode: "ask",
      confirmWrites: false,
      autoApprove: false,
    });

    const text = frames
      .filter((f) => f.type === "text-delta")
      .map((f) => String(f.text || ""))
      .join("");
    const done = frames.find((f) => f.type === "done");
    assert.ok(slot.codexThreadId, "真实运行后应填充 slot.codexThreadId");
    assert.equal(done?.status, "completed", `运行应以 completed 结束，实际 frames: ${JSON.stringify(frames)}`);
    assert.ok(text.includes("2"), `模型回复应包含 2，实际: ${text}`);
    console.log(
      `PASS smoke:codex — model=${chosen} threadId=${slot.codexThreadId} reply=${JSON.stringify(text.trim())}`,
    );
  } finally {
    gatewayState.conns.clear();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
