// 对话线程：查找条、提示、骨架屏与回合列表
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Components } from "react-markdown";
import { formatDuration, friendlyError, isProgressBlurb, runMeta } from "../../lib/chat/format";
import { searchQuery } from "../../lib/chat/tools";
import { editPathsOf, turnSuperseded, writesWereRejected } from "../../lib/chat/turns";
import type { Chat, ToolCall, Turn } from "../../lib/chat/types";
import { modelLabel } from "../../lib/models";
import { JieboGlyph } from "../JieboMark";
import ToolCard, { mutatingTool, parseAskQuestions, QuestionCard, toolKind, toolPath } from "../ToolCard";
import { CiteText, Highlight, MemoMarkdown, REMARK_PLUGINS } from "./markdown";
import { StallHint } from "./StallHint";
import { ThreadFind } from "./ThreadFind";

type ThreadProps = {
  threadRef: RefObject<HTMLDivElement | null>;
  onThreadScroll: () => void;
  threadFindOpen: boolean;
  hasApiKey: boolean;
  error: string;
  notice: string;
  bodyPending: boolean;
  active: Chat;
  loadingOlder: boolean;
  threadFindHits: Turn[];
  threadFindHi: number;
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
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
  setThreadFindQ: Dispatch<SetStateAction<string>>;
  setThreadFindIndex: Dispatch<SetStateAction<number>>;
  setThreadFindOpen: Dispatch<SetStateAction<boolean>>;
};

export function Thread({
  threadRef,
  onThreadScroll,
  threadFindOpen,
  hasApiKey,
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
  setThreadFindQ,
  setThreadFindIndex,
  setThreadFindOpen,
}: ThreadProps) {
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
        {!hasApiKey || error ? <div className="warn">{friendlyError(error)}</div> : null}
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
        {active.turns.map((turn, turnIndex) => {
          if (turnSuperseded(active.turns, turnIndex)) return null;
          let prevIndex = turnIndex - 1;
          while (prevIndex >= 0 && turnSuperseded(active.turns, prevIndex)) {
            prevIndex -= 1;
          }
          const prevTurn = prevIndex >= 0 ? active.turns[prevIndex] : undefined;
          const hideUser = Boolean(prevTurn && prevTurn.user.trim() && prevTurn.user.trim() === turn.user.trim());
          return (
            <article
              className={`turn${hideUser ? " turn-continue" : ""}${threadFindHits[threadFindHi]?.id === turn.id ? " find-hit" : ""}`}
              data-turn={turn.id}
              key={turn.id}
            >
              {hideUser ? null : (
                <div className="turn-user">
                  <div className="user-kicker">你</div>
                  <div className="user-bubble">
                    {turn.images?.length ? (
                      <div className="user-thumbs">
                        {turn.images.map((img, index) => (
                          <img key={`${turn.id}-${index}`} src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                        ))}
                      </div>
                    ) : null}
                    <CiteText text={turn.user} onOpen={openFile} query={threadFindOpen ? threadFindQ : undefined} />
                    {turn.model || turn.mode ? (
                      <div className="user-meta">
                        {turn.mode ? turn.mode : ""}
                        {turn.mode && turn.model ? " · " : ""}
                        {turn.model ? modelLabel(turn.model) : ""}
                      </div>
                    ) : null}
                  </div>
                  {!turn.running && !turn.queued ? (
                    <div className="turn-actions">
                      <button type="button" className="pill" onClick={() => editTurn(turn)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className="pill"
                        disabled={!connected || busy}
                        onClick={() => retryTurn(turn)}
                      >
                        重试
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
              <div className="assistant-row">
                <span className="bot-avatar" aria-hidden="true">
                  <JieboGlyph size={16} />
                </span>
                <div className="assistant">
                  {turn.thinking && (turn.running || formatDuration(turn.durationMs)) ? (
                    <details key={turn.running ? "live" : "done"} className="thinking" open={turn.running || undefined}>
                      <summary>
                        <span className={turn.running ? "text-shimmer" : undefined}>
                          {turn.running
                            ? "正在思考"
                            : formatDuration(turn.durationMs)
                              ? `思考了 ${formatDuration(turn.durationMs)}`
                              : "思考过程"}
                        </span>
                      </summary>
                      <pre>
                        <Highlight text={turn.thinking} query={threadFindOpen ? threadFindQ : undefined} />
                      </pre>
                    </details>
                  ) : null}
                  {turn.queued ? <div className="task-line">排队中</div> : null}
                  {turn.todos?.length ? (
                    <ul className="todo-list">
                      {turn.todos.map((item) => (
                        <li key={item.id} className={`todo-item ${item.status.replace(/\s+/g, "-")}`}>
                          <span className="todo-mark">
                            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "…" : "○"}
                          </span>
                          <Highlight text={item.content} query={threadFindOpen ? threadFindQ : undefined} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {(() => {
                    const visible = turn.tools.filter((tool) => !/todo/i.test(tool.name));
                    const ids = new Set(visible.map((tool) => tool.callId));
                    const kids = new Map<string, typeof visible>();
                    const roots: typeof visible = [];
                    for (const tool of visible) {
                      if (tool.parentCallId && ids.has(tool.parentCallId)) {
                        const list = kids.get(tool.parentCallId) || [];
                        list.push(tool);
                        kids.set(tool.parentCallId, list);
                      } else {
                        roots.push(tool);
                      }
                    }
                    const groups: (typeof visible)[] = [];
                    for (const tool of roots) {
                      const prev = groups[groups.length - 1];
                      const prevKind = prev ? toolKind(prev[0].name, prev[0].args) : "";
                      const kind = toolKind(tool.name, tool.args);
                      const prevFile = prev ? toolPath(prev[0]) : "";
                      const file = toolPath(tool);
                      if (prev && prevKind === "search" && kind === "search") {
                        prev.push(tool);
                      } else if (
                        prev &&
                        file &&
                        file === prevFile &&
                        (kind === "edit" || kind === "write" || kind === "read") &&
                        kind === prevKind
                      ) {
                        prev.push(tool);
                      } else {
                        groups.push([tool]);
                      }
                    }
                    const card = (tool: (typeof visible)[number]) => {
                      const asked = parseAskQuestions(tool.name, tool.args);
                      if (asked) {
                        const last = turnIndex === active.turns.length - 1;
                        return (
                          <QuestionCard
                            key={tool.callId}
                            asked={asked}
                            canAnswer={last && !turn.running && !turn.queued}
                            onAnswer={(text) => submit(text)}
                          />
                        );
                      }
                      const nested = kids.get(tool.callId);
                      const nestedLive = Boolean(turn.running && nested?.some((item) => item.status === "running"));
                      return (
                        <ToolCard
                          key={tool.callId}
                          tool={tool}
                          settled={!turn.running}
                          nestedLive={nestedLive}
                          nested={nested?.length ? nested.map(card) : undefined}
                          onOpen={openFile}
                          onAccept={
                            !turn.running && mutatingTool(tool.name) && !tool.review
                              ? () => keepTool(turn.id, tool)
                              : undefined
                          }
                          onReject={
                            !turn.running && mutatingTool(tool.name) && !tool.review
                              ? () => rejectTool(turn, tool)
                              : undefined
                          }
                        />
                      );
                    };
                    return groups.map((group) => {
                      const packKind = toolKind(group[0].name, group[0].args);
                      if (group.length > 1 && packKind === "search") {
                        const live = Boolean(turn.running && group.some((tool) => tool.status === "running"));
                        return (
                          <details
                            className={`tool-pack${live ? " running" : ""}`}
                            open={live}
                            key={group.map((tool) => tool.callId).join("-")}
                          >
                            <summary>
                              <span className={`tool-dot ${live ? "running" : "completed"}`}>
                                <svg
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.4"
                                  aria-hidden="true"
                                >
                                  <path d="M11.5 11.5 15 15M7 12a5 5 0 1 1 0-10 5 5 0 1 0 0 10Z" />
                                </svg>
                              </span>
                              <span className="tool-kind">Searched</span>
                              <span className="tool-title">{searchQuery(group[0]) || "·"}</span>
                              <span className={`tool-badge${live ? " run" : ""}`}>
                                {live ? <span className="text-shimmer">Processing</span> : "Completed"}
                              </span>
                            </summary>
                            {group.map(card)}
                          </details>
                        );
                      }
                      if (group.length > 1 && (packKind === "edit" || packKind === "write" || packKind === "read")) {
                        const live = Boolean(turn.running && group.some((tool) => tool.status === "running"));
                        const packLabel = packKind === "edit" ? "Edited" : packKind === "write" ? "Wrote" : "Read";
                        const file = toolPath(group[0]);
                        const short = file.split("/").pop() || file;
                        return (
                          <details
                            className={`tool-pack${live ? " running" : ""}`}
                            open={live}
                            key={group.map((tool) => tool.callId).join("-")}
                          >
                            <summary>
                              <span className={`tool-dot ${live ? "running" : "completed"}`}>
                                <svg
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.4"
                                  aria-hidden="true"
                                >
                                  <path d="M3 13.5 12.5 4l2 2L5 15.5H3Z" />
                                </svg>
                              </span>
                              <span className="tool-kind">{packLabel}</span>
                              <span className="tool-title">
                                {short} · {group.length} 次
                              </span>
                              <span className={`tool-badge${live ? " run" : ""}`}>
                                {live ? <span className="text-shimmer">Processing</span> : "Completed"}
                              </span>
                            </summary>
                            {group.map(card)}
                          </details>
                        );
                      }
                      return card(group[0]);
                    });
                  })()}
                  {turn.assistant && !(isProgressBlurb(turn.assistant) && !turn.running) ? (
                    <div className={`markdown${turn.running ? " streaming" : ""}`}>
                      <MemoMarkdown remarkPlugins={REMARK_PLUGINS} components={mdComponents}>
                        {turn.assistant}
                      </MemoMarkdown>
                    </div>
                  ) : turn.running ? (
                    <div className="task-line">{turn.task || "开始动手"}</div>
                  ) : null}
                  {turn.running && !turn.pendingTool ? (
                    <StallHint
                      lastProgress={() => lastProgressRef.current[activeId]}
                      onStop={() => stopChat(activeId)}
                    />
                  ) : null}
                  {turn.error ? <div className="error-line">{friendlyError(turn.error)}</div> : null}
                  {!turn.running && !turn.queued && !turn.error && /approval/i.test(turn.status || "") ? (
                    <div className="run-meta">{runMeta(turn.status, turn.durationMs)}</div>
                  ) : null}
                  {turn.mode === "plan" && turn.assistant && !turn.running && !turn.queued ? (
                    <button
                      type="button"
                      className="apply-plan"
                      disabled={!connected || busy}
                      onClick={() => applyPlan(turn)}
                    >
                      执行这个计划
                    </button>
                  ) : null}
                  {(() => {
                    const paths = editPathsOf(turn);
                    const pending = turn.tools.some((tool) => mutatingTool(tool.name) && !tool.review);
                    if (!paths.length || turn.running || turn.queued || !pending || writesWereRejected(turn))
                      return null;
                    return (
                      <div className="turn-review">
                        <span>{paths.length} 个文件改动</span>
                        <button type="button" className="pill" onClick={() => keepTurnFiles(turn)}>
                          全部保留
                        </button>
                        <button type="button" className="pill" onClick={() => restoreTurnFiles(turn)}>
                          全部还原
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </article>
          );
        })}
        <div className="thread-spacer" aria-hidden="true" />
      </div>
    </div>
  );
}
