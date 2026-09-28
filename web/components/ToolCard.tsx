import { useState, type ReactNode } from "react";
import { crewLabel } from "../lib/crew";
import { modelLabel } from "../lib/models";

type ToolCall = {
  callId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "running" | "completed" | "error";
  review?: "accepted" | "rejected";
  parentCallId?: string;
  agent?: string;
  model?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function field(args: unknown, ...keys: string[]): string {
  const record = asRecord(args);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function KindGlyph({ kind }: { kind: string }) {
  const d =
    kind === "search"
      ? "M11.5 11.5 15 15M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"
      : kind === "read"
        ? "M4 2.5h6l3 3V13.5H4Z"
        : kind === "edit" || kind === "write"
          ? "M3 13.5 12.5 4l2 2L5 15.5H3Z"
          : kind === "shell"
            ? "M3 5.5 7 8 3 10.5M8 12.5h5"
            : "M8 3v10M3 8h10";
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function toolKind(name: string, args?: unknown): "read" | "edit" | "write" | "shell" | "search" | "other" {
  const n = name.toLowerCase();
  if (/(todo|createplan)/.test(n)) return "other";
  if (/(shell|bash|terminal|command)/.test(n)) return "shell";
  if (/(grep|glob|search|find|ripgrep)/.test(n)) return "search";
  if (/(strreplace|replace|apply.?patch|editnotebook|edit)/.test(n)) return "edit";
  if (/(write|create|delete|unlink)/.test(n)) return "write";
  if (/(read|cat|open|getfile)/.test(n)) return "read";
  if (/(todo|task)/.test(n)) return "other";
  if (field(args, "globPattern", "glob", "glob_pattern", "pattern", "query")) return "search";
  return "other";
}

export function mutatingTool(name: string) {
  const kind = toolKind(name);
  return kind === "edit" || kind === "write";
}

function clip(text: string, max = 12_000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

function extractShell(result: unknown): { stdout: string; stderr: string; exit?: string } {
  if (result == null) return { stdout: "", stderr: "" };
  if (typeof result === "string") return { stdout: result, stderr: "" };
  const record = asRecord(result);
  const inner =
    record.result && typeof record.result === "object" ? asRecord(record.result) : record;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = inner[key];
      if (typeof value === "string" && value) return value;
      if (typeof value === "number") return String(value);
    }
    return "";
  };
  return {
    stdout: pick("stdout", "output", "out", "text"),
    stderr: pick("stderr", "err", "errorMessage", "error"),
    exit: pick("exitCode", "exit_code", "code", "status") || undefined,
  };
}

function pretty(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function toolPath(tool: { args?: unknown; result?: unknown }): string {
  return (
    field(tool.args, "path", "file", "target", "file_path", "uri") ||
    field(tool.result, "path", "file", "file_path")
  );
}

export function extractDiff(tool: ToolCall): { path: string; before: string; after: string; unified: string } {
  const args = tool.args;
  const result = tool.result;
  const path = toolPath(tool);
  const before =
    field(args, "old_string", "oldString", "oldText") ||
    field(result, "old_string", "oldString", "before", "original");
  const after =
    field(args, "new_string", "newString", "newText", "contents", "content") ||
    field(result, "new_string", "newString", "after", "updated", "contents", "content");
  const unified =
    field(args, "diff", "patch") ||
    field(result, "diff", "patch") ||
    (typeof result === "string" && /^(diff |@@ |\+|-)/m.test(result) ? result : "");
  return { path, before, after, unified };
}

function UnifiedDiff({ text }: { text: string }) {
  return (
    <pre className="diff-body">
      {text.split("\n").map((line, index) => {
        const type =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : "same";
        return (
          <div key={index} className={`diff-line ${type}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function lineDiff(before: string, after: string): Array<{ type: "same" | "del" | "add"; text: string }> {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 120_000) {
    const rows: Array<{ type: "same" | "del" | "add"; text: string }> = [];
    const max = Math.max(n, m);
    for (let i = 0; i < max; i += 1) {
      const a = oldLines[i];
      const b = newLines[i];
      if (a === b) {
        if (a != null) rows.push({ type: "same", text: a });
      } else {
        if (a != null) rows.push({ type: "del", text: a });
        if (b != null) rows.push({ type: "add", text: b });
      }
    }
    return rows;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const rev: Array<{ type: "same" | "del" | "add"; text: string }> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      rev.push({ type: "same", text: oldLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      rev.push({ type: "del", text: oldLines[i - 1] });
      i -= 1;
    } else {
      rev.push({ type: "add", text: newLines[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    rev.push({ type: "del", text: oldLines[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    rev.push({ type: "add", text: newLines[j - 1] });
    j -= 1;
  }
  return rev.reverse();
}

function DiffView({ before, after }: { before: string; after: string }) {
  const rows = lineDiff(before, after);
  return (
    <pre className="diff-body">
      {rows.map((row, index) => (
        <div key={index} className={`diff-line ${row.type}`}>
          <span className="diff-mark">
            {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
          </span>
          {row.text}
        </div>
      ))}
    </pre>
  );
}

function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

function firstPlusLine(unified: string): number | undefined {
  const match = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(unified);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isFinite(line) ? line : undefined;
}

export default function ToolCard({
  tool,
  settled,
  nested,
  nestedLive,
  onOpen,
  onAccept,
  onReject,
}: {
  tool: ToolCall;
  settled?: boolean;
  nested?: ReactNode;
  nestedLive?: boolean;
  onOpen?: (path: string, line?: number) => void;
  onAccept?: () => void;
  onReject?: () => void;
}) {
  const args = tool.args;
  const kind = toolKind(tool.name, args);
  const pathFromArgs = field(args, "path", "file", "target", "file_path", "uri");
  const command = field(args, "command");
  const pattern = field(args, "pattern", "query", "globPattern", "glob", "glob_pattern");
  const diff = extractDiff(tool);
  const path = diff.path || pathFromArgs;
  const roleLabel = crewLabel(tool.name, args, tool.agent);
  const model = tool.model ? modelLabel(tool.model) : "";
  const rawTitle =
    kind === "shell"
      ? command || tool.name
      : kind === "search"
        ? pattern || tool.name
        : roleLabel || /task|todo|agent|explore|builder|reviewer/i.test(tool.name)
          ? field(args, "content", "description", "title") || ""
          : path || (tool.name === "tool" ? pattern : tool.name);
  const title =
    kind === "read" || kind === "edit" || kind === "write"
      ? shortPath(path || rawTitle)
      : kind === "search" || kind === "shell"
        ? shortPath(rawTitle)
        : rawTitle;
  const label =
    roleLabel ||
    (kind === "shell"
      ? "Ran"
      : kind === "search"
        ? "Searched"
        : kind === "edit"
          ? "Edited"
          : kind === "write"
            ? "Wrote"
            : kind === "read"
              ? "Read"
              : /task/i.test(tool.name)
                ? "Task"
                : tool.name);
  const live = (tool.status === "running" && !settled) || Boolean(nestedLive);
  const showDiff = Boolean(diff.before || diff.after || diff.unified);
  const shell = kind === "shell" ? extractShell(tool.result) : { stdout: "", stderr: "" };
  const hasShellOut = Boolean(shell.stdout || shell.stderr || shell.exit);

  return (
    <details
      className={`tool kind-${kind}${nested ? " has-crew" : ""}${live ? " running" : ""}`}
      open={live}
    >
          <summary>
        <span className={`tool-dot ${live ? "running" : tool.status === "error" ? "error" : "completed"}`}>
          <KindGlyph kind={kind} />
        </span>
        <span className="tool-kind">{label}</span>
        <span
          className={`tool-title${path && onOpen ? " link" : ""}`}
          onClick={
            path && onOpen
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpen(path, firstPlusLine(diff.unified));
                }
              : undefined
          }
        >
          {title}
          {model ? ` · ${model}` : ""}
        </span>
        <span className={`tool-badge${live ? " run" : tool.status === "error" ? " err" : ""}`}>
          {live ? <span className="text-shimmer">Processing</span> : tool.status === "error" ? "Error" : "Completed"}
        </span>
        {tool.review === "accepted" ? <span className="tool-review-done">已保留</span> : null}
        {tool.review === "rejected" ? <span className="tool-review-done">已还原</span> : null}
      </summary>
      {showDiff && diff.unified ? (
        <UnifiedDiff text={diff.unified} />
      ) : showDiff && (diff.before || diff.after) ? (
        <DiffView before={diff.before} after={diff.after} />
      ) : kind === "shell" ? (
        <div className="shell-block">
          {command ? <pre className="shell-body">$ {command}</pre> : null}
          {shell.exit ? <div className="shell-exit">exit {shell.exit}</div> : null}
          {shell.stdout ? <pre className="shell-out">{clip(shell.stdout)}</pre> : null}
          {shell.stderr ? <pre className="shell-err">{clip(shell.stderr)}</pre> : null}
          {!hasShellOut && tool.result != null ? <pre>{clip(pretty(tool.result))}</pre> : null}
        </div>
      ) : kind === "search" ? null : args != null ? (
        <pre>{pretty(args)}</pre>
      ) : null}
      {tool.result != null && !showDiff && kind !== "shell" && kind !== "search" ? (
        <pre>{clip(pretty(tool.result))}</pre>
      ) : null}
      {!tool.review && tool.status !== "running" && (onAccept || onReject) ? (
        <div className="tool-review">
          {onReject ? (
            <button
              type="button"
              className="pill"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onReject();
              }}
            >
              还原
            </button>
          ) : null}
          {onAccept ? (
            <button
              type="button"
              className="pill"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onAccept();
              }}
            >
              保留
            </button>
          ) : null}
        </div>
      ) : null}
      {nested ? <div className="tool-crew">{nested}</div> : null}
    </details>
  );
}

export type AskedOption = { id: string; label: string };
export type AskedQuestion = {
  id: string;
  prompt: string;
  allowMultiple: boolean;
  options: AskedOption[];
};

export function parseAskQuestions(
  name: string,
  args: unknown,
): { title: string; questions: AskedQuestion[] } | null {
  if (!/ask.?question/i.test(name)) return null;
  const record = asRecord(args);
  if (!Array.isArray(record.questions)) return null;
  const questions: AskedQuestion[] = [];
  record.questions.forEach((item, index) => {
    const row = asRecord(item);
    const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
    if (!prompt) return;
    const id = typeof row.id === "string" && row.id ? row.id : `q${index}`;
    const allowMultiple = row.allowMultiple === true || row.allow_multiple === true;
    const options = (Array.isArray(row.options) ? row.options : []).flatMap((option, optIndex) => {
      const opt = asRecord(option);
      const label = typeof opt.label === "string" ? opt.label.trim() : "";
      if (!label) return [];
      const optionId = typeof opt.id === "string" && opt.id ? opt.id : `o${optIndex}`;
      return [{ id: optionId, label }];
    });
    questions.push({ id, prompt, allowMultiple, options });
  });
  if (!questions.length) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return { title, questions };
}

export function formatAskAnswer(
  title: string,
  questions: AskedQuestion[],
  picks: Record<string, string[]>,
  notes: Record<string, string>,
): string {
  const lines = [`对「${title || "刚才的问题"}」的回答：`];
  questions.forEach((question, index) => {
    const chosen = question.options
      .filter((option) => (picks[question.id] || []).includes(option.id))
      .map((option) => option.label);
    const note = (notes[question.id] || "").trim();
    let answer = chosen.join("、");
    if (note) answer = answer ? `${answer}（${note}）` : note;
    lines.push(`${index + 1}. ${question.prompt}`);
    lines.push(`回答：${answer}`);
  });
  lines.push("");
  lines.push("请按这些回答继续。");
  return lines.join("\n");
}

export function QuestionCard({
  asked,
  canAnswer,
  onAnswer,
}: {
  asked: { title: string; questions: AskedQuestion[] };
  canAnswer: boolean;
  onAnswer: (text: string) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const ready = asked.questions.every((question) => {
    const chosen = picks[question.id] || [];
    return chosen.length > 0 || Boolean((notes[question.id] || "").trim());
  });
  const toggle = (question: AskedQuestion, optionId: string) => {
    setPicks((prev) => {
      const current = prev[question.id] || [];
      const next = question.allowMultiple
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : current.length === 1 && current[0] === optionId
          ? []
          : [optionId];
      return { ...prev, [question.id]: next };
    });
  };
  return (
    <section className="ask-card">
      <h3>{asked.title || "需要你选一下"}</h3>
      <p className="ask-lead">
        {canAnswer
          ? "这一轮停在提问上。选好后会接着做。"
          : "模型问了这些问题。"}
      </p>
      {asked.questions.map((question, index) => (
        <div className="ask-q" key={question.id}>
          <p>
            {asked.questions.length > 1 ? `${index + 1}. ` : ""}
            {question.prompt}
          </p>
          {canAnswer ? (
            <>
              {question.options.map((option) => {
                const on = (picks[question.id] || []).includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`ask-opt${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => toggle(question, option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
              <textarea
                className="ask-note"
                rows={2}
                placeholder={question.options.length ? "也可以补充一句" : "写下回答"}
                value={notes[question.id] || ""}
                onChange={(event) =>
                  setNotes((prev) => ({ ...prev, [question.id]: event.target.value }))
                }
              />
            </>
          ) : (
            question.options.map((option) => (
              <span className="ask-opt" key={option.id}>
                {option.label}
              </span>
            ))
          )}
        </div>
      ))}
      {canAnswer ? (
        <button
          type="button"
          className="ask-send"
          disabled={!ready}
          onClick={() => onAnswer(formatAskAnswer(asked.title, asked.questions, picks, notes))}
        >
          按这个回答继续
        </button>
      ) : null}
    </section>
  );
}
