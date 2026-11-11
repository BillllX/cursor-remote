import { useEffect, useState } from "react";
import type {
  ClientMessage,
  WorkspaceScheduleExecutorKind,
  WorkspaceScheduleRunSummaryItem,
  WorkspaceScheduleSummaryItem,
} from "@shared/protocol";
import { buildAssistantOpMessage } from "@shared/assistantOp";

const EXECUTOR_KIND_LABELS: Record<WorkspaceScheduleExecutorKind, string> = {
  wecom_watch_sync: "企微关注文件巡检同步",
  wecom_mail_poll: "企微邮箱增量拉取",
  http_api_ingest: "外部 HTTP/API/网页抓取",
  workspace_script: "工作区受控脚本",
  agent_prompt: "AI 定时分析指令",
};

function formatShortTime(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  try {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "—";
  }
}

type WorkspaceScheduleSectionProps = {
  workspaceKey: string;
  schedules: WorkspaceScheduleSummaryItem[];
  runs: WorkspaceScheduleRunSummaryItem[];
  loading: boolean;
  lastScheduleResult?: { action: "upsert" | "toggle" | "run_now" | "remove"; message: string };
  sendKbOperation: (message: ClientMessage, silent?: boolean) => void;
  onOpenBoard: (relPath: string) => void;
  setErrorText: (msg: string) => void;
};

export function WorkspaceScheduleSection({
  workspaceKey,
  schedules,
  runs,
  loading,
  lastScheduleResult,
  sendKbOperation,
  onOpenBoard,
  setErrorText,
}: WorkspaceScheduleSectionProps) {
  const [adding, setAdding] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [executorKindDraft, setExecutorKindDraft] = useState<WorkspaceScheduleExecutorKind>("wecom_watch_sync");
  const [scheduleModeDraft, setScheduleModeDraft] = useState<"interval" | "daily_times">("interval");
  const [intervalDraft, setIntervalDraft] = useState("60");
  const [dailyTimesDraft, setDailyTimesDraft] = useState("08:45, 18:30");
  const [quietDraft, setQuietDraft] = useState("3");
  const [mailKeywordDraft, setMailKeywordDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [scriptRunnerDraft, setScriptRunnerDraft] = useState<"python3" | "node" | "bash">("python3");
  const [scriptPathDraft, setScriptPathDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");

  useEffect(() => {
    if (lastScheduleResult?.action === "upsert") {
      setAdding(false);
      setTitleDraft("");
      setUrlDraft("");
      setScriptPathDraft("");
      setPromptDraft("");
      setMailKeywordDraft("");
    }
  }, [lastScheduleResult]);

  function handleCreate() {
    const title = titleDraft.trim();
    if (!title) {
      setErrorText("请填写定时任务名称（如：企微关注表每小时同步）");
      return;
    }
    const rawInterval = Number(intervalDraft);
    if (scheduleModeDraft === "interval" && (!Number.isFinite(rawInterval) || rawInterval < 5 || rawInterval > 10080)) {
      setErrorText("固定间隔分钟数需在 5 ~ 10080 之间");
      return;
    }
    const intervalMinutes = Math.max(5, Math.min(10080, Math.floor(rawInterval || 60)));
    const dailyTimes = dailyTimesDraft
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^([01]?\d|2[0-3]):([0-5]\d)$/.test(s));
    if (scheduleModeDraft === "daily_times" && dailyTimes.length === 0) {
      setErrorText("每日定点模式请填写至少一个 HH:MM 格式时刻（如 08:45, 18:30）");
      return;
    }
    if (executorKindDraft === "http_api_ingest" && !/^https?:\/\/\S+/i.test(urlDraft.trim())) {
      setErrorText("HTTP/API 抓取任务请填写有效的 http:// 或 https:// 地址");
      return;
    }
    if (executorKindDraft === "workspace_script" && !scriptPathDraft.trim()) {
      setErrorText("工作区受控脚本任务请填写脚本相对路径（如 scripts/pull.py）");
      return;
    }
    if (executorKindDraft === "agent_prompt" && !promptDraft.trim()) {
      setErrorText("AI 定时分析任务请填写执行的分析指令");
      return;
    }

    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        workspaceScheduleAction: {
          kind: "upsert",
          title,
          enabled: true,
          executorKind: executorKindDraft,
          scheduleMode: scheduleModeDraft,
          intervalMinutes,
          ...(scheduleModeDraft === "daily_times" ? { dailyTimes } : {}),
          ...(executorKindDraft === "wecom_watch_sync" ? { quietPeriodMinutes: Number(quietDraft) || 3 } : {}),
          ...(executorKindDraft === "wecom_mail_poll" && mailKeywordDraft.trim()
            ? { mailKeyword: mailKeywordDraft.trim() }
            : {}),
          ...(executorKindDraft === "http_api_ingest" ? { url: urlDraft.trim() } : {}),
          ...(executorKindDraft === "workspace_script"
            ? { runner: scriptRunnerDraft, scriptRelPath: scriptPathDraft.trim() }
            : {}),
          ...(executorKindDraft === "agent_prompt" ? { prompt: promptDraft.trim() } : {}),
        },
      }),
    );
  }

  function handleToggle(item: WorkspaceScheduleSummaryItem) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        workspaceScheduleAction: {
          kind: "toggle",
          idOrTitle: item.id,
          enabled: !item.enabled,
        },
      }),
    );
  }

  function handleRunNow(item: WorkspaceScheduleSummaryItem) {
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        workspaceScheduleAction: {
          kind: "run_now",
          idOrTitle: item.id,
        },
      }),
    );
  }

  function handleRemove(item: WorkspaceScheduleSummaryItem) {
    if (!window.confirm(`确定删除定时任务《${item.title}》吗？`)) return;
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        workspaceScheduleAction: {
          kind: "remove",
          idOrTitle: item.id,
        },
      }),
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        paddingTop: 8,
        borderTop: "1px solid var(--line)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <span className="side-label" style={{ margin: 0 }}>
          通用定时任务（{schedules.length}）
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {runs.length > 0 ? (
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
              onClick={() => setShowRuns((v) => !v)}
            >
              {showRuns ? "收起日志" : `运行日志(${runs.length})`}
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
              color: "var(--ink)",
              cursor: "pointer",
            }}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "收起" : "+ 新建定时任务"}
          </button>
        </div>
      </div>

      {adding ? (
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
          <div style={{ fontSize: 11, fontWeight: 600 }}>新建通用定时任务（单飞互斥锁 · 跑完归档才解锁更新状态）</div>
          <input
            type="text"
            className="search-input"
            style={{ padding: "5px 8px", fontSize: 12, margin: 0 }}
            placeholder="任务名称（如：企微关注表每小时自动同步）"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <select
              className="search-input"
              style={{ padding: "4px 6px", fontSize: 11, margin: 0, flex: 1 }}
              value={executorKindDraft}
              onChange={(e) => setExecutorKindDraft(e.target.value as WorkspaceScheduleExecutorKind)}
            >
              <option value="wecom_watch_sync">企微关注文件巡检同步</option>
              <option value="wecom_mail_poll">企微邮箱增量拉取</option>
              <option value="http_api_ingest">HTTP/API/网页抓取入库</option>
              <option value="workspace_script">工作区受控脚本 (Python/Node/Bash)</option>
              <option value="agent_prompt">AI Agent 定时分析指令</option>
            </select>
            <select
              className="search-input"
              style={{ padding: "4px 6px", fontSize: 11, margin: 0, width: 112 }}
              value={scheduleModeDraft}
              onChange={(e) => setScheduleModeDraft(e.target.value as "interval" | "daily_times")}
            >
              <option value="interval">固定间隔</option>
              <option value="daily_times">每日定点</option>
            </select>
          </div>

          {scheduleModeDraft === "interval" ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
              <span style={{ color: "var(--muted)" }}>每隔（分钟，跑完后起算）：</span>
              <input
                type="number"
                className="search-input"
                style={{ padding: "4px 6px", fontSize: 11, margin: 0, width: 80 }}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
              />
            </div>
          ) : (
            <input
              type="text"
              className="search-input"
              style={{ padding: "4px 8px", fontSize: 11, margin: 0 }}
              placeholder="每日触发时刻，逗号分隔（如 08:45, 18:30）"
              value={dailyTimesDraft}
              onChange={(e) => setDailyTimesDraft(e.target.value)}
            />
          )}

          {executorKindDraft === "wecom_watch_sync" ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
              <span style={{ color: "var(--muted)" }}>静默防抖等待（分钟）：</span>
              <input
                type="number"
                className="search-input"
                style={{ padding: "4px 6px", fontSize: 11, margin: 0, width: 70 }}
                value={quietDraft}
                onChange={(e) => setQuietDraft(e.target.value)}
              />
            </div>
          ) : null}

          {executorKindDraft === "wecom_mail_poll" ? (
            <input
              type="text"
              className="search-input"
              style={{ padding: "4px 8px", fontSize: 11, margin: 0 }}
              placeholder="可选：邮件搜索关键词（如 日报、保证金）"
              value={mailKeywordDraft}
              onChange={(e) => setMailKeywordDraft(e.target.value)}
            />
          ) : null}

          {executorKindDraft === "http_api_ingest" ? (
            <input
              type="text"
              className="search-input"
              style={{ padding: "4px 8px", fontSize: 11, margin: 0 }}
              placeholder="公开 HTTP/HTTPS 接口或网页 URL"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
            />
          ) : null}

          {executorKindDraft === "workspace_script" ? (
            <div style={{ display: "flex", gap: 6 }}>
              <select
                className="search-input"
                style={{ padding: "4px 6px", fontSize: 11, margin: 0, width: 90 }}
                value={scriptRunnerDraft}
                onChange={(e) => setScriptRunnerDraft(e.target.value as "python3" | "node" | "bash")}
              >
                <option value="python3">python3</option>
                <option value="node">node</option>
                <option value="bash">bash</option>
              </select>
              <input
                type="text"
                className="search-input"
                style={{ padding: "4px 8px", fontSize: 11, margin: 0, flex: 1 }}
                placeholder="脚本相对路径（如 scripts/pull_data.py）"
                value={scriptPathDraft}
                onChange={(e) => setScriptPathDraft(e.target.value)}
              />
            </div>
          ) : null}

          {executorKindDraft === "agent_prompt" ? (
            <textarea
              className="search-input"
              rows={2}
              style={{ padding: "5px 8px", fontSize: 11, margin: 0 }}
              placeholder="定时执行的 AI 分析指令（如：对比今日各资方退保进度并更新看板）"
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
            />
          ) : null}

          <button
            type="button"
            className="new-chat primary"
            style={{ margin: 0, padding: "5px 10px", fontSize: 12 }}
            disabled={loading}
            onClick={handleCreate}
          >
            创建并启用定时任务
          </button>
        </div>
      ) : null}

      {schedules.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          尚未配置定时任务。点击右上角「+ 新建定时任务」或对小驳说「每小时自动检查同步企微关注文件」。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {schedules.map((item) => {
            const isBusy = item.state !== "idle";
            const stateBadge =
              item.state === "running_step1"
                ? { label: "⏳ 正在采集执行…", color: "var(--warn, #b7651b)", bg: "rgba(217, 130, 43, 0.16)" }
                : item.state === "running_step2"
                  ? { label: "⏳ 后台归档更新看板中…", color: "var(--warn, #b7651b)", bg: "rgba(217, 130, 43, 0.16)" }
                  : !item.enabled
                    ? { label: "已暂停", color: "var(--muted)", bg: "rgba(128,128,128,0.14)" }
                    : item.lastStatus === "failed"
                      ? { label: "上次异常", color: "var(--danger, #d9534f)", bg: "rgba(217, 83, 79, 0.14)" }
                      : { label: "待命运行中", color: "var(--accent, #2f6b52)", bg: "rgba(47, 107, 82, 0.14)" };

            const freqLabel =
              item.scheduleMode === "daily_times"
                ? `每日 ${(item.dailyTimes || []).join(", ")}`
                : `每 ${item.intervalMinutes} 分钟（跑完起算）`;

            return (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                  padding: "8px 9px",
                  borderRadius: 7,
                  border: "1px solid var(--line)",
                  background: "var(--fill-quaternary, rgba(128,128,128,0.03))",
                  fontSize: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <div style={{ fontWeight: 600, minWidth: 0, flex: 1 }}>
                    ⏱️ {item.title}
                    <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 400, marginLeft: 6 }}>
                      [{EXECUTOR_KIND_LABELS[item.executorKind]}]
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 999,
                      background: stateBadge.bg,
                      color: stateBadge.color,
                      fontWeight: 600,
                      flex: "none",
                    }}
                  >
                    {stateBadge.label}
                  </span>
                </div>

                <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4 }}>
                  <div>策略：{freqLabel} · {item.payloadSummary}</div>
                  <div>
                    上次完成：{formatShortTime(item.lastFinishedAt)}
                    {item.enabled && item.nextRunAt ? ` · 下次预计：${formatShortTime(item.nextRunAt)}` : ""}
                  </div>
                </div>

                {item.lastSummary ? (
                  <div
                    style={{
                      fontSize: 11,
                      color: item.lastStatus === "failed" ? "var(--danger, #d9534f)" : "var(--ink)",
                      background: "rgba(128,128,128,0.06)",
                      padding: "4px 6px",
                      borderRadius: 5,
                      wordBreak: "break-word",
                    }}
                  >
                    最新状态：{item.lastSummary}
                  </div>
                ) : null}

                {item.lastUpdatedFiles && item.lastUpdatedFiles.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {item.lastUpdatedFiles.map((f) => (
                      <button
                        key={f}
                        type="button"
                        style={{
                          background: "rgba(47, 107, 82, 0.08)",
                          border: "1px solid var(--line)",
                          borderRadius: 5,
                          padding: "1px 6px",
                          fontSize: 10,
                          color: "var(--accent, #2f6b52)",
                          cursor: "pointer",
                        }}
                        onClick={() => onOpenBoard(f)}
                      >
                        📄 {f}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                  <button
                    type="button"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--line)",
                      borderRadius: 5,
                      padding: "2px 7px",
                      fontSize: 11,
                      color: "var(--accent, #2f6b52)",
                      cursor: isBusy ? "not-allowed" : "pointer",
                      opacity: isBusy ? 0.5 : 1,
                    }}
                    disabled={loading || isBusy}
                    onClick={() => handleRunNow(item)}
                  >
                    {isBusy ? "运行锁定中…" : "▶ 立即执行"}
                  </button>
                  <button
                    type="button"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--line)",
                      borderRadius: 5,
                      padding: "2px 7px",
                      fontSize: 11,
                      color: "var(--ink)",
                      cursor: "pointer",
                    }}
                    disabled={loading}
                    onClick={() => handleToggle(item)}
                  >
                    {item.enabled ? "暂停" : "启用"}
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
                      cursor: isBusy ? "not-allowed" : "pointer",
                      opacity: isBusy ? 0.5 : 1,
                    }}
                    disabled={loading || isBusy}
                    onClick={() => handleRemove(item)}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showRuns && runs.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>定时任务最近运行记录：</div>
          {runs.slice(0, 8).map((r) => (
            <div
              key={r.runId}
              style={{
                padding: "5px 7px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                fontSize: 11,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted)", fontSize: 10 }}>
                <span>
                  {formatShortTime(r.finishedAt)} · {r.title} ({r.trigger === "manual" ? "手动" : "定时"})
                </span>
                <span>{r.status}</span>
              </div>
              <div style={{ marginTop: 2, wordBreak: "break-word" }}>{r.summary}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
