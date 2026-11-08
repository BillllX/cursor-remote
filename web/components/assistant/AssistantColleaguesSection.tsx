"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildAssistantOpMessage } from "@shared/assistantOp";
import type {
  AssistantResultMessage,
  ClientMessage,
  KbColleagueProposalItem,
  KbDropTokenItem,
  KbWorkspaceStatusData,
  KbWorkspaceSummaryItem,
} from "@shared/protocol";

type AssistantColleaguesSectionProps = {
  send: (message: ClientMessage) => void;
  lastResult: AssistantResultMessage | null;
  resultTick: number;
  onNotice: (msg: string) => void;
};

export function AssistantColleaguesSection({
  send,
  lastResult,
  resultTick,
  onNotice,
}: AssistantColleaguesSectionProps) {
  const [status, setStatus] = useState<KbWorkspaceStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");

  // 新增跨工作区同事通行证表单
  const [labelDraft, setLabelDraft] = useState("");
  const [passcodeDraft, setPasscodeDraft] = useState("");
  const [expiresDraft, setExpiresDraft] = useState("");
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
  const [calFreeBusyDraft, setCalFreeBusyDraft] = useState(true);
  const [imTenantIdDraft, setImTenantIdDraft] = useState("");

  // 正在展开编辑的同事通行证 ID
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editImTenantId, setEditImTenantId] = useState("");

  const pendingReqIdsRef = useRef(new Set<string>());

  const dispatchOp = useCallback(
    (message: ClientMessage) => {
      if (message.type !== "assistant_op" || !message.reqId) return;
      pendingReqIdsRef.current.add(message.reqId);
      setLoading(true);
      setErrorText("");
      send(message);
    },
    [send],
  );

  const reload = useCallback(() => {
    dispatchOp(buildAssistantOpMessage("kb_workspace_status", { workspace: "" }));
  }, [dispatchOp]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!lastResult || !lastResult.reqId) return;
    if (!pendingReqIdsRef.current.delete(lastResult.reqId)) return;
    setLoading(pendingReqIdsRef.current.size > 0);

    const op = lastResult.op;
    if (
      op !== "kb_workspace_status" &&
      op !== "drop_token_create" &&
      op !== "drop_token_update" &&
      op !== "drop_token_revoke"
    ) {
      return;
    }
    if (!lastResult.ok) {
      setErrorText(lastResult.error || "操作失败");
      return;
    }
    const data = lastResult.data as KbWorkspaceStatusData | undefined;
    if (!data) return;
    setStatus(data);
    setErrorText("");

    if (selectedWorkspaces.length === 0 && data.kbWorkspaces && data.kbWorkspaces.length > 0) {
      setSelectedWorkspaces([data.kbWorkspaces[0]!.workspaceKey]);
    }

    if (op === "drop_token_create") {
      setPasscodeDraft("");
      setLabelDraft("");
      setImTenantIdDraft("");
      onNotice("已创建跨工作区同事通行证");
    } else if (op === "drop_token_update") {
      onNotice("已更新同事权限或提案状态");
    } else if (op === "drop_token_revoke") {
      onNotice("已吊销同事通行证");
    }
  }, [lastResult, resultTick, onNotice, selectedWorkspaces.length]);

  const kbWorkspaces: KbWorkspaceSummaryItem[] = status?.kbWorkspaces || [];
  const tokens: KbDropTokenItem[] = status?.tokens || [];
  const pendingProposals: KbColleagueProposalItem[] = (status?.proposals || []).filter(
    (p) => p.status === "pending",
  );

  function toggleNewWorkspaceSelection(wsKey: string) {
    setSelectedWorkspaces((prev) =>
      prev.includes(wsKey) ? prev.filter((x) => x !== wsKey) : [...prev, wsKey],
    );
  }

  function handleCreateColleague(e: React.FormEvent) {
    e.preventDefault();
    const passcode = passcodeDraft.trim();
    if (passcode.length < 6 || passcode.length > 64) {
      setErrorText("通行口令长度需在 6–64 位之间");
      return;
    }
    const targetWorkspaces =
      selectedWorkspaces.length > 0
        ? selectedWorkspaces
        : kbWorkspaces[0]
          ? [kbWorkspaces[0].workspaceKey]
          : [];
    if (targetWorkspaces.length === 0) {
      setErrorText("请先在任意子工作区开启至少一个知识库，再创建同事通行证");
      return;
    }
    const rawExp = expiresDraft.trim();
    let expiresInDays: number | undefined;
    if (rawExp) {
      const days = Number(rawExp);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        setErrorText("有效天数需为 1–3650 之间的正数（留空表示永久有效）");
        return;
      }
      expiresInDays = days;
    }
    dispatchOp(
      buildAssistantOpMessage("drop_token_create", {
        workspace: "",
        workspaces: targetWorkspaces,
        passcode,
        label: labelDraft.trim() || undefined,
        ...(expiresInDays !== undefined ? { expiresInDays } : {}),
        permissions: {
          kbAsk: true,
          kbDrop: true,
          kbPropose: true,
          calendarFreeBusy: calFreeBusyDraft,
          calendarPropose: calFreeBusyDraft,
        },
        ...(imTenantIdDraft.trim() ? { imTenantId: imTenantIdDraft.trim() } : {}),
      }),
    );
  }

  function handleToggleTokenWorkspace(tok: KbDropTokenItem, ws: KbWorkspaceSummaryItem) {
    const currentList =
      tok.workspaces && tok.workspaces.length > 0
        ? tok.workspaces
        : [{ workspaceId: tok.workspaceId, workspaceKey: tok.workspaceKey }];
    const hasWs = currentList.some(
      (w) => w.workspaceId === ws.workspaceId || w.workspaceKey === ws.workspaceKey,
    );
    if (hasWs && currentList.length <= 1) {
      setErrorText("至少需保留 1 个关联的知识库工作区（如需停用请点吊销）");
      return;
    }
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: tok.id,
        ...(hasWs ? { removeWorkspaces: [ws.workspaceKey] } : { addWorkspaces: [ws.workspaceKey] }),
      }),
    );
  }

  function handleToggleCalendarPerm(tok: KbDropTokenItem) {
    const nextCal = tok.permissions?.calendarFreeBusy === false;
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: tok.id,
        permissions: {
          calendarFreeBusy: nextCal,
          calendarPropose: nextCal,
        },
      }),
    );
  }

  function handleSaveImBinding(tok: KbDropTokenItem) {
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: tok.id,
        imTenantId: editImTenantId.trim() || null,
      }),
    );
  }

  function handleActivateWechat(tok: KbDropTokenItem) {
    if (!tok.wxBinding?.openId) return;
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: tok.id,
        wxOpenId: tok.wxBinding.openId,
        wxStatus: "active",
      }),
    );
  }

  function handleMakeNeverExpire(tok: KbDropTokenItem) {
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: tok.id,
        neverExpire: true,
      }),
    );
  }

  function handleGlobalRevoke(tok: KbDropTokenItem) {
    if (!window.confirm(`确定全局吊销同事「${tok.label}」的通行证吗？吊销后其网页免登、IM 与微信权限将立即失效。`)) {
      return;
    }
    dispatchOp(
      buildAssistantOpMessage("drop_token_revoke", {
        workspace: "",
        idOrLabel: tok.id,
        globalRevoke: true,
      }),
    );
  }

  function handleDecideProposal(proposalId: string, approve: boolean) {
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: "__proposal__",
        decideProposal: {
          proposalId,
          approve,
        },
      }),
    );
  }

  function copyPortalUrl() {
    const rel = status?.dropPortalPath;
    if (!rel) return;
    const fullUrl = typeof window !== "undefined" ? `${window.location.origin}${rel}` : rel;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(fullUrl).then(
        () => onNotice(`已复制门户链接：${fullUrl}`),
        () => onNotice("复制失败"),
      );
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 1. 对外门户入口栏 */}
      <section className="assistant-section">
        <div className="assistant-item-head" style={{ marginBottom: 6 }}>
          <span className="side-label" style={{ margin: 0 }}>
            对外知识库与问答门户
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" className="pill" disabled={!status?.dropPortalPath} onClick={copyPortalUrl}>
              复制链接
            </button>
            {status?.dropPortalPath ? (
              <a
                href={status.dropPortalPath}
                target="_blank"
                rel="noreferrer"
                className="pill"
                style={{ textDecoration: "none" }}
              >
                打开门户 ↗
              </a>
            ) : null}
            <button type="button" className="pill" disabled={loading} onClick={reload}>
              刷新
            </button>
          </div>
        </div>
        <div className="loop-meta">
          同事打开 <code>{status?.dropPortalPath || "门户链接"}</code> 输入一次通行口令后自动记住登录态，可跨获权知识库问答、查你的脱敏日历忙闲、发起预约或知识库更新提案。
        </div>
      </section>

      {errorText ? (
        <div className="loop-meta" style={{ color: "var(--danger, #d9534f)" }}>
          {errorText}
        </div>
      ) : null}

      {/* 2. 同事待批提案（日历预约 / 知识库更新） */}
      {pendingProposals.length > 0 ? (
        <section className="assistant-section">
          <div className="side-label">待批同事提案 · {pendingProposals.length}</div>
          <ul className="assistant-list">
            {pendingProposals.map((prop) => (
              <li key={prop.id} className="assistant-item unread">
                <div className="assistant-item-head">
                  <span className="chat-mark warn">
                    {prop.kind === "knowledge_update" ? "知识库更新" : "日历预约"}
                  </span>
                  <span className="assistant-item-title">
                    {prop.proposerName}：{prop.summary}
                  </span>
                  <button
                    type="button"
                    className="pill"
                    disabled={loading}
                    onClick={() => handleDecideProposal(prop.id, true)}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className="pill"
                    disabled={loading}
                    onClick={() => handleDecideProposal(prop.id, false)}
                  >
                    拒绝
                  </button>
                </div>
                <div className="loop-meta">
                  {prop.detail} · 来源：{prop.sourceChannel}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 3. 跨工作区同事通行证列表 */}
      <section className="assistant-section">
        <div className="side-label">同事通行证（{tokens.length}）</div>
        {tokens.length === 0 ? (
          <div className="loop-meta">
            还没有配置同事通行证。在下方新建一个口令，可同时勾选多个知识库工作区并授权日历忙闲与站内 IM。
          </div>
        ) : (
          <ul className="assistant-list">
            {tokens.map((tok) => {
              const wsList =
                tok.workspaces && tok.workspaces.length > 0
                  ? tok.workspaces
                  : [{ workspaceId: tok.workspaceId, workspaceKey: tok.workspaceKey }];
              const isEditing = editingTokenId === tok.id;
              const calAllowed = tok.permissions?.calendarFreeBusy !== false;
              return (
                <li key={tok.id} className="assistant-item">
                  <div className="assistant-item-head">
                    <span className="assistant-item-title">{tok.label}</span>
                    <span className={`chat-mark ${tok.active ? "ok" : "warn"}`}>
                      {!tok.active
                        ? "已失效"
                        : tok.expiresAt
                          ? `${new Date(tok.expiresAt).toLocaleDateString("zh-CN")} 到期`
                          : "永久有效"}
                    </span>
                    <span className="chat-mark">
                      {calAllowed ? "可查日历忙闲" : "仅知识库"}
                    </span>
                    {tok.imTenantId ? <span className="chat-mark">IM:{tok.imTenantId}</span> : null}
                    {tok.wxBinding?.status === "active" ? (
                      <span className="chat-mark ok">微信已绑</span>
                    ) : tok.wxBinding?.status === "pending_owner" ? (
                      <button
                        type="button"
                        className="pill"
                        disabled={loading}
                        onClick={() => handleActivateWechat(tok)}
                      >
                        确认激活微信
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="pill"
                      onClick={() => {
                        if (isEditing) {
                          setEditingTokenId(null);
                        } else {
                          setEditingTokenId(tok.id);
                          setEditImTenantId(tok.imTenantId || "");
                        }
                      }}
                    >
                      {isEditing ? "收起" : "配置权限"}
                    </button>
                    <button
                      type="button"
                      className="pill"
                      disabled={loading}
                      onClick={() => handleGlobalRevoke(tok)}
                    >
                      吊销
                    </button>
                  </div>
                  <div className="loop-meta">
                    获权知识库：{wsList.map((w) => w.workspaceKey).join(" 、 ")} · ID: {tok.id}
                  </div>

                  {isEditing ? (
                    <div
                      style={{
                        marginTop: 8,
                        paddingTop: 8,
                        borderTop: "1px solid var(--line)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        fontSize: 12,
                      }}
                    >
                      <div>
                        <div className="loop-meta" style={{ marginBottom: 4 }}>
                          勾选允许该同事访问的知识库工作区：
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {kbWorkspaces.map((ws) => {
                            const checked = wsList.some(
                              (w) =>
                                w.workspaceId === ws.workspaceId || w.workspaceKey === ws.workspaceKey,
                            );
                            return (
                              <button
                                key={ws.workspaceId}
                                type="button"
                                className={`pill${checked ? " on" : ""}`}
                                disabled={loading}
                                onClick={() => handleToggleTokenWorkspace(tok, ws)}
                              >
                                {checked ? "✓ " : "+ "}
                                {ws.workspaceKey}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="loop-actions" style={{ alignItems: "center" }}>
                        <button
                          type="button"
                          className={`pill${calAllowed ? " on" : ""}`}
                          disabled={loading}
                          onClick={() => handleToggleCalendarPerm(tok)}
                        >
                          {calAllowed ? "✓ 已允许查日历忙闲与发起提案" : "开启日历忙闲与提案权限"}
                        </button>
                        {tok.expiresAt ? (
                          <button
                            type="button"
                            className="pill"
                            disabled={loading}
                            onClick={() => handleMakeNeverExpire(tok)}
                          >
                            设为永久不过期
                          </button>
                        ) : null}
                      </div>

                      <div className="assistant-inline-form">
                        <input
                          className="side-input"
                          style={{ maxWidth: 200 }}
                          value={editImTenantId}
                          onChange={(e) => setEditImTenantId(e.target.value)}
                          placeholder="绑定站内 IM 账号 ID（留空解绑）"
                        />
                        <button
                          type="button"
                          className="pill"
                          disabled={loading}
                          onClick={() => handleSaveImBinding(tok)}
                        >
                          保存 IM 绑定
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 4. 新增跨工作区同事通行证 */}
      <section className="assistant-section">
        <div className="side-label">+ 新增跨工作区同事通行证</div>
        {kbWorkspaces.length === 0 ? (
          <div className="loop-meta">
            提示：请先进入任意一个子工作区的「管理 → 知识库」开启知识库分类，之后即可在此为同事统一分配跨工作区通行证。
          </div>
        ) : (
          <form onSubmit={handleCreateColleague} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="assistant-inline-form">
              <input
                className="side-input"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
                placeholder="同事称呼/部门（如：王明-风控）"
              />
              <input
                type="password"
                className="side-input"
                value={passcodeDraft}
                onChange={(e) => setPasscodeDraft(e.target.value)}
                placeholder="设置 6–64 位通行口令"
              />
              <input
                type="number"
                className="side-input"
                style={{ maxWidth: 110 }}
                value={expiresDraft}
                onChange={(e) => setExpiresDraft(e.target.value)}
                placeholder="永久有效"
                title="有效天数（默认留空为永久有效不过期）"
              />
            </div>

            <div>
              <div className="loop-meta" style={{ marginBottom: 4 }}>
                授权访问的知识库工作区（可多选）：
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {kbWorkspaces.map((ws) => {
                  const checked = selectedWorkspaces.includes(ws.workspaceKey);
                  return (
                    <button
                      key={ws.workspaceId}
                      type="button"
                      className={`pill${checked ? " on" : ""}`}
                      onClick={() => toggleNewWorkspaceSelection(ws.workspaceKey)}
                    >
                      {checked ? "✓ " : ""}
                      {ws.workspaceKey}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="assistant-inline-form" style={{ alignItems: "center" }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={calFreeBusyDraft}
                  onChange={(e) => setCalFreeBusyDraft(e.target.checked)}
                />
                允许查日历忙闲与发起变更提案
              </label>
              <input
                className="side-input"
                style={{ maxWidth: 180 }}
                value={imTenantIdDraft}
                onChange={(e) => setImTenantIdDraft(e.target.value)}
                placeholder="关联站内 IM 账号（选填）"
              />
              <button type="submit" className="new-chat primary" disabled={loading}>
                添加同事通行证
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
