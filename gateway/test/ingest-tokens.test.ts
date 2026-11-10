import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { workspaceToolsFor } from "../src/assistant/service.ts";
import { assistantTools, assistantToolSpecs, toolSpecs, workspaceSessionTools } from "../src/assistant/tools.ts";
import { isMutatingTool, summarizeToolArgs } from "../src/chat/tools.ts";
import { revokeDropTokenFromUi } from "../src/ingest/hub.ts";
import { listIngestQueue, submitDirectIngestBatch } from "../src/ingest/queue.ts";
import {
  createDropToken,
  findColleaguePassByChannel,
  listDropTokens,
  logoutDropSessionToken,
  resetDropAuthMemoryStateForTest,
  revokeDropToken,
  setupKbWorkspaceForTenant,
  switchDropSessionWorkspace,
  updateDropToken,
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

  const addWorkspace = (
    key: string,
    id = `wsa_${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-000000000001`,
  ) => {
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

  test("管理端吊销仅作用于当前工作区，不会跨工作区吊销同名口令", () => {
    const { host, addWorkspace } = makeTestEnv();
    const fintopia = addWorkspace("Fintopia集团");
    const keda = addWorkspace("keda");
    for (const workspace of ["Fintopia集团", "keda"]) {
      assert.equal(
        setupKbWorkspaceForTenant(host, {
          workspace,
          title: `${workspace} 知识库`,
          categories: ["资料"],
        }).ok,
        true,
      );
      assert.equal(
        createDropToken(host, {
          workspace,
          passcode: `${workspace}-passcode`,
          label: "同名投递码",
        }).ok,
        true,
      );
    }

    const revoked = revokeDropTokenFromUi(host, {
      workspace: "Fintopia集团",
      idOrLabel: "同名投递码",
    });
    assert.equal(revoked.ok, true);

    const tokens = listDropTokens(host, { includeRevoked: true });
    assert.equal(tokens.find((token) => token.workspaceId === fintopia.workspaceId)?.active, false);
    assert.equal(tokens.find((token) => token.workspaceId === keda.workspaceId)?.active, true);
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
      kbIngestSubmit: () => ({ ok: true }),
    };

    const specs = assistantToolSpecs(hostConfig);
    const initSpec = specs.find((s) => s.name === "kb_workspace_init");
    const createSpec = specs.find((s) => s.name === "drop_token_create");
    const revokeSpec = specs.find((s) => s.name === "drop_token_revoke");
    const ingestSubmitSpec = specs.find((s) => s.name === "kb_ingest_submit");
    const listSpec = specs.find((s) => s.name === "drop_token_list");

    assert.equal(initSpec?.category, "write");
    assert.equal(createSpec?.category, "write");
    assert.equal(revokeSpec?.category, "write");
    assert.equal(ingestSubmitSpec?.category, "write");
    assert.equal(listSpec?.category, "network");

    // Ask / Plan 模式下 toolsForMode 自动过滤掉 category === "write" 的工具
    const askModeNames = new Set(toolsForMode("ask", specs).map((t) => t.name));
    assert.equal(askModeNames.has("kb_workspace_init"), false);
    assert.equal(askModeNames.has("drop_token_create"), false);
    assert.equal(askModeNames.has("drop_token_revoke"), false);
    assert.equal(askModeNames.has("kb_ingest_submit"), false);
    assert.equal(askModeNames.has("drop_token_list"), true);

    // summarizeToolArgs 保留 workspace/fileName 并对 passcode 脱敏
    const summarized = summarizeToolArgs({
      workspace: "Fintopia集团",
      fileName: "a.md",
      passcode: "secret-pass-123",
    }) as Record<string, unknown>;
    assert.equal(summarized.workspace, "Fintopia集团");
    assert.equal(summarized.fileName, "a.md");
    assert.equal(summarized.passcode, "***");

    // isMutatingTool 识别这些工具为变更工具
    assert.equal(isMutatingTool("kb_workspace_init", {}), true);
    assert.equal(isMutatingTool("mcp__custom__drop_token_create", {}), true);
    assert.equal(isMutatingTool("drop_token_revoke", {}), true);
    assert.equal(isMutatingTool("kb_ingest_submit", {}), true);
    assert.equal(isMutatingTool("drop_token_list", {}), false);
  });

  test("kb_ingest_submit 工具：支持在 chat、schedule 定时巡检与子工作区会话中直接提交日常增量数据进入归档队列", async () => {
    const { host, addWorkspace } = makeTestEnv();
    addWorkspace("Fintopia集团");
    setupKbWorkspaceForTenant(host, {
      workspace: "Fintopia集团",
      title: "Fintopia 集团知识库",
      categories: ["资金", "资产", "牌照"],
    });

    const submitCallback = (args: {
      workspace: string;
      fileName: string;
      content: string;
      note?: string;
      submitterName?: string;
    }) => {
      const res = submitDirectIngestBatch(host, {
        workspaceKeyOrId: args.workspace,
        tokenId: "dt_tool_test",
        submitterName: args.submitterName || "定时数据巡检",
        note: args.note,
        files: [{ fileName: args.fileName, data: Buffer.from(args.content, "utf8") }],
      });
      return res.ok
        ? { ok: true, batchId: res.batchId, workspaceKey: res.workspaceKey }
        : { ok: false, error: res.error };
    };

    // 1. schedule 角色同时拥有 web_read 与 kb_ingest_submit
    const scheduleTools = assistantTools({
      ref: { id: host.id, stateDir: host.stateDir },
      role: "schedule",
      kbIngestSubmit: submitCallback,
    });
    assert.ok(scheduleTools.web_read, "schedule 角色应具备 web_read 工具以支持定时巡检公开网页");
    assert.ok(scheduleTools.kb_ingest_submit, "schedule 角色应具备 kb_ingest_submit 工具以将巡检增量入库");

    const scheduleOut = JSON.parse(
      String(
        await scheduleTools.kb_ingest_submit.execute(
          {
            workspace: "Fintopia集团",
            fileName: "20261108_定时巡检增量.md",
            content: "# 11月8日舆情与牌照巡检增量\n\n未发现异常负面。",
            note: "每日早间8:30自动巡检",
          },
          { toolCallId: "sched-call-1" },
        ),
      ),
    ) as { ok: boolean; batchId: string; workspaceKey: string };
    assert.equal(scheduleOut.ok, true);
    assert.equal(scheduleOut.workspaceKey, "Fintopia集团");

    // 2. 子工作区会话工具 (workspaceSessionTools) 支持免填 workspace 直接向本知识库提交对话沉淀
    const wsTools = workspaceSessionTools({
      propose: () => ({ ok: true }),
      search: () => [],
      markUsed: () => ({ ok: true }),
      kbIngestSubmit: (args) =>
        submitCallback({
          workspace: "Fintopia集团",
          ...args,
        }),
    });
    assert.ok(wsTools.kb_ingest_submit);
    const wsOut = JSON.parse(
      String(
        await wsTools.kb_ingest_submit.execute(
          {
            fileName: "20261108_对话口头更新_三农信保证金.md",
            content: "# 三农信最新保证金回流\n\n最新确认回流 1200 万元。",
          },
          { toolCallId: "ws-call-1" },
        ),
      ),
    ) as { ok: boolean; batchId: string };
    assert.equal(wsOut.ok, true);

    const queue = listIngestQueue(host);
    assert.equal(
      queue.some((q) => q.batchId === scheduleOut.batchId),
      true,
    );
    assert.equal(
      queue.some((q) => q.batchId === wsOut.batchId),
      true,
    );

    // 3. 子工作区 Ask 模式下剥离 kb_ingest_submit，且只读后台委派 (readonly: true) 绝不挂载 kb_ingest_submit
    const wsToolSpecs = toolSpecs(wsTools);
    const wsAskNames = new Set(toolsForMode("ask", wsToolSpecs).map((t) => t.name));
    assert.equal(wsAskNames.has("kb_ingest_submit"), false);

    const readonlyDelegateTools = workspaceToolsFor(
      { id: host.id, stateDir: host.stateDir, name: "Default", workspaceRoot: host.workspaceRoot },
      "delegate-chat-1",
      join(host.workspaceRoot, "Fintopia集团"),
      { readonly: true },
    );
    assert.equal("kb_ingest_submit" in readonlyDelegateTools, false, "只读后台委派严禁挂载 kb_ingest_submit");
  });

  test("多工作区绑定、持久化记住登录态（跨网关重启自动恢复）、在线切库、单库解绑 vs 全局吊销、以及 IM/微信身份匹配", () => {
    const { host, addWorkspace } = makeTestEnv();
    const fintopia = addWorkspace("Fintopia集团");
    const sannong = addWorkspace("sannongxin");
    const keda = addWorkspace("keda");

    for (const ws of ["Fintopia集团", "sannongxin", "keda"]) {
      assert.equal(
        setupKbWorkspaceForTenant(host, {
          workspace: ws,
          title: `${ws} 知识库`,
          categories: ["核心资料"],
        }).ok,
        true,
      );
    }

    // 1. 创建王明的口令，默认不过期，且初始绑定 Fintopia集团
    const created = createDropToken(host, {
      workspace: "Fintopia集团",
      passcode: "wang-multi-2026",
      label: "王明（风控）",
      imTenantId: "wangming",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.record.expiresAt, undefined, "默认应永久有效不过期");

    // 2. 通过 updateDropToken 将 sannongxin 追加给王明
    const updated = updateDropToken(host, {
      tokenId: created.record.id,
      addWorkspaces: ["sannongxin"],
      permissions: { calendarFreeBusy: true, calendarPropose: true },
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.record.workspaces?.length, 2);

    // 3. 按 IM 账号 wangming 可直接查到王明的通行证及 2 个授权知识库
    const byIm = findColleaguePassByChannel(host, { imTenantId: "wangming" });
    assert.equal(Boolean(byIm), true);
    assert.equal(byIm?.workspaces.length, 2);

    // 4. 王明登录（默认 remember=true 持久化），拿到 2 个 authorizedWorkspaces
    const authRes = verifyDropPasscodeAndCreateSession(host, {
      passcode: "wang-multi-2026",
      submitterName: "王明",
      clientIp: "10.0.1.10",
    });
    assert.equal(authRes.ok, true);
    if (!authRes.ok) return;
    assert.equal(authRes.session.persistent, true);
    assert.equal(authRes.session.authorizedWorkspaces?.length, 2);
    assert.equal(authRes.session.workspaceKey, "Fintopia集团");

    // 5. 模拟网关进程重启（清空内存 activeDropSessions）且王明切换了网络 IP -> 仍能从 drop-sessions.json 自动无缝恢复会话
    resetDropAuthMemoryStateForTest();
    const recovered = verifyDropSessionToken(
      host,
      authRes.session.sessionToken,
      Date.now() + 7 * 86_400_000,
      "172.16.0.99",
    );
    assert.equal(recovered.ok, true, "跨重启且过 7 天、换 IP 后，记住登录会话仍应无缝恢复");
    if (!recovered.ok) return;
    assert.equal(recovered.session.submitterName, "王明");
    assert.equal(recovered.session.authorizedWorkspaces?.length, 2);

    // 6. 在线切换到 sannongxin 知识库（越权切到未授权的 keda 被 403 拦截）
    const forbiddenSwitch = switchDropSessionWorkspace(host, authRes.session.sessionToken, "keda");
    assert.equal(forbiddenSwitch.ok, false);
    if (!forbiddenSwitch.ok) assert.equal(forbiddenSwitch.status, 403);

    const okSwitch = switchDropSessionWorkspace(host, authRes.session.sessionToken, "sannongxin");
    assert.equal(okSwitch.ok, true);
    if (okSwitch.ok) {
      assert.equal(okSwitch.session.workspaceKey, "sannongxin");
    }

    // 再次模拟重启，验证激活的工作区保持为切换后的 sannongxin
    resetDropAuthMemoryStateForTest();
    const recoveredAfterSwitch = verifyDropSessionToken(host, authRes.session.sessionToken);
    assert.equal(recoveredAfterSwitch.ok, true);
    if (recoveredAfterSwitch.ok) {
      assert.equal(recoveredAfterSwitch.session.workspaceKey, "sannongxin");
    }

    // 7. 单工作区解绑：从 sannongxin 移除王明，王明对 Fintopia集团 的会话依然有效且自动切回 Fintopia集团
    const singleUnbind = revokeDropToken(host, created.record.id, Date.now(), sannong.workspaceId, {
      globalRevoke: false,
    });
    assert.equal(singleUnbind.ok, true);
    const afterSingleUnbind = verifyDropSessionToken(host, authRes.session.sessionToken);
    assert.equal(afterSingleUnbind.ok, true, "仅解绑 1 个工作区时，仍绑有 Fintopia集团 的通行证不应连坐失效");
    if (afterSingleUnbind.ok) {
      assert.equal(afterSingleUnbind.session.workspaceId, fintopia.workspaceId);
      assert.equal(afterSingleUnbind.session.authorizedWorkspaces?.length, 1);
    }

    // 8. 主动退出登录清除持久化会话
    assert.equal(logoutDropSessionToken(host, authRes.session.sessionToken), true);
    assert.equal(verifyDropSessionToken(host, authRes.session.sessionToken).ok, false);
  });
});
