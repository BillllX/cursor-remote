export type AgentMode = "agent" | "plan" | "ask";

/** USER 根目录 AGENTS.md 没设名字或不合法时，助理叫这个。iOS 有同名常量 */
export const DEFAULT_ASSISTANT_NAME = "小驳";

export type AssistantInboxItem = {
  id: string;
  kind: "approval" | "delegation" | "reminder" | "brief" | "run" | "memory" | "info";
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
  chatId?: string;
  scheduleId?: string;
  delegationId?: string;
};

export type AssistantMemoryEntry = {
  id: string;
  rev: number;
  topic: string;
  kind: string;
  text: string;
  basis: "user_said" | "inferred";
  confidence: number;
  source?: { chatId?: string; turn?: number; chatDeleted?: boolean };
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  invalidAt?: string | null;
  invalidReason?: string;
  supplements?: string[];
};

export type AssistantDelegation = {
  id: string;
  parentChatId?: string;
  childChatId: string;
  workspace: string;
  title: string;
  mode: "foreground" | "background";
  status: "running" | "awaiting" | "done" | "failed";
  createdAt: number;
  endedAt?: number;
  result?: string;
};

export type AssistantApproval = {
  id: string;
  chatId: string;
  callId: string;
  tool: string;
  /** 参数摘要，不含文件全文 */
  summary: string;
  delegationId?: string;
  parentChatId?: string;
  createdAt: number;
  expiresAt: number;
};

export type AssistantState = {
  name: string;
  background: { model: string; ok: boolean; reason?: string };
  pushKey?: string;
  inbox: AssistantInboxItem[];
  todos: Array<{ id: string; text: string; due?: string; done: boolean; doneAt?: number; createdAt: number }>;
  schedules: Array<{
    id: string;
    title: string;
    kind: "prompt" | "brief" | "remind";
    cron: string;
    tz: string;
    prompt: string;
    enabled: boolean;
    nextAt: number | null;
    lastStatus?: string;
    failCount: number;
    pausedReason?: string;
  }>;
  delegations: AssistantDelegation[];
  /** 委派子会话停在审批上的工具调用；任一在线设备、父会话或收件箱都能作答 */
  approvals: AssistantApproval[];
  runs: Array<{ runId: string; origin: string; label: string; status: string; startedAt: number; endedAt?: number; summary?: string; error?: string }>;
  brief?: { day: string; text: string } | null;
  memory?: {
    rev: number;
    core: { rev: number; fields: Record<string, string> };
    entries: AssistantMemoryEntry[];
    settings: { paused: boolean; allowSensitive: Record<string, boolean | undefined> };
    sensitive: Record<string, string>;
    coreTokens: number;
    coreBudget: number;
  };
};

/** assistant_op 的操作名；args 由网关逐项校验 */
export type AssistantOp =
  | "inbox_read"
  | "todo_add"
  | "todo_done"
  | "todo_undo"
  | "todo_remove"
  | "schedule_set"
  | "schedule_remove"
  | "memory_save"
  | "memory_edit"
  | "memory_invalidate"
  | "memory_restore"
  | "memory_forget"
  | "memory_purge"
  | "memory_purge_all"
  | "memory_core"
  | "memory_settings"
  | "memory_export"
  | "push_subscribe"
  | "push_unsubscribe"
  | "push_test"
  /** args: { chatId, callId, allow }；作答委派子会话的挂起审批 */
  | "approval_answer";

/** baseline = 现有拦截/整轮重放；plane = 策略层（工具集限制、按指纹放行、方言 overlay） */
export type PolicyId = "baseline" | "plane";

export type PromptImage = { data: string; mimeType: string };

export type CheckpointInfo = { id: string; label: string; createdAt: number };

// maxMessageBytes：客户端单条 WS 消息接收上限（iOS URLSessionWebSocketTask 约 1MiB）。
// 网关对超限的大消息（目前只有 stored_state）改发 stored_state_deferred，客户端走 HTTP /state 拉取。
// caps：客户端能力集。已知值：
//   "sync_chat"     —— 支持单会话增量上传（sync_chat）与 sync_ack 回执
//   "stored_digest" —— 分叉时收 stored_digest 目录 + load_chats 按需拉取，而不是全量 stored_state
//   "slim_state"    —— stored_state 只给元数据（剥 turns，补 preview），内容走 load_chat 分页；
//                      stored_chat（load_chats 应答）仍回全量——digest 对账是跨设备 turns 更新唯一通道
//                     该客户端 sync_chat 可不写 turns 键（=保留服务端 turns，键缺失≠清空）
//                     网页 v2 起不再上传正文：图片随网关转录落盘，截断走 truncate_turns
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
      /** P11：第三方模型（model 带 provider: 前缀）的会话历史——客户端是内容权威源，
       *  网关无状态，随 prompt 上行最近若干条 user/assistant 文本；Cursor 路径忽略 */
      history?: { role: "user" | "assistant"; text: string }[];
      /** 客户端本地回合 id。网关用它对齐缓冲、快照和落盘，避免靠用户原文配对 */
      turnId?: string;
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
  // 只改工具的保留/还原标记，不回传工具正文
  | {
      type: "tool_review";
      chatId: string;
      turnId: string;
      reviews: { callId: string; review: "accepted" | "rejected" }[];
    }
  // 删掉 turnId 这一轮及之后的回合（编辑、重试）。会话在跑时不改，只回当前 chatRev；不做 rev 拒绝，回执带 truncated
  | { type: "truncate_turns"; chatId: string; turnId: string; rev: number }
  // 按本连接能力重发一份 stored_state（slim 客户端只有元数据和 preview）
  | { type: "load_state" }
  // stored_digest 后按需拉取单个会话全量（P4c）
  | { type: "load_chats"; ids: string[] }
  // slim_state 客户端的会话内容分页（P8）：from 省略=最后一页，否则拉 turns[..<from] 的上一页。
  // nonce：客户端分页代际标记，网关在 chat_turns 原样回显——降级/重启分页后旧链迟到页据此丢弃
  | { type: "load_chat"; chatId: string; from?: number; nonce?: number }
  | { type: "approval_reply"; chatId: string; callId: string; allow: boolean }
  | { type: "set_policy"; policy: PolicyId; chatId?: string }
  // 管理员查询全部租户的使用统计（P9）：仅 tenants.json 里 admin: true 的租户可用
  | { type: "admin_stats" }
  | { type: "ping" }
  // 产品 Loop（见 docs/IDE.md）：挂在某个会话上的重复任务。L1 只定消息形状，调度在 L2
  | {
      type: "loop_start";
      chatId: string;
      goal: string;
      intervalSec: number;
      maxTicks?: number;
      model?: string;
      mode?: AgentMode;
    }
  | { type: "loop_stop"; chatId: string }
  // 个人助理（今日页、记忆页、推送）。memory: true 时一并下发记忆全量
  | { type: "assistant_get"; memory?: boolean }
  | { type: "assistant_op"; op: AssistantOp; args?: Record<string, unknown>; reqId?: string };

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

export type LoopStatus = "idle" | "armed" | "running" | "stopped";

export type LoopTickStatus = "ran" | "skipped" | "stopped" | "error";

export type LoopTick = {
  chatId: string;
  tick: number;
  status: LoopTickStatus;
  summary: string;
};

export type LoopState = {
  chatId: string;
  status: LoopStatus;
  goal: string;
  intervalSec: number;
  tick: number;
  maxTicks?: number;
  lastSummary?: string;
  nextAt?: number;
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
      /** P9：当前租户是否管理员（tenants.json 里 admin: true）——客户端据此显示统计入口 */
      admin?: boolean;
      policy?: PolicyId;
      /** 未停止的产品 Loop。L2 起随 ready 下发；L1 字段先占位 */
      loops?: LoopState[];
      /** USER 根目录的助理名字，来自 AGENTS.md；缺省 DEFAULT_ASSISTANT_NAME */
      assistantName?: string;
      /** 这个租户唯一的助理会话编号；固定在 USER 根目录，不能删除、不能换工作区 */
      assistantChatId?: string;
    }
  | { type: "workspaces"; root: string; items: { path: string; name: string; user?: boolean }[] }
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
  | {
      type: "sync_ack";
      rev?: number;
      chatRevs?: Record<string, number>;
      keptBodies?: boolean;
      reviewOnly?: boolean;
      /** truncate_turns 的回执（不对应任何 sync_chat）；false = 没截成 */
      truncated?: boolean;
    }
  // 分叉时的目录推送（P4c，需 caps: ["stored_digest"]）：客户端比对 chatRevs 后用 load_chats 拉差异会话
  | { type: "stored_digest"; rev?: number; deletedIds?: string[]; chatRevs?: Record<string, number> }
  // load_chats 的应答：单个会话全量（slim_state 客户端也是全量——digest 对账是跨设备 turns 更新唯一通道）
  | { type: "stored_chat"; chat: unknown; rev?: number }
  // load_chat 的应答（P8）：turns[from..] 一页；hasMore=前面还有；单条超预算的 turn 带 clipped 标记；
  // nonce 回显请求的 nonce（客户端分页代际校验，见 load_chat）
  | { type: "chat_turns"; chatId: string; turns: unknown[]; from: number; hasMore: boolean; total: number; nonce?: number }
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
  | {
      type: "run_snapshot";
      chatId: string;
      turnId?: string;
      phase: "running" | "done";
      status?: string;
      userText: string;
      assistant: string;
      thinking?: string;
      tools?: HistoryTurn["tools"];
      task?: string;
      model?: string;
      mode?: AgentMode;
      awaitingApproval?: { callId: string; name: string; args?: unknown };
      queued?: Array<{ turnId?: string; userText: string }>;
      durationMs?: number;
      clipped?: boolean;
    }
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
  // admin_stats 的应答（P9）：全租户使用统计。cursor 是当前 CURSOR_API_KEY 的官方账单
  | { type: "admin_stats"; serverTime: number; tenants: AdminTenantStats[]; cursor?: CursorBill }
  | ({ type: "loop_state" } & LoopState)
  | ({ type: "loop_tick" } & LoopTick)
  | { type: "assistant_state"; state: AssistantState }
  | { type: "assistant_result"; reqId?: string; op: AssistantOp; ok: boolean; error?: string; data?: unknown }
  | { type: "inbox_item"; item: AssistantInboxItem }
  /** 委派开始、待批、继续、完成、失败时下发；approval 只在待批时带 */
  | { type: "delegation_state"; delegation: AssistantDelegation; approval?: AssistantApproval }
  | { type: "memory_written"; chatId?: string; entry: AssistantMemoryEntry }
  | { type: "pong" };

/** 当前 CURSOR_API_KEY 的官方账单，口径与 Cursor CLI `/usage` 相同。
 *  套餐内三项是已用百分比；spendCents / limitCents 是美分。Enterprise 通常没有百分比，
 *  只有本 Key 在当前账期的 spendCents。 */
export type CursorOnDemand = {
  kind: "fixed" | "unlimited" | "disabled" | "unavailable";
  usedCents: number;
  /** kind 为 fixed 时的上限，单位美分 */
  limitCents?: number;
};

export type CursorBill = {
  ok: boolean;
  error?: string;
  plan?: string;
  /** 账期起止，Unix 毫秒 */
  cycleStart?: number;
  cycleEnd?: number;
  /** 套餐内已用百分比（0–100） */
  includedPercent?: number;
  autoPercent?: number;
  apiPercent?: number;
  /** 这把 API Key 在当前账期的花费，单位美分 */
  spendCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  onDemand?: CursorOnDemand;
  models?: { name: string; spendCents: number }[];
  fetchedAt: number;
};

/** P9：单租户使用统计。estTokens 按字符估算（≈4 字符/token，英文偏向；中文 1 字符≈1-2 token，
 *  中文场景实际消耗约为估算值的 2-4 倍）。这是网关自计量的相对消耗，
 *  官方账单在 admin_stats.cursor。 */
export type AdminTenantStats = {
  id: string;
  name: string;
  admin: boolean;
  /** 当前在线连接数 */
  online: number;
  /** 现存会话数（实时读 disk） */
  chats: number;
  /** 累计用户消息数（prompt 条数，含排队） */
  turns: number;
  /** 累计 agent 运行完成次数（按 finishRun 计；confirm-writes 被拦截的首次运行手动收尾、
   *  不经 finishRun，故「拦截+重放」实际计 1 次；titleChat 起标题也不经 finishRun、
   *  单独计 1 次——相对消耗口径，非精确 API 调用数） */
  runs: number;
  /** 累计工具调用完成数 */
  toolCalls: number;
  /** 累计运行时长（毫秒） */
  runMs: number;
  /** 累计用户输入字符数（仅文本；纯图 prompt 计 0，图像 token 不在口径内） */
  inChars: number;
  /** 累计助手输出字符数（text + thinking + 会话标题；不含工具调用参数） */
  outChars: number;
  /** (inChars + outChars) / 4 的估算 token 量 */
  estTokens: number;
  /** 第三方模型（自研 Agent）接口返回的真实 token：输入 / 输出 / 缓存命中 */
  modelInTokens?: number;
  modelOutTokens?: number;
  modelCacheTokens?: number;
  firstSeenAt: number;
  lastActiveAt: number;
};
