import type { PreviewKind } from "./protocol.ts";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac"]);
const VIDEO_EXT = new Set(["mp4", "webm"]);
const MARKDOWN_EXT = new Set(["md", "mdx", "markdown"]);
const HTML_EXT = new Set(["html", "htm"]);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  mdx: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
};

export function fileExt(path: string) {
  const base = path.replace(/\\/g, "/").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function kindFromPath(path: string): PreviewKind {
  const normalized = path.replace(/\\/g, "/");
  if (/\.canvas\.tsx$/i.test(normalized)) return "canvas";
  const ext = fileExt(normalized);
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "svg") return "svg";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (ext === "pdf") return "pdf";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "text";
}

export function mimeOf(path: string, kind = kindFromPath(path)) {
  const ext = fileExt(path);
  if (MIME[ext]) return MIME[ext];
  if (kind === "text") return "text/plain; charset=utf-8";
  if (kind === "canvas") return "text/tsx; charset=utf-8";
  if (kind === "binary") return "application/octet-stream";
  return "application/octet-stream";
}

export function sizeLimit(kind: PreviewKind) {
  if (kind === "canvas" || kind === "markdown") return 800_000;
  if (kind === "html" || kind === "svg") return 2_000_000;
  if (kind === "image") return 20 * 1024 * 1024;
  if (kind === "pdf" || kind === "audio") return 40 * 1024 * 1024;
  if (kind === "video") return 80 * 1024 * 1024;
  return 200_000;
}

export function isByteKind(kind: PreviewKind) {
  return kind === "image" || kind === "pdf" || kind === "audio" || kind === "video";
}

export function needsMediaUrl(kind: PreviewKind) {
  return isByteKind(kind) || kind === "svg";
}

export function preferHttpText(kind: PreviewKind) {
  return kind === "canvas" || kind === "markdown" || kind === "html";
}

export function isLiveKind(kind: PreviewKind) {
  return kind === "canvas" || kind === "markdown" || kind === "html" || kind === "svg";
}

export function isWideKind(kind: PreviewKind) {
  return kind === "canvas" || kind === "html" || kind === "markdown" || kind === "pdf";
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function resolveAssetPath(fromFile: string, href: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;
  if (raw.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const clean = raw.split("#")[0].split("?")[0];
  if (!clean) return null;
  const from = fromFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const parts = [...(dir ? dir.split("/") : []), ...clean.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}
