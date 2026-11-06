// 工作区知识库与投递口令可视化管理面板（嵌入在工作区侧栏「管理」中）
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantResultMessage, ClientMessage, KbWorkspaceStatusData } from "@shared/protocol";
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

  // 新增投递口令表单
  const [passcodeDraft, setPasscodeDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [expiresDraft, setExpiresDraft] = useState("90");
  const pendingReqIdsRef = useRef(new Set<string>());

  const sendKbOperation = useCallback(
    (message: ClientMessage) => {
      if (message.type !== "assistant_op" || !message.reqId) return;
      pendingReqIdsRef.current.add(message.reqId);
      setLoading(true);
      setErrorText("");
      send(message);
    },
    [send],
  );

  useEffect(() => {
    if (!workspaceKey) return;
    pendingReqIdsRef.current.clear();
    setStatus(null);
    sendKbOperation(buildAssistantOpMessage("kb_workspace_status", { workspace: workspaceKey }));
  }, [workspaceKey, sendKbOperation]);

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

      if (op === "kb_workspace_init") {
        setEditingKb(false);
        setNotice(`已启用知识库工作区：${data.title}`);
      } else if (op === "drop_token_create") {
        setPasscodeDraft("");
        setLabelDraft("");
        setNotice("已创建投递口令");
      } else if (op === "drop_token_revoke") {
        setNotice("已吊销投递口令");
      }
    }
    if (consumed) setLoading(pendingReqIdsRef.current.size > 0);
  }, [assistantResults, workspaceKey, workspaceName, setNotice]);

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
    const days = Number(expiresDraft);
    sendKbOperation(
      buildAssistantOpMessage("drop_token_create", {
        workspace: workspaceKey,
        passcode,
        label: labelDraft.trim() || undefined,
        ...(Number.isFinite(days) && days > 0 ? { expiresInDays: days } : {}),
      }),
    );
  }

  function handleRevokeToken(id: string, label: string) {
    if (!window.confirm(`确定吊销投递口令「${label}」吗？吊销后同事将无法继续凭该口令上传。`)) {
      return;
    }
    sendKbOperation(
      buildAssistantOpMessage("drop_token_revoke", {
        workspace: workspaceKey,
        idOrLabel: id,
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
              {status.tokens.map((tok) => (
                <div
                  key={tok.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "5px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--line)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{tok.label}</div>
                    <div style={{ fontSize: 10, color: "var(--muted)" }}>
                      ID: {tok.id}
                      {tok.expiresAt
                        ? ` · 有效期至 ${new Date(tok.expiresAt).toLocaleDateString("zh-CN")}`
                        : " · 长期有效"}
                    </div>
                  </div>
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
                      flex: "none",
                    }}
                    onClick={() => handleRevokeToken(tok.id, tok.label)}
                  >
                    吊销
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>
              尚未配置投递口令。在下方创建一个口令发给同事，同事即可在投递页上传文档并查阅 HTML 看板。
            </div>
          )}

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
            <div style={{ fontSize: 11, fontWeight: 600 }}>+ 新增投递密钥（口令）</div>
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
                placeholder="备注（如：风控团队）"
                value={labelDraft}
                onChange={(e) => setLabelDraft(e.target.value)}
              />
              <input
                type="number"
                className="search-input"
                style={{ padding: "5px 8px", fontSize: 12, margin: 0, width: 76 }}
                placeholder="有效天数"
                title="有效天数（留空为长期有效）"
                value={expiresDraft}
                onChange={(e) => setExpiresDraft(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="new-chat primary"
              style={{ margin: 0, padding: "5px 10px", fontSize: 12 }}
              disabled={loading}
              onClick={handleCreateToken}
            >
              创建投递口令
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
