import { useEffect, useState } from "react";
import type {
  ClientMessage,
  WorkspaceScheduleExecutorKind,
  WorkspaceScheduleRunSummaryItem,
  WorkspaceScheduleSummaryItem,
  KbWorkspaceStatusData,
} from "@shared/protocol";
import { buildAssistantOpMessage } from "@shared/assistantOp";

const EXECUTOR_KIND_LABELS: Record<WorkspaceScheduleExecutorKind, string> = {
  wecom_watch_sync: "企微关注文件巡检同步",
  wecom_mail_poll: "企微邮箱增量拉取",
  http_api_ingest: "外部 HTTP/API/网页抓取",
  workspace_script: "工作区受控脚本",
  agent_prompt: "AI 定时分析指令",
};

function formatTime(ms: number | null | undefined, timeZone: string) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

const runLabels: Record<WorkspaceScheduleRunSummaryItem["status"], string> = {
  succeeded: "已完成",
  no_change: "无变化",
  partial: "部分完成",
  failed: "失败",
};

function cadence(item: WorkspaceScheduleSummaryItem) {
  if (item.scheduleMode === "weekly") return `每周 ${(item.weeklyDays ?? []).map((d) => "一二三四五六日"[d - 1]).join("、")} ${item.dailyTimes?.join("、") ?? "—"}`;
  if (item.scheduleMode === "monthly" && item.monthly) {
    const { day, time, shortMonth } = item.monthly;
    return `每月 ${day} 日 ${time}${day > 28 ? (shortMonth === "skip" ? " · 短月跳过" : " · 短月月底运行") : ""}`;
  }
  return item.scheduleMode === "daily_times"
    ? `每天 ${item.dailyTimes?.join("、") ?? "—"}`
    : `完成后间隔 ${item.intervalMinutes} 分钟`;
}

const stack = { display: "grid", gap: 10, minWidth: 0, overflowWrap: "anywhere" } as const;
const actions = { display: "flex", flexWrap: "wrap", gap: 8 } as const;
const surface = { ...stack, border: "1px solid var(--line)", padding: 12, borderRadius: 8 } as const;
const control = { margin: 0, minWidth: 0, width: "100%" } as const;

type WorkspaceScheduleSectionProps = {
  workspaceKey: string;
  heading?: string;
  showCreate?: boolean;
  summaryOnly?: boolean;
  schedules: WorkspaceScheduleSummaryItem[];
  runs: WorkspaceScheduleRunSummaryItem[];
  loading: boolean;
  lastScheduleResult?: KbWorkspaceStatusData["workspaceScheduleResult"];
  backfillPreview?: KbWorkspaceStatusData["workspaceBackfill"];
  sendKbOperation: (message: ClientMessage, silent?: boolean) => void;
  onOpenBoard: (relPath: string, sha?: string) => void;
  setErrorText: (msg: string) => void;
};

export function WorkspaceScheduleSection({
  workspaceKey,
  heading = "工作区自动化",
  showCreate = true,
  summaryOnly = false,
  schedules,
  runs,
  loading,
  lastScheduleResult,
  backfillPreview,
  sendKbOperation,
  onOpenBoard,
  setErrorText,
}: WorkspaceScheduleSectionProps) {
  const [backfilling, setBackfilling] = useState<string>();
  const [period, setPeriod] = useState("");
  const [reportInputs, setReportInputs] = useState("");
  const [reportOutput, setReportOutput] = useState("");
  const [outputTargets, setOutputTargets] = useState("");
  const preview = backfillPreview?.scheduleId === backfilling && backfillPreview?.period === period
    ? backfillPreview : undefined;
  function backfill(kind: "backfill" | "backfill_preview", item: WorkspaceScheduleSummaryItem) {
    if (!period || (kind === "backfill" && !preview)) return;
    setErrorText("");
    sendKbOperation(buildAssistantOpMessage("drop_token_update", {
      workspace: workspaceKey,
      workspaceScheduleAction: {
        kind, id: item.id, period, ...(summaryOnly ? { summaryOnly: true } : {}),
        ...(kind === "backfill" ? { token: preview!.token, newVersion: preview!.versions > 0 } : {}),
      },
    }));
  }
  const [editing, setEditing] = useState<WorkspaceScheduleSummaryItem | "new" | null>(null);
  const [formError, setFormError] = useState("");
  const [pending, setPending] = useState<{ action: "run_now" | "remove"; item: WorkspaceScheduleSummaryItem } | null>(
    null,
  );
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<WorkspaceScheduleExecutorKind>("wecom_watch_sync");
  const [mode, setMode] = useState<WorkspaceScheduleSummaryItem["scheduleMode"]>("interval");
  const [interval, setInterval] = useState("60");
  const [weeklyDays, setWeeklyDays] = useState<number[]>([3, 6]);
  const [times, setTimes] = useState("09:00");
  const [day, setDay] = useState("5");
  const [time, setTime] = useState("09:00");
  const [shortMonth, setShortMonth] = useState<"skip" | "last_day">("skip");
  const [detail, setDetail] = useState("");
  const [quiet, setQuiet] = useState("3");
  const [runner, setRunner] = useState<"python3" | "node" | "bash">("python3");

  useEffect(() => {
    if (lastScheduleResult?.action === "upsert") setEditing(null);
    if (lastScheduleResult?.action === "backfill") setBackfilling(undefined);
  }, [lastScheduleResult]);

  function openForm(item: WorkspaceScheduleSummaryItem | "new") {
    setEditing(item);
    setFormError("");
    const saved = item === "new" ? undefined : item;
    setTitle(saved?.title ?? "");
    setKind(saved?.executorKind ?? "wecom_watch_sync");
    setMode(saved?.scheduleMode ?? "interval");
    setInterval(String(saved?.intervalMinutes ?? 60));
    setWeeklyDays(saved?.weeklyDays ?? [3, 6]);
    setTimes(saved?.dailyTimes?.join("、") ?? "09:00");
    setDay(String(saved?.monthly?.day ?? 5));
    setTime(saved?.monthly?.time ?? "09:00");
    setShortMonth(saved?.monthly?.shortMonth ?? "skip");
    setDetail("");
    setReportInputs(saved?.reportInputs?.join("\n") ?? "");
    setReportOutput(saved?.outputRelPath ?? "");
    setOutputTargets(saved?.outputTargets?.join("\n") ?? "");
    setQuiet("3");
    setRunner("python3");
  }

  function save() {
    const saved = editing === "new" ? null : editing;
    if (!title.trim()) {
      setFormError("请输入自动化名称。");
      return;
    }
    const dailyTimes = times.trim().split(/[,，、\s]+/);
    const validClock = /^([01]?\d|2[0-3]):[0-5]\d$/;
    if ((mode === "daily_times" || mode === "weekly") && !dailyTimes.every((value) => validClock.test(value))) {
      setFormError("请用 HH:MM 填写每天的运行时间，例如 09:00。多个时间用逗号分隔。");
      return;
    }
    if (mode === "weekly" && !weeklyDays.length) { setFormError("请选择至少一个运行日。"); return; }
    if (!saved && kind === "http_api_ingest" && !/^https?:\/\//i.test(detail.trim())) {
      setFormError("来源地址需以 http:// 或 https:// 开头。");
      return;
    }
    setFormError("");
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        workspaceScheduleAction: {
          kind: "upsert",
          ...(summaryOnly ? { summaryOnly: true } : {}),
          ...(saved ? { id: saved.id, expectedUpdatedAt: saved.updatedAt } : { enabled: false, createOnly: true }),
          title: title.trim(),
          executorKind: kind,
          scheduleMode: mode,
          ...(mode === "interval" ? { intervalMinutes: Number(interval) } : {}),
          ...((mode === "daily_times" || mode === "weekly") ? { dailyTimes } : {}),
          ...(mode === "weekly" ? { weeklyDays } : {}),
          ...(mode === "monthly" ? { monthly: { day: Number(day), time, shortMonth } } : {}),
          ...(!saved && kind === "wecom_watch_sync" ? { quietPeriodMinutes: Number(quiet) } : {}),
          ...(!saved && kind === "wecom_mail_poll" ? { mailKeyword: detail.trim() || undefined } : {}),
          ...(!saved && kind === "http_api_ingest" ? { url: detail.trim() } : {}),
          ...(!saved && kind === "workspace_script" ? { runner, scriptRelPath: detail.trim() } : {}),
          ...(!saved && kind === "agent_prompt" ? { prompt: detail.trim() } : {}),
          outputTargets: outputTargets.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          ...(kind === "agent_prompt" ? { outputRelPath: reportOutput.trim(), reportInputs: reportInputs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) } : {}),
        },
      }),
    );
  }

  function act(kind: "toggle" | "run_now" | "remove", item: WorkspaceScheduleSummaryItem) {
    setErrorText("");
    sendKbOperation(
      buildAssistantOpMessage("drop_token_update", {
        workspace: workspaceKey,
        workspaceScheduleAction: {
          kind,
          ...(summaryOnly ? { summaryOnly: true } : {}),
          idOrTitle: item.id,
          ...(kind === "toggle" ? { enabled: !item.enabled } : {}),
        },
      }),
    );
  }

  const archivedRuns = runs.filter((run) => schedules.every((item) => item.id !== run.scheduleId));

  function renderRun(run: WorkspaceScheduleRunSummaryItem, tz: string, showTitle = false) {
    return (
      <div key={run.runId} style={{ ...surface, marginTop: 8 }}>
        {showTitle && <strong>{run.title}</strong>}
        <div>
          {runLabels[run.status]} · {run.trigger === "backfill" ? "补跑" : run.trigger === "manual" ? "手动运行" : "定时触发"}{run.period && ` · ${run.period}`} ·{" "}
          {formatTime(run.finishedAt, tz)}
          {showTitle && "（UTC）"}
        </div>
        <div>{run.error || run.summary}</div>
        {!!run.snapshots?.length ? (
          <div style={actions}>
            {run.snapshots.map(({ path, sha }) => sha && (
              <button type="button" className="new-chat" key={path} onClick={() => onOpenBoard(path, sha)}>
                查看本次版本 · {path}
              </button>
            ))}
          </div>
        ) : !!run.updatedFiles?.length && <div>未保留本次文件版本</div>}
      </div>
    );
  }

  return (
    <section
      style={{ ...stack, paddingTop: 12, borderTop: "1px solid var(--line)" }}
      aria-label={heading}
      aria-busy={loading}
    >
      <div style={{ ...actions, alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{heading}</h3>
        {showCreate && !editing && (
          <button type="button" className="new-chat" disabled={loading} onClick={() => openForm("new")}>
            新建自动化
          </button>
        )}
      </div>
      {editing && (
        <form
          style={surface}
          onSubmit={(event) => {
            event.preventDefault();
            if (!loading) save();
          }}
        >
          <h4 style={{ margin: 0 }}>{editing === "new" ? "新建自动化" : "编辑计划"}</h4>
          <label style={stack}>
            名称
            <input
              autoFocus
              className="search-input"
              style={control}
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {editing === "new" ? (
            <label style={stack}>
              执行内容
              <select
                className="search-input"
                style={control}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as WorkspaceScheduleExecutorKind);
                  setDetail("");
                }}
              >
                {Object.entries(EXECUTOR_KIND_LABELS).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p style={{ margin: 0 }}>
              执行内容：{editing.payloadSummary || EXECUTOR_KIND_LABELS[kind]}。此处可更改名称和触发频率。
            </p>
          )}
          <label style={stack}>
            触发频率
            <select
              className="search-input"
              style={control}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="interval">固定间隔</option>
              <option value="daily_times">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </label>
          {mode === "interval" && (
            <label style={stack}>
              完成后间隔（分钟）
              <input
                className="search-input"
                type="number"
                min={5}
                max={10080}
                required
                style={control}
                value={interval}
                onChange={(event) => setInterval(event.target.value)}
              />
            </label>
          )}
          {mode === "weekly" && <fieldset><legend>运行日</legend>{Array.from({ length: 7 }, (_, i) => i + 1).map((d) => <label key={d}><input type="checkbox" checked={weeklyDays.includes(d)} onChange={(e) => setWeeklyDays(e.target.checked ? [...weeklyDays, d].sort() : weeklyDays.filter((v) => v !== d))} />周{"一二三四五六日"[d - 1]}</label>)}</fieldset>}
          {(mode === "daily_times" || mode === "weekly") && (
            <label style={stack}>
              每天运行时间（逗号分隔）
              <input
                className="search-input"
                required
                style={control}
                value={times}
                onChange={(event) => setTimes(event.target.value)}
              />
            </label>
          )}
          {mode === "monthly" && (
            <>
              <label style={stack}>
                每月第几日
                <input
                  className="search-input"
                  type="number"
                  min={1}
                  max={31}
                  required
                  style={control}
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                />
              </label>
              <label style={stack}>
                运行时刻
                <input
                  className="search-input"
                  type="time"
                  required
                  style={control}
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </label>
              {Number(day) > 28 && (
                <label style={stack}>
                  当月没有这一天
                  <select
                    className="search-input"
                    style={control}
                    value={shortMonth}
                    onChange={(event) => setShortMonth(event.target.value as typeof shortMonth)}
                  >
                    <option value="skip">跳过当月</option>
                    <option value="last_day">当月最后一天运行</option>
                  </select>
                </label>
              )}
            </>
          )}
          {mode !== "interval" && <small>运行时区：{editing === "new" ? "Asia/Shanghai" : editing.tz}</small>}
          {editing === "new" && kind === "wecom_watch_sync" && (
            <label style={stack}>
              文件变动后等待（分钟）
              <input
                className="search-input"
                type="number"
                min={1}
                required
                style={control}
                value={quiet}
                onChange={(event) => setQuiet(event.target.value)}
              />
            </label>
          )}
          {editing === "new" && kind === "wecom_mail_poll" && (
            <label style={stack}>
              邮件关键词（选填）
              <input
                className="search-input"
                style={control}
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
              />
            </label>
          )}
          {editing === "new" && kind === "http_api_ingest" && (
            <label style={stack}>
              来源 URL
              <input
                type="url"
                className="search-input"
                required
                style={control}
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
              />
            </label>
          )}
          {editing === "new" && kind === "workspace_script" && (
            <>
              <label style={stack}>
                脚本解释器
                <select
                  className="search-input"
                  style={control}
                  value={runner}
                  onChange={(event) => setRunner(event.target.value as typeof runner)}
                >
                  <option value="python3">Python 3</option>
                  <option value="node">Node.js</option>
                  <option value="bash">Bash</option>
                </select>
              </label>
              <label style={stack}>
                脚本相对路径
                <input
                  className="search-input"
                  required
                  style={control}
                  value={detail}
                  onChange={(event) => setDetail(event.target.value)}
                />
              </label>
            </>
          )}
          {editing === "new" && kind === "agent_prompt" && (
            <label style={stack}>
              分析指令
              <textarea
                className="search-input"
                required
                style={control}
                rows={3}
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
              />
            </label>
          )}
          <details>
            <summary>产物写入协调</summary>
            <label>会更新的路径（每行一项）<textarea style={control} value={outputTargets} onChange={(event) => setOutputTargets(event.target.value)} placeholder="例如 投诉/投诉.html" /></label>
            <p>同时写到同一份产物时会等待，其他文件照常处理。</p>
          </details>
          {kind === "agent_prompt" && (
            <>
              <label>固定产物路径（可选）<input style={control} value={reportOutput} onChange={(event) => setReportOutput(event.target.value)} placeholder="例如 投诉/月报.md" /></label>
              {mode === "monthly" && <label>必需资料路径（每行一项，可选）<textarea style={control} value={reportInputs} onChange={(event) => setReportInputs(event.target.value)} /></label>}
            </>
          )}
          {formError && (
            <p role="alert" style={{ margin: 0, color: "var(--danger)" }}>
              {formError}
            </p>
          )}
          <div style={actions}>
            <button className="new-chat primary" disabled={loading} type="submit">
              {editing === "new" ? "保存为暂停" : "保存更改"}
            </button>
            <button className="new-chat" disabled={loading} type="button" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {!schedules.length && <p style={{ margin: 0, color: "var(--muted)" }}>此工作区还没有自动化。</p>}
      {schedules.map((item) => {
        const busy = item.state !== "idle";
        const status =
          item.state === "waiting_output" ? "等待同一产物更新" : item.state === "running_step1"
            ? "正在执行"
            : item.state === "running_step2"
              ? "等待归档"
              : item.enabled
                ? "已启用"
                : "已暂停";
        const history = runs.filter((run) => run.scheduleId === item.id);
        return (
          <article key={item.id} style={surface}>
            <h4 style={{ margin: 0 }}>{item.title}</h4>
            <div style={{ color: "var(--muted)" }}>
              {status} · {cadence(item)}
            </div>
            {item.enabled && item.nextRunAt != null && (
              <div>
                下次运行 {formatTime(item.nextRunAt, item.tz)}（{item.tz}）
              </div>
            )}
            {item.lastStatus && (
              <div>
                上次结果：{runLabels[item.lastStatus]} · {formatTime(item.lastFinishedAt, item.tz)}
              </div>
            )}
            {(item.lastError || item.lastSummary) && <div>{item.lastError || item.lastSummary}</div>}
            {!!item.lastUpdatedFiles?.length && (
              <div style={actions}>
                {item.lastUpdatedFiles.map((path) => (
                  <button type="button" className="new-chat" key={path} onClick={() => onOpenBoard(path)}>
                    {path}
                  </button>
                ))}
              </div>
            )}
            <div style={actions}>
              <button
                className="new-chat"
                type="button"
                disabled={loading || busy || !!pending}
                onClick={() => setPending({ action: "run_now", item })}
              >
                立即运行
              </button>
              {item.scheduleMode === "monthly" && item.executorKind === "agent_prompt" && (
                <button className="new-chat" type="button" disabled={loading || busy || !!pending} onClick={() => {
                  setPeriod(""); setBackfilling(item.id);
                }}>按期补跑</button>
              )}

              <button
                className="new-chat"
                type="button"
                disabled={loading || !!pending}
                onClick={() => act("toggle", item)}
              >
                {item.enabled ? "暂停" : "启用"}
              </button>
              <button
                className="new-chat"
                type="button"
                disabled={loading || busy || !!pending || !!editing}
                onClick={() => openForm(item)}
              >
                编辑计划
              </button>
              <button
                className="new-chat danger-btn"
                type="button"
                disabled={loading || busy || !!pending}
                onClick={() => setPending({ action: "remove", item })}
              >
                删除
              </button>
            </div>
            {pending?.item.id === item.id && (
              <div role="group" aria-label="确认操作" style={surface}>
                <p style={{ margin: 0 }}>
                  {pending.action === "run_now"
                    ? "立即运行会执行这条自动化，并可能更新数据或产物。"
                    : "删除后此规则将停止运行。"}
                </p>
                <div style={actions}>
                  <button
                    className={pending.action === "remove" ? "new-chat danger-btn" : "new-chat primary"}
                    type="button"
                    disabled={loading || busy}
                    onClick={() => {
                      act(pending.action, item);
                      setPending(null);
                    }}
                  >
                    {pending.action === "run_now" ? "确认立即运行" : "确认删除"}
                  </button>
                  <button className="new-chat" type="button" onClick={() => setPending(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}
            {backfilling === item.id && (
              <div role="group" aria-label="按期补跑" style={surface}>
                <label>统计月份 <input type="month" placeholder="YYYY-MM" value={period} onChange={(event) => { setPeriod(event.target.value); }} /></label>
                <div style={actions}>
                  <button className="new-chat" type="button" disabled={loading || busy || !/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(period)} onClick={() => backfill("backfill_preview", item)}>检查该期</button>
                  <button className="new-chat" type="button" onClick={() => setBackfilling(undefined)}>收起</button>
                </div>
                {preview && (
                  <>
                    <div role="status">{preview.versions ? `已有 ${preview.versions} 次结果` : "没有找到该期的历史结果"}。补跑不改变下次运行时间。</div>
                    {preview.files.map((path) => <button className="new-chat" type="button" key={path} onClick={() => onOpenBoard(path)}>{path}</button>)}
                    {preview.missingInputs.length > 0 && <p>缺少资料：{preview.missingInputs.join("、")}</p>}
                    {!preview.inputsDeclared && <p>规则未声明必需资料，运行时将检查数据覆盖范围。</p>}
                    <button className="new-chat primary" type="button" disabled={loading || busy || !!preview.missingInputs.length} onClick={() => backfill("backfill", item)}>
                      {preview.versions ? "生成新版本" : "补跑该期"}
                    </button>
                  </>
                )}
              </div>
            )}
            <details>
              <summary>运行记录{history.length ? `（${history.length}）` : ""}</summary>
              {!history.length && <p>暂无运行记录。</p>}
              {history.map((run) => renderRun(run, item.tz))}
            </details>
          </article>
        );
      })}
      {!!archivedRuns.length && (
        <details>
          <summary>已删除规则的运行记录（{archivedRuns.length}）</summary>
          {archivedRuns.map((run) => renderRun(run, "UTC", true))}
        </details>
      )}
    </section>
  );
}
