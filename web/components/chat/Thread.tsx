// 对话线程：查找条、提示、骨架屏与回合列表（单个回合的渲染在 TurnRow，带 memo）
import type { Dispatch, RefObject, SetStateAction } from "react";
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
  keepTool: (turnId: string, tool: ToolCall) => void;
  rejectTool: (turn: Turn, tool: ToolCall) => void;
  mdComponents: Components;
  lastProgressRef: RefObject<Record<string, number>>;
  activeId: string;
  stopChat: (chatId: string) => void;
  applyPlan: (turn: Turn) => void;
  keepTurnFiles: (turn: Turn) => void;
  restoreTurnFiles: (turn: Turn) => void;
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
  keepTool,
  rejectTool,
  mdComponents,
  lastProgressRef,
  activeId,
  stopChat,
  applyPlan,
  keepTurnFiles,
  restoreTurnFiles,
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
    keepTool,
    rejectTool,
    stopChat,
    applyPlan,
    keepTurnFiles,
    restoreTurnFiles,
    loadTurnBody,
    releaseTurnBody,
  });
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
            hideUser={hideUser}
            isLast={isLast}
            deferred={deferrable && !threadFindOpen}
            findHit={turn.id === findHitId}
            findQuery={findQuery}
            locked={locked}
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
