// 工作区知识库与投递口令可视化管理面板（嵌入在工作区侧栏「管理」中）
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantResultMessage,
  ClientMessage,
  KbWecomWatchedItemSummary,
  KbWorkspaceIngestLogItem,
  KbWorkspaceStatusData,
  WxQrCodeStartData,
  WxQrCodeStatusData,
} from "@shared/protocol";
import { buildAssistantOpMessage } from "@shared/assistantOp";
import { FileGlyph } from "../FileTree";
import { WorkspaceScheduleSection } from "./WorkspaceScheduleSection";

const WECOM_SOURCE_TYPE_LABELS: Record<KbWecomWatchedItemSummary["sourceType"], string> = {
  sheet: "在线表格",
  smartsheet: "智能表格",
  doc: "在线文档",
  smartpage: "智能文档",
  disk_file: "微盘文件",
};

function formatShortTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  try {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "—";
  }
}

type WorkspaceKbPanelProps = {
  workspaceKey: string;
  workspaceName: string;
  workspacePath: string;
  send: (message: ClientMessage) => void;
  assistantResults: AssistantResultMessage[];
  onOpenBoard: (relPath: string) => void;
  setNotice: (msg: string) => void;
  viewMode?: "kb" | "schedules" | "tokens" | "all";
};

export function WorkspaceKbPanel({
  workspaceKey,
  workspaceName,
  workspacePath,
  send,
  assistantResults,
  onOpenBoard,
  setNotice,
  viewMode = "all",
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

  // 企微关注文件新增表单与预览展开状态
  const [addingWatch, setAddingWatch] = useState(false);
  const [watchTitleDraft, setWatchTitleDraft] = useState("");
  const [watchDocOrUrlDraft, setWatchDocOrUrlDraft] = useState("");
  const [watchSourceTypeDraft, setWatchSourceTypeDraft] = useState<KbWecomWatchedItemSummary["sourceType"]>("sheet");
  const [watchSheetDraft, setWatchSheetDraft] = useState("");
  const [watchNoteDraft, setWatchNoteDraft] = useState("");
  const [expandedWatchPreviewIds, setExpandedWatchPreviewIds] = useState<Record<string, boolean>>({});
  const [expandedLogBatchIds, setExpandedLogBatchIds] = useState<Record<string, boolean>>({});

  const pendingReqIdsRef = useRef(new Set<string>());
  const silentReqIdsRef = useRef(new Set<string>());
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
      if (silent) {
        silentReqIdsRef.current.add(message.reqId);
      } else {
        pendingReqIdsRef.current.add(message.reqId);
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
    setEditingKb(false);
    setAddingWatch(false);
    setWatchTitleDraft("");
    setWatchDocOrUrlDraft("");
    setWatchSheetDraft("");
    setWatchNoteDraft("");
    setExpandedWatchPreviewIds({});
    setExpandedLogBatchIds({});
    pendingReqIdsRef.current.clear();
    setStatus(null);
    sendKbOperation(buildAssistantOpMessage("kb_workspace_status", { workspace: workspaceKey }));
  }, [workspaceKey, sendKbOperation, clearPollTimer]);

  useEffect(() => {
    let consumed = false;
    for (const result of assistantResults) {
      const isSilent = Boolean(result.reqId && silentReqIdsRef.current.delete(result.reqId));
      const isExplicit = Boolean(result.reqId && pendingReqIdsRef.current.delete(result.reqId));
      if (!isSilent && !isExplicit) continue;
      if (isExplicit) consumed = true;
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
        if (!isSilent) setErrorText(result.error || "操作失败");
        continue;
      }
      const data = result.data as KbWorkspaceStatusData | undefined;
      if (!data || data.workspaceKey !== workspaceKey) continue;
      setStatus(data);
      if (!isSilent) setErrorText("");
      if (!editingKb) {
        setKbTitleDraft(data.title || `${workspaceName} 知识库`);
        setKbCategoriesDraft((data.allowedCategories || ["资金", "资产", "牌照"]).join("、"));
      }

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
        if (data.workspaceScheduleResult) {
          setNotice(data.workspaceScheduleResult.message);
        } else if (data.wecomWatchResult) {
          setNotice(data.wecomWatchResult.message);
          if (data.wecomWatchResult.action === "add") {
            setAddingWatch(false);
            setWatchTitleDraft("");
            setWatchDocOrUrlDraft("");
            setWatchSheetDraft("");
            setWatchNoteDraft("");
          }
        } else {
          setNotice("已更新知识库与通行配置");
        }
      } else if (op === "drop_token_revoke") {
        setNotice("已更新/吊销投递口令");
      }
    }
    if (consumed) setLoading(pendingReqIdsRef.current.size > 0);
  }, [assistantResults, workspaceKey, workspaceName, setNotice, clearPollTimer, pollQrStatus, qrModalOpen, editingKb]);

  const hasActiveIngestJob = Boolean(
    status?.ingestLogs?.some((item) => item.status === "queued" || item.status === "processing") ||
      status?.workspaceSchedules?.some((item) => item.state !== "idle"),
  );

  // 当存在排队或正在后台归档的任务时，每 3.5 秒静默刷新一次面板状态，以便实时看到归档完成后的更新内容与看板
  useEffect(() => {
    if (!workspaceKey || !hasActiveIngestJob) return;
    const timer = setInterval(() => {
      sendKbOperation(buildAssistantOpMessage("kb_workspace_status", { workspace: workspaceKey }), true);
    }, 3500);
    return () => clearInterval(timer);
  }, [workspaceKey, hasActiveIngestJob, sendKbOperation]);

  function handleCheckWecomWatch(idOrTitle?: string) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        wecomWatchAction: {
          kind: "check",
          ...(idOrTitle ? { idOrTitle } : {}),
        },
      }),
    );
  }

  function handleSyncWecomWatch(idOrTitle?: string, forceSync = false) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        wecomWatchAction: {
          kind: "sync",
          ...(idOrTitle ? { idOrTitle } : {}),
          ...(forceSync ? { forceSync: true } : {}),
        },
      }),
    );
  }

  function handleAddWecomWatch() {
    const title = watchTitleDraft.trim();
    const rawRef = watchDocOrUrlDraft.trim();
    if (!title) {
      setErrorText("请填写关注文件名称（如：保证金跟进）");
      return;
    }
    if (!rawRef) {
      setErrorText("请粘贴企业微信文档链接或填写 docId / fileId");
      return;
    }
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        wecomWatchAction: {
          kind: "add",
          title,
          sourceType: watchSourceTypeDraft,
          ...(watchSourceTypeDraft === "disk_file" && !/^https?:\/\//i.test(rawRef)
            ? { fileId: rawRef }
            : { docId: rawRef }),
          ...(watchSheetDraft.trim() ? { sheet: watchSheetDraft.trim() } : {}),
          ...(watchNoteDraft.trim() ? { note: watchNoteDraft.trim() } : {}),
        },
      }),
    );
  }

  function handleRemoveWecomWatch(id: string, title: string) {
    if (!window.confirm(`确定从本知识库关注列表中移除《${title}》吗？`)) {
      return;
    }
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        wecomWatchAction: {
          kind: "remove",
          idOrTitle: id,
        },
      }),
    );
  }

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

  function handleToggleBoardDropVisibility(boardRelPath: string, showOnDrop: boolean) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        dropBoardsAction: {
          kind: "set_visibility",
          boardRelPath,
          showOnDrop,
        },
      }),
    );
  }

  function handleSetAllBoardsDropVisibility(showAll: boolean) {
    if (!status) return;
    const hiddenDropBoards = showAll ? [] : status.boards.map((b) => b.relPath);
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        dropBoardsAction: {
          kind: "set_visibility",
          hiddenDropBoards,
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

  const showKbSection = viewMode === "all" || viewMode === "kb";
  const showSchedulesSection = viewMode === "all" || viewMode === "schedules";
  const showTokensSection = viewMode === "all" || viewMode === "tokens";

  return (
    <div
      className="workspace-kb-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
      aria-label="知识库与自动化配置"
      data-workspace-path={workspacePath}
    >
      {showKbSection ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span className="side-label" style={{ margin: 0 }}>
            知识库与业务看板
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
      ) : null}

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
      {showKbSection && (!status?.isKnowledgeBase || editingKb) ? (
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
      ) : showKbSection && status ? (
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
      ) : null}

      {/* 2. 知识库 HTML 看板列表（支持直接打开右侧预览，并勾选哪些看板在 Drop 页面向外部访客展示） */}
      {showKbSection && status?.isKnowledgeBase ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="side-label" style={{ margin: 0 }}>
                知识库 HTML 看板（{status.boards.length}）
              </span>
              {status.boards.length > 0 ? (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  Drop 页展示 {status.boards.filter((b) => b.showOnDrop !== false).length} / {status.boards.length}
                </span>
              ) : null}
            </div>
            {status.boards.length > 1 ? (
              <div style={{ display: "flex", gap: 4 }}>
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
                  disabled={loading || status.boards.every((b) => b.showOnDrop !== false)}
                  onClick={() => handleSetAllBoardsDropVisibility(true)}
                >
                  全部展示
                </button>
                <button
                  type="button"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--line)",
                    borderRadius: 5,
                    padding: "2px 6px",
                    fontSize: 11,
                    color: "var(--muted)",
                    cursor: "pointer",
                  }}
                  disabled={loading || status.boards.every((b) => b.showOnDrop === false)}
                  onClick={() => handleSetAllBoardsDropVisibility(false)}
                >
                  全部隐藏
                </button>
              </div>
            ) : null}
          </div>
          {status.boards.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>暂无同名 .html 看板。上传文档归档后会自动生成。</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {status.boards.map((board) => {
                const shownOnDrop = board.showOnDrop !== false;
                return (
                  <div
                    key={board.relPath}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      borderRadius: 6,
                      border: "1px solid var(--line)",
                      padding: "4px 8px",
                      opacity: shownOnDrop ? 1 : 0.72,
                    }}
                  >
                    <button
                      type="button"
                      className="tree-file"
                      style={{ flex: 1, minWidth: 0, border: 0, padding: "2px 0", background: "transparent" }}
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
                          {board.updatedAt ? ` · 更新于 ${formatShortTime(board.updatedAt)}` : ""}
                        </span>
                      </span>
                    </button>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        color: shownOnDrop ? "var(--accent, #2f6b52)" : "var(--muted)",
                        fontWeight: shownOnDrop ? 600 : 400,
                        cursor: loading ? "not-allowed" : "pointer",
                        flex: "none",
                        margin: 0,
                        userSelect: "none",
                      }}
                      title="勾选后该页面会在 /p/<租户>/drop 页面向同事展示；取消勾选则不在 Drop 页面展示"
                    >
                      <input
                        type="checkbox"
                        checked={shownOnDrop}
                        disabled={loading}
                        onChange={(e) => handleToggleBoardDropVisibility(board.relPath, e.target.checked)}
                      />
                      <span>{shownOnDrop ? "Drop页展示" : "Drop已隐藏"}</span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* 2.5 关注的企微文件与变动巡检 */}
      {showKbSection && status?.isKnowledgeBase ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--line)",
          }}
          aria-label="关注的企微文件与变动巡检"
        >
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="side-label" style={{ margin: 0 }}>
                关注的企微文件（{status.wecomWatchItems?.length ?? 0}）
              </span>
              {(() => {
                const pendingCount = (status.wecomWatchItems ?? []).filter(
                  (it) => it.lastCheckHasChanged || !it.lastSyncedSha256,
                ).length;
                if (pendingCount <= 0) return null;
                return (
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 999,
                      background: "rgba(217, 130, 43, 0.16)",
                      color: "var(--warn, #b7651b)",
                      fontWeight: 600,
                    }}
                  >
                    {pendingCount} 项待同步
                  </span>
                );
              })()}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
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
                disabled={loading || (status.wecomWatchItems?.length ?? 0) === 0}
                title="实时比对企业微信远端最新修改时间与内容指纹（只看不改）"
                onClick={() => handleCheckWecomWatch()}
              >
                🔍 检查变动
              </button>
              <button
                type="button"
                style={{
                  background: "rgba(47, 107, 82, 0.12)",
                  border: "1px solid var(--accent, #2f6b52)",
                  borderRadius: 5,
                  padding: "2px 6px",
                  fontSize: 11,
                  color: "var(--accent, #2f6b52)",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                disabled={loading || (status.wecomWatchItems?.length ?? 0) === 0}
                title="将检测到有变动的关注文件送入归档队列，自动更新知识库与 HTML 看板"
                onClick={() => handleSyncWecomWatch()}
              >
                🔄 同步变动
              </button>
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
                disabled={loading}
                onClick={() => setAddingWatch((v) => !v)}
              >
                {addingWatch ? "收起" : "+ 关注"}
              </button>
            </div>
          </div>

          {addingWatch ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: 8,
                borderRadius: 8,
                border: "1px solid var(--line)",
                background: "var(--fill-quaternary, rgba(128,128,128,0.04))",
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600 }}>+ 添加企业微信关注文件（自动识别 ?tab= 子表）</div>
              <input
                type="text"
                className="search-input"
                style={{ padding: "5px 8px", fontSize: 12, margin: 0 }}
                placeholder="关注名称（如：2026退保计划-11月保证金退保计划）"
                value={watchTitleDraft}
                onChange={(e) => setWatchTitleDraft(e.target.value)}
              />
              <input
                type="text"
                className="search-input"
                style={{ padding: "5px 8px", fontSize: 12, margin: 0 }}
                placeholder="粘贴企微文档链接 https://doc.weixin.qq.com/... 或 docId / fileId"
                value={watchDocOrUrlDraft}
                onChange={(e) => setWatchDocOrUrlDraft(e.target.value)}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <select
                  className="search-input"
                  style={{ padding: "4px 6px", fontSize: 11, margin: 0, width: 105 }}
                  value={watchSourceTypeDraft}
                  onChange={(e) => setWatchSourceTypeDraft(e.target.value as KbWecomWatchedItemSummary["sourceType"])}
                >
                  <option value="sheet">在线表格</option>
                  <option value="smartsheet">智能表格</option>
                  <option value="doc">在线文档</option>
                  <option value="smartpage">智能文档</option>
                  <option value="disk_file">微盘文件</option>
                </select>
                <input
                  type="text"
                  className="search-input"
                  style={{ padding: "4px 6px", fontSize: 11, margin: 0, flex: 1 }}
                  placeholder="子表 ID 或名称（如 z4j6dz，链接含 ?tab= 可留空）"
                  value={watchSheetDraft}
                  onChange={(e) => setWatchSheetDraft(e.target.value)}
                />
              </div>
              <input
                type="text"
                className="search-input"
                style={{ padding: "4px 6px", fontSize: 11, margin: 0 }}
                placeholder="归档备注（可选，例如提示归入哪个分类主体）"
                value={watchNoteDraft}
                onChange={(e) => setWatchNoteDraft(e.target.value)}
              />
              <button
                type="button"
                className="new-chat primary"
                style={{ margin: 0, padding: "5px 10px", fontSize: 12 }}
                disabled={loading}
                onClick={handleAddWecomWatch}
              >
                加入关注并立即检查
              </button>
            </div>
          ) : null}

          {!status.wecomWatchItems || status.wecomWatchItems.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              尚未绑定企微关注文件。点击上方「+ 关注」粘贴企微表格/文档链接，或直接对小驳说“把这个企微表加到关注列表”。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {status.wecomWatchItems.map((item) => {
                const isFirstPending = !item.lastSyncedSha256;
                const hasChanged = Boolean(item.lastCheckHasChanged);
                const hasError = Boolean(item.lastCheckError);
                const previewText = item.lastCheckPreview || item.lastSnapshotPreview || "";
                const previewExpanded = Boolean(expandedWatchPreviewIds[item.id]);

                let badgeLabel = "已同步最新";
                let badgeBg = "rgba(47, 107, 82, 0.14)";
                let badgeColor = "var(--accent, #2f6b52)";
                if (hasError) {
                  badgeLabel = "检查异常";
                  badgeBg = "rgba(217, 83, 79, 0.14)";
                  badgeColor = "var(--danger, #d9534f)";
                } else if (isFirstPending) {
                  badgeLabel = "待首次入库";
                  badgeBg = "rgba(217, 130, 43, 0.16)";
                  badgeColor = "var(--warn, #b7651b)";
                } else if (hasChanged) {
                  badgeLabel = "有新变动（待同步）";
                  badgeBg = "rgba(217, 130, 43, 0.16)";
                  badgeColor = "var(--warn, #b7651b)";
                }

                return (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: "7px 9px",
                      borderRadius: 7,
                      border:
                        hasChanged || isFirstPending ? "1px solid rgba(217, 130, 43, 0.45)" : "1px solid var(--line)",
                      background:
                        hasChanged || isFirstPending
                          ? "rgba(217, 130, 43, 0.04)"
                          : "var(--fill-quaternary, rgba(128,128,128,0.03))",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                      <div
                        style={{
                          minWidth: 0,
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          flexWrap: "wrap",
                        }}
                      >
                        <strong style={{ fontSize: 12, wordBreak: "break-all" }}>{item.title}</strong>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "0px 5px",
                            borderRadius: 4,
                            border: "1px solid var(--line)",
                            color: "var(--muted)",
                          }}
                        >
                          {WECOM_SOURCE_TYPE_LABELS[item.sourceType] || item.sourceType}
                          {item.sheet ? ` · 子表:${item.sheet}` : ""}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 999,
                          background: badgeBg,
                          color: badgeColor,
                          fontWeight: 600,
                          flex: "none",
                        }}
                      >
                        {badgeLabel}
                      </span>
                    </div>

                    <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.45 }}>
                      <span>企微修改：{item.lastCheckedUpdateTime || item.lastSyncedUpdateTime || "待检查"}</span>
                      <span> · 上次检查：{formatShortTime(item.lastCheckedAt)}</span>
                      <span> · 上次入库：{item.lastSyncedAt ? formatShortTime(item.lastSyncedAt) : "尚未入库"}</span>
                      {item.lastCheckSummary ? <span> · {item.lastCheckSummary}</span> : null}
                    </div>

                    {hasError ? (
                      <div style={{ fontSize: 11, color: "var(--danger, #d9534f)", lineHeight: 1.4 }}>
                        检查报错：{item.lastCheckError}
                      </div>
                    ) : item.lastCheckDiffHint ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: hasChanged ? "var(--warn, #b7651b)" : "var(--muted)",
                          lineHeight: 1.4,
                          wordBreak: "break-word",
                        }}
                      >
                        {item.lastCheckDiffHint}
                      </div>
                    ) : null}

                    {previewExpanded && previewText ? (
                      <pre
                        style={{
                          margin: "2px 0 0",
                          padding: "6px 8px",
                          borderRadius: 6,
                          border: "1px solid var(--line)",
                          background: "var(--paper, rgba(0,0,0,0.03))",
                          fontSize: 10,
                          lineHeight: 1.4,
                          maxHeight: 130,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                        }}
                      >
                        {previewText}
                      </pre>
                    ) : null}

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 2,
                      }}
                    >
                      <div style={{ display: "flex", gap: 6 }}>
                        {previewText ? (
                          <button
                            type="button"
                            style={{
                              background: "transparent",
                              border: 0,
                              padding: 0,
                              fontSize: 11,
                              color: "var(--accent, #2f6b52)",
                              cursor: "pointer",
                            }}
                            onClick={() =>
                              setExpandedWatchPreviewIds((prev) => ({
                                ...prev,
                                [item.id]: !prev[item.id],
                              }))
                            }
                          >
                            {previewExpanded ? "收起数据预览 ▲" : "查看数据预览 ▼"}
                          </button>
                        ) : null}
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
                          disabled={loading}
                          onClick={() => handleCheckWecomWatch(item.id)}
                        >
                          检查
                        </button>
                        <button
                          type="button"
                          style={{
                            background: hasChanged || isFirstPending ? "rgba(47, 107, 82, 0.14)" : "transparent",
                            border:
                              hasChanged || isFirstPending
                                ? "1px solid var(--accent, #2f6b52)"
                                : "1px solid var(--line)",
                            borderRadius: 5,
                            padding: "2px 6px",
                            fontSize: 11,
                            color: hasChanged || isFirstPending ? "var(--accent, #2f6b52)" : "var(--ink)",
                            fontWeight: hasChanged || isFirstPending ? 600 : 400,
                            cursor: "pointer",
                          }}
                          disabled={loading}
                          title={
                            hasChanged || isFirstPending
                              ? "将该企微文件最新内容送入归档队列更新知识库"
                              : "强制重新拉取并同步入库"
                          }
                          onClick={() => handleSyncWecomWatch(item.id, !hasChanged && !isFirstPending)}
                        >
                          {hasChanged || isFirstPending ? "同步入库" : "重新同步"}
                        </button>
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
                          disabled={loading}
                          onClick={() => handleRemoveWecomWatch(item.id, item.title)}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* 2.8 工作区更新记录（更新时间 & 更新内容摘要） */}
      {showKbSection && status?.isKnowledgeBase ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--line)",
          }}
          aria-label="工作区更新记录"
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="side-label" style={{ margin: 0 }}>
                工作区更新记录（{status.ingestLogs?.length ?? 0}）
              </span>
              {hasActiveIngestJob ? (
                <span
                  style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: "rgba(47, 107, 82, 0.16)",
                    color: "var(--accent, #2f6b52)",
                    fontWeight: 600,
                  }}
                >
                  ⏳ 后台归档更新中…
                </span>
              ) : null}
            </div>
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
              disabled={loading}
              onClick={() =>
                sendKbOperation(buildAssistantOpMessage("kb_workspace_status", { workspace: workspaceKey }))
              }
            >
              刷新记录
            </button>
          </div>

          {!status.ingestLogs || status.ingestLogs.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              暂无工作区归档更新记录。当同步企微关注文件或投递文档后，这里会按时间展示每次更新工作区的时间、更新内容摘要与关联看板。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {status.ingestLogs.map((log: KbWorkspaceIngestLogItem) => {
                const isRunning = log.status === "queued" || log.status === "processing";
                const isFailed = log.status === "failed";
                const isPartial = log.status === "partial";
                const fullText = (log.summary || log.errorReason || "").trim();
                const isLong = fullText.length > 160;
                const expanded = Boolean(expandedLogBatchIds[log.batchId]);
                const shownText = !expanded && isLong ? `${fullText.slice(0, 160)}…` : fullText;

                let stLabel = "已更新入库";
                let stColor = "var(--accent, #2f6b52)";
                let stBg = "rgba(47, 107, 82, 0.14)";
                if (isRunning) {
                  stLabel = log.status === "processing" ? "正在归档更新…" : "排队等待中…";
                  stColor = "var(--accent, #2f6b52)";
                  stBg = "rgba(47, 107, 82, 0.18)";
                } else if (isPartial) {
                  stLabel = "部分归档";
                  stColor = "var(--warn, #b7651b)";
                  stBg = "rgba(217, 130, 43, 0.16)";
                } else if (isFailed) {
                  stLabel = "归档未完成";
                  stColor = "var(--danger, #d9534f)";
                  stBg = "rgba(217, 83, 79, 0.14)";
                }

                return (
                  <div
                    key={log.batchId}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: "7px 9px",
                      borderRadius: 7,
                      border: "1px solid var(--line)",
                      background: "var(--fill-quaternary, rgba(128,128,128,0.03))",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink)" }}>
                        🕒 {formatShortTime(log.timestamp)} · {log.submitterName}
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 999,
                          background: stBg,
                          color: stColor,
                          fontWeight: 600,
                          flex: "none",
                        }}
                      >
                        {stLabel}
                      </span>
                    </div>

                    {log.note ? (
                      <div style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-word" }}>
                        来源说明：{log.note}
                      </div>
                    ) : null}

                    {shownText ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: isFailed && !log.summary ? "var(--danger, #d9534f)" : "var(--ink)",
                          lineHeight: 1.45,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {shownText}
                        {isLong ? (
                          <button
                            type="button"
                            style={{
                              background: "transparent",
                              border: 0,
                              padding: "0 0 0 6px",
                              fontSize: 11,
                              color: "var(--accent, #2f6b52)",
                              cursor: "pointer",
                            }}
                            onClick={() =>
                              setExpandedLogBatchIds((prev) => ({
                                ...prev,
                                [log.batchId]: !prev[log.batchId],
                              }))
                            }
                          >
                            {expanded ? "收起" : "展开全文"}
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {log.updatedHtmls.length > 0 || log.movedFiles.length > 0 ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
                        {log.updatedHtmls.map((htmlRel) => (
                          <button
                            key={htmlRel}
                            type="button"
                            style={{
                              background: "rgba(47, 107, 82, 0.08)",
                              border: "1px solid var(--line)",
                              borderRadius: 5,
                              padding: "2px 6px",
                              fontSize: 10,
                              color: "var(--accent, #2f6b52)",
                              cursor: "pointer",
                            }}
                            title={`点击打开已更新看板：${htmlRel}`}
                            onClick={() => onOpenBoard(htmlRel)}
                          >
                            📊 看板：{htmlRel}
                          </button>
                        ))}
                        {log.movedFiles.map((mf) => (
                          <button
                            key={`${mf.from}->${mf.to}`}
                            type="button"
                            style={{
                              background: "transparent",
                              border: "1px solid var(--line)",
                              borderRadius: 5,
                              padding: "2px 6px",
                              fontSize: 10,
                              color: "var(--muted)",
                              cursor: "pointer",
                            }}
                            title={`点击查看归档原文件：${mf.to}`}
                            onClick={() => onOpenBoard(mf.to)}
                          >
                            📄 [{mf.category}] {mf.to}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* 通用工程级定时任务（无论是否开启知识库均支持配置） */}
      {showSchedulesSection && status ? (
        <WorkspaceScheduleSection
          workspaceKey={workspaceKey}
          schedules={status.workspaceSchedules ?? []}
          runs={status.workspaceScheduleRuns ?? []}
          loading={loading}
          lastScheduleResult={status.workspaceScheduleResult}
          sendKbOperation={sendKbOperation}
          onOpenBoard={onOpenBoard}
          setErrorText={setErrorText}
        />
      ) : null}

      {/* 3. 外部同事投递门户链接与投递密钥管理 */}
      {showTokensSection && status?.isKnowledgeBase ? (
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
                  style={{
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                    fontSize: 11,
                    color: "var(--muted)",
                  }}
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
              <div style={{ color: "var(--muted)" }}>{qrStatusData?.message || "截图发给同事扫码确认即自动激活"}</div>
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
