import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  handleAssistantFileIngest,
  handleAssistantIngest,
  sniffCaptureImageMime,
  validateCapture,
  validateFileMetadata,
} from "../src/assistant/captureHttp.ts";
import { assistantTools } from "../src/assistant/tools.ts";
import { listInbox, postInbox } from "../src/assistant/inbox.ts";
import { getTenant, loadTenants } from "../src/tenants.ts";
import { artifactPath, storeArtifact } from "../src/turnFiles.ts";

const root = mkdtempSync(join(tmpdir(), "jiebo-assistant-capture-"));
const workspace = join(root, "user");
const token = "assistant-capture-test-token";
process.env.CURSOR_REMOTE_TENANTS_FILE = join(root, "missing.json");
process.env.CURSOR_REMOTE_TOKEN = token;
process.env.CURSOR_REMOTE_CWD = workspace;
process.env.CURSOR_REMOTE_STATE_DIR = join(root, "state");
process.env.CURSOR_REMOTE_MEDIA_SECRET = "assistant-capture-test-secret";

let server: Server;
let origin = "";

before(async () => {
  mkdirSync(workspace, { recursive: true });
  loadTenants();
  server = createServer((req, res) => {
    if (req.url === "/upload/assistant/ingest") return void handleAssistantIngest(req, res);
    if (req.url === "/upload/assistant/ingest-file") return void handleAssistantFileIngest(req, res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function metadata(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function oversizedFileStatus(header: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL("/upload/assistant/ingest-file", origin);
    const req = request(
      target,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "content-length": String(32 * 1024 * 1024 + 1),
          "x-jiebo-assistant": header,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode || 0));
      },
    );
    req.on("error", reject);
    req.flushHeaders();
  });
}

describe("assistant capture HTTP", () => {
  test("校验内容、文件名与 MIME", () => {
    assert.equal(validateCapture({ clientId: "../bad", kind: "text", text: "x", intent: "总结" }), null);
    assert.equal(validateCapture({ clientId: "ok-1", kind: "location", lat: 91, lng: 1, intent: "总结" }), null);
    assert.equal(
      validateFileMetadata({
        clientId: "ok-1",
        kind: "file",
        filename: "../secret",
        mime: "text/plain",
        intent: "记住",
      }),
      null,
    );
    assert.equal(sniffCaptureImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
    assert.equal(sniffCaptureImageMime(Buffer.from("<svg>")), null);
    assert.equal(
      validateFileMetadata({
        clientId: "ok-1",
        kind: "file",
        filename: "page.html",
        mime: "text/html",
        intent: "记住",
      }),
      null,
    );
  });

  test("Bearer、浏览器 Origin 和 64KB 上限", async () => {
    const noAuth = await fetch(`${origin}/upload/assistant/ingest`, { method: "POST", body: "{}" });
    assert.equal(noAuth.status, 401);
    const browser = await fetch(`${origin}/upload/assistant/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(browser.status, 403);
    const large = await fetch(`${origin}/upload/assistant/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "large-1",
        kind: "text",
        text: "x".repeat(70 * 1024),
        intent: "总结",
      }),
    });
    assert.equal(large.status, 413);
  });

  test("JSON clientId 幂等并形成可继续处理的 inbox prompt", async () => {
    const body = JSON.stringify({
      clientId: "json-1",
      kind: "link",
      url: "https://example.com/article",
      title: "文章",
      intent: "稍后读",
      note: "周末看",
    });
    const send = () =>
      fetch(`${origin}/upload/assistant/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    const first = await send();
    const second = await send();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { created: boolean }).created, false);
    const tenant = getTenant("default")!;
    const rows = listInbox(tenant, 300).filter((item) => item.key === "assistant-capture:json-1");
    assert.equal(rows.length, 1);
    assert.match(rows[0].actionPrompt || "", /稍后读/);
    assert.deepEqual(rows[0].capture, {
      kind: "link",
      title: "文章",
      url: "https://example.com/article",
      intent: "稍后读",
    });
  });

  test("文件限制、路径隔离和幂等", async () => {
    const outside = join(root, "agent-writable-outside");
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, ".jiebo"));
    const row = {
      clientId: "file-1",
      kind: "file",
      filename: "资料.txt",
      mime: "text/plain",
      intent: "总结",
    };
    const send = (headers: Record<string, string>, body: string) =>
      fetch(`${origin}/upload/assistant/ingest-file`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
        body,
      });
    const mismatch = await send(
      { "content-type": "application/octet-stream", "x-jiebo-assistant": metadata(row) },
      "hello",
    );
    assert.equal(mismatch.status, 400);
    const fakeImage = await send(
      {
        "content-type": "image/jpeg",
        "x-jiebo-assistant": metadata({
          ...row,
          clientId: "fake-image",
          kind: "image",
          filename: "fake.jpg",
          mime: "image/jpeg",
        }),
      },
      "<svg>bad</svg>",
    );
    assert.equal(fakeImage.status, 400);
    assert.equal(await oversizedFileStatus(metadata({ ...row, clientId: "file-too-large" })), 413);
    const first = await send({ "content-type": "text/plain", "x-jiebo-assistant": metadata(row) }, "hello");
    assert.equal(first.status, 200);
    const second = await send({ "content-type": "text/plain", "x-jiebo-assistant": metadata(row) }, "hello");
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { created: boolean }).created, false);
    assert.equal(existsSync(join(outside, "assistant")), false, "上传不得跟随工作区内的 symlink");
    const captured = listInbox(getTenant("default")!, 300).find((item) => item.key === "assistant-capture:file-1");
    assert.equal(captured?.capture?.kind, "file");
    assert.match(captured?.capture?.path || "", /^captures\//);
    assert.match(captured?.capture?.sha || "", /^[0-9a-f]{64}$/);
    assert.equal((captured?.capture?.path || "").includes(getTenant("default")!.stateDir), false);
    const stored = artifactPath(getTenant("default")!.stateDir, captured?.capture?.sha || "");
    assert.ok(stored);
    assert.equal(readFileSync(stored!, "utf8"), "hello");
  });

  test("受控快照读取按收件箱和租户双重隔离", async () => {
    const tenantA = { id: "capture-a", stateDir: join(root, "capture-a") };
    const tenantB = { id: "capture-b", stateDir: join(root, "capture-b") };
    const { sha } = storeArtifact(tenantA.stateDir, Buffer.from("tenant-a-secret"));
    postInbox(tenantA, {
      kind: "info",
      title: "A 文件",
      body: "受控文件",
      capture: { kind: "file", path: "captures/a.txt", sha, mime: "text/plain", size: 15 },
    });
    const own = assistantTools({ ref: tenantA, role: "chat" }).capture_file_read!;
    const other = assistantTools({ ref: tenantB, role: "chat" }).capture_file_read!;
    assert.match(
      String(await own.execute({ path: "captures/a.txt", sha }, { toolCallId: "read-a" })),
      /tenant-a-secret/,
    );
    assert.match(
      String(await other.execute({ path: "captures/a.txt", sha }, { toolCallId: "read-b" })),
      /不属于当前租户/,
    );
  });
});
