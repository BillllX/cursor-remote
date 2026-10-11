import type { MediaTicket, PreviewKind } from "@shared/protocol";
import { kindFromPath, resolveAssetPath } from "@shared/preview";

// 与网关共用的判定逻辑都在 shared/preview.ts；这里只放网页独有的（拼地址、改写 HTML）
export {
  fileExt,
  formatBytes,
  isLiveKind,
  isWideKind,
  kindFromPath,
  needsMediaUrl,
  preferHttpText,
  resolveAssetPath,
} from "@shared/preview";

export function tabKind(path: string, kind?: string): PreviewKind {
  if (kind && kind !== "file") return kind as PreviewKind;
  return kindFromPath(path);
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

function isHttpUrl(url: string) {
  return /^https?:\/\//i.test(url.trim());
}

export function rewriteHtml(source: string, fromFile: string, toSrc: (workspacePath: string) => string): string {
  const rewritten = source.replace(/(\s)(src|href)=(["'])([^"']*)\3/gi, (full, space, attr, quote, url) => {
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
  });
  const csp =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"base-uri 'none'; object-src 'none'; form-action 'none'\">";
  if (/<head[\s>]/i.test(rewritten)) {
    return rewritten.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  }
  if (/<html[\s>]/i.test(rewritten)) {
    return rewritten.replace(/<html([^>]*)>/i, `<html$1><head>${csp}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${rewritten}</body></html>`;
}
