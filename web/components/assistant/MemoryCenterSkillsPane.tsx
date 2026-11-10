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
  selectedKey?: string | null;
  onSelectKey?: (key: string) => void;
  onDataChange?: (skills: SkillFactorySummaryItem[], proposals: SkillFactoryProposalItem[]) => void;
  onUseSkillInChat?: (skill: SkillFactorySummaryItem) => void;
};

export const KIND_LABEL: Record<SkillFactoryKind, string> = {
  channel_guard: "后台守卫",
  native_tool: "原生工具",
  manual_runbook: "受控手册",
  declarative_skill: "技能包",
};

export const SCOPE_LABEL: Record<SkillFactoryScope, string> = {
  platform: "平台级",
  workspace: "工作区",
  repo: "仓库级",
};

export function healthToneOf(health: SkillFactorySummaryItem["health"]) {
  return health === "healthy" ? "ok" : health === "tampered" ? "danger" : "warn";
}

export function healthTextOf(health: SkillFactorySummaryItem["health"]) {
  if (health === "healthy") return "正常";
  if (health === "tampered") return "哈希篡改/未锁";
  if (health === "broken_ref") return "引用待核实";
  if (health === "degraded") return "降级运行";
  if (health === "disabled") return "已停用";
  return health;
}

export function MemoryCenterSkillDetail({
  selectedKey,
  skills,
  proposals,
  decidingId,
  onDecide,
  onUseSkillInChat,
  onUpdateMeta,
  onEditApproved,
}: {
  selectedKey: string | null;
  skills: SkillFactorySummaryItem[];
  proposals: SkillFactoryProposalItem[];
  decidingId: string | null;
  onDecide: (proposal: SkillFactoryProposalItem, approve: boolean) => void;
  onUseSkillInChat?: (skill: SkillFactorySummaryItem) => void;
  onUpdateMeta?: (
    skill: SkillFactorySummaryItem,
    patch: { pinned?: boolean; autoPrewarm?: boolean; disabled?: boolean },
  ) => void;
  onEditApproved?: (
    skill: SkillFactorySummaryItem,
    draft: { name: string; summary: string; keywords: string[]; body: string },
  ) => void;
}) {
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editKeywords, setEditKeywords] = useState("");
  const [editBody, setEditBody] = useState("");

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const propId = selectedKey?.startsWith("prop:") ? selectedKey.slice(5) : null;
  const skillId = selectedKey?.startsWith("skill:") ? selectedKey.slice(6) : null;

  const activeProposal =
    (propId ? proposals.find((p) => p.id === propId) : null) ??
    (!skillId && pendingProposals.length > 0 ? pendingProposals[0] : null);

  if (activeProposal) {
    const busy = decidingId === activeProposal.id;
    return (
      <div className={styles.detailBody}>
        <div className="side-label">待启用技能草案</div>
        <div className="assistant-item-head">
          <span className="assistant-item-title">
            {activeProposal.name} ({activeProposal.skillId})
          </span>
          <span className={`chat-mark warn ${MEMORY_CENTER_CSS.badge}`}>待批准</span>
        </div>
        <div className="assistant-item-body">{activeProposal.summary}</div>
        <p className="loop-meta">
          作用文件夹：{activeProposal.targetDir} · 权限：
          {activeProposal.mode === "write" ? "读写（允许改文件与跑脚本）" : "只读参考"}
        </p>
        {activeProposal.triggers.keywords.length > 0 ? (
          <p className="loop-meta">触发关键词：{activeProposal.triggers.keywords.join("、")}</p>
        ) : null}
        {activeProposal.triggers.globs.length > 0 ? (
          <p className="loop-meta">匹配文件：{activeProposal.triggers.globs.join("、")}</p>
        ) : null}
        {activeProposal.requiredTools.length > 0 ? (
          <p className="loop-meta">关联工具：{activeProposal.requiredTools.join(", ")}</p>
        ) : null}
        {activeProposal.promotedFromMemoryIds.length > 0 ? (
          <p className={styles.subline}>
            批准后将自动把 {activeProposal.promotedFromMemoryIds.length} 条原工作区记忆标为「已办完」，释放常驻空间。
          </p>
        ) : null}
        {activeProposal.status === "pending" ? (
          <div className={styles.rowMeta}>
            <button
              type="button"
              className={styles.pineBtn}
              disabled={busy}
              onClick={() => onDecide(activeProposal, true)}
            >
              {busy ? "处理中…" : "批准上架"}
            </button>
            <button type="button" className="pill" disabled={busy} onClick={() => onDecide(activeProposal, false)}>
              拒绝
            </button>
          </div>
        ) : null}
        <div className="side-label">技能手册全文（SKILL.md）</div>
        <pre className="assistant-pre">{activeProposal.formattedMarkdown}</pre>
        <details>
          <summary className="loop-meta">安全门禁与落盘信息（#{activeProposal.sha256.slice(0, 8)}）</summary>
          <p className="loop-meta">落盘路径：{activeProposal.relSkillPath}</p>
          <p className="loop-meta">SHA-256：{activeProposal.sha256}</p>
        </details>
      </div>
    );
  }

  const activeSkill =
    (skillId ? skills.find((s) => s.id === skillId) : null) ??
    skills.find((s) => s.kind !== "channel_guard") ??
    skills[0] ??
    null;

  if (!activeSkill) {
    return <p className={styles.subline}>在左侧点选一项技能或提案，查看完整操作手册（SOP）。</p>;
  }

  const isEditing = editingSkillId === activeSkill.id;
  const canEditDeclarative =
    activeSkill.kind === "declarative_skill" &&
    activeSkill.health === "healthy" &&
    Boolean(activeSkill.sha256) &&
    Boolean(onEditApproved);

  const startEditing = () => {
    setEditingSkillId(activeSkill.id);
    setEditName(activeSkill.name);
    setEditSummary(activeSkill.summary);
    setEditKeywords(activeSkill.triggers.keywords.join(", "));
    setEditBody(activeSkill.body ?? "");
  };

  return (
    <div className={styles.detailBody}>
      <div className="side-label">
        {activeSkill.kind === "channel_guard" ? "平台后台守卫（系统自动运行）" : "技能详情与操作手册"}
      </div>
      <div className="assistant-item-head">
        <span className="assistant-item-title">{activeSkill.name}</span>
        <span className={`chat-mark ${healthToneOf(activeSkill.health)} ${MEMORY_CENTER_CSS.badge}`}>
          {healthTextOf(activeSkill.health)}
        </span>
      </div>
      <div className="assistant-item-body">{activeSkill.summary}</div>
      <div className={styles.rowMeta}>
        <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>
          {KIND_LABEL[activeSkill.kind] ?? activeSkill.kind}
        </span>
        <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>
          {SCOPE_LABEL[activeSkill.scope] ?? activeSkill.scope}
        </span>
        {activeSkill.pinned ? <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>常驻推荐</span> : null}
        {activeSkill.autoPrewarm ? <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>自动预热</span> : null}
      </div>
      <p className="loop-meta">
        被采用 {activeSkill.stats.adoptedCount} 次 · 查阅 {activeSkill.stats.viewedCount} 次 · 自动预热{" "}
        {activeSkill.stats.prewarmedCount} 次
      </p>
      {activeSkill.triggers.keywords.length > 0 ? (
        <p className="loop-meta">触发词：{activeSkill.triggers.keywords.join("、")}</p>
      ) : null}
      {activeSkill.triggers.globs.length > 0 ? (
        <p className="loop-meta">匹配文件：{activeSkill.triggers.globs.join("、")}</p>
      ) : null}
      {activeSkill.requiredTools.length > 0 ? (
        <p className="loop-meta">关联工具：{activeSkill.requiredTools.join(", ")}</p>
      ) : null}
      {activeSkill.healthReason ? <p className={styles.clayText}>{activeSkill.healthReason}</p> : null}

      {activeSkill.kind !== "channel_guard" && activeSkill.health !== "tampered" ? (
        <div className={styles.rowMeta}>
          {activeSkill.health !== "disabled" && onUseSkillInChat ? (
            <button type="button" className={styles.pineBtn} onClick={() => onUseSkillInChat(activeSkill)}>
              在对话中使用
            </button>
          ) : null}
          {canEditDeclarative && !isEditing ? (
            <button type="button" className="pill" onClick={startEditing}>
              编辑手册与触发词
            </button>
          ) : null}
          {onUpdateMeta ? (
            <>
              <button
                type="button"
                className="pill"
                onClick={() => onUpdateMeta(activeSkill, { pinned: !activeSkill.pinned })}
              >
                {activeSkill.pinned ? "取消常驻推荐" : "设为常驻推荐"}
              </button>
              {activeSkill.mode === "read" ? (
                <button
                  type="button"
                  className="pill"
                  onClick={() => onUpdateMeta(activeSkill, { autoPrewarm: !activeSkill.autoPrewarm })}
                >
                  {activeSkill.autoPrewarm ? "关闭自动预热" : "开启自动预热"}
                </button>
              ) : null}
              <button
                type="button"
                className="pill"
                onClick={() => onUpdateMeta(activeSkill, { disabled: activeSkill.health !== "disabled" })}
              >
                {activeSkill.health === "disabled" ? "恢复启用" : "停用此技能"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {isEditing && canEditDeclarative ? (
        <form
          className={styles.detailBody}
          onSubmit={(e) => {
            e.preventDefault();
            const kwList = editKeywords
              .split(/[,，、]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            onEditApproved?.(activeSkill, {
              name: editName.trim(),
              summary: editSummary.trim(),
              keywords: kwList,
              body: editBody,
            });
            setEditingSkillId(null);
          }}
        >
          <div className="side-label">在线编辑技能包（保存时自动复检五道安全门禁并重签 SHA-256）</div>
          <input
            className="side-input"
            value={editName}
            placeholder="技能名称"
            onChange={(e) => setEditName(e.target.value)}
          />
          <input
            className="side-input"
            value={editSummary}
            placeholder="一句话摘要"
            onChange={(e) => setEditSummary(e.target.value)}
          />
          <input
            className="side-input"
            value={editKeywords}
            placeholder="触发关键词（逗号分隔）"
            onChange={(e) => setEditKeywords(e.target.value)}
          />
          <textarea
            className="loop-goal"
            rows={10}
            value={editBody}
            placeholder="技能 SOP 正文"
            onChange={(e) => setEditBody(e.target.value)}
          />
          <div className={styles.rowMeta}>
            <button
              type="submit"
              className={styles.pineBtn}
              disabled={!editName.trim() || !editSummary.trim() || !editBody.trim()}
            >
              保存并重签锁
            </button>
            <button type="button" className="pill" onClick={() => setEditingSkillId(null)}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="side-label">操作手册（SOP 正文）</div>
          <pre className="assistant-pre">{activeSkill.body?.trim() || "（该能力未附带独立正文）"}</pre>
        </>
      )}

      <details>
        <summary className="loop-meta">底层技术信息（{activeSkill.id}）</summary>
        <p className="loop-meta">技能 ID：{activeSkill.id}</p>
        <p className="loop-meta">代码/文件入口：{activeSkill.entry}</p>
        {activeSkill.sha256 ? <p className="loop-meta">SHA-256：{activeSkill.sha256}</p> : null}
      </details>
    </div>
  );
}

export default function MemoryCenterSkillsPane({
  folderId,
  op,
  lastResult,
  resultTick,
  onNotice,
  selectedKey,
  onSelectKey,
  onDataChange,
  onUseSkillInChat,
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
    if (
      lastResult.op !== "skill_factory_status" &&
      lastResult.op !== "skill_proposal_decide" &&
      lastResult.op !== "skill_update_meta" &&
      lastResult.op !== "skill_edit_approved"
    ) {
      return;
    }
    setLoading(false);
    setDecidingId(null);
    if (!lastResult.ok) {
      setError(lastResult.error || "技能工厂操作失败");
      return;
    }
    setError(null);
    if (lastResult.data) {
      const nextSkills = lastResult.data.skills ?? [];
      const nextProposals = lastResult.data.proposals ?? [];
      setSkills(nextSkills);
      setProposals(nextProposals);
      onDataChange?.(nextSkills, nextProposals);
    }
    if (lastResult.op === "skill_proposal_decide") {
      onNotice("技能提案已处理。");
    } else if (lastResult.op === "skill_update_meta") {
      onNotice("技能设置已更新。");
    } else if (lastResult.op === "skill_edit_approved") {
      onNotice("技能已保存并更新 SHA-256 签名锁。");
    }
  }, [lastResult, resultTick, onNotice, onDataChange]);

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const visibleSkills = skills.filter((s) => (scopeFilter === "all" ? true : s.scope === scopeFilter));
  const callableSkills = visibleSkills.filter((s) => s.kind !== "channel_guard");
  const guardSkills = visibleSkills.filter((s) => s.kind === "channel_guard");

  const decide = (proposal: SkillFactoryProposalItem, approve: boolean) => {
    setDecidingId(proposal.id);
    op("skill_proposal_decide", {
      proposalId: proposal.id,
      approve,
      expectedRev: proposal.rev,
      decisionNote: approve ? "在技能工厂面板批准上架" : "在技能工厂面板拒绝",
    });
  };

  const updateMeta = (
    sk: SkillFactorySummaryItem,
    patch: { pinned?: boolean; autoPrewarm?: boolean; disabled?: boolean },
  ) => {
    op("skill_update_meta", {
      skillId: sk.id,
      entry: sk.entry,
      ...patch,
      workspace: folderId || undefined,
    });
  };

  const activeKey = selectedKey ?? expandedId;
  const pickKey = (key: string) => {
    setExpandedId((prev) => (prev === key ? null : key));
    onSelectKey?.(key);
  };

  const renderSkillRow = (sk: SkillFactorySummaryItem) => {
    const key = `skill:${sk.id}`;
    const isSelected = activeKey === key;
    const isInlineExpanded = !onSelectKey && expandedId === key;
    const healthTone = healthToneOf(sk.health);
    const healthText = healthTextOf(sk.health);
    return (
      <li key={sk.id}>
        <div
          role="button"
          tabIndex={0}
          aria-pressed={isSelected}
          className={`assistant-item assistant-item-btn ${MEMORY_CENTER_CSS.rowBtn}${isSelected ? ` ${MEMORY_CENTER_CSS.rowSelected}` : ""}`}
          onClick={() => pickKey(key)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pickKey(key);
            }
          }}
        >
          <div className="assistant-item-head">
            <span className="assistant-item-title">{sk.name}</span>
            <span className={`chat-mark ${healthTone} ${MEMORY_CENTER_CSS.badge}`}>{healthText}</span>
          </div>
          <div className="assistant-item-body">{sk.summary}</div>
          <div className={styles.rowMeta}>
            <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>{KIND_LABEL[sk.kind] ?? sk.kind}</span>
            <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>{SCOPE_LABEL[sk.scope] ?? sk.scope}</span>
            {sk.pinned ? <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>常驻推荐</span> : null}
            {sk.autoPrewarm ? <span className={`chat-mark ${MEMORY_CENTER_CSS.badge}`}>自动预热</span> : null}
            <span className="loop-meta">
              采用 {sk.stats.adoptedCount} · 查阅 {sk.stats.viewedCount} · 预热 {sk.stats.prewarmedCount}
            </span>
          </div>
          {isInlineExpanded ? (
            <div className={styles.detailBody} onClick={(e) => e.stopPropagation()}>
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
              {sk.healthReason ? <p className={styles.clayText}>{sk.healthReason}</p> : null}
              {sk.kind !== "channel_guard" && sk.health !== "tampered" ? (
                <div className={styles.rowMeta}>
                  <button type="button" className="pill" onClick={() => updateMeta(sk, { pinned: !sk.pinned })}>
                    {sk.pinned ? "取消常驻推荐" : "设为常驻推荐"}
                  </button>
                  {sk.mode === "read" ? (
                    <button
                      type="button"
                      className="pill"
                      onClick={() => updateMeta(sk, { autoPrewarm: !sk.autoPrewarm })}
                    >
                      {sk.autoPrewarm ? "关闭自动预热" : "开启自动预热"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="pill"
                    onClick={() => updateMeta(sk, { disabled: sk.health !== "disabled" })}
                  >
                    {sk.health === "disabled" ? "恢复启用" : "停用此技能"}
                  </button>
                  {sk.health !== "disabled" && onUseSkillInChat ? (
                    <button type="button" className={styles.pineBtn} onClick={() => onUseSkillInChat(sk)}>
                      在对话中使用
                    </button>
                  ) : null}
                </div>
              ) : null}
              {sk.body ? <pre className="assistant-pre">{sk.body}</pre> : null}
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <div className={styles.detailBody}>
      <div className={styles.headRow}>
        <p className={styles.subline}>
          对话技能 {callableSkills.length} 项 · 后台守卫 {guardSkills.length} 项
          {pendingProposals.length > 0 ? ` · 待启用 ${pendingProposals.length} 项` : ""}
        </p>
        <div className={styles.rowMeta}>
          <select
            className="pill"
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
      </div>

      {error ? (
        <div className={MEMORY_CENTER_CSS.statusError}>
          <p>{error}</p>
          <button type="button" className="pill" onClick={loadSkills}>
            重试
          </button>
        </div>
      ) : null}

      {loading && !skills.length ? <div className={MEMORY_CENTER_CSS.statusLoading}>正在加载技能工厂…</div> : null}

      {pendingProposals.length > 0 ? (
        <div>
          <div className="side-label">待你确认启用的新技能（{pendingProposals.length} 项）</div>
          <ul className="assistant-list">
            {pendingProposals.map((prop) => {
              const key = `prop:${prop.id}`;
              const isExpanded = expandedId === key;
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
                      作用文件夹：{prop.targetDir} · 权限：{prop.mode === "write" ? "读写" : "只读"} · 已通过安全门禁（#
                      {prop.sha256.slice(0, 8)}）
                    </span>
                  </div>
                  {prop.promotedFromMemoryIds.length > 0 ? (
                    <p className={styles.subline}>
                      批准后将自动把 {prop.promotedFromMemoryIds.length} 条原工作区记忆标为「已办完」释放常驻预算。
                    </p>
                  ) : null}
                  {isExpanded ? (
                    <div>
                      <p className="loop-meta">
                        落盘路径：{prop.relSkillPath} · SHA-256：{prop.sha256}
                      </p>
                      <pre className="assistant-pre">{prop.formattedMarkdown}</pre>
                    </div>
                  ) : null}
                  <div className={styles.rowMeta}>
                    <button type="button" className="pill" onClick={() => pickKey(key)}>
                      {isExpanded ? "收起技能手册" : "预览技能手册"}
                    </button>
                    <button type="button" className={styles.pineBtn} disabled={busy} onClick={() => decide(prop, true)}>
                      {busy ? "处理中…" : "批准上架"}
                    </button>
                    <button type="button" className="pill" disabled={busy} onClick={() => decide(prop, false)}>
                      拒绝
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="side-label">对话可用技能（可在聊天中调用）</div>
      <ul className="assistant-list">{callableSkills.map(renderSkillRow)}</ul>

      {guardSkills.length > 0 ? (
        <>
          <div className="side-label">系统后台守卫（网关自动运行）</div>
          <ul className="assistant-list">{guardSkills.map(renderSkillRow)}</ul>
        </>
      ) : null}
    </div>
  );
}
