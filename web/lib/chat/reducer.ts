import type { AssistantState, LoopState, ServerMessage } from "@shared/protocol";
import { isUntitled, stopOrphanRuns } from "./sessions";
import { mergeToolOutput } from "./tools";
import {
  applyRunSnapshot,
  extractTodos,
  historyToTurns,
  mergeHistoryTurns,
  rejectMutatingTools,
  settleTurn,
  turnHasOpenTools,
  writesWereRejected,
} from "./turns";
import type { Chat, Turn } from "./types";
import { inWorkspaceRoot, preferChatCwd } from "./workspace";

type Msg<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
export type LoopRow = LoopState & { tickStatus?: string };

export type ChatReduceContext = {
  /** 收到消息当下的 activeIdRef.current；必须由调用方在 setState 之前读好，updater 可能推迟到渲染时才跑 */
  activeId: string;
  /** 当前服务端会话版本；超大正文只有同版本才可压过迟到的截断快照。 */
  chatRevs?: Readonly<Record<string, number>>;
};

/** 没带 chatId 的消息算到当前会话上 */
export function serverChatId(message: ServerMessage, activeId: string): string {
  return "chatId" in message && message.chatId ? message.chatId : activeId;
}

/** 元素逐个相同就沿用旧数组，setState 拿到同一引用就不重渲染 */
function keepIfSame<T>(prev: T[], next: T[]): T[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return next;
  return prev;
}

export function patchChatIn(chats: Chat[], chatId: string, updater: (chat: Chat) => Chat): Chat[] {
  return keepIfSame(
    chats,
    chats.map((chat) => (chat.id === chatId ? updater(chat) : chat)),
  );
}

function lastTurnIndex(chat: Chat, pick: (turn: Turn) => boolean) {
  for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
    if (pick(chat.turns[i])) return i;
  }
  return -1;
}

/** 只改最后一个 running 的回合；没有或 updater 原样返回时沿用原 chat */
export function patchRunningTurnIn(chats: Chat[], chatId: string, updater: (turn: Turn) => Turn): Chat[] {
  return patchChatIn(chats, chatId, (chat) => {
    const index = lastTurnIndex(chat, (turn) => Boolean(turn.running));
    if (index < 0) return chat;
    const turn = updater(chat.turns[index]);
    if (turn === chat.turns[index]) return chat;
    const turns = chat.turns.slice();
    turns[index] = turn;
    return { ...chat, turns };
  });
}

/** 只改最后一个 running 或还有未结束工具的回合；没有或 updater 原样返回时沿用原 chat */
export function patchOpenTurnIn(chats: Chat[], chatId: string, updater: (turn: Turn) => Turn): Chat[] {
  return patchChatIn(chats, chatId, (chat) => {
    const index = lastTurnIndex(chat, (turn) => Boolean(turn.running) || turnHasOpenTools(turn));
    if (index < 0) return chat;
    const turn = updater(chat.turns[index]);
    if (turn === chat.turns[index]) return chat;
    const turns = chat.turns.slice();
    turns[index] = turn;
    return { ...chat, turns };
  });
}

function setChatPolicy(chats: Chat[], chatId: string, policy: Chat["policy"]): Chat[] {
  return patchChatIn(chats, chatId, (chat) => (chat.policy === policy ? chat : { ...chat, policy }));
}

export function markUnread(chats: Chat[], chatId: string): Chat[] {
  return patchChatIn(chats, chatId, (chat) => (chat.unread ? chat : { ...chat, unread: true }));
}

/**
 * 同步提交：基于 ref 算出新值并立即写回 ref，再把值（不是 updater）交给 set；没变化时不调用 set。
 * React 在已有待渲染更新时会把 updater 推迟到渲染才执行，紧接着读 ref 的代码就会读到旧值；
 * 所有写入都要走这里，混用 updater 和直接赋值会让后者覆盖还没执行的前者。
 */
export function commitSync<T>(ref: { current: T }, set: (value: T) => void, reduce: (prev: T) => T): T {
  const prev = ref.current;
  const next = reduce(prev);
  if (next === prev) return prev;
  ref.current = next;
  set(next);
  return next;
}

/** 重连后要自动续发本地排队回合的会话：有排队、没在跑，且不在网关的排队名单里（那些由网关发）；要用 applyReadyRuns 之后的列表算 */
export function chatsToFlush(chats: Chat[], serverQueued: readonly string[] = []): string[] {
  const queued = new Set(serverQueued);
  return chats
    .filter(
      (chat) =>
        !queued.has(chat.id) && chat.turns.some((turn) => turn.queued) && !chat.turns.some((turn) => turn.running),
    )
    .map((chat) => chat.id);
}

/** ready：网关上没在跑/排队的回合收尾；具体运行/排队回合由随后带 turnId 的快照定位。 */
export function applyReadyRuns(chats: Chat[], message: Msg<"ready">): Chat[] {
  const keep = [...(message.runningChatIds || []), ...(message.queuedChatIds || [])];
  return keepIfSame(chats, stopOrphanRuns(chats, keep));
}

/**
 * chatCwd：带 chatId 时由调用方按收到消息当下的 chatsRef 算好（和同时 setCwd 用的是同一个值），
 * 不能在这里按 updater 里的 chat 重算
 */
export function applySession(chats: Chat[], message: Msg<"session">, activeId: string, chatCwd?: string): Chat[] {
  if (message.chatId) {
    return patchChatIn(chats, message.chatId, (item) => ({
      ...item,
      cwd: chatCwd || item.cwd,
      agentId: message.agentId || undefined,
    }));
  }
  if (message.cwd) {
    return patchChatIn(chats, activeId, (item) => {
      const cwd = preferChatCwd(item.cwd, message.cwd);
      return cwd === item.cwd ? item : { ...item, cwd };
    });
  }
  return chats;
}

/** 上传完成时用户已切走：把 @路径 补进那个会话的草稿 */
export function appendDraftMention(chats: Chat[], chatId: string, path: string): Chat[] {
  const token = `@${path} `;
  return patchChatIn(chats, chatId, (chat) => {
    const draft = chat.draft || "";
    if (draft.includes(`@${path}`)) return chat;
    return {
      ...chat,
      draft: `${draft}${draft && !draft.endsWith(" ") ? " " : ""}${token}`,
    };
  });
}

export function workspaceMover(message: Msg<"workspace_renamed">) {
  return (path?: string) =>
    path && inWorkspaceRoot(path, message.from) ? message.path + path.slice(message.from.length) : path;
}

/**
 * 网关消息对会话列表的纯变换。只覆盖 onServer 里直接改 chats 的分支；
 * holdSnapshot 之类的跳过判断、以及 send / ref / 预览等副作用都留在调用方。
 */
export function applyServerMessage(chats: Chat[], message: ServerMessage, ctx: ChatReduceContext): Chat[] {
  const chatId = serverChatId(message, ctx.activeId);
  switch (message.type) {
    case "tool-output":
      return patchRunningTurnIn(chats, chatId, (turn) => {
        const tools = [...turn.tools];
        const index = tools.findIndex((tool) => tool.callId === message.callId);
        if (index < 0) {
          tools.push({
            callId: message.callId,
            name: "shell",
            status: "running",
            result: mergeToolOutput(undefined, message),
          });
        } else {
          tools[index] = {
            ...tools[index],
            result: mergeToolOutput(tools[index].result, message),
          };
        }
        return { ...turn, tools };
      });
    case "chat_title": {
      const title = message.title.trim();
      if (!message.chatId || !title) return chats;
      return patchChatIn(chats, message.chatId, (chat) => (isUntitled(chat.title) ? { ...chat, title } : chat));
    }
    case "history":
      return patchChatIn(chats, chatId, (chat) => {
        const incoming = historyToTurns(Array.isArray(message.turns) ? message.turns : []);
        if (!incoming.length) return chat;
        const turns = mergeHistoryTurns(chat.turns, incoming);
        return turns === chat.turns ? chat : { ...chat, turns };
      });
    case "status": {
      let next = chats;
      // RUNNING/CREATING 不带 turnId，不能据此改变具体回合；本机乐观状态与 run_snapshot 会精确定位。
      if (
        message.status === "FINISHED" ||
        message.status === "ERROR" ||
        message.status === "CANCELLED" ||
        message.status === "EXPIRED"
      ) {
        const settled =
          message.status === "ERROR" || message.status === "EXPIRED"
            ? "error"
            : message.status === "CANCELLED"
              ? "cancelled"
              : "finished";
        next = patchOpenTurnIn(next, chatId, (turn) => settleTurn(turn, settled));
      }
      if (/已拒绝写入/.test(message.message || "")) {
        next = patchChatIn(next, chatId, (chat) => {
          const last = [...chat.turns].reverse().find((turn) => turn.running || turn.pendingTool || turn.tools.length);
          if (!last) return chat;
          return {
            ...chat,
            turns: chat.turns.map((turn) => (turn.id === last.id ? rejectMutatingTools(turn) : turn)),
          };
        });
      }
      return next;
    }
    case "run_snapshot":
      return patchChatIn(chats, message.chatId, (chat) => {
        const turns = applyRunSnapshot(chat.turns, message, ctx.chatRevs?.[message.chatId]);
        return turns === chat.turns ? chat : { ...chat, turns };
      });
    case "text-delta":
      return patchRunningTurnIn(chats, chatId, (turn) => ({
        ...turn,
        assistant: turn.assistant + message.text,
      }));
    case "thinking-delta":
      return patchRunningTurnIn(chats, chatId, (turn) => ({
        ...turn,
        thinking: turn.thinking + message.text,
      }));
    case "tool-started": {
      let next = patchRunningTurnIn(chats, chatId, (turn) => {
        const tools = turn.tools.filter((tool) => tool.callId !== message.callId);
        tools.push({
          callId: message.callId,
          name: message.name,
          args: message.args,
          status: "running",
          parentCallId: message.parentCallId,
          agent: message.agent,
          model: message.model,
        });
        return { ...turn, tools };
      });
      const todos = extractTodos(message.name, message.args);
      if (todos) {
        next = patchRunningTurnIn(next, chatId, (turn) => ({ ...turn, todos }));
      }
      return next;
    }
    case "tool-completed":
      return patchOpenTurnIn(chats, chatId, (turn) => {
        const existing = turn.tools.find((tool) => tool.callId === message.callId);
        if (existing?.status === "error" && message.status === "completed") {
          return turn;
        }
        const tools = turn.tools.filter((tool) => tool.callId !== message.callId);
        tools.push({
          callId: message.callId,
          name: message.name,
          args: existing?.args,
          result: message.result,
          status: message.status,
          review: existing?.review,
          parentCallId: existing?.parentCallId || message.parentCallId,
          agent: existing?.agent || message.agent,
          model: existing?.model || message.model,
        });
        const todos = extractTodos(message.name, existing?.args) || extractTodos(message.name, message.result);
        return { ...turn, tools, todos: todos || turn.todos };
      });
    case "task":
      return patchRunningTurnIn(chats, chatId, (turn) => ({ ...turn, task: message.text }));
    case "approval":
      return patchRunningTurnIn(chats, chatId, (turn) => ({
        ...turn,
        pendingTool: { callId: message.callId, name: message.name, args: message.args },
      }));
    case "error":
      return patchOpenTurnIn(chats, chatId, (turn) =>
        settleTurn(
          {
            ...turn,
            error: message.message,
          },
          "error",
        ),
      );
    case "done":
      return patchOpenTurnIn(chats, chatId, (turn) => {
        const next = settleTurn(turn, message.status, message.durationMs);
        return writesWereRejected(next) || writesWereRejected(turn) ? rejectMutatingTools(next) : next;
      });
    case "run_meta": {
      const next = patchRunningTurnIn(chats, chatId, (turn) => ({
        ...turn,
        model: message.model || turn.model,
        mode: message.mode || turn.mode,
      }));
      return message.policy ? setChatPolicy(next, chatId, message.policy) : next;
    }
    case "policy":
      if (!message.policy) return chats;
      return setChatPolicy(chats, message.chatId || ctx.activeId, message.policy);
    case "checkpoints":
      return patchChatIn(chats, message.chatId, (chat) => ({ ...chat, checkpoints: message.items }));
    case "workspace_renamed": {
      const move = workspaceMover(message);
      return keepIfSame(
        chats,
        chats.map((chat) => (chat.cwd && move(chat.cwd) !== chat.cwd ? { ...chat, cwd: move(chat.cwd) } : chat)),
      );
    }
    default:
      return chats;
  }
}

/** ready 自带的循环列表：停掉的、空闲的不显示 */
export function loopsFromReady(rows: Msg<"ready">["loops"]): Record<string, LoopState> {
  const next: Record<string, LoopState> = {};
  for (const row of rows || []) {
    if (!row?.chatId || row.status === "stopped" || row.status === "idle") continue;
    next[row.chatId] = row;
  }
  return next;
}

export function applyLoopMessage(loops: Record<string, LoopRow>, message: ServerMessage): Record<string, LoopRow> {
  switch (message.type) {
    case "loop_state": {
      if (!message.chatId) return loops;
      const prevRow = loops[message.chatId];
      return {
        ...loops,
        [message.chatId]: {
          chatId: message.chatId,
          status: message.status,
          goal: message.goal,
          intervalSec: message.intervalSec,
          tick: message.tick,
          maxTicks: message.maxTicks,
          lastSummary: message.lastSummary,
          nextAt: message.nextAt,
          tickStatus: prevRow?.tickStatus,
        },
      };
    }
    case "loop_tick": {
      const row = loops[message.chatId];
      if (!row) return loops;
      return {
        ...loops,
        [message.chatId]: {
          ...row,
          tick: message.tick,
          lastSummary: message.summary,
          tickStatus: message.status,
          status: message.status === "stopped" ? "stopped" : row.status,
        },
      };
    }
    default:
      return loops;
  }
}

export function applyAssistantMessage(state: AssistantState | null, message: ServerMessage): AssistantState | null {
  switch (message.type) {
    case "inbox_item": {
      if (!state) return state;
      const inbox = [message.item, ...state.inbox.filter((row) => row.id !== message.item.id)];
      return { ...state, inbox };
    }
    case "delegation_state": {
      if (!state) return state;
      const { delegation, approval } = message;
      const delegations = [delegation, ...state.delegations.filter((row) => row.id !== delegation.id)];
      const others = state.approvals.filter((row) => row.delegationId !== delegation.id);
      const approvals = delegation.status === "awaiting" && approval ? [...others, approval] : others;
      return { ...state, delegations, approvals };
    }
    default:
      return state;
  }
}
