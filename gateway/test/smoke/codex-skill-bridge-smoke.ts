// 真实锁版 SDK/CLI 验证，仅在临时工作区读取技能；通过两次独立 Node 进程验证重启续接。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { buildCodexChildEnv, codexHomeDir, hasCodexAuth, readCodexModelSlugs } from "../../src/chat/codexRunner.ts";
import { startCodexSkillBridge } from "../../src/chat/codexSkillBridge.ts";
import { hydrateConn, persistConn, slotOf } from "../../src/runtime/slots.ts";
import { liveSlotsOf } from "../../src/runtime/state.ts";
import type { Conn } from "../../src/runtime/types.ts";
import { allTenants } from "../../src/tenants.ts";
import { gatewayEnv } from "../../src/config.ts";

async function phase(dir: string, resume: boolean) {
  process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "none.json");
  process.env.CURSOR_REMOTE_TOKEN = "bridge-smoke-local";
  process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
  process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
  process.env.CURSOR_REMOTE_MEDIA_SECRET = "bridge-smoke-local";
  process.env.CURSOR_REMOTE_SANDBOX = "0";
  process.env.CODEX_SKILL_BRIDGE = "1";
  mkdirSync(join(dir, "ws"), { recursive: true });
  assert.ok(hasCodexAuth(), "缺少真实 CLI 登录凭证");
  const tenant = allTenants()[0];
  const ws = { readyState: 1, bufferedAmount: 0, send() {} } as unknown as Conn["ws"];
  const conn = { ws, tenant, cwd: tenant.workspaceRoot, authed: true, slots: liveSlotsOf(tenant) } as Conn;
  hydrateConn(conn);
  const slot = slotOf(conn, "bridge-smoke");
  const savedId = slot.codexThreadId;
  if (resume) {
    assert.ok(savedId);
    assert.equal(slot.mode, "agent");
  }
  slot.finished = false;
  slot.epoch++;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 90_000);
  const bridge = await startCodexSkillBridge(conn, slot, tenant.workspaceRoot, slot.epoch, abort.signal);
  try {
    const env = { ...buildCodexChildEnv(), ...bridge.env };
    const client = new Codex({
      env,
      config: bridge.config,
      ...(gatewayEnv.codexApiKey() ? { apiKey: gatewayEnv.codexApiKey() } : {}),
      ...(gatewayEnv.codexBaseUrl() ? { baseUrl: gatewayEnv.codexBaseUrl() } : {}),
    });
    const model = readCodexModelSlugs()[0] || "gpt-6.1-sol";
    const options = {
      model,
      workingDirectory: tenant.workspaceRoot,
      sandboxMode: "danger-full-access" as const,
      approvalPolicy: "never" as const,
      skipGitRepoCheck: true,
    };
    const thread = savedId ? client.resumeThread(savedId, options) : client.startThread(options);
    const turns = resume ? 1 : 2;
    const seen: string[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const prompt =
        resume || turn > 0
          ? "这是同一线程续轮。必须通过 jiebo 的 skill_verify 核验 canvas-artifact-builder。不要使用 Shell、文件工具、网络或任何业务写工具。然后仅回复‘续接完成’。"
          : "请通过 jiebo MCP 依次调用 skill_list(query=canvas)、skill_use(id=canvas-artifact-builder,limit=120)、skill_use(id=canvas-artifact-builder,cursor=上一页nextCursor,limit=120)、skill_verify(id=canvas-artifact-builder)。不要使用 Shell、文件工具、网络或业务写工具。不要尝试读取凭据或配置。完成后回复‘桥接验证完成’。";
      const expectedId = slot.codexThreadId;
      const { events } = await thread.runStreamed(prompt, { signal: abort.signal });
      for await (const event of events) {
        if (event.type === "thread.started") {
          if (expectedId) assert.equal(event.thread_id, expectedId, "恢复必须保持原线程");
          slot.codexThreadId = event.thread_id;
          slot.lastEngine = "codex";
          persistConn(conn);
        }
        if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
          assert.equal(event.item.server, "jiebo");
          assert.equal(event.item.status, "completed", event.item.error?.message);
          seen.push(event.item.tool);
        }
        if (event.type === "item.completed")
          assert.ok(!["command_execution", "file_change"].includes(event.item.type), "探针不得执行 Shell 或修改文件");
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
      }
    }
    assert.ok(slot.codexThreadId);
    assert.ok(seen.includes("skill_verify"));
    if (!resume) {
      assert.ok(seen.includes("skill_list"));
      assert.ok(seen.filter((name) => name === "skill_use").length >= 2);
    }
    let cancellationPassed = false;
    if (resume) {
      // 真实 CLI 收到 turn.started 后取消，同时撤销本轮网关桥接。
      const cancelThread = client.resumeThread(slot.codexThreadId!, options);
      try {
        const stream = await cancelThread.runStreamed("等待测试取消，不调用任何工具。", { signal: abort.signal });
        for await (const event of stream.events) {
          if (event.type === "turn.started") abort.abort();
        }
      } catch {
        assert.ok(abort.signal.aborted, "只能接受主动取消引起的异常");
        cancellationPassed = true;
      }
      assert.ok(cancellationPassed, "真实 CLI 必须响应取消");
    }
    // 桥接不将临时令牌写入共享配置或认证文件。
    const home = codexHomeDir();
    for (const file of ["config.toml", "auth.json"]) {
      if (existsSync(join(home, file)))
        assert.ok(!readFileSync(join(home, file), "utf8").includes(bridge.env.JIEBO_MCP_TOKEN));
    }
    console.log(
      JSON.stringify({
        phase: resume ? "restart-resume" : "start-and-resume",
        model,
        thread: slot.codexThreadId,
        tools: seen,
        cancellationPassed,
        ok: true,
      }),
    );
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    for (const secret of Object.values(bridge.env)) message = message.split(secret).join("[已脱敏]");
    throw new Error(message);
  } finally {
    clearTimeout(deadline);
    await bridge.close();
  }
}

const phaseDir = process.argv[3];
if (process.argv[2] === "--phase" && phaseDir) {
  await phase(phaseDir, process.argv[4] === "resume");
} else {
  const dir = mkdtempSync(join(tmpdir(), "jb-cli-smoke-"));
  try {
    const cli = resolve("node_modules/.bin/codex");
    const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(version.status, 0);
    console.log(version.stdout.trim());
    for (const name of ["start", "resume"]) {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(import.meta.url), "--phase", dir, name],
        { encoding: "utf8", timeout: 110_000 },
      );
      process.stdout.write(child.stdout);
      if (child.status !== 0) {
        process.stderr.write(child.stderr);
        throw new Error(`真实 CLI ${name} 未通过，退出码 ${child.status}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
