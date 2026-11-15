import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPlatform } from "@cursor/sdk";

/**
 * SDK 1.0.31 的沙箱支持检测有进程级缓存：非沙箱执行器先初始化时，
 * 尚未配置 helper 路径就可能缓存 false，随后所有受限租户都会启动失败。
 * 必须在接收连接、启动后台任务之前预热沙箱；只初始化执行器，不发送模型请求。
 */
export async function initializeSdkSandbox(apiKey?: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "jiebo-sdk-sandbox-"));
  try {
    const platform = await createAgentPlatform();
    const release = await platform.prewarmLocalWorkspace({
      apiKey,
      local: {
        cwd,
        sandboxOptions: { enabled: true },
        // 用空目录且不加载用户或项目配置，避免启动阶段挂载工作区 MCP。
        settingSources: [],
      },
    });
    await release();
  } catch (cause) {
    throw new Error("服务端 SDK 沙箱初始化失败；保留租户隔离，请检查沙箱程序及运行环境。", { cause });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
