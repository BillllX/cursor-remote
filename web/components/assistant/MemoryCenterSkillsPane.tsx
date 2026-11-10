"use client";

import { useCallback, useEffect, useState } from "react";
import type { BuildAssistantOpMessage } from "@shared/assistantOp";
import type {
  AssistantResultMessage,
  SkillFactoryKind,
  SkillFactoryProposalItem,
  SkillFactoryScope,
  SkillFactorySummaryItem,
} from "@shared/protocol";
import styles from "./memoryCenter.module.css";
import { MEMORY_CENTER_CSS } from "./memoryCenterLabels";

type Props = {
  folderId: string | null;
  op: BuildAssistantOpMessage;
  lastResult: AssistantResultMessage | null;
  resultTick: number;
  onNotice: (text: string) => void;
};

const KIND_LABEL: Record<SkillFactoryKind, string> = {
  channel_guard: "后台守卫",
  native_tool: "原生工具",
  manual_runbook: "受控手册",
  declarative_skill: "技能包",
};

const SCOPE_LABEL: Record<SkillFactoryScope, string> = {
  platform: "平台级",
  workspace: "工作区",
  repo: "仓库级",
};

export default function MemoryCenterSkillsPane({
  folderId,
  op,
  lastResult,
  resultTick,
  onNotice,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillFactorySummaryItem[]>([]);
  const [proposals, setProposals] = useState<SkillFactoryProposalItem[]>([]);
  const [scopeFilter, setScopeFilter] = useState<SkillFactoryScope | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const loadSkills = useCallback(() => {
    setLoading(true);
    setError(null);
    op("skill_factory_status", { workspace: folderId || undefined });
  }, [folderId, op]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!lastResult) return;
    if (lastResult.op !== "skill_factory_status" && lastResult.op !== "skill_proposal_decide") return;
    setLoading(false);
    setDecidingId(null);
    if (!lastResult.ok) {
      setError(lastResult.error || "技能工厂加载失败");
      return;
    }
    setError(null);
    if (lastResult.data) {
      setSkills(lastResult.data.skills ?? []);
      setProposals(lastResult.data.proposals ?? []);
    }
    if (lastResult.op === "skill_proposal_decide") {
      onNotice("技能提案已处理。");
    }
  }, [lastResult, resultTick, onNotice]);

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const visibleSkills = skills.filter((s) => (scopeFilter === "all" ? true : s.scope === scopeFilter));

  const decide = (proposal: SkillFactoryProposalItem, approve: boolean) => {
    setDecidingId(proposal.id);
    op("skill_proposal_decide", {
      proposalId: proposal.id,
      approve,
      expectedRev: proposal.rev,
      decisionNote: approve ? "在技能工厂面板批准上架" : "在技能工厂面板拒绝",
    });
  };

  return (
    <div className={styles.detailBody}>
      <div className={styles.headRow}>
        <p className={styles.subline}>
          已集成 {skills.length} 项能力 · 待审批草案 {pendingProposals.length} 项
        </p>
        <select
          className={styles.folderMenu}
          aria-label="技能范围"
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value as SkillFactoryScope | "all")}
        >
          <option value="all">全部范围</option>
          <option value="platform">平台级</option>
          <option value="workspace">工作区</option>
          <option value="repo">仓库级</option>
        </select>
        <button type="button" className="pill" onClick={loadSkills}>
          刷新
        </button>
      </div>

      {error ? (
        <div className={MEMORY_CENTER_CSS.statusError}>
          <p>{error}</p>
          <button type="button" className="pill" onClick={loadSkills}>
            重试
          </button>
        </div>
      ) : null}

      {loading && !skills.length ? (
        <div className={MEMORY_CENTER_CSS.statusLoading}>正在加载技能工厂…</div>
      ) : null}

      {pendingProposals.length > 0 ? (
        <div>
          <div className="side-label">待你审批的技能包草案（SHA-256 锁定）</div>
          <ul className="assistant-list">
            {pendingProposals.map((prop) => {
              const isExpanded = expandedId === `prop:${prop.id}`;
              const busy = decidingId === prop.id;
              return (
                <li key={prop.id} className="assistant-item">
                  <div className="assistant-item-head">
                    <span className="assistant-item-title">
                      {prop.name} ({prop.skillId})
                    </span>
                    <span className={`chat-mark warn ${MEMORY_CENTER_CSS.badge}`}>待批准</span>
                  </div>
                  <div className="assistant-item-body">{prop.summary}</div>
                  <div className={styles.rowMeta}>
                    <span className="loop-meta">
                      落盘路径：{prop.relSkillPath} · 模式：{prop.mode === "write" ? "读写" : "只读"} · SHA-256：{prop.sha256}
                    </span>
                  </div>
                  {prop.promotedFromMemoryIds.length > 0 ? (
                    <p className={styles.subline}>
                      批准后将自动把 {prop.promotedFromMemoryIds.length} 条原工作区记忆标为「已办完」释放常驻预算。
                    </p>
                  ) : null}
                  {isExpanded ? (
                    <pre className="assistant-pre">{prop.formattedMarkdown}</pre>
                  ) : null}
                  <div className={styles.rowMeta}>
                    <button
                      type="button"
                      className="pill"
                      onClick={() => setExpandedId(isExpanded ? null : `prop:${prop.id}`)}
                    >
                      {isExpanded ? "收起 SKILL.md 全文" : "查看 SKILL.md 全文"}
                    </button>
                    <button
                      type="button"
                      className={styles.pineBtn}
                      disabled={busy}
                      onClick={() => decide(prop, true)}
                    >
                      {busy ? "处理中…" : "批准上架"}
                    </button>
                    <button
                      type="button"
                      className="pill"
                      disabled={busy}
                      onClick={() => decide(prop, false)}
                    >
                      拒绝
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="side-label">已集成技能与通道守卫</div>
      <ul className="assistant-list">
        {visibleSkills.map((sk) => {
          const isExpanded = expandedId === `skill:${sk.id}`;
          const healthTone =
            sk.health === "healthy"
              ? "ok"
              : sk.health === "tampered"
                ? "danger"
                : "warn";
          const healthText =
            sk.health === "healthy"
              ? "正常"
              : sk.health === "tampered"
                ? "哈希篡改/未锁"
                : sk.health === "broken_ref"
                  ? "引用待核实"
                  : sk.health;
          return (
            <li key={sk.id} className="assistant-item">
              <div
                role="button"
                tabIndex={0}
                className={`assistant-item-btn ${MEMORY_CENTER_CSS.rowBtn}`}
                onClick={() => setExpandedId(isExpanded ? null : `skill:${sk.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpandedId(isExpanded ? null : `skill:${sk.id}`);
                  }
                }}
              >
                <div className="assistant-item-head">
                  <span className="assistant-item-title">{sk.name}</span>
                  <span className={`chat-mark ${healthTone} ${MEMORY_CENTER_CSS.badge}`}>
                    {healthText}
                  </span>
                </div>
                <div className="assistant-item-body">{sk.summary}</div>
                <div className={styles.rowMeta}>
                  <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>
                    {KIND_LABEL[sk.kind] ?? sk.kind}
                  </span>
                  <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>
                    {SCOPE_LABEL[sk.scope] ?? sk.scope}
                  </span>
                  {sk.pinned ? (
                    <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>常驻摘要</span>
                  ) : null}
                  <span className="loop-meta">
                    采用 {sk.stats.adoptedCount} · 查阅 {sk.stats.viewedCount} · 预热 {sk.stats.prewarmedCount}
                  </span>
                </div>
                {isExpanded ? (
                  <div className={styles.detailBody}>
                    <p className="loop-meta">技能 ID：{sk.id}</p>
                    <p className="loop-meta">代码/文件入口：{sk.entry}</p>
                    {sk.triggers.keywords.length > 0 ? (
                      <p className="loop-meta">触发词：{sk.triggers.keywords.join("、")}</p>
                    ) : null}
                    {sk.triggers.globs.length > 0 ? (
                      <p className="loop-meta">文件匹配：{sk.triggers.globs.join("、")}</p>
                    ) : null}
                    {sk.requiredTools.length > 0 ? (
                      <p className="loop-meta">关联工具：{sk.requiredTools.join(", ")}</p>
                    ) : null}
                    {sk.healthReason ? (
                      <p className={styles.clayText}>{sk.healthReason}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
