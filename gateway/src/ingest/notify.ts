import { Agent } from "@cursor/sdk";
import { postInbox } from "../assistant/inbox.ts";
import { clip } from "../assistant/store.ts";
import { listModels } from "../chat/models.ts";
import { gatewayEnv } from "../config.ts";
import { log } from "../log.ts";
import { getTenant, sandboxEnabledForTenant } from "../tenants.ts";
import { noteWorkspaceAgentAttention, openWorkspaceAgent, readWorkspaceAgentFile } from "../workspace/agents.ts";
import {
  KB_INGEST_LOG_REL_PATH,
  safeReadWorkspaceTextFileSync,
  safeWriteWorkspaceFileSync,
  type KbWorkspaceConfig,
} from "./contract.ts";
import { buildDropTenantHost, type DropPortalTenant } from "./http.ts";
import {
  bindIngestBatchWorker,
  recoverInterruptedIngestQueue,
  type IngestQueueEntry,
} from "./queue.ts";
import { bindQaRunner, type QaRunnerDeps } from "./qaRunner.ts";
import {
  clearQaSessionStorageSync,
  purgeQaSessionsByTokenIdsSync,
  sweepTenantQaTempStorageSync,
} from "./qaStorage.ts";
import { bindIngestRunner, runIngestBatchJob, type IngestRunnerDeps } from "./runner.ts";
import type { DropBatchMeta } from "./staging.ts";
import {
  onDropSessionEvicted,
  onDropTokensRevoked,
  type DropTenantHost,
} from "./tokens.ts";
import type { IngestToolExecutionLog } from "./tools.ts";

export type IngestLogRecord = {
  batchId: string;
  timestamp: number;
  status: "completed" | "partial" | "failed";
  submitterName: string;
  note: string;
  movedFiles: Array<{ from: string; to: string; category: string }>;
  updatedHtmls: string[];
  summary: string;
  errorReason?: string;
};

const MAX_INGEST_LOG_READ_BYTES = 8 * 1024 * 1024;
const MAX_INGEST_LOG_KEEP_BYTES = 1024 * 1024;

/**
 * 将单次归档记录安全追加到工作区内的 `.jiebo/ingest-log.jsonl`：
 * 1. 读取上限设为 8MB，写入维持在 ≤ 1MB（超过 1MB 时按字节从尾部保留完整行），从而确保永远不会撞上 8MB 读取上限导致历史被清空；
 * 2. 若因意外原因文件不存在则新建，若因其他错误读取失败则直接返回错误而不覆盖原文件。
 */
export function appendWorkspaceIngestLog(
  workspaceDir: string,
  record: IngestLogRecord,
): { ok: true } | { ok: false; error: string } {
  const existingRead = safeReadWorkspaceTextFileSync(workspaceDir, KB_INGEST_LOG_REL_PATH, MAX_INGEST_LOG_READ_BYTES);
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  let baseText = "";
  if (existingRead.ok) {
    baseText = existingRead.text;
    const budgetForExisting = Math.max(0, MAX_INGEST_LOG_KEEP_BYTES - lineBytes);
    if (Buffer.byteLength(baseText, "utf8") > budgetForExisting) {
      const lines = baseText.split("\n").filter(Boolean);
      const kept: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const lBytes = Buffer.byteLength(lines[i], "utf8") + 1;
        if (bytes + lBytes > budgetForExisting && kept.length > 0) break;
        if (bytes + lBytes <= budgetForExisting) {
          kept.unshift(lines[i]);
          bytes += lBytes;
        }
      }
      baseText = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    } else if (baseText && !baseText.endsWith("\n")) {
      baseText += "\n";
    }
  } else if (!existingRead.error.startsWith("文件不存在")) {
    return { ok: false, error: existingRead.error };
  }

  const writeRes = safeWriteWorkspaceFileSync(workspaceDir, KB_INGEST_LOG_REL_PATH, `${baseText}${line}`);
  if (!writeRes.ok) return writeRes;
  return { ok: true };
}

/**
 * 组装发送给工作区拥有者的收件箱 `brief` 卡片标题与正文（包含 `@相对路径` 引用以便在客户端一键点击打开 HTML 知识库或原文件）
 */
export function formatIngestBriefNotification(ctx: {
  config: KbWorkspaceConfig;
  meta: DropBatchMeta;
  executionLog: IngestToolExecutionLog;
  summaryText: string;
  status: "completed" | "partial" | "failed";
  errorReason?: string;
}): { title: string; body: string } {
  const { config, meta, executionLog, summaryText, status, errorReason } = ctx;
  const fileCount = meta.files.length;
  const movedCount = executionLog.movedFiles.length;

  const statusTag =
    status === "completed"
      ? "已归档入库"
      : status === "partial"
        ? `部分归档 (${movedCount}/${fileCount})`
        : "归档未完成（需关注）";

  const title = `【${config.title}】${statusTag}：${meta.submitterName} 投递了 ${fileCount} 份文档`;

  const lines: string[] = [];
  lines.push(`**投递人**：${meta.submitterName} · **批次号**：\`${meta.batchId}\``);
  if (meta.note) {
    lines.push(`**投递备注**：${meta.note}`);
  }
  lines.push("");

  if (summaryText) {
    lines.push("### 核心内容与归档总结");
    lines.push(summaryText.trim());
    lines.push("");
  } else if (errorReason) {
    lines.push(`**处理说明**：${errorReason}`);
    lines.push("");
  }

  if (executionLog.updatedHtmls.length > 0) {
    lines.push("### 已同步更新的知识库看板（点击直接预览）");
    for (const htmlRel of executionLog.updatedHtmls) {
      lines.push(`- @${htmlRel}`);
    }
    lines.push("");
  }

  if (executionLog.movedFiles.length > 0) {
    lines.push("### 已分类落盘的原始档案");
    for (const m of executionLog.movedFiles) {
      lines.push(`- [${m.category}] @${m.to}`);
    }
  } else {
    lines.push(`- 原始文件已安全保留在 \`.cursor-remote/uploads/inbox/${meta.batchId}/\` 目录中。`);
  }

  return {
    title: clip(title, 120),
    body: clip(lines.join("\n").trim(), 3800),
  };
}

/**
 * 解析该知识库工作区关联的真实主会话 `mainChatId`：
 * 1. 若全局租户已加载，调用 `openWorkspaceAgent` 打开/创建真实主会话并更新注意序号；
 * 2. 若在未加载完整租户的轻量/独立环境中，仅从 `workspace-agent-chats.json` 读取已存在的真实 `mainChatId`（绝不将 `wsa_xxx` 工作区 ID 伪造成 `chatId`）。
 */
function resolveWorkspaceMainChatId(host: DropTenantHost, workspacePath: string, batchId: string, status: "completed" | "partial" | "failed"): string | undefined {
  const fullTenant = getTenant(host.id);
  if (fullTenant && fullTenant.workspaceRoot === host.workspaceRoot) {
    try {
      const opened = openWorkspaceAgent(fullTenant, workspacePath);
      if (opened) {
        noteWorkspaceAgentAttention(
          fullTenant,
          opened.chatId,
          `ingest-${batchId}`,
          status === "failed" ? "failed" : "completed",
        );
        return opened.chatId;
      }
    } catch {
      // fall through to mapping file lookup
    }
  }
  try {
    const file = readWorkspaceAgentFile({
      id: host.id,
      stateDir: host.stateDir,
      workspaceRoot: host.workspaceRoot,
    } as Parameters<typeof readWorkspaceAgentFile>[0]);
    for (const item of Object.values(file.items)) {
      if (item.path === workspacePath && item.mainChatId) {
        return item.mainChatId;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * 归档批次完成后的交付闭环：
 * 1. 将本次归档详情写入 `.jiebo/ingest-log.jsonl`（不污染 `.jiebo/memory.md`）；
 * 2. 解析或打开该知识库工作区的主会话 `mainChatId`；
 * 3. 调用 `postInbox` 写入 `kind: "brief"`（天然属于 `PUSH_KINDS`，立即触发 iOS APNs / Web Push 及在线 WS `inbox_item` 广播），幂等键为 `ingest:<batchId>`。
 */
export function handleIngestBatchCompleted(ctx: {
  host: DropTenantHost;
  entry: IngestQueueEntry;
  workspacePath: string;
  config: KbWorkspaceConfig;
  meta: DropBatchMeta;
  executionLog: IngestToolExecutionLog;
  summaryText: string;
  status: "completed" | "partial" | "failed";
  errorReason?: string;
}): { inboxItemId: string; chatId?: string; logWritten: boolean } {
  const { host, workspacePath, config, meta, executionLog, summaryText, status, errorReason } = ctx;

  const logRes = appendWorkspaceIngestLog(workspacePath, {
    batchId: meta.batchId,
    timestamp: Date.now(),
    status,
    submitterName: meta.submitterName,
    note: meta.note,
    movedFiles: executionLog.movedFiles,
    updatedHtmls: executionLog.updatedHtmls,
    summary: clip(summaryText, 1000),
    ...(errorReason ? { errorReason } : {}),
  });

  const mainChatId = resolveWorkspaceMainChatId(host, workspacePath, meta.batchId, status);

  const { title, body } = formatIngestBriefNotification(ctx);
  const posted = postInbox(host, {
    kind: "brief",
    key: `ingest:${meta.batchId}`,
    title,
    body,
    ...(mainChatId ? { chatId: mainChatId } : {}),
  });

  return {
    inboxItemId: posted.item.id,
    chatId: mainChatId,
    logWritten: logRes.ok,
  };
}

const QA_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let activeQaStartupImmediate: ReturnType<typeof setImmediate> | null = null;
let activeQaSweepTimer: ReturnType<typeof setInterval> | null = null;
let activeRevokeUnsub: (() => void) | null = null;
let activeEvictUnsub: (() => void) | null = null;

export function stopIngestQaSweepTimer() {
  if (activeQaStartupImmediate) {
    clearImmediate(activeQaStartupImmediate);
    activeQaStartupImmediate = null;
  }
  if (activeQaSweepTimer) {
    clearInterval(activeQaSweepTimer);
    activeQaSweepTimer = null;
  }
  if (activeRevokeUnsub) {
    activeRevokeUnsub();
    activeRevokeUnsub = null;
  }
  if (activeEvictUnsub) {
    activeEvictUnsub();
    activeEvictUnsub = null;
  }
}

/**
 * 启动并绑定网关知识库归档与只读问答（QA）运行时（由 `gateway/src/index.ts` 与端到端测试统一调用）：
 * 1. 绑定 `IngestRunner`（含 `handleIngestBatchCompleted` 通知回调）与 `QaRunner`；
 * 2. 绑定 `IngestBatchWorker` 为 `runIngestBatchJob`；
 * 3. 对所有租户执行 `recoverInterruptedIngestQueue` 启动恢复；
 * 4. 启动知识库 QA 临时目录清理器（启动首扫 + 每 10 分钟定期清扫 + 口令吊销/会话淘汰即时销毁钩子）。
 */
export function startIngestRuntime(opts: {
  tenants: () => DropPortalTenant[];
  runnerOverrides?: Partial<IngestRunnerDeps>;
  qaRunnerOverrides?: Partial<QaRunnerDeps>;
  qaSweepIntervalMs?: number;
}): string[] {
  const apiKeyFn = opts.runnerOverrides?.apiKey ?? (() => gatewayEnv.cursorApiKey());
  const listModelsFn = opts.runnerOverrides?.listModels ?? listModels;
  const promptFn = opts.runnerOverrides?.prompt ?? ((message, options) => Agent.prompt(message, options));
  const sandboxFn = opts.runnerOverrides?.sandbox ?? ((tenantId) => sandboxEnabledForTenant(getTenant(tenantId)));

  bindIngestRunner({
    apiKey: apiKeyFn,
    listModels: listModelsFn,
    prompt: promptFn,
    sandbox: sandboxFn,
    onBatchCompleted:
      opts.runnerOverrides?.onBatchCompleted ??
      ((ctx) => {
        handleIngestBatchCompleted(ctx);
      }),
  });
  bindIngestBatchWorker(runIngestBatchJob);

  bindQaRunner({
    apiKey: opts.qaRunnerOverrides?.apiKey ?? apiKeyFn,
    listModels: opts.qaRunnerOverrides?.listModels ?? listModelsFn,
    prompt: opts.qaRunnerOverrides?.prompt ?? promptFn,
    sandbox: opts.qaRunnerOverrides?.sandbox ?? sandboxFn,
  });

  stopIngestQaSweepTimer();

  activeRevokeUnsub = onDropTokensRevoked((ref, revokedIds) => {
    const matchedTenant = opts.tenants().find((t) => t.id === ref.id && t.stateDir === ref.stateDir);
    const wsRoot = matchedTenant?.workspaceRoot ?? getTenant(ref.id)?.workspaceRoot ?? ref.stateDir;
    try {
      purgeQaSessionsByTokenIdsSync(ref, wsRoot, revokedIds);
    } catch (err) {
      log.error("purge qa sessions on revoke", err instanceof Error ? err.message : err);
    }
  });

  activeEvictUnsub = onDropSessionEvicted((grant) => {
    const matchedTenant = opts.tenants().find((t) => t.id === grant.tenantId);
    if (!matchedTenant) return;
    try {
      clearQaSessionStorageSync(buildDropTenantHost(matchedTenant), grant.qaSessionId, grant.workspaceId);
    } catch {
      // ignore
    }
  });

  const recoveredWorkspaces: string[] = [];
  for (const tenant of opts.tenants()) {
    try {
      const host = buildDropTenantHost(tenant);
      const drained = recoverInterruptedIngestQueue(host);
      recoveredWorkspaces.push(...drained);
    } catch (err) {
      log.error("recover ingest queue", err instanceof Error ? err.message : err);
    }
  }

  // 启动首扫延后到下一个事件循环 tick 执行，避免阻塞启动主路径
  activeQaStartupImmediate = setImmediate(() => {
    activeQaStartupImmediate = null;
    for (const tenant of opts.tenants()) {
      try {
        sweepTenantQaTempStorageSync(buildDropTenantHost(tenant), { isStartup: true });
      } catch (err) {
        log.error("startup sweep qa temp", err instanceof Error ? err.message : err);
      }
    }
  });

  const intervalMs = opts.qaSweepIntervalMs ?? QA_SWEEP_INTERVAL_MS;
  if (intervalMs > 0) {
    activeQaSweepTimer = setInterval(() => {
      for (const tenant of opts.tenants()) {
        try {
          sweepTenantQaTempStorageSync(buildDropTenantHost(tenant));
        } catch (err) {
          log.error("periodic sweep qa temp", err instanceof Error ? err.message : err);
        }
      }
    }, intervalMs);
    activeQaSweepTimer.unref?.();
  }

  return recoveredWorkspaces;
}
