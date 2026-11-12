import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentOptions, RunResult } from "@cursor/sdk";
import { BACKGROUND_MODEL, BACKGROUND_TOOLS } from "../assistant/background.ts";
import { clip } from "../assistant/store.ts";
import { readControlledWeb } from "../assistant/webRead.ts";
import { isInside } from "../pathInside.ts";
import {
  DEFAULT_MAX_FILE_BYTES,
  ensureSafePathInWorkspace,
  hasControlChars,
  isAllowedUploadFileName,
  loadKbWorkspaceConfig,
} from "./contract.ts";
import { submitDirectIngestBatch } from "./queue.ts";
import { checkAndOptionallySyncWecomItems, ingestWecomMailToKb, searchWecomResources } from "./wecomSource.ts";
import type {
  WorkspaceScheduleExecutorKind,
  WorkspaceTaskExecutor,
} from "./workspaceScheduleTypes.ts";

export type ScheduleAgentPromptDeps = {
  apiKey: () => string;
  prompt: (message: string, options: AgentOptions) => Promise<RunResult>;
  sandbox?: (tenantId: string) => boolean;
};

let agentPromptDeps: ScheduleAgentPromptDeps | null = null;

export function bindWorkspaceScheduleAgentPromptDeps(deps: ScheduleAgentPromptDeps | null): void {
  agentPromptDeps = deps;
}

const executorRegistry = new Map<WorkspaceScheduleExecutorKind, WorkspaceTaskExecutor>();

export function registerWorkspaceTaskExecutor(
  kind: WorkspaceScheduleExecutorKind,
  executor: WorkspaceTaskExecutor,
): void {
  executorRegistry.set(kind, executor);
}

export function getWorkspaceTaskExecutor(kind: WorkspaceScheduleExecutorKind): WorkspaceTaskExecutor | undefined {
  return executorRegistry.get(kind);
}

/** 1. 企微关注文件巡检同步执行器 */
const executeWecomWatchSync: WorkspaceTaskExecutor = async ({ host, schedule }) => {
  const { payload } = schedule;
  const itemIds =
    Array.isArray(payload.watchItemIds) && payload.watchItemIds.length > 0 ? payload.watchItemIds : undefined;
  const res = await checkAndOptionallySyncWecomItems(host, {
    workspace: schedule.workspaceKeySnapshot,
    itemIds,
    quietPeriodMinutes: payload.quietPeriodMinutes ?? 3,
    syncIfChanged: true,
    forceSync: false,
  });

  if (!res.ok) {
    return {
      phase: "completed",
      status: "failed",
      summary: res.error || "企业微信关注文件巡检失败",
      error: res.error || "企业微信关注文件巡检失败",
    };
  }

  const batchIds = [...new Set(res.results.map((r) => r.batchId).filter((b): b is string => Boolean(b)))];
  if (batchIds.length > 0) {
    const syncedTitles = res.results
      .filter((r) => r.synced)
      .map((r) => `《${r.title}》`)
      .join("、");
    return {
      phase: "awaiting_ingest",
      batchIds,
      preSummary: `检测到 ${res.syncedCount} 份企微文件更新（${syncedTitles}），正在后台归档并刷新看板…`,
    };
  }

  const failedItems = res.results.filter((r) => !r.ok || Boolean(r.syncError));
  if (failedItems.length > 0 && res.checkedCount > 0 && failedItems.length === res.checkedCount) {
    const errMsg = failedItems[0]?.syncError || failedItems[0]?.error || "巡检异常";
    return {
      phase: "completed",
      status: "failed",
      summary: `检查 ${res.checkedCount} 项均失败：${errMsg}`,
      error: errMsg,
    };
  }

  const deferredNote = res.deferredCount ? `（另有 ${res.deferredCount} 项刚修改处于静默防抖期）` : "";
  return {
    phase: "completed",
    status: "no_change",
    summary: `已巡检 ${res.checkedCount} 份企微关注文件，均无新变动${deferredNote}`,
  };
};

/** 2. 企微邮箱增量拉取执行器 */
const executeWecomMailPoll: WorkspaceTaskExecutor = async ({ host, schedule }) => {
  const { payload, cursorState } = schedule;
  const limit = Math.max(1, Math.min(20, Math.floor(payload.mailLimit ?? 5)));
  const searchRes = await searchWecomResources(host, {
    scope: "mail_search",
    keyword: payload.mailKeyword,
    hasAttachments: payload.onlyWithAttachments,
    limit,
  });
  if (!searchRes.ok) {
    return {
      phase: "completed",
      status: "failed",
      summary: searchRes.error || "检索企业微信邮件失败",
      error: searchRes.error,
    };
  }

  const seenMailIds = Array.isArray(cursorState.seenMailIds)
    ? cursorState.seenMailIds.filter((x): x is string => typeof x === "string")
    : [];
  const seenSet = new Set(seenMailIds);
  const rawList = Array.isArray(searchRes.data?.mail_list)
    ? (searchRes.data.mail_list as Array<Record<string, unknown>>)
    : [];
  const newMailIds: string[] = [];
  for (const item of rawList) {
    const id = typeof item.mail_id === "string" ? item.mail_id.trim() : "";
    if (id && !seenSet.has(id)) newMailIds.push(id);
  }

  if (newMailIds.length === 0) {
    return {
      phase: "completed",
      status: "no_change",
      summary: `已检索企微邮箱${payload.mailKeyword ? `（关键词：${payload.mailKeyword}）` : ""}，无未入库的新邮件`,
    };
  }

  const batchIds: string[] = [];
  const batchMailMap: Record<string, string> = {};
  const ingestedIds: string[] = [];
  const errors: string[] = [];
  for (const mailId of newMailIds) {
    const ing = await ingestWecomMailToKb(host, {
      workspace: schedule.workspaceKeySnapshot,
      mailId,
      note: payload.note || `定时拉取企微邮件 (${schedule.title})`,
    });
    if (ing.ok && ing.batchId) {
      batchIds.push(ing.batchId);
      batchMailMap[ing.batchId] = mailId;
      ingestedIds.push(mailId);
    } else if (ing.error) {
      errors.push(ing.error);
    }
  }

  const nextCursorState = {
    ...cursorState,
    seenMailIds: [...new Set([...seenMailIds, ...ingestedIds])].slice(-500),
  };

  if (batchIds.length > 0) {
    return {
      phase: "awaiting_ingest",
      batchIds,
      preSummary: `拉取到 ${batchIds.length} 封新企微邮件并送入归档队列…`,
      nextCursorState,
      batchMailMap,
    };
  }

  const errMsg = errors[0] || "邮件拉取入库未成功";
  return {
    phase: "completed",
    status: "failed",
    summary: errMsg,
    error: errMsg,
  };
};

/** 3. 受控外部 HTTP/API/网页抓取入库执行器 */
const executeHttpApiIngest: WorkspaceTaskExecutor = async ({ host, schedule, workspacePath }) => {
  const { payload, cursorState } = schedule;
  const url = (payload.url || "").trim();
  if (!url) {
    return { phase: "completed", status: "failed", summary: "未配置目标 URL", error: "缺少 url 参数" };
  }
  let webRes: { url: string; title?: string; text: string; truncated: boolean };
  try {
    webRes = await readControlledWeb(url, { allowDataTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "读取远端 URL 失败";
    return { phase: "completed", status: "failed", summary: msg, error: msg };
  }

  const bodyText = (webRes.text || "").trim();
  if (!bodyText) {
    return { phase: "completed", status: "failed", summary: "远端返回内容为空", error: "远端返回内容为空" };
  }

  const sha256 = createHash("sha256").update(bodyText, "utf8").digest("hex");
  if (cursorState.lastBodySha256 === sha256) {
    return {
      phase: "completed",
      status: "no_change",
      summary: `已请求 ${webRes.url || url}，内容哈希无变动`,
    };
  }

  const kbLoaded = loadKbWorkspaceConfig(workspacePath, host.workspaceRoot);
  const rawName = (payload.targetFileName || `${schedule.title.replace(/[^\w\u4e00-\u9fa5.-]/g, "_")}.md`).trim();
  let fileName = /\.(md|csv|txt|json)$/i.test(rawName) ? rawName : `${rawName}.md`;
  if (kbLoaded.ok) {
    const check = isAllowedUploadFileName(fileName, kbLoaded.config);
    if (!check.ok) fileName = `${fileName.replace(/\.[^.]+$/, "")}.md`;
    else fileName = check.normalizedName;
  }
  const docContent = fileName.endsWith(".md")
    ? `# ${webRes.title || schedule.title}\n\n- 来源 URL：\`${webRes.url || url}\`\n- 内容指纹：\`${sha256}\`\n\n---\n\n${bodyText}\n`
    : bodyText;

  const submitted = submitDirectIngestBatch(host, {
    workspaceKeyOrId: schedule.workspaceId,
    tokenId: "dt_schedule_http_ingest",
    submitterName: `定时任务(${schedule.title})`,
    note: payload.note || `定时抓取接口/网页：${webRes.title || url}`,
    files: [{ fileName, data: Buffer.from(docContent, "utf8") }],
  });

  if (!submitted.ok) {
    return { phase: "completed", status: "failed", summary: submitted.error, error: submitted.error };
  }

  return {
    phase: "awaiting_ingest",
    batchIds: [submitted.batchId],
    preSummary: `检测到 ${webRes.title || url} 内容更新，已提交归档批次 ${submitted.batchId}`,
    nextCursorState: { ...cursorState, lastBodySha256: sha256, lastFetchedAt: Date.now() },
  };
};

/** 4. 工作区受控脚本任务执行器（Python/Node/Bash，无 shell 拼接注入） */
const executeWorkspaceScript: WorkspaceTaskExecutor = async ({ host, schedule, workspacePath }) => {
  const { payload, cursorState } = schedule;
  const relScript = (payload.scriptRelPath || "").trim();
  if (!relScript) {
    return { phase: "completed", status: "failed", summary: "未指定脚本路径 scriptRelPath", error: "缺少 scriptRelPath" };
  }
  const scriptCheck = ensureSafePathInWorkspace(workspacePath, relScript, { expectLeaf: "file" });
  if (!scriptCheck.ok || !existsSync(scriptCheck.absPath)) {
    const err = scriptCheck.ok ? `脚本文件不存在：${relScript}` : scriptCheck.error;
    return { phase: "completed", status: "failed", summary: err, error: err };
  }

  const runnerBin = payload.runner === "node" ? "node" : payload.runner === "bash" ? "bash" : "python3";
  const safeArgs = Array.isArray(payload.args)
    ? payload.args.filter((a): a is string => typeof a === "string" && !hasControlChars(a)).slice(0, 16)
    : [];
  const timeoutMs = Math.max(5, Math.min(300, Math.floor(payload.timeoutSeconds ?? 60))) * 1000;
  const kbLoaded = loadKbWorkspaceConfig(workspacePath, host.workspaceRoot);
  const maxBytes = kbLoaded.ok ? kbLoaded.config.maxFileBytes : DEFAULT_MAX_FILE_BYTES;

  // 最小白名单环境变量，严禁透传 CURSOR_API_KEY 等宿主敏感凭据
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: "/opt/node-v22/bin:/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    TZ: schedule.tz || "Asia/Shanghai",
    HOME: workspacePath,
    TMPDIR: tmpdir(),
    WORKSPACE_DIR: workspacePath,
  };

  const execRes = await new Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>((resolveRun) => {
    let settled = false;
    const finish = (res: { ok: boolean; code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolveRun(res);
    };
    const child = spawn(runnerBin, [scriptCheck.absPath, ...safeArgs], {
      cwd: workspacePath,
      env: safeEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // ignore
      }
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      killTree();
      finish({
        ok: false,
        code: 124,
        stdout: Buffer.concat(outChunks).toString("utf8").trim(),
        stderr: `脚本执行超时 (>${timeoutMs}ms)`,
      });
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        overflowed = true;
        killTree();
        return;
      }
      outChunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        overflowed = true;
        killTree();
        return;
      }
      errChunks.push(c);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, code: 127, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString("utf8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf8").trim();
      if (overflowed) {
        finish({ ok: false, code: 137, stdout: "", stderr: `脚本输出体积超过上限（>${maxBytes} bytes）` });
        return;
      }
      finish({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });
  });

  if (!execRes.ok) {
    const errMsg = clip(execRes.stderr || execRes.stdout || `脚本退出码 ${execRes.code}`, 240);
    return { phase: "completed", status: "failed", summary: `脚本执行失败：${errMsg}`, error: errMsg };
  }

  let outputData: Buffer | null = null;
  let outputFileName = `${schedule.title.replace(/[^\w\u4e00-\u9fa5.-]/g, "_")}_output.md`;

  if (payload.outputRelPath?.trim()) {
    const outCheck = ensureSafePathInWorkspace(workspacePath, payload.outputRelPath.trim(), { expectLeaf: "file" });
    if (!outCheck.ok || !existsSync(outCheck.absPath)) {
      const err = outCheck.ok ? `脚本未产出指定文件：${payload.outputRelPath}` : outCheck.error;
      return { phase: "completed", status: "failed", summary: err, error: err };
    }
    const st = lstatSync(outCheck.absPath);
    if (!st.isFile() || st.isSymbolicLink() || !isInside(realpathSync(outCheck.absPath), realpathSync(workspacePath))) {
      return { phase: "completed", status: "failed", summary: "脚本输出文件不是安全的工作区普通文件", error: "输出文件越界" };
    }
    if (st.size > maxBytes) {
      const err = `脚本产出文件体积（${st.size} bytes）超过单文件上限（${maxBytes} bytes）`;
      return { phase: "completed", status: "failed", summary: err, error: err };
    }
    outputData = readFileSync(outCheck.absPath);
    outputFileName = outCheck.normalizedRel.split("/").pop() || outputFileName;
  } else if (execRes.stdout) {
    outputData = Buffer.from(execRes.stdout, "utf8");
  }

  if (!outputData || outputData.length === 0) {
    return { phase: "completed", status: "no_change", summary: "脚本执行成功（无新增输出数据）" };
  }

  const sha256 = createHash("sha256").update(outputData).digest("hex");
  if (cursorState.lastOutputSha256 === sha256) {
    return {
      phase: "completed",
      status: "no_change",
      summary: `脚本 ${relScript} 执行完成，输出内容哈希与上次一致（无变动）`,
    };
  }

  const nextCursor = { ...cursorState, lastOutputSha256: sha256, lastRunAt: Date.now() };
  if (payload.ingestToKb !== false && kbLoaded.ok) {
    const nameCheck = isAllowedUploadFileName(outputFileName, kbLoaded.config);
    const safeName = nameCheck.ok ? nameCheck.normalizedName : `${outputFileName}.md`;
    const submitted = submitDirectIngestBatch(host, {
      workspaceKeyOrId: schedule.workspaceId,
      tokenId: "dt_schedule_script",
      submitterName: `定时脚本(${schedule.title})`,
      note: payload.note || `工作区定时脚本 ${relScript} 增量产出`,
      files: [{ fileName: safeName, data: outputData }],
    });
    if (!submitted.ok) {
      return { phase: "completed", status: "failed", summary: submitted.error, error: submitted.error };
    }
    return {
      phase: "awaiting_ingest",
      batchIds: [submitted.batchId],
      preSummary: `脚本 ${relScript} 产出新数据，已投入归档批次 ${submitted.batchId}`,
      nextCursorState: nextCursor,
    };
  }

  return {
    phase: "completed",
    status: "succeeded",
    summary: clip(execRes.stdout || `脚本 ${relScript} 执行成功`, 300),
     ...(payload.outputRelPath ? { updatedFiles: [payload.outputRelPath.trim()] } : {}),
    nextCursorState: nextCursor,
  };
};

/** 5. 通用 AI Agent 定时分析/巡检任务执行器 */
const executeAgentPrompt: WorkspaceTaskExecutor = async ({ host, schedule, workspacePath }) => {
  const promptText = (schedule.payload.prompt || "").trim();
  if (!promptText) {
    return { phase: "completed", status: "failed", summary: "未配置 AI 任务指令 prompt", error: "缺少 prompt" };
  }
  if (!agentPromptDeps) {
    return { phase: "completed", status: "failed", summary: "AI 定时执行器尚未绑定运行依赖", error: "未初始化" };
  }
  const apiKey = agentPromptDeps.apiKey();
  if (!apiKey) {
    return { phase: "completed", status: "failed", summary: "缺少 CURSOR_API_KEY", error: "缺少 CURSOR_API_KEY" };
  }

  const sandboxEnabled = agentPromptDeps.sandbox ? agentPromptDeps.sandbox(host.id) : true;
  const fullPrompt = [
    `你是工作区「${schedule.workspaceKeySnapshot}」的定时任务执行器（任务名：${schedule.title}）。`,
    "请只读分析本工作区内的数据并按以下任务指令输出简明中文结论：",
    promptText,
  ].join("\n\n");

  const timeoutMs = Math.max(10, Math.min(3600, Math.floor(schedule.payload.timeoutSeconds ?? 1200))) * 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const res = await Promise.race([
      agentPromptDeps.prompt(fullPrompt, {
        apiKey,
        model: { id: BACKGROUND_MODEL },
        tools: [...BACKGROUND_TOOLS],
        local: {
          cwd: workspacePath,
          sandboxOptions: { enabled: sandboxEnabled },
          settingSources: [],
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI 定时任务执行超时 (>${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
    if (res.status !== "finished") {
      const err = res.error?.message || `模型状态异常: ${res.status}`;
      return { phase: "completed", status: "failed", summary: err, error: err };
    }
    const text = (res.result || "").trim();
    const kbLoaded = loadKbWorkspaceConfig(workspacePath, host.workspaceRoot);
    if (schedule.payload.ingestToKb !== false && kbLoaded.ok && text) {
      const fileName = `${schedule.title.replace(/[^\w\u4e00-\u9fa5.-]/g, "_")}_定时分析报告.md`;
      const submitted = submitDirectIngestBatch(host, {
        workspaceKeyOrId: schedule.workspaceId,
        tokenId: "dt_schedule_agent",
        submitterName: `定时分析(${schedule.title})`,
        note: schedule.payload.note || `AI 定时任务《${schedule.title}》报告入库`,
        files: [{ fileName, data: Buffer.from(`# ${schedule.title}\n\n${text}\n`, "utf8") }],
      });
      if (!submitted.ok) {
        return { phase: "completed", status: "failed", summary: submitted.error, error: submitted.error };
      }
      return {
        phase: "awaiting_ingest",
        batchIds: [submitted.batchId],
        preSummary: clip(text, 240),
      };
    }
    return {
      phase: "completed",
      status: "succeeded",
      summary: clip(text || "定时 AI 分析已完成", 500),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { phase: "completed", status: "failed", summary: msg, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

registerWorkspaceTaskExecutor("wecom_watch_sync", executeWecomWatchSync);
registerWorkspaceTaskExecutor("wecom_mail_poll", executeWecomMailPoll);
registerWorkspaceTaskExecutor("http_api_ingest", executeHttpApiIngest);
registerWorkspaceTaskExecutor("workspace_script", executeWorkspaceScript);
registerWorkspaceTaskExecutor("agent_prompt", executeAgentPrompt);
