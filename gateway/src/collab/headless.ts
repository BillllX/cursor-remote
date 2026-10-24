import type { AgentOptions, Run, RunResult, SDKAgent } from "@cursor/sdk";
import { isPlane, parsePolicy, toolFingerprint } from "../../../shared/policy.ts";
import type { ApprovalRef, HistoryTurn, PolicyId, TurnFile } from "../../../shared/protocol.ts";
import { isMutatingTool, toolEscapesWorkspace } from "../chat/tools.ts";
import { computeTurnFiles } from "../turnFiles.ts";
import { confinedCwd, sandboxEnabledForTenant, type Tenant } from "../tenants.ts";

export type RunContext = {
  tenant: Tenant;
  chatId: string;
  cwd: string;
  model: string;
  mode: "agent";
  policy: PolicyId;
  dialect: boolean;
  clock: { now: number; tz: string };
  approvalPolicy: "workspace_safe";
  approvedFingerprints?: string[];
  approvalDecisions?: Array<{ fingerprint: string; allow: boolean }>;
  signal?: AbortSignal;
  sourceTurnId?: string;
};

export interface RunObserver {
  onText(chunk: string): void;
  onTool(event: { name: string; status: string }): void;
  onApproval(card: ApprovalRef): void;
  onFiles(files: TurnFile[]): void;
  onDone(status: "completed" | "awaiting" | "failed"): void;
}

type HeadlessDeps = {
  apiKey: () => string;
  create?: (options: AgentOptions) => Promise<SDKAgent>;
  prompt?: (message: string, options: AgentOptions) => Promise<RunResult>;
};

let deps: HeadlessDeps | null = null;

export function bindHeadlessRunHost(next: HeadlessDeps) {
  deps = next;
}

export type HeadlessResult =
  | { status: "completed"; text: string; files: TurnFile[]; suggestedNextActors?: string[] }
  | { status: "awaiting"; text: string; approval: ApprovalRef; files: TurnFile[] }
  | { status: "cancelled"; text: string }
  | { status: "failed"; error: string };

const PREAMBLE = [
  "你在协作任务的无头运行器中，完成任务后用中文简要汇报。",
  "只能在当前工作区内读写；禁止发布、部署、联网写操作和操作工作区外路径。",
  "不要探测父级 Git 仓库或兄弟工作区；Shell 的 working_directory 固定为当前工作区，命令中的文件路径优先使用相对路径。工作区外信息不可用时直接跳过，不要尝试绕过。",
  "普通工作区文件写入可直接执行。命令只用于构建、测试、格式化和只读检查；危险命令必须让安全审查拒绝或进入审批。",
  "不要派子 Agent，不要写助理 Inbox。",
  '最终回复可以是严格 JSON：{"summary":"...","suggestedNextActors":["actor:workspace:..."]}；建议只供小驳决定下一 wave，你不能自行创建任务。',
].join("\n");

export type HeadlessToolDecision =
  | { action: "allow"; fingerprint: string }
  | { action: "approval"; fingerprint: string; reason: string }
  | { action: "deny"; fingerprint: string; reason: string };

function shellCommand(args: unknown) {
  if (!args || typeof args !== "object") return "";
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

/** 独立于租户 admin/sandbox 配置的 Collab 工具授权边界。 */
export function authorizeHeadlessTool(
  context: Pick<RunContext, "cwd" | "policy" | "approvalPolicy" | "approvedFingerprints" | "approvalDecisions">,
  name: string,
  args: unknown,
): HeadlessToolDecision {
  const fingerprint = toolFingerprint(name, args);
  if (context.approvalPolicy !== "workspace_safe") {
    return { action: "deny", fingerprint, reason: "未知的协作工具授权策略" };
  }
  if (toolEscapesWorkspace(context.cwd, name, args)) {
    return { action: "deny", fingerprint, reason: "工具路径或工作目录超出当前工作区" };
  }
  const command = shellCommand(args);
  if (
    command &&
    [...command.matchAll(/(?:^|[\s"'=])((?:\/|~\/|\.\.\/)[^\s"';&|]*)/g)].some((match) => {
      const raw = match[1];
      if (raw === "/dev/null" || raw.startsWith("/dev/")) return false;
      const confined = confinedCwd(raw, context.cwd);
      return !confined;
    })
  ) {
    return { action: "deny", fingerprint, reason: "Shell 命令引用了工作区外路径" };
  }
  if (command && (/(?:^|[\s"'=])\.\.(?=$|[/\\\s"';&|])/m.test(command) || /(?:^|[\s;&|])git(?:\s|$)/im.test(command))) {
    return {
      action: "deny",
      fingerprint,
      reason: "协作 Headless 禁止通过 Shell 探测父目录或 Git 仓库",
    };
  }
  if (
    command &&
    /\b(curl|wget|nc|ncat|ssh|scp|rsync|git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|jiebo-publish)\b/i.test(
      command,
    )
  ) {
    return { action: "deny", fingerprint, reason: "协作 Headless 禁止网络或发布操作" };
  }
  if (
    command &&
    /(^|[\s;&|])(sudo|su)(\s|$)|\brm\s+-[^\n]*r[^\n]*f\s+(\/|~|\.\.)|\b(chmod|chown)\s+-R\b/i.test(command)
  ) {
    return { action: "deny", fingerprint, reason: "协作 Headless 禁止危险系统命令" };
  }
  const protectedOperation =
    isMutatingTool(name, args) && (!isPlane(context.policy) || /(shell|bash|terminal|command)/i.test(name));
  const approved =
    context.approvedFingerprints?.includes(fingerprint) ||
    context.approvalDecisions?.some((decision) => decision.allow && decision.fingerprint === fingerprint);
  if (protectedOperation && !approved) {
    return { action: "approval", fingerprint, reason: "该受保护操作需要用户批准" };
  }
  return { action: "allow", fingerprint };
}

function structuredResult(text: string) {
  try {
    const value = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as {
      summary?: unknown;
      suggestedNextActors?: unknown;
    };
    if (!value || typeof value.summary !== "string") return { text };
    return {
      text: value.summary,
      suggestedNextActors: Array.isArray(value.suggestedNextActors)
        ? value.suggestedNextActors.filter(
            (actor): actor is string => typeof actor === "string" && actor.startsWith("actor:workspace:"),
          )
        : [],
    };
  } catch {
    return { text };
  }
}

/**
 * D0c 可写 adapter：不复用只读 background，也不依赖在线 WebSocket。
 * cwd 先经与交互 runner 相同的 confinedCwd 边界校验，SDK 沙箱与 Auto-review 继续生效。
 */
export async function runHeadless(context: RunContext, task: string, observer: RunObserver): Promise<HeadlessResult> {
  if (!deps) return { status: "failed", error: "Headless Run Host 没有初始化" };
  const cwd = confinedCwd(context.cwd, context.tenant.workspaceRoot);
  if (!cwd || cwd !== context.cwd) return { status: "failed", error: "协作任务工作区越界" };
  parsePolicy(context.policy);
  const apiKey = deps.apiKey();
  if (!apiKey) return { status: "failed", error: "服务器没有配置 CURSOR_API_KEY" };
  const sdkSandbox = sandboxEnabledForTenant(context.tenant);

  const options: AgentOptions = {
    apiKey,
    model: { id: context.model },
    mode: "agent",
    // 不开放 task/mcp/web/delete。没有 SDK 沙箱时不提供 Shell，避免字符串检查被变量展开绕过。
    tools: sdkSandbox
      ? ["read", "grep", "glob", "ls", "edit", "shell", "readLints"]
      : ["read", "grep", "glob", "ls", "edit", "readLints"],
    local: {
      cwd,
      autoReview: true,
      // 普通租户使用 SDK 沙箱；明确受信租户可关闭沙箱，但同时失去 Shell 工具。
      sandboxOptions: { enabled: sdkSandbox },
      settingSources: ["project"],
    },
    idempotencyKey: context.chatId,
  };
  const tools: NonNullable<HistoryTurn["tools"]> = [];
  // Headless 不读取父 Git 元数据；文件卡由结构化工具路径和工作区内 diff 生成。
  const baseline = null;
  let agent: SDKAgent | undefined;
  let run: Run | undefined;
  let denied: string | undefined;
  let pendingApproval: ApprovalRef | undefined;
  const collectFiles = (text: string) =>
    computeTurnFiles({
      cwd,
      stateDir: context.tenant.stateDir,
      tools,
      baseline,
      assistantBody: text,
      // Collab Headless 不通过 Git 兜底读取父仓库；文件内容只来自受控工具结果。
      fallbackDiff: () => null,
    }).map((file) => ({
      ...file,
      sourceChatId: context.chatId,
      sourceTurnId: context.sourceTurnId || context.chatId,
    }));
  const cancel = () => {
    if (run?.supports("cancel")) void run.cancel().catch(() => undefined);
  };
  context.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let result: RunResult;
    if (deps.create) {
      agent = await deps.create(options);
      run = await agent.send(`${PREAMBLE}\n\n${task}`, {
        mode: "agent",
        model: { id: context.model },
        local: { force: true },
        onDelta: ({ update }) => {
          const event = update as {
            type?: string;
            text?: string;
            callId?: string;
            toolCall?: { name?: string; type?: string; args?: unknown; result?: unknown; status?: string };
          };
          if (event.type === "text-delta" && event.text) observer.onText(event.text);
          if (event.type === "tool-call-started") {
            const name = event.toolCall?.name || event.toolCall?.type || "tool";
            const callId = event.callId || `call-${tools.length + 1}`;
            const decision = authorizeHeadlessTool(context, name, event.toolCall?.args);
            tools.push({
              callId,
              name,
              args: event.toolCall?.args,
              status: "running",
            });
            observer.onTool({ name, status: "running" });
            if (decision.action === "deny") {
              denied = decision.reason;
              cancel();
            } else if (decision.action === "approval") {
              pendingApproval = {
                id: `approval:${context.chatId}:${callId}`,
                callId,
                fingerprint: decision.fingerprint,
                summary: decision.reason,
                tool: name,
                expiresAt: Date.now() + 24 * 60 * 60_000,
              };
              cancel();
            }
          }
          if (event.type === "tool-call-completed") {
            const known = tools.find((item) => item.callId === event.callId);
            const name = event.toolCall?.name || event.toolCall?.type || known?.name || "tool";
            if (known) {
              known.status = event.toolCall?.status === "error" ? "error" : "completed";
              known.result = event.toolCall?.result;
            }
            observer.onTool({ name, status: event.toolCall?.status || "completed" });
          }
        },
      });
      if (context.signal?.aborted || denied || pendingApproval) cancel();
      result = await run.wait();
    } else if (deps.prompt) {
      result = await deps.prompt(`${PREAMBLE}\n\n${task}`, options);
    } else {
      throw new Error("Headless Run Host 没有 SDK create/prompt 实现");
    }
    const text = (result.result || "").trim();
    if (denied) {
      observer.onDone("failed");
      return { status: "failed", error: denied };
    }
    if (pendingApproval) {
      observer.onApproval(pendingApproval);
      const files = collectFiles(text);
      observer.onFiles(files);
      observer.onDone("awaiting");
      return { status: "awaiting", text, approval: pendingApproval, files };
    }
    if (result.status === "finished") {
      const structured = structuredResult(text);
      if (!deps.create) observer.onText(structured.text);
      const files = collectFiles(structured.text);
      observer.onFiles(files);
      observer.onDone("completed");
      return { status: "completed", text: structured.text, files, suggestedNextActors: structured.suggestedNextActors };
    }
    if (result.status === "cancelled" || context.signal?.aborted) {
      observer.onDone("failed");
      return { status: "cancelled", text };
    }
    const error = result.error?.message || `运行结束状态 ${result.status}`;
    if (/approv|review|confirm|批准|审批/i.test(error)) {
      const tool = tools.at(-1)?.name || "受保护操作";
      const callId = tools.at(-1)?.callId;
      const approval: ApprovalRef = {
        id: `approval:${context.chatId}:${callId || "run"}`,
        callId,
        fingerprint: tools.at(-1) ? toolFingerprint(tool, tools.at(-1)?.args) : undefined,
        summary: error.slice(0, 500),
        tool,
        expiresAt: Date.now() + 24 * 60 * 60_000,
      };
      observer.onApproval(approval);
      const files = collectFiles(text);
      observer.onFiles(files);
      observer.onDone("awaiting");
      return { status: "awaiting", text, approval, files };
    }
    observer.onDone("failed");
    return { status: "failed", error };
  } catch (error) {
    if (context.signal?.aborted || (error instanceof Error && /abort|cancel/i.test(error.message))) {
      observer.onDone("failed");
      return { status: "cancelled", text: "" };
    }
    observer.onDone("failed");
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    context.signal?.removeEventListener("abort", cancel);
    agent?.close();
  }
}
