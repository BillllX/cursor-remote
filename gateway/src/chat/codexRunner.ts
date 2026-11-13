// Codex CLI（@openai/codex-sdk）双引擎并存运行器：仅向非沙箱管理员租户开放，与 Cursor CLI 共享会话槽位与检查点
import {
  Codex,
  type CodexOptions,
  type Input,
  type SandboxMode,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TurnOptions,
  type UserInput,
} from "@openai/codex-sdk";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { WebSocket } from "ws";
import type { AgentMode } from "../../../shared/protocol.ts";
import { gatewayEnv } from "../config.ts";
import { broadcastFileChanged } from "../fileEvents.ts";
import { slotLog } from "../log.ts";
import { shellEnv } from "../native/tools/shell.ts";
import { type ChatHistoryItem, externalModelIds } from "../providers.ts";
import { isAbortError } from "../runtime/abort.ts";
import { rememberApproved, waitForApproval } from "../runtime/approvals.ts";
import { persistConn } from "../runtime/slots.ts";
import type { Conn, Slot } from "../runtime/types.ts";
import { sandboxEnabledForTenant, stateDir } from "../tenants.ts";
import { noteModelTokens, noteOutput, noteToolCall } from "../usage.ts";
import { undoEdits } from "../workspace/checkpoints.ts";
import { pushWorkspace, settleWorkspacePushes, workspacePath } from "../workspace/files.ts";
import { send } from "../ws/send.ts";
import { ensureTurnBaseline, recordRunCheckpoint } from "./baseline.ts";
import { finishRun } from "./finish.ts";
import { attachReseedContext } from "./history.ts";
import { emitToolOutput, presentToolArgs, rememberEdit, rememberShellCall, summarizeToolArgs } from "./tools.ts";

/** 统一模型路由前缀（禁止混用其他前缀） */
export const CODEX_MODEL_PREFIX = "codex:";

/** models_cache.json 缺失或为空时的安全回退模型列表 */
export const DEFAULT_CODEX_MODELS = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"] as const;

const MODEL_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CODEX_ROUTE_RE = /^codex:([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/;

export type CodexRoute = {
  model: string;
  full: string;
};

export type CodexThreadLike = {
  runStreamed(input: Input, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

export type CodexClientLike = {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
};

export type CodexRunnerDeps = {
  createCodex?: (options: CodexOptions) => CodexClientLike;
};

/** 解析当前 Codex CLI 的状态与凭证主目录（支持 CODEX_HOME 覆盖，默认 ~/.codex） */
export function codexHomeDir(): string {
  const custom = gatewayEnv.codexHome();
  return custom ? resolve(custom) : resolve(homedir(), ".codex");
}

/** 检查是否存在可用的 Codex 认证凭证（CODEX_API_KEY 或合法的 CODEX_HOME/auth.json） */
export function hasCodexAuth(): boolean {
  if (gatewayEnv.codexApiKey()) return true;
  const authPath = resolve(codexHomeDir(), "auth.json");
  if (!existsSync(authPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown; refresh_token?: unknown };
      access_token?: unknown;
      refresh_token?: unknown;
    };
    if (!raw || typeof raw !== "object") return false;
    if (typeof raw.OPENAI_API_KEY === "string" && raw.OPENAI_API_KEY.trim()) return true;
    const access = raw.tokens?.access_token ?? raw.access_token;
    const refresh = raw.tokens?.refresh_token ?? raw.refresh_token;
    return (
      (typeof access === "string" && Boolean(access.trim())) || (typeof refresh === "string" && Boolean(refresh.trim()))
    );
  } catch {
    return false;
  }
}

/** 从 CODEX_HOME/models_cache.json 提取合法模型 slug，失败或为空时回退 DEFAULT_CODEX_MODELS */
export function readCodexModelSlugs(): string[] {
  const explicit = gatewayEnv.codexCliModels();
  if (explicit) {
    const parsed = explicit
      .split(",")
      .map((s) => s.trim())
      .filter((s) => MODEL_SLUG_RE.test(s));
    if (parsed.length) return [...new Set(parsed)];
  }
  const cachePath = resolve(codexHomeDir(), "models_cache.json");
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf8")) as {
        models?: Array<{ slug?: unknown; id?: unknown; visibility?: unknown }>;
      };
      const rows = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
      const slugs: string[] = [];
      for (const item of rows) {
        if (!item || typeof item !== "object") continue;
        const rec = item as { slug?: unknown; id?: unknown; visibility?: unknown };
        if (rec.visibility === "hide") continue;
        const candidate =
          typeof rec.slug === "string" ? rec.slug.trim() : typeof rec.id === "string" ? rec.id.trim() : "";
        if (MODEL_SLUG_RE.test(candidate)) slugs.push(candidate);
      }
      if (slugs.length) return [...new Set(slugs)];
    } catch {
      // 缓存损坏或格式变化时静默回退默认列表
    }
  }
  return [...DEFAULT_CODEX_MODELS];
}

/**
 * 返回面向指定租户暴露的 Codex CLI 模型 ID 列表（统一前缀 `codex:<model>`）。
 * 安全门禁：Codex CLI 直接在宿主派生进程且共享 CODEX_HOME 凭证，仅向非沙箱受信任管理员租户开放。
 */
export function codexModelIds(tenant?: { sandbox: boolean; admin?: boolean } | null): string[] {
  if (tenant !== undefined && sandboxEnabledForTenant(tenant)) return [];
  if (!hasCodexAuth()) return [];
  const externalSet = new Set(externalModelIds());
  const out: string[] = [];
  for (const slug of readCodexModelSlugs()) {
    const full = `${CODEX_MODEL_PREFIX}${slug}`;
    if (!externalSet.has(full) && !out.includes(full)) out.push(full);
  }
  return out;
}

/** 识别 `codex:<model>` 模型前缀 */
export function codexRoute(modelId: string | undefined | null): CodexRoute | null {
  if (typeof modelId !== "string") return null;
  const trimmed = modelId.trim();
  const match = CODEX_ROUTE_RE.exec(trimmed);
  if (!match) return null;
  return { model: match[1], full: trimmed };
}

/** 构造传递给 Codex CLI 子进程的净化环境变量白名单（绝不泄露 CURSOR_API_KEY、APNS 私钥等网关机密） */
export function buildCodexChildEnv(): Record<string, string> {
  const env = shellEnv();
  env.CODEX_HOME = codexHomeDir();
  return env;
}

/** 识别认证过期或刷新失败错误，附加运维重登指引 */
export function formatCodexErrorMessage(rawMessage: string): string {
  const text = (rawMessage || "Codex CLI 调用失败").trim();
  if (
    /401\b|unauthorized|token[_ -]?expired|invalid_grant|refresh[_ -]?token|authentication failed|not logged in/i.test(
      text,
    )
  ) {
    return `${text}（Codex 登录凭证已失效或过期，请在服务器执行 codex login 重新完成认证）`;
  }
  return text;
}

function imageExt(mimeType: string): string {
  const lower = (mimeType || "").toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "jpg";
}

function summarizeMcpResult(item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string {
  if (item.error?.message) return item.error.message;
  if (!item.result) return "";
  const parts: string[] = [];
  if (Array.isArray(item.result.content)) {
    for (const block of item.result.content) {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  if (parts.length) return parts.join("\n");
  if (item.result.structured_content !== undefined) {
    return JSON.stringify(item.result.structured_content);
  }
  return "";
}

/** 运行一轮 Codex CLI 对话，将 JSONL 事件流转换为网关标准 WebSocket 事件 */
export async function runCodexChat(
  ws: WebSocket,
  conn: Conn,
  slot: Slot,
  route: CodexRoute,
  input: {
    prompt: string;
    compactPrompt?: string;
    userText: string;
    images: Array<{ data: string; mimeType: string }>;
    history: ChatHistoryItem[];
    epoch: number;
    cwd: string;
    mode: AgentMode;
    confirmWrites: boolean;
    autoApprove: boolean;
    reviewAppended?: boolean;
    prewarmedSkills?: Array<{ id: string; name: string }>;
  },
  deps: CodexRunnerDeps = {},
): Promise<void> {
  const { epoch, cwd, mode } = input;
  const t0 = Date.now();
  const live = () => slot.epoch === epoch && !slot.finished;

  send(ws, { type: "status", chatId: slot.chatId, status: "RUNNING" });
  send(ws, {
    type: "run_meta",
    chatId: slot.chatId,
    model: route.full,
    mode,
    policy: slot.policy,
    dialect: slot.dialect,
    ...(input.prewarmedSkills?.length ? { prewarmedSkills: input.prewarmedSkills } : {}),
  });

  // 安全红线：受限沙箱租户严禁直接派生宿主 Codex CLI
  if (sandboxEnabledForTenant(conn.tenant)) {
    const msg = "当前受限租户未启用 Codex CLI 宿主引擎，请切换管理员租户或使用受沙箱保护的模型。";
    send(ws, { type: "error", chatId: slot.chatId, message: msg });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
    return;
  }

  if (!hasCodexAuth() && !deps.createCodex) {
    const msg = "未检测到 Codex CLI 认证凭证（CODEX_API_KEY 或 ~/.codex/auth.json），请先执行 codex login。";
    send(ws, { type: "error", chatId: slot.chatId, message: msg });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
    return;
  }

  if (!input.autoApprove && (mode === "agent" || mode === "plan")) {
    recordRunCheckpoint(ws, conn, slot, cwd, mode);
  }
  ensureTurnBaseline(slot, cwd, mode);

  const abort = new AbortController();
  slot.externalAbort = abort;
  const tempImagePaths: string[] = [];

  try {
    // 与 Cursor CLI（非沙箱管理员租户 sandboxOptions.enabled = false）保持完全一致：
    // 关闭 Codex CLI 内置 Linux 沙箱（danger-full-access）并开启网络访问，使子进程可正常访问外网与跨子工作区路径；
    // Ask 模式下若发生误改，在回合结束时与 Cursor CLI 一样通过 undoEdits 自动还原。
    const sandboxMode: SandboxMode = "danger-full-access";

    // 当 Agent 模式开启 confirmWrites 时，在启动写操作子进程前先发标准 approval 卡片等待用户批准
    if (mode === "agent" && input.confirmWrites && !input.autoApprove) {
      const approvalCallId = `codex-write-${epoch}`;
      const approvalToolName = "codex_workspace_write";
      const approvalArgs = {
        cwd,
        sandboxMode,
        model: route.full,
        request: input.userText.slice(0, 200),
      };
      send(ws, {
        type: "tool-started",
        chatId: slot.chatId,
        callId: approvalCallId,
        name: approvalToolName,
        args: presentToolArgs(approvalToolName, approvalArgs),
      });
      slot.openTools.set(approvalCallId, { name: approvalToolName, args: approvalArgs });
      slot.runStats.toolStarts += 1;
      slot.awaitingApproval = true;
      slot.approvalCallId = approvalCallId;
      slot.runStats.approvals += 1;
      send(ws, {
        type: "approval",
        chatId: slot.chatId,
        callId: approvalCallId,
        name: approvalToolName,
        args: summarizeToolArgs(approvalArgs),
      });
      const allowed = await waitForApproval(slot);
      slot.awaitingApproval = false;
      slot.approvalCallId = null;
      if (!live()) return;
      if (!allowed) {
        slot.openTools.delete(approvalCallId);
        send(ws, {
          type: "tool-completed",
          chatId: slot.chatId,
          callId: approvalCallId,
          name: approvalToolName,
          status: "error",
          result: "已拒绝写入授权",
        });
        send(ws, {
          type: "status",
          chatId: slot.chatId,
          status: "CANCELLED",
          message: "已拒绝写入，未启动 Codex 写操作。",
        });
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: "\n\n已拒绝写入，未启动 Codex 写操作。",
        });
        finishRun(ws, slot, "cancelled", Date.now() - t0, epoch);
        return;
      }
      rememberApproved(slot);
      if (slot.openTools.delete(approvalCallId)) noteToolCall(slot.tenantId);
      send(ws, {
        type: "tool-completed",
        chatId: slot.chatId,
        callId: approvalCallId,
        name: approvalToolName,
        status: "completed",
        result: "已批准本轮 Codex 工作区写权限",
      });
    }

    // 跨引擎互切与续轮上下文选择：
    // 若上一轮引擎不是 codex（例如刚从 Cursor CLI 切过来）或显式标记了 reseed，
    // 则丢弃旧的 codexThreadId（防止漏掉中间在 Cursor 发生的对话），开启新线程并注入最近对话摘录
    const switchedFromOtherEngine = Boolean(slot.lastEngine && slot.lastEngine !== "codex");
    const needReseed = Boolean(slot.reseed || switchedFromOtherEngine);
    let effectivePrompt = input.prompt;
    if (needReseed) {
      slot.codexThreadId = null;
      slot.reseed = false;
      effectivePrompt = attachReseedContext(conn.tenant, slot.chatId, input.userText, input.prompt, input.history);
    } else if (slot.codexThreadId && slot.lastEngine === "codex" && !input.reviewAppended && input.compactPrompt) {
      effectivePrompt = input.compactPrompt;
    }

    // 图片落盘到租户受控状态目录下的临时文件，供 local_image 传参，finally 中清理
    let sdkInput: Input = effectivePrompt;
    if (input.images.length > 0) {
      const tmpDir = resolve(conn.tenant?.stateDir || stateDir(), "codex-tmp-images");
      mkdirSync(tmpDir, { recursive: true });
      const parts: UserInput[] = [{ type: "text", text: effectivePrompt }];
      for (let i = 0; i < input.images.length; i += 1) {
        const img = input.images[i];
        const ext = imageExt(img.mimeType);
        const filePath = resolve(tmpDir, `codex-img-${slot.chatId}-${epoch}-${i}-${Date.now()}.${ext}`);
        writeFileSync(filePath, Buffer.from(img.data, "base64"), { mode: 0o600 });
        tempImagePaths.push(filePath);
        parts.push({ type: "local_image", path: filePath });
      }
      sdkInput = parts;
    }

    const apiKey = gatewayEnv.codexApiKey() || undefined;
    const baseUrl = gatewayEnv.codexBaseUrl() || undefined;
    const codexOptions: CodexOptions = {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      env: buildCodexChildEnv(),
    };
    const codex = deps.createCodex ? deps.createCodex(codexOptions) : new Codex(codexOptions);
    const threadOpts: ThreadOptions = {
      model: route.model,
      workingDirectory: cwd,
      sandboxMode,
      networkAccessEnabled: true,
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };

    const thread = slot.codexThreadId
      ? codex.resumeThread(slot.codexThreadId, threadOpts)
      : codex.startThread(threadOpts);

    slot.lastEngine = "codex";
    const { events } = await thread.runStreamed(sdkInput, { signal: abort.signal });

    // Codex item.updated 推送的是从头累加的完整文本，按 item.id 切片计算增量 delta
    const emittedTextLen = new Map<string, number>();
    const emittedReasoningLen = new Map<string, number>();
    const emittedOutputLen = new Map<string, number>();
    const startedTools = new Set<string>();

    const sliceDelta = (map: Map<string, number>, id: string, fullText: string): string => {
      const prev = map.get(id) ?? 0;
      if (!fullText || fullText.length <= prev) return "";
      const delta = fullText.slice(prev);
      map.set(id, fullText.length);
      return delta;
    };

    const ensureToolStarted = (callId: string, name: string, args: unknown) => {
      if (startedTools.has(callId)) return;
      startedTools.add(callId);
      send(ws, {
        type: "tool-started",
        chatId: slot.chatId,
        callId,
        name,
        args: presentToolArgs(name, args),
      });
      slot.openTools.set(callId, { name, args });
      slot.runStats.toolStarts += 1;
    };

    const completeTool = (callId: string, name: string, status: "completed" | "error", result: unknown) => {
      if (slot.openTools.delete(callId)) {
        noteToolCall(slot.tenantId);
      }
      send(ws, {
        type: "tool-completed",
        chatId: slot.chatId,
        callId,
        name,
        status,
        result,
      });
    };

    const handleItem = (item: ThreadItem, phase: "started" | "updated" | "completed") => {
      if (!live()) return;
      switch (item.type) {
        case "agent_message": {
          const delta = sliceDelta(emittedTextLen, item.id, item.text || "");
          if (delta) {
            send(ws, { type: "text-delta", chatId: slot.chatId, text: delta });
            noteOutput(slot.tenantId, delta.length);
          }
          break;
        }
        case "reasoning": {
          const delta = sliceDelta(emittedReasoningLen, item.id, item.text || "");
          if (delta) {
            send(ws, { type: "thinking-delta", chatId: slot.chatId, text: delta });
            noteOutput(slot.tenantId, delta.length);
          }
          break;
        }
        case "command_execution": {
          const name = "Bash";
          const args = { command: item.command };
          ensureToolStarted(item.id, name, args);
          rememberShellCall(slot, name, item.id);
          const outDelta = sliceDelta(emittedOutputLen, item.id, item.aggregated_output || "");
          if (outDelta) {
            emitToolOutput(ws, slot, {
              callId: item.id,
              stream: "stdout",
              chunk: outDelta,
            });
          }
          if (phase === "completed") {
            const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
            completeTool(item.id, name, failed ? "error" : "completed", {
              exitCode: item.exit_code ?? (failed ? 1 : 0),
              output: (item.aggregated_output || "").slice(-4000),
            });
            pushWorkspace(ws, slot, conn);
          }
          break;
        }
        case "file_change": {
          const name = "Edit";
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const primaryPath = changes[0]?.path || "";
          const args = { path: primaryPath, changes };
          ensureToolStarted(item.id, name, args);
          const changedRelPaths: string[] = [];
          for (const ch of changes) {
            if (!ch?.path) continue;
            rememberEdit(slot, name, { path: ch.path }, cwd);
            const rel = workspacePath(cwd, ch.path) || ch.path;
            if (rel && !changedRelPaths.includes(rel)) changedRelPaths.push(rel);
          }
          if (phase === "completed") {
            const failed = item.status === "failed";
            completeTool(
              item.id,
              name,
              failed ? "error" : "completed",
              failed ? "补丁应用失败" : `已更新 ${changes.map((c) => c.path).join(", ")}`,
            );
            if (!failed && changedRelPaths.length) {
              pushWorkspace(ws, slot, conn, changedRelPaths);
              broadcastFileChanged(slot.tenantId, slot.chatId, changedRelPaths);
            }
          }
          break;
        }
        case "mcp_tool_call": {
          const name = `mcp:${item.server}:${item.tool}`;
          ensureToolStarted(item.id, name, item.arguments);
          if (phase === "completed") {
            const failed = item.status === "failed" || Boolean(item.error);
            completeTool(item.id, name, failed ? "error" : "completed", summarizeMcpResult(item));
          }
          break;
        }
        case "web_search": {
          const name = "WebSearch";
          const args = { query: item.query };
          ensureToolStarted(item.id, name, args);
          if (phase === "completed") {
            completeTool(item.id, name, "completed", `搜索：${item.query}`);
          }
          break;
        }
        case "todo_list": {
          if (Array.isArray(item.items) && item.items.length) {
            const summary = item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n");
            send(ws, { type: "task", chatId: slot.chatId, text: summary });
          }
          break;
        }
        case "error": {
          if (phase === "completed" && item.message) {
            send(ws, {
              type: "text-delta",
              chatId: slot.chatId,
              text: `\n\n[Codex 提示：${item.message}]`,
            });
          }
          break;
        }
      }
    };

    for await (const event of events) {
      if (!live()) break;
      switch (event.type) {
        case "thread.started":
          slot.codexThreadId = event.thread_id;
          slot.lastEngine = "codex";
          persistConn(conn);
          break;
        case "turn.started":
          break;
        case "item.started":
          handleItem(event.item, "started");
          break;
        case "item.updated":
          handleItem(event.item, "updated");
          break;
        case "item.completed":
          handleItem(event.item, "completed");
          break;
        case "turn.completed":
          if (event.usage) {
            noteModelTokens(
              slot.tenantId,
              event.usage.input_tokens ?? 0,
              event.usage.output_tokens ?? 0,
              event.usage.cached_input_tokens ?? 0,
            );
          }
          break;
        case "turn.failed":
          throw new Error(event.error?.message || "Codex turn failed");
        case "error":
          throw new Error(event.message || "Codex stream error");
      }
    }

    if (!live()) return;

    if (mode === "ask" && slot.edited.length) {
      const undone = undoEdits(cwd, slot.edited);
      slot.edited = [];
      if (undone.paths.length) {
        send(ws, {
          type: "text-delta",
          chatId: slot.chatId,
          text: `\n\nAsk 模式已还原误改：${undone.paths.join(", ")}`,
        });
        send(ws, {
          type: "undone",
          chatId: slot.chatId,
          paths: undone.paths,
          error: undone.error,
        });
      }
    } else if (slot.edited.length) {
      await pushWorkspace(ws, slot, conn, slot.edited);
    }
    await settleWorkspacePushes(ws);
    finishRun(ws, slot, "completed", Date.now() - t0, epoch);
  } catch (err) {
    if (!live()) return;
    if (isAbortError(err) || abort.signal.aborted) {
      finishRun(ws, slot, "cancelled", Date.now() - t0, epoch);
      return;
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    const formatted = formatCodexErrorMessage(rawMsg);
    slotLog(slot).error("codexRunner", formatted);
    send(ws, { type: "error", chatId: slot.chatId, message: formatted });
    finishRun(ws, slot, "error", Date.now() - t0, epoch);
  } finally {
    if (slot.externalAbort === abort) slot.externalAbort = null;
    if (slot.approvalCallId && !slot.awaitingApproval) slot.approvalCallId = null;
    for (const imgPath of tempImagePaths) {
      try {
        unlinkSync(imgPath);
      } catch {
        // ignore missing temp file
      }
    }
  }
}
