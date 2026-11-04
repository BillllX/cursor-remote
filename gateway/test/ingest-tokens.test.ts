import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { assistantTools, assistantToolSpecs } from "../src/assistant/tools.ts";
import { isMutatingTool } from "../src/chat/tools.ts";
import {
  createDropToken,
  listDropTokens,
  resetDropAuthMemoryStateForTest,
  revokeDropToken,
  setupKbWorkspaceForTenant,
  verifyDropPasscodeAndCreateSession,
  verifyDropSessionToken,
  type DropTenantHost,
  type DropWorkspaceRef,
} from "../src/ingest/tokens.ts";
import { toolsForMode } from "../src/native/tools/registry.ts";

const tempDirs: string[] = [];

function makeTestEnv() {
  const base = join(tmpdir(), `drop-tokens-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stateDir = join(base, "state");
  const workspaceRoot = join(base, "workspaces");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  tempDirs.push(base);

  const registry = new Map<string, DropWorkspaceRef>();

  const addWorkspace = (key: string, id = `wsa_${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-000000000001`) => {
    const path = join(workspaceRoot, key);
    mkdirSync(path, { recursive: true });
    const ref: DropWorkspaceRef = { workspaceId: id, key, path };
    registry.set(key, ref);
    registry.set(id, ref);
    return ref;
  };

  const renameWorkspace = (oldKey: string, newKey: string) => {
    const existing = registry.get(oldKey);
    if (!existing) throw new Error("missing workspace");
    const newPath = join(workspaceRoot, newKey);
    renameSync(existing.path, newPath);
    registry.delete(oldKey);
    const updated: DropWorkspaceRef = { workspaceId: existing.workspaceId, key: newKey, path: newPath };
    registry.set(newKey, updated);
    registry.set(existing.workspaceId, updated);
  };

  const host: DropTenantHost = {
    id: "default",
    stateDir,
    workspaceRoot,
    resolveWorkspace: (keyOrId: string) => registry.get(keyOrId.trim()) ?? null,
  };

  return { base, stateDir, workspaceRoot, host, addWorkspace, renameWorkspace };
}

afterEach(() => {
  resetDropAuthMemoryStateForTest();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Step 2: Scoped 投递口令与小驳工具 (tokens.ts)", () => {
  test("未初始化知识库的工作区拒绝创建投递口令；初始化后成功创建且落盘 0o600 不存明文", () => {
    const { host, stateDir, addWorkspace } = makeTestEnv();
    addWorkspace("Fintopia集团");

    const beforeInit = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "fintopia-2026",
    });
    assert.equal(beforeInit.ok, false);

    const setupRes = setupKbWorkspaceForTenant(host, {
      workspace: "Fintopia集团",
      title: "Fintopia 集团知识库",
      categories: ["资金", "资产", "牌照"],
    });
    assert.equal(setupRes.ok, true);

    const created = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "fintopia-2026",
      label: "财务团队投递码",
      expiresInDays: 30,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.record.label, "财务团队投递码");
    assert.equal("codeHash" in created.record, false);

    const diskPath = join(stateDir, "assistant", "drop-tokens.json");
    const rawDisk = readFileSync(diskPath, "utf8");
    assert.equal(rawDisk.includes("fintopia-2026"), false);
    assert.equal(statSync(diskPath).mode & 0o777, 0o600);

    const duplicate = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "fintopia-2026",
    });
    assert.equal(duplicate.ok, false);
  });

  test("口令校验、工作区重命名解析、按相同 label 批量吊销使全部同名口令与会话立即失效", () => {
    const { host, addWorkspace, renameWorkspace } = makeTestEnv();
    addWorkspace("Fintopia集团");
    setupKbWorkspaceForTenant(host, {
      workspace: "Fintopia集团",
      title: "Fintopia 集团知识库",
      categories: ["资金", "资产", "牌照"],
    });
    const c1 = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "fin-pass-111",
    });
    const c2 = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "fin-pass-222",
    });
    assert.equal(c1.ok, true);
    assert.equal(c2.ok, true);

    const auth1 = verifyDropPasscodeAndCreateSession(host, {
      passcode: "fin-pass-111",
      submitterName: "张工-财务",
      clientIp: "10.0.0.1",
    });
    const auth2 = verifyDropPasscodeAndCreateSession(host, {
      passcode: "fin-pass-222",
      submitterName: "王工-风控",
      clientIp: "10.0.0.2",
    });
    assert.equal(auth1.ok, true);
    assert.equal(auth2.ok, true);
    if (!auth1.ok || !auth2.ok) return;

    // 修改返回副本不应影响内部会话状态
    auth1.session.workspacePath = "/hacked";
    const sessCheckBefore = verifyDropSessionToken(host, auth1.session.sessionToken);
    assert.equal(sessCheckBefore.ok, true);
    if (sessCheckBefore.ok) {
      assert.equal(sessCheckBefore.session.workspacePath.endsWith("Fintopia集团"), true);
    }

    // 工作区重命名后，已签发的 sessionToken 仍能通过稳定 workspaceId 解析到新路径
    renameWorkspace("Fintopia集团", "Fintopia集团_新");
    const sessCheck = verifyDropSessionToken(host, auth1.session.sessionToken);
    assert.equal(sessCheck.ok, true);
    if (sessCheck.ok) {
      assert.equal(sessCheck.session.workspaceKey, "Fintopia集团_新");
      assert.equal(sessCheck.session.workspacePath.endsWith("Fintopia集团_新"), true);
    }

    // 按默认相同 label ("Fintopia集团 投递码") 吊销时，两枚同名口令及其会话全部失效
    const revRes = revokeDropToken(host, "Fintopia集团 投递码");
    assert.equal(revRes.ok, true);
    if (revRes.ok) {
      assert.equal(revRes.revokedIds.length, 2);
    }
    assert.equal(verifyDropSessionToken(host, auth1.session.sessionToken).ok, false);
    assert.equal(verifyDropSessionToken(host, auth2.session.sessionToken).ok, false);
  });

  test("持有有效口令者不能通过穿插成功认证重置失败计数绕过 429 锁定", () => {
    const { host, addWorkspace } = makeTestEnv();
    addWorkspace("keda");
    setupKbWorkspaceForTenant(host, {
      workspace: "keda",
      title: "可达智灵知识库",
      categories: ["售前", "交付"],
    });
    const t0 = 1_700_000_000_000;
    createDropToken(
      host,
      {
        workspace: "keda",
        passcode: "keda-valid-code",
      },
      t0,
    );

    // 攻击者先输错 3 次
    for (let i = 0; i < 3; i++) {
      const failRes = verifyDropPasscodeAndCreateSession(
        host,
        {
          passcode: `guess-other-${i}`,
          submitterName: "攻击者",
          clientIp: "192.168.1.99",
        },
        t0 + i * 100,
      );
      assert.equal(failRes.ok, false);
    }

    // 攻击者用自己已知的有效口令成功登录 1 次（不应清空之前的 3 次失败记录！）
    const validRes = verifyDropPasscodeAndCreateSession(
      host,
      {
        passcode: "keda-valid-code",
        submitterName: "攻击者",
        clientIp: "192.168.1.99",
      },
      t0 + 400,
    );
    assert.equal(validRes.ok, true);

    // 再输错 2 次（累计满 5 次）立即触发锁定
    for (let i = 3; i < 5; i++) {
      const failRes = verifyDropPasscodeAndCreateSession(
        host,
        {
          passcode: `guess-other-${i}`,
          submitterName: "攻击者",
          clientIp: "192.168.1.99",
        },
        t0 + i * 200,
      );
      assert.equal(failRes.ok, false);
    }

    // 第 6 次请求被 429 拦截
    const lockedRes = verifyDropPasscodeAndCreateSession(
      host,
      {
        passcode: "keda-valid-code",
        submitterName: "攻击者",
        clientIp: "192.168.1.99",
      },
      t0 + 2000,
    );
    assert.equal(lockedRes.ok, false);
    if (!lockedRes.ok) {
      assert.equal(lockedRes.status, 429);
    }
  });

  test("写操作工具在 toolSpecs 中标记为 write（Ask/Plan 模式自动剥离），且 isMutatingTool 识别为写工具", () => {
    const { host, addWorkspace } = makeTestEnv();
    addWorkspace("GEO评估");

    const hostConfig = {
      ref: { id: host.id, stateDir: host.stateDir },
      role: "chat" as const,
      kbInitWorkspace: (args: { workspace: string; title: string; categories: string[] }) =>
        setupKbWorkspaceForTenant(host, args),
      dropTokenCreate: (args: { workspace: string; passcode: string; label?: string; expiresInDays?: number }) =>
        createDropToken(host, args),
      dropTokenList: (args: { includeRevoked?: boolean }) => listDropTokens(host, args),
      dropTokenRevoke: (args: { idOrLabel: string }) => revokeDropToken(host, args.idOrLabel),
    };

    const specs = assistantToolSpecs(hostConfig);
    const initSpec = specs.find((s) => s.name === "kb_workspace_init");
    const createSpec = specs.find((s) => s.name === "drop_token_create");
    const revokeSpec = specs.find((s) => s.name === "drop_token_revoke");
    const listSpec = specs.find((s) => s.name === "drop_token_list");

    assert.equal(initSpec?.category, "write");
    assert.equal(createSpec?.category, "write");
    assert.equal(revokeSpec?.category, "write");
    assert.equal(listSpec?.category, "network");

    // Ask / Plan 模式下 toolsForMode 自动过滤掉 category === "write" 的工具
    const askModeNames = new Set(toolsForMode("ask", specs).map((t) => t.name));
    assert.equal(askModeNames.has("kb_workspace_init"), false);
    assert.equal(askModeNames.has("drop_token_create"), false);
    assert.equal(askModeNames.has("drop_token_revoke"), false);
    assert.equal(askModeNames.has("drop_token_list"), true);

    // isMutatingTool 识别这三个工具为变更工具
    assert.equal(isMutatingTool("kb_workspace_init", {}), true);
    assert.equal(isMutatingTool("mcp__custom__drop_token_create", {}), true);
    assert.equal(isMutatingTool("drop_token_revoke", {}), true);
    assert.equal(isMutatingTool("drop_token_list", {}), false);
  });
});
