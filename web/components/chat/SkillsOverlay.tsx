"use client";

// 独立技能工厂浮窗（管理当前工作区与平台级 SKILL.md 技能包、受控手册、原生工具与新技能提案审批）
import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { buildAssistantOpMessage, type BuildAssistantOpMessage } from "@shared/assistantOp";
import type {
  AssistantResultMessage,
  ClientMessage,
  SkillFactoryProposalItem,
  SkillFactorySummaryItem,
} from "@shared/protocol";
import MemoryCenterSkillsPane, { MemoryCenterSkillDetail } from "../assistant/MemoryCenterSkillsPane";
import styles from "../assistant/memoryCenter.module.css";

type SkillsOverlayProps = {
  open: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  workspaceKey: string;
  workspaceName: string;
  send: (message: ClientMessage) => void;
  lastAssistantResult: AssistantResultMessage | null;
  assistantResultTick: number;
  setNotice: Dispatch<SetStateAction<string>>;
  onUseSkillInChat: (promptText: string) => void;
};

export function SkillsOverlay({
  open,
  onClose,
  dialogRef,
  workspaceKey,
  workspaceName,
  send,
  lastAssistantResult,
  assistantResultTick,
  setNotice,
  onUseSkillInChat,
}: SkillsOverlayProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillFactorySummaryItem[]>([]);
  const [proposals, setProposals] = useState<SkillFactoryProposalItem[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const op = useCallback(
    (...params: Parameters<BuildAssistantOpMessage>) => {
      send(buildAssistantOpMessage(...params));
    },
    [send],
  ) as BuildAssistantOpMessage;

  useEffect(() => {
    if (!open) return;
    op("skill_factory_status", { workspace: workspaceKey || undefined });
  }, [open, op, workspaceKey]);

  useEffect(() => {
    if (!lastAssistantResult) return;
    if (
      lastAssistantResult.op !== "skill_factory_status" &&
      lastAssistantResult.op !== "skill_proposal_decide" &&
      lastAssistantResult.op !== "skill_update_meta" &&
      lastAssistantResult.op !== "skill_edit_approved"
    ) {
      return;
    }
    setDecidingId(null);
    if (!lastAssistantResult.ok) {
      if (lastAssistantResult.error) setNotice(lastAssistantResult.error);
      return;
    }
    if (lastAssistantResult.data) {
      setSkills(lastAssistantResult.data.skills ?? []);
      setProposals(lastAssistantResult.data.proposals ?? []);
    }
    if (lastAssistantResult.op === "skill_update_meta") {
      setNotice("技能设置已更新。");
    } else if (lastAssistantResult.op === "skill_edit_approved") {
      setNotice("技能已保存并重签 SHA-256 完整性锁。");
    }
  }, [lastAssistantResult, assistantResultTick, setNotice]);

  const handleUseSkill = useCallback(
    (sk: SkillFactorySummaryItem) => {
      onUseSkillInChat(`请调用技能「${sk.name}」（${sk.id}）协助处理当前任务。`);
      onClose();
    },
    [onClose, onUseSkillInChat],
  );

  if (!open) return null;

  const pendingCount = proposals.filter((p) => p.status === "pending").length;

  return (
    <div className="search-overlay workspace-modal-overlay open" onClick={onClose}>
      <div
        ref={dialogRef}
        className="search-box assistant-box workspace-modal-box memory-center-wide"
        role="dialog"
        aria-modal="true"
        aria-label="技能工厂"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">技能工厂</span>
              {workspaceName ? <span className="workspace-modal-badge">{workspaceName}</span> : null}
              {pendingCount > 0 ? (
                <span className="chat-mark warn">待批准 {pendingCount}</span>
              ) : null}
            </div>
            <div className="workspace-modal-sub">
              管理声明式技能包（.jiebo/skills/&lt;id&gt;/SKILL.md）、受控操作手册、原生工具与新技能提案审批
            </div>
          </div>
          <div className="workspace-modal-actions">
            <button
              type="button"
              className="workspace-modal-btn"
              onClick={() => op("skill_factory_status", { workspace: workspaceKey || undefined })}
            >
              刷新
            </button>
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label="关闭技能工厂"
              title="关闭 (Esc)"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        <div
          className="assistant-body"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(300px, 1.15fr) minmax(280px, 1fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div className={styles.middle} style={{ minWidth: 0 }}>
            <MemoryCenterSkillsPane
              folderId={workspaceKey || null}
              op={op}
              lastResult={lastAssistantResult}
              resultTick={assistantResultTick}
              onNotice={setNotice}
              selectedKey={selectedKey}
              onSelectKey={(key) => setSelectedKey(key)}
              onDataChange={(nextSkills, nextProposals) => {
                setSkills(nextSkills);
                setProposals(nextProposals);
              }}
              onUseSkillInChat={handleUseSkill}
            />
          </div>

          <aside className={styles.detail} aria-label="技能详情" style={{ minWidth: 0 }}>
            <MemoryCenterSkillDetail
              selectedKey={selectedKey}
              skills={skills}
              proposals={proposals}
              decidingId={decidingId}
              onDecide={(prop, approve) => {
                setDecidingId(prop.id);
                op("skill_proposal_decide", {
                  proposalId: prop.id,
                  approve,
                  expectedRev: prop.rev,
                  decisionNote: approve ? "在技能工厂浮窗批准上架" : "在技能工厂浮窗拒绝",
                });
              }}
              onUseSkillInChat={handleUseSkill}
              onUpdateMeta={(sk, patch) => {
                op("skill_update_meta", {
                  skillId: sk.id,
                  entry: sk.entry,
                  ...patch,
                  workspace: workspaceKey || undefined,
                });
              }}
              onEditApproved={(sk, draft) => {
                if (!sk.sha256) return;
                op("skill_edit_approved", {
                  skillId: sk.id,
                  entry: sk.entry,
                  expectedSha256: sk.sha256,
                  name: draft.name,
                  summary: draft.summary,
                  keywords: draft.keywords,
                  globs: sk.triggers.globs,
                  requiredTools: sk.requiredTools,
                  refs: sk.refs,
                  body: draft.body,
                  workspace: workspaceKey || undefined,
                });
              }}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
