// 提示词组装：工作区规则与用户消息包装
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ReviewBinding, reviewPanelPrompt, workspaceConfinePrompt } from "../../../shared/crew.ts";
import type { AgentMode } from "../../../shared/protocol.ts";
import { PUBLISH_AGENT_PROMPT, PUBLISH_DENIED_PROMPT, PUBLISH_OWNER_PROMPT } from "../../../shared/publishPrompt.ts";
import { workspaceContextFor } from "../assistant/service.ts";
import { log } from "../log.ts";
import type { Tenant } from "../tenants.ts";
import { expandAttachments } from "./attachments.ts";

/** 有租户时：W0 工作偏好 + 从 cwd 往上到 USER 根目录的分层规则；没有租户只读 cwd 这一层 */
export function loadWorkspaceRules(cwd: string, tenant?: Tenant | null): string {
  if (tenant) {
    try {
      return workspaceContextFor(tenant, cwd);
    } catch (err) {
      log.error("workspace context", err);
    }
  }
  const chunks: string[] = [];
  const take = (rel: string) => {
    const abs = resolve(cwd, rel);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return;
      const text = readFileSync(abs, "utf8").trim();
      if (text) chunks.push(`# ${rel}\n${text}`);
    } catch (err) {
      // skip unreadable rule files
      log.debug("规则文件读不了", abs, err instanceof Error ? err.message : err);
    }
  };
  take(".cursorrules");
  take("AGENTS.md");
  const dir = resolve(cwd, ".cursor/rules");
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      for (const name of readdirSync(dir).sort()) {
        if (!/\.(md|mdc)$/i.test(name)) continue;
        take(`.cursor/rules/${name}`);
      }
    }
  } catch (err) {
    // no rules directory
    log.debug("规则目录读不了", dir, err instanceof Error ? err.message : err);
  }
  return chunks.join("\n\n").slice(0, 16_000);
}

export function wrapPrompt(
  text: string,
  mode: AgentMode,
  files?: string[],
  rules?: string,
  cwd?: string,
  panel: ReviewBinding[] = [],
  atUserRoot = false,
  confine = true,
): string {
  let body = text;
  if (files?.length) {
    const expanded = cwd ? expandAttachments(cwd, files) : "";
    body = `The user attached these workspace files as context:\n${files
      .map((file) => `- ${file}`)
      .join("\n")}${expanded ? `\n\n${expanded}` : ""}\n\n${text}`;
  }
  if (rules?.trim()) {
    body = `Workspace rules (follow these):\n${rules.trim()}\n\n${body}`;
  }
  const bound = cwd && confine ? `${workspaceConfinePrompt(cwd)}\n\n` : "";
  const publishPrompt = confine ? (atUserRoot ? PUBLISH_AGENT_PROMPT : PUBLISH_DENIED_PROMPT) : PUBLISH_OWNER_PROMPT;
  const planPublish = confine
    ? atUserRoot
      ? "不要执行 jiebo-publish。需要外网地址时，把 jiebo-publish start -- <启动命令> 写进方案。网站只能在这个 USER 工作区里做。"
      : "不要执行 jiebo-publish，也不要把它写进方案。对外网站只能在 USER 工作区里创建。"
    : "不要执行 jiebo-publish。需要外网地址时，把 jiebo-publish start -- <启动命令> 写进方案。这个用户的任意会话都能创建对外网站。";
  const crewStay = confine
    ? "Subagents must stay inside the current workspace."
    : "Subagents have the same reach as the USER workspace and may edit any directory under this user's root.";
  if (mode === "ask") {
    return `${bound}ASK MODE (read-only). You must not modify the workspace.
Do not call write, edit, delete, apply patch, or any mutating shell command (rm, mv, git commit, npm install, etc.).
Do not run jiebo-publish.
If the user wants a change, explain what you would do and stop. Answer in text only.
Do not spawn subagents. Any suggested change must stay inside the current workspace.

${body}`;
  }
  if (mode === "plan") {
    return `${bound}Plan mode: 只出方案，不要改文件，不要跑会改系统的命令。用中文分步写清楚。用户点「执行这个计划」后才会动手。
${confine ? "方案里的每一步都只能动当前工作区里的文件，不要提议改工作区外的路径。" : "方案可以动这个用户根目录下的各个子工作区，和 USER 工作区权限相同。"}
${planPublish}
可以派出 explore 子代理做只读摸底。不要派出 builder。
${reviewPanelPrompt(panel)}

${body}`;
  }
  return `${bound}CANVAS: If this turn's deliverable is a standalone analytical artifact (table, chart, review, metrics, timeline, architecture comparison), write exactly one file at .cursor-remote/canvases/<kebab-name>.canvas.tsx.
Import only from "cursor/canvas". Default-export one React component. Embed data inline. No fetch(), no relative imports, no npm packages.
Link that file in the reply, e.g. [仓库概览](.cursor-remote/canvases/repo-overview.canvas.tsx). Do not write a canvas for ordinary Q&A or a pure code edit.
画布颜色跟应用主题走：只用 cursor/canvas 组件和 useHostTheme() 上色，不要写死 hex、rgb、hsl，也不要另做一套深浅色。宿主会套上用户当前的配色。

命令或工具失败时不要结束整个任务。同一件事最多再试 2 次，每次换一种做法，不要原样重复。仍失败就把这一步记下来；后面不依赖它的步骤继续做。全部做完再说明哪一步没成。

${publishPrompt}

CREW: Named subagents via the Task/Agent tool: explore (read-only search), builder (implement). ${crewStay}
${reviewPanelPrompt(panel)}

${body}`;
}
