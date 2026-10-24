import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Delegation } from "../src/assistant/delegations.ts";
import type { InboxItem } from "../src/assistant/inbox.ts";
import { buildArtifactProjection, safeArtifactPath, safeArtifactURL } from "../src/assistant/artifactProjection.ts";

const SHA = "a".repeat(64);

function delegation(patch: Partial<Delegation> = {}): Delegation {
  return {
    id: "d-1",
    childChatId: "child",
    workspace: "/private/workspace",
    title: "生成报告",
    task: "正文不得进入投影",
    mode: "background",
    status: "done",
    createdAt: 10,
    ...patch,
  };
}

function inbox(patch: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i-1",
    kind: "info",
    title: "来自分享",
    body: "正文和 token 都不得进入投影 secret-token",
    createdAt: 30,
    read: false,
    capture: { kind: "link", title: "可靠网页", url: "https://example.com/read" },
    ...patch,
  };
}

describe("Artifact 只读投影", () => {
  test("稳定 id、确定排序、委派回填与子回合去重", () => {
    const file = { path: "reports/final.md", kind: "markdown", op: "added", sha: SHA };
    const chats = [
      {
        id: "parent",
        title: "父会话",
        turns: [
          {
            id: "parent-turn",
            startedAt: 20,
            files: [{ ...file, sourceChatId: "child", sourceTurnId: "child-turn" }],
          },
        ],
      },
      {
        id: "child",
        title: "子会话",
        turns: [{ id: "child-turn", startedAt: 15, files: [file] }],
      },
    ];
    const input = { chats, delegations: [delegation()], inbox: [inbox()] };
    const first = buildArtifactProjection(input);
    const second = buildArtifactProjection(input);

    assert.deepEqual(first, second);
    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((row) => row.createdAt),
      [30, 20],
    );
    const artifact = first.find((row) => row.kind === "file");
    assert.equal(artifact?.sourceChatId, "child");
    assert.equal(artifact?.sourceTurnId, "child-turn");
    assert.equal(artifact?.provenance?.delegationId, "d-1");
    assert.equal(artifact?.provenance?.label, "委派：生成报告");
  });

  test("裁剪稳定，链接只读 capture 受控字段并过滤非 http(s)", () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      inbox({
        id: `i-${index}`,
        createdAt: 100 + index,
        body: index === 0 ? "https://body.example/不能反解析" : "正文",
        capture:
          index === 0
            ? { kind: "text", title: "文本" }
            : index === 1
              ? { kind: "link", url: "javascript:alert(1)" }
              : { kind: "link", url: `https://example.com/${index}`, title: `链接 ${index}` },
      }),
    );
    const artifacts = buildArtifactProjection({ chats: [], delegations: [], inbox: items }, 3);
    assert.equal(artifacts.length, 3);
    assert.deepEqual(
      artifacts.map((row) => row.createdAt),
      [106, 105, 104],
    );
    assert.equal(
      artifacts.some((row) => row.url?.includes("body.example")),
      false,
    );
    assert.equal(
      artifacts.some((row) => row.url?.startsWith("javascript:")),
      false,
    );
  });

  test("租户输入互不混合，绝对路径、越界路径、凭据 URL 与正文均不泄露", () => {
    const tenantA = buildArtifactProjection({
      chats: [
        {
          id: "a",
          title: "/secret/absolute/title",
          turns: [
            {
              id: "ta",
              startedAt: 1,
              user: "用户正文 secret-token",
              assistant: "助理正文 secret-token",
              files: [
                { path: "/etc/passwd", kind: "text", op: "modified" },
                { path: "../outside.txt", kind: "text", op: "modified" },
                { path: "safe/result.txt", kind: "text", op: "modified" },
              ],
            },
          ],
        },
      ],
      delegations: [],
      inbox: [],
    });
    const tenantB = buildArtifactProjection({
      chats: [{ id: "b", title: "B", turns: [{ id: "tb", files: [{ path: "b.txt", kind: "text" }] }] }],
      delegations: [],
      inbox: [],
    });

    assert.deepEqual(
      tenantA.map((row) => row.path),
      ["safe/result.txt"],
    );
    assert.deepEqual(
      tenantB.map((row) => row.path),
      ["b.txt"],
    );
    assert.equal(JSON.stringify(tenantA).includes("secret-token"), false);
    assert.equal(JSON.stringify(tenantA).includes("/secret/absolute/title"), false);
    assert.equal(safeArtifactPath("C:\\secret.txt"), undefined);
    assert.equal(safeArtifactURL("https://user:password@example.com"), undefined);
    assert.equal(safeArtifactURL("file:///tmp/a"), undefined);
  });

  test("复合 Canvas 后缀先于普通扩展判断且不区分大小写", () => {
    const artifacts = buildArtifactProjection({
      chats: [
        {
          id: "canvas-chat",
          turns: [
            {
              id: "canvas-turn",
              files: [{ path: "design/board.canvas.tsx" }, { path: "design/alt.CANVAS.JSX" }],
            },
          ],
        },
      ],
      delegations: [],
      inbox: [],
    });
    assert.deepEqual(
      artifacts.map((row) => row.previewKind),
      ["canvas", "canvas"],
    );
  });
});
