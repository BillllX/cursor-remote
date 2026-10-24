import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { Artifact, PreviewKind, TurnFile } from "../../../shared/protocol.ts";
import type { Delegation } from "./delegations.ts";
import type { InboxItem } from "./inbox.ts";

export const ARTIFACT_PROJECTION_LIMIT = 200;

export type ArtifactProjectionInput = {
  chats: unknown[];
  delegations: Delegation[];
  inbox: InboxItem[];
};

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 只允许工作区相对路径；绝对路径、反斜杠和任何越界段都不进入投影。 */
export function safeArtifactPath(value: unknown): string | undefined {
  const path = text(value);
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return undefined;
  }
  return path;
}

export function safeArtifactURL(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function stableId(parts: string[]) {
  return `artifact:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function previewKind(path: string): PreviewKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".canvas.tsx") || lower.endsWith(".canvas.jsx")) return "canvas";
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".mdx") return "markdown";
  if (extension === ".html" || extension === ".htm") return "html";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".avif"].includes(extension)) return "image";
  if (extension === ".svg") return "svg";
  if (extension === ".pdf") return "pdf";
  if ([".mp3", ".m4a", ".wav", ".aac", ".ogg"].includes(extension)) return "audio";
  if ([".mp4", ".mov", ".m4v", ".webm"].includes(extension)) return "video";
  return "text";
}

function turnFile(value: unknown): TurnFile | null {
  const row = record(value);
  const path = safeArtifactPath(row?.path);
  if (!row || !path) return null;
  const rawKind = text(row.kind);
  const knownKinds = new Set<PreviewKind>([
    "text",
    "canvas",
    "markdown",
    "html",
    "image",
    "svg",
    "pdf",
    "audio",
    "video",
    "binary",
  ]);
  const kind = rawKind && knownKinds.has(rawKind as PreviewKind) ? (rawKind as PreviewKind) : undefined;
  return {
    path,
    kind: kind ?? previewKind(path),
    op: row.op === "added" ? "added" : "modified",
    sha: text(row.sha),
    diffSha: text(row.diffSha),
    sourceChatId: text(row.sourceChatId),
    sourceTurnId: text(row.sourceTurnId),
  };
}

function sourceLabel(chatTitle: string, delegation?: Delegation) {
  const value = delegation?.title || chatTitle;
  if (
    !value ||
    /(^|\s)\/(?:[^/\s]+\/)*[^/\s]+/.test(value) ||
    /(^|\s)[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\0")
  ) {
    return undefined;
  }
  return `${delegation ? "委派" : "会话"}：${value.slice(0, 120)}`;
}

/** 纯函数：不读文件、不写索引，也不携带 turn 正文或委派任务正文。 */
export function buildArtifactProjection(input: ArtifactProjectionInput, limit = ARTIFACT_PROJECTION_LIMIT): Artifact[] {
  const rows: Artifact[] = [];
  const delegations = new Map(input.delegations.map((item) => [item.childChatId, item]));
  const assistantChatId = input.chats.map(record).find((chat) => chat?.assistant === true)?.id;

  for (const rawChat of input.chats) {
    const chat = record(rawChat);
    const chatId = text(chat?.id);
    if (!chat || !chatId || !Array.isArray(chat.turns)) continue;
    const chatTitle = text(chat.title) ?? "";
    for (const rawTurn of chat.turns) {
      const turn = record(rawTurn);
      const turnId = text(turn?.id);
      if (!turn || !turnId || !Array.isArray(turn.files)) continue;
      const createdAt = typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) ? turn.startedAt : 0;
      for (const rawFile of turn.files) {
        const file = turnFile(rawFile);
        if (!file) continue;
        const sourceChatId = file.sourceChatId ?? chatId;
        const sourceTurnId = file.sourceTurnId ?? turnId;
        const delegation = delegations.get(sourceChatId);
        rows.push({
          id: stableId(["file", sourceChatId, sourceTurnId, file.path, file.sha ?? "", file.diffSha ?? ""]),
          title: basename(file.path),
          kind: "file",
          previewKind: file.kind,
          createdAt,
          path: file.path,
          sha: file.sha,
          diffSha: file.diffSha,
          sourceChatId,
          sourceTurnId,
          provenance: {
            turnId: sourceTurnId,
            delegationId: delegation?.id,
            collabTaskId: delegation?.collabTaskId,
            label: sourceLabel(chatTitle, delegation),
          },
        });
      }
    }
  }

  for (const item of input.inbox) {
    const capture = item.capture;
    if (!capture) continue;
    const provenance = { inboxId: item.id, captureId: item.id, label: "助理收件箱" };
    if (capture.kind === "link") {
      const url = safeArtifactURL(capture.url);
      if (!url) continue;
      const title = text(capture.title) ?? new URL(url).hostname;
      rows.push({
        id: stableId(["link", item.id, url]),
        title,
        kind: "link",
        createdAt: item.createdAt,
        url,
        provenance,
        sourceCitation: { url, title, capturedAt: item.createdAt },
      });
      continue;
    }
    if (capture.kind === "file") {
      const path = safeArtifactPath(capture.path);
      const sha = text(capture.sha);
      // Share 文件只能来自租户 artifacts 快照；旧版工作区路径不再作为可信来源。
      if (!path || !sha || !/^[0-9a-f]{64}$/.test(sha)) continue;
      rows.push({
        id: stableId(["capture-file", item.id, path, sha]),
        title: text(capture.title) ?? basename(path),
        kind: "file",
        previewKind: previewKind(path),
        createdAt: item.createdAt,
        path,
        sha,
        sourceChatId: typeof assistantChatId === "string" ? assistantChatId : undefined,
        provenance,
      });
      continue;
    }
    rows.push({
      id: stableId(["capture", item.id, capture.kind]),
      title: text(capture.title) ?? (capture.kind === "location" ? "位置捕获" : "文本捕获"),
      kind: "capture",
      previewKind: "text",
      createdAt: item.createdAt,
      provenance,
    });
  }

  const deduped = new Map<string, Artifact>();
  for (const artifact of rows) {
    const known = deduped.get(artifact.id);
    if (!known || artifact.createdAt > known.createdAt) deduped.set(artifact.id, artifact);
  }
  return [...deduped.values()]
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
