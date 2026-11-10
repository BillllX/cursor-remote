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
  WxQrCodeStartData,
  WxQrCodeStatusData,
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

  // 微信 iLink 扫码绑定弹窗状态（支持为指定同事生成绑定码，或绑定主人自己的微信）
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrTargetMode, setQrTargetMode] = useState<"owner_colleague" | "owner_self">("owner_colleague");
  const [qrTargetTokenId, setQrTargetTokenId] = useState<string>("");
  const [qrTargetLabel, setQrTargetLabel] = useState<string>("");
  const [qrStartData, setQrStartData] = useState<WxQrCodeStartData | null>(null);
  const [qrStatusData, setQrStatusData] = useState<WxQrCodeStatusData | null>(null);
  const [qrVerifyCode, setQrVerifyCode] = useState("");

  const pendingReqIdsRef = useRef(new Set<string>());
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeQrSessionIdRef = useRef<string>("");

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      activeQrSessionIdRef.current = "";
      clearPollTimer();
    };
  }, [clearPollTimer]);

  const dispatchOp = useCallback(
    (message: ClientMessage, silent = false) => {
      if (message.type !== "assistant_op" || !message.reqId) return;
      pendingReqIdsRef.current.add(message.reqId);
      if (!silent) {
        setLoading(true);
        setErrorText("");
      }
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

  const pollQrStatus = useCallback(
    (qrSessionId: string, verifyCode?: string) => {
      clearPollTimer();
      dispatchOp(
        buildAssistantOpMessage("drop_token_update", {
          workspace: "",
          tokenId: qrTargetTokenId || "__owner__",
          wxQrAction: {
            kind: "status",
            qrSessionId,
            ...(verifyCode ? { verifyCode } : {}),
          },
        }),
        true,
      );
    },
    [clearPollTimer, dispatchOp, qrTargetTokenId],
  );

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

    if (data.wxQrStart) {
      if (!qrModalOpen) return;
      activeQrSessionIdRef.current = data.wxQrStart.qrSessionId;
      setQrStartData(data.wxQrStart);
      setQrStatusData({
        qrSessionId: data.wxQrStart.qrSessionId,
        tokenId: data.wxQrStart.tokenId,
        status: "wait",
        message: "请使用手机微信扫描上方二维码并点击「确认连接」（可截图发给同事扫码）",
      });
      clearPollTimer();
      pollTimerRef.current = setTimeout(() => {
        pollQrStatus(data.wxQrStart!.qrSessionId);
      }, 2200);
      return;
    }

    if (data.wxQrStatus) {
      if (!qrModalOpen || data.wxQrStatus.qrSessionId !== activeQrSessionIdRef.current) return;
      setQrStatusData(data.wxQrStatus);
      const st = data.wxQrStatus.status;
      if (st === "confirmed") {
        clearPollTimer();
        onNotice(data.wxQrStatus.message || "微信扫码绑定成功！");
      } else if (st === "expired" || st === "verify_code_blocked") {
        clearPollTimer();
      } else if (st !== "need_verifycode" && qrModalOpen) {
        clearPollTimer();
        pollTimerRef.current = setTimeout(() => {
          pollQrStatus(data.wxQrStatus!.qrSessionId);
        }, 2200);
      }
      return;
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
  }, [lastResult, resultTick, onNotice, selectedWorkspaces.length, clearPollTimer, pollQrStatus, qrModalOpen]);

  const kbWorkspaces: KbWorkspaceSummaryItem[] = status?.kbWorkspaces || [];
  const tokens: KbDropTokenItem[] = status?.tokens || [];
  const pendingProposals: KbColleagueProposalItem[] = (status?.proposals || []).filter((p) => p.status === "pending");
  const ownerWx = status?.ownerWx;

  function openWechatQrModal(mode: "owner_colleague" | "owner_self", tok?: KbDropTokenItem) {
    clearPollTimer();
    activeQrSessionIdRef.current = "";
    const targetId = mode === "owner_self" ? "__owner__" : tok?.id || "";
    const label = mode === "owner_self" ? "主人微信（接收审批通知）" : tok?.label || "同事";
    setQrTargetMode(mode);
    setQrTargetTokenId(targetId);
    setQrTargetLabel(label);
    setQrStartData(null);
    setQrStatusData(null);
    setQrVerifyCode("");
    setQrModalOpen(true);

    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: targetId,
        wxQrAction: {
          kind: "start",
          mode,
          tokenId: targetId,
        },
      }),
    );
  }

  function closeWechatQrModal() {
    clearPollTimer();
    activeQrSessionIdRef.current = "";
    setQrModalOpen(false);
    setQrStartData(null);
    setQrStatusData(null);
  }

  function handleUnbindOwnerWx() {
    if (!window.confirm("确定解绑主人微信通知通道吗？")) return;
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: "__owner__",
        wxQrAction: {
          kind: "unbind_owner",
        },
      }),
    );
  }

  function handleUnbindColleagueWx(tok: KbDropTokenItem) {
    if (!window.confirm(`确定解绑同事「${tok.label}」的微信通道吗？`)) return;
    dispatchOp(
      buildAssistantOpMessage("drop_token_update", {
        workspace: "",
        tokenId: tok.id,
        wxOpenId: null,
      }),
    );
  }

  function toggleNewWorkspaceSelection(wsKey: string) {
    setSelectedWorkspaces((prev) => (prev.includes(wsKey) ? prev.filter((x) => x !== wsKey) : [...prev, wsKey]));
  }

  function handleCreateColleague(e: React.FormEvent) {
    e.preventDefault();
    const passcode = passcodeDraft.trim();
    if (passcode.length < 6 || passcode.length > 64) {
      setErrorText("通行口令长度需在 6–64 位之间");
      return;
    }
    const targetWorkspaces =
      selectedWorkspaces.length > 0 ? selectedWorkspaces : kbWorkspaces[0] ? [kbWorkspaces[0].workspaceKey] : [];
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
    const hasWs = currentList.some((w) => w.workspaceId === ws.workspaceId || w.workspaceKey === ws.workspaceKey);
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
      {/* 1. 对外门户入口栏 & 主人微信绑定入口 */}
      <section className="assistant-section">
        <div className="assistant-item-head" style={{ marginBottom: 6 }}>
          <span className="side-label" style={{ margin: 0 }}>
            对外知识库门户 & 微信通道
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="pill"
              disabled={loading}
              onClick={() => openWechatQrModal("owner_self")}
              title="扫码绑定主人自己的微信，在微信内接收审批单并回复『批准』"
            >
              {ownerWx?.openId ? "📲 重绑主人微信" : "📲 绑定主人微信"}
            </button>
            {ownerWx?.openId ? (
              <button type="button" className="pill" disabled={loading} onClick={handleUnbindOwnerWx}>
                解绑主人微信
              </button>
            ) : null}
            <button type="button" className="pill" disabled={!status?.dropPortalPath} onClick={copyPortalUrl}>
              复制门户链接
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
          同事可打开 <code>{status?.dropPortalPath || "门户链接"}</code> 免登问答，或点击下方卡片的「📲
          生成微信绑定码」直接用微信扫码与小驳直连收发消息。
          {ownerWx?.openId ? (
            <span>
              {" "}
              · 主人微信已绑定：<code>{ownerWx.openId}</code>
            </span>
          ) : null}
        </div>
      </section>

      {/* 微信扫码绑定模态框 */}
      {qrModalOpen ? (
        <section
          className="assistant-section"
          style={{
            border: "1px solid var(--accent, #2f6b52)",
            background: "var(--fill-quaternary, rgba(47, 107, 82, 0.06))",
            padding: 14,
            borderRadius: 10,
          }}
        >
          <div className="assistant-item-head" style={{ marginBottom: 8 }}>
            <span className="assistant-item-title">📲 微信官方 iLink 扫码绑定 · {qrTargetLabel}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="pill"
                disabled={loading}
                onClick={() => {
                  const tok = tokens.find((t) => t.id === qrTargetTokenId);
                  openWechatQrModal(qrTargetMode, tok);
                }}
              >
                🔄 刷新二维码
              </button>
              <button type="button" className="pill" onClick={closeWechatQrModal}>
                关闭
              </button>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            {qrStartData?.qrSvgDataUrl ? (
              <img
                src={qrStartData.qrSvgDataUrl}
                alt="微信绑定二维码"
                style={{
                  width: 180,
                  height: 180,
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  background: "#ffffff",
                  padding: 6,
                }}
              />
            ) : (
              <div
                style={{
                  width: 180,
                  height: 180,
                  borderRadius: 8,
                  border: "1px dashed var(--line)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  color: "var(--muted)",
                }}
              >
                正在拉取微信二维码…
              </div>
            )}

            <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="loop-meta" style={{ fontSize: 13, color: "var(--ink)" }}>
                {qrStatusData?.message || "正在向腾讯 iLink 申请微信官方 ClawBot 绑定二维码…"}
              </div>
              <div className="loop-meta">
                {qrTargetMode === "owner_self"
                  ? "请用您本人的手机微信扫一扫，确认后即可在微信里接收同事提案通知并直接回复「批准」。"
                  : `您可以直接截图此二维码发给「${qrTargetLabel}」在微信里长按识别，或让对方当面扫码；扫码确认后将直接激活绑定到 ${qrTargetTokenId}。`}
              </div>

              {qrStatusData?.status === "need_verifycode" && qrStartData ? (
                <div className="assistant-inline-form">
                  <input
                    className="side-input"
                    style={{ maxWidth: 180 }}
                    value={qrVerifyCode}
                    onChange={(e) => setQrVerifyCode(e.target.value)}
                    placeholder="输入手机微信显示的6位验证码"
                  />
                  <button
                    type="button"
                    className="pill on"
                    onClick={() => {
                      const code = qrVerifyCode.trim();
                      if (!code) return;
                      setQrVerifyCode("");
                      pollQrStatus(qrStartData.qrSessionId, code);
                    }}
                  >
                    提交验证码
                  </button>
                </div>
              ) : null}

              {qrStartData?.qrcodeImgContent ? (
                <div className="loop-meta" style={{ wordBreak: "break-all" }}>
                  备用扫码链接：<code>{qrStartData.qrcodeImgContent}</code>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

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
                  <span className="chat-mark warn">{prop.kind === "knowledge_update" ? "知识库更新" : "日历预约"}</span>
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
                    <span className="chat-mark">{calAllowed ? "可查日历忙闲" : "仅知识库"}</span>
                    {tok.imTenantId ? <span className="chat-mark">IM:{tok.imTenantId}</span> : null}
                    {tok.wxBinding?.status === "active" ? (
                      <span className="chat-mark ok" title={tok.wxBinding.openId || ""}>
                        微信已绑
                      </span>
                    ) : tok.wxBinding?.status === "pending_owner" ? (
                      <button
                        type="button"
                        className="pill on"
                        disabled={loading}
                        onClick={() => handleActivateWechat(tok)}
                        title={`待确认微信 ID: ${tok.wxBinding.openId || ""}`}
                      >
                        ✓ 确认激活微信
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="pill"
                      disabled={loading}
                      onClick={() => openWechatQrModal("owner_colleague", tok)}
                      title="生成该同事专属的微信官方扫码绑定二维码（扫码确认即直接激活）"
                    >
                      {tok.wxBinding?.status === "active" ? "📲 重绑微信码" : "📲 生成微信绑定码"}
                    </button>
                    {tok.wxBinding?.status === "active" ? (
                      <button
                        type="button"
                        className="pill"
                        disabled={loading}
                        onClick={() => handleUnbindColleagueWx(tok)}
                      >
                        解绑微信
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
                    <button type="button" className="pill" disabled={loading} onClick={() => handleGlobalRevoke(tok)}>
                      吊销
                    </button>
                  </div>
                  <div className="loop-meta">
                    获权知识库：{wsList.map((w) => w.workspaceKey).join(" 、 ")} · ID: {tok.id}
                    {tok.wxBinding?.openId ? ` · 微信: ${tok.wxBinding.openId}` : ""}
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
                              (w) => w.workspaceId === ws.workspaceId || w.workspaceKey === ws.workspaceKey,
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
