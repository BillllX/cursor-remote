// 终端输出浮窗（支持当前会话/工作区范围切换、状态筛选、关键字搜索、错误高亮、定位回合与快捷指令）
import { useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { filterShellRows, type ShellRow, type ShellStatusFilter } from "../../lib/chat/tools";
import styles from "./TerminalOverlay.module.css";

type TerminalOverlayProps = {
  terminalOpen: boolean;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  terminalTrap: RefObject<HTMLDivElement | null>;
  shellEntries: ShellRow[];
  workspaceShellEntries?: ShellRow[];
  terminalLogRef: RefObject<HTMLDivElement | null>;
  workspaceName?: string;
  chatTitle?: string;
  setNotice?: (msg: string) => void;
  onJumpToTurn?: (turnId: string, chatId?: string) => void;
  onSendCommandToComposer?: (promptText: string) => void;
};

const MAX_COLLAPSED_LINES = 36;
const TAIL_PREVIEW_LINES = 20;

const QUICK_COMMANDS = [
  { label: "查看 Git 状态", command: "git status -sb" },
  { label: "查看目录文件", command: "ls -la" },
  { label: "最近提交记录", command: "git log -n 5 --oneline" },
];

function clipLines(text: string, expanded: boolean): { text: string; totalLines: number; clipped: boolean } {
  const lines = text.split("\n");
  if (expanded || lines.length <= MAX_COLLAPSED_LINES) {
    return { text, totalLines: lines.length, clipped: false };
  }
  const head = lines.slice(0, 8).join("\n");
  const tail = lines.slice(-TAIL_PREVIEW_LINES).join("\n");
  const omitted = lines.length - 8 - TAIL_PREVIEW_LINES;
  return {
    text: `${head}\n… 已折叠中间 ${omitted} 行 …\n${tail}`,
    totalLines: lines.length,
    clipped: true,
  };
}

export function TerminalOverlay({
  terminalOpen,
  setTerminalOpen,
  terminalTrap,
  shellEntries,
  workspaceShellEntries,
  terminalLogRef,
  workspaceName = "工作区",
  chatTitle = "当前对话",
  setNotice,
  onJumpToTurn,
  onSendCommandToComposer,
}: TerminalOverlayProps) {
  const [scope, setScope] = useState<"session" | "workspace">("session");
  const [statusFilter, setStatusFilter] = useState<ShellStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [quickCmd, setQuickCmd] = useState("");

  const allWorkspaceRows = workspaceShellEntries ?? shellEntries;
  const baseRows = scope === "workspace" ? allWorkspaceRows : shellEntries;

  const counts = useMemo(() => {
    let running = 0;
    let failed = 0;
    let succeeded = 0;
    for (const row of baseRows) {
      if (row.running) running += 1;
      else if (row.failed) failed += 1;
      else succeeded += 1;
    }
    return { total: baseRows.length, running, failed, succeeded };
  }, [baseRows]);

  const filteredRows = useMemo(() => filterShellRows(baseRows, statusFilter, query), [baseRows, statusFilter, query]);

  function copyText(text: string, label: string) {
    const clip = navigator.clipboard;
    if (!clip?.writeText) {
      setNotice?.("复制失败");
      return;
    }
    void clip.writeText(text).then(
      () => setNotice?.(label),
      () => setNotice?.("复制失败"),
    );
  }

  function handleCopyAll() {
    if (!filteredRows.length) return;
    const text = filteredRows
      .map((row) => {
        const header = `# ${row.chatTitle ? `[${row.chatTitle}] ` : ""}第 ${row.turnIndex} 轮${row.exitCode != null ? ` (exit ${row.exitCode})` : ""}`;
        const body = row.output || (row.running ? "(正在运行…)" : "(无输出)");
        return `${header}\n$ ${row.command}\n${body}`;
      })
      .join("\n\n");
    copyText(text, `已复制 ${filteredRows.length} 条终端记录`);
  }

  function scrollToBottom() {
    const node = terminalLogRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }

  function handleQuickSubmit(cmdText: string) {
    const trimmed = cmdText.trim();
    if (!trimmed || !onSendCommandToComposer) return;
    onSendCommandToComposer(`请帮我执行终端命令并查看结果：\n\`\`\`sh\n${trimmed}\n\`\`\``);
    setQuickCmd("");
    setTerminalOpen(false);
  }

  function handleAskAgentForRow(row: ShellRow) {
    if (!onSendCommandToComposer) return;
    if (row.failed) {
      const errSnippet = (row.stderr || row.output || "").split("\n").slice(-20).join("\n");
      const prompt = errSnippet
        ? `终端命令 \`${row.command}\` 执行失败${row.exitCode ? `（退出码 ${row.exitCode}）` : ""}，请帮我排查原因并修复：\n\`\`\`\n${errSnippet}\n\`\`\``
        : `终端命令 \`${row.command}\` 执行失败，请帮我排查原因并重新执行。`;
      onSendCommandToComposer(prompt);
    } else {
      onSendCommandToComposer(`请再执行一次终端命令：\n\`\`\`sh\n${row.command}\n\`\`\``);
    }
    setTerminalOpen(false);
  }

  return (
    <div
      className={`search-overlay workspace-modal-overlay${terminalOpen ? " open" : ""}`}
      onClick={() => setTerminalOpen(false)}
    >
      <div
        ref={terminalTrap}
        className="search-box terminal-box workspace-modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="终端"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="workspace-modal-head">
          <div className="workspace-modal-heading">
            <div className="workspace-modal-title-row">
              <span className="loop-title workspace-modal-title">终端输出</span>
              <span className="workspace-modal-badge">{counts.total} 条命令</span>
              {counts.running > 0 ? (
                <span className={`${styles.statusBadge} ${styles.statusRun}`}>◉ {counts.running} 运行中</span>
              ) : null}
              {counts.failed > 0 ? (
                <span className={`${styles.statusBadge} ${styles.statusErr}`}>! {counts.failed} 失败</span>
              ) : null}
            </div>
            <div className="workspace-modal-sub">
              {workspaceName} · {scope === "session" ? `当前对话：${chatTitle}` : "当前工作区全部对话"}
            </div>
          </div>
          <div className="workspace-modal-actions">
            {filteredRows.length > 0 ? (
              <>
                <button type="button" className="workspace-modal-btn" onClick={() => setExpandAll((prev) => !prev)}>
                  {expandAll ? "智能折叠" : "全部展开"}
                </button>
                <button type="button" className="workspace-modal-btn" onClick={scrollToBottom}>
                  跳到底部
                </button>
                <button type="button" className="workspace-modal-btn" onClick={handleCopyAll}>
                  复制全部
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="files-browser-close workspace-modal-close"
              aria-label="关闭终端输出"
              title="关闭 (Esc)"
              onClick={() => setTerminalOpen(false)}
            >
              ×
            </button>
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.filterGroup} role="group" aria-label="终端输出范围">
            <button
              type="button"
              className={`${styles.filterPill}${scope === "session" ? ` ${styles.filterPillOn}` : ""}`}
              aria-pressed={scope === "session"}
              onClick={() => setScope("session")}
            >
              当前对话 ({shellEntries.length})
            </button>
            <button
              type="button"
              className={`${styles.filterPill}${scope === "workspace" ? ` ${styles.filterPillOn}` : ""}`}
              aria-pressed={scope === "workspace"}
              onClick={() => setScope("workspace")}
            >
              本工作区 ({allWorkspaceRows.length})
            </button>
          </div>

          <div className={styles.filterGroup} role="group" aria-label="命令状态筛选">
            {(
              [
                ["all", `全部 (${counts.total})`],
                ["running", `运行中 (${counts.running})`],
                ["failed", `失败 (${counts.failed})`],
                ["succeeded", `成功 (${counts.succeeded})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${styles.filterPill}${statusFilter === id ? ` ${styles.filterPillOn}` : ""}`}
                aria-pressed={statusFilter === id}
                onClick={() => setStatusFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className={styles.searchWrap}>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="搜索命令、目录或输出内容…"
              aria-label="搜索终端输出"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button type="button" className={styles.clearBtn} aria-label="清空终端搜索" onClick={() => setQuery("")}>
                ×
              </button>
            ) : null}
          </div>
        </div>

        {filteredRows.length ? (
          <div className="terminal-log" ref={terminalLogRef}>
            {filteredRows.map((row, index) => {
              const isLatest = index === filteredRows.length - 1;
              const isExpanded = expandAll || isLatest || row.running || Boolean(expandedIds[row.id]);
              const stdoutView = clipLines(row.stdout || (!row.stderr ? row.output : ""), isExpanded);
              const stderrView = clipLines(row.stderr, isExpanded);
              const hasLongOutput =
                (row.stdout || row.output).split("\n").length > MAX_COLLAPSED_LINES ||
                row.stderr.split("\n").length > MAX_COLLAPSED_LINES;

              return (
                <div
                  key={`${row.chatId || "cur"}:${row.id}:${index}`}
                  className={`terminal-row ${styles.card}${row.running ? ` ${styles.cardRunning}` : ""}${row.failed ? ` ${styles.cardFailed}` : ""}`}
                >
                  <div className={styles.cardHead}>
                    <div className={styles.cmdRow}>
                      <span
                        className={`${styles.statusBadge} ${
                          row.running ? styles.statusRun : row.failed ? styles.statusErr : styles.statusOk
                        }`}
                      >
                        {row.running
                          ? "◉ 运行中"
                          : row.failed
                            ? `! 失败${row.exitCode != null ? ` (${row.exitCode})` : ""}`
                            : `✓ 完成${row.exitCode != null ? ` (${row.exitCode})` : ""}`}
                      </span>
                      <code className={styles.cmd}>$ {row.command}</code>
                    </div>

                    <div className={styles.rowActions}>
                      {hasLongOutput ? (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() =>
                            setExpandedIds((prev) => ({
                              ...prev,
                              [row.id]: !isExpanded,
                            }))
                          }
                        >
                          {isExpanded
                            ? "折叠长输出"
                            : `展开全部 (${stdoutView.totalLines + (row.stderr ? stderrView.totalLines : 0)} 行)`}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => copyText(row.command, "已复制命令")}
                      >
                        复制命令
                      </button>
                      {row.output ? (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => copyText(row.output, "已复制输出")}
                        >
                          复制输出
                        </button>
                      ) : null}
                      {onJumpToTurn && row.turnId ? (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => {
                            onJumpToTurn(row.turnId, row.chatId);
                            setTerminalOpen(false);
                          }}
                        >
                          定位回合
                        </button>
                      ) : null}
                      {onSendCommandToComposer ? (
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${row.failed ? styles.actionBtnDanger : ""}`}
                          onClick={() => handleAskAgentForRow(row)}
                        >
                          {row.failed ? "让 Agent 排查" : "再跑一次"}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className={styles.metaRow}>
                    {scope === "workspace" && row.chatTitle ? (
                      <span className={styles.metaChip}>会话：{row.chatTitle}</span>
                    ) : null}
                    <span className={styles.metaChip}>第 {row.turnIndex} 轮</span>
                    {row.agent ? <span className={styles.metaChip}>代理：{row.agent}</span> : null}
                    {row.cwd ? (
                      <span className={styles.metaChip} title={row.cwd}>
                        目录：{row.cwd}
                      </span>
                    ) : null}
                    {row.description ? <span className={styles.metaDesc}>{row.description}</span> : null}
                  </div>

                  <div className={styles.outputWrap}>
                    {stdoutView.text ? (
                      <pre className="terminal-out">{stdoutView.text}</pre>
                    ) : !row.stderr ? (
                      <pre className="terminal-out muted">
                        {row.running ? "正在执行命令，等待实时输出…" : "命令执行完毕，无标准输出"}
                      </pre>
                    ) : null}

                    {row.stderr ? (
                      <div className={styles.stderrBlock}>
                        <div className={styles.stderrHeader}>STDERR · 错误或警告输出</div>
                        <pre className={`terminal-out ${styles.stderrPre}`}>{stderrView.text}</pre>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={`terminal-empty ${styles.emptyBox}`}>
            {baseRows.length > 0 ? (
              <>
                <div className={styles.emptyTitle}>没有匹配筛选条件的终端记录</div>
                <div className="loop-meta">当前共有 {baseRows.length} 条命令记录，可尝试清空搜索词或切换状态筛选。</div>
                <div className={styles.quickPresets}>
                  <button
                    type="button"
                    className="workspace-modal-btn"
                    onClick={() => {
                      setStatusFilter("all");
                      setQuery("");
                    }}
                  >
                    重置筛选条件
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={styles.emptyTitle}>
                  {scope === "session" ? "当前对话还没有终端命令输出" : "当前工作区还没有终端命令输出"}
                </div>
                <div className="loop-meta">
                  Agent 执行 Shell 命令时，命令、标准输出、错误日志与退出码都会实时汇总到这里。
                </div>
                {scope === "session" && allWorkspaceRows.length > 0 ? (
                  <div className={styles.quickPresets}>
                    <button type="button" className="new-chat primary" onClick={() => setScope("workspace")}>
                      查看本工作区其它会话的 {allWorkspaceRows.length} 条终端记录
                    </button>
                  </div>
                ) : null}
                {onSendCommandToComposer ? (
                  <div className={styles.quickSection}>
                    <div className="side-label">快捷指令（点击填入当前对话）</div>
                    <div className={styles.quickPresets}>
                      {QUICK_COMMANDS.map((item) => (
                        <button
                          key={item.command}
                          type="button"
                          className={styles.presetChip}
                          onClick={() => handleQuickSubmit(item.command)}
                        >
                          <span className={styles.presetPrompt}>$</span>
                          <span>{item.command}</span>
                          <span className={styles.presetLabel}>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        )}

        {onSendCommandToComposer ? (
          <form
            className={styles.quickBar}
            onSubmit={(event) => {
              event.preventDefault();
              handleQuickSubmit(quickCmd);
            }}
          >
            <span className={styles.quickPrompt} aria-hidden="true">
              $
            </span>
            <input
              type="text"
              className={styles.quickInput}
              placeholder="输入命令交给当前对话 Agent 执行（例如：git status、npm test）…"
              aria-label="输入终端命令交给 Agent 执行"
              value={quickCmd}
              onChange={(event) => setQuickCmd(event.target.value)}
            />
            <button type="submit" className="new-chat primary" disabled={!quickCmd.trim()}>
              填入对话执行
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
