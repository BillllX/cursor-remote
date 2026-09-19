"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentMode,
  CheckpointInfo,
  ClientMessage,
  PromptImage,
  SearchHit,
  ServerMessage,
  HistoryTurn,
} from "../lib/protocol";
import ToolCard, { extractDiff, mutatingTool, toolKind, toolPath } from "./ToolCard";
import CodeBlock from "./CodeBlock";
import FileTree, { GIT_LABEL, FileGlyph } from "./FileTree";
import FilePreview, { type PreviewTab } from "./FilePreview";
import { isCanvasPath } from "../lib/canvas/path";
import { SAMPLE_CANVAS_PATH, SAMPLE_CANVAS_SOURCE } from "../lib/canvas/sample";
import type { CanvasAction } from "../lib/canvas/host";
import { isWideKind, kindFromPath, preferHttpText, tabKind } from "../lib/preview";
import { fetchPreviewText, peekPreviewText, putPreviewText } from "../lib/previewCache";
import {
  DEFAULT_MODEL,
  modelLabel,
  readLastModel,
  resolveModel,
  sessionModel,
  writeLastModel,
} from "../lib/models";
import ModelPicker from "./ModelPicker";
import { JieboMark as Mark } from "./JieboMark";
import { IconAgent, IconAsk, IconPlan, IconShield, IconWrite } from "./chromeIcons";

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

type Turn = {
  id: string;
  user: string;
  assistant: string;
  thinking: string;
  tools: ToolCall[];
  task?: string;
  error?: string;
  running: boolean;
  queued?: boolean;
  images?: PromptImage[];
  mode?: AgentMode;
  model?: string;
  todos?: TodoItem[];
  status?: string;
  durationMs?: number;
  pendingTool?: { callId: string; name: string; args?: unknown };
};

type Chat = {
  id: string;
  title: string;
  turns: Turn[];
  agentId?: string;
  draft?: string;
  model?: string;
  mode?: AgentMode;
  cwd?: string;
  previewTabs?: { path: string; line?: number }[];
  previewPath?: string;
  unread?: boolean;
  confirmWrites?: boolean;
  draftImages?: PromptImage[];
  checkpoints?: CheckpointInfo[];
};

function gatewayUrl() {
  if (typeof window === "undefined") return "ws://127.0.0.1:8787";
  const explicit = process.env.NEXT_PUBLIC_GATEWAY_WS;
  if (explicit) return explicit;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // 本地 Next 在 :3000，浏览器直连本机 gateway
  if (window.location.port === "3000") {
    const port = process.env.NEXT_PUBLIC_GATEWAY_PORT || "8787";
    return `${protocol}//${window.location.hostname}:${port}`;
  }
  // 公网：直连 nginx 反代后的 gateway（/bridge → /ws）
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${protocol}//${window.location.host}${base}/bridge`;
}

function uploadUrl(chatId: string, name: string) {
  const query = `chatId=${encodeURIComponent(chatId)}&name=${encodeURIComponent(name)}`;
  if (typeof window === "undefined") return `/upload?${query}`;
  if (window.location.port === "3000") {
    const port = process.env.NEXT_PUBLIC_GATEWAY_PORT || "8787";
    return `${window.location.protocol}//${window.location.hostname}:${port}/upload?${query}`;
  }
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  return `${base}/upload?${query}`;
}

function uid() {
  return crypto.randomUUID();
}

function isUntitled(title: string | undefined) {
  return !title || title === "新对话";
}

function useHeldOpen(open: boolean, ms = 280) {
  const [held, setHeld] = useState(open);
  useEffect(() => {
    if (open) {
      setHeld(true);
      return;
    }
    const id = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(id);
  }, [open, ms]);
  return open || held;
}

function padOverlaySheet() {
  return window.matchMedia("(max-width: 1366px) and (any-pointer: coarse), (max-width: 920px)").matches;
}

function useSheetDrag(open: boolean, onClose: () => void, edge: "left" | "right") {
  const ref = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || !open) return;
    const el: HTMLElement = node;

    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let vx = 0;
    let dragging = false;
    let tracking = false;
    let pointerId = -1;

    const width = () => el.getBoundingClientRect().width || 320;

    function setDrag(px: number, opacity: number) {
      el.style.setProperty("--sheet-drag", `${px}px`);
      el.classList.add("sheet-dragging");
      const scrim = scrimRef.current;
      if (scrim) {
        scrim.style.setProperty("--scrim-drag", String(opacity));
        scrim.classList.add("sheet-dragging");
      }
    }

    function clearDrag() {
      el.style.removeProperty("--sheet-drag");
      el.classList.remove("sheet-dragging");
      const scrim = scrimRef.current;
      if (scrim) {
        scrim.style.removeProperty("--scrim-drag");
        scrim.classList.remove("sheet-dragging");
      }
    }

    function onDown(event: PointerEvent) {
      if (!open || !padOverlaySheet()) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      tracking = true;
      dragging = false;
      pointerId = event.pointerId;
      startX = lastX = event.clientX;
      startY = event.clientY;
      lastT = performance.now();
      vx = 0;
    }

    function onMove(event: PointerEvent) {
      if (!tracking || event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const now = performance.now();
      vx = (event.clientX - lastX) / Math.max(1, now - lastT);
      lastX = event.clientX;
      lastT = now;
      if (!dragging) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        const dismissDir = edge === "left" ? dx < 0 : dx > 0;
        if (Math.abs(dy) > Math.abs(dx) || !dismissDir) {
          tracking = false;
          return;
        }
        dragging = true;
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      const travel = edge === "left" ? Math.min(0, dx) : Math.max(0, dx);
      const progress = Math.min(1, Math.abs(travel) / width());
      setDrag(travel, 1 - progress);
    }

    function onUp(event: PointerEvent) {
      if (!tracking || event.pointerId !== pointerId) return;
      tracking = false;
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      const dx = event.clientX - startX;
      const travel = edge === "left" ? Math.min(0, dx) : Math.max(0, dx);
      const progress = Math.abs(travel) / width();
      const flick = edge === "left" ? vx < -0.35 : vx > 0.35;
      clearDrag();
      if (progress > 0.28 || flick) onClose();
    }

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      clearDrag();
    };
  }, [open, onClose, edge]);

  return { ref, scrimRef };
}

function shortPadTitle(title: string | undefined, firstUser?: string) {
  if (!title || title === "新对话") return "新对话";
  const clip = (text: string) => (text.length > 32 ? `${text.slice(0, 32)}…` : text);
  const stripped = (firstUser || "")
    .replace(/@[^\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/[\u4e00-\u9fff]/.test(stripped)) return clip(stripped);
  const base = (title.split("/").filter(Boolean).pop() || title)
    .replace(/^@/, "")
    .replace(/[-_\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(base || "对话");
}

const EMPTY_STARTERS = [
  "看一下这个项目的结构",
  "最近改了哪些文件？",
  "用 Canvas 概括这个仓库",
];


function attachedFiles(text: string) {
  return [...text.matchAll(/@([^\s]+)/g)].map((match) => match[1]);
}

function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const upto = text.slice(0, caret);
  const match = upto.match(/(^|[\s])@([^\s]*)$/);
  if (!match) return null;
  const query = match[2];
  return { query, start: caret - query.length - 1 };
}

type TodoItem = { id: string; content: string; status: string };

function extractTodos(name: string, payload: unknown): TodoItem[] | null {
  if (!/todo/i.test(name)) return null;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const list = record.todos ?? record.items ?? record.merge;
  if (!Array.isArray(list)) return null;
  const items = list
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const content = typeof row.content === "string" ? row.content : typeof row.text === "string" ? row.text : "";
      if (!content) return null;
      return {
        id: typeof row.id === "string" ? row.id : String(index),
        content,
        status: typeof row.status === "string" ? row.status : "pending",
      };
    })
    .filter((item): item is TodoItem => Boolean(item));
  return items.length ? items : null;
}

function friendlyError(text: string) {
  if (/agent[- ].*not found/i.test(text)) return "这条会话在服务器上已经不在了，重试会开新的。";
  return text.replace(/agent-[a-z0-9-]+/gi, "Agent");
}

function formatDuration(ms?: number) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function searchQuery(tool: { args?: unknown }) {
  if (!tool.args || typeof tool.args !== "object") return "";
  const record = tool.args as Record<string, unknown>;
  for (const key of ["pattern", "query", "globPattern", "glob", "glob_pattern"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function isProgressBlurb(text: string) {
  const t = text.trim();
  return t.length > 0 && t.length < 100 && /^正在/.test(t) && !t.includes("\n");
}

function turnSuperseded(turns: Turn[], index: number) {
  const turn = turns[index];
  const next = turns[index + 1];
  if (!turn?.error || turn.running) return false;
  if (turn.assistant.trim()) return false;
  if (turn.tools.some((tool) => !/todo/i.test(tool.name))) return false;
  return Boolean(next && next.user.trim() === turn.user.trim());
}

function usableDraft(chat: { draft?: string; turns: Array<{ user?: string }> }) {
  const draft = (chat.draft || "").trim();
  if (!draft) return "";
  for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
    if ((chat.turns[i].user || "").trim() === draft) return "";
  }
  return chat.draft || "";
}

function runMeta(status?: string, ms?: number) {
  const key = (status || "").toLowerCase();
  const label =
    key === "cancelled" || key === "canceled"
      ? "已停止"
      : key === "error" || key === "failed"
        ? "出错"
        : key === "approval"
          ? "待确认"
          : "完成";
  const time = formatDuration(ms);
  return time ? `${label} · ${time}` : label;
}

function parseCite(language?: string): { path: string; line: number } | null {
  if (!language) return null;
  const numbered = /^(\d+):\d+:(.+)$/.exec(language);
  if (numbered) return { line: Number(numbered[1]), path: numbered[2] };
  const fileLine = /^(.+):(\d+)$/.exec(language);
  if (fileLine && (fileLine[1].includes("/") || isFileMention(fileLine[1]))) {
    return { path: fileLine[1], line: Number(fileLine[2]) };
  }
  return null;
}

function splitCiteParts(text: string) {
  const re = /@([^\s@:，。；、！？,;!?)]+)(?::(\d+)(?:-(\d+))?)?/g;
  const parts: { value: string; path?: string; line?: number; endLine?: number }[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ value: text.slice(last, match.index) });
    parts.push({
      value: match[0],
      path: match[1],
      line: match[2] ? Number(match[2]) : undefined,
      endLine: match[3] ? Number(match[3]) : undefined,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ value: text.slice(last) });
  return parts.length ? parts : [{ value: text }];
}

function escapeRe(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionChips(text: string) {
  return splitCiteParts(text).flatMap((part, index) =>
    part.path && isFileMention(part.path)
      ? [
          {
            key: `${index}-${part.value}`,
            token: part.value,
            path: part.path,
            line: part.line,
            endLine: part.endLine,
          },
        ]
      : [],
  );
}

function isFileMention(token: string) {
  return (
    /^diff$/i.test(token) ||
    token.endsWith("/") ||
    /[./:]/.test(token) ||
    /^(readme|license|makefile|dockerfile|changelog|gemfile|procfile|jenkinsfile)(\.[a-z0-9]+)?$/i.test(
      token,
    )
  );
}

function mentionExtras(paths: string[], query: string): string[] {
  const q = query.toLowerCase();
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return ["Diff", ...[...dirs].sort()]
    .filter((item) => !q || item.toLowerCase().includes(q))
    .slice(0, 16);
}

function mentionHits(paths: string[], query: string, remote: string[] = []): string[] {
  const q = query.toLowerCase();
  const files = [...remote, ...paths].filter((path) => {
    if (!q) return true;
    const base = path.split("/").pop() || path;
    return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...mentionExtras(paths, query), ...files]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= 40) break;
  }
  return out;
}

function isOpenableMention(path: string) {
  return !/^diff$/i.test(path) && !path.endsWith("/");
}

function stripMention(text: string, token: string) {
  return text
    .replace(new RegExp(`(^|\\s)${escapeRe(token)}(?=\\s|$)`), "$1")
    .replace(/[ \t]{2,}/g, " ");
}

function toolPreview(name: string, args: unknown) {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const bits = [name];
  for (const key of ["path", "command", "file", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) {
      bits.push(String(record[key]).slice(0, 72));
      break;
    }
  }
  return bits.join(" · ");
}

function Highlight({ text, query }: { text: string; query?: string }) {
  const q = query?.trim();
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, "ig"));
  const needle = q.toLowerCase();
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle ? (
          <mark key={index} className="find-mark">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function CiteText({
  text,
  onOpen,
  query,
}: {
  text: string;
  onOpen: (path: string, line?: number) => void;
  query?: string;
}) {
  return (
    <>
      {splitCiteParts(text).map((part, index) =>
        part.path ? (
          <button
            key={index}
            type="button"
            className="cite-ref"
            onClick={() => onOpen(part.path!, part.line)}
          >
            <Highlight text={part.value} query={query} />
          </button>
        ) : (
          <Highlight key={index} text={part.value} query={query} />
        ),
      )}
    </>
  );
}

function sameFile(a: string, b: string, cwd = "") {
  const n = (path: string) =>
    (relToCwd(path, cwd) || path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const left = n(a);
  const right = n(b);
  if (left === right) return true;
  if (left.startsWith("/") !== right.startsWith("/")) {
    const abs = left.startsWith("/") ? left : right;
    const rel = left.startsWith("/") ? right : left;
    return Boolean(rel) && abs.endsWith(`/${rel}`);
  }
  return false;
}

function relToCwd(path: string, cwd = "") {
  let p = path.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && (p === root || p.startsWith(`${root}/`))) {
    return p === root ? "" : p.slice(root.length + 1);
  }
  return p;
}

function normPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function sameCwd(a?: string, b?: string) {
  return normPath(a || "") === normPath(b || "");
}

function inWorkspaceRoot(path: string, root: string) {
  const abs = normPath(path);
  const base = normPath(root);
  if (!abs || !base) return false;
  return abs === base || abs.startsWith(`${base}/`);
}

function preferChatCwd(current?: string, incoming?: string) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (sameCwd(current, incoming)) return current;
  if (inWorkspaceRoot(current, incoming)) return current;
  return incoming;
}

function workspaceLabel(path: string, root: string) {
  const abs = normPath(path);
  const base = normPath(root);
  if (!abs) return base.split("/").filter(Boolean).pop() || "工作区";
  if (!base || abs === base) return base.split("/").filter(Boolean).pop() || abs || "工作区";
  if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
  return abs.split("/").filter(Boolean).pop() || abs;
}

function pathFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["path", "file", "target", "file_path"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return "";
}

function editPathsOf(turn: Turn): string[] {
  const paths: string[] = [];
  for (const tool of turn.tools) {
    if (!mutatingTool(tool.name)) continue;
    const path = pathFromPayload(tool.args) || pathFromPayload(tool.result);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function rejectMutatingTools(turn: Turn): Turn {
  return {
    ...turn,
    pendingTool: undefined,
    tools: turn.tools.map((tool) =>
      mutatingTool(tool.name) ? { ...tool, review: tool.review || "rejected" } : tool,
    ),
  };
}

function turnHasOpenTools(turn: Turn) {
  return turn.tools.some((tool) => tool.status === "running");
}

function settleOpenTools(turn: Turn, toolStatus: "completed" | "error"): Turn {
  if (!turnHasOpenTools(turn) && !turn.running && !turn.queued && !turn.pendingTool) return turn;
  return {
    ...turn,
    running: false,
    queued: false,
    pendingTool: undefined,
    tools: turn.tools.map((tool) =>
      tool.status === "running" ? { ...tool, status: toolStatus } : tool,
    ),
  };
}

function settleTurn(turn: Turn, status?: string, durationMs?: number): Turn {
  const key = (status || turn.status || "").toLowerCase();
  if (key === "approval") {
    return {
      ...turn,
      running: false,
      queued: false,
      status: status || turn.status,
      durationMs: durationMs ?? turn.durationMs,
    };
  }
  const failed = key === "cancelled" || key === "canceled" || key === "error";
  return {
    ...settleOpenTools(turn, failed ? "error" : "completed"),
    status: status || turn.status,
    durationMs: durationMs ?? turn.durationMs,
  };
}

function writesWereRejected(turn: Turn) {
  return /已拒绝写入/.test(`${turn.assistant || ""}\n${turn.status || ""}`);
}

function wrapCites(
  children: ReactNode,
  onOpen: (path: string, line?: number) => void,
  query?: string,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return <CiteText text={child} onOpen={onOpen} query={query} />;
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    const tag = child.type;
    if (
      typeof tag === "string" &&
      ["strong", "em", "b", "i", "span"].includes(tag) &&
      child.props.children
    ) {
      return cloneElement(child, undefined, wrapCites(child.props.children, onOpen, query));
    }
    return child;
  });
}

function gitLetterOf(path: string, gitStatus: Record<string, string>, cwd = "") {
  const rel = relToCwd(path, cwd) || path;
  if (gitStatus[rel]) return gitStatus[rel];
  if (gitStatus[path]) return gitStatus[path];
  const hit = Object.entries(gitStatus).find(([item]) => sameFile(item, rel) || sameFile(item, path));
  return hit?.[1];
}

function mergeRemoteChats(
  local: Chat[],
  remote: Chat[],
  deleted: Set<string> = new Set(),
): Chat[] {
  const drop = (chats: Chat[]) => chats.filter((chat) => !deleted.has(chat.id));
  local = drop(local);
  remote = drop(remote);
  if (!remote.length) return local;
  const localEmpty =
    !local.length ||
    (local.length === 1 &&
      !local[0].turns.length &&
      !local[0].agentId &&
      (local[0].id === "boot" || local[0].title === "新对话"));
  if (localEmpty) return stopOrphanRuns(remote);
  const weight = (chat: Chat) =>
    chat.turns.reduce(
      (n, turn) => n + (turn.user ? 1 : 0) + (turn.assistant ? 1 : 0) + turn.tools.length,
      0,
    );
  const localById = new Map(local.map((chat) => [chat.id, chat]));
  return stopOrphanRuns(
    remote.map((chat) => {
      const cur = localById.get(chat.id);
      if (!cur) return chat;
      if (cur.turns.some((turn) => turn.running) || weight(cur) > weight(chat)) {
        return {
          ...cur,
          agentId: cur.agentId || chat.agentId,
          cwd: preferChatCwd(cur.cwd, chat.cwd),
          draft: cur.draft || chat.draft,
          previewTabs: cur.previewTabs?.length ? cur.previewTabs : chat.previewTabs,
          previewPath: cur.previewPath || chat.previewPath,
        };
      }
      return {
        ...chat,
        cwd: preferChatCwd(cur.cwd, chat.cwd),
        draft: cur.draft || chat.draft,
        previewTabs: cur.previewTabs?.length ? cur.previewTabs : chat.previewTabs,
        previewPath: cur.previewPath || chat.previewPath,
        agentId: cur.agentId || chat.agentId,
      };
    }),
  );
}

function mergeToolOutput(
  result: unknown,
  message: { stream?: string; chunk?: string; stdout?: string; stderr?: string },
): unknown {
  const rec: Record<string, unknown> =
    result && typeof result === "object"
      ? { ...(result as Record<string, unknown>) }
      : { stdout: typeof result === "string" ? result : "", stderr: "" };
  if (typeof rec.stdout !== "string") rec.stdout = "";
  if (typeof rec.stderr !== "string") rec.stderr = "";
  if (message.stdout != null) rec.stdout = message.stdout;
  if (message.stderr != null) rec.stderr = message.stderr;
  if (message.chunk) {
    const key = message.stream === "stderr" ? "stderr" : "stdout";
    rec[key] = String(rec[key] || "") + message.chunk;
  }
  return rec;
}

function historyToTurns(items: HistoryTurn[]): Turn[] {
  return items.map((item) => ({
    id: item.id || uid(),
    user: item.user || "",
    assistant: item.assistant || "",
    thinking: item.thinking || "",
    tools: (item.tools || []).map((tool) => ({
      callId: tool.callId || uid(),
      name: tool.name,
      args: tool.args,
      result: tool.result,
      status: tool.status === "running" ? "completed" : tool.status,
      parentCallId: tool.parentCallId,
      agent: tool.agent,
      model: tool.model,
    })),
    running: false,
  }));
}

function mergeTools(local: Turn["tools"], remote: Turn["tools"]): Turn["tools"] {
  const out = [...local];
  for (const tool of remote) {
    const index = out.findIndex(
      (item) =>
        item.callId === tool.callId ||
        (item.name === tool.name && JSON.stringify(item.args) === JSON.stringify(tool.args)),
    );
    if (index < 0) {
      out.push({ ...tool, status: tool.status === "running" ? "completed" : tool.status });
      continue;
    }
    if (!out[index].result && tool.result) {
      out[index] = {
        ...out[index],
        result: tool.result,
        status: tool.status === "running" ? out[index].status : tool.status,
        parentCallId: out[index].parentCallId || tool.parentCallId,
        agent: out[index].agent || tool.agent,
        model: out[index].model || tool.model,
      };
    }
  }
  return out;
}

function mergeHistoryTurns(local: Turn[], incoming: Turn[]): Turn[] {
  if (!incoming.length) return local;
  const localHasContent = local.some(
    (turn) => turn.user.trim() || turn.assistant.trim() || turn.tools.length,
  );
  if (!localHasContent) return incoming;
  const fingerprint = (turn: Turn) => turn.user.trim().replace(/\s+/g, " ").slice(0, 240);
  const merged = local.map((turn) => ({ ...turn }));
  const byFp = new Map<string, number>();
  merged.forEach((turn, index) => {
    const fp = fingerprint(turn);
    if (fp && !byFp.has(fp)) byFp.set(fp, index);
  });
  const prefix: Turn[] = [];
  let seenLocal = false;
  for (const remote of incoming) {
    const fp = fingerprint(remote);
    if (!fp) continue;
    const index = byFp.get(fp);
    if (index == null) {
      if (!seenLocal) prefix.push({ ...remote, running: false });
      continue;
    }
    seenLocal = true;
    const cur = merged[index];
    if (cur.running) continue;
    merged[index] = {
      ...cur,
      assistant: remote.assistant.length > cur.assistant.length ? remote.assistant : cur.assistant,
      thinking: (remote.thinking || "").length > (cur.thinking || "").length ? remote.thinking || "" : cur.thinking,
      tools: mergeTools(cur.tools, remote.tools),
    };
  }
  return prefix.length ? [...prefix, ...merged] : merged;
}

const CHATS_KEY = "cursor-remote-chats";
const DELETED_KEY = "cursor-remote-deleted";
const TOKEN_KEY = "cursor-remote-token";
const RECENT_KEY = "cursor-remote-recent";
const MAX_DELETED = 200;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/jpg"]);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
const MAX_RECENT = 8;

function clearBrowserChatStore() {
  try {
    localStorage.removeItem(CHATS_KEY);
    localStorage.removeItem(DELETED_KEY);
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // private mode
  }
}

function pushRecent(prev: string[], path: string): string[] {
  if (!path.trim()) return prev;
  return [path, ...prev.filter((item) => item !== path)].slice(0, MAX_RECENT);
}

function slimChats(chats: Chat[]): Chat[] {
  return chats.map((chat) => ({
    ...chat,
    previewTabs: chat.previewTabs?.map(({ path, line }) => ({ path, line })),
    draftImages: chat.draftImages?.slice(0, 3),
    turns: chat.turns.map((turn, index, all) => {
      const { running, ...rest } = turn;
      const keepImages = index >= all.length - 20;
      const settled = settleTurn(
        { ...rest, images: keepImages ? turn.images : undefined, running: false },
        running ? turn.status || "cancelled" : turn.status,
      );
      return settled;
    }),
  }));
}

function stopOrphanRuns(chats: Chat[], keepIds?: Iterable<string>): Chat[] {
  const keep = keepIds ? new Set(keepIds) : null;
  return chats.map((chat) => {
    if (keep?.has(chat.id)) return chat;
    return {
      ...chat,
      turns: chat.turns.map((turn) =>
        turn.running || turn.queued || turnHasOpenTools(turn)
          ? settleTurn(turn, turn.status || "cancelled")
          : turn,
      ),
    };
  });
}

async function filesToImages(files: FileList | File[]): Promise<PromptImage[]> {
  const list = [...files].filter((file) => isPromptImageFile(file));
  const out: PromptImage[] = [];
  for (const file of list) {
    const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (!IMAGE_MIME.has(mime) || file.size > MAX_IMAGE_BYTES) continue;
    const data = await fileToBase64(file);
    if (data) out.push({ data, mimeType: mime });
  }
  return out;
}

function isPromptImageFile(file: File) {
  const mime = file.type === "image/jpg" ? "image/jpeg" : file.type;
  return IMAGE_MIME.has(mime) && file.size > 0 && file.size <= MAX_IMAGE_BYTES;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function formatUploadMb(bytes: number) {
  if (!bytes) return "0MB";
  return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
}

function rememberDeleted(prev: Set<string>, id: string): Set<string> {
  return new Set([id, ...prev].slice(0, MAX_DELETED));
}

function LoginGate({
  connected,
  verifying,
  error,
  value,
  onChange,
  onSubmit,
}: {
  connected: boolean;
  verifying: boolean;
  error: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const composingRef = useRef(false);
  return (
    <div className="login-gate">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (composingRef.current) return;
          onSubmit();
        }}
      >
        <Mark />
        <h1>接驳</h1>
        <p>网页说话，远端动手。先输入密码。</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          className="side-input"
          value={value}
          placeholder="密码"
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            window.setTimeout(() => {
              composingRef.current = false;
            }, 0);
          }}
        />
        {error ? <div className="error-line">{friendlyError(error)}</div> : null}
        <button type="submit" className="login-btn" disabled={!value.trim()}>
          {verifying ? "正在验证…" : "进入"}
        </button>
        <div className="login-status">
          {connected ? "已连上服务器" : "正在连 gateway…"}
        </div>
      </form>
    </div>
  );
}

export default function ChatApp() {
  const wsRef = useRef<WebSocket | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [cwd, setCwd] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaces, setWorkspaces] = useState<{ path: string; name: string }[]>([]);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceCreating, setWorkspaceCreating] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [authError, setAuthError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [mode, setMode] = useState<AgentMode>("agent");
  const [models, setModels] = useState<string[]>([DEFAULT_MODEL]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [draftCaret, setDraftCaret] = useState<number | null>(null);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [threadFindOpen, setThreadFindOpen] = useState(false);
  const [threadFindQ, setThreadFindQ] = useState("");
  const [threadFindIndex, setThreadFindIndex] = useState(0);
  const [grepOpen, setGrepOpen] = useState(false);
  const [grepQ, setGrepQ] = useState("");
  const searchShown = useHeldOpen(searchOpen);
  const paletteShown = useHeldOpen(paletteOpen);
  const grepShown = useHeldOpen(grepOpen);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesShown = useHeldOpen(filesOpen);
  const [filesQuery, setFilesQuery] = useState("");
  const [grepHits, setGrepHits] = useState<SearchHit[]>([]);
  const [grepIndex, setGrepIndex] = useState(0);
  const [grepWait, setGrepWait] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>([]);
  const [previewPath, setPreviewPath] = useState("");
  const [previewMax, setPreviewMax] = useState(false);
  const [fileHits, setFileHits] = useState<string[]>([]);
  const [treePaths, setTreePaths] = useState<string[]>([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const treePathsRef = useRef<string[]>([]);
  treePathsRef.current = treePaths;
  const [gitStatus, setGitStatus] = useState<Record<string, string>>({});
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([
    { id: "boot", title: "新对话", turns: [] },
  ]);
  const [activeId, setActiveId] = useState("boot");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [navReady, setNavReady] = useState(false);
  const [demoCanvas, setDemoCanvas] = useState(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setNavReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const closeNav = useCallback(() => setNavOpen(false), []);
  const closePreview = useCallback(() => setPreviewMax(false), []);
  const navDrag = useSheetDrag(navOpen, closeNav, "left");
  const previewDrag = useSheetDrag(previewMax, closePreview, "right");

  const active = useMemo(
    () => chats.find((chat) => chat.id === activeId) ?? chats[0],
    [chats, activeId],
  );
  const sidebarChats = useMemo(() => {
    const keep = new Set<string>();
    const seenEmpty = new Set<string>();
    for (const chat of chats) {
      const empty = chat.title === "新对话" && !chat.turns.length;
      if (!empty) {
        keep.add(chat.id);
        continue;
      }
      const key = normPath(chat.cwd || workspaceRoot);
      if (chat.id === activeId || !seenEmpty.has(key)) {
        keep.add(chat.id);
        seenEmpty.add(key);
      }
    }
    return chats.filter((chat) => keep.has(chat.id));
  }, [chats, activeId, workspaceRoot]);

  const recentWorkspaces = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; name: string }[] = [];
    for (const chat of chats) {
      const path = chat.cwd || workspaceRoot;
      if (!path) continue;
      const key = normPath(path);
      if (seen.has(key) || !inWorkspaceRoot(path, workspaceRoot || path)) continue;
      seen.add(key);
      out.push({ path, name: workspaceLabel(path, workspaceRoot) });
    }
    return out;
  }, [chats, workspaceRoot]);

  const catalogWorkspaces = useMemo(() => {
    const recent = new Set(recentWorkspaces.map((item) => normPath(item.path)));
    return workspaces.filter((item) => !recent.has(normPath(item.path)));
  }, [workspaces, recentWorkspaces]);

  const workspaceGroups = useMemo(() => {
    const root = workspaceRoot || cwd;
    const known = workspaces.length
      ? workspaces
      : root
        ? [{ path: root, name: workspaceLabel(root, root) }]
        : [];
    const byPath = new Map(known.map((item) => [normPath(item.path), { ...item, chats: [] as Chat[] }]));
    for (const chat of sidebarChats) {
      const key = normPath(chat.cwd || root);
      const cur = byPath.get(key);
      if (cur) cur.chats.push(chat);
      else {
        byPath.set(key, {
          path: chat.cwd || root,
          name: workspaceLabel(chat.cwd || root, root),
          chats: [chat],
        });
      }
    }
    return [...byPath.values()].filter(
      (group) => group.chats.length || (root && !sameCwd(group.path, root)),
    );
  }, [sidebarChats, workspaces, workspaceRoot, cwd]);

  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const scrollMap = useRef<Record<string, number>>({});
  const draftRef = useRef(draft);
  const imagesRef = useRef<Record<string, PromptImage[]>>({});
  const newChatRef = useRef<() => void>(() => {});
  const startChatInRef = useRef<(path: string) => void>(() => {});
  const searchOpenRef = useRef(false);
  const paletteOpenRef = useRef(false);
  const threadFindOpenRef = useRef(false);
  const grepOpenRef = useRef(false);
  const filesOpenRef = useRef(false);
  const grepQRef = useRef("");
  const appliedStoreRef = useRef(false);
  const stateRevRef = useRef(0);
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const renameSkipRef = useRef(false);
  const previewTabsRef = useRef(previewTabs);
  previewTabsRef.current = previewTabs;
  const previewPathRef = useRef(previewPath);
  previewPathRef.current = previewPath;
  const previewMaxRef = useRef(previewMax);
  previewMaxRef.current = previewMax;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const pendingUploadsRef = useRef(
    new Map<string, { resolve: (path: string) => void; reject: (err: Error) => void; timer: number }>(),
  );
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;
  const outboxRef = useRef<ClientMessage[]>([]);
  const pendingHelloRef = useRef<Extract<ClientMessage, { type: "hello" }> | null>(null);
  const verifyTimerRef = useRef<number | undefined>(undefined);
  const lastProgressRef = useRef<Record<string, number>>({});
  const stallNoticedRef = useRef<Set<string>>(new Set());
  const tenantIdRef = useRef("");

  function resetTenantSession() {
    const boot: Chat = { id: "boot", title: "新对话", turns: [] };
    chatsRef.current = [boot];
    setChats([boot]);
    activeIdRef.current = "boot";
    setActiveId("boot");
    appliedStoreRef.current = false;
    stateRevRef.current = 0;
    deletedIdsRef.current = new Set();
    lastProgressRef.current = {};
    stallNoticedRef.current.clear();
    outboxRef.current = [];
    draftRef.current = "";
    setDraft("");
    setCwd("");
    setWorkspaceRoot("");
    setWorkspaces([]);
    setPreviewTabs([]);
    setPreviewPath("");
    setCheckpoints([]);
    setRecentFiles([]);
    setTreePaths([]);
    setGitStatus({});
    setImages([]);
    setError("");
  }

  const send = useCallback((message: ClientMessage) => {
    if (message.type !== "hello" && !unlockedRef.current) {
      outboxRef.current = [...outboxRef.current, message].slice(-50);
      return;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return;
    }
    if (message.type === "hello") {
      pendingHelloRef.current = message;
      return;
    }
    outboxRef.current = [...outboxRef.current, message].slice(-50);
  }, []);

  const flushOutbox = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pending = outboxRef.current;
    outboxRef.current = [];
    for (const message of pending) {
      if (message.type === "hello") continue;
      ws.send(JSON.stringify(message));
    }
  }, []);

  const rememberRecent = useCallback((path: string) => {
    if (!path.trim() || !isOpenableMention(path)) return;
    setRecentFiles((prev) => pushRecent(prev, path));
  }, []);

  const patchChat = useCallback((chatId: string, updater: (chat: Chat) => Chat) => {
    setChats((prev) => {
      const next = prev.map((chat) => (chat.id === chatId ? updater(chat) : chat));
      chatsRef.current = next;
      return next;
    });
  }, []);

  const patchActive = useCallback(
    (updater: (chat: Chat) => Chat) => {
      patchChat(activeIdRef.current, updater);
    },
    [patchChat],
  );

  const patchRunningTurnIn = useCallback(
    (chatId: string, updater: (turn: Turn) => Turn) => {
      patchChat(chatId, (chat) => {
        let index = -1;
        for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
          if (chat.turns[i].running) {
            index = i;
            break;
          }
        }
        if (index < 0) return chat;
        const turns = chat.turns.slice();
        turns[index] = updater(turns[index]);
        return { ...chat, turns };
      });
    },
    [patchChat],
  );

  const patchOpenTurnIn = useCallback(
    (chatId: string, updater: (turn: Turn) => Turn) => {
      patchChat(chatId, (chat) => {
        let index = -1;
        for (let i = chat.turns.length - 1; i >= 0; i -= 1) {
          if (chat.turns[i].running || turnHasOpenTools(chat.turns[i])) {
            index = i;
            break;
          }
        }
        if (index < 0) return chat;
        const turns = chat.turns.slice();
        turns[index] = updater(turns[index]);
        return { ...chat, turns };
      });
    },
    [patchChat],
  );

  const stopChat = useCallback(
    (chatId: string) => {
      send({ type: "cancel", chatId });
      patchChat(chatId, (chat) => ({
        ...chat,
        turns: chat.turns.map((turn) =>
          turn.running || turnHasOpenTools(turn) ? settleTurn(turn, "cancelled") : turn,
        ),
      }));
    },
    [patchChat, send],
  );

  const busy = Boolean(active?.turns.some((turn) => turn.running));
  const modelRef = useRef(model);
  modelRef.current = model;
  const lastModelRef = useRef("");
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const confirmWritesRef = useRef(false);
  confirmWritesRef.current = Boolean(active?.confirmWrites);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const workspaceMenuOpenRef = useRef(false);
  workspaceMenuOpenRef.current = workspaceMenuOpen;
  const mentionQueryRef = useRef(mentionQuery);
  mentionQueryRef.current = mentionQuery;
  const mentionRangeRef = useRef<{ query: string; start: number } | null>(null);
  const draftSaveTimerRef = useRef(0);
  const mentionSearchTimerRef = useRef(0);
  const peekDiffAtRef = useRef<Record<string, number>>({});
  const replayQuietUntilRef = useRef(0);
  const previewWantedRef = useRef<Set<string>>(new Set());
  const previewTriesRef = useRef<Record<string, number>>({});
  const httpHydratedRef = useRef<Set<string>>(new Set());

  const flushQueue = useCallback(
    (chatId: string) => {
      const chat = chatsRef.current.find((item) => item.id === chatId);
      if (!chat || chat.turns.some((turn) => turn.running)) return;
      const next = chat.turns.find((turn) => turn.queued);
      if (!next) return;
      patchChat(chatId, (current) => {
        const index = current.turns.findIndex((turn) => turn.id === next.id && turn.queued);
        if (index < 0) return current;
        const turns = current.turns.slice();
        turns[index] = { ...turns[index], queued: false, running: true };
        return { ...current, turns };
      });
      send({
        type: "prompt",
        text: next.user,
        model: next.model || modelRef.current,
        mode: next.mode || modeRef.current,
        chatId,
        files: attachedFiles(next.user),
        images: next.images,
        confirmWrites: Boolean(chat.confirmWrites),
        nameChat: isUntitled(chat.title),
      });
    },
    [patchChat, send],
  );

  const sendQueued = useCallback(
    (turnId: string) => {
      if (busyRef.current) return;
      const chatId = activeIdRef.current;
      const chat = chatsRef.current.find((item) => item.id === chatId);
      const next = chat?.turns.find((turn) => turn.id === turnId && turn.queued);
      if (!next) return;
      patchChat(chatId, (current) => {
        const index = current.turns.findIndex((turn) => turn.id === turnId && turn.queued);
        if (index < 0) return current;
        const turns = current.turns.slice();
        turns[index] = { ...turns[index], queued: false, running: true };
        return { ...current, turns };
      });
      send({
        type: "prompt",
        text: next.user,
        model: next.model || modelRef.current,
        mode: next.mode || modeRef.current,
        chatId,
        files: attachedFiles(next.user),
        images: next.images,
        confirmWrites: Boolean(chat?.confirmWrites),
        nameChat: isUntitled(chat?.title),
      });
    },
    [patchChat, send],
  );

  const dropQueued = useCallback(
    (turnId: string) => {
      const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
      const turn = chat?.turns.find((item) => item.id === turnId && item.queued);
      patchActive((item) => ({
        ...item,
        turns: item.turns.map((row) =>
          row.id === turnId && row.queued
            ? { ...row, queued: false, running: false, status: "cancelled" }
            : row,
        ),
      }));
      send({ type: "drop_queued", chatId: activeIdRef.current, text: turn?.user });
    },
    [patchActive, send],
  );

  const onServer = useCallback(
    (message: ServerMessage) => {
      const chatId =
        "chatId" in message && message.chatId ? message.chatId : activeIdRef.current;
      if (
        chatId &&
        (message.type === "text-delta" ||
          message.type === "thinking-delta" ||
          message.type === "tool-started" ||
          message.type === "tool-completed" ||
          message.type === "tool-output" ||
          message.type === "task" ||
          (message.type === "status" &&
            (message.status === "RUNNING" || message.status === "CREATING")))
      ) {
        lastProgressRef.current[chatId] = Date.now();
        stallNoticedRef.current.delete(chatId);
      }
      if (chatId && (message.type === "done" || message.type === "error")) {
        delete lastProgressRef.current[chatId];
        stallNoticedRef.current.delete(chatId);
      }
      if (
        chatId &&
        chatId !== activeIdRef.current &&
        (message.type === "text-delta" ||
          message.type === "thinking-delta" ||
          message.type === "tool-started" ||
          message.type === "done" ||
          message.type === "error" ||
          message.type === "approval")
      ) {
        patchChat(chatId, (chat) => (chat.unread ? chat : { ...chat, unread: true }));
      }
      switch (message.type) {
        case "ready":
          {
            const nextTenant = message.tenantId || "";
            if (tenantIdRef.current && nextTenant && tenantIdRef.current !== nextTenant) {
              resetTenantSession();
            }
            if (nextTenant) tenantIdRef.current = nextTenant;
            const reconnected = unlockedRef.current;
            if (reconnected) setNotice("已重新连上服务器");
            unlockedRef.current = true;
            setUnlocked(true);
            setVerifying(false);
            if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
            setAuthError("");
            if (tokenRef.current) localStorage.setItem(TOKEN_KEY, tokenRef.current);
            setHasApiKey(message.hasApiKey);
            {
              const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
              setCwd(chat?.cwd || message.cwd);
            }
            if (message.workspaceRoot) setWorkspaceRoot(message.workspaceRoot);
            else setWorkspaceRoot((prev) => prev || message.cwd);
            setChats((prev) => {
              const keep = [...(message.runningChatIds || []), ...(message.queuedChatIds || [])];
              const queued = new Set(message.queuedChatIds || []);
              return stopOrphanRuns(prev, keep).map((chat) => {
                if (!queued.has(chat.id)) return chat;
                if (chat.turns.some((turn) => turn.queued || turn.running)) return chat;
                const last = [...chat.turns].reverse().find((turn) => turn.user.trim());
                if (!last) return chat;
                return {
                  ...chat,
                  turns: chat.turns.map((turn) =>
                    turn.id === last.id ? { ...turn, queued: true } : turn,
                  ),
                };
              });
            });
            {
              const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
              const nextModel = resolveModel(
                sessionModel(chat) || lastModelRef.current || modelRef.current,
                message.models,
                message.model,
              );
              if (nextModel) {
                modelRef.current = nextModel;
                setModel(nextModel);
                rememberLastModel(nextModel);
                if (chat && chat.model !== nextModel) {
                  patchChat(chat.id, (item) =>
                    item.model === nextModel ? item : { ...item, model: nextModel },
                  );
                }
                if (chat) send({ type: "set_model", model: nextModel, chatId: chat.id });
              }
              if (chat?.mode) {
                modeRef.current = chat.mode;
                setMode(chat.mode);
              }
              if (chat?.cwd && chat.cwd !== message.cwd) {
                send({ type: "set_workspace", cwd: chat.cwd, chatId: chat.id });
              }
              const live = message.runningChatIds?.includes(chat?.id || "") ?? false;
              if (chat?.agentId && !live && !reconnected) {
                send({ type: "resume_session", chatId: chat.id, agentId: chat.agentId });
              }
            }
            if (message.models.length) setModels(message.models);
            if (!message.hasApiKey) {
              setError("服务器还没配模型密钥，先写进网关配置。");
            } else {
              setError("");
            }
            send({ type: "list_files", query: "", chatId: activeIdRef.current });
            for (const tab of previewTabsRef.current) {
              previewWantedRef.current.add(tab.path);
              send({ type: "read_file", path: tab.path, chatId: activeIdRef.current, diff: tab.diff || undefined });
            }
            flushOutbox();
            if (!reconnected) {
              const serverQueued = new Set(message.queuedChatIds || []);
              for (const chat of chatsRef.current) {
                if (serverQueued.has(chat.id)) continue;
                if (
                  chat.turns.some((turn) => turn.queued) &&
                  !chat.turns.some((turn) => turn.running)
                ) {
                  flushQueue(chat.id);
                }
              }
            }
          }
          break;
        case "auth":
          unlockedRef.current = false;
          setUnlocked(false);
          setVerifying(false);
          if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
          if (!message.ok) {
            setAuthError(message.message || "密码不对。");
            localStorage.removeItem(TOKEN_KEY);
          }
          break;
        case "stored_state":
          {
            const remoteRev = typeof message.rev === "number" ? message.rev : 0;
            if (appliedStoreRef.current && remoteRev <= stateRevRef.current) break;
            if (!Array.isArray(message.chats)) break;
            appliedStoreRef.current = true;
            if (remoteRev > stateRevRef.current) stateRevRef.current = remoteRev;
            if (Array.isArray(message.deletedIds)) {
              deletedIdsRef.current = new Set(
                [...deletedIdsRef.current, ...message.deletedIds].slice(0, MAX_DELETED),
              );
            }
            if (!message.chats.length) break;
            const merged = mergeRemoteChats(
              chatsRef.current,
              message.chats as Chat[],
              deletedIdsRef.current,
            );
            setChats(merged);
            const current = merged.find((item) => item.id === activeIdRef.current);
            const keep = current || merged[0];
            if (keep && !current) {
              setActiveId(keep.id);
              {
                const value = usableDraft(keep);
                draftRef.current = value;
                setDraft(value);
                setComposerEpoch((n) => n + 1);
              }
              {
                const nextModel = sessionModel(keep) || lastModelRef.current || modelRef.current;
                if (nextModel) {
                  modelRef.current = nextModel;
                  setModel(nextModel);
                  rememberLastModel(nextModel);
                  if (keep.model !== nextModel) {
                    patchChat(keep.id, (item) =>
                      item.model === nextModel ? item : { ...item, model: nextModel },
                    );
                  }
                }
              }
              if (keep.mode) {
                modeRef.current = keep.mode;
                setMode(keep.mode);
              }
              if (keep.cwd) {
                setCwd(keep.cwd);
              }
              const tabs = keep.previewTabs || [];
              if (tabs.length) {
                setPreviewTabs(
                  tabs.map((tab) => ({
                    path: tab.path,
                    line: tab.line,
                    kind: kindFromPath(tab.path),
                  })),
                );
                setPreviewPath(keep.previewPath || tabs[0].path);
                setPreviewMax(false);
              }
            }
            if (keep?.agentId && !keep.turns.length) {
              send({ type: "resume_session", chatId: keep.id, agentId: keep.agentId });
            }
          }
          break;
        case "session":
          if (message.chatId) {
            const chat = chatsRef.current.find((item) => item.id === message.chatId);
            const nextCwd = preferChatCwd(chat?.cwd, message.cwd);
            if (message.chatId === activeIdRef.current && nextCwd) setCwd(nextCwd);
            patchChat(message.chatId, (item) => ({
              ...item,
              cwd: nextCwd || item.cwd,
              agentId: message.agentId || undefined,
            }));
          } else if (message.cwd) {
            const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
            const nextCwd = preferChatCwd(chat?.cwd, message.cwd);
            if (nextCwd) setCwd(nextCwd);
            patchActive((item) => {
              const cwd = preferChatCwd(item.cwd, message.cwd);
              return cwd === item.cwd ? item : { ...item, cwd };
            });
          }
          if (
            !message.chatId ||
            (message.chatId === activeIdRef.current && !message.agentId)
          ) {
            send({
              type: "list_files",
              query: "",
              chatId: message.chatId || activeIdRef.current,
            });
          }
          break;
        case "files":
          if (message.chatId && message.chatId !== activeIdRef.current) break;
          if (message.mention) {
            if (mentionQueryRef.current == null || message.query !== mentionQueryRef.current) break;
            setFileHits(
              mentionHits(
                treePathsRef.current.length ? treePathsRef.current : message.paths,
                message.query,
                message.paths,
              ),
            );
          } else {
            setTreePaths(message.paths);
            setGitStatus(message.status || {});
            setTreeTruncated(Boolean(message.truncated));
          }
          break;
        case "search_hits":
          if (message.chatId && message.chatId !== activeIdRef.current) break;
          if (message.query.trim() === grepQRef.current.trim()) {
            setGrepHits(message.hits);
            setGrepWait(false);
          }
          break;
        case "tool-output":
          patchRunningTurnIn(chatId, (turn) => {
            const tools = [...turn.tools];
            const index = tools.findIndex((tool) => tool.callId === message.callId);
            if (index < 0) {
              tools.push({
                callId: message.callId,
                name: "shell",
                status: "running",
                result: mergeToolOutput(undefined, message),
              });
            } else {
              tools[index] = {
                ...tools[index],
                result: mergeToolOutput(tools[index].result, message),
              };
            }
            return { ...turn, tools };
          });
          break;
        case "pong":
          break;
        case "chat_title": {
          const title = message.title.trim();
          if (!message.chatId || !title) break;
          patchChat(message.chatId, (chat) => (isUntitled(chat.title) ? { ...chat, title } : chat));
          break;
        }
        case "history":
          patchChat(chatId, (chat) => {
            const incoming = historyToTurns(Array.isArray(message.turns) ? message.turns : []);
            if (!incoming.length) return chat;
            const turns = mergeHistoryTurns(chat.turns, incoming);
            return turns === chat.turns ? chat : { ...chat, turns };
          });
          break;
        case "status":
          if (message.message) setNotice(message.message);
          if (message.status === "RUNNING" || message.status === "CREATING") {
            patchChat(chatId, (chat) => {
              const last = [...chat.turns].reverse().find((turn) => turn.user || turn.running);
              if (!last || last.running) return chat;
              return {
                ...chat,
                turns: chat.turns.map((turn) =>
                  turn.id === last.id ? { ...turn, running: true, queued: false, status: message.status } : turn,
                ),
              };
            });
          }
          if (/已拒绝写入/.test(message.message || "")) {
            patchChat(chatId, (chat) => {
              const last = [...chat.turns].reverse().find((turn) => turn.running || turn.pendingTool || turn.tools.length);
              if (!last) return chat;
              return {
                ...chat,
                turns: chat.turns.map((turn) => (turn.id === last.id ? rejectMutatingTools(turn) : turn)),
              };
            });
          }
          break;
        case "text-delta":
          patchRunningTurnIn(chatId, (turn) => ({
            ...turn,
            assistant: turn.assistant + message.text,
          }));
          break;
        case "thinking-delta":
          patchRunningTurnIn(chatId, (turn) => ({
            ...turn,
            thinking: turn.thinking + message.text,
          }));
          break;
        case "tool-started":
          patchRunningTurnIn(chatId, (turn) => {
            const tools = turn.tools.filter((tool) => tool.callId !== message.callId);
            tools.push({
              callId: message.callId,
              name: message.name,
              args: message.args,
              status: "running",
              parentCallId: message.parentCallId,
              agent: message.agent,
              model: message.model,
            });
            return { ...turn, tools };
          });
          {
            const args = message.args;
            const todos = extractTodos(message.name, args);
            if (todos) {
              patchRunningTurnIn(chatId, (turn) => ({ ...turn, todos }));
            }
            if (args && typeof args === "object") {
              const record = args as Record<string, unknown>;
              for (const key of ["path", "file", "target", "file_path"]) {
                if (typeof record[key] === "string" && record[key]) {
                  rememberRecent(record[key]);
                  break;
                }
              }
            }
            if (mutatingTool(message.name) && chatId === activeIdRef.current && !confirmWritesRef.current) {
              const path = relToCwd(pathFromPayload(message.args), cwdRef.current);
              const kind = path ? kindFromPath(path) : "text";
              const skipDiff =
                kind === "canvas" || kind === "markdown" || kind === "html" || kind === "pdf" || kind === "audio";
              if (path && !skipDiff) {
                const now = Date.now();
                if ((peekDiffAtRef.current[path] || 0) < now - 400) {
                  peekDiffAtRef.current[path] = now;
                  setPreviewTabs((prev) => {
                    const existing = prev.find((tab) => sameFile(tab.path, path, cwdRef.current));
                    if (existing) {
                      return prev.map((tab) =>
                        sameFile(tab.path, path, cwdRef.current)
                          ? { ...tab, diff: true, content: existing.diff ? tab.content : undefined, error: undefined }
                          : tab,
                      );
                    }
                    return [...prev, { path, diff: true }].slice(-8);
                  });
                  setPreviewPath(path);
                  send({ type: "read_file", path, chatId, diff: true });
                }
              }
            }
          }
          break;
        case "tool-completed":
          patchOpenTurnIn(chatId, (turn) => {
            const existing = turn.tools.find((tool) => tool.callId === message.callId);
            if (existing?.status === "error" && message.status === "completed") {
              return turn;
            }
            const tools = turn.tools.filter((tool) => tool.callId !== message.callId);
            tools.push({
              callId: message.callId,
              name: message.name,
              args: existing?.args,
              result: message.result,
              status: message.status,
              review: existing?.review,
              parentCallId: existing?.parentCallId || message.parentCallId,
              agent: existing?.agent || message.agent,
              model: existing?.model || message.model,
            });
            const todos =
              extractTodos(message.name, existing?.args) ||
              extractTodos(message.name, message.result);
            return { ...turn, tools, todos: todos || turn.todos };
          });
          if (chatId === activeIdRef.current) {
            const running = chatsRef.current
              .find((chat) => chat.id === chatId)
              ?.turns.find((turn) => turn.running);
            const args = running?.tools.find((tool) => tool.callId === message.callId)?.args;
            const path = relToCwd(
              pathFromPayload(args) || pathFromPayload(message.result),
              cwdRef.current,
            );
            if (path && mutatingTool(message.name || running?.tools.find((tool) => tool.callId === message.callId)?.name || "")) {
              send({ type: "list_files", query: "", chatId });
              const kind = kindFromPath(path);
              const skipDiff =
                kind === "canvas" ||
                kind === "markdown" ||
                kind === "html" ||
                kind === "pdf" ||
                kind === "audio";
              const tab = previewTabsRef.current.find((item) => sameFile(item.path, path, cwdRef.current));
              previewWantedRef.current.add(tab?.path || path);
              if (!tab) {
                setPreviewTabs((prev) =>
                  prev.some((item) => sameFile(item.path, path, cwdRef.current))
                    ? prev
                    : [...prev, { path, diff: !skipDiff, kind }].slice(-8),
                );
                setPreviewPath(path);
              }
              send({
                type: "read_file",
                path: tab?.path || path,
                chatId,
                diff: skipDiff ? undefined : true,
              });
            } else if (path) {
              const tab = previewTabsRef.current.find((item) => sameFile(item.path, path, cwdRef.current));
              if (tab) {
                send({
                  type: "read_file",
                  path: tab.path,
                  chatId,
                  diff: tab.diff || undefined,
                });
              }
            }
          }
          break;
        case "task":
          patchRunningTurnIn(chatId, (turn) => ({ ...turn, task: message.text }));
          break;
        case "approval":
          patchRunningTurnIn(chatId, (turn) => ({
            ...turn,
            pendingTool: { callId: message.callId, name: message.name, args: message.args },
          }));
          break;
        case "error":
          setError(message.message);
          patchOpenTurnIn(chatId, (turn) =>
            settleTurn(
              {
                ...turn,
                error: message.message,
              },
              "error",
            ),
          );
          break;
        case "done":
          patchOpenTurnIn(chatId, (turn) => {
            const next = settleTurn(turn, message.status, message.durationMs);
            return writesWereRejected(next) || writesWereRejected(turn)
              ? rejectMutatingTools(next)
              : next;
          });
          {
            if (chatId === activeIdRef.current && mentionQueryRef.current == null) {
              send({ type: "list_files", query: "", chatId });
              for (const tab of previewTabsRef.current) {
                send({
                  type: "read_file",
                  path: tab.path,
                  chatId,
                  diff: tab.diff || undefined,
                });
              }
            }
          }
          break;
        case "undone":
          setNotice(
            message.error
              ? message.error
              : message.paths.length
                ? `已还原 ${message.paths.join(", ")}`
                : "没有可还原的改动",
          );
          if (!message.chatId || message.chatId === activeIdRef.current) {
            send({ type: "list_files", query: "", chatId: activeIdRef.current });
            for (const tab of previewTabsRef.current) {
              send({
                type: "read_file",
                path: tab.path,
                chatId: activeIdRef.current,
                diff: tab.diff || undefined,
              });
            }
          }
          break;
        case "run_meta":
          patchRunningTurnIn(chatId, (turn) => ({
            ...turn,
            model: message.model || turn.model,
            mode: message.mode || turn.mode,
          }));
          break;
        case "checkpoints":
          patchChat(message.chatId, (chat) => ({ ...chat, checkpoints: message.items }));
          if (message.chatId === activeIdRef.current) {
            setCheckpoints(message.items);
            const newest = message.items[0];
            if (newest && Date.now() - newest.createdAt < 5000) {
              setNotice(`已记下检查点 ${newest.label}`);
            }
          }
          break;
        case "restored":
          if (message.silent) {
            replayQuietUntilRef.current = Date.now() + 12_000;
            send({ type: "list_files", query: "", chatId: activeIdRef.current });
            break;
          }
          setNotice(
            message.error
              ? message.error
              : `已还原检查点 ${message.label || message.checkpointId || ""}`,
          );
          send({ type: "list_files", query: "", chatId: activeIdRef.current });
          for (const tab of previewTabsRef.current) {
            send({ type: "read_file", path: tab.path, chatId: activeIdRef.current, diff: tab.diff || undefined });
          }
          break;
        case "file_content":
          {
            const cwd = cwdRef.current;
            const match = (path: string) => sameFile(path, message.path, cwd);
            if (message.chatId && message.chatId !== activeIdRef.current) break;
            if (message.diff && message.error === "没有未提交的改动") {
              send({ type: "read_file", path: message.path, chatId: activeIdRef.current });
              setPreviewTabs((prev) =>
                prev.map((tab) => (match(tab.path) ? { ...tab, diff: false, error: undefined } : tab)),
              );
              break;
            }
            if (message.error && /读不了|不是文件|不在工作区/.test(message.error)) {
              if (Date.now() < replayQuietUntilRef.current) break;
              const had = previewTabsRef.current.find((tab) => match(tab.path));
              if (had?.content) break;
              setPreviewTabs((prev) =>
                prev.map((tab) =>
                  match(tab.path)
                    ? { ...tab, error: "文件已不在当前工作区，换工作区后再打开，或关掉这个预览。" }
                    : tab,
                ),
              );
              setNotice(`${message.path} 已不在工作区`);
              break;
            }
            const patch = {
              content: message.content,
              error: message.error,
              diff: kindFromPath(message.path) === "canvas" ? false : Boolean(message.diff),
              kind: message.kind || kindFromPath(message.path),
              mime: message.mime,
              size: message.size,
              url: message.url,
              headUrl: message.headUrl,
              media: message.media,
            };
            if (typeof message.content === "string") putPreviewText(message.path, message.content);
            setPreviewTabs((prev) => {
              const idx = prev.findIndex((tab) => match(tab.path));
              if (idx < 0) {
                const wanted =
                  match(previewPathRef.current) ||
                  [...previewWantedRef.current].some((path) => match(path));
                if (!wanted) return prev;
                return [
                  ...prev,
                  {
                    path: relToCwd(message.path, cwd) || message.path,
                    ...patch,
                    content: message.content,
                  },
                ].slice(-8);
              }
              previewWantedRef.current.delete(prev[idx].path);
              delete previewTriesRef.current[prev[idx].path];
              return prev.map((tab, index) =>
                index === idx
                  ? {
                      ...tab,
                      ...patch,
                      content: message.content ?? tab.content,
                      kind: message.kind || tab.kind || kindFromPath(message.path),
                      mime: message.mime ?? tab.mime,
                      size: message.size ?? tab.size,
                      url: message.url ?? tab.url,
                      media: message.media ?? tab.media,
                    }
                  : tab,
              );
            });
          }
          break;
        case "file_written":
          if (message.error) {
            setError(message.error);
            break;
          }
          setNotice(`已保存 ${message.path}`);
          send({ type: "list_files", query: "", chatId: activeIdRef.current });
          send({
            type: "read_file",
            path: message.path,
            chatId: activeIdRef.current,
          });
          break;
        case "file_uploaded": {
          const pending = message.id ? pendingUploadsRef.current.get(message.id) : undefined;
          if (pending) {
            pendingUploadsRef.current.delete(message.id!);
            window.clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error));
            else if (message.path) pending.resolve(message.path);
            else pending.reject(new Error("上传失败"));
            break;
          }
          setUploading((n) => Math.max(0, n - 1));
          if (message.error) {
            setError(message.name ? `${message.name}：${message.error}` : message.error);
            break;
          }
          if (message.path) {
            const path = message.path;
            const token = `@${path} `;
            if (message.chatId && message.chatId !== activeIdRef.current) {
              patchChat(message.chatId, (chat) => {
                const draft = chat.draft || "";
                if (draft.includes(`@${path}`)) return chat;
                return {
                  ...chat,
                  draft: `${draft}${draft && !draft.endsWith(" ") ? " " : ""}${token}`,
                };
              });
            } else {
              const current = draftRef.current;
              if (!current.includes(`@${path}`)) {
                const next = `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${token}`;
                draftRef.current = next;
                setDraft(next);
                setComposerEpoch((n) => n + 1);
                setDraftCaret(next.length);
                patchChat(activeIdRef.current, (chat) =>
                  chat.draft === next ? chat : { ...chat, draft: next },
                );
              }
            }
            rememberRecent(path);
            send({ type: "list_files", query: "", chatId: message.chatId || activeIdRef.current });
            setNotice(`已添加 ${path}`);
          }
          break;
        }
        case "fs_done":
          if (message.error) {
            setError(message.error);
            break;
          }
          setNotice(
            message.op === "delete"
              ? `已删除 ${message.path}`
              : message.op === "rename"
                ? `已重命名为 ${message.to || message.path}`
                : `已创建 ${message.to || message.path}`,
          );
          send({ type: "list_files", query: "", chatId: activeIdRef.current });
          if (message.op === "delete") {
            setPreviewTabs((prev) => prev.filter((tab) => !sameFile(tab.path, message.path)));
            setPreviewPath((prev) => (sameFile(prev, message.path) ? "" : prev));
          } else if (message.op === "rename" && message.to) {
            setPreviewTabs((prev) =>
              prev.map((tab) => (sameFile(tab.path, message.path) ? { ...tab, path: message.to! } : tab)),
            );
            setPreviewPath((prev) => (sameFile(prev, message.path) ? message.to! : prev));
            send({ type: "read_file", path: message.to, chatId: activeIdRef.current });
          } else if (message.op === "create") {
            send({ type: "read_file", path: message.path, chatId: activeIdRef.current });
            setPreviewTabs((prev) =>
              prev.some((tab) => sameFile(tab.path, message.path))
                ? prev
                : [...prev, { path: message.path, content: "" }].slice(-8),
            );
            setPreviewPath(message.path);
          }
          break;
        case "workspaces":
          setWorkspaceRoot(message.root);
          setWorkspaces(message.items);
          setCwd((prev) => (prev && inWorkspaceRoot(prev, message.root) ? prev : message.root));
          setChats((prev) =>
            prev.map((chat) => {
              if (!chat.cwd || !inWorkspaceRoot(chat.cwd, message.root)) {
                return { ...chat, cwd: message.root };
              }
              return chat;
            }),
          );
          break;
        case "workspace_created":
          setWorkspaces((prev) =>
            prev.some((item) => sameCwd(item.path, message.path))
              ? prev
              : [...prev, { path: message.path, name: message.name }],
          );
          setWorkspaceCreating(false);
          setWorkspaceNameDraft("");
          startChatInRef.current(message.path);
          break;
        default:
          break;
      }
    },
    [flushQueue, flushOutbox, patchChat, patchOpenTurnIn, patchRunningTurnIn, rememberRecent, send],
  );

  const onServerRef = useRef(onServer);
  onServerRef.current = onServer;

  useEffect(() => {
    if (!connected || !unlocked) return;
    const pending = previewTabs.filter((tab) => {
      if (tab.error || tab.content != null) return false;
      const kind = tabKind(tab.path, tab.kind);
      if (kind === "image" || kind === "pdf" || kind === "audio" || kind === "video") return false;
      if (kind === "svg" && tab.url) return false;
      return true;
    });
    if (!pending.length) return;
    const timer = window.setTimeout(() => {
      for (const tab of pending) {
        const tries = (previewTriesRef.current[tab.path] || 0) + 1;
        previewTriesRef.current[tab.path] = tries;
        if (tries > 4) {
          setPreviewTabs((prev) =>
            prev.map((item) =>
              sameFile(item.path, tab.path, cwdRef.current)
                ? { ...item, error: "预览超时。关掉这个页签再点一次文件。" }
                : item,
            ),
          );
          continue;
        }
        previewWantedRef.current.add(tab.path);
        send({
          type: "read_file",
          path: tab.path,
          chatId: activeIdRef.current,
          diff: tab.diff || undefined,
        });
      }
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [previewTabs, connected, unlocked, send]);

  useEffect(() => {
    if (!unlocked) return;
    const jobs = previewTabs.filter((tab) => {
      if (tab.diff || !tab.url) return false;
      const kind = tabKind(tab.path, tab.kind);
      if (!preferHttpText(kind)) return false;
      return tab.content == null;
    });
    for (const tab of jobs) {
      const key = `${tab.path}|${tab.url}`;
      if (httpHydratedRef.current.has(key)) continue;
      httpHydratedRef.current.add(key);
      const cached = peekPreviewText(tab.path);
      if (cached != null && tab.content == null) {
        setPreviewTabs((prev) =>
          prev.map((item) =>
            sameFile(item.path, tab.path, cwdRef.current) && item.content == null
              ? { ...item, content: cached }
              : item,
          ),
        );
      }
      fetchPreviewText(tab.url as string)
        .then((text) => {
          putPreviewText(tab.path, text);
          setPreviewTabs((prev) =>
            prev.map((item) =>
              sameFile(item.path, tab.path, cwdRef.current)
                ? { ...item, content: text, error: undefined }
                : item,
            ),
          );
        })
        .catch(() => {
          httpHydratedRef.current.delete(key);
          if (peekPreviewText(tab.path) != null) return;
          previewWantedRef.current.add(tab.path);
          send({
            type: "read_file",
            path: tab.path,
            chatId: activeIdRef.current,
            diff: tab.diff || undefined,
          });
        });
    }
  }, [
    unlocked,
    send,
    previewTabs.map((tab) => `${tab.path}:${tab.url || ""}:${tab.diff ? 1 : 0}`).join("|"),
  ]);

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
    const last = readLastModel();
    if (last) {
      lastModelRef.current = last;
      modelRef.current = last;
      setModel(last);
    }
    clearBrowserChatStore();
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("canvas") !== "demo") return;
    setDemoCanvas(true);
    setPreviewTabs([
      { path: SAMPLE_CANVAS_PATH, kind: "canvas", content: SAMPLE_CANVAS_SOURCE, diff: false },
    ]);
    setPreviewPath(SAMPLE_CANVAS_PATH);
    setPreviewMax(true);
  }, []);

  useEffect(() => {
    if (!unlockedRef.current) return;
    if (chats.length === 1 && chats[0].id === "boot") return;
    const timer = window.setTimeout(() => {
      stateRevRef.current += 1;
      send({ type: "sync_state", chats: slimChats(chats), rev: stateRevRef.current });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [chats, send]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const chat of chatsRef.current) {
        if (!chat.turns.some((turn) => turn.running || turnHasOpenTools(turn))) continue;
        const last = lastProgressRef.current[chat.id];
        if (!last || now - last < 90_000 || stallNoticedRef.current.has(chat.id)) continue;
        stallNoticedRef.current.add(chat.id);
        if (chat.id === activeIdRef.current) {
          setNotice("这一轮没有新进展。如果一直转圈，点停止再发一次。");
        }
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (chats.length === 1 && chats[0].id === "boot") return;
    const slim = previewTabs.map(({ path, line }) => ({ path, line }));
    patchActive((chat) => {
      const same =
        JSON.stringify(chat.previewTabs || []) === JSON.stringify(slim) &&
        (chat.previewPath || "") === previewPath;
      return same ? chat : { ...chat, previewTabs: slim, previewPath };
    });
  }, [previewTabs, previewPath, patchActive]);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const close = () => {
      setWorkspaceMenuOpen(false);
      setWorkspaceCreating(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [workspaceMenuOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        if (workspaceMenuOpenRef.current) {
          setWorkspaceMenuOpen(false);
          setWorkspaceCreating(false);
          return;
        }
        if (paletteOpenRef.current) {
          setPaletteOpen(false);
          return;
        }
        if (grepOpenRef.current) {
          setGrepOpen(false);
          return;
        }
        if (filesOpenRef.current) {
          setFilesOpen(false);
          setFilesQuery("");
          return;
        }
        if (searchOpenRef.current) {
          setSearchOpen(false);
          return;
        }
        if (threadFindOpenRef.current) {
          setThreadFindOpen(false);
          return;
        }
        if (previewMaxRef.current && previewTabsRef.current.length) {
          setPreviewMax(false);
          return;
        }
        if (busyRef.current) stopChat(activeIdRef.current);
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newChatRef.current();
      }
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(false);
        setThreadFindOpen(false);
        setGrepOpen(false);
        setSearchOpen(true);
        setSearchQ("");
      }
      if (meta && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setSearchOpen(false);
        setThreadFindOpen(false);
        setGrepOpen(false);
        setPaletteOpen((open) => !open);
        setPaletteQ("");
        setPaletteIndex(0);
      }
      if (meta && event.key.toLowerCase() === "f") {
        if (event.shiftKey) {
          event.preventDefault();
          setSearchOpen(false);
          setPaletteOpen(false);
          setThreadFindOpen(false);
          setGrepOpen(true);
          return;
        }
        const node = event.target;
        const inPreview =
          node instanceof Element && node.closest(".file-preview")
            ? true
            : Boolean(document.activeElement?.closest(".file-preview"));
        if (inPreview) return;
        event.preventDefault();
        setSearchOpen(false);
        setPaletteOpen(false);
        setThreadFindOpen(true);
        setThreadFindIndex(0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [send, stopChat]);

  useEffect(() => {
    if (!paletteOpen) return;
    if (!treePaths.length) send({ type: "list_files", query: "", chatId: activeIdRef.current });
  }, [paletteOpen, send, treePaths.length]);

  useEffect(() => {
    if (!filesOpen) return;
    if (!treePaths.length) send({ type: "list_files", query: "", chatId: activeIdRef.current });
  }, [filesOpen, send, treePaths.length]);

  useEffect(() => {
    if (!grepOpen) return;
    if (!grepQ.trim()) {
      setGrepHits([]);
      setGrepWait(false);
      return;
    }
    setGrepWait(true);
    setGrepHits([]);
    const timer = window.setTimeout(() => {
      send({ type: "search_text", query: grepQ.trim(), chatId: activeIdRef.current });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [grepOpen, grepQ, send]);

  useEffect(() => {
    return () => {
      if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
      if (mentionSearchTimerRef.current) window.clearTimeout(mentionSearchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    let raf = 0;
    let lastKb = -1;
    let lastOpen = false;
    const measure = () => {
      const vv = window.visualViewport;
      // Hardware keyboards pan visualViewport.scroll on every caret move.
      // Only the occluded height from a software keyboard should shift layout.
      const occluded = vv ? Math.max(0, window.innerHeight - vv.height) : 0;
      const kb = occluded > 100 ? Math.round(occluded) : 0;
      const open = kb > 100;
      if (kb === lastKb && open === lastOpen) return;
      lastKb = kb;
      lastOpen = open;
      root.style.setProperty("--kb", `${kb}px`);
      root.classList.toggle("kb-open", open);
    };
    const sync = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    window.visualViewport?.addEventListener("resize", sync);
    window.addEventListener("resize", sync);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.visualViewport?.removeEventListener("resize", sync);
      window.removeEventListener("resize", sync);
      root.style.removeProperty("--kb");
      root.classList.remove("kb-open");
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    let heartbeat: number | undefined;

    const connect = () => {
      if (retry) {
        window.clearTimeout(retry);
        retry = undefined;
      }
      const prev = wsRef.current;
      if (prev) {
        prev.onclose = null;
        prev.onerror = null;
        prev.onopen = null;
        prev.onmessage = null;
        if (prev.readyState === WebSocket.OPEN || prev.readyState === WebSocket.CONNECTING) {
          prev.close();
        }
      }
      const ws = new WebSocket(gatewayUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        if (closed || wsRef.current !== ws) return;
        setConnected(true);
        setAuthError((prev) => (prev.startsWith("还没连上") ? "" : prev));
        const queued = pendingHelloRef.current;
        pendingHelloRef.current = null;
        const saved = queued?.token || localStorage.getItem(TOKEN_KEY) || tokenRef.current.trim();
        if (saved) {
          if (!unlockedRef.current) setVerifying(true);
          send({ type: "hello", token: saved });
          if (!unlockedRef.current) {
            if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
            verifyTimerRef.current = window.setTimeout(() => {
              if (unlockedRef.current) return;
              setVerifying(false);
              setAuthError("验证超时，请再试一次。");
            }, 20000);
          }
        }
      };
      ws.onmessage = (event) => {
        try {
          onServerRef.current(JSON.parse(String(event.data)) as ServerMessage);
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        setConnected(false);
        if (!unlockedRef.current) {
          setVerifying(false);
        } else {
          setNotice("正在重连服务器…");
        }
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };

    connect();
    heartbeat = window.setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ping" }));
    }, 25000);
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      if (heartbeat) window.clearInterval(heartbeat);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [send]);

  const scrollThreadToEnd = useCallback(() => {
    const run = () => {
      const el = threadRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      scrollMap.current[activeIdRef.current] = el.scrollTop;
    };
    run();
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    window.setTimeout(run, 80);
    window.setTimeout(run, 320);
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (busy) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const saved = scrollMap.current[activeId];
    if (saved != null) el.scrollTop = saved;
    else el.scrollTop = el.scrollHeight;
  }, [active?.turns, busy, activeId]);

  const previewMaxWasRef = useRef(previewMax);
  useEffect(() => {
    const was = previewMaxWasRef.current;
    previewMaxWasRef.current = previewMax;
    if (!was || previewMax) return;
    scrollThreadToEnd();
  }, [previewMax, scrollThreadToEnd]);

  function submit(raw?: string) {
    if (raw != null) draftRef.current = raw;
    const text = draftRef.current.trim();
    if (!text && !images.length) return;
    const attached = images.slice(0, MAX_IMAGES);
    syncComposer("");
    setImages([]);
    imagesRef.current[activeIdRef.current] = [];
    setError("");
    setNotice("");
    lastProgressRef.current[activeIdRef.current] = Date.now();
    stallNoticedRef.current.delete(activeIdRef.current);
    const turn: Turn = {
      id: uid(),
      user: text || "（附图）",
      assistant: "",
      thinking: "",
      tools: [],
      running: !busyRef.current,
      queued: busyRef.current,
      images: attached.length ? attached : undefined,
      mode: modeRef.current,
      model: modelRef.current,
    };
    const current = chatsRef.current.find((item) => item.id === activeIdRef.current);
    patchActive((chat) => ({
      ...chat,
      draft: "",
      turns: [
        ...chat.turns.map((item) => (item.pendingTool ? { ...item, pendingTool: undefined } : item)),
        turn,
      ],
    }));
    send({
      type: "prompt",
      text: text || "请看附图。",
      model: modelRef.current,
      mode: modeRef.current,
      chatId: activeIdRef.current,
      files: attachedFiles(text),
      images: attached.length ? attached : undefined,
      confirmWrites: confirmWritesRef.current,
      nameChat: isUntitled(current?.title),
    });
  }

  function submitNewWorkspace() {
    const name = workspaceNameDraft.trim();
    if (!name) return;
    send({ type: "create_workspace", name });
  }

  function stashView() {
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = 0;
    }
    const id = activeIdRef.current;
    if (threadRef.current) scrollMap.current[id] = threadRef.current.scrollTop;
    const text = draftRef.current;
    imagesRef.current[id] = images;
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === id
          ? { ...chat, draft: text, draftImages: images, model: modelRef.current, mode: modeRef.current, cwd: chat.cwd || cwdRef.current, previewTabs: previewTabsRef.current.map(({ path, line }) => ({ path, line })), previewPath: previewPathRef.current }
          : chat,
      ),
    );
  }

  function startChatIn(path: string) {
    const next = path.trim() || workspaceRoot;
    if (!next) return;
    persistMode("agent");
    const nextModel = lastModelRef.current || modelRef.current;
    const empties = chatsRef.current.filter(
      (chat) =>
        chat.title === "新对话" &&
        !chat.turns.length &&
        sameCwd(chat.cwd || workspaceRoot, next),
    );
    setWorkspaceMenuOpen(false);
    setWorkspaceCreating(false);
    setWorkspaceNameDraft("");
    setNavOpen(false);
    if (empties.length) {
      const keep = {
        ...empties[0],
        mode: "agent" as AgentMode,
        cwd: next,
        model: empties[0].model || nextModel,
      };
      if (empties.length > 1) {
        const drop = new Set(empties.slice(1).map((chat) => chat.id));
        setChats((prev) => prev.filter((chat) => !drop.has(chat.id)));
      }
      patchChat(keep.id, (chat) => ({
        ...chat,
        mode: "agent",
        cwd: next,
        model: chat.model || nextModel,
      }));
      selectChat({ ...keep, cwd: next });
      return;
    }
    stashView();
    const chat = {
      id: uid(),
      title: "新对话",
      turns: [],
      draft: "",
      model: nextModel,
      mode: "agent" as AgentMode,
      cwd: next,
      confirmWrites: confirmWritesRef.current,
    };
    setChats((prev) => [chat, ...prev]);
    setActiveId(chat.id);
    if (nextModel) {
      modelRef.current = nextModel;
      setModel(nextModel);
    }
    syncComposer("");
    setImages([]);
    setSearchOpen(false);
    setCheckpoints([]);
    setPreviewTabs([]);
    setPreviewPath("");
    setPreviewMax(false);
    setThreadFindOpen(false);
    setGrepOpen(false);
    send({ type: "new_session", chatId: chat.id, cwd: next });
    if (nextModel) send({ type: "set_model", model: nextModel, chatId: chat.id });
  }
  startChatInRef.current = startChatIn;

  function openNewChatMenu() {
    send({ type: "list_workspaces" });
    setWorkspaceCreating(false);
    setWorkspaceMenuOpen(true);
    setNavOpen(true);
  }
  newChatRef.current = openNewChatMenu;

  function newChat() {
    if (workspaceMenuOpen) {
      setWorkspaceMenuOpen(false);
      setWorkspaceCreating(false);
      return;
    }
    openNewChatMenu();
  }

  function openFilesBrowser() {
    setFilesQuery("");
    setFilesOpen(true);
    setNavOpen(false);
    setPaletteOpen(false);
    setSearchOpen(false);
    setGrepOpen(false);
  }

  function selectChat(chat: Chat) {
    stashView();
    setNavOpen(false);
    setActiveId(chat.id);
    if (chat.unread) patchChat(chat.id, (item) => ({ ...item, unread: false }));
    const draft = usableDraft(chat);
    syncComposer(draft);
    if (draft !== (chat.draft || "")) {
      patchChat(chat.id, (item) => ({ ...item, draft }));
    }
    setImages(imagesRef.current[chat.id] || chat.draftImages || []);
    setSearchOpen(false);
    setCheckpoints(chat.checkpoints || []);
    send({ type: "list_checkpoints", chatId: chat.id });
    send({ type: "list_files", query: "", chatId: chat.id });
    applySessionModel(chat);
    if (chat.mode) {
      modeRef.current = chat.mode;
      setMode(chat.mode);
    }
    if (chat.cwd) {
      setCwd(chat.cwd);
      if (chat.cwd !== cwdRef.current) {
        send({ type: "set_workspace", cwd: chat.cwd, chatId: chat.id });
      }
    }
    const savedTabs = chat.previewTabs || [];
    if (savedTabs.length) {
      const next = savedTabs.map((tab) => ({ path: tab.path, line: tab.line, kind: kindFromPath(tab.path) }));
      setPreviewTabs(next);
      setPreviewPath(chat.previewPath || savedTabs[0]?.path || "");
      for (const tab of next) {
        previewWantedRef.current.add(tab.path);
        send({ type: "read_file", path: tab.path, chatId: chat.id, diff: undefined });
      }
      setPreviewMax(false);
    } else {
      setPreviewTabs([]);
      setPreviewPath("");
      setPreviewMax(false);
    }
    setThreadFindOpen(false);
    if (chat.agentId) {
      send({ type: "resume_session", chatId: chat.id, agentId: chat.agentId });
    }
  }

  async function addImages(files: FileList | File[]) {
    const next = await filesToImages(files);
    if (!next.length) return 0;
    setImages((prev) => {
      const merged = [...prev, ...next].slice(0, MAX_IMAGES);
      imagesRef.current[activeIdRef.current] = merged;
      patchActive((chat) => ({ ...chat, draftImages: merged }));
      return merged;
    });
    return next.length;
  }

  function attachUploadedPath(chatId: string, path: string) {
    const token = `@${path} `;
    rememberRecent(path);
    if (chatId && chatId !== activeIdRef.current) {
      patchChat(chatId, (chat) => {
        const draft = chat.draft || "";
        if (draft.includes(`@${path}`)) return chat;
        return {
          ...chat,
          draft: `${draft}${draft && !draft.endsWith(" ") ? " " : ""}${token}`,
        };
      });
      return;
    }
    const current = draftRef.current;
    if (current.includes(`@${path}`)) return;
    const next = `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${token}`;
    draftRef.current = next;
    setDraft(next);
    setComposerEpoch((n) => n + 1);
    setDraftCaret(next.length);
    patchChat(activeIdRef.current, (chat) => (chat.draft === next ? chat : { ...chat, draft: next }));
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const merged = prev.filter((_, i) => i !== index);
      imagesRef.current[activeIdRef.current] = merged;
      return merged;
    });
  }

  function clearDraftTimers() {
    if (draftSaveTimerRef.current) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = 0;
    }
    if (mentionSearchTimerRef.current) {
      window.clearTimeout(mentionSearchTimerRef.current);
      mentionSearchTimerRef.current = 0;
    }
  }

  function syncComposer(value: string, caret?: number) {
    clearDraftTimers();
    draftRef.current = value;
    setDraft(value);
    setComposerEpoch((n) => n + 1);
    if (caret != null) setDraftCaret(caret);
  }

  function updateMentions(value: string, caret: number) {
    const mention = mentionAt(value, caret);
    mentionRangeRef.current = mention;
    const query = mention ? mention.query : null;
    setMentionQuery((prev) => (prev === query ? prev : query));
    if (!mention) {
      setFileHits((prev) => (prev.length ? [] : prev));
      if (mentionSearchTimerRef.current) {
        window.clearTimeout(mentionSearchTimerRef.current);
        mentionSearchTimerRef.current = 0;
      }
      return;
    }
    const hits = mentionHits(treePathsRef.current, mention.query);
    setFileHits((prev) =>
      prev.length === hits.length && prev.every((item, i) => item === hits[i]) ? prev : hits,
    );
    if (mentionSearchTimerRef.current) window.clearTimeout(mentionSearchTimerRef.current);
    mentionSearchTimerRef.current = window.setTimeout(() => {
      mentionSearchTimerRef.current = 0;
      send({ type: "list_files", query: mention.query, chatId: activeIdRef.current, mention: true });
    }, 120);
  }

  function handleDraftChange(value: string, caret: number) {
    draftRef.current = value;
    if (draftSaveTimerRef.current) window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = 0;
      const text = draftRef.current;
      patchActive((chat) => (chat.draft === text ? chat : { ...chat, draft: text }));
    }, 400);
    updateMentions(value, caret);
  }

  function applyDraft(value: string, caret?: number) {
    syncComposer(value, caret);
    patchActive((chat) => (chat.draft === value ? chat : { ...chat, draft: value }));
    updateMentions(value, caret ?? value.length);
  }

  function dismissMention() {
    mentionRangeRef.current = null;
    setMentionQuery(null);
    setFileHits([]);
  }

  function submitLogin() {
    const next = token.trim();
    if (!next) return;
    setVerifying(true);
    setAuthError("");
    tokenRef.current = next;
    send({ type: "hello", token: next });
    if (verifyTimerRef.current) window.clearTimeout(verifyTimerRef.current);
    verifyTimerRef.current = window.setTimeout(() => {
      if (unlockedRef.current) return;
      setVerifying(false);
      const open = wsRef.current?.readyState === WebSocket.OPEN;
      setAuthError(
        open
          ? "验证超时，请再试一次。"
          : "还没连上服务器。请稍后再试。",
      );
    }, 20000);
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    tokenRef.current = "";
    tenantIdRef.current = "";
    setToken("");
    unlockedRef.current = false;
    setUnlocked(false);
    setVerifying(false);
    setAuthError("");
    resetTenantSession();
    pendingHelloRef.current = null;
    wsRef.current?.close();
  }

  function rememberLastModel(value: string) {
    const id = value.trim();
    if (!id) return;
    lastModelRef.current = id;
    writeLastModel(id);
  }

  function applySessionModel(chat: Chat) {
    const next = resolveModel(
      sessionModel(chat) || lastModelRef.current || modelRef.current,
      models,
      DEFAULT_MODEL,
    );
    if (!next) return;
    modelRef.current = next;
    setModel(next);
    if (sessionModel(chat)) rememberLastModel(next);
    if (chat.model !== next) {
      patchChat(chat.id, (item) => (item.model === next ? item : { ...item, model: next }));
    }
    send({ type: "set_model", model: next, chatId: chat.id });
  }

  function persistModel(value: string) {
    modelRef.current = value;
    setModel(value);
    rememberLastModel(value);
    patchActive((chat) => (chat.model === value ? chat : { ...chat, model: value }));
    send({ type: "set_model", model: value, chatId: activeIdRef.current });
    const label = modelLabel(value);
    setNotice(busyRef.current ? `跑完后下一条用 ${label}` : `下一条用 ${label}`);
  }

  function persistMode(value: AgentMode) {
    modeRef.current = value;
    setMode(value);
    patchActive((chat) => (chat.mode === value ? chat : { ...chat, mode: value }));
    setNotice(value === "ask" ? "只问，不改文件" : value === "plan" ? "先出方案，再动手" : "可以直接改文件、跑命令");
  }

  function handlePickFile(path: string, line?: number, endLine?: number, snippet?: string) {
    const token =
      line && endLine && endLine !== line
        ? `${path}:${line}-${endLine}`
        : line
          ? `${path}:${line}`
          : path;
    const mention = mentionRangeRef.current;
    const at = mention ? mention.start : -1;
    const fence =
      snippet?.trim() && at < 0
        ? `\n\`\`\`${path.split(".").pop() || ""}\n${snippet.trimEnd()}\n\`\`\`\n`
        : "";
    const inserted = `@${token} `;
    const current = draftRef.current;
    const next =
      mention && at >= 0
        ? `${current.slice(0, at)}${inserted}${current.slice(at + 1 + mention.query.length)}${fence}`
        : `${current}${current && !current.endsWith(" ") && !current.endsWith("\n") ? " " : ""}${inserted}${fence}`;
    const caret = at >= 0 ? at + inserted.length : next.length;
    applyDraft(next, caret);
    mentionRangeRef.current = null;
    setMentionQuery(null);
    setFileHits([]);
    if (isOpenableMention(path)) {
      rememberRecent(path);
      openFile(path);
    }
  }

  function handleAskRange(path: string, start: number, end: number, text: string) {
    handlePickFile(path, start, end, text);
  }

  function handleTreeCreate(path: string, kind: "file" | "dir") {
    send({
      type: "fs_op",
      op: kind === "dir" ? "mkdir" : "create",
      path,
      chatId: activeIdRef.current,
    });
  }

  function handleTreeRename(from: string, to: string) {
    send({ type: "fs_op", op: "rename", path: from, to, chatId: activeIdRef.current });
  }

  function handleTreeDelete(path: string, dir: boolean) {
    if (!window.confirm(dir ? `删除空目录 ${path}？` : `删除文件 ${path}？`)) return;
    send({ type: "fs_op", op: "delete", path, chatId: activeIdRef.current });
  }

  function handleComposerFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) {
      setError("没有选到文件");
      return;
    }
    setNotice(`已选 ${list[0].name || "文件"}${list.length > 1 ? ` 等 ${list.length} 个` : ""}，正在上传…`);
    void ingestComposerFiles(list);
  }

  async function ingestComposerFiles(list: File[]) {
    if (!list.length) {
      setError("没有选到文件");
      return;
    }
    const tooBig = list.filter((file) => file.size > MAX_UPLOAD_BYTES);
    const ok = list.filter((file) => !(file.size > MAX_UPLOAD_BYTES)).slice(0, MAX_UPLOAD_FILES);
    if (tooBig.length) {
      const file = tooBig[0];
      setError(`${file.name || "文件"} 有 ${formatUploadMb(file.size)}，上限 ${MAX_UPLOAD_MB}MB`);
    }
    if (!ok.length) return;
    const pics = ok.filter((file) => isPromptImageFile(file));
    if (pics.length) void addImages(pics);
    for (const file of ok) {
      void uploadComposerFile(file);
    }
  }

  async function uploadComposerFile(file: File) {
    const chatId = activeIdRef.current;
    const name = file.name || "file";
    setUploading((n) => n + 1);
    setNotice(`正在上传 ${name}`);
    try {
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`有 ${formatUploadMb(file.size)}，上限 ${MAX_UPLOAD_MB}MB`);
      }
      let path = "";
      try {
        path = await uploadComposerFileHttp(chatId, name, file);
      } catch (httpErr) {
        const buf = await file.arrayBuffer();
        if (!buf.byteLength) {
          throw httpErr instanceof Error ? httpErr : new Error("上传失败");
        }
        if (buf.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`有 ${formatUploadMb(buf.byteLength)}，上限 ${MAX_UPLOAD_MB}MB`);
        }
        path = await uploadComposerFileSocket(chatId, name, buf);
      }
      attachUploadedPath(chatId, path);
      send({ type: "list_files", query: "", chatId });
      setNotice(`已添加 ${path}`);
    } catch (err) {
      setError(`${name}：${err instanceof Error ? err.message : "上传失败"}`);
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  }

  async function uploadComposerFileHttp(chatId: string, name: string, file: File) {
    const token = tokenRef.current || (typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) || "" : "");
    const form = new FormData();
    if (token) form.append("token", token);
    form.append("file", file, name);
    const res = await fetch(uploadUrl(chatId, name), {
      method: "POST",
      body: form,
    });
    const payload = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res.ok || payload.error || !payload.path) {
      throw new Error(payload.error || `上传失败（${res.status}）`);
    }
    return payload.path;
  }

  function uploadComposerFileSocket(chatId: string, name: string, buf: ArrayBuffer) {
    return new Promise<string>((resolve, reject) => {
      const id = uid();
      const timer = window.setTimeout(() => {
        pendingUploadsRef.current.delete(id);
        reject(new Error("上传超时"));
      }, 90_000);
      pendingUploadsRef.current.set(id, { resolve, reject, timer });
      void fileToBase64(new Blob([buf]))
        .then((data) => {
          if (!data) throw new Error("文件读不出来");
          send({ type: "upload_file", chatId, name, data, id });
        })
        .catch((err) => {
          pendingUploadsRef.current.delete(id);
          window.clearTimeout(timer);
          reject(err instanceof Error ? err : new Error("上传失败"));
        });
    });
  }

  function removeDraftMention(token: string) {
    applyDraft(stripMention(draftRef.current, token));
  }

  function openFile(path: string, line?: number, asDiff?: boolean) {
    const rel = relToCwd(path, cwdRef.current) || path;
    const kind = kindFromPath(rel);
    const dirty = Boolean(gitLetterOf(rel, gitStatus, cwdRef.current));
    const diff =
      kind === "canvas"
        ? false
        : asDiff != null
          ? asDiff
          : line == null &&
            dirty &&
            (kind === "text" || kind === "image" || kind === "svg");
    const current = previewTabsRef.current.find((tab) => sameFile(tab.path, rel, cwdRef.current));
    const sendPath = current?.path || rel;
    const cached = !diff ? peekPreviewText(rel) : undefined;
    previewWantedRef.current.add(sendPath);
    previewWantedRef.current.add(rel);
    previewTriesRef.current[sendPath] = 0;
    for (const item of [...httpHydratedRef.current]) {
      if (item.startsWith(`${sendPath}|`) || item.startsWith(`${rel}|`)) {
        httpHydratedRef.current.delete(item);
      }
    }
    setPreviewTabs((prev) => {
      const existing = prev.find((tab) => sameFile(tab.path, rel, cwdRef.current));
      if (existing) {
        return prev.map((tab) =>
          sameFile(tab.path, rel, cwdRef.current)
            ? {
                ...tab,
                line,
                diff,
                kind,
                content: diff !== tab.diff ? cached : tab.content ?? cached,
                url: diff !== tab.diff ? undefined : tab.url,
                headUrl: diff !== tab.diff ? undefined : tab.headUrl,
                error: undefined,
              }
            : tab,
        );
      }
      return [...prev, { path: rel, line, diff, kind, content: cached }].slice(-8);
    });
    setPreviewPath(sendPath);
    rememberRecent(rel);
    setNavOpen(false);
    setPreviewMax(true);
    send({ type: "read_file", path: sendPath, chatId: activeIdRef.current, diff: diff || undefined });
  }

  function handleCanvasAction(action: CanvasAction, canvasPath: string) {
    if (action.type === "openFile") {
      openFile(action.path, action.selection?.startLineNumber);
      return;
    }
    if (action.type === "newComposerChat") {
      const token = `@${canvasPath}`;
      const extra = action.userPrompt?.trim() || "";
      const next = extra ? `${token} ${extra}` : `${token} `;
      applyDraft(next, next.length);
      return;
    }
    if (action.type === "openAgent") {
      const hit = chatsRef.current.find((chat) => chat.agentId === action.agentId);
      if (hit) selectChat(hit);
    }
  }

  function togglePreviewDiff(path: string, diff: boolean) {
    openFile(path, undefined, diff);
  }

  function revertFile(path: string, silent = false) {
    if (!silent && !window.confirm(`还原 ${path}？未提交的改动会丢掉。`)) return;
    send({ type: "revert_file", chatId: activeIdRef.current, path });
  }

  function keepFile(path: string) {
    openFile(path, undefined, false);
  }

  function revertHunk(path: string, hunk: string) {
    send({ type: "revert_hunk", chatId: activeIdRef.current, path, hunk });
  }

  function setToolReview(turnId: string, callId: string, review: "accepted" | "rejected") {
    patchActive((chat) => ({
      ...chat,
      turns: chat.turns.map((item) =>
        item.id !== turnId
          ? item
          : {
              ...item,
              tools: item.tools.map((tool) => (tool.callId === callId ? { ...tool, review } : tool)),
            },
      ),
    }));
  }

  function keepTool(turnId: string, tool: ToolCall) {
    const path = relToCwd(pathFromPayload(tool.args) || pathFromPayload(tool.result), cwdRef.current);
    setToolReview(turnId, tool.callId, "accepted");
    if (path) keepFile(path);
  }

  function rejectTool(turn: Turn, tool: ToolCall) {
    const diff = extractDiff(tool);
    const path = relToCwd(diff.path || pathFromPayload(tool.args) || pathFromPayload(tool.result), cwdRef.current);
    if (!path) return;
    if (diff.unified) revertHunk(path, diff.unified);
    else revertFile(path, true);
    setToolReview(turn.id, tool.callId, "rejected");
  }

  function keepTurnFiles(turn: Turn) {
    patchActive((chat) => ({
      ...chat,
      turns: chat.turns.map((item) =>
        item.id !== turn.id
          ? item
          : {
              ...item,
              tools: item.tools.map((tool) =>
                mutatingTool(tool.name) ? { ...tool, review: tool.review || "accepted" } : tool,
              ),
            },
      ),
    }));
    for (const path of editPathsOf(turn)) keepFile(relToCwd(path, cwdRef.current) || path);
  }

  function restoreTurnFiles(turn: Turn) {
    const paths = editPathsOf(turn).map((path) => relToCwd(path, cwdRef.current) || path);
    if (!paths.length) return;
    if (!window.confirm(`还原这一轮的 ${paths.length} 个文件？`)) return;
    const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
    const last = [...(chat?.turns || [])].reverse().find((item) => !item.queued && editPathsOf(item).length);
    if (last?.id === turn.id) send({ type: "undo", chatId: activeIdRef.current });
    else {
      for (const path of paths) revertFile(path, true);
    }
    patchActive((item) => ({
      ...item,
      turns: item.turns.map((row) =>
        row.id !== turn.id
          ? row
          : {
              ...row,
              tools: row.tools.map((tool) =>
                mutatingTool(tool.name) ? { ...tool, review: "rejected" } : tool,
              ),
            },
      ),
    }));
  }

  function saveFile(path: string, content: string) {
    send({ type: "write_file", path, content, chatId: activeIdRef.current });
  }

  function retryTurn(turn: Turn) {
    if (!connected) return;
    if (busyRef.current) {
      setNotice("等当前这条跑完再重试");
      return;
    }
    const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
    if (!chat) return;
    const index = chat.turns.findIndex((item) => item.id === turn.id);
    if (index < 0) return;
    const next: Turn = {
      ...turn,
      assistant: "",
      thinking: "",
      tools: [],
      todos: undefined,
      error: undefined,
      status: undefined,
      durationMs: undefined,
      pendingTool: undefined,
      running: true,
      queued: false,
    };
    patchActive((item) => ({
      ...item,
      turns: [...item.turns.slice(0, index), next],
      agentId: undefined,
    }));
    lastProgressRef.current[activeIdRef.current] = Date.now();
    stallNoticedRef.current.delete(activeIdRef.current);
    send({
      type: "prompt",
      text: turn.user || "请看附图。",
      model: turn.model || modelRef.current,
      mode: turn.mode || modeRef.current,
      chatId: activeIdRef.current,
      files: attachedFiles(turn.user),
      images: turn.images,
      confirmWrites: confirmWritesRef.current,
      fresh: true,
      nameChat: isUntitled(chat.title),
    });
  }

  function editTurn(turn: Turn) {
    if (busyRef.current) {
      setNotice("等当前这条跑完再编辑");
      return;
    }
    const chat = chatsRef.current.find((item) => item.id === activeIdRef.current);
    if (!chat) return;
    const index = chat.turns.findIndex((item) => item.id === turn.id);
    if (index < 0) return;
    patchActive((item) => ({
      ...item,
      turns: item.turns.slice(0, index),
      agentId: undefined,
    }));
    send({ type: "new_session", chatId: activeIdRef.current });
    applyDraft(turn.user, turn.user.length);
    if (turn.images?.length) {
      setImages(turn.images);
      imagesRef.current[activeIdRef.current] = turn.images;
    }
  }

  function startRename(chat: Chat) {
    setRenameId(chat.id);
    setRenameDraft(chat.title);
  }

  function commitRename() {
    if (renameSkipRef.current) {
      renameSkipRef.current = false;
      setRenameId(null);
      return;
    }
    const id = renameId;
    const title = renameDraft.trim();
    setRenameId(null);
    if (!id || !title) return;
    patchChat(id, (chat) => {
      if (chat.title === title) return chat;
      if (title === "新对话" && !isUntitled(chat.title)) return chat;
      return { ...chat, title };
    });
  }

  function flushChats(next: Chat[]) {
    chatsRef.current = next;
    stateRevRef.current += 1;
    send({ type: "sync_state", chats: slimChats(next), rev: stateRevRef.current });
  }

  function deleteChat(id: string) {
    if (renameId === id) setRenameId(null);
    deletedIdsRef.current = rememberDeleted(deletedIdsRef.current, id);
    const doomed = chatsRef.current.find((chat) => chat.id === id);
    if (doomed?.turns.some((turn) => turn.running)) {
      send({ type: "cancel", chatId: id });
    }
    send({ type: "delete_session", chatId: id });
    const rest = chatsRef.current.filter((chat) => chat.id !== id);
    delete imagesRef.current[id];
    if (!rest.length) {
      const nextModel = lastModelRef.current || modelRef.current;
      const chat = {
        id: uid(),
        title: "新对话",
        turns: [],
        draft: "",
        model: nextModel,
        mode: modeRef.current,
        cwd: cwdRef.current,
        confirmWrites: confirmWritesRef.current,
      };
      setChats([chat]);
      setActiveId(chat.id);
      if (nextModel) {
        modelRef.current = nextModel;
        setModel(nextModel);
      }
      syncComposer("");
      setImages([]);
      setCheckpoints([]);
      setPreviewTabs([]);
      setPreviewPath("");
      setPreviewMax(false);
      send({ type: "new_session", chatId: chat.id, cwd: chat.cwd });
      if (nextModel) send({ type: "set_model", model: nextModel, chatId: chat.id });
      flushChats([chat]);
      return;
    }
    setChats(rest);
    flushChats(rest);
    if (id !== activeIdRef.current) return;
    const chat = rest[0];
    setActiveId(chat.id);
    if (chat.unread) patchChat(chat.id, (item) => ({ ...item, unread: false }));
    const draft = usableDraft(chat);
    syncComposer(draft);
    if (draft !== (chat.draft || "")) {
      patchChat(chat.id, (item) => ({ ...item, draft }));
    }
    setImages(imagesRef.current[chat.id] || chat.draftImages || []);
    setCheckpoints(chat.checkpoints || []);
    send({ type: "list_checkpoints", chatId: chat.id });
    send({ type: "list_files", query: "", chatId: chat.id });
    applySessionModel(chat);
    if (chat.mode) {
      modeRef.current = chat.mode;
      setMode(chat.mode);
    }
    if (chat.cwd) {
      setCwd(chat.cwd);
      if (chat.cwd !== cwdRef.current) {
        send({ type: "set_workspace", cwd: chat.cwd, chatId: chat.id });
      }
    }
    setPreviewTabs([]);
    setPreviewPath("");
    setPreviewMax(false);
    setThreadFindOpen(false);
    if (chat.agentId) {
      send({ type: "resume_session", chatId: chat.id, agentId: chat.agentId });
    }
  }

  function closePreviewTab(path: string) {
    setPreviewTabs((prev) => {
      const next = prev.filter((tab) => !sameFile(tab.path, path));
      if (!next.length) setPreviewMax(false);
      setPreviewPath((current) =>
        sameFile(current, path) ? next.at(-1)?.path || "" : current,
      );
      return next;
    });
  }

  function applyPlan(turn: Turn) {
    if (!connected || busyRef.current) return;
    setMode("agent");
    modeRef.current = "agent";
    persistMode("agent");
    setNotice("按计划开始执行");
    const text = `请按你上一条计划开始执行，直接改文件，不要再只出方案。\n\n${turn.assistant.slice(0, 4000)}`;
    const next: Turn = {
      id: uid(),
      user: "执行这个计划",
      assistant: "",
      thinking: "",
      tools: [],
      running: true,
      mode: "agent",
      model: modelRef.current,
    };
    const current = chatsRef.current.find((item) => item.id === activeIdRef.current);
    patchActive((chat) => ({ ...chat, turns: [...chat.turns, next] }));
    lastProgressRef.current[activeIdRef.current] = Date.now();
    stallNoticedRef.current.delete(activeIdRef.current);
    send({
      type: "prompt",
      text,
      model: modelRef.current,
      mode: "agent",
      chatId: activeIdRef.current,
      confirmWrites: confirmWritesRef.current,
      nameChat: isUntitled(current?.title),
    });
  }

  function persistConfirmWrites(value: boolean) {
    confirmWritesRef.current = value;
    patchActive((chat) => (chat.confirmWrites === value ? chat : { ...chat, confirmWrites: value }));
    setNotice(value ? "写入前会先问你" : "写入不再确认");
  }

  function resolveApproval(allow: boolean) {
    const turn = [...(chatsRef.current.find((item) => item.id === activeIdRef.current)?.turns || [])]
      .reverse()
      .find((item) => item.pendingTool);
    const tool = turn?.pendingTool;
    if (!tool || !turn) return;
    const rejectedPaths = allow ? [] : editPathsOf(turn);
    patchChat(activeIdRef.current, (chat) => ({
      ...chat,
      turns: chat.turns.map((item) =>
        item.id === turn.id
          ? allow
            ? { ...item, pendingTool: undefined }
            : rejectMutatingTools(item)
          : item,
      ),
    }));
    if (!allow && rejectedPaths.length) {
      setPreviewTabs((prev) => {
        const next = prev.filter((tab) => {
          const rel = relToCwd(tab.path, cwdRef.current) || tab.path;
          const hit = rejectedPaths.some(
            (path) => sameFile(path, tab.path) || sameFile(relToCwd(path, cwdRef.current) || path, rel),
          );
          if (!hit) return true;
          return treePathsRef.current.some((item) => sameFile(item, rel) || sameFile(item, tab.path));
        });
        if (next.length !== prev.length && !next.some((tab) => sameFile(tab.path, previewPathRef.current))) {
          queueMicrotask(() => setPreviewPath(next[0]?.path || ""));
        }
        return next;
      });
    }
    setNotice(allow ? "已允许，正在按确认后重跑" : "已拒绝写入，正在还原到发送前");
    send({
      type: "approval_reply",
      chatId: activeIdRef.current,
      callId: tool.callId,
      allow,
    });
  }

  const empty = !active?.turns.length;
  searchOpenRef.current = searchOpen;
  paletteOpenRef.current = paletteOpen;
  threadFindOpenRef.current = threadFindOpen;
  grepOpenRef.current = grepOpen;
  filesOpenRef.current = filesOpen;
  grepQRef.current = grepQ;
  const searchHits = searchQ.trim()
    ? chats.filter((chat) => {
        const q = searchQ.trim().toLowerCase();
        return (
          chat.title.toLowerCase().includes(q) ||
          chat.turns.some((turn) => turn.user.toLowerCase().includes(q))
        );
      })
    : chats;
  const paletteHits = (() => {
    const q = paletteQ.trim().toLowerCase();
    const match = (path: string) => {
      if (!q) return true;
      const base = path.split("/").pop() || path;
      return path.toLowerCase().includes(q) || base.toLowerCase().includes(q);
    };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of [...recentFiles, ...treePaths]) {
      if (seen.has(path) || !match(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out.slice(0, 80);
  })();
  const paletteHi = Math.min(paletteIndex, Math.max(0, paletteHits.length - 1));
  const grepHi = Math.min(grepIndex, Math.max(0, grepHits.length - 1));
  const threadFindHits =
    threadFindOpen && threadFindQ.trim() && active
      ? active.turns.filter((turn) => {
          const q = threadFindQ.trim().toLowerCase();
          return (
            turn.user.toLowerCase().includes(q) ||
            turn.assistant.toLowerCase().includes(q) ||
            turn.thinking.toLowerCase().includes(q)
          );
        })
      : [];
  const threadFindHi = Math.min(threadFindIndex, Math.max(0, threadFindHits.length - 1));

  useEffect(() => {
    if (!threadFindOpen) return;
    const id = threadFindHits[threadFindHi]?.id;
    if (!id || !threadRef.current) return;
    threadRef.current.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ block: "center" });
  }, [threadFindOpen, threadFindHi, threadFindQ, activeId]);

  if (!unlocked && !demoCanvas) {
    return (
      <LoginGate
        connected={connected}
        verifying={verifying}
        error={authError}
        value={token}
        onChange={(value) => {
          setToken(value);
          setAuthError("");
        }}
        onSubmit={submitLogin}
      />
    );
  }

  return (
    <div className={`app${navOpen ? " nav-open" : ""}${navReady ? " nav-ready" : ""}`}>
      {searchShown ? (
        <div className={`search-overlay${searchOpen ? " open" : ""}`} onClick={() => setSearchOpen(false)}>
          <div
            className="search-box"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              autoFocus={searchOpen}
              className="search-input"
              placeholder="搜索对话"
              value={searchQ}
              onChange={(event) => setSearchQ(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearchOpen(false);
                if (event.key === "Enter" && searchHits[0]) selectChat(searchHits[0]);
              }}
            />
            <div className="search-list">
              {searchHits.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className={`search-item${chat.id === activeId ? " active" : ""}`}
                  onClick={() => selectChat(chat)}
                >
                  {chat.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {paletteShown ? (
        <div className={`search-overlay${paletteOpen ? " open" : ""}`} onClick={() => setPaletteOpen(false)}>
          <div className="search-box" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus={paletteOpen}
              className="search-input"
              placeholder="打开文件"
              value={paletteQ}
              onChange={(event) => {
                setPaletteQ(event.target.value);
                setPaletteIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPaletteOpen(false);
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setPaletteIndex((index) => Math.min(index + 1, Math.max(0, paletteHits.length - 1)));
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setPaletteIndex((index) => Math.max(index - 1, 0));
                }
                if (event.key === "Enter" && paletteHits[paletteHi]) {
                  event.preventDefault();
                  openFile(paletteHits[paletteHi]);
                  setPaletteOpen(false);
                }
              }}
            />
            <div className="search-list">
              {paletteHits.length ? (
                paletteHits.map((path, index) => {
                  const base = path.split("/").pop() || path;
                  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                  const ext = (base.includes(".") ? base.split(".").pop() : "") || "file";
                  return (
                  <button
                    key={path}
                    type="button"
                    className={`search-item file-hit${index === paletteHi ? " active" : ""}`}
                    onClick={() => {
                      openFile(path);
                      setPaletteOpen(false);
                    }}
                  >
                    <span className="file-kind">{ext.slice(0, 4)}</span>
                    <span className="search-item-name">{base}</span>
                    <span className="search-item-dir">{dir || "."}</span>
                  </button>
                  );
                })
              ) : (
                <div className="search-item">没有匹配的文件</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {grepShown ? (
        <div className={`search-overlay${grepOpen ? " open" : ""}`} onClick={() => setGrepOpen(false)}>
          <div className="search-box grep-box" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus={grepOpen}
              className="search-input"
              placeholder="在工作区里搜文本"
              value={grepQ}
              onChange={(event) => {
                setGrepQ(event.target.value);
                setGrepIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setGrepOpen(false);
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setGrepIndex((index) => Math.min(index + 1, Math.max(0, grepHits.length - 1)));
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setGrepIndex((index) => Math.max(index - 1, 0));
                }
                if (event.key === "Enter" && grepHits[grepHi]) {
                  event.preventDefault();
                  const hit = grepHits[grepHi];
                  openFile(hit.path, hit.line, false);
                  setGrepOpen(false);
                }
              }}
            />
            <div className="search-list">
              {grepQ.trim() ? (
                grepWait ? (
                  <div className="search-item">正在搜索…</div>
                ) : grepHits.length ? (
                  grepHits.map((hit, index) => (
                    <button
                      key={`${hit.path}:${hit.line}:${index}`}
                      type="button"
                      className={`search-item file-hit${index === grepHi ? " active" : ""}`}
                      onClick={() => {
                        openFile(hit.path, hit.line, false);
                        setGrepOpen(false);
                      }}
                    >
                      <span className="search-item-name">
                        {hit.path.split("/").pop()}
                        <span className="search-item-line">:{hit.line}</span>
                      </span>
                      <span className="search-item-snip">{hit.text}</span>
                      <span className="search-item-dir">{hit.path.includes("/") ? hit.path.slice(0, hit.path.lastIndexOf("/")) : "."}</span>
                    </button>
                  ))
                ) : (
                  <div className="search-item">没有匹配的内容</div>
                )
              ) : (
                <div className="search-item">输入关键字，在文件内容里找 · 最多 100 条</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {filesShown ? (
        <div
          className={`files-overlay${filesOpen ? " open" : ""}`}
          onClick={() => {
            setFilesOpen(false);
            setFilesQuery("");
          }}
        >
          <div
            className="files-browser"
            role="dialog"
            aria-label="文件浏览器"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="files-browser-head">
              <div className="files-browser-title">
                <span>文件</span>
                <span className="files-browser-cwd" title={cwd || workspaceRoot}>
                  {workspaceLabel(cwd || workspaceRoot, workspaceRoot)}
                </span>
              </div>
              <button
                type="button"
                className="files-browser-close"
                aria-label="关闭文件浏览器"
                onClick={() => {
                  setFilesOpen(false);
                  setFilesQuery("");
                }}
              >
                ×
              </button>
            </div>
            <input
              autoFocus={filesOpen}
              className="files-browser-search"
              placeholder="搜索文件名或路径"
              value={filesQuery}
              onChange={(event) => setFilesQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFilesOpen(false);
                  setFilesQuery("");
                }
              }}
            />
            <div className="files-browser-body">
              {Object.keys(gitStatus).length ? (
                <div className="changes-list files-browser-changes">
                  <div className="side-label">改动 · {Object.keys(gitStatus).length}</div>
                  {Object.entries(gitStatus)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([path, letter]) => (
                      <button
                        key={path}
                        type="button"
                        className={`tree-file${sameFile(previewPath, path) ? " on" : ""}`}
                        title={path}
                        onClick={() => {
                          openFile(path, undefined, true);
                          setFilesOpen(false);
                          setFilesQuery("");
                        }}
                      >
                        <FileGlyph path={path} />
                        <span className="tree-file-copy">
                          <span className="tree-file-name">{path.split("/").pop() || path}</span>
                          <span className="tree-file-path">{path}</span>
                        </span>
                        <span className={`git-mark ${letter}`} title={GIT_LABEL[letter] || letter}>
                          {letter}
                        </span>
                      </button>
                    ))}
                </div>
              ) : null}
              <FileTree
                paths={treePaths}
                truncated={treeTruncated}
                status={gitStatus}
                query={filesQuery}
                variant="browser"
                onPick={(path) => {
                  handlePickFile(path);
                  setFilesOpen(false);
                  setFilesQuery("");
                }}
                onOpen={(path) => {
                  openFile(path);
                  setFilesOpen(false);
                  setFilesQuery("");
                }}
                onCreate={handleTreeCreate}
                onRename={handleTreeRename}
                onDelete={handleTreeDelete}
              />
            </div>
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className="nav-scrim"
        aria-label="关闭对话列表"
        aria-hidden={!navOpen}
        tabIndex={navOpen ? 0 : -1}
        ref={(node) => {
          navDrag.scrimRef.current = node;
        }}
        onClick={() => setNavOpen(false)}
      />
      <aside className="sidebar" ref={navDrag.ref}>
        <div className="brand">
          <Mark />
          <div>
            <div className="brand-title">接驳</div>
            <div className="brand-sub" title={cwd || workspaceRoot}>
              {workspaceLabel(cwd || workspaceRoot, workspaceRoot)}
            </div>
          </div>
        </div>
        <div
          className={`workspace-picker${workspaceMenuOpen ? " open" : ""}`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="side-actions">
          <button
            className={`new-chat${workspaceMenuOpen ? " open" : ""}`}
            type="button"
            onClick={newChat}
          >
            + 新对话
          </button>
          <button
            className="new-chat grep-chat"
            type="button"
            title="搜代码 ⌘⇧F"
            onClick={() => {
              setSearchOpen(false);
              setPaletteOpen(false);
              setThreadFindOpen(false);
              setGrepOpen(true);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
          </div>
          {workspaceMenuOpen ? (
            <div className="workspace-menu">
              <div className="workspace-menu-hint">先选工作区，这个对话只能在里面写文件</div>
              {recentWorkspaces.length ? (
                <>
                  <div className="workspace-menu-label">最近</div>
                  {recentWorkspaces.map((item) => (
                    <button
                      key={`recent-${item.path}`}
                      type="button"
                      className={`workspace-menu-item${sameCwd(item.path, cwd) ? " on" : ""}`}
                      onClick={() => startChatIn(item.path)}
                    >
                      <span className="workspace-menu-name">{item.name}</span>
                      {sameCwd(item.path, cwd) ? <span className="workspace-menu-check">✓</span> : null}
                    </button>
                  ))}
                </>
              ) : null}
              {catalogWorkspaces.length ? (
                <>
                  <div className="workspace-menu-label">目录</div>
                  {catalogWorkspaces.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className="workspace-menu-item"
                      onClick={() => startChatIn(item.path)}
                    >
                      <span className="workspace-menu-name">{item.name}</span>
                    </button>
                  ))}
                </>
              ) : null}
              {!recentWorkspaces.length && !catalogWorkspaces.length && workspaceRoot ? (
                <button
                  type="button"
                  className="workspace-menu-item on"
                  onClick={() => startChatIn(workspaceRoot)}
                >
                  <span className="workspace-menu-name">{workspaceLabel(workspaceRoot, workspaceRoot)}</span>
                  <span className="workspace-menu-check">✓</span>
                </button>
              ) : null}
              {workspaceCreating ? (
                <form
                  className="workspace-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitNewWorkspace();
                  }}
                >
                  <input
                    className="side-input"
                    autoFocus
                    value={workspaceNameDraft}
                    placeholder="新目录名"
                    onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                  />
                  <button type="submit" className="workspace-create-ok" disabled={!workspaceNameDraft.trim()}>
                    创建
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="workspace-menu-item new"
                  onClick={() => setWorkspaceCreating(true)}
                >
                  + 新建工作区
                </button>
              )}
            </div>
          ) : null}
        </div>
        <div className="chats">
          {workspaceGroups.map((group) => (
            <div key={group.path} className="chat-group">
              <div className="chat-group-label" title={group.path}>
                {group.name}
              </div>
              {group.chats.map((chat) => (
            <div
              key={chat.id}
              className={`chat-item${chat.id === activeId ? " active" : ""}${chat.turns.some((turn) => turn.running) ? " busy" : ""}${chat.unread && chat.id !== activeId ? " unread" : ""}`}
            >
              {renameId === chat.id ? (
                <input
                  className="chat-rename"
                  value={renameDraft}
                  autoFocus
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      renameSkipRef.current = true;
                      setRenameId(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="chat-item-main"
                  title="单击打开，双击改名"
                  onClick={() => selectChat(chat)}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    startRename(chat);
                  }}
                >
                  <span className="chat-item-title">{chat.title}</span>
                  {chat.turns.some((turn) => turn.running) ? (
                    <span className="chat-mark run">跑</span>
                  ) : chat.unread ? (
                    <span className="chat-mark unread">新</span>
                  ) : null}
                </button>
              )}
              <button
                type="button"
                className="chat-item-x"
                title="删除会话"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteChat(chat.id);
                }}
              >
                ×
              </button>
            </div>
              ))}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="side-files-btn"
          onClick={openFilesBrowser}
        >
          <span>文件</span>
          <span className="side-files-meta">
            {Object.keys(gitStatus).length
              ? `${Object.keys(gitStatus).length} 处改动`
              : treePaths.length
                ? `${treePaths.length}`
                : "浏览"}
          </span>
        </button>
        <div className="side-foot">
          <button
            type="button"
            className="side-foot-btn"
            onClick={() => setSettingsOpen((open) => !open)}
            title={cwd || "工作目录"}
          >
            <span className={`dot ${connected ? (busy ? "busy" : "on") : "off"}`} />
            <span className="side-foot-cwd">
              {connected
                ? busy
                  ? "服务器正在干活"
                  : workspaceLabel(cwd || workspaceRoot, workspaceRoot)
                : "没连上"}
            </span>
          </button>
          {settingsOpen ? (
            <div className="side-settings">
              <div className="workspace-path" title={cwd}>
                {cwd || workspaceRoot || "工作区"}
              </div>
              <button type="button" className="logout-btn" onClick={logout}>
                退出登录
              </button>
            </div>
          ) : null}
        </div>
      </aside>

      <main className={`main${previewTabs.length ? " with-preview" : ""}${previewMax ? " preview-max" : ""}${previewTabs.some((tab) => isWideKind(tabKind(tab.path, tab.kind)) && sameFile(tab.path, previewPath)) ? " with-canvas" : ""}`}>
        <div className="main-col">
        <div className="pad-bar">
          <button
            type="button"
            className="pad-bar-btn pad-bar-nav"
            aria-label={navOpen ? "关闭对话列表" : "打开对话列表"}
            onClick={() => {
              setNavOpen((open) => {
                const next = !open;
                if (next) setPreviewMax(false);
                return next;
              });
            }}
          >
            <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
            </svg>
          </button>
          <div className="pad-bar-title" title={active?.title || "新对话"}>
            {shortPadTitle(active?.title, active?.turns.find((turn) => turn.user)?.user)}
          </div>
          <button
            type="button"
            className="pad-bar-btn"
            aria-label="打开文件"
            onClick={openFilesBrowser}
          >
            <svg viewBox="0 0 16 16" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3.5 2.5h6l3 3v8h-9z" />
              <path d="M9.5 2.5v3h3" />
            </svg>
          </button>
          <button type="button" className="pad-bar-btn" aria-label="新对话" onClick={newChat}>
            +
          </button>
        </div>
        {empty ? (
          <div className="empty">
            <div className="empty-mark">
              <Mark />
            </div>
            <h1>从这里开始</h1>
            <p className="empty-lead">网页说话，远端动手。从左侧接着聊，或先打开一个工作区文件。</p>
            {error ? <div className="error-line">{friendlyError(error)}</div> : null}
            {notice ? <div className="notice-line">{notice}</div> : null}
            <div className="empty-starters">
              <button
                type="button"
                className="empty-chip"
                onClick={openFilesBrowser}
              >
                打开工作区文件
              </button>
              {EMPTY_STARTERS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="empty-chip"
                  onClick={() => applyDraft(text, text.length)}
                >
                  {text}
                </button>
              ))}
            </div>
            <p className="empty-foot empty-foot-portrait">点左上角打开对话列表 · 可粘贴图片</p>
            <p className="empty-foot empty-foot-land">对话列表在左侧 · 可粘贴图片</p>
          </div>
        ) : (
            <div className="thread" ref={threadRef}>
              {threadFindOpen ? (
                <div className="thread-find">
                  <input
                    autoFocus
                    className="thread-find-input"
                    placeholder="在对话里找"
                    value={threadFindQ}
                    onChange={(event) => {
                      setThreadFindQ(event.target.value);
                      setThreadFindIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setThreadFindOpen(false);
                      }
                      if (event.key === "Enter" && threadFindHits.length) {
                        event.preventDefault();
                        setThreadFindIndex((index) => {
                          const next = event.shiftKey
                            ? (index - 1 + threadFindHits.length) % threadFindHits.length
                            : (index + 1) % threadFindHits.length;
                          return next;
                        });
                      }
                    }}
                  />
                  <span className="thread-find-count">
                    {threadFindQ.trim()
                      ? threadFindHits.length
                        ? `${threadFindHi + 1}/${threadFindHits.length}`
                        : "无"
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="pill"
                    disabled={!threadFindHits.length}
                    onClick={() =>
                      setThreadFindIndex(
                        (index) =>
                          (index - 1 + threadFindHits.length) % threadFindHits.length,
                      )
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="pill"
                    disabled={!threadFindHits.length}
                    onClick={() =>
                      setThreadFindIndex((index) => (index + 1) % threadFindHits.length)
                    }
                  >
                    ↓
                  </button>
                  <button type="button" className="pill" onClick={() => setThreadFindOpen(false)}>
                    关闭
                  </button>
                </div>
              ) : null}
              <div className="thread-inner">
                {!hasApiKey || error ? (
                  <div className="warn">{friendlyError(error)}</div>
                ) : null}
                {notice ? <div className="warn">{notice}</div> : null}
                {active.turns.map((turn, turnIndex) => {
                  if (turnSuperseded(active.turns, turnIndex)) return null;
                  let prevIndex = turnIndex - 1;
                  while (prevIndex >= 0 && turnSuperseded(active.turns, prevIndex)) {
                    prevIndex -= 1;
                  }
                  const prevTurn = prevIndex >= 0 ? active.turns[prevIndex] : undefined;
                  const hideUser = Boolean(
                    prevTurn && prevTurn.user.trim() && prevTurn.user.trim() === turn.user.trim(),
                  );
                  return (
                  <article
                    className={`turn${hideUser ? " turn-continue" : ""}${threadFindHits[threadFindHi]?.id === turn.id ? " find-hit" : ""}`}
                    data-turn={turn.id}
                    key={turn.id}
                  >
                    {hideUser ? null : (
                    <div className="turn-user">
                      <div className="user-kicker">你</div>
                      <div className="user-bubble">
                        {turn.images?.length ? (
                          <div className="user-thumbs">
                            {turn.images.map((img, index) => (
                              <img
                                key={`${turn.id}-${index}`}
                                src={`data:${img.mimeType};base64,${img.data}`}
                                alt=""
                              />
                            ))}
                          </div>
                        ) : null}
                        <CiteText
                          text={turn.user}
                          onOpen={openFile}
                          query={threadFindOpen ? threadFindQ : undefined}
                        />
                        {turn.model || turn.mode ? (
                          <div className="user-meta">
                            {turn.mode ? turn.mode : ""}
                            {turn.mode && turn.model ? " · " : ""}
                            {turn.model ? modelLabel(turn.model) : ""}
                          </div>
                        ) : null}
                      </div>
                      {!turn.running && !turn.queued ? (
                        <div className="turn-actions">
                          <button type="button" className="pill" onClick={() => editTurn(turn)}>
                            编辑
                          </button>
                          <button
                            type="button"
                            className="pill"
                            disabled={!connected || busy}
                            onClick={() => retryTurn(turn)}
                          >
                            重试
                          </button>
                        </div>
                      ) : null}
                    </div>
                    )}
                    <div className="assistant-row">
                    <span className="bot-avatar" aria-hidden="true">接</span>
                    <div className="assistant">
                      {turn.thinking && (turn.running || formatDuration(turn.durationMs)) ? (
                        <details
                          key={turn.running ? "live" : "done"}
                          className="thinking"
                          open={turn.running || undefined}
                        >
                          <summary>
                            <span className={turn.running ? "text-shimmer" : undefined}>
                            {turn.running
                              ? "正在思考"
                              : formatDuration(turn.durationMs)
                                ? `思考了 ${formatDuration(turn.durationMs)}`
                                : "思考过程"}
                            </span>
                          </summary>
                          <pre>
                            <Highlight
                              text={turn.thinking}
                              query={threadFindOpen ? threadFindQ : undefined}
                            />
                          </pre>
                        </details>
                      ) : null}
                      {turn.queued ? <div className="task-line">排队中</div> : null}
                      {turn.todos?.length ? (
                        <ul className="todo-list">
                          {turn.todos.map((item) => (
                            <li
                              key={item.id}
                              className={`todo-item ${item.status.replace(/\s+/g, "-")}`}
                            >
                              <span className="todo-mark">
                                {item.status === "completed"
                                  ? "✓"
                                  : item.status === "in_progress"
                                    ? "…"
                                    : "○"}
                              </span>
                              <Highlight
                                text={item.content}
                                query={threadFindOpen ? threadFindQ : undefined}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {(() => {
                        const visible = turn.tools.filter((tool) => !/todo/i.test(tool.name));
                        const ids = new Set(visible.map((tool) => tool.callId));
                        const kids = new Map<string, typeof visible>();
                        const roots: typeof visible = [];
                        for (const tool of visible) {
                          if (tool.parentCallId && ids.has(tool.parentCallId)) {
                            const list = kids.get(tool.parentCallId) || [];
                            list.push(tool);
                            kids.set(tool.parentCallId, list);
                          } else {
                            roots.push(tool);
                          }
                        }
                        const groups: (typeof visible)[] = [];
                        for (const tool of roots) {
                          const prev = groups[groups.length - 1];
                          const prevKind = prev
                            ? toolKind(prev[0].name, prev[0].args)
                            : "";
                          const kind = toolKind(tool.name, tool.args);
                          const prevFile = prev ? toolPath(prev[0]) : "";
                          const file = toolPath(tool);
                          if (
                            prev &&
                            prevKind === "search" &&
                            kind === "search"
                          ) {
                            prev.push(tool);
                          } else if (
                            prev &&
                            file &&
                            file === prevFile &&
                            (kind === "edit" || kind === "write" || kind === "read") &&
                            kind === prevKind
                          ) {
                            prev.push(tool);
                          } else {
                            groups.push([tool]);
                          }
                        }
                        const card = (tool: (typeof visible)[number]) => {
                          const nested = kids.get(tool.callId);
                          const nestedLive = Boolean(
                            turn.running && nested?.some((item) => item.status === "running"),
                          );
                          return (
                            <ToolCard
                              key={tool.callId}
                              tool={tool}
                              settled={!turn.running}
                              nestedLive={nestedLive}
                              nested={nested?.length ? nested.map(card) : undefined}
                              onOpen={openFile}
                              onAccept={
                                !turn.running && mutatingTool(tool.name) && !tool.review
                                  ? () => keepTool(turn.id, tool)
                                  : undefined
                              }
                              onReject={
                                !turn.running && mutatingTool(tool.name) && !tool.review
                                  ? () => rejectTool(turn, tool)
                                  : undefined
                              }
                            />
                          );
                        };
                        return groups.map((group) => {
                          const packKind = toolKind(group[0].name, group[0].args);
                          if (group.length > 1 && packKind === "search") {
                            const live = Boolean(
                              turn.running && group.some((tool) => tool.status === "running"),
                            );
                            return (
                              <details
                                className={`tool-pack${live ? " running" : ""}`}
                                open={live}
                                key={group.map((tool) => tool.callId).join("-")}
                              >
                                <summary>
                                  <span className={`tool-dot ${live ? "running" : "completed"}`}>
                                    <svg
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      aria-hidden="true"
                                    >
                                      <path d="M11.5 11.5 15 15M7 12a5 5 0 1 1 0-10 5 5 0 1 0 0 10Z" />
                                    </svg>
                                  </span>
                                  <span className="tool-kind">Searched</span>
                                  <span className="tool-title">
                                    {searchQuery(group[0]) || "·"}
                                  </span>
                                  <span className={`tool-badge${live ? " run" : ""}`}>
                                    {live ? <span className="text-shimmer">Processing</span> : "Completed"}
                                  </span>
                                </summary>
                                {group.map(card)}
                              </details>
                            );
                          }
                          if (
                            group.length > 1 &&
                            (packKind === "edit" || packKind === "write" || packKind === "read")
                          ) {
                            const live = Boolean(
                              turn.running && group.some((tool) => tool.status === "running"),
                            );
                            const packLabel =
                              packKind === "edit"
                                ? "Edited"
                                : packKind === "write"
                                  ? "Wrote"
                                  : "Read";
                            const file = toolPath(group[0]);
                            const short = file.split("/").pop() || file;
                            return (
                              <details
                                className={`tool-pack${live ? " running" : ""}`}
                                open={live}
                                key={group.map((tool) => tool.callId).join("-")}
                              >
                                <summary>
                                  <span className={`tool-dot ${live ? "running" : "completed"}`}>
                                    <svg
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      aria-hidden="true"
                                    >
                                      <path d="M3 13.5 12.5 4l2 2L5 15.5H3Z" />
                                    </svg>
                                  </span>
                                  <span className="tool-kind">{packLabel}</span>
                                  <span className="tool-title">
                                    {short} · {group.length} 次
                                  </span>
                                  <span className={`tool-badge${live ? " run" : ""}`}>
                                    {live ? <span className="text-shimmer">Processing</span> : "Completed"}
                                  </span>
                                </summary>
                                {group.map(card)}
                              </details>
                            );
                          }
                          return card(group[0]);
                        });
                      })()}
                      {turn.assistant && !(isProgressBlurb(turn.assistant) && !turn.running) ? (
                        <div className="markdown">
                          <Markdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              table({ children }) {
                                return (
                                  <div className="md-table">
                                    <table>{children}</table>
                                  </div>
                                );
                              },
                              pre({ children }) {
                                return <>{children}</>;
                              },
                              p({ children }) {
                                return <p>{wrapCites(children, openFile, threadFindOpen ? threadFindQ : undefined)}</p>;
                              },
                              li({ children }) {
                                return <li>{wrapCites(children, openFile, threadFindOpen ? threadFindQ : undefined)}</li>;
                              },
                              td({ children }) {
                                return <td>{wrapCites(children, openFile, threadFindOpen ? threadFindQ : undefined)}</td>;
                              },
                              a({ href, children }) {
                                const raw = (href || "").trim();
                                const local =
                                  raw &&
                                  !/^[a-z]+:/i.test(raw) &&
                                  !raw.startsWith("#") &&
                                  (isCanvasPath(raw) || isFileMention(raw));
                                if (local) {
                                  return (
                                    <button
                                      type="button"
                                      className="cite-ref"
                                      onClick={() => openFile(raw.replace(/^\.\//, ""))}
                                    >
                                      {children}
                                    </button>
                                  );
                                }
                                return (
                                  <a href={href} target="_blank" rel="noreferrer">
                                    {children}
                                  </a>
                                );
                              },
                              code({ className, children }) {
                                const text = String(children).replace(/\n$/, "");
                                const language = (className || "").replace(/^language-/, "");
                                const cite = parseCite(language);
                                if (cite) {
                                  return (
                                    <div>
                                      <button
                                        type="button"
                                        className="cite-jump"
                                        onClick={() => openFile(cite.path, cite.line)}
                                      >
                                        {cite.path}:{cite.line}
                                      </button>
                                      <CodeBlock
                                        code={text}
                                        language={cite.path.split(".").pop()}
                                        highlight={cite.line}
                                        lineNumbers
                                      />
                                    </div>
                                  );
                                }
                                if (!language && !text.includes("\n")) {
                                  return <code>{text}</code>;
                                }
                                return <CodeBlock code={text} language={language} />;
                              },
                            }}
                          >
                            {turn.assistant}
                          </Markdown>
                        </div>
                      ) : turn.running ? (
                        <div className="task-line">{turn.task || "开始动手"}</div>
                      ) : null}
                      {turn.error ? <div className="error-line">{friendlyError(turn.error)}</div> : null}
                      {!turn.running &&
                      !turn.queued &&
                      !turn.error &&
                      /approval/i.test(turn.status || "") ? (
                        <div className="run-meta">{runMeta(turn.status, turn.durationMs)}</div>
                      ) : null}
                      {turn.mode === "plan" && turn.assistant && !turn.running && !turn.queued ? (
                        <button
                          type="button"
                          className="apply-plan"
                          disabled={!connected || busy}
                          onClick={() => applyPlan(turn)}
                        >
                          执行这个计划
                        </button>
                      ) : null}
                      {(() => {
                        const paths = editPathsOf(turn);
                        const pending = turn.tools.some(
                          (tool) => mutatingTool(tool.name) && !tool.review,
                        );
                        if (
                          !paths.length ||
                          turn.running ||
                          turn.queued ||
                          !pending ||
                          writesWereRejected(turn)
                        )
                          return null;
                        return (
                          <div className="turn-review">
                            <span>{paths.length} 个文件改动</span>
                            <button type="button" className="pill" onClick={() => keepTurnFiles(turn)}>
                              全部保留
                            </button>
                            <button type="button" className="pill" onClick={() => restoreTurnFiles(turn)}>
                              全部还原
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                    </div>
                  </article>
                  );
                })}
                <div className="thread-spacer" aria-hidden="true" />
              </div>
            </div>
        )}
        </div>
        {previewTabs.length ? (
          <>
            <button
              type="button"
              className="preview-scrim"
              aria-label="收起预览"
              ref={(node) => {
                previewDrag.scrimRef.current = node;
              }}
              onClick={() => setPreviewMax(false)}
            />
            <FilePreview
            sheetRef={previewDrag.ref}
            tabs={previewTabs}
            activePath={previewPath}
            onSelect={setPreviewPath}
            onCloseTab={closePreviewTab}
            onCloseAll={() => {
              setPreviewTabs([]);
              setPreviewPath("");
              setPreviewMax(false);
            }}
            expanded={previewMax}
            onToggleExpand={() => setPreviewMax((open) => !open)}
            onCite={handlePickFile}
            onAskRange={handleAskRange}
            onToggleDiff={togglePreviewDiff}
            onRevert={revertFile}
            onKeep={keepFile}
            onRejectHunk={revertHunk}
            onSave={saveFile}
            chatId={activeId}
            onCanvasAction={handleCanvasAction}
            onOpenFile={openFile}
            canRevert={Boolean(
              gitLetterOf(previewPath, gitStatus, cwd) ||
                previewTabs.find((tab) => sameFile(tab.path, previewPath))?.diff,
            )}
            />
            <button
              type="button"
              className="preview-reopen"
              onClick={() => {
                setNavOpen(false);
                setPreviewMax(true);
              }}
            >
              {(previewTabs.find((tab) => sameFile(tab.path, previewPath)) || previewTabs[0]).path
                .split("/")
                .pop()}{" "}
              · 预览
            </button>
          </>
        ) : null}
            <div className="composer-dock">
              <div className="composer-wrap">
                {(() => {
                  const pending = empty
                    ? undefined
                    : [...active.turns].reverse().find((turn) => turn.pendingTool)?.pendingTool;
                  if (!pending) return null;
                  return (
                    <div className="approval-row">
                      <span>要改文件：{toolPreview(pending.name, pending.args)}。允许会先还原再写；拒绝还原到发送前。</span>
                      <button type="button" className="pill" onClick={() => resolveApproval(true)}>
                        允许
                      </button>
                      <button type="button" className="pill" onClick={() => resolveApproval(false)}>
                        拒绝
                      </button>
                    </div>
                  );
                })()}
                {empty || !active.turns.some((turn) => turn.queued) ? null : (
                  <div className="queue-row">
                    {active.turns
                      .filter((turn) => turn.queued)
                      .map((turn) => (
                        <span className="queue-chip" key={turn.id}>
                          <button
                            type="button"
                            className="queue-chip-send"
                            disabled={busy}
                            title={busy ? "等当前这条跑完，或先停止" : "现在发送这条"}
                            onClick={() => sendQueued(turn.id)}
                          >
                            排队 · {turn.user.slice(0, 24)}
                          </button>
                          <button
                            type="button"
                            className="queue-chip-drop"
                            title="去掉这条排队"
                            onClick={() => dropQueued(turn.id)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                  </div>
                )}
                <Composer
                  draft={draft}
                  epoch={composerEpoch}
                  images={images}
                  uploading={uploading}
                  notice={notice}
                  error={error}
                  model={model}
                  models={models}
                  setModel={persistModel}
                  mode={mode}
                  setMode={persistMode}
                  confirmWrites={Boolean(active?.confirmWrites)}
                  setConfirmWrites={persistConfirmWrites}
                  busy={busy}
                  connected={connected}
                  onSubmit={submit}
                  onStop={() => stopChat(activeId)}
                  onUndo={() => send({ type: "undo", chatId: activeId })}
                  onRestore={(id) => send({ type: "restore", chatId: activeId, checkpointId: id })}
                  onOpenMenu={() => send({ type: "list_checkpoints", chatId: activeId })}
                  checkpoints={checkpoints}
                  onAddImages={addImages}
                  onDropFiles={handleComposerFiles}
                  onRemoveImage={removeImage}
                  fileHits={fileHits}
                  mentionQuery={mentionQuery}
                  onDraftChange={handleDraftChange}
                  onPickFile={handlePickFile}
                  onOpenFile={openFile}
                  onRemoveMention={removeDraftMention}
                  onDismissMention={dismissMention}
                  caret={draftCaret}
                  onCaretApplied={() => setDraftCaret(null)}
                  centered={empty}
                />
              </div>
            </div>
      </main>
    </div>
  );
}

function Composer({
  draft,
  epoch,
  images,
  uploading,
  notice,
  error,
  model,
  models,
  setModel,
  mode,
  setMode,
  confirmWrites,
  setConfirmWrites,
  busy,
  connected,
  onSubmit,
  onStop,
  onUndo,
  onRestore,
  onOpenMenu,
  checkpoints,
  onAddImages,
  onDropFiles,
  onRemoveImage,
  fileHits,
  mentionQuery,
  onDraftChange,
  onPickFile,
  onOpenFile,
  onRemoveMention,
  onDismissMention,
  caret,
  onCaretApplied,
  centered,
}: {
  draft: string;
  epoch: number;
  images: PromptImage[];
  uploading?: number;
  notice?: string;
  error?: string;
  model: string;
  models: string[];
  setModel: (value: string) => void;
  mode: AgentMode;
  setMode: (value: AgentMode) => void;
  confirmWrites: boolean;
  setConfirmWrites: (value: boolean) => void;
  busy: boolean;
  connected: boolean;
  onSubmit: (text?: string) => void;
  onStop: () => void;
  onUndo: () => void;
  onRestore: (id: string) => void;
  onOpenMenu?: () => void;
  checkpoints: CheckpointInfo[];
  onAddImages: (files: FileList | File[]) => void;
  onDropFiles?: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  fileHits: string[];
  mentionQuery: string | null;
  onDraftChange: (value: string, caret: number) => void;
  onPickFile: (path: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onRemoveMention: (token: string) => void;
  onDismissMention: () => void;
  caret?: number | null;
  onCaretApplied?: () => void;
  centered?: boolean;
}) {
  const mentioning = mentionQuery != null;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composingRef = useRef(false);
  const sendLockRef = useRef(false);
  const [text, setText] = useState(draft);
  const [moreOpen, setMoreOpen] = useState(false);
  const [density, setDensity] = useState<"full" | "mid" | "compact" | "tight">("full");
  const modesRef = useRef<HTMLDivElement | null>(null);
  const thumbLive = useRef(false);
  const [thumb, setThumb] = useState({ x: 0, w: 0, live: false });
  const chips = mentionChips(text);
  const canSend = Boolean(text.trim() || images.length) && !uploading;
  useLayoutEffect(() => {
    setText(draft);
    const el = inputRef.current;
    if (el && el.value !== draft) el.value = draft;
  }, [epoch, draft]);
  useEffect(() => {
    if (caret == null || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(caret, caret);
    onCaretApplied?.();
  }, [caret, epoch, onCaretApplied]);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const apply = () => {
      const width = el.getBoundingClientRect().width;
      const next = width <= 400 ? "tight" : width <= 480 ? "compact" : width <= 560 ? "mid" : "full";
      setDensity((prev) => (prev === next ? prev : next));
    };
    apply();
    // Some embedded Chromium views never fire ResizeObserver / container queries.
    const interval = window.setInterval(apply, 200);
    window.addEventListener("resize", apply);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(apply);
      observer.observe(el);
    }
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", apply);
      observer?.disconnect();
    };
  }, []);
  useEffect(() => {
    const root = modesRef.current;
    if (!root) return;
    const applyThumb = () => {
      const activeBtn = root.querySelector<HTMLElement>(".mode-btn.on");
      if (!activeBtn) return;
      setThumb({ x: activeBtn.offsetLeft, w: activeBtn.offsetWidth, live: thumbLive.current });
      if (!thumbLive.current) {
        requestAnimationFrame(() => {
          thumbLive.current = true;
          setThumb((prev) => ({ ...prev, live: true }));
        });
      }
    };
    applyThumb();
    const ro = new ResizeObserver(applyThumb);
    ro.observe(root);
    root.querySelectorAll(".mode-btn").forEach((btn) => ro.observe(btn));
    root.addEventListener("transitionend", applyThumb);
    return () => {
      ro.disconnect();
      root.removeEventListener("transitionend", applyThumb);
    };
  }, [mode, density]);
  function flushDraft() {
    const el = inputRef.current;
    const value = el ? el.value : text;
    composingRef.current = false;
    setText(value);
    onDraftChange(value, el?.selectionStart ?? value.length);
    return value;
  }
  function sendNow() {
    if (!canSend || sendLockRef.current) return;
    sendLockRef.current = true;
    onSubmit(flushDraft());
    queueMicrotask(() => {
      sendLockRef.current = false;
    });
  }
  return (
    <>
    <form
      ref={composerRef}
      className={`composer density-${density}${centered ? " centered" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        sendNow();
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const list = Array.from(event.dataTransfer.files);
        if (!list.length) return;
        if (onDropFiles) onDropFiles(list);
        else onAddImages(list);
      }}
    >
      <div className="composer-body">
      {mentioning ? (
        <div className="mention-list">
          {fileHits.length ? (
            fileHits.map((path) => (
              <button
                key={path}
                type="button"
                className="mention-item"
                onClick={() => onPickFile(path)}
              >
                {path}
              </button>
            ))
          ) : (
            <div className="mention-item muted">没有匹配的文件</div>
          )}
        </div>
      ) : null}
      {chips.length ? (
        <div className="mention-chips">
          {chips.map((chip) => (
            <span className="mention-chip" key={chip.key}>
              <button
                type="button"
                className="mention-chip-open"
                title={chip.token}
                onClick={() => {
                  if (!isOpenableMention(chip.path)) return;
                  onOpenFile(chip.path, chip.line);
                }}
              >
                @{/^diff$/i.test(chip.path) ? "Diff" : chip.path.split("/").pop()}
                {chip.line ? `:${chip.line}` : ""}
                {chip.endLine ? `-${chip.endLine}` : ""}
              </button>
              <button
                type="button"
                className="mention-chip-drop"
                title="去掉这个引用"
                onClick={() => onRemoveMention(chip.token)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {error ? <div className="error-line">{error}</div> : null}
      {notice && !error ? <div className="notice-line">{notice}</div> : null}
      {uploading ? (
        <div className="composer-upload">正在上传 {uploading} 个文件…</div>
      ) : null}
      {images.length ? (
        <div className="composer-thumbs">
          {images.map((img, index) => (
            <button
              key={`${img.mimeType}-${index}`}
              type="button"
              className="composer-thumb"
              onClick={() => onRemoveImage(index)}
              title="去掉这张图"
            >
              <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        className="composer-input"
        defaultValue={draft}
        placeholder={
          !connected
            ? "正在连服务器…"
            : busy
              ? "正在动手，Enter 会排队"
              : mode === "ask"
                ? "问一句，不改文件，@ 引用"
                : mode === "plan"
                  ? "描述任务，只出方案，@ 引用"
                  : "交代要做的事，@ 引用文件"
        }
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="send"
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!files.length) return;
          event.preventDefault();
          if (onDropFiles) onDropFiles(files);
          else onAddImages(files);
        }}
        onInput={(event) => {
          const el = event.currentTarget;
          const value = el.value;
          if (!composingRef.current) setText(value);
          onDraftChange(value, el.selectionStart ?? value.length);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          const el = inputRef.current;
          if (el) {
            setText(el.value);
            onDraftChange(el.value, el.selectionStart ?? el.value.length);
          }
        }}
        onKeyDown={(event) => {
          const composing = composingRef.current || event.nativeEvent.isComposing;
          if (mentioning && event.key === "Enter" && !composing) {
            if (fileHits[0]) {
              event.preventDefault();
              onPickFile(fileHits[0]);
            }
            return;
          }
          if (event.key === "Escape" && mentionQuery != null) {
            event.preventDefault();
            onDismissMention();
            return;
          }
          if (event.key === "Escape" && busy) {
            event.preventDefault();
            onStop();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          if (composing) return;
          event.preventDefault();
          sendNow();
        }}
      />
      </div>
      <div className="composer-bar">
        <label className="pill icon composer-attach" title="添加文件或图片" aria-label="添加文件或图片">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="file"
            multiple
            className="composer-file-input"
            onClick={(event) => {
              event.currentTarget.value = "";
            }}
            onChange={(event) => {
              const list = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
              if (!list.length) return;
              if (onDropFiles) onDropFiles(list);
              else onAddImages(list);
            }}
          />
        </label>
        <div className="mode-switch" role="tablist" aria-label="工作方式" ref={modesRef}>
          <span
            className={`mode-thumb${thumb.live ? " live" : ""}`}
            style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
            aria-hidden="true"
          />
          {(["agent", "plan", "ask"] as AgentMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={`mode-btn${mode === item ? " on" : ""}`}
              title={item === "agent" ? "动手" : item === "plan" ? "方案" : "只问"}
              aria-label={item === "agent" ? "动手" : item === "plan" ? "方案" : "只问"}
              onClick={() => setMode(item)}
            >
              {item === "agent" ? <IconAgent /> : item === "plan" ? <IconPlan /> : <IconAsk />}
              <span className="mode-label">{item === "agent" ? "动手" : item === "plan" ? "方案" : "只问"}</span>
            </button>
          ))}
        </div>
        <ModelPicker
          model={model}
          models={models}
          onChange={setModel}
          dismiss={moreOpen}
          onOpen={() => setMoreOpen(false)}
        />
        <button
          type="button"
          className={`mode-btn confirm-btn${confirmWrites ? " on" : ""}`}
          title={confirmWrites ? "写入前先问你" : "直接写入"}
          aria-label={confirmWrites ? "确认写" : "直写"}
          onClick={() => setConfirmWrites(!confirmWrites)}
        >
          {confirmWrites ? <IconShield /> : <IconWrite />}
          <span className="confirm-label">{confirmWrites ? "确认写" : "直写"}</span>
        </button>
        <span className="grow" />
        <div className="composer-more">
          <button
            type="button"
            className="pill icon"
            title="更多"
            onClick={() => {
              setMoreOpen((open) => {
                const next = !open;
                if (next) onOpenMenu?.();
                return next;
              });
            }}
          >
            ···
          </button>
          {moreOpen ? (
            <div className="composer-menu">
              <button
                type="button"
                className={confirmWrites ? "on" : ""}
                onClick={() => {
                  setConfirmWrites(!confirmWrites);
                  setMoreOpen(false);
                }}
              >
                {confirmWrites ? "确认写入 · 开" : "确认写入"}
              </button>
              {!busy ? (
                <button
                  type="button"
                  onClick={() => {
                    onUndo();
                    setMoreOpen(false);
                  }}
                >
                  撤销上一次
                </button>
              ) : null}
              {checkpoints.length ? (
                <>
                  <div className="composer-menu-label">检查点 · {checkpoints.length}</div>
                  {checkpoints.map((item) => (
                  <button
                    key={`${item.id}-${item.createdAt}`}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      onRestore(item.id);
                      setMoreOpen(false);
                    }}
                  >
                    还原 · {item.label}
                  </button>
                  ))}
                </>
              ) : (
                <button type="button" disabled>
                  {mode === "ask" ? "只问不会打检查点" : "动手或出方案时会记下检查点"}
                </button>
              )}
            </div>
          ) : null}
        </div>
        {busy ? (
          <button className="send stop" type="button" onClick={onStop} title="Esc 停止">
            ■
          </button>
        ) : null}
        <button className="send" type="submit" disabled={!canSend}>
          ↑
        </button>
      </div>
    </form>
      {centered ? (
        <div className="hint desk-only">
          ⌘N 新对话 · ⌘K 搜会话 · ⌘P 打开文件 · 可粘贴或上传文件
        </div>
      ) : null}
    </>
  );
}
