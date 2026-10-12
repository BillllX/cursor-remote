// 输入区：回到最新、委派/审批/排队行与输入框
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AgentMode,
  AssistantApproval,
  AssistantState,
  CheckpointInfo,
  ClientMessage,
  PolicyId,
  PromptImage,
} from "@shared/protocol";
import { toolPreview } from "../../lib/chat/tools";
import type { Chat } from "../../lib/chat/types";
import { DELEGATION_STATUS } from "../AssistantPanel";
import { Composer } from "./Composer";

type ComposerDockProps = {
  jumpState: "" | "far" | "new";
  empty: boolean;
  scrollThreadToEnd: (smooth?: boolean) => void;
  assistantState: AssistantState | null;
  activeId: string;
  answerDelegation: (approval: AssistantApproval, allow: boolean) => void;
  openChatById: (chatId: string) => void;
  active: Chat;
  resolveApproval: (allow: boolean) => void;
  busy: boolean;
  sendQueued: (turnId: string) => void;
  dropQueued: (turnId: string) => void;
  draft: string;
  composerEpoch: number;
  images: PromptImage[];
  uploading: number;
  notice: string;
  error: string;
  model: string;
  models: string[];
  persistModel: (value: string) => void;
  mode: AgentMode;
  persistMode: (value: AgentMode) => void;
  persistConfirmWrites: (value: boolean) => void;
  policyRef: RefObject<PolicyId>;
  persistPolicy: (value: PolicyId) => void;
  connected: boolean;
  submit: (raw?: string) => void;
  stopChat: (chatId: string) => void;
  send: (message: ClientMessage) => void;
  checkpoints: CheckpointInfo[];
  addImages: (files: FileList | File[]) => Promise<number>;
  handleComposerFiles: (files: FileList | File[]) => void;
  removeImage: (index: number) => void;
  fileHits: string[];
  mentionQuery: string | null;
  handleDraftChange: (value: string, caret: number) => void;
  handlePickFile: (path: string, line?: number, endLine?: number, snippet?: string) => void;
  openFile: (path: string, line?: number, asDiff?: boolean) => void;
  removeDraftMention: (token: string) => void;
  dismissMention: () => void;
  draftCaret: number | null;
  setDraftCaret: Dispatch<SetStateAction<number | null>>;
};

export function ComposerDock({
  jumpState,
  empty,
  scrollThreadToEnd,
  assistantState,
  activeId,
  answerDelegation,
  openChatById,
  active,
  resolveApproval,
  busy,
  sendQueued,
  dropQueued,
  draft,
  composerEpoch,
  images,
  uploading,
  notice,
  error,
  model,
  models,
  persistModel,
  mode,
  persistMode,
  persistConfirmWrites,
  policyRef,
  persistPolicy,
  connected,
  submit,
  stopChat,
  send,
  checkpoints,
  addImages,
  handleComposerFiles,
  removeImage,
  fileHits,
  mentionQuery,
  handleDraftChange,
  handlePickFile,
  openFile,
  removeDraftMention,
  dismissMention,
  draftCaret,
  setDraftCaret,
}: ComposerDockProps) {
  return (
    <div className="composer-dock">
      {jumpState && !empty ? (
        <button
          type="button"
          className={`thread-jump${jumpState === "new" ? " new" : ""}`}
          onClick={() => scrollThreadToEnd(true)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3.5v8.5M4 8.5l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {jumpState === "new" ? "有新内容" : "回到最新"}
        </button>
      ) : null}
      <div className="composer-wrap">
        {(() => {
          const mine = (assistantState?.delegations || []).filter(
            (row) => row.parentChatId === activeId && (row.status === "running" || row.status === "awaiting"),
          );
          if (!mine.length) return null;
          return mine.map((row) => {
            const approval = assistantState?.approvals.find((item) => item.delegationId === row.id);
            return (
              <div className={`approval-row delegation-row${approval ? "" : " idle"}`} key={row.id}>
                <span>
                  委派「{row.title}」→ {row.workspace} · {DELEGATION_STATUS[row.status]}
                  {approval ? `：要${approval.tool === "shell" ? "跑命令" : "改文件"} ${approval.summary}` : ""}
                </span>
                {approval ? (
                  <>
                    <button type="button" className="pill" onClick={() => answerDelegation(approval, true)}>
                      批准
                    </button>
                    <button type="button" className="pill" onClick={() => answerDelegation(approval, false)}>
                      拒绝
                    </button>
                  </>
                ) : null}
                <button type="button" className="pill" onClick={() => openChatById(row.childChatId)}>
                  打开子会话
                </button>
              </div>
            );
          });
        })()}
        {(() => {
          const pending = empty ? undefined : [...active.turns].reverse().find((turn) => turn.pendingTool)?.pendingTool;
          if (!pending) return null;
          return (
            <div className="approval-row">
              <span>要改文件：{toolPreview(pending.name, pending.args)}。允许会先还原再写；拒绝还原到发送前。</span>
              <button type="button" className="pill" onClick={() => resolveApproval(true)}>
                允许
              </button>
              <button type="button" className="pill" onClick={() => resolveApproval(false)}>
                拒绝
              </button>
            </div>
          );
        })()}
        {empty || !active.turns.some((turn) => turn.queued) ? null : (
          <div className="queue-row">
            {active.turns
              .filter((turn) => turn.queued)
              .map((turn) => (
                <span className="queue-chip" key={turn.id}>
                  <button
                    type="button"
                    className="queue-chip-send"
                    disabled={busy}
                    title={busy ? "等当前这条跑完，或先停止" : "现在发送这条"}
                    onClick={() => sendQueued(turn.id)}
                  >
                    排队 · {turn.user.slice(0, 24)}
                  </button>
                  <button
                    type="button"
                    className="queue-chip-drop"
                    title="去掉这条排队"
                    onClick={() => dropQueued(turn.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}
        <Composer
          draft={draft}
          epoch={composerEpoch}
          images={images}
          uploading={uploading}
          notice={notice}
          error={error}
          model={model}
          models={models}
          setModel={persistModel}
          mode={mode}
          setMode={persistMode}
          confirmWrites={Boolean(active?.confirmWrites)}
          setConfirmWrites={persistConfirmWrites}
          policy={policyRef.current}
          setPolicy={persistPolicy}
          busy={busy}
          connected={connected}
          onSubmit={submit}
          onStop={() => stopChat(activeId)}
          onUndo={() => send({ type: "undo", chatId: activeId })}
          onRestore={(id) => send({ type: "restore", chatId: activeId, checkpointId: id })}
          onOpenMenu={() => send({ type: "list_checkpoints", chatId: activeId })}
          checkpoints={checkpoints}
          onAddImages={addImages}
          onDropFiles={handleComposerFiles}
          onRemoveImage={removeImage}
          fileHits={fileHits}
          mentionQuery={mentionQuery}
          onDraftChange={handleDraftChange}
          onPickFile={handlePickFile}
          onOpenFile={openFile}
          onRemoveMention={removeDraftMention}
          onDismissMention={dismissMention}
          caret={draftCaret}
          onCaretApplied={() => setDraftCaret(null)}
          centered={empty}
        />
      </div>
    </div>
  );
}
