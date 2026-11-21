// 对话线程：查找条、提示、骨架屏与回合列表（单个回合的渲染在 TurnRow，带 memo）
import type { DelegationAction } from "./DelegationReceipt";
import { useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AssistantDelegation } from "@shared/protocol";
import type { Components } from "react-markdown";
import { friendlyError } from "../../lib/chat/format";
import { PERF, perfCountThread } from "../../lib/chat/perf";
import { useStableActions } from "../../lib/chat/stableActions";
import { planTurnRows } from "../../lib/chat/threadRows";
import type { Chat, ToolCall, Turn } from "../../lib/chat/types";
import { ThreadFind } from "./ThreadFind";
import { TurnRow } from "./TurnRow";

type ThreadProps = {
  threadRef: RefObject<HTMLDivElement | null>;
  onThreadScroll: () => void;
  threadFindOpen: boolean;
  error: string;
  notice: string;
  bodyPending: boolean;
  active: Chat;
  delegations?: AssistantDelegation[];
  openDelegation?: (id: string) => void;
  onDelegationAction?: DelegationAction;
  submitDelegationFollowUp?: (prompt: string) => void;
  loadingOlder: boolean;
  threadFindHits: Turn[];
  threadFindHi: number;
  openFile: (path: string, line?: number, asDiff?: boolean, sha?: string, sourceChatId?: string) => void;
  threadFindQ: string;
  editTurn: (turn: Turn) => void;
  connected: boolean;
  busy: boolean;
  retryTurn: (turn: Turn) => void;
  submit: (raw?: string) => void;
  submitQuestionAnswer: (raw: string) => void;
  keepTool: (turnId: string, tool: ToolCall) => void;
  rejectTool: (turn: Turn, tool: ToolCall) => void;
  mdComponents: Components;
  lastProgressRef: RefObject<Record<string, number>>;
  activeId: string;
  stopChat: (chatId: string) => void;
  keepTurnFiles: (turn: Turn) => void;
  restoreTurnFiles: (turn: Turn) => void;
  restoringTurnIds: Readonly<Record<string, boolean>>;
  turnBodyLoads: Readonly<Record<string, "loading" | "error">>;
  loadTurnBody: (chatId: string, turnId: string) => void;
  releaseTurnBody: (chatId: string, turnId: string) => void;
  setThreadFindQ: Dispatch<SetStateAction<string>>;
  setThreadFindIndex: Dispatch<SetStateAction<number>>;
  setThreadFindOpen: Dispatch<SetStateAction<boolean>>;
};

export function Thread({
  threadRef,
  onThreadScroll,
  threadFindOpen,
  error,
  notice,
  bodyPending,
  active,
  delegations,
  openDelegation,
  submitDelegationFollowUp,
  onDelegationAction,
  loadingOlder,
  threadFindHits,
  threadFindHi,
  openFile,
  threadFindQ,
  editTurn,
  connected,
  busy,
  retryTurn,
  submit,
  submitQuestionAnswer,
  keepTool,
  rejectTool,
  mdComponents,
  lastProgressRef,
  activeId,
  stopChat,
  keepTurnFiles,
  restoreTurnFiles,
  restoringTurnIds,
  turnBodyLoads,
  loadTurnBody,
  releaseTurnBody,
  setThreadFindQ,
  setThreadFindIndex,
  setThreadFindOpen,
}: ThreadProps) {
  if (PERF) perfCountThread();
  // 回调每次渲染都是新函数（ChatApp 里多是普通函数声明）；换成引用不变、调用时转给最新实现的包装，TurnRow 的 memo 才有效
  const actions = useStableActions({
    openFile,
    editTurn,
    retryTurn,
    submit,
    submitQuestionAnswer,
    keepTool,
    rejectTool,
    stopChat,
    keepTurnFiles,
    restoreTurnFiles,
    loadTurnBody,
    releaseTurnBody,
    openDelegation: (id: string) => openDelegation?.(id),
    onDelegationAction: (...args: Parameters<DelegationAction>) => onDelegationAction?.(...args) ?? Promise.resolve("该入口暂不可用。"),
    submitDelegationFollowUp: (prompt: string) => submitDelegationFollowUp?.(prompt),
  });
  const delegationRows = useMemo(() => {
    const index = new Map<string, AssistantDelegation[]>();
    for (const item of delegations ?? []) {
      if (item.parentChatId !== activeId || !item.parentTurnId) continue;
      const rows = index.get(item.parentTurnId) ?? [];
      rows.push(item);
      index.set(item.parentTurnId, rows);
    }
    return index;
  }, [delegations, activeId]);
  // 每行依赖的派生值（前一有效回合、是否末轮）一次扫描算好，行组件只收原始值
  const rows = planTurnRows(active.turns);
  const findHitId = threadFindHits[threadFindHi]?.id;
  const findQuery = threadFindOpen ? threadFindQ : undefined;
  const locked = !connected || busy;
  return (
    <div className="thread" ref={threadRef} onScroll={onThreadScroll}>
      {threadFindOpen ? (
        <ThreadFind
          threadFindQ={threadFindQ}
          setThreadFindQ={setThreadFindQ}
          setThreadFindIndex={setThreadFindIndex}
          setThreadFindOpen={setThreadFindOpen}
          threadFindHits={threadFindHits}
          threadFindHi={threadFindHi}
        />
      ) : null}
      <div className="thread-inner">
        {error ? <div className="warn">{friendlyError(error)}</div> : null}
        {notice ? <div className="warn">{notice}</div> : null}
        {bodyPending && !active.turns.length ? (
          <div className="skeleton" role="status" aria-live="polite">
            <span className="sr-only">正在加载对话…</span>
            <div className="skel-line skel-user" style={{ width: "42%" }} />
            <div className="skel-block">
              {["94%", "86%", "58%"].map((width) => (
                <div key={width} className="skel-line" style={{ width }} />
              ))}
            </div>
            <div className="skel-line skel-user" style={{ width: "30%" }} />
            <div className="skel-block">
              {["90%", "72%"].map((width) => (
                <div key={width} className="skel-line" style={{ width }} />
              ))}
            </div>
          </div>
        ) : loadingOlder ? (
          <div className="thread-loading">正在加载更早的内容…</div>
        ) : null}
        {rows.map(({ turn, hideUser, isLast, deferrable }) => (
          <TurnRow
            key={turn.id}
            turn={turn}
            delegations={delegationRows.get(turn.id)}
            hideUser={hideUser}
            isLast={isLast}
            deferred={deferrable && !threadFindOpen}
            findHit={turn.id === findHitId}
            findQuery={findQuery}
            locked={locked}
            restoring={Boolean(restoringTurnIds[turn.id])}
            oversizedState={
              turnBodyLoads[`${activeId}:${turn.id}`] || (turn.oversized && !turn.deferred ? "loaded" : "idle")
            }
            activeId={activeId}
            mdComponents={mdComponents}
            lastProgressRef={lastProgressRef}
            actions={actions}
          />
        ))}
        <div className="thread-spacer" aria-hidden="true" />
      </div>
    </div>
  );
}
