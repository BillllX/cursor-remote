import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PresentationConverter, readPresentation } from "../src/presentationPreview.ts";
import { isPresentationPath, kindFromPath } from "../../shared/preview.ts";

const root = mkdtempSync(join(tmpdir(), "ppt-preview-test-"));
const count = join(root, "count");
const fake = join(root, "libreoffice");
// 用替身验证命令契约、资源清理和错误分支，真实 LibreOffice 另做可选冒烟。
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const source = args.at(-1);
const dir = args[args.indexOf('--outdir') + 1];
fs.appendFileSync(${JSON.stringify(count)}, dir + '\\n');
const profile = new URL(args[0].slice('-env:UserInstallation='.length));
const config = fs.readFileSync(new URL(profile.href + '/user/registrymodifications.xcu'), 'utf8');
if (!config.includes('DisableMacrosExecution') || !args.includes('pdf:impress_pdf_Export')) process.exit(2);
const content = fs.readFileSync(source, 'utf8');
if (content === 'fail') process.exit(1);
if (content === 'no-output') process.exit(0);
setTimeout(() => fs.writeFileSync(path.join(dir, 'slides.pdf'), content === 'invalid' ? 'bad' : '%PDF-1.4\\n' + content), content === 'slow' ? 500 : 30);
`,
);
chmodSync(fake, 0o700);
after(() => rmSync(root, { recursive: true, force: true }));

test("PPT 后缀大小写兼容，保留 binary 协议和原件下载", () => {
  for (const file of ["中文.ppt", "中文.PPTX"]) {
    assert.equal(isPresentationPath(file), true);
    assert.equal(kindFromPath(file), "binary");
  }
  assert.equal(isPresentationPath("x.pptx.zip"), false);
});

test("转换成功、同租户内容缓存与并发请求合并，租户及内容变化重新转换", async () => {
  const converter = new PresentationConverter(fake);
  const start = readFileSyncCount();
  const [a, b] = await Promise.all([
    converter.convert("tenant-a", "a.pptx", Buffer.from("one")),
    converter.convert("tenant-a", "a.pptx", Buffer.from("one")),
  ]);
  assert.match(a.toString(), /^%PDF-/);
  assert.deepEqual(a, b);
  await converter.convert("tenant-a", "b.pptx", Buffer.from("one"));
  assert.equal(readFileSyncCount(), start + 1);
  await converter.convert("tenant-b", "a.pptx", Buffer.from("one"));
  await converter.convert("tenant-a", "a.pptx", Buffer.from("two"));
  await converter.convert("tenant-a", "a.ppt", Buffer.from("one"));
  assert.equal(readFileSyncCount(), start + 4);
  for (const dir of readFileSync(count, "utf8").trim().split("\n")) {
    assert.throws(() => readFileSync(join(dir, "slides.pdf")), /ENOENT/);
  }
});

function readFileSyncCount() {
  try {
    return readFileSync(count, "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
}

test("不支持的文件与超大输入不启动转换", async () => {
  const converter = new PresentationConverter(fake);
  await assert.rejects(converter.convert("a", "a.docx", Buffer.from("x")), { status: 400 });
  await assert.rejects(converter.convert("a", "a.ppt", Buffer.alloc(40 * 1024 * 1024 + 1)), { status: 413 });
});

test("缺组件、进程失败、无输出与非法 PDF 返回可解释错误，失败可重试", async () => {
  await assert.rejects(new PresentationConverter(join(root, "missing")).convert("a", "a.ppt", Buffer.from("a")), {
    status: 503,
    message: /LibreOffice/,
  });
  const converter = new PresentationConverter(fake);
  for (const content of ["fail", "no-output", "invalid", "fail"]) {
    await assert.rejects(converter.convert("a", "a.pptx", Buffer.from(content)), { status: 422 });
  }
});

test("超时终止转换，超过并发上限可稍后重试", async () => {
  const fast = new PresentationConverter(fake, 20);
  await assert.rejects(fast.convert("a", "a.ppt", Buffer.from("slow")), { status: 422 });
  const converter = new PresentationConverter(fake);
  const first = converter.convert("a", "a.ppt", Buffer.from("slow"));
  const second = converter.convert("b", "a.ppt", Buffer.from("slow"));
  await assert.rejects(converter.convert("c", "a.ppt", Buffer.from("slow")), { status: 503 });
  await Promise.all([first, second]);
  assert.match((await converter.convert("c", "a.ppt", Buffer.from("slow"))).toString(), /^%PDF-/);
});

test("读取工作区原件拒绝越界、符号链接、硬链接，正常中文文件可读", async () => {
  writeFileSync(join(root, "演示.pptx"), "slides");
  assert.equal((await readPresentation(root, "演示.pptx")).toString(), "slides");
  await assert.rejects(readPresentation(root, "../outside.pptx"), { status: 403 });
  symlinkSync(join(root, "演示.pptx"), join(root, "link.pptx"));
  await assert.rejects(readPresentation(root, "link.pptx"), { status: 403 });
  linkSync(join(root, "演示.pptx"), join(root, "hard.pptx"));
  await assert.rejects(readPresentation(root, "hard.pptx"), { status: 403 });
});
