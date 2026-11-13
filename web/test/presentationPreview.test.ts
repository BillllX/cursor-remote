import assert from "node:assert/strict";
import { test } from "node:test";
import { presentationPreviewSrc, previewSrc } from "../lib/preview";

test("PPT 转换 URL 保留部署前缀、中文路径、媒体票据和快照", () => {
  const source = "/cursor-remote/api/media?path=%E6%BC%94%E7%A4%BA.pptx&chatId=c1&exp=123&sig=s1&rev=sha:abc";
  const converted = new URL(presentationPreviewSrc(source), "https://example.test");
  assert.equal(converted.pathname, "/cursor-remote/api/media");
  assert.equal(converted.searchParams.get("path"), "演示.pptx");
  assert.equal(converted.searchParams.get("sig"), "s1");
  assert.equal(converted.searchParams.get("rev"), "sha:abc");
  assert.equal(converted.searchParams.get("preview"), "pdf");
  assert.equal(source.includes("preview="), false);
});

test("绝对媒体地址、原件地址及片段不影响转换参数", () => {
  assert.equal(
    presentationPreviewSrc(previewSrc("https://example.test/media?a=1#x")),
    "https://example.test/media?a=1&preview=pdf",
  );
  assert.equal(presentationPreviewSrc("/media"), "/media?preview=pdf");
});
