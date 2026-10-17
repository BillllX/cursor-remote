import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasVersion } from "../../shared/protocol.ts";
import { atomicWriteFileSync } from "./fsAtomic.ts";
import { checkArtifactQuota, isSha, readArtifact, storeArtifact } from "./turnFiles.ts";

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_VERSIONS = 50;
const TOKEN_RE = /^[a-f0-9]{32}$/;

type StoredVersion = CanvasVersion & { htmlSha: string };
type CanvasFile = {
  v: 1;
  paths: Record<string, StoredVersion[]>;
  shares: Record<string, { path: string; sha: string; htmlSha: string; createdAt: number }>;
};
type CanvasTenant = { id: string; stateDir: string };

function metadataPath(stateDir: string) {
  return resolve(stateDir, "canvas-versions.json");
}

function readMetadata(stateDir: string): CanvasFile {
  try {
    const value = JSON.parse(readFileSync(metadataPath(stateDir), "utf8")) as CanvasFile;
    if (value?.v === 1 && value.paths && value.shares) return value;
  } catch {
    // 首次使用或损坏时从空索引开始；artifacts 本身仍然安全保留
  }
  return { v: 1, paths: {}, shares: {} };
}

function writeMetadata(stateDir: string, value: CanvasFile) {
  atomicWriteFileSync(metadataPath(stateDir), JSON.stringify(value), { mkdir: true, mode: 0o600 });
}

export function isCanvasPath(path: string) {
  return /\.canvas\.tsx$/i.test(path);
}

function staticHtml(buf: Buffer) {
  const probe = buf.subarray(0, 4096).toString("utf8").trimStart().toLowerCase();
  return probe.startsWith("<!doctype html") || probe.startsWith("<html");
}

export function saveCanvasVersion(
  tenant: CanvasTenant,
  path: string,
  sourceSha: string | undefined,
  html: string,
  now = Date.now(),
  source?: Buffer,
): CanvasVersion {
  if (!isCanvasPath(path)) throw new Error("只能保存 .canvas.tsx 的版本。");
  let resolvedSourceSha = sourceSha;
  if (!resolvedSourceSha || !isSha(resolvedSourceSha) || !readArtifact(tenant.stateDir, resolvedSourceSha)) {
    if (!source?.length || source.length > MAX_HTML_BYTES) throw new Error("Canvas 源码版本已清理、为空或过大。");
    resolvedSourceSha = storeArtifact(tenant.stateDir, source).sha;
  }
  const htmlBuf = Buffer.from(html, "utf8");
  if (!htmlBuf.length || htmlBuf.length > MAX_HTML_BYTES || !staticHtml(htmlBuf)) {
    throw new Error("静态 HTML 为空、过大或格式不合法。");
  }
  const htmlSha = storeArtifact(tenant.stateDir, htmlBuf).sha;
  const data = readMetadata(tenant.stateDir);
  const previous = data.paths[path] || [];
  const existing = previous.find((row) => row.sha === resolvedSourceSha);
  const row: StoredVersion = existing ? { ...existing, htmlSha } : { sha: resolvedSourceSha, htmlSha, createdAt: now };
  data.paths[path] = [row, ...previous.filter((item) => item.sha !== resolvedSourceSha)].slice(0, MAX_VERSIONS);
  for (const share of Object.values(data.shares)) {
    if (share.path === path && share.sha === resolvedSourceSha) share.htmlSha = htmlSha;
  }
  writeMetadata(tenant.stateDir, data);
  checkArtifactQuota(tenant.stateDir);
  return row;
}

export function listCanvasVersions(
  tenant: CanvasTenant,
  path: string,
  urlFor: (token: string) => string,
): CanvasVersion[] {
  if (!isCanvasPath(path)) return [];
  const data = readMetadata(tenant.stateDir);
  const shares = new Map<string, string>();
  for (const [token, share] of Object.entries(data.shares)) {
    if (share.path === path) shares.set(share.sha, urlFor(token));
  }
  return (data.paths[path] || [])
    .filter((row) => isSha(row.sha) && isSha(row.htmlSha))
    .map((row) => ({ ...row, shareUrl: shares.get(row.sha) }));
}

export function publishCanvasVersion(
  tenant: CanvasTenant,
  path: string,
  sha: string,
  urlFor: (token: string) => string,
  now = Date.now(),
): { sha: string; url: string } {
  if (!isCanvasPath(path) || !isSha(sha)) throw new Error("Canvas 路径或版本不合法。");
  const data = readMetadata(tenant.stateDir);
  const version = (data.paths[path] || []).find((row) => row.sha === sha);
  if (!version || !readArtifact(tenant.stateDir, version.htmlSha))
    throw new Error("这个 Canvas 版本尚无静态 HTML，或已被清理。");
  let token = Object.entries(data.shares).find(([, row]) => row.path === path && row.sha === sha)?.[0];
  if (!token) {
    token = randomBytes(16).toString("hex");
    data.shares[token] = { path, sha, htmlSha: version.htmlSha, createdAt: now };
    writeMetadata(tenant.stateDir, data);
  }
  return { sha, url: urlFor(token) };
}

/** 恢复只能读取该路径已登记的源码版本，不能拿任意租户 artifact 覆盖工作区文件。 */
export function readCanvasVersionSource(tenant: CanvasTenant, path: string, sha: string): Buffer | null {
  if (!isCanvasPath(path) || !isSha(sha)) return null;
  const version = (readMetadata(tenant.stateDir).paths[path] || []).find((row) => row.sha === sha);
  return version ? readArtifact(tenant.stateDir, version.sha) : null;
}

/** /p/<tenant>/c/<opaque token>：只按租户内索引读 HTML artifact，URL 从不接受文件路径或 sha。 */
export function servePublishedCanvas(
  tenant: CanvasTenant,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const share = readMetadata(tenant.stateDir).shares[token];
  if (!share || !isSha(share.htmlSha)) return false;
  const buf = readArtifact(tenant.stateDir, share.htmlSha);
  if (!buf || !staticHtml(buf)) return false;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "public, max-age=60",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data: https:; frame-ancestors *",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : buf);
  return true;
}

export function hasCanvasMetadata(stateDir: string) {
  return existsSync(metadataPath(stateDir));
}
