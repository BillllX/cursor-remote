// 线程内查找条
import type { Dispatch, SetStateAction } from "react";
import type { Turn } from "../../lib/chat/types";

type ThreadFindProps = {
  threadFindQ: string;
  setThreadFindQ: Dispatch<SetStateAction<string>>;
  setThreadFindIndex: Dispatch<SetStateAction<number>>;
  setThreadFindOpen: Dispatch<SetStateAction<boolean>>;
  threadFindHits: Turn[];
  threadFindHi: number;
};

export function ThreadFind({
  threadFindQ,
  setThreadFindQ,
  setThreadFindIndex,
  setThreadFindOpen,
  threadFindHits,
  threadFindHi,
}: ThreadFindProps) {
  return (
    <div className="thread-find">
      <input
        autoFocus
        className="thread-find-input"
        placeholder="在对话里找"
        value={threadFindQ}
        onChange={(event) => {
          setThreadFindQ(event.target.value);
          setThreadFindIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setThreadFindOpen(false);
          }
          if (event.key === "Enter" && threadFindHits.length) {
            event.preventDefault();
            setThreadFindIndex((index) => {
              const next = event.shiftKey
                ? (index - 1 + threadFindHits.length) % threadFindHits.length
                : (index + 1) % threadFindHits.length;
              return next;
            });
          }
        }}
      />
      <span className="thread-find-count">
        {threadFindQ.trim() ? (threadFindHits.length ? `${threadFindHi + 1}/${threadFindHits.length}` : "无") : ""}
      </span>
      <button
        type="button"
        className="pill"
        disabled={!threadFindHits.length}
        onClick={() => setThreadFindIndex((index) => (index - 1 + threadFindHits.length) % threadFindHits.length)}
      >
        ↑
      </button>
      <button
        type="button"
        className="pill"
        disabled={!threadFindHits.length}
        onClick={() => setThreadFindIndex((index) => (index + 1) % threadFindHits.length)}
      >
        ↓
      </button>
      <button type="button" className="pill" onClick={() => setThreadFindOpen(false)}>
        关闭
      </button>
    </div>
  );
}
