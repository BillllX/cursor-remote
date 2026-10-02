import type { MediaTicket, PreviewKind } from "./protocol";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac"]);
const VIDEO_EXT = new Set(["mp4", "webm"]);
const MARKDOWN_EXT = new Set(["md", "mdx", "markdown"]);
const HTML_EXT = new Set(["html", "htm"]);

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

export function tabKind(path: string, kind?: string): PreviewKind {
  if (kind && kind !== "file") return kind as PreviewKind;
  return kindFromPath(path);
}

export function isLiveKind(kind: PreviewKind) {
  return kind === "canvas" || kind === "markdown" || kind === "html" || kind === "svg";
}

export function isWideKind(kind: PreviewKind) {
  return kind === "canvas" || kind === "html" || kind === "markdown" || kind === "pdf";
}

export function needsMediaUrl(kind: PreviewKind) {
  return kind === "image" || kind === "svg" || kind === "pdf" || kind === "audio" || kind === "video";
}

export function preferHttpText(kind: PreviewKind) {
  return kind === "canvas" || kind === "markdown" || kind === "html";
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const ONLINE_ORIGIN = "https://jiebo.aiagentswitcher.com";

function originBase() {
  if (typeof window !== "undefined" && window.location.port === "3000") return ONLINE_ORIGIN;
  return process.env.NEXT_PUBLIC_BASE_PATH || "";
}

export function previewSrc(url?: string) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || url.startsWith("blob:")) return url;
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${originBase()}${path}`;
}

export function mediaSrc(path: string, chatId: string, media?: MediaTicket, rev?: string) {
  if (!path || !chatId || !media) return "";
  const q = new URLSearchParams({
    path,
    chatId,
    exp: String(media.exp),
    sig: media.sig,
  });
  if (rev) q.set("rev", rev);
  return `${originBase()}/media?${q}`;
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

function isHttpUrl(url: string) {
  return /^https?:\/\//i.test(url.trim());
}

export function rewriteHtml(
  source: string,
  fromFile: string,
  toSrc: (workspacePath: string) => string,
): string {
  const rewritten = source.replace(
    /(\s)(src|href)=(["'])([^"']*)\3/gi,
    (full, space, attr, quote, url) => {
      const raw = String(url || "").trim();
      if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("blob:")) return full;
      if (/^javascript:/i.test(raw)) return `${space}${attr}=${quote}${quote}`;
      const lower = attr.toLowerCase();
      if (isHttpUrl(raw)) {
        if (lower === "href") return full;
        if (lower === "src" && /\.(css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(\?|$)/i.test(raw)) return full;
        return `${space}${attr}=${quote}${quote}`;
      }
      const resolved = resolveAssetPath(fromFile, raw);
      if (!resolved) return `${space}${attr}=${quote}${quote}`;
      return `${space}${attr}=${quote}${toSrc(resolved)}${quote}`;
    },
  );
  const csp =
    '<meta http-equiv="Content-Security-Policy" content="base-uri \'none\'; object-src \'none\'; form-action \'none\'">';
  if (/<head[\s>]/i.test(rewritten)) {
    return rewritten.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  }
  if (/<html[\s>]/i.test(rewritten)) {
    return rewritten.replace(/<html([^>]*)>/i, `<html$1><head>${csp}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${rewritten}</body></html>`;
}
