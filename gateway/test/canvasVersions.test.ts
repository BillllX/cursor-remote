import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  listCanvasVersions,
  publishCanvasVersion,
  readCanvasVersionSource,
  saveCanvasVersion,
} from "../src/canvasVersions.ts";
import { storeArtifact } from "../src/turnFiles.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tenant() {
  const stateDir = mkdtempSync(join(tmpdir(), "canvas-versions-"));
  roots.push(stateDir);
  return { id: "tenant-a", stateDir };
}

describe("Canvas 版本与分享", () => {
  test("源码和 HTML 复用 artifacts，保存与发布按 path+sha 幂等", () => {
    const t = tenant();
    const source = Buffer.from("export default function Canvas() { return <main /> }\n");
    const sourceSha = storeArtifact(t.stateDir, source).sha;
    const html = "<!doctype html><html><body>snapshot</body></html>";
    const first = saveCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, html, 100);
    const second = saveCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, html, 200);
    assert.equal(first.sha, sourceSha);
    assert.equal(second.createdAt, 100);
    assert.equal(listCanvasVersions(t, "boards/a.canvas.tsx", (token) => `/c/${token}`).length, 1);

    const published = publishCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, (token) => `/c/${token}`, 300);
    const again = publishCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, (token) => `/c/${token}`, 400);
    assert.equal(again.url, published.url);
    assert.deepEqual(readCanvasVersionSource(t, "boards/a.canvas.tsx", sourceSha), source);
  });

  test("当前文件没有现成 sha 时由网关保存源码快照", () => {
    const t = tenant();
    const source = Buffer.from("export default function Canvas() { return <main>当前版</main> }\n");
    const version = saveCanvasVersion(
      t,
      "boards/current.canvas.tsx",
      undefined,
      "<!doctype html><html><body>当前版</body></html>",
      100,
      source,
    );
    assert.deepEqual(readCanvasVersionSource(t, "boards/current.canvas.tsx", version.sha), source);
  });

  test("同一源码重新保存 HTML 后既有分享同步到新快照", () => {
    const t = tenant();
    const sourceSha = storeArtifact(t.stateDir, Buffer.from("source")).sha;
    saveCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, "<html><body>旧</body></html>", 100);
    const shared = publishCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, (token) => `/c/${token}`);
    saveCanvasVersion(t, "boards/a.canvas.tsx", sourceSha, "<html><body>新</body></html>", 200);
    assert.equal(listCanvasVersions(t, "boards/a.canvas.tsx", (token) => `/c/${token}`)[0].shareUrl, shared.url);
  });

  test("恢复权限只认该路径已登记版本，任意 artifact 和跨路径 sha 都拒绝", () => {
    const t = tenant();
    const allowed = storeArtifact(t.stateDir, Buffer.from("allowed")).sha;
    const arbitrary = storeArtifact(t.stateDir, Buffer.from("arbitrary")).sha;
    saveCanvasVersion(t, "boards/a.canvas.tsx", allowed, "<html><body>a</body></html>");
    assert.equal(readCanvasVersionSource(t, "boards/a.canvas.tsx", arbitrary), null);
    assert.equal(readCanvasVersionSource(t, "boards/b.canvas.tsx", allowed), null);
    assert.equal(readCanvasVersionSource(t, "../a.canvas.tsx", allowed), null);
  });
});
