// 工作区知识库与投递口令可视化管理面板（嵌入在工作区侧栏「管理」中）
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantResultMessage,
  ClientMessage,
  KbWorkspaceStatusData,
  WxQrCodeStartData,
  WxQrCodeStatusData,
} from "@shared/protocol";
import { buildAssistantOpMessage } from "@shared/assistantOp";
import { FileGlyph } from "../FileTree";

type WorkspaceKbPanelProps = {
  workspaceKey: string;
  workspaceName: string;
  workspacePath: string;
  send: (message: ClientMessage) => void;
  assistantResults: AssistantResultMessage[];
  onOpenBoard: (relPath: string) => void;
  setNotice: (msg: string) => void;
};

export function WorkspaceKbPanel({
  workspaceKey,
  workspaceName,
  workspacePath,
  send,
  assistantResults,
  onOpenBoard,
  setNotice,
}: WorkspaceKbPanelProps) {
  const [status, setStatus] = useState<KbWorkspaceStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");

  // 知识库初始化/编辑分类表单
  const [editingKb, setEditingKb] = useState(false);
  const [kbTitleDraft, setKbTitleDraft] = useState("");
  const [kbCategoriesDraft, setKbCategoriesDraft] = useState("");

  // 新增投递口令表单（默认留空表示永久不过期）
  const [passcodeDraft, setPasscodeDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [expiresDraft, setExpiresDraft] = useState("");
  const [calFreeBusyDraft, setCalFreeBusyDraft] = useState(true);
  const [imTenantIdDraft, setImTenantIdDraft] = useState("");
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrTargetTokenId, setQrTargetTokenId] = useState("");
  const [qrTargetLabel, setQrTargetLabel] = useState("");
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

  const sendKbOperation = useCallback(
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

  const pollQrStatus = useCallback(
    (qrSessionId: string, verifyCode?: string) => {
      clearPollTimer();
      sendKbOperation(
        buildAssistantOpMessage("drop_token_update", {
          workspace: workspaceKey,
          tokenId: qrTargetTokenId,
          wxQrAction: {
            kind: "status",
            qrSessionId,
            ...(verifyCode ? { verifyCode } : {}),
          },
        }),
        true,
      );
    },
    [clearPollTimer, qrTargetTokenId, sendKbOperation, workspaceKey],
  );

  useEffect(() => {
    if (!workspaceKey) return;
    clearPollTimer();
    activeQrSessionIdRef.current = "";
    setQrModalOpen(false);
    setQrStartData(null);
    setQrStatusData(null);
    setQrVerifyCode("");
    pendingReqIdsRef.current.clear();
    setStatus(null);
    sendKbOperation(buildAssistantOpMessage("kb_workspace_status", { workspace: workspaceKey }));
  }, [workspaceKey, sendKbOperation, clearPollTimer]);

  useEffect(() => {
    let consumed = false;
    for (const result of assistantResults) {
      if (!result.reqId || !pendingReqIdsRef.current.delete(result.reqId)) continue;
      consumed = true;
      const op = result.op;
      if (
        op !== "kb_workspace_status" &&
        op !== "kb_workspace_init" &&
        op !== "drop_token_create" &&
        op !== "drop_token_update" &&
        op !== "drop_token_revoke"
      ) {
        continue;
      }
      if (!result.ok) {
        setErrorText(result.error || "操作失败");
        continue;
      }
      const data = result.data as KbWorkspaceStatusData | undefined;
      if (!data || data.workspaceKey !== workspaceKey) continue;
      setStatus(data);
      setErrorText("");
      setKbTitleDraft(data.title || `${workspaceName} 知识库`);
      setKbCategoriesDraft((data.allowedCategories || ["资金", "资产", "牌照"]).join("、"));

      if (data.wxQrStart) {
        if (!qrModalOpen) continue;
        activeQrSessionIdRef.current = data.wxQrStart.qrSessionId;
        setQrStartData(data.wxQrStart);
        setQrStatusData({
          qrSessionId: data.wxQrStart.qrSessionId,
          tokenId: data.wxQrStart.tokenId,
          status: "wait",
          message: "等待微信扫码确认…",
        });
        clearPollTimer();
        pollTimerRef.current = setTimeout(() => {
          pollQrStatus(data.wxQrStart!.qrSessionId);
        }, 2200);
        continue;
      }

      if (data.wxQrStatus) {
        if (!qrModalOpen || data.wxQrStatus.qrSessionId !== activeQrSessionIdRef.current) continue;
        setQrStatusData(data.wxQrStatus);
        const st = data.wxQrStatus.status;
        if (st === "confirmed") {
          clearPollTimer();
          setNotice(data.wxQrStatus.message || "微信扫码绑定成功！");
        } else if (st === "expired" || st === "verify_code_blocked") {
          clearPollTimer();
        } else if (st !== "need_verifycode" && qrModalOpen) {
          clearPollTimer();
          pollTimerRef.current = setTimeout(() => {
            pollQrStatus(data.wxQrStatus!.qrSessionId);
          }, 2200);
        }
        continue;
      }

      if (op === "kb_workspace_init") {
        setEditingKb(false);
        setNotice(`已启用知识库工作区：${data.title}`);
      } else if (op === "drop_token_create") {
        setPasscodeDraft("");
        setLabelDraft("");
        setImTenantIdDraft("");
        setNotice("已创建同事通行口令（默认永久有效）");
      } else if (op === "drop_token_update") {
        setNotice("已更新同事通行权限配置");
      } else if (op === "drop_token_revoke") {
        setNotice("已更新/吊销投递口令");
      }
    }
    if (consumed) setLoading(pendingReqIdsRef.current.size > 0);
  }, [assistantResults, workspaceKey, workspaceName, setNotice, clearPollTimer, pollQrStatus, qrModalOpen]);

  function handleOpenColleagueWxQr(tokenId: string, label: string) {
    clearPollTimer();
    activeQrSessionIdRef.current = "";
    setQrTargetTokenId(tokenId);
    setQrTargetLabel(label);
    setQrStartData(null);
    setQrStatusData(null);
    setQrVerifyCode("");
    setQrModalOpen(true);
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        tokenId,
        wxQrAction: {
          kind: "start",
          mode: "owner_colleague",
          tokenId,
        },
      }),
    );
  }

  function handleSaveKbConfig() {
    const title = kbTitleDraft.trim() || `${workspaceName} 知识库`;
    const categories = kbCategoriesDraft
      .split(/[,，、\s\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (categories.length === 0) {
      setErrorText("请至少填写一个一级分类目录（如：资金、资产、牌照）");
      return;
    }
    sendKbOperation(
      buildAssistantOpMessage("kb_workspace_init", {
        workspace: workspaceKey,
        title,
        categories,
      }),
    );
  }

  function handleCreateToken() {
    const passcode = passcodeDraft.trim();
    if (passcode.length < 6 || passcode.length > 64) {
      setErrorText("投递口令长度需在 6–64 位之间");
      return;
    }
    const rawExp = expiresDraft.trim();
    let expiresInDays: number | undefined;
    if (rawExp) {
      const days = Number(rawExp);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        setErrorText("有效天数需为 1–3650 之间的正数（留空表示永久不过期）");
        return;
      }
      expiresInDays = days;
    }
    sendKbOperation(
      buildAssistantOpMessage("drop_token_create", {
        workspace: workspaceKey,
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

  function handleBindExistingToken(tokenId: string) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        tokenId,
        addWorkspaces: [workspaceKey],
      }),
    );
  }

  function handleMakeNeverExpire(tokenId: string) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        tokenId,
        neverExpire: true,
      }),
    );
  }

  function handleRevokeToken(id: string, label: string, globalRevoke = false) {
    const promptMsg = globalRevoke
      ? `确定全局吊销同事通行证「${label}」吗？吊销后其所有知识库、IM 与微信权限将立即失效。`
      : `确定从当前知识库移出或吊销「${label}」吗？`;
    if (!window.confirm(promptMsg)) {
      return;
    }
    sendKbOperation(
      buildAssistantOpMessage("drop_token_revoke", {
        workspace: workspaceKey,
        idOrLabel: id,
        ...(globalRevoke ? { globalRevoke: true } : {}),
      }),
    );
  }

  function copyDropPortalUrl() {
    const rel = status?.dropPortalPath || "/p/default/drop";
    const fullUrl = typeof window !== "undefined" ? `${window.location.origin}${rel}` : rel;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(fullUrl).then(
        () => setNotice(`已复制投递页链接：${fullUrl}`),
        () => setNotice("复制失败"),
      );
    }
  }

  return (
    <div
      className="workspace-kb-panel"
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
      aria-label="知识库与外部投递配置"
      data-workspace-path={workspacePath}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span className="side-label" style={{ margin: 0 }}>
          知识库与投递门户
        </span>
        {status?.isKnowledgeBase ? (
          <span
            style={{
              fontSize: 11,
              padding: "1px 7px",
              borderRadius: 999,
              background: "rgba(47, 107, 82, 0.16)",
              color: "var(--accent, #2f6b52)",
              fontWeight: 600,
            }}
          >
            已标记为知识库
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>普通工作区</span>
        )}
      </div>

      {errorText ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--danger, #d9534f)",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--danger, #d9534f)",
          }}
        >
          {errorText}
        </div>
      ) : null}

      {/* 1. 转为知识库工作区 / 编辑分类白名单 */}
      {!status?.isKnowledgeBase || editingKb ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--fill-quaternary, rgba(128,128,128,0.05))",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {status?.isKnowledgeBase ? "修改知识库分类配置" : "将本工作区转为「知识库工作区」"}
          </div>
          <label style={{ fontSize: 11, color: "var(--muted)" }}>
            知识库标题
            <input
              type="text"
              className="search-input"
              style={{ marginTop: 4, padding: "5px 8px", fontSize: 12 }}
              value={kbTitleDraft}
              onChange={(e) => setKbTitleDraft(e.target.value)}
              placeholder={`${workspaceName} 知识库`}
            />
          </label>
          <label style={{ fontSize: 11, color: "var(--muted)" }}>
            一级分类目录（顿号或逗号分隔，自动建目录并写入 .jiebo/kb.json）
            <input
              type="text"
              className="search-input"
              style={{ marginTop: 4, padding: "5px 8px", fontSize: 12 }}
              value={kbCategoriesDraft}
              onChange={(e) => setKbCategoriesDraft(e.target.value)}
              placeholder="例如：资金、资产、牌照"
            />
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="new-chat primary"
              style={{ margin: 0, flex: 1, padding: "5px 10px", fontSize: 12 }}
              disabled={loading}
              onClick={handleSaveKbConfig}
            >
              {status?.isKnowledgeBase ? "保存知识库配置" : "一键转为知识库工作区"}
            </button>
            {status?.isKnowledgeBase ? (
              <button
                type="button"
                className="new-chat"
                style={{ margin: 0, padding: "5px 10px", fontSize: 12 }}
                onClick={() => setEditingKb(false)}
              >
                取消
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 12 }}>{status.title}</strong>
            <button
              type="button"
              style={{
                background: "transparent",
                border: 0,
                color: "var(--muted)",
                fontSize: 11,
                cursor: "pointer",
                padding: 0,
              }}
              onClick={() => setEditingKb(true)}
            >
              编辑分类
            </button>
          </div>
          <div style={{ color: "var(--muted)", fontSize: 11 }}>一级分类：{status.allowedCategories.join(" / ")}</div>
        </div>
      )}

      {/* 2. 知识库 HTML 看板列表（直接点击打开右侧预览） */}
      {status?.isKnowledgeBase ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="side-label" style={{ margin: 0 }}>
            知识库 HTML 看板（{status.boards.length}）
          </div>
          {status.boards.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>暂无同名 .html 看板。上传文档归档后会自动生成。</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {status.boards.map((board) => (
                <button
                  key={board.relPath}
                  type="button"
                  className="tree-file"
                  style={{ borderRadius: 6, padding: "5px 8px" }}
                  title={`点击打开预览：${board.relPath}`}
                  onClick={() => onOpenBoard(board.relPath)}
                >
                  <FileGlyph path={board.relPath} />
                  <span className="tree-file-copy">
                    <span className="tree-file-name" style={{ fontSize: 12 }}>
                      {board.title}
                    </span>
                    <span className="tree-file-path" style={{ fontSize: 11 }}>
                      {board.relPath}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* 3. 外部同事投递门户链接与投递密钥管理 */}
      {status?.isKnowledgeBase ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--line)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="side-label" style={{ margin: 0 }}>
              同事投递门户与密钥（{status.tokens.length}）
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                style={{
                  background: "transparent",
                  border: "1px solid var(--line)",
                  borderRadius: 5,
                  padding: "2px 6px",
                  fontSize: 11,
                  color: "var(--ink)",
                  cursor: "pointer",
                }}
                onClick={copyDropPortalUrl}
              >
                复制链接
              </button>
              <a
                href={status.dropPortalPath}
                target="_blank"
                rel="noreferrer"
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 5,
                  padding: "2px 6px",
                  fontSize: 11,
                  color: "var(--ink)",
                  textDecoration: "none",
                }}
              >
                打开投递页 ↗
              </a>
            </div>
          </div>

          {status.tokens.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {status.tokens.map((tok) => {
                const wsCount = tok.workspaces && tok.workspaces.length > 0 ? tok.workspaces.length : 1;
                return (
                  <div
                    key={tok.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 6,
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--line)",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {tok.label}
                        {wsCount > 1 ? `（共 ${wsCount} 个知识库）` : ""}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--muted)" }}>
                        ID: {tok.id}
                        {tok.expiresAt
                          ? ` · 有效期至 ${new Date(tok.expiresAt).toLocaleDateString("zh-CN")}`
                          : " · 永久有效"}
                        {tok.permissions?.calendarFreeBusy !== false ? " · 可查忙闲/预约" : ""}
                        {tok.imTenantId ? ` · IM:${tok.imTenantId}` : ""}
                        {tok.wxBinding?.status === "active" ? " · 微信已绑" : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flex: "none" }}>
                      <button
                        type="button"
                        style={{
                          background: "transparent",
                          border: "1px solid var(--line)",
                          borderRadius: 5,
                          padding: "2px 6px",
                          fontSize: 11,
                          color: "var(--ink)",
                          cursor: "pointer",
                        }}
                        title="生成微信扫码绑定二维码"
                        onClick={() => handleOpenColleagueWxQr(tok.id, tok.label)}
                      >
                        📲 微信码
                      </button>
                      {tok.expiresAt ? (
                        <button
                          type="button"
                          style={{
                            background: "transparent",
                            border: "1px solid var(--line)",
                            borderRadius: 5,
                            padding: "2px 6px",
                            fontSize: 11,
                            color: "var(--ink)",
                            cursor: "pointer",
                          }}
                          title="改为永久不过期"
                          onClick={() => handleMakeNeverExpire(tok.id)}
                        >
                          设为永不过期
                        </button>
                      ) : null}
                      <button
                        type="button"
                        style={{
                          background: "transparent",
                          border: "1px solid var(--line)",
                          borderRadius: 5,
                          padding: "2px 6px",
                          fontSize: 11,
                          color: "var(--danger, #d9534f)",
                          cursor: "pointer",
                        }}
                        onClick={() => handleRevokeToken(tok.id, tok.label, false)}
                      >
                        {wsCount > 1 ? "移出本库" : "吊销"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              尚未配置投递口令。在下方创建一个口令发给同事，同事登录一次后将自动记住状态无缝进入。
            </div>
          )}

          {qrModalOpen ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: 10,
                borderRadius: 8,
                border: "1px solid var(--accent, #2f6b52)",
                background: "var(--fill-quaternary, rgba(47, 107, 82, 0.06))",
                fontSize: 11,
                textAlign: "center",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
                <strong>📲 微信绑定码 · {qrTargetLabel}</strong>
                <button
                  type="button"
                  style={{ background: "transparent", border: 0, cursor: "pointer", fontSize: 11, color: "var(--muted)" }}
                  onClick={() => {
                    clearPollTimer();
                    activeQrSessionIdRef.current = "";
                    setQrModalOpen(false);
                  }}
                >
                  关闭
                </button>
              </div>
              {qrStartData?.qrSvgDataUrl ? (
                <img
                  src={qrStartData.qrSvgDataUrl}
                  alt="微信二维码"
                  style={{ width: 150, height: 150, borderRadius: 6, background: "#fff", padding: 4 }}
                />
              ) : (
                <div style={{ padding: 20, color: "var(--muted)" }}>正在获取微信二维码…</div>
              )}
              <div style={{ color: "var(--muted)" }}>
                {qrStatusData?.message || "截图发给同事扫码确认即自动激活"}
              </div>
              {qrStatusData?.status === "need_verifycode" && qrStartData ? (
                <div style={{ display: "flex", gap: 6, width: "100%", justifyContent: "center", marginTop: 4 }}>
                  <input
                    type="text"
                    className="search-input"
                    style={{ padding: "4px 6px", fontSize: 11, margin: 0, width: 130 }}
                    placeholder="手机6位验证码"
                    value={qrVerifyCode}
                    onChange={(e) => setQrVerifyCode(e.target.value)}
                  />
                  <button
                    type="button"
                    className="new-chat primary"
                    style={{ margin: 0, padding: "4px 8px", fontSize: 11 }}
                    onClick={() => {
                      const code = qrVerifyCode.trim();
                      if (!code) return;
                      setQrVerifyCode("");
                      pollQrStatus(qrStartData.qrSessionId, code);
                    }}
                  >
                    提交
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 将其他知识库已有的同事口令一键授权到本知识库 */}
          {status.otherTokens && status.otherTokens.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: 8,
                borderRadius: 8,
                border: "1px dashed var(--line)",
                fontSize: 11,
              }}
            >
              <div style={{ fontWeight: 600, color: "var(--muted)" }}>
                将已有同事通行证加入本知识库（同一口令跨库通用）：
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {status.otherTokens.map((ot) => (
                  <button
                    key={ot.id}
                    type="button"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--line)",
                      borderRadius: 5,
                      padding: "3px 7px",
                      fontSize: 11,
                      color: "var(--ink)",
                      cursor: "pointer",
                    }}
                    disabled={loading}
                    onClick={() => handleBindExistingToken(ot.id)}
                  >
                    + 授权「{ot.label}」访问本库
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* 新增口令表单 */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 8,
              borderRadius: 8,
              border: "1px solid var(--line)",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600 }}>+ 新增同事通行证（口令）</div>
            <input
              type="password"
              className="search-input"
              style={{ padding: "5px 8px", fontSize: 12, margin: 0 }}
              placeholder="设置 6–64 位投递口令（如 fintopia-2026）"
              value={passcodeDraft}
              onChange={(e) => setPasscodeDraft(e.target.value)}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                className="search-input"
                style={{ padding: "5px 8px", fontSize: 12, margin: 0, flex: 1 }}
                placeholder="同事称呼/备注（如：王明-风控）"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
              />
              <input
                type="number"
                className="search-input"
                style={{ padding: "5px 8px", fontSize: 12, margin: 0, width: 88 }}
                placeholder="永久有效"
                title="有效天数（默认留空为永久有效不过期）"
                value={expiresDraft}
                onChange={(e) => setExpiresDraft(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "var(--muted)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={calFreeBusyDraft}
                  onChange={(e) => setCalFreeBusyDraft(e.target.checked)}
                />
                允许查日历忙闲与发起变更提案
              </label>
              <input
                type="text"
                className="search-input"
                style={{ padding: "3px 6px", fontSize: 11, margin: 0, width: 115 }}
                placeholder="站内IM账号(可选)"
                value={imTenantIdDraft}
                onChange={(e) => setImTenantIdDraft(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="new-chat primary"
              style={{ margin: 0, padding: "5px 10px", fontSize: 12 }}
              disabled={loading}
              onClick={handleCreateToken}
            >
              创建同事通行口令
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
