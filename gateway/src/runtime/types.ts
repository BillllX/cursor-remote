// 网关运行期共享类型：会话槽位、连接、检查点、工作区文件清单等
import type { Agent } from "@cursor/sdk";
import type { WebSocket } from "ws";
import type { ReviewBinding } from "../../../shared/crew.ts";
import type { AgentMode, PolicyId, PreviewKind } from "../../../shared/protocol.ts";
import type { ClientClock } from "../assistant/service.ts";
import type { ChatHistoryItem } from "../providers.ts";
import type { RunTranscript } from "../runlog.ts";
import type { Tenant } from "../tenants.ts";

export type AgentHandle = Awaited<ReturnType<typeof Agent.create>>;

export type RunHandle = Awaited<ReturnType<AgentHandle["send"]>>;

export type Checkpoint = {
  id: string;
  label: string;
  commit: string;
  createdAt: number;
  gitDir?: string;
  workTree?: string;
  /** 打点时目录里没有文件。还原时没有可 restore 的路径，只删之后新建的文件 */
  empty?: boolean;
};

type PendingPrompt = {
  text: string;
  model?: string;
  mode: AgentMode;
  files?: string[];
  images?: Array<{ data: string; mimeType: string }>;
  confirmWrites: boolean;
  autoApprove: boolean;
  policy: PolicyId;
  dialect: boolean;
  /** P11：第三方模型的会话历史（客户端权威，随 prompt 上行） */
  history?: ChatHistoryItem[];
  /** 客户端回合 id。排队重放时带回，避免和另一轮缓冲混在一起 */
  turnId?: string;
};

type RunStats = {
  toolStarts: number;
  intercepts: number;
  approvals: number;
  replays: number;
};

type OpenTool = {
  name: string;
  args?: unknown;
  parentCallId?: string;
  agent?: string;
  model?: string;
};

export type Slot = {
  tenantId: string;
  chatId: string;
  cwd: string;
  model?: string;
  /** 该会话最近一次 prompt 的模式；Loop 没指定 mode 时沿用 */
  mode?: AgentMode;
  agentId: string | null;
  agent: AgentHandle | null;
  run: RunHandle | null;
  epoch: number;
  finished: boolean;
  edited: string[];
  checkpoints: Checkpoint[];
  awaitingApproval: boolean;
  lastShellCallId: string | null;
  owner: WebSocket | null;
  approvalWait: ((allow: boolean) => void) | null;
  approvalSettled: boolean | null;
  pending: PendingPrompt[];
  openTools: Map<string, OpenTool>;
  reseed: boolean;
  /** P11：第三方模型在途请求的取消柄（Cursor run 走 slot.run，这条路径没有 RunHandle） */
  externalAbort: AbortController | null;
  /** L2：Loop 本拍收集助手文本 / 错误 / 收尾状态，仅调度期间设置 */
  captureText?: (text: string) => void;
  captureError?: (text: string) => void;
  captureDone?: (status: string) => void;
  /** 委派来的子会话：审批要进收件箱并推送，等待时长按 approvalTimeoutMs */
  delegationId?: string;
  approvalTimeoutMs?: number;
  policy: PolicyId;
  approvedKeys: Set<string>;
  approvalCallId: string | null;
  runStats: RunStats;
  dialect: boolean;
  /** 已登记、且彼此模型不同的评审子代理。undefined 表示还没跟目录对齐过。 */
  reviewRoster?: ReviewBinding[];
  /** 这一轮还没被客户端确认的正文。断线后靠它补快照 */
  transcript?: RunTranscript;
  runFlush?: ReturnType<typeof setTimeout>;
  /** 给 owner 以外的同租户连接节流推送累计快照 */
  mirrorTimer?: ReturnType<typeof setTimeout>;
  /**
   * 本轮文件清单的基线，跟 transcript.turnId 走：审批后重放/继续同一轮沿用，不重建。
   * checkpoint 是本轮检查点；没建检查点时 tree 是只用于清单的树；两者都没有表示这一轮建过但没建成
   */
  turnBase?: { turnId: string; cwd: string; checkpoint?: Checkpoint; tree?: string };
};

export type Conn = {
  cwd: string;
  model: string;
  authed: boolean;
  ip: string;
  tenant: Tenant | null;
  slots: Map<string, Slot>;
  ws: WebSocket;
  /** hello.client.maxMessageBytes：单条 WS 消息接收上限（0 = 不限，iOS 约 1MiB） */
  maxMessageBytes: number;
  /** hello.client.caps：客户端能力集（"sync_chat" / "stored_digest"） */
  caps: Set<string>;
  /** caps 含 "im" 时 hello 置 true；im_presence 切换。前台连接在线时聊天不发 APNs */
  imForeground?: boolean;
  /** 当前正在看的工作区 Agent 主会话；离开、后台或断线时为空 */
  workspaceViewingChatId?: string;
  policy: PolicyId;
  /** 最近一条 prompt 带来的客户端时钟（时区 + 与网关的时差），助理会话每轮据此写“现在几点” */
  clock?: ClientClock;
};

export type WorkspaceFile = {
  path: string;
  content?: string;
  error?: string;
  kind?: PreviewKind;
  mime?: string;
  size?: number;
  hasHead?: boolean;
};

export type WorkspaceFiles = { paths: string[]; status: Record<string, string>; truncated: boolean };
