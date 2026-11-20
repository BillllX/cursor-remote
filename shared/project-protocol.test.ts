import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { decodeProjectRequest, projectPath } from "./projectValidation.ts";
const message = () => ({
  type: "project_request",
  protocol: 1,
  requestId: randomUUID(),
  action: "project_list",
  payload: {},
});
test("项目外壳严格解码，拒绝注入身份/目录和未知字段", () => {
  assert.equal(decodeProjectRequest(message()).action, "project_list");
  for (const injected of [
    { ...message(), owner: "other" },
    { ...message(), principal: "other" },
    { ...message(), cwd: "/tmp" },
    { ...message(), payload: { owner: "other" } },
    { ...message(), protocol: 2 },
  ])
    assert.throws(() => decodeProjectRequest(injected));
});
test("项目保护路径、父目录和跨平台路径碰撞的输入门禁", () => {
  for (const p of ["../a", "/a", "a\\b", "a//b", "a/.git/config", "AGENTS.md", "a/CON", "a/../b", "a\u0000b"])
    assert.throws(() => projectPath(p), p);
  assert.equal(projectPath("文档/说明.txt"), "文档/说明.txt");
});
