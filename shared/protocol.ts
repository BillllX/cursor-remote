export type AgentMode = "agent" | "plan" | "ask";

export type PromptImage = { data: string; mimeType: string };

export type CheckpointInfo = { id: string; label: string; createdAt: number };

export type ClientMessage =
  | { type: "hello"; token?: string }
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
  | { type: "approval_reply"; chatId: string; callId: string; allow: boolean }
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
    }
  | { type: "workspaces"; root: string; items: { path: string; name: string }[] }
  | { type: "workspace_created"; path: string; name: string }
  | { type: "session"; chatId: string; agentId: string; cwd: string }
  | { type: "run_meta"; chatId: string; model: string; mode?: AgentMode }
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
    }
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
  | { type: "stored_state"; chats: unknown[]; rev?: number; deletedIds?: string[] }
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
