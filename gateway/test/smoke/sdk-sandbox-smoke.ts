// 在支持 Cursor SDK 沙箱的服务器运行；不调用模型、不读取业务工作区。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPlatform } from "@cursor/sdk";
import { initializeSdkSandbox } from "../../src/runtime/sdkSandbox.ts";

const cwd = await mkdtemp(join(tmpdir(), "jiebo-sdk-sandbox-test-"));
try {
  await initializeSdkSandbox();
  const platform = await createAgentPlatform();
  // 覆盖管理员先执行、普通租户随后执行以及再次切换的初始化顺序。
  for (const enabled of [false, true, false, true]) {
    const release = await platform.prewarmLocalWorkspace({
      local: { cwd, sandboxOptions: { enabled }, settingSources: [] },
    });
    assert.equal(typeof release, "function");
    await release();
  }
  console.log("SDK 沙箱回归通过：预热后管理员与受限租户可交替初始化，无模型请求。");
} finally {
  await rm(cwd, { recursive: true, force: true });
}
