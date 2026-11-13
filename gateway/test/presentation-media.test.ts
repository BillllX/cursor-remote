import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { handleMedia } from "../src/http/routes.ts";
import { mediaTicket } from "../src/media.ts";
import { getTenant } from "../src/tenants.ts";
import { storeArtifact } from "../src/turnFiles.ts";

const base = mkdtempSync(join(tmpdir(), "ppt-http-test-"));
const workspace = join(base, "workspace");
const originalPath = process.env.PATH;
process.env.CURSOR_REMOTE_TENANTS_FILE = join(base, "missing.json");
process.env.CURSOR_REMOTE_TOKEN = "ppt-test-token";
process.env.CURSOR_REMOTE_CWD = workspace;
process.env.CURSOR_REMOTE_STATE_DIR = join(base, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "ppt-media-secret";
process.env.PATH = `${base}:${originalPath}`;
mkdirSync(workspace);
writeFileSync(join(workspace, "演示.PPTX"), "live slides");
writeFileSync(
  join(base, "libreoffice"),
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = args[args.indexOf('--outdir') + 1];
fs.writeFileSync(path.join(dir, 'slides.pdf'), '%PDF-1.4\\n' + fs.readFileSync(args.at(-1), 'utf8'));
`,
);
chmodSync(join(base, "libreoffice"), 0o700);
const server = createServer((req, res) => {
  void handleMedia(req, res, new URL(req.url!, "http://localhost")).catch(() => res.writeHead(500).end());
});
let origin = "";
let snapshot = "";
before(async () => {
  const tenant = getTenant("default")!;
  tenant.disk.chats = [{ id: "chat-ppt", cwd: workspace }];
  snapshot = storeArtifact(tenant.stateDir, Buffer.from("snapshot slides")).sha;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.PATH = originalPath;
  rmSync(base, { recursive: true, force: true });
});

function url(extra: Record<string, string> = {}) {
  const ticket = mediaTicket("ppt-media-secret", "default", "chat-ppt")!;
  return `${origin}/media?${new URLSearchParams({ path: "演示.PPTX", chatId: "chat-ppt", exp: String(ticket.exp), sig: ticket.sig, preview: "pdf", ...extra })}`;
}

test("PPT 转换先校验媒体票据、文件类型和工作区边界", async () => {
  assert.equal((await fetch(url({ sig: "invalid" }))).status, 401);
  assert.equal((await fetch(url({ exp: "1" }))).status, 401);
  assert.equal((await fetch(url({ path: "data.docx" }))).status, 400);
  assert.equal((await fetch(url({ path: "../outside.pptx" }))).status, 403);
  symlinkSync(join(workspace, "演示.PPTX"), join(workspace, "linked.pptx"));
  assert.equal((await fetch(url({ path: "linked.pptx" }))).status, 403);
});

test("当前 PPT 返回私有 PDF，原始下载保留 PPT MIME 与内容", async () => {
  const preview = await fetch(url());
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "application/pdf");
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.match(await preview.text(), /live slides/);
  const original = await fetch(url({ preview: "" }));
  assert.match(original.headers.get("content-type")!, /presentationml/);
  assert.equal(await original.text(), "live slides");
});

test("历史快照使用快照内容，转换输出兼容 Range 和 HEAD", async () => {
  const preview = await fetch(url({ rev: `sha:${snapshot}` }));
  assert.match(await preview.text(), /snapshot slides/);
  const range = await fetch(url(), { headers: { Range: "bytes=0-4" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "%PDF-");
  const head = await fetch(url(), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "application/pdf");
  assert.equal(await head.text(), "");
});
