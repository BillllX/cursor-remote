// 真实锁版 SDK/CLI 验证：覆盖禁用占位防崩、子工作区技能工厂/记忆读写、个人助理全量工具挂载、同进程续轮与独立进程重启恢复。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { listSkillProposals } from "../../src/assistant/skills.ts";
import { listTodos } from "../../src/assistant/todos.ts";
import { buildCodexChildEnv, codexHomeDir, hasCodexAuth, readCodexModelSlugs } from "../../src/chat/codexRunner.ts";
import { DISABLED_JIEBO_MCP_CONFIG, startCodexSkillBridge } from "../../src/chat/codexSkillBridge.ts";
import { gatewayEnv } from "../../src/config.ts";
import { assistantChatIdOf } from "../../src/runtime/chats.ts";
import { hydrateConn, persistConn, slotOf } from "../../src/runtime/slots.ts";
import { liveSlotsOf } from "../../src/runtime/state.ts";
import type { Conn } from "../../src/runtime/types.ts";
import { allTenants } from "../../src/tenants.ts";

async function phase(dir: string, modeName: "start" | "resume" | "assistant") {
  process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "none.json");
  process.env.CURSOR_REMOTE_TOKEN = "bridge-smoke-local";
  process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
  process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
  process.env.CURSOR_REMOTE_MEDIA_SECRET = "bridge-smoke-local";
  process.env.CURSOR_REMOTE_SANDBOX = "0";
  delete process.env.CODEX_SKILL_BRIDGE; // 验证默认开启
  const subWs = join(dir, "ws", "demo-proj");
  mkdirSync(subWs, { recursive: true });
  assert.ok(hasCodexAuth(), "缺少真实 CLI 登录凭证");
  const tenant = allTenants()[0];
  const isAssistant = modeName === "assistant";
  const resume = modeName === "resume";
  const cwd = isAssistant ? tenant.workspaceRoot : subWs;
  const ws = { readyState: 1, bufferedAmount: 0, send() {} } as unknown as Conn["ws"];
  const conn = { ws, tenant, cwd, authed: true, slots: liveSlotsOf(tenant) } as Conn;
  hydrateConn(conn);
  const chatId = isAssistant ? assistantChatIdOf(tenant) : "bridge-smoke";
  const slot = slotOf(conn, chatId);
  slot.cwd = cwd;
  const savedId = slot.codexThreadId;
  if (resume) {
    assert.ok(savedId);
    assert.equal(slot.mode, "agent");
  }
  slot.finished = false;
  slot.epoch++;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 110_000);
  const bridge = await startCodexSkillBridge(conn, slot, cwd, slot.epoch, abort.signal);
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
      workingDirectory: cwd,
      sandboxMode: "danger-full-access" as const,
      approvalPolicy: "never" as const,
      skipGitRepoCheck: true,
    };

    if (isAssistant) {
      const thread = client.startThread(options);
      const seen: string[] = [];
      const prompt =
        "你是用户的个人助理。请依次通过 jiebo MCP 调用 todo_add(text='核验 Codex 全量桥接', due='2026-11-20') 与 skill_proposal_list(status='pending')。不要使用 Shell、文件工具或网络。完成后仅回复‘助理桥接验证完成’。";
      const { events } = await thread.runStreamed(prompt, { signal: abort.signal });
      for await (const event of events) {
        if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
          assert.equal(event.item.server, "jiebo");
          assert.equal(event.item.status, "completed", event.item.error?.message);
          seen.push(event.item.tool);
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
      }
      assert.ok(seen.includes("todo_add"), "真实 CLI 应成功调用 todo_add");
      assert.ok(seen.includes("skill_proposal_list"), "真实 CLI 应成功调用 skill_proposal_list");
      assert.ok(
        listTodos({ id: tenant.id, stateDir: tenant.stateDir }).some((t) => t.text.includes("核验 Codex 全量桥接")),
      );
      console.log(
        JSON.stringify({
          phase: "assistant-full-tools",
          model,
          toolsCount: bridge.toolNames.length,
          tools: seen,
          ok: true,
        }),
      );
      return;
    }

    const thread = savedId ? client.resumeThread(savedId, options) : client.startThread(options);
    const turns = resume ? 1 : 2;
    const seen: string[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const prompt =
        resume || turn > 0
          ? "这是同一线程续轮。必须通过 jiebo 的 skill_verify 核验 canvas-artifact-builder，并调用 skill_mark_used(id='canvas-artifact-builder')。不要使用 Shell、文件工具或网络。然后仅回复‘续接完成’。"
          : "请通过 jiebo MCP 依次调用：1) skill_list(query='技能工厂')；2) skill_use(id='canvas-artifact-builder', limit=120)；3) skill_use(id='canvas-artifact-builder', cursor=上一页nextCursor, limit=120)；4) workspace_memory_propose(section='约定', text='临时探针验证记忆写入')；5) skill_propose(id='smoke-demo-sop', name='探针技能草案', summary='验证真实 CLI 发起技能提案', body='# 步骤\\n1. 只读检查文件。')。不要使用 Shell、文件工具或网络。完成后仅回复‘桥接验证完成’。";
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
    assert.ok(seen.includes("skill_mark_used"));
    if (!resume) {
      assert.ok(seen.includes("skill_list"));
      assert.ok(seen.filter((name) => name === "skill_use").length >= 2);
      assert.ok(seen.includes("workspace_memory_propose"));
      assert.ok(seen.includes("skill_propose"));
      assert.equal(listSkillProposals(tenant, "pending").length, 1);
    }
    let cancellationPassed = false;
    if (resume) {
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
  await phase(phaseDir, (process.argv[4] as "start" | "resume" | "assistant") || "start");
} else {
  const dir = mkdtempSync(join(tmpdir(), "jb-cli-smoke-"));
  try {
    const cli = existsSync(resolve("node_modules/.bin/codex"))
      ? resolve("node_modules/.bin/codex")
      : resolve("../node_modules/.bin/codex");
    const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(version.status, 0);
    console.log(version.stdout.trim());

    // 先验证禁用配置不会触发 invalid transport in mcp_servers.jiebo
    const disabledSrv = (DISABLED_JIEBO_MCP_CONFIG.mcp_servers as Record<string, { command: string; enabled: boolean }>)
      .jiebo;
    const disabledCheck = spawnSync(
      cli,
      [
        "-c",
        `mcp_servers.jiebo.command=${JSON.stringify(disabledSrv.command)}`,
        "-c",
        `mcp_servers.jiebo.enabled=${String(disabledSrv.enabled)}`,
        "mcp",
        "list",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(disabledCheck.status, 0, disabledCheck.stderr);

    for (const name of ["start", "resume", "assistant"] as const) {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(import.meta.url), "--phase", dir, name],
        { encoding: "utf8", timeout: 120_000 },
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
