import { previewSrc } from "./preview";

const MAX = 24;
const cache = new Map<string, string>();

function key(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function peekPreviewText(path: string) {
  return cache.get(key(path));
}

export function putPreviewText(path: string, content: string) {
  const k = key(path);
  if (cache.has(k)) cache.delete(k);
  cache.set(k, content);
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export async function fetchPreviewText(url: string, signal?: AbortSignal) {
  const href = previewSrc(url);
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 8000);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(href, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`preview ${res.status}`);
    return await res.text();
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
