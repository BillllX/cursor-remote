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

/** 统一记忆中心：条目种类 */
export type MemoryCenterKind = "personal" | "work_preference" | "workspace_memory" | "rule" | "document";

/** 统一记忆中心：层级（L0 个人 / L1 工作偏好 / L2+ 工作区与仓库） */
export type MemoryCenterLayer = "L0" | "L1" | "L2" | "L3" | "L4";

/** 统一记忆中心：生命周期与展示状态 */
export type MemoryCenterState =
  | "pinned"
  | "hot"
  | "cold"
  | "done"
  | "expired"
  | "待核实";

export type MemoryInjectionReason = "pinned" | "section_anchor" | "relevant" | "rotation";
export type MemoryInjectionSkipReason = "budget" | "cold_unrelated" | "terminal";

export type WorkspaceMemoryItem = {
  id: string | null;
  kind: MemoryCenterKind;
  layer: MemoryCenterLayer;
  scopeId: string;
  section?: string;
  text: string;
  refs: string[];
  missingRefs: string[];
  at?: string | null;
  from?: string | null;
  state?: "hot" | "cold" | "done" | null;
  effectiveState: "hot" | "cold" | "done" | "expired";
  pinned?: boolean;
  used?: string | null;
  uses?: number;
  expires?: string | null;
  truncated?: boolean;
  /** 可编辑内容与元数据的稳定 hash，用于 CAS；不含 mtime。 */
  revision: string;
};

export type RuleFile = {
  relPath: string;
  appliesDir: string;
  chars: number;
  body: string;
  truncated?: boolean;
};

export type InjectionDiagnostics = {
  total: number;
  selected: number;
  skippedBudget: number;
  hotSelected: number;
  coldRecalled: number;
  terminalSkipped: number;
  coldUnrelatedSkipped?: number;
  pinnedSelected: number;
  relevantSelected: number;
  strategy: string;
  selectedIds: Array<{ id: string | null; reason: MemoryInjectionReason }>;
  skippedReasons?: Array<{ id: string | null; reason: MemoryInjectionSkipReason }>;
  selectedIdsTruncated?: boolean;
  skippedReasonsTruncated?: boolean;
  truncated?: boolean;
};

export type MemoryCenterScopeSummary = {
  id: string;
  label: string;
  kind: MemoryCenterKind;
  layer: MemoryCenterLayer;
  parentId?: string | null;
  memoryCount: number;
  hot: number;
  cold: number;
  done: number;
  expired: number;
  pinned: number;
  missingRefs: number;
  ruleFileCount: number;
  tokenBudget: number;
  injectionSelected: number;
  injectionSkipped: number;
  pendingCount: number;
  health?: string | null;
  error?: string | null;
};

export type MemoryCenterPersonalOverview = {
  validEntries: number;
  invalidEntries: number;
  coreFieldLines: number;
  workPreferenceLines: number;
  paused: boolean;
  coreBudget: number;
  coreTokens: number;
  workPreferenceBudget: number;
};

export type MemoryCenterOverview = {
  personal: MemoryCenterPersonalOverview;
  scopes: MemoryCenterScopeSummary[];
  scopesTruncated?: boolean;
};

export type MemoryCenterScopeDetail = {
  scope: MemoryCenterScopeSummary;
  items: WorkspaceMemoryItem[];
  rules: RuleFile[];
  diagnostics: InjectionDiagnostics | null;
  itemsTruncated?: boolean;
  rulesTruncated?: boolean;
  rulesPayloadTruncated?: boolean;
};

export type MemoryCenterGetData =
  | { mode: "overview"; overview: MemoryCenterOverview; payloadTruncated?: boolean }
  | { mode: "detail"; detail: MemoryCenterScopeDetail; payloadTruncated?: boolean };

export type MemoryCenterSearchMatchReason =
  | "text"
  | "section"
  | "ref"
  | "scope"
  | "state"
  | "pinned"
  | "related";

export type MemoryCenterSearchHit = {
  scopeId: string;
  kind: MemoryCenterKind;
  layer: MemoryCenterLayer;
  id: string | null;
  section?: string;
  text: string;
  refs: string[];
  missingRefs: string[];
  state?: "hot" | "cold" | "done" | null;
  effectiveState: "hot" | "cold" | "done" | "expired";
  pinned?: boolean;
  reasons: MemoryCenterSearchMatchReason[];
  score: number;
};

export type MemoryCenterSearchData = {
  hits: MemoryCenterSearchHit[];
  truncated?: boolean;
  payloadTruncated?: boolean;
};

export type MemoryCenterMutateErrorCode =
  | "invalid_scope"
  | "not_found"
  | "conflict"
  | "invalid_input"
  | "unsafe_ref"
  | "sensitive"
  | "write_failed";

export type MemoryCenterMutatePatch = {
  section?: string;
  text?: string;
  refs?: string[];
  pinned?: boolean;
  state?: "hot" | "cold" | "done" | null;
  expires?: string | null;
};

export type MemoryCenterMutateMutation =
  | {
      action: "create";
      section: string;
      text: string;
      refs?: string[];
      pinned?: boolean;
      state?: "hot" | "cold" | "done";
      expires?: string;
    }
  | { action: "update"; id: string; revision: string; patch: MemoryCenterMutatePatch }
  | { action: "set_state"; id: string; revision: string; state: "hot" | "cold" | "done" }
  | { action: "set_pinned"; id: string; revision: string; pinned: boolean }
  | { action: "delete"; id: string; revision: string };

export type MemoryCenterMutateArgs = {
  scope: string;
  mutation: MemoryCenterMutateMutation;
};

export type MemoryCenterMutateData = {
  scope: string;
  action: string;
  item?: WorkspaceMemoryItem;
  deletedId?: string;
  detail: MemoryCenterScopeDetail;
};

export type MemoryCenterMutateFailureData = {
  code: MemoryCenterMutateErrorCode;
  detail?: MemoryCenterScopeDetail;
};

export type MemoryCenterActivityAction =
  | "create"
  | "update"
  | "set_state"
  | "set_pinned"
  | "delete"
  | "restore"
  | "import";

export type MemoryCenterAuditLineFields = {
  id: string | null;
  section: string;
  text: string;
  refs: string[];
  from?: string | null;
  at?: string | null;
  pinned?: boolean;
  state?: "hot" | "cold" | "done" | null;
  used?: string | null;
  uses?: number | null;
  expires?: string | null;
  meta?: Record<string, string>;
  metaOrder?: string[];
};

export type MemoryCenterAuditSnapshot = {
  line: MemoryCenterAuditLineFields;
  rawLine: string;
  rowHint?: number;
  revision: string;
};

export type MemoryCenterActivitySnapshotSummary = {
  id: string | null;
  section: string;
  text: string;
  revision: string;
  state?: "hot" | "cold" | "done" | null;
  pinned?: boolean;
};

export type MemoryCenterActivityEntry = {
  auditId: string;
  scope: string;
  itemId: string;
  action: MemoryCenterActivityAction;
  actor: "user" | "maintenance";
  at: string;
  before?: MemoryCenterActivitySnapshotSummary;
  after?: MemoryCenterActivitySnapshotSummary;
  canRestore: boolean;
  restoreBlockedReason?: string;
  degraded?: boolean;
};

export type MemoryCenterActivityData = {
  entries: MemoryCenterActivityEntry[];
  nextCursor?: string;
  truncated?: boolean;
  degraded?: boolean;
};

export type MemoryCenterRestoreData = {
  scope: string;
  auditId: string;
  item?: WorkspaceMemoryItem;
  deletedId?: string;
  detail: MemoryCenterScopeDetail;
};

export type MemoryCenterRestoreErrorCode =
  | "invalid_scope"
  | "not_found"
  | "conflict"
  | "corrupt_audit"
  | "write_failed";

export type MemoryCenterRestoreFailureData = {
  code: MemoryCenterRestoreErrorCode;
  detail?: MemoryCenterScopeDetail;
};

export type MemoryCenterSuggestionKind =
  | "missing_ref"
  | "stale_hot"
  | "duplicate"
  | "budget_pressure"
  | "stale_ongoing";

export type MemoryCenterSuggestionRisk = "low" | "medium";

export type MemoryCenterSuggestionProposedAction = {
  kind: "dismiss" | "mark_handled" | "set_state" | "mark_done";
  state?: "hot" | "cold" | "done";
  targetId?: string;
  keepId?: string;
};

export type MemoryCenterSuggestionEntry = {
  id: string;
  scope: string;
  kind: MemoryCenterSuggestionKind;
  summary: string;
  reason: string;
  risk: MemoryCenterSuggestionRisk;
  itemIds: string[];
  revisions: string[];
  proposedAction: MemoryCenterSuggestionProposedAction;
};

export type MemoryCenterSuggestionsData = {
  generatedAt: string;
  lastRunAt?: string;
  entries: MemoryCenterSuggestionEntry[];
  truncated?: boolean;
};

export type MemoryCenterSuggestionAnswerData = {
  id: string;
  status: "accepted" | "dismissed" | "stale";
  detail?: string;
};

export type MemoryCenterSuggestionAnswerErrorCode =
  | "invalid_scope"
  | "not_found"
  | "stale"
  | "conflict"
  | "write_failed";

/** assistant_op 参数与结果 typed 映射（记忆中心与其它 op 可逐步补齐） */
export type AssistantOpArgsMap = {
  memory_center_get: { scope?: string };
  memory_center_search: {
    query: string;
    scope?: string;
    kind?: MemoryCenterKind;
    state?: MemoryCenterState;
  };
  memory_center_mutate: MemoryCenterMutateArgs;
  memory_center_activity: {
    scope?: string;
    cursor?: string;
    limit?: number;
    action?: MemoryCenterActivityAction;
  };
  memory_center_restore: { scope: string; auditId: string };
  memory_center_suggestions_get: { scope?: string };
  memory_center_suggestion_answer: { scope: string; id: string; accept: boolean };
  memory_center_export: { scopes?: string[] };
  memory_center_import_preview: { path: string };
  memory_center_import_apply: {
    planId: string;
    resolutions: Array<{ changeId: string; resolution: "keep_current" | "use_snapshot" | "duplicate" }>;
  };
  memory_center_import_rollback: { importId: string };
};

export type AssistantOpResultMap = {
  memory_center_get: MemoryCenterGetData;
  memory_center_search: MemoryCenterSearchData;
  memory_center_mutate: MemoryCenterMutateData;
  memory_center_activity: MemoryCenterActivityData;
  memory_center_restore: MemoryCenterRestoreData;
  memory_center_suggestions_get: MemoryCenterSuggestionsData;
  memory_center_suggestion_answer: MemoryCenterSuggestionAnswerData;
  memory_center_export: import("./memoryCenterImportTypes.ts").MemoryCenterExportData;
  memory_center_import_preview: import("./memoryCenterImportTypes.ts").MemoryCenterImportPreviewData;
  memory_center_import_apply: import("./memoryCenterImportTypes.ts").MemoryCenterImportApplyData;
  memory_center_import_rollback: import("./memoryCenterImportTypes.ts").MemoryCenterImportRollbackData;
};

type AssistantResultBranchForOp<K extends AssistantOp> = K extends "memory_center_mutate"
  ? { op: K } & (
      | { ok: true; data: MemoryCenterMutateData }
      | { ok: false; error: string; data: MemoryCenterMutateFailureData }
    )
  : K extends "memory_center_restore"
    ? { op: K } & (
        | { ok: true; data: MemoryCenterRestoreData }
        | { ok: false; error: string; data: MemoryCenterRestoreFailureData }
      )
    : K extends "memory_center_suggestion_answer"
      ? { op: K } & (
          | { ok: true; data: MemoryCenterSuggestionAnswerData }
          | { ok: false; error: string; data: { code: MemoryCenterSuggestionAnswerErrorCode; detail?: string } }
        )
      : K extends
          | "memory_center_export"
          | "memory_center_import_preview"
          | "memory_center_import_apply"
          | "memory_center_import_rollback"
        ? { op: K } & (
            | { ok: true; data: AssistantOpResult<K> }
            | { ok: false; error: string; data?: { code?: string } }
          )
        : { op: K; ok: boolean; error?: string; data?: AssistantOpResult<K> };

export type AssistantOpArgs<O extends AssistantOp> = O extends keyof AssistantOpArgsMap
  ? AssistantOpArgsMap[O]
  : Record<string, unknown>;

export type AssistantOpResult<O extends AssistantOp> = O extends keyof AssistantOpResultMap
  ? AssistantOpResultMap[O]
  : unknown;

export type AssistantDelegation = {
  id: string;
  parentChatId?: string;
  parentTurnId?: string;
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
  /** 网关配置了 APNs（.p8）且能发；iPhone 设置页据此显示「通知已就绪」。iPhone 不读 pushKey */
  pushApns?: boolean;
  inbox: AssistantInboxItem[];
  /** source：user 手动加 / chat 对话里助理记下 / nightly 夜里从聊天补记；quote 是记下时的原话 */
  todos: Array<{
    id: string;
    text: string;
    due?: string;
    done: boolean;
    doneAt?: number;
    createdAt: number;
    chatId?: string;
    source?: "user" | "chat" | "nightly";
    quote?: string;
  }>;
  /** 苹果日历订阅：地址 = 网关 HTTP 基址 + /media/cal/<token>.ics；lastFetchAt 是日历最近一次来拉的时间 */
  calendar?: { token: string; enabled: boolean; lastFetchAt?: number };
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
  /** args: { id, text?, due? }；due 传空串表示去掉日期 */
  | "todo_update"
  /** args: { enabled?, rotate? }；rotate=true 重新生成订阅口令，旧地址立即失效 */
  | "calendar_set"
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
  /** args: { scope?: string }；无 scope 为总览+作用域树，有 scope 为该层详情（只读） */
  | "memory_center_get"
  /** args: { query, scope?, kind?, state? }；跨个人/W0/工作区只读搜索，不续期 used */
  | "memory_center_search"
  /** args: { scope, mutation }；工作区 .jiebo/memory.md 结构化编辑（revision CAS） */
  | "memory_center_mutate"
  /** args: { scope?, cursor?, limit? }；工作区记忆变更审计时间线 */
  | "memory_center_activity"
  /** args: { scope, auditId }；按审计回滚最近一次可回滚变更 */
  | "memory_center_restore"
  /** args: { scope? }；工作区记忆整理建议（只读扫描结果） */
  | "memory_center_suggestions_get"
  /** args: { scope, id, accept }；接受或忽略一条建议 */
  | "memory_center_suggestion_answer"
  | "memory_center_export"
  | "memory_center_import_preview"
  | "memory_center_import_apply"
  | "memory_center_import_rollback"
  | "push_subscribe"
  | "push_unsubscribe"
  | "push_test"
  /** args: { chatId, callId, allow }；作答委派子会话的挂起审批 */
  | "approval_answer"
  /** args: { delegationId }；停掉一项在跑或等批准的前台委派 */
  | "delegation_cancel";

export type AssistantOpTyped = keyof AssistantOpArgsMap;

export type MemoryCenterRestoreResultBranch = Extract<
  ServerMessage,
  { type: "assistant_result"; op: "memory_center_restore" }
>;
export type MemoryCenterSuggestionAnswerResultBranch = Extract<
  ServerMessage,
  { type: "assistant_result"; op: "memory_center_suggestion_answer" }
>;
export type AssistantOpLegacy = Exclude<AssistantOp, AssistantOpTyped>;

/** 网关不依赖 args 字段即可执行的 op；ClientMessage 可省略 args。 */
export type AssistantOpNoArgs = "memory_export" | "push_test";

type AssistantOpClientBranch<K extends AssistantOp> = K extends
  | "memory_center_search"
  | "memory_center_mutate"
  | "memory_center_restore"
  | "memory_center_suggestion_answer"
  | "memory_center_import_preview"
  | "memory_center_import_apply"
  | "memory_center_import_rollback"
  ? { op: K; args: AssistantOpArgsMap[K] }
  : K extends "memory_center_get" | "memory_center_activity" | "memory_center_suggestions_get" | "memory_center_export"
    ? { op: K; args?: AssistantOpArgsMap[K] }
    : K extends AssistantOpNoArgs
      ? { op: K; args?: undefined }
      : K extends AssistantOpLegacy
        ? { op: K; args?: Record<string, unknown> }
        : never;

/** 按 op 收窄 args 的 assistant_op 判别联合（ClientMessage 成员）。 */
export type AssistantOpClientMessage = {
  [K in AssistantOp]: { type: "assistant_op"; reqId?: string } & AssistantOpClientBranch<K>;
}[AssistantOp];

/** 按 op 收窄 data 的 assistant_result 判别联合（ServerMessage 成员）。 */
export type AssistantResultMessage = {
  type: "assistant_result";
  reqId?: string;
} & {
  [K in AssistantOp]: AssistantResultBranchForOp<K>;
}[AssistantOp];

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
//   "slim_chats"    —— stored_chat 也只给元数据（同 slim_state 的行），内容走 load_chat 分页
//   "deferred_turn" —— 超大单回合先收轻量占位，再用 GET /state/turn 按需取完整正文
//   "im"            —— 收发平台用户之间的即时消息（im_*，见 docs/im.md）；连接默认在前台，im_presence 切换
// slim 行对有内容的会话带 segHashes：第 i 个是 turns[i*100, (i+1)*100) 的 sha1(JSON.stringify(分段))，
// 客户端据此只重拉变了的分段
export type HelloClient = { name: string; version: string; maxMessageBytes?: number; caps?: string[] };

// ── 平台用户之间的即时消息（IM，见 docs/im.md）。只有 hello caps 含 "im" 的连接才处理 / 收到 im_* ──

/** 会话号。单聊 = `dm~<较小租户 id>~<较大租户 id>`（按字符串排序；租户 id 不含 "~"） */
export type ImConvId = string;
export type ImKind = "text" | "image" | "voice" | "file" | "link" | "location";
export type ImTextBody = { text: string };
/** blob / thumb 是 POST /upload/im 返回的 blob（sha256 hex）；original=发的是原图 */
export type ImImageBody = { blob: string; thumb: string; w: number; h: number; original: boolean };
/** durationMs ≤ 60000；waveform 最多 100 个 0..1 */
export type ImVoiceBody = { blob: string; durationMs: number; waveform: number[] };
/** size 以网关记录的 blob 大小为准 */
export type ImFileBody = { blob: string; name: string; size: number; mime: string };
/** url 只能 http/https；icon 是 blob */
export type ImLinkBody = { url: string; title?: string; desc?: string; icon?: string };
/** WGS-84 */
export type ImLocationBody = { lat: number; lng: number; name: string; address: string };
export type ImBody = ImTextBody | ImImageBody | ImVoiceBody | ImFileBody | ImLinkBody | ImLocationBody;

export type ImMessage = {
  convId: ImConvId;
  /** 会话内从 1 递增 */
  seq: number;
  /** 发件人租户 id */
  from: string;
  /** 网关落盘时间（毫秒） */
  at: number;
  kind: ImKind;
  /** 撤回后没有 body */
  body?: ImBody;
  /** 回复的同会话 seq */
  replyTo?: number;
  recalled?: true;
  /** 只出现在发件人自己的视图里：被对方拉黑拒收 */
  rejected?: true;
  clientId: string;
};

/** 下载票据，签名绑定（租户, scope, exp）；scope 是会话号或 "avatars"，2 小时有效 */
export type ImTicket = { exp: number; sig: string };
export type WorkspaceAgentRow = {
  path: string;
  directoryName: string;
  displayName: string;
  avatarBlob?: string;
  mainChatId?: string;
  status: "idle" | "running" | "queued" | "awaiting";
  unread: number;
  /** 服务端单调注意序号：每轮审批或完成首次出现时 +1；同轮审批后完成不重复。read 只允许向前推进 */
  readSeq: number;
  finishedSeq: number;
  lastActivityAt: number;
};
export type ImUser = { id: string; nickname: string; avatar?: string };
export type ImMe = ImUser & { notifyPreview: boolean };
export type ImConvRow = {
  convId: ImConvId;
  peer: string;
  /** 自己可见的最后一条；缺省 = 没有可见消息（比如清空过），客户端可不显示这一行 */
  last?: ImMessage;
  /** 最多 1000（封顶），客户端等于 1000 时显示「999+」 */
  unread: number;
  readSeq: number;
  /** 自己可见的最大 seq */
  maxSeq: number;
  pin: boolean;
  mute: boolean;
  /** seq ≤ hideBefore 的消息对自己不再返回 */
  hideBefore: number;
  ticket: ImTicket;
};
export type ImErrorCode =
  | "no_cap"
  | "not_visible"
  | "rate_limited"
  | "too_large"
  | "bad_body"
  | "not_found"
  | "recall_expired"
  | "forbidden"
  | "internal";

export type ClientMessage =
  | { type: "hello"; token?: string; client?: HelloClient }
  | { type: "set_workspace"; cwd: string; chatId?: string; create?: boolean }
  | { type: "list_workspaces" }
  | { type: "create_workspace"; name: string }
  /** 只改根目录下的一级工作区；会话、断点里的路径一并改过去 */
  | { type: "rename_workspace"; path: string; name: string }
  /** 空目录真删，有文件只隐藏，还有对话就拒绝 */
  | { type: "delete_workspace"; path: string }
  | { type: "workspace_agent_list"; cursor?: string }
  | { type: "workspace_agent_open"; path: string }
  /** displayName/avatar 缺字段表示不改，null/空串表示恢复默认 */
  | { type: "workspace_agent_profile"; path: string; displayName?: string | null; avatar?: string | null }
  | { type: "workspace_agent_read"; chatId: string; seq: number }
  | { type: "workspace_agent_viewing"; chatId: string | null }
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
      /** 发送时客户端的时间（毫秒）和系统时区（IANA），助理换算“明天”“下周三”用 */
      clientTime?: { now: number; tz: string };
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
  // sha：读这一轮结束时的快照（TurnFile.sha），不读工作区；diff: true 时 sha 指 TurnFile.diffSha。
  // 快照被清理时回 error "历史版本已清理"。reqId 在 file_content 原样回显
  | { type: "read_file"; path: string; chatId?: string; diff?: boolean; sha?: string; reqId?: string }
  | { type: "write_file"; path: string; content: string; chatId?: string }
  /** 保存 Canvas 的源码快照及客户端渲染出的静态 HTML；sourceSha 缺省时由网关读取当前源码并存快照 */
  | { type: "canvas_version_save"; chatId: string; path: string; sourceSha?: string; html: string }
  | { type: "canvas_versions"; chatId: string; path: string }
  /** sha 是 canvas_versions 返回的源码 sha；发布它对应的静态 HTML */
  | { type: "canvas_publish"; chatId: string; path: string; sha: string }
  /** 把指定源码 sha 原子写回当前工作区文件 */
  | { type: "canvas_restore"; chatId: string; path: string; sha: string }
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
  | AssistantOpClientMessage
  // IM（需 caps 含 "im"，否则回 im_error code=no_cap）
  | { type: "im_contacts" }
  /**
   * 会话列表分页：置顶在前，再按最后一条可见消息时间倒序。limit 默认 50，最大 100；
   * cursor 原样回传上一页回包里的 cursor，取排在它后面的会话
   */
  | { type: "im_list"; cursor?: string; limit?: number }
  /** 默认最新一页；before：取 seq < before 的上一页；after：取 seq > after 的下一页。limit 默认 30，最大 50 */
  | { type: "im_history"; convId: ImConvId; before?: number; after?: number; limit?: number }
  /** to（对方租户 id）和 convId 二选一；同一 clientId 重发只回原 ack */
  | {
      type: "im_send";
      clientId: string;
      to?: string;
      convId?: ImConvId;
      kind: ImKind;
      body: ImBody;
      replyTo?: number;
    }
  | { type: "im_recall"; convId: ImConvId; seq: number }
  | { type: "im_read"; convId: ImConvId; seq: number }
  /** hideBefore 只增不减（清空聊天记录） */
  | { type: "im_settings"; convId: ImConvId; pin?: boolean; mute?: boolean; hideBefore?: number }
  /** avatar 传空串或 null 去掉头像 */
  | { type: "im_profile"; nickname?: string; avatar?: string | null; notifyPreview?: boolean }
  | { type: "im_block"; tenantId: string; on: boolean }
  /** App 进出前台；没有回包 */
  | { type: "im_presence"; foreground: boolean };

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

/** 一轮结束时 Agent 新增或改过的文件。快照存在网关 artifacts 目录，按 sha 取 */
export type TurnFile = {
  /** 工作区相对路径 */
  path: string;
  kind: PreviewKind;
  op: "added" | "modified";
  /** 这一轮结束时的字节数 */
  size?: number;
  /** 结束时内容的 sha256（64 位小写 hex）。超过 8MB 或读不到时缺省 → 客户端打开当前版本 */
  sha?: string;
  /** 这一轮改动对照文本（unified diff）的 sha256；只对文本类 kind（text/canvas/markdown/html/svg）有 */
  diffSha?: string;
  /** 增加行数 */
  added?: number;
  /** 删除行数 */
  removed?: number;
  /** 委派交付物合并到父回合时，保留来源子会话和子回合 */
  sourceChatId?: string;
  sourceTurnId?: string;
};

export type CanvasVersion = {
  /** Canvas 源码 artifact sha */
  sha: string;
  /** 对应的静态 HTML artifact sha；旧版本可能尚未保存 */
  htmlSha?: string;
  createdAt: number;
  /** 当前公开的是这一版时才有 */
  shareUrl?: string;
};

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
  /** 仅用于传输的非权威副本；上传时网关按 id 保留服务端完整正文 */
  clipped?: boolean;
  /** 正文未随本消息发送，客户端应按需从 /state/turn 拉取 */
  deferred?: boolean;
  /** 完整 turn 的 JSON UTF-8 字节数 */
  bodyBytes?: number;
  /** 回合开始时间（毫秒 epoch） */
  startedAt?: number;
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
    /** 首次开始时 assistant 已有的长度（UTF-16 码元），工具卡片插在正文这个位置 */
    at?: number;
  }>;
  /** 这一轮结束且写过文件时才有这个键 */
  files?: TurnFile[];
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
      /**
       * 网关能力集。已知值："turn_files"、"read_sha"（read_file 带 sha）、"read_req_id"（file_content 回显 reqId）、
       * "seg_hashes"（slim 行带 segHashes）、"tool_at"（工具带 at）、"slim_chats"（认 slim_chats cap）、
       * "im"（支持 im_* 即时消息）、"file_changed"、"canvas_versions"
       */
      features?: string[];
    }
  | { type: "workspaces"; root: string; items: { path: string; name: string; user?: boolean }[] }
  | { type: "workspace_created"; path: string; name: string }
  | { type: "workspace_renamed"; from: string; path: string; name: string }
  | { type: "workspace_removed"; path: string; name: string; mode: "deleted" | "hidden" }
  | {
      type: "workspace_agents";
      workspaces: WorkspaceAgentRow[];
      avatarTicket: ImTicket;
      /** 首次请求和广播页为 true：客户端先清空旧列表；后续 cursor 页为 false。 */
      reset: boolean;
      more: boolean;
      /** 本页请求所带 cursor；客户端用来丢弃迟到的旧分页。 */
      after?: string;
      /** more=true 时继续请求 workspace_agent_list(cursor)。 */
      cursor?: string;
    }
  | { type: "workspace_agent_opened"; path: string; chatId: string }
  | { type: "workspace_agent_update"; chatId: string; unread: number; readSeq: number; finishedSeq: number }
  /**
   * 三个字段网关总会带上，“没有”用空串表示而不是省略：chatId 为空串 = 还没有会话时切了工作区（只看 cwd）；
   * agentId 为空串 = 这个会话当前没有 agent（客户端清掉本地旧值）
   */
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
      /** 网关按本轮转录补上，含义同 HistoryTurn tools[].at */
      at?: number;
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
  | { type: "search_hits"; query: string; hits: SearchHit[]; chatId?: string; truncated?: boolean }
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
      /** 原样回显 read_file 的 reqId / sha；请求没带就没有这个键 */
      reqId?: string;
      sha?: string;
      /** 超过连接声明的单条上限：有 url 时去掉了 content（客户端走 HTTP），否则 content 被截短 */
      truncated?: boolean;
    }
  // 一轮结束时的文件清单，广播给同租户连接；同一份也写进 turn.files 落盘
  | { type: "turn_files"; chatId: string; turnId: string; files: TurnFile[] }
  /** 工作区文件内容已经变化；path 相对该 chat 的 cwd，同租户连接均会收到 */
  | { type: "file_changed"; chatId: string; path: string }
  | { type: "canvas_versions"; chatId: string; path: string; versions: CanvasVersion[] }
  | {
      type: "canvas_published";
      chatId: string;
      path: string;
      sha: string;
      url?: string;
      error?: string;
    }
  | { type: "canvas_restored"; chatId: string; path: string; sha: string; error?: string }
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
  // 分叉时的目录推送（P4c，需 caps: ["stored_digest"]）：客户端比对 chatRevs 后用 load_chats 拉差异会话。
  // reason: "rejected" = 本连接的 sync_state / sync_chat 被拒（在途推送要重推）；
  // "changed" = 别处写入后的广播（在途推送仍有效）。旧网关不带，按 rejected 处理
  | {
      type: "stored_digest";
      rev?: number;
      deletedIds?: string[];
      chatRevs?: Record<string, number>;
      reason?: "rejected" | "changed";
    }
  // load_chats 的应答：单个会话全量（slim_state 客户端也是全量——digest 对账是跨设备 turns 更新唯一通道）；
  // 带 slim_chats cap 时只给元数据 + segHashes
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
  | AssistantResultMessage
  | { type: "inbox_item"; item: AssistantInboxItem }
  /** 委派开始、待批、继续、完成、失败时下发；approval 只在待批时带 */
  | { type: "delegation_state"; delegation: AssistantDelegation; approval?: AssistantApproval }
  | { type: "memory_written"; chatId?: string; entry: AssistantMemoryEntry }
  | { type: "pong" }
  // IM 下行（只发给 caps 含 "im" 的连接）
  | { type: "im_contacts"; me: ImMe; users: ImUser[]; avatarTicket: ImTicket }
  /**
   * more=true 时还有下一页，带上 cursor 再请求一次。超过单条上限时网关从末尾丢行并置 more / cursor。
   * 翻页期间被新消息顶到前面的会话不会在后面的页里重复出现，靠 im_message 更新
   */
  | { type: "im_list"; convs: ImConvRow[]; blocked: string[]; more: boolean; cursor?: string }
  /**
   * messages 按 seq 升序。more：请求带 after 时表示后面还有，否则表示前面还有。
   * before / after 原样回显请求。超过单条上限时网关从翻页方向的远端丢消息并置 more=true
   */
  | {
      type: "im_history";
      convId: ImConvId;
      messages: ImMessage[];
      more: boolean;
      ticket: ImTicket;
      before?: number;
      after?: number;
    }
  /** 只发给发件连接；rejected=被对方拒收（消息已发出，只有自己看得到） */
  | { type: "im_ack"; clientId: string; convId: ImConvId; seq: number; at: number; rejected?: boolean }
  /**
   * 发给会话双方 caps 含 im 的在线连接，发件连接本身除外（它收 im_ack）；客户端仍可按 clientId 去重。
   * unread：收件这一方在这个会话的未读（发件人自己的其他设备收到的是发件人的未读），客户端直接用，不自己累加
   */
  | { type: "im_message"; message: ImMessage; ticket: ImTicket; unread?: number }
  /**
   * what 决定带哪些字段（unread 都是收到这条的那个人在这个会话的权威未读）：
   *   recall   → convId, seq, unread（双方，各自的未读）
   *   read     → convId, seq, unread（自己的其他连接）
   *   settings → convId, pin, mute, hideBefore, unread（自己所有连接）
   *   prefs    → me（自己所有连接）
   *   profile  → user, avatarTicket（所有可见用户）
   *   block    → blocked（自己所有连接）
   */
  | {
      type: "im_update";
      what: "recall" | "read" | "settings" | "prefs" | "profile" | "block";
      convId?: ImConvId;
      seq?: number;
      pin?: boolean;
      mute?: boolean;
      hideBefore?: number;
      me?: ImMe;
      user?: ImUser;
      avatarTicket?: ImTicket;
      blocked?: string[];
      unread?: number;
    }
  | { type: "im_error"; clientId?: string; code: ImErrorCode; message: string };

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
