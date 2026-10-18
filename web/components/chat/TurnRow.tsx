// 线程里的单个回合（用户气泡 + 助手回复 + 工具卡）。
// 用 React.memo 包住：流式输出时只有正在跑的那个回合的 turn 引用会变，旧回合 props 全相同就不再重渲染。
// props 约定（改动时必须守住，否则 memo 白包）：
//   - 全部是原始值、稳定引用的对象（mdComponents、lastProgressRef、actions），不放每次渲染新建的对象 / 数组 / 内联函数；
//   - 回调统一放进 actions（由 Thread 用 useStableActions 生成，引用不变、调用时转给最新实现），所以不用自定义 comparator，
//     也就不会有过期闭包的问题。
import { memo, type CSSProperties, type RefObject } from "react";
import type { Components } from "react-markdown";
import { formatDuration, friendlyError, isProgressBlurb, runMeta } from "../../lib/chat/format";
import { PERF, perfCountRow } from "../../lib/chat/perf";
import { silentAssistantTool } from "../../lib/chat/toolKinds";
import { searchQuery } from "../../lib/chat/tools";
import { estimateTurnHeight } from "../../lib/chat/threadRows";
import { editPathsOf, writesWereRejected } from "../../lib/chat/turns";
import type { ToolCall, Turn } from "../../lib/chat/types";
import { modelLabel } from "../../lib/models";
import { JieboGlyph } from "../JieboMark";
import ToolCard, { mutatingTool, parseAskQuestions, QuestionCard, toolKind, toolPath } from "../ToolCard";
import { CiteText, Highlight, MemoMarkdown, REMARK_PLUGINS } from "./markdown";
import { StallHint } from "./StallHint";

/** 行里要用的全部回调；Thread 保证这个对象和里面的函数引用终身不变 */
export type TurnRowActions = {
  openFile: (path: string, line?: number, asDiff?: boolean, sha?: string, sourceChatId?: string) => void;
  editTurn: (turn: Turn) => void;
  retryTurn: (turn: Turn) => void;
  submit: (raw?: string) => void;
  keepTool: (turnId: string, tool: ToolCall) => void;
  rejectTool: (turn: Turn, tool: ToolCall) => void;
  stopChat: (chatId: string) => void;
  applyPlan: (turn: Turn) => void;
  keepTurnFiles: (turn: Turn) => void;
  restoreTurnFiles: (turn: Turn) => void;
};

export type TurnRowProps = {
  turn: Turn;
  /** 和前一个有效回合的用户消息相同，不重复画用户气泡 */
  hideUser: boolean;
  /** 整个列表的最后一个回合（只有它的提问卡片能作答） */
  isLast: boolean;
  /** 已结算的旧回合：让浏览器跳过屏外渲染（content-visibility:auto） */
  deferred: boolean;
  /** 是线程内查找当前命中的那一条 */
  findHit: boolean;
  /** 查找栏打开时的关键词，否则 undefined */
  findQuery: string | undefined;
  /** 未连上或有回合在跑：重试、执行计划按钮禁用 */
  locked: boolean;
  activeId: string;
  mdComponents: Components;
  lastProgressRef: RefObject<Record<string, number>>;
  actions: TurnRowActions;
};

type ToolGroup = ToolCall[];

/** 工具分组：搜索连续合并；同一文件的读 / 写 / 改连续合并；带父调用的挂到父卡片下面 */
function groupTools(turn: Turn) {
  const visible = turn.tools.filter((tool) => !/todo/i.test(tool.name) && !silentAssistantTool(tool.name));
  const ids = new Set(visible.map((tool) => tool.callId));
  const kids = new Map<string, ToolCall[]>();
  const roots: ToolCall[] = [];
  for (const tool of visible) {
    if (tool.parentCallId && ids.has(tool.parentCallId)) {
      const list = kids.get(tool.parentCallId) || [];
      list.push(tool);
      kids.set(tool.parentCallId, list);
    } else {
      roots.push(tool);
    }
  }
  const groups: ToolGroup[] = [];
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
  return { groups, kids };
}

function renderTools(turn: Turn, isLast: boolean, actions: TurnRowActions) {
  const { groups, kids } = groupTools(turn);
  const card = (tool: ToolCall) => {
    const asked = parseAskQuestions(tool.name, tool.args);
    if (asked) {
      return (
        <QuestionCard
          key={tool.callId}
          asked={asked}
          canAnswer={isLast && !turn.running && !turn.queued}
          onAnswer={(text) => actions.submit(text)}
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
        onOpen={actions.openFile}
        onAccept={
          !turn.running && mutatingTool(tool.name) && !tool.review ? () => actions.keepTool(turn.id, tool) : undefined
        }
        onReject={
          !turn.running && mutatingTool(tool.name) && !tool.review ? () => actions.rejectTool(turn, tool) : undefined
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
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
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
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
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
}

function TurnRowView({
  turn,
  hideUser,
  isLast,
  deferred,
  findHit,
  findQuery,
  locked,
  activeId,
  mdComponents,
  lastProgressRef,
  actions,
}: TurnRowProps) {
  // 仅测量开关打开时计数（?perf=1），默认这里什么都不做
  if (PERF) perfCountRow(turn.id);
  // 旧回合的占位高度：跳过渲染时用它撑住滚动条，渲染过一次后 `auto` 会改用浏览器记下的真实高度
  const style: CSSProperties | undefined = deferred
    ? { containIntrinsicSize: `auto ${estimateTurnHeight(turn, hideUser)}px` }
    : undefined;
  const paths = editPathsOf(turn);
  const pendingReview = turn.tools.some((tool) => mutatingTool(tool.name) && !tool.review);
  return (
    <article
      className={`turn${hideUser ? " turn-continue" : ""}${findHit ? " find-hit" : ""}${deferred ? " turn-cv" : ""}`}
      style={style}
      data-turn={turn.id}
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
            <CiteText text={turn.user} onOpen={actions.openFile} query={findQuery} />
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
              <button type="button" className="pill" onClick={() => actions.editTurn(turn)}>
                编辑
              </button>
              <button type="button" className="pill" disabled={locked} onClick={() => actions.retryTurn(turn)}>
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
                <Highlight text={turn.thinking} query={findQuery} />
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
                  <Highlight text={item.content} query={findQuery} />
                </li>
              ))}
            </ul>
          ) : null}
          {renderTools(turn, isLast, actions)}
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
              onStop={() => actions.stopChat(activeId)}
            />
          ) : null}
          {turn.error ? <div className="error-line">{friendlyError(turn.error)}</div> : null}
          {!turn.running && !turn.queued && !turn.error && /approval/i.test(turn.status || "") ? (
            <div className="run-meta">{runMeta(turn.status, turn.durationMs)}</div>
          ) : null}
          {turn.mode === "plan" && turn.assistant && !turn.running && !turn.queued ? (
            <button type="button" className="apply-plan" disabled={locked} onClick={() => actions.applyPlan(turn)}>
              执行这个计划
            </button>
          ) : null}
          {turn.files?.length && !turn.running && !turn.queued ? (
            <div className="turn-files">
              <div className="turn-files-title">本回合文件 · {turn.files.length}</div>
              {turn.files.map((file) => (
                <div
                  className="turn-file"
                  key={`${file.sourceChatId || ""}:${file.sourceTurnId || ""}:${file.path}:${file.sha || ""}`}
                >
                  <button
                    type="button"
                    onClick={() => actions.openFile(file.path, undefined, false, file.sha, file.sourceChatId)}
                  >
                    <span>{file.path.split("/").pop()}</span>
                    <small>
                      {file.op === "added" ? "新增" : "修改"}
                      {file.added != null ? ` +${file.added}` : ""}
                      {file.removed != null ? ` −${file.removed}` : ""}
                    </small>
                  </button>
                  {file.diffSha ? (
                    <button
                      type="button"
                      className="pill"
                      onClick={() => actions.openFile(file.path, undefined, true, file.diffSha, file.sourceChatId)}
                    >
                      Diff
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {paths.length && !turn.running && !turn.queued && pendingReview && !writesWereRejected(turn) ? (
            <div className="turn-review">
              <span>{paths.length} 个文件改动</span>
              <button type="button" className="pill" onClick={() => actions.keepTurnFiles(turn)}>
                全部保留
              </button>
              <button type="button" className="pill" onClick={() => actions.restoreTurnFiles(turn)}>
                全部还原
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export const TurnRow = memo(TurnRowView);
