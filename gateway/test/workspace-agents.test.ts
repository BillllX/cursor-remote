import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { WebSocket } from "ws";
import type { ServerMessage, WorkspaceAgentRow } from "../../shared/protocol.ts";
import { apnsBadgeFor } from "../src/assistant/apns.ts";
import { createBodyStore } from "../src/chatBodies.ts";
import { deleteWorkspace, renameWorkspace } from "../src/workspace/workspaces.ts";
import { fitWorkspaceAgents, frameFor } from "../src/ws/frame.ts";
import {
  WORKSPACE_AVATARS_SCOPE,
  markWorkspaceAgentRead,
  noteWorkspaceAgentAttention,
  openWorkspaceAgent,
  readWorkspaceAgentFile,
  updateWorkspaceAgentProfile,
  workspaceAgentPage,
  workspaceAvatarAllowed,
  workspaceUnread,
} from "../src/workspace/agents.ts";
import { applyStreamEvent, snapshotMessage, type RunTranscript } from "../src/runlog.ts";
import { mirrorRun } from "../src/ws/send.ts";
import { emptyDisk, type Tenant } from "../src/tenants.ts";
import { gatewayState } from "../src/runtime/state.ts";
import { imTicket, imTicketOk } from "../src/im/ticket.ts";

const roots: string[] = [];

afterEach(() => {
  gatewayState.conns.clear();
  gatewayState.liveByTenant.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tenant(id = `t-${Math.random().toString(16).slice(2)}`) {
  const root = mkdtempSync(join(tmpdir(), "workspace-agents-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const stateDir = join(root, "state");
  mkdirSync(workspaceRoot);
  mkdirSync(stateDir);
  return {
    id,
    name: id,
    tokenHash: Buffer.alloc(32),
    admin: true,
    sandbox: false,
    workspaceRoot,
    stateDir,
    stateFile: join(stateDir, "state.json"),
    disk: emptyDisk(),
    bodies: createBodyStore(stateDir, (turns) => turns),
  } satisfies Tenant;
}

function workspace(t: Tenant, name: string) {
  const path = join(t.workspaceRoot, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function fakeSocket() {
  const messages: ServerMessage[] = [];
  return {
    messages,
    ws: {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        messages.push(JSON.parse(raw) as ServerMessage);
      },
    } as unknown as WebSocket,
  };
}

describe("工作区 Agent 映射生命周期", () => {
  test("并发/重复 open 只创建一条主会话", async () => {
    const t = tenant();
    const path = workspace(t, "demo");
    const rows = await Promise.all(Array.from({ length: 12 }, async () => openWorkspaceAgent(t, path)));
    assert.equal(new Set(rows.map((row) => row?.chatId)).size, 1);
    assert.equal(t.disk.chats.length, 1);
  });

  test("墓碑和 cwd 坏映射都会自愈为新会话", () => {
    const t = tenant();
    const path = workspace(t, "demo");
    const first = openWorkspaceAgent(t, path)!;
    t.disk.deletedIds.push(first.chatId);
    const second = openWorkspaceAgent(t, path)!;
    assert.notEqual(second.chatId, first.chatId);
    const chat = t.disk.chats.find((row) => (row as { id?: string }).id === second.chatId) as { cwd?: string };
    chat.cwd = workspace(t, "other");
    const third = openWorkspaceAgent(t, path)!;
    assert.notEqual(third.chatId, second.chatId);
    assert.equal(
      (t.disk.chats.find((row) => (row as { id?: string }).id === third.chatId) as { cwd?: string }).cwd,
      path,
    );
  });

  test("改名保留 mainChatId，并迁移空主会话 cwd", async () => {
    const t = tenant();
    const from = workspace(t, "before");
    const opened = openWorkspaceAgent(t, from)!;
    const workspaceId = readWorkspaceAgentFile(t).items.before.workspaceId;
    const sock = fakeSocket();
    const conn = { cwd: t.workspaceRoot } as never;
    await renameWorkspace(sock.ws, t, conn, from, "after");
    const mapped = readWorkspaceAgentFile(t).items.after;
    assert.equal(mapped.mainChatId, opened.chatId);
    assert.equal(mapped.workspaceId, workspaceId);
    const chat = t.disk.chats.find((row) => (row as { id?: string }).id === opened.chatId) as { cwd?: string };
    assert.equal(chat.cwd, join(t.workspaceRoot, "after"));
  });

  test("v1 注册表首次读取原子迁移到 v2，并为现有目录生成稳定 workspaceId", () => {
    const t = tenant();
    const path = workspace(t, "legacy");
    writeFileSync(
      join(t.stateDir, "workspace-agent-chats.json"),
      JSON.stringify({
        version: 1,
        items: {
          legacy: {
            path,
            displayName: "旧 Agent",
            lastReadSeq: 1,
            unread: 2,
            lastActivityAt: 3,
            lastFinishedSeq: 4,
          },
        },
      }),
    );
    const first = readWorkspaceAgentFile(t);
    const second = readWorkspaceAgentFile(t);
    assert.equal(first.version, 2);
    assert.match(first.items.legacy.workspaceId, /^wsa_[0-9a-f-]{36}$/);
    assert.equal(second.items.legacy.workspaceId, first.items.legacy.workspaceId);
    const disk = JSON.parse(readFileSync(join(t.stateDir, "workspace-agent-chats.json"), "utf8"));
    assert.equal(disk.version, 2);
    assert.equal(disk.items.legacy.workspaceId, first.items.legacy.workspaceId);
  });

  test("删除空主会话时目录、映射和会话墓碑一起清理", () => {
    const t = tenant();
    const path = workspace(t, "empty");
    const opened = openWorkspaceAgent(t, path)!;
    const sock = fakeSocket();
    deleteWorkspace(sock.ws, t, { cwd: t.workspaceRoot } as never, path);
    assert.equal(readWorkspaceAgentFile(t).items.empty, undefined);
    assert.ok(t.disk.deletedIds.includes(opened.chatId));
    assert.equal(workspaceAgentPage(t).rows.length, 0);
  });

  test("列表只含磁盘存在、非隐藏的一级目录", () => {
    const t = tenant();
    workspace(t, "visible");
    workspace(t, "hidden");
    const nested = workspace(t, "visible/nested");
    writeFileSync(join(t.stateDir, "hidden-workspaces.json"), JSON.stringify(["hidden"]));
    writeFileSync(
      join(t.stateDir, "workspace-agent-chats.json"),
      JSON.stringify({
        version: 1,
        items: {
          ghost: {
            path: join(t.workspaceRoot, "ghost"),
            lastReadSeq: 0,
            unread: 0,
            lastActivityAt: 0,
            lastFinishedSeq: 0,
          },
          "visible/nested": {
            path: nested,
            lastReadSeq: 0,
            unread: 0,
            lastActivityAt: 0,
            lastFinishedSeq: 0,
          },
        },
      }),
    );
    t.disk.slots.push(
      { chatId: "ghost-slot", cwd: join(t.workspaceRoot, "ghost") } as never,
      { chatId: "nested-slot", cwd: nested } as never,
    );
    const rows = workspaceAgentPage(t).rows;
    assert.deepEqual(
      rows.map((row) => row.directoryName),
      ["visible"],
    );
  });
});

describe("工作区 Agent 未读、头像与分页", () => {
  test("已读标记单调；审批与同轮完成只增加一次，下一轮再增加", () => {
    const t = tenant();
    const path = workspace(t, "demo");
    const chatId = openWorkspaceAgent(t, path)!.chatId;
    const approval = noteWorkspaceAgentAttention(t, chatId, "turn-1", "approval")!;
    const completed = noteWorkspaceAgentAttention(t, chatId, "turn-1", "completed")!;
    assert.equal(approval.firstForTurn, true);
    assert.equal(completed.firstForTurn, false);
    assert.equal(completed.item.lastFinishedSeq, 1);
    assert.equal(workspaceUnread(t), 1);
    assert.equal(markWorkspaceAgentRead(t, chatId, 1), true);
    assert.equal(markWorkspaceAgentRead(t, chatId, 0), true);
    assert.equal(readWorkspaceAgentFile(t).items.demo.lastReadSeq, 1);
    noteWorkspaceAgentAttention(t, chatId, "turn-2", "failed");
    assert.equal(readWorkspaceAgentFile(t).items.demo.unread, 1);
  });

  test("workspace badge 是独立第三分量", () => {
    assert.equal(
      apnsBadgeFor(
        { assistant: true, im: true, workspace: true },
        { badgeParts: { assistant: 2, im: 3, workspace: 5 } },
      ),
      10,
    );
    assert.equal(
      apnsBadgeFor(
        { assistant: false, im: true, workspace: false },
        { badgeParts: { assistant: 2, im: 3, workspace: 5 } },
      ),
      3,
    );
  });

  test("工作区头像只接受 workspace-avatars scope 且必须在映射中", () => {
    const t = tenant("avatar-owner");
    const path = workspace(t, "demo");
    const sha = "a".repeat(64);
    assert.equal(updateWorkspaceAgentProfile(t, path, undefined, sha), true);
    assert.equal(workspaceAvatarAllowed(t, sha), true);
    assert.equal(workspaceAvatarAllowed(t, "b".repeat(64)), false);
    const ticket = imTicket("secret", t.id, WORKSPACE_AVATARS_SCOPE, 1_000);
    assert.equal(imTicketOk("secret", t.id, WORKSPACE_AVATARS_SCOPE, String(ticket.exp), ticket.sig, 1_001), true);
    assert.equal(imTicketOk("secret", t.id, "avatars", String(ticket.exp), ticket.sig, 1_001), false);
  });

  test("固定 100 行分页可完整遍历", () => {
    const t = tenant();
    for (let i = 0; i < 235; i += 1) workspace(t, `w-${String(i).padStart(3, "0")}`);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = workspaceAgentPage(t, cursor);
      names.push(...page.rows.map((row) => row.directoryName));
      cursor = page.nextCursor;
      if (!page.more) break;
    } while (cursor);
    assert.equal(names.length, 235);
    assert.equal(new Set(names).size, 235);
  });

  test("frame 裁剪后 more/cursor 可继续", () => {
    const row = (name: string): WorkspaceAgentRow => ({
      workspaceId: `wsa_00000000-0000-4000-8000-${name.padEnd(12, "0")}`,
      path: `/workspace/${name}/${"x".repeat(300)}`,
      directoryName: name,
      displayName: name,
      status: "idle",
      unread: 0,
      readSeq: 0,
      finishedSeq: 0,
      lastActivityAt: 0,
    });
    const message = {
      type: "workspace_agents" as const,
      workspaces: [row("a"), row("b"), row("c")],
      avatarTicket: { exp: 1, sig: "s" },
      reset: true,
      more: false,
    };
    const clipped = fitWorkspaceAgents(message, 750)!;
    assert.ok(clipped.workspaces.length > 0 && clipped.workspaces.length < 3);
    assert.equal(clipped.more, true);
    assert.equal(clipped.cursor, clipped.workspaces.at(-1)?.directoryName);
    const sock = fakeSocket();
    gatewayState.conns.set(sock.ws, { ws: sock.ws, maxMessageBytes: 1_000 } as never);
    const frame = frameFor(sock.ws, message);
    assert.ok(frame);
    const framed = JSON.parse(frame!) as Extract<ServerMessage, { type: "workspace_agents" }>;
    assert.equal(framed.more, true);
    assert.equal(framed.cursor, framed.workspaces.at(-1)?.directoryName);
  });
});

describe("多设备运行快照", () => {
  test("approval 进入 transcript 并镜像给非 owner；done 立即给最终快照", () => {
    const owner = fakeSocket();
    const peer = fakeSocket();
    const transcript: RunTranscript = {
      turnId: "turn-1",
      userText: "改文件",
      assistant: "准备修改",
      thinking: "",
      tools: [],
      phase: "running",
      epoch: 1,
    };
    const slot = {
      tenantId: "mirror-tenant",
      chatId: "chat-1",
      epoch: 1,
      transcript,
      owner: owner.ws,
      pending: [],
    } as never;
    gatewayState.conns.set(peer.ws, {
      ws: peer.ws,
      authed: true,
      tenant: { id: "mirror-tenant" },
      maxMessageBytes: 900_000,
    } as never);
    applyStreamEvent(transcript, {
      type: "approval",
      chatId: "chat-1",
      callId: "call-1",
      name: "write_file",
      args: { path: "a.txt" },
    });
    mirrorRun(slot, true);
    const approval = peer.messages.at(-1);
    assert.equal(approval?.type, "run_snapshot");
    assert.deepEqual(approval?.type === "run_snapshot" ? approval.awaitingApproval : undefined, {
      callId: "call-1",
      name: "write_file",
      args: { path: "a.txt" },
    });
    applyStreamEvent(transcript, { type: "done", chatId: "chat-1", status: "finished" });
    mirrorRun(slot, true);
    const done = peer.messages.at(-1);
    assert.equal(done?.type, "run_snapshot");
    assert.equal(done?.type === "run_snapshot" ? done.phase : "", "done");
    assert.equal(done?.type === "run_snapshot" ? done.awaitingApproval : "bad", undefined);
    const finalSnapshot = snapshotMessage("chat-1", transcript, []);
    assert.equal(finalSnapshot.type === "run_snapshot" ? finalSnapshot.phase : "", "done");
  });
});
