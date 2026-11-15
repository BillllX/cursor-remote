import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import {
  decideSkillProposal,
  editApprovedDeclarativeSkill,
  listSkillProposals,
  listSkills,
  proposeSkillPackage,
  updateSkillMeta,
  type UseSkillResult,
} from "../src/assistant/skills.ts";
import {
  CODEX_SKILL_TOOLS,
  DISABLED_JIEBO_MCP_CONFIG,
  startCodexSkillBridge,
  type StartCodexBridgeOpts,
} from "../src/chat/codexSkillBridge.ts";
import { initKbWorkspaceConfig } from "../src/ingest/contract.ts";
import { assistantChatIdOf } from "../src/runtime/chats.ts";
import { hydrateConn, persistTenant, slotOf } from "../src/runtime/slots.ts";
import { gatewayState, liveSlotsOf } from "../src/runtime/state.ts";
import type { Conn } from "../src/runtime/types.ts";
import { allTenants } from "../src/tenants.ts";
import { openWorkspaceAgent } from "../src/workspace/agents.ts";

const dir = mkdtempSync(join(tmpdir(), "jb-bridge-test-"));
process.env.CURSOR_REMOTE_TENANTS_FILE = join(dir, "none.json");
process.env.CURSOR_REMOTE_TOKEN = "bridge-test";
process.env.CURSOR_REMOTE_CWD = join(dir, "ws");
process.env.CURSOR_REMOTE_STATE_DIR = join(dir, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "bridge-test-secret";
process.env.CURSOR_REMOTE_SANDBOX = "0";
delete process.env.CODEX_SKILL_BRIDGE; // 验证默认开启（1）
after(() => rmSync(dir, { recursive: true, force: true }));

type RpcFrame = {
  id: number;
  error: { code: number; message?: string };
  result: {
    serverInfo: { name: string };
    tools: { name: string; inputSchema: Record<string, unknown> }[];
    content: { text: string }[];
    isError?: boolean;
  };
  payload: Extract<UseSkillResult, { ok: true }> & Record<string, unknown>;
};

let next = 0;
async function fixture(
  opts: {
    assistant?: boolean;
    kbWorkspace?: boolean;
    bridgeOpts?: StartCodexBridgeOpts;
  } = {},
) {
  const base = allTenants()[0];
  const subName = `case-${++next}`;
  const subDir = join(base.workspaceRoot, subName);
  mkdirSync(subDir, { recursive: true });
  if (opts.kbWorkspace) {
    assert.equal(
      initKbWorkspaceConfig(subDir, {
        title: `测试知识库 ${subName}`,
        allowedCategories: ["资金", "资产"],
      }).ok,
      true,
    );
    openWorkspaceAgent(base, subName);
  }
  const cwd = opts.assistant ? base.workspaceRoot : subDir;
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send() {} } as unknown as WebSocket;
  const tenant = { ...base, admin: true, sandbox: false };
  const conn = {
    ws,
    cwd,
    model: "codex:gpt-6.1-sol",
    authed: true,
    ip: "127.0.0.1",
    tenant,
    slots: liveSlotsOf(tenant),
    policy: "baseline",
    caps: new Set(),
    maxMessageBytes: 0,
  } as Conn;
  const chatId = opts.assistant ? assistantChatIdOf(tenant) : `bridge-${next}`;
  const slot = slotOf(conn, chatId);
  slot.cwd = cwd;
  slot.finished = false;
  slot.epoch++;
  const abort = new AbortController();
  const bridge = await startCodexSkillBridge(conn, slot, cwd, slot.epoch, abort.signal, opts.bridgeOpts);
  const server = (bridge.config.mcp_servers as Record<string, { args: string[]; tool_timeout_sec: number }>).jiebo;
  const child = spawn(process.execPath, server.args, {
    env: { PATH: process.env.PATH, ...bridge.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  child.stdin.on("error", () => {});
  let buffer = "";
  let id = 0;
  const pending = new Map<number, (value: RpcFrame) => void>();
  const frames: RpcFrame[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffer += text;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const frame = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      frames.push(frame);
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    }
  });
  function rpc(method: string, params?: unknown) {
    const requestId = ++id;
    return new Promise<RpcFrame>((done, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`RPC 超时：${method}`));
      }, 3000);
      pending.set(requestId, (value) => {
        clearTimeout(timer);
        done(value);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
  }
  async function init() {
    const response = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(response.result.serverInfo.name, "jiebo");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await rpc("ping");
  }
  async function call(name: string, args: unknown = {}) {
    const response = await rpc("tools/call", { name, arguments: args });
    return { ...response, payload: response.result ? JSON.parse(response.result.content[0].text) : undefined };
  }
  async function close() {
    await bridge.close();
    await exit;
  }
  return { tenant, conn, slot, cwd, abort, bridge, server, child, exit, rpc, call, init, frames, close };
}

test("子工作区全量工具挂载、参数校验、统计去重、记忆读写与技能工厂提案幂等", async () => {
  const f = await fixture();
  try {
    assert.equal(statSync(dirname(f.bridge.env.JIEBO_MCP_SOCKET)).mode & 0o777, 0o700);
    assert.equal(statSync(f.bridge.env.JIEBO_MCP_SOCKET).mode & 0o777, 0o600);
    assert.equal(f.server.tool_timeout_sec, 300);
    assert.ok(!JSON.stringify(f.bridge.config).includes(f.bridge.env.JIEBO_MCP_TOKEN));
    assert.ok(!f.child.spawnargs.join(" ").includes(f.bridge.env.JIEBO_MCP_TOKEN));
    assert.ok((await f.rpc("tools/list")).error);
    await f.init();

    const toolNames = (await f.rpc("tools/list")).result.tools.map((t) => t.name);
    for (const requiredTool of [
      ...CODEX_SKILL_TOOLS,
      "skill_mark_used",
      "skill_propose",
      "workspace_memory_propose",
      "workspace_memory_search",
      "workspace_memory_mark_used",
    ]) {
      assert.ok(toolNames.includes(requiredTool), `子工作区桥接应包含 ${requiredTool}`);
    }
    // 子工作区不向模型暴露全局技能审批工具（防自提自批）或个人记忆工具
    assert.equal(toolNames.includes("skill_proposal_decide"), false);
    assert.equal(toolNames.includes("memory_save"), false);

    // JSON Schema 参数边界拦截
    assert.equal((await f.call("skill_propose", { id: "no" })).error.code, -32602);
    assert.equal((await f.call("skill_use", { id: "../../secret" })).error.code, -32602);
    assert.equal((await f.call("skill_use", { id: "canvas-artifact-builder", limit: 2401 })).error.code, -32602);
    assert.equal((await f.call("skill_use", { id: "canvas-artifact-builder", limit: 0 })).error.code, -32602);
    assert.equal((await f.call("skill_list", { unexpected: "no" })).error.code, -32602);
    assert.equal((await f.call("skill_list", { constructor: "no" })).error.code, -32602);
    assert.equal((await f.call("unmounted_tool", {})).error.code, -32602);

    // 内置技能工厂 SOP 可查可读
    const listedFactory = await f.call("skill_list", { query: "技能工厂" });
    assert.ok(JSON.stringify(listedFactory.payload).includes("skill-factory-guide"));
    const factorySop = await f.call("skill_use", { id: "skill-factory-guide", limit: 400 });
    assert.equal(factorySop.payload.ok, true);

    // 查阅与采用计数同轮同版本去重
    const before = listSkills(f.tenant, f.cwd).find((s) => s.id === "canvas-artifact-builder")!.stats;
    const first = await f.call("skill_use", { id: "canvas-artifact-builder", limit: 100 });
    assert.equal(first.payload.ok, true);
    assert.equal(first.payload.stats.viewedCount, before.viewedCount + 1);
    const repeated = await f.call("skill_use", { id: "canvas-artifact-builder", limit: 100 });
    assert.equal(repeated.payload.stats.viewedCount, before.viewedCount + 1);

    const adopt1 = await f.call("skill_mark_used", { id: "canvas-artifact-builder" });
    assert.equal(adopt1.payload.ok, true);
    assert.equal((adopt1.payload.stats as { adoptedCount: number }).adoptedCount, before.adoptedCount + 1);
    const adopt2 = await f.call("skill_mark_used", { id: "canvas-artifact-builder" });
    assert.equal((adopt2.payload.stats as { adoptedCount: number }).adoptedCount, before.adoptedCount + 1);

    // 工作区记忆闭环：propose -> search -> mark_used
    const memWrite = await f.call("workspace_memory_propose", {
      section: "约定",
      text: "Codex 桥接测试工作区统一走 npm test 验证",
    });
    assert.equal(memWrite.payload.ok, true);
    const memSearch = await f.call("workspace_memory_search", { query: "Codex 桥接测试" });
    const hits =
      (memSearch.payload as unknown as { matches?: Array<{ id?: string; text: string }> }).matches ??
      (Array.isArray(memSearch.payload) ? (memSearch.payload as Array<{ id?: string; text: string }>) : []);
    assert.ok(JSON.stringify(memSearch.payload).includes("Codex 桥接测试工作区"));
    const firstHitId = hits[0]?.id;
    if (firstHitId) {
      const memMarked = await f.call("workspace_memory_mark_used", { id: firstHitId });
      assert.equal(memMarked.payload.ok, true);
    }

    // 技能工厂提案闭环（含同轮重复参数幂等复用）
    const propArgs = {
      id: "codex-demo-sop",
      name: "Codex 提案验证手册",
      summary: "验证 Codex 通过 MCP 提交技能草案到隔离区",
      mode: "read",
      requiredTools: "read, grep",
      body: "# 步骤\n1. 先只读检查目录结构。\n2. 核对输出一致性。",
    };
    const prop1 = await f.call("skill_propose", propArgs);
    const prop2 = await f.call("skill_propose", propArgs);
    assert.equal(prop1.payload.ok, true);
    assert.equal(
      (prop1.payload.proposal as { id: string }).id,
      (prop2.payload.proposal as { id: string }).id,
      "同轮重复提交相同提案应幂等返回同一草案",
    );

    assert.equal((await f.call("skill_verify", { id: "canvas-artifact-builder" })).payload.ok, true);
    assert.equal((await f.rpc("unknown/method")).error.code, -32601);
    f.child.stdin.write("{invalid-json\n");
    await f.rpc("ping");
    assert.ok(f.frames.some((frame) => frame.error?.code === -32700));
  } finally {
    await f.close();
  }
  assert.equal(existsSync(f.bridge.env.JIEBO_MCP_SOCKET), false);
});

test("知识库工作区与只读委派模式工具边界及置顶个人助理全量管家工具闭环", async () => {
  // 1. 已启用 kb.json 的知识库子工作区：挂载归档、企微检索/检查/同步/管理与工程定时任务
  const kb = await fixture({ kbWorkspace: true });
  try {
    await kb.init();
    const kbTools = (await kb.rpc("tools/list")).result.tools.map((t) => t.name);
    for (const expected of [
      "kb_ingest_submit",
      "wecom_search",
      "wecom_watch_check",
      "wecom_watch_sync",
      "wecom_watch_manage",
      "workspace_schedule_manage",
      "skill_propose",
    ]) {
      assert.ok(kbTools.includes(expected), `知识库子工作区应挂载 ${expected}`);
    }
    const watchList = await kb.call("wecom_watch_manage", { action: "list" });
    assert.equal(watchList.result.isError, false);
    const schedList = await kb.call("workspace_schedule_manage", { action: "list" });
    assert.equal(schedList.payload.ok, true);
  } finally {
    await kb.close();
  }

  // 2. 只读模式（readonly: true）：剥离 skill_propose 与所有可写知识库/企微同步工具
  const ro = await fixture({ kbWorkspace: true, bridgeOpts: { readonly: true } });
  try {
    await ro.init();
    const roTools = (await ro.rpc("tools/list")).result.tools.map((t) => t.name);
    for (const forbidden of [
      "skill_propose",
      "kb_ingest_submit",
      "wecom_watch_sync",
      "wecom_watch_manage",
      "workspace_schedule_manage",
    ]) {
      assert.equal(roTools.includes(forbidden), false, `只读委派严禁挂载 ${forbidden}`);
    }
    assert.equal(roTools.includes("wecom_search"), true);
    assert.equal(roTools.includes("wecom_watch_check"), true);
  } finally {
    await ro.close();
  }

  // 3. 置顶个人助理根会话（assistant-<tenantId>）：挂载完整管家工具并能跑通待办与技能审批
  const assistant = await fixture({ assistant: true });
  try {
    await assistant.init();
    const assistantTools = (await assistant.rpc("tools/list")).result.tools;
    const names = assistantTools.map((t) => t.name);
    for (const expected of [
      "memory_search",
      "memory_save",
      "work_preference_add",
      "todo_list",
      "todo_add",
      "todo_done",
      "schedule_list",
      "schedule_set",
      "inbox_post",
      "delegate",
      "create_workspace",
      "gateway_calendar_events_list",
      "gateway_calendar_event_add",
      "kb_workspace_init",
      "drop_token_list",
      "colleague_proposal_list",
      "skill_proposal_list",
      "skill_proposal_decide",
    ]) {
      assert.ok(names.includes(expected), `个人助理根会话应挂载 ${expected}`);
    }
    // 校验所有暴露工具的 JSON Schema 结构完整（required 字段均在 properties 中）
    for (const t of assistantTools) {
      assert.equal(t.inputSchema.type, "object", `${t.name} schema 顶层应为 object`);
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      const req = (t.inputSchema.required ?? []) as string[];
      for (const k of req) {
        assert.ok(Object.hasOwn(props, k), `${t.name} required 字段 ${k} 必须存在于 properties`);
      }
    }

    const addedTodo = await assistant.call("todo_add", {
      text: "周五复盘 Fintopia 归档看板",
      due: "2026-11-20",
    });
    assert.equal(addedTodo.payload.ok, true);
    const todos = await assistant.call("todo_list", {});
    assert.ok(JSON.stringify(todos.payload).includes("周五复盘 Fintopia 归档看板"));

    // 助理审批前序测试提交的待审技能草案
    const pendingList = listSkillProposals(assistant.tenant, "pending");
    assert.ok(pendingList.length >= 1);
    const decideRes = await assistant.call("skill_proposal_decide", {
      proposalId: pendingList[0]!.id,
      approve: true,
      expectedRev: pendingList[0]!.rev,
      decisionNote: "助理根会话通过 MCP 批准上架",
    });
    assert.equal(decideRes.payload.ok, true);
  } finally {
    await assistant.close();
  }

  // 4. 校验禁用占位配置带合法 stdio command，防 Codex CLI 报 invalid transport
  const disabledJiebo = (DISABLED_JIEBO_MCP_CONFIG.mcp_servers as Record<string, Record<string, unknown>>).jiebo;
  assert.equal(disabledJiebo.enabled, false);
  assert.equal(disabledJiebo.command, "true");
});

function bodyOf(content: string) {
  return content.split("\n").slice(1, -2).join("\n");
}
test("长 SOP 完整分页、版本变化与停用阻断续页", async () => {
  const f = await fixture();
  try {
    const body = "# 分页测试\n" + "只读核对第一个步骤并检查结果。\n".repeat(400);
    const proposed = proposeSkillPackage(f.tenant, f.cwd, {
      id: "long-bridge-sop",
      name: "长手册",
      summary: "分页验证",
      body,
      mode: "read",
      requiredTools: ["read"],
    });
    assert.ok(proposed.ok);
    assert.ok(
      decideSkillProposal(f.tenant, {
        proposalId: proposed.proposal.id,
        approve: true,
        expectedRev: proposed.proposal.rev,
      }).ok,
    );
    await f.init();
    let page = (await f.call("skill_use", { id: "long-bridge-sop", limit: 1000 })).payload;
    const firstCursor = page.nextCursor;
    const count = page.stats.viewedCount;
    const parts = [bodyOf(page.content)];
    while (page.nextCursor) {
      page = (await f.call("skill_use", { id: "long-bridge-sop", cursor: page.nextCursor, limit: 1000 })).payload;
      assert.equal(page.ok, true);
      assert.equal(page.stats.viewedCount, count);
      parts.push(bodyOf(page.content));
    }
    assert.equal(parts.join(""), body.trim());
    const manifest = listSkills(f.tenant, f.cwd).find((s) => s.id === "long-bridge-sop")!;
    assert.ok(
      editApprovedDeclarativeSkill(f.tenant, f.cwd, {
        skillId: manifest.id,
        entry: manifest.entry,
        expectedSha256: manifest.sha256!,
        name: manifest.name,
        summary: manifest.summary,
        requiredTools: manifest.requiredTools,
        body: body + "\n新版",
      }).ok,
    );
    assert.equal((await f.call("skill_use", { id: "long-bridge-sop", cursor: firstCursor })).payload.ok, false);
    const current = (await f.call("skill_use", { id: "long-bridge-sop", limit: 100 })).payload;
    assert.equal(current.stats.viewedCount, count + 1);
    assert.ok(updateSkillMeta(f.tenant, f.cwd, { skillId: "long-bridge-sop", disabled: true }).ok);
    assert.equal((await f.call("skill_use", { id: "long-bridge-sop", cursor: current.nextCursor })).payload.ok, false);
  } finally {
    await f.close();
  }
});

test("每次调用复核管理员准入与工作区，取消后回收转发进程", async () => {
  const f = await fixture();
  try {
    await f.init();
    f.tenant.admin = false;
    assert.ok((await f.rpc("tools/list")).error);
    f.tenant.admin = true;
    f.slot.cwd = f.tenant.workspaceRoot;
    assert.ok((await f.rpc("tools/list")).error);
    f.slot.cwd = f.cwd;
    f.abort.abort();
    await f.exit;
  } finally {
    await f.close();
  }
});

test("错误令牌不能连接，分片 JSON 可解析，EOF 退出", async () => {
  const f = await fixture();
  try {
    const socket = connect(f.bridge.env.JIEBO_MCP_SOCKET);
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(JSON.stringify({ token: "bad", message: { id: 1, jsonrpc: "2.0", method: "initialize" } }) + "\n");
    await closed;
    await f.init();
    f.child.stdin.write('{"jsonrpc":"2.0","id":900,"meth');
    f.child.stdin.write('od":"ping"}\n');
    await f.rpc("ping");
    assert.ok(f.frames.some((frame) => frame.id === 900 && frame.result));
    f.child.stdin.end();
    await f.exit;
  } finally {
    await f.close();
  }
});

test("超限输入使转发器退出，网关清理 socket", async () => {
  const f = await fixture();
  try {
    await f.init();
    f.child.stdin.write("x".repeat(1024 * 1024 + 1));
    await f.exit;
  } finally {
    await f.close();
  }
});

test("槽位持久化后重建保留 Agent 默认值、线程与策略", async () => {
  const f = await fixture();
  try {
    f.slot.codexThreadId = "saved-thread";
    f.slot.lastEngine = "codex";
    f.slot.policy = "plane";
    f.slot.dialect = false;
    persistTenant(f.tenant, f.conn.slots);
    f.conn.slots.delete(f.slot.chatId);
    hydrateConn(f.conn);
    const hydrated = f.conn.slots.get(f.slot.chatId)!;
    assert.equal(hydrated.mode, "agent");
    assert.equal(hydrated.codexThreadId, "saved-thread");
    assert.equal(hydrated.policy, "plane");
    assert.equal(hydrated.dialect, false);
    gatewayState.liveByTenant.delete(f.tenant.id);
  } finally {
    await f.close();
  }
});

test("Unicode 单字符分页完整，空游标作为首页，伪造半个字符游标拒绝", async () => {
  const f = await fixture();
  try {
    const body = "# 手册😀𠮷结束";
    const proposal = proposeSkillPackage(f.tenant, f.cwd, {
      id: "unicode-sop",
      name: "字符手册",
      summary: "字符边界验证",
      body,
      mode: "read",
      requiredTools: ["read"],
    });
    assert.ok(proposal.ok);
    assert.ok(
      decideSkillProposal(f.tenant, {
        proposalId: proposal.proposal.id,
        expectedRev: proposal.proposal.rev,
        approve: true,
      }).ok,
    );
    await f.init();
    let page = (await f.call("skill_use", { id: "unicode-sop", limit: 1, cursor: "" })).payload;
    assert.equal(page.ok, true);
    const version = page.version;
    let text = "";
    while (true) {
      const part = bodyOf(page.content);
      assert.equal(Array.from(part).length, 1);
      text += part;
      if (!page.nextCursor) break;
      page = (await f.call("skill_use", { id: "unicode-sop", limit: 1, cursor: page.nextCursor })).payload;
      assert.equal(page.ok, true);
    }
    assert.equal(text, body);
    assert.equal(
      (await f.call("skill_use", { id: "unicode-sop", cursor: `${version}:${body.indexOf("😀") + 1}` })).payload.ok,
      false,
    );
  } finally {
    await f.close();
  }
});

test("stdin EOF 等待已经发出的响应后退出", async () => {
  const f = await fixture();
  try {
    await f.init();
    const response = f.rpc("tools/list");
    f.child.stdin.end();
    assert.equal((await response).result.tools.length, f.bridge.toolNames.length);
    await f.exit;
  } finally {
    await f.close();
  }
});
