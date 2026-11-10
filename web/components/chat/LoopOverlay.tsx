// 循环任务（Loop）浮窗
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AgentMode, ClientMessage, LoopState } from "@shared/protocol";

type LoopOverlayProps = {
  wideIDE?: boolean;
  sidePane?: "search" | "chats" | "files" | "git" | "terminal" | "loop";
  setLoopOpen: Dispatch<SetStateAction<boolean>>;
  loopTrap: RefObject<HTMLFormElement | null>;
  loopGoal: string;
  loopInterval: string;
  loopMax: string;
  setNotice: Dispatch<SetStateAction<string>>;
  send: (message: ClientMessage) => void;
  activeId: string;
  model: string;
  mode: AgentMode;
  setLoopGoal: Dispatch<SetStateAction<string>>;
  setLoopInterval: Dispatch<SetStateAction<string>>;
  setLoopMax: Dispatch<SetStateAction<string>>;
  loops: Record<
    string,
    LoopState & {
      tickStatus?: string;
    }
  >;
};

export function LoopOverlay({
  setLoopOpen,
  loopTrap,
  loopGoal,
  loopInterval,
  loopMax,
  setNotice,
  send,
  activeId,
  model,
  mode,
  setLoopGoal,
  setLoopInterval,
  setLoopMax,
  loops,
}: LoopOverlayProps) {
  const activeLoop = loops[activeId];
  const isRunning = activeLoop && activeLoop.status !== "stopped" && activeLoop.status !== "idle";

  return (
    <div className="search-overlay workspace-modal-overlay open" onClick={() => setLoopOpen(false)}>
      <form
        ref={loopTrap}
        className="search-box loop-box workspace-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="循环任务"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          const goal = loopGoal.trim();
          const intervalSec = Math.round(Number(loopInterval));
          const maxTicks = loopMax.trim() ? Math.round(Number(loopMax)) : undefined;
          if (!goal) {
            setNotice("Loop 需要一段目标");
            return;
          }
          if (goal.length > 4000) {
            setNotice("Loop 目标超过 4000 字");
            return;
          }
          if (!Number.isInteger(intervalSec) || intervalSec < 30 || intervalSec > 86400) {
            setNotice("间隔要在 30 秒到 24 小时之间");
            return;
          }
          if (maxTicks != null && (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 100)) {
            setNotice("最多 1 到 100 拍");
            return;
          }
          send({
            type: "loop_start",
            chatId: activeId,
            goal,
            intervalSec,
            maxTicks,
            model,
            mode,
          });
        }}
      >
        <div className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">Loop · 当前对话</span>
              {isRunning ? <span className="workspace-modal-badge">运行中</span> : null}
            </div>
            <div className="workspace-modal-sub">按设定间隔自动唤醒当前会话继续推进目标</div>
          </div>
          <div className="workspace-modal-actions">
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label="关闭循环任务"
              title="关闭 (Esc)"
              onClick={() => setLoopOpen(false)}
            >
              ×
            </button>
          </div>
        </div>

        <div className="workspace-modal-body" style={{ display: "grid", gap: 12 }}>
          <textarea
            className="loop-goal"
            rows={4}
            placeholder="每拍要做的事。做完时让它在最后一行写 LOOP_DONE"
            value={loopGoal}
            onChange={(event) => setLoopGoal(event.target.value)}
          />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="loop-field">
              间隔（秒）
              <input
                className="side-input"
                inputMode="numeric"
                value={loopInterval}
                onChange={(event) => setLoopInterval(event.target.value)}
              />
            </label>
            <label className="loop-field">
              最多拍数，可空
              <input
                className="side-input"
                inputMode="numeric"
                value={loopMax}
                onChange={(event) => setLoopMax(event.target.value)}
              />
            </label>
          </div>
          {activeLoop ? (
            <div className="loop-meta">
              {activeLoop.status === "running"
                ? "正在跑"
                : activeLoop.status === "armed"
                  ? "等待下一拍"
                  : activeLoop.status === "stopped"
                    ? "已停止"
                    : "空闲"}
              {" · "}第 {activeLoop.tick} 拍{activeLoop.maxTicks ? ` / ${activeLoop.maxTicks}` : ""}
              {activeLoop.tickStatus === "skipped" ? " · 顺延" : activeLoop.tickStatus === "error" ? " · 出错" : ""}
              {activeLoop.lastSummary ? ` · ${activeLoop.lastSummary}` : ""}
            </div>
          ) : (
            <div className="loop-meta">还没开始。关上网页也会继续，重新打开后状态还在。</div>
          )}
          <div className="loop-actions">
            <button className="new-chat primary" type="submit" disabled={Boolean(isRunning)}>
              开始
            </button>
            <button
              className="new-chat"
              type="button"
              disabled={!activeLoop || activeLoop.status === "stopped"}
              onClick={() => send({ type: "loop_stop", chatId: activeId })}
            >
              停止
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
