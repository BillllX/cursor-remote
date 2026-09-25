export type AgentMode = "agent" | "plan" | "ask";

/** baseline = 现有拦截/整轮重放；plane = 策略层（工具集限制、按指纹放行、方言 overlay） */
export type PolicyId = "baseline" | "plane";

export type PromptImage = { data: string; mimeType: string };

export type CheckpointInfo = { id: string; label: string; createdAt: number };

// maxMessageBytes：客户端单条 WS 消息接收上限（iOS URLSessionWebSocketTask 约 1MiB）。
// 网关对超限的大消息（目前只有 stored_state）改发 stored_state_deferred，客户端走 HTTP /state 拉取。
// caps：客户端能力集。已知值：
//   "sync_chat"     —— 支持单会话增量上传（sync_chat）与 sync_ack 回执
//   "stored_digest" —— 分叉时收 stored_digest 目录 + load_chats 按需拉取，而不是全量 stored_state
//   "slim_state"    —— stored_state/stored_chat 只给元数据（剥 turns，补 preview），内容走 load_chat 分页；
//                     该客户端 sync_chat 可不写 turns 键（=保留服务端 turns，键缺失≠清空）
export type HelloClient = { name: string; version: string; maxMessageBytes?: number; caps?: string[] };

export type ClientMessage =
  | { type: "hello"; token?: string; client?: HelloClient }
  | { type: "set_workspace"; cwd: string; chatId?: string; create?: boolean }
  | { type: "list_workspaces" }
  | { type: "create_workspace"; name: string }
  | {
      type: "prompt";
      text: string;
      model?: string;
      mode?: AgentMode;
      chatId: string;
      files?: string[];
      images?: PromptImage[];
      confirmWrites?: boolean;
      autoApprove?: boolean;
      fresh?: boolean;
      nameChat?: boolean;
      policy?: PolicyId;
      /** 缺省 true。false 时关掉中文系方言 overlay，给 dialect-bench 对照用 */
      dialect?: boolean;
    }
  | { type: "cancel"; chatId: string }
  | { type: "drop_queued"; chatId: string; text?: string }
  | { type: "set_model"; model: string; chatId?: string }
  | { type: "list_checkpoints"; chatId: string }
  | { type: "undo"; chatId: string }
  | { type: "revert_file"; chatId: string; path: string }
  | { type: "revert_hunk"; chatId: string; path: string; hunk: string }
  | { type: "restore"; chatId: string; checkpointId: string }
  | { type: "new_session"; chatId: string; cwd?: string }
  | { type: "delete_session"; chatId: string }
  | { type: "resume_session"; chatId: string; agentId: string }
  | { type: "list_files"; query?: string; chatId?: string; mention?: boolean }
  | { type: "search_text"; query: string; chatId?: string }
  | { type: "read_file"; path: string; chatId?: string; diff?: boolean }
  | { type: "write_file"; path: string; content: string; chatId?: string }
  | {
      type: "upload_file";
      chatId: string;
      name: string;
      data: string;
      mimeType?: string;
      id?: string;
    }
  | {
      type: "fs_op";
      op: "create" | "mkdir" | "rename" | "delete";
      path: string;
      to?: string;
      chatId?: string;
    }
  | { type: "sync_state"; chats: unknown[]; rev?: number }
  // 单会话增量上传（P4b）：只带变化的那个会话；删除/新建等结构变化仍走 sync_state
  | { type: "sync_chat"; chat: unknown; rev?: number }
  // stored_digest 后按需拉取单个会话全量（P4c）
  | { type: "load_chats"; ids: string[] }
  // slim_state 客户端的会话内容分页（P8）：from 省略=最后一页，否则拉 turns[..<from] 的上一页
  | { type: "load_chat"; chatId: string; from?: number }
  | { type: "approval_reply"; chatId: string; callId: string; allow: boolean }
  | { type: "set_policy"; policy: PolicyId; chatId?: string }
  | { type: "ping" };

export type PreviewKind =
  | "text"
  | "canvas"
  | "markdown"
  | "html"
  | "image"
  | "svg"
  | "pdf"
  | "audio"
  | "video"
  | "binary";

export type MediaTicket = { exp: number; sig: string };

export type SearchHit = { path: string; line: number; text: string };

export type ToolMeta = {
  parentCallId?: string;
  agent?: string;
  model?: string;
};

export type HistoryTurn = {
  id: string;
  user: string;
  assistant: string;
  thinking?: string;
  tools?: Array<{
    callId: string;
    name: string;
    args?: unknown;
    result?: unknown;
    status: "running" | "completed" | "error";
    parentCallId?: string;
    agent?: string;
    model?: string;
  }>;
};

export type ServerMessage =
  | {
      type: "ready";
      cwd: string;
      hasApiKey: boolean;
      model: string;
      models: string[];
      agentId: string | null;
      runningChatIds?: string[];
      queuedChatIds?: string[];
      workspaceRoot?: string;
      tenantId?: string;
      tenantName?: string;
      policy?: PolicyId;
    }
  | { type: "workspaces"; root: string; items: { path: string; name: string }[] }
  | { type: "workspace_created"; path: string; name: string }
  | { type: "session"; chatId: string; agentId: string; cwd: string }
  | { type: "run_meta"; chatId: string; model: string; mode?: AgentMode; policy?: PolicyId; dialect?: boolean }
  | { type: "text-delta"; chatId: string; text: string }
  | { type: "thinking-delta"; chatId: string; text: string }
  | ({
      type: "tool-started";
      chatId: string;
      callId: string;
      name: string;
      args?: unknown;
    } & ToolMeta)
  | ({
      type: "tool-completed";
      chatId: string;
      callId: string;
      name: string;
      status: "completed" | "error";
      result?: unknown;
    } & ToolMeta)
  | { type: "task"; chatId: string; text: string }
  | { type: "status"; chatId?: string; status: string; message?: string }
  | { type: "error"; chatId?: string; message: string }
  | ({
      type: "approval";
      chatId: string;
      callId: string;
      name: string;
      args?: unknown;
    } & ToolMeta)
  | {
      type: "done";
      chatId: string;
      status: string;
      durationMs?: number;
      policy?: PolicyId;
      toolStarts?: number;
      intercepts?: number;
      approvals?: number;
      replays?: number;
      dialect?: boolean;
    }
  | { type: "policy"; policy: PolicyId; chatId?: string }
  | { type: "files"; query: string; paths: string[]; status?: Record<string, string>; mention?: boolean; truncated?: boolean; chatId?: string }
  | { type: "search_hits"; query: string; hits: SearchHit[]; chatId?: string }
  | {
      type: "file_content";
      path: string;
      chatId?: string;
      content?: string;
      error?: string;
      diff?: boolean;
      kind?: PreviewKind;
      mime?: string;
      size?: number;
      url?: string;
      headUrl?: string;
      media?: MediaTicket;
    }
  | { type: "file_written"; path: string; chatId?: string; error?: string }
  | {
      type: "file_uploaded";
      path: string;
      chatId?: string;
      name?: string;
      error?: string;
      size?: number;
      id?: string;
    }
  | {
      type: "fs_done";
      op: string;
      path: string;
      to?: string;
      error?: string;
      chatId?: string;
    }
  | { type: "stored_state"; chats: unknown[]; rev?: number; deletedIds?: string[]; chatRevs?: Record<string, number> }
  // stored_state 超过客户端 maxMessageBytes 时的替代通知：客户端应 HTTP GET /state 拉全量
  | { type: "stored_state_deferred"; rev?: number }
  // sync_state / sync_chat 被接受后的回执（P4b）：携带服务端最新 rev 与相关会话的 chatRev
  | { type: "sync_ack"; rev?: number; chatRevs?: Record<string, number> }
  // 分叉时的目录推送（P4c，需 caps: ["stored_digest"]）：客户端比对 chatRevs 后用 load_chats 拉差异会话
  | { type: "stored_digest"; rev?: number; deletedIds?: string[]; chatRevs?: Record<string, number> }
  // load_chats 的应答：单个会话全量（slim_state 客户端为剥 turns 的元数据）
  | { type: "stored_chat"; chat: unknown; rev?: number }
  // load_chat 的应答（P8）：turns[from..] 一页；hasMore=前面还有；单条超预算的 turn 带 clipped 标记
  | { type: "chat_turns"; chatId: string; turns: unknown[]; from: number; hasMore: boolean; total: number }
  | { type: "auth"; ok: boolean; message?: string }
  | {
      type: "tool-output";
      chatId: string;
      callId: string;
      stream?: "stdout" | "stderr";
      chunk?: string;
      stdout?: string;
      stderr?: string;
    }
  | { type: "history"; chatId: string; turns: HistoryTurn[] }
  | { type: "undone"; chatId: string; paths: string[]; error?: string }
  | { type: "checkpoints"; chatId: string; items: CheckpointInfo[] }
  | {
      type: "restored";
      chatId: string;
      checkpointId?: string;
      label?: string;
      error?: string;
      silent?: boolean;
    }
  | { type: "chat_title"; chatId: string; title: string }
  | { type: "pong" };
