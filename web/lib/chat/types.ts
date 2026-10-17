// 会话与回合的数据形状（网页本地状态）
import type { AgentMode, CheckpointInfo, PolicyId, PromptImage, TurnFile } from "@shared/protocol";

export type ToolCall = {
  callId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "running" | "completed" | "error";
  review?: "accepted" | "rejected";
  parentCallId?: string;
  agent?: string;
  model?: string;
};

export type Turn = {
  id: string;
  user: string;
  assistant: string;
  thinking: string;
  tools: ToolCall[];
  task?: string;
  error?: string;
  running: boolean;
  queued?: boolean;
  images?: PromptImage[];
  mode?: AgentMode;
  model?: string;
  todos?: TodoItem[];
  status?: string;
  durationMs?: number;
  pendingTool?: { callId: string; name: string; args?: unknown };
  files?: TurnFile[];
};

export type Chat = {
  id: string;
  title: string;
  turns: Turn[];
  agentId?: string;
  draft?: string;
  model?: string;
  mode?: AgentMode;
  cwd?: string;
  previewTabs?: { path: string; line?: number }[];
  previewPath?: string;
  unread?: boolean;
  confirmWrites?: boolean;
  policy?: PolicyId;
  draftImages?: PromptImage[];
  checkpoints?: CheckpointInfo[];
  /** 网关给的最后一条摘要；正文没加载时侧栏和搜索用它 */
  preview?: string;
  /** 最近一次开始或结束回复的时间（毫秒）；侧栏按它给工作区排序、显示“几分钟前” */
  touchedAt?: number;
};

/**
 * 会话正文的加载状态。rev 是这份正文对应的服务端 chatRev（本地新建还没上传的为 undefined）。
 * loading 时：target 是发请求时的 chatRev；base 是用来只补最后一页的旧正文；buf 是从后往前攒的页。
 */
export type BodyState =
  | { state: "complete"; rev: number | undefined }
  | {
      state: "loading";
      rev: number | undefined;
      prev: "none" | "complete";
      nonce: number;
      target: number;
      base: Turn[] | null;
      buf: Turn[];
      progressive: boolean;
    };

export type TodoItem = { id: string; content: string; status: string };
