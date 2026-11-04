import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ALLOWED_EXTS,
  ensureSafePathInWorkspace,
  initKbWorkspaceConfig,
  isAllowedUploadFileName,
  loadKbWorkspaceConfig,
  parseKbWorkspaceConfig,
  validateArchiveTargetRelPath,
  validateKbHtmlRelPath,
} from "../src/ingest/contract.ts";

const tempDirs: string[] = [];

function makeTempRoot() {
  const dir = join(tmpdir(), `kb-contract-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Step 1: 知识库工作区契约 (contract.ts)", () => {
  test("初始化并加载合法的 .jiebo/kb.json 配置", () => {
    const root = makeTempRoot();
    const ws = join(root, "Fintopia集团");
    mkdirSync(ws, { recursive: true });

    const res = initKbWorkspaceConfig(ws, {
      title: "Fintopia 集团知识库",
      allowedCategories: ["资金", "资产", "牌照"],
    });
    assert.equal(res.ok, true);

    const loaded = loadKbWorkspaceConfig(ws, root);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.title, "Fintopia 集团知识库");
      assert.deepEqual(loaded.config.allowedCategories, ["资金", "资产", "牌照"]);
      assert.equal(loaded.config.maxFileBytes, 32 * 1024 * 1024);
      assert.deepEqual(loaded.config.allowedExts, [...DEFAULT_ALLOWED_EXTS]);
    }
  });

  test("拒绝非法配置项（不静默回退）", () => {
    assert.equal(
      parseKbWorkspaceConfig({
        version: 1,
        kind: "knowledge_base",
        title: "测试",
        allowedCategories: ["资产"],
        maxFileBytes: 100, // 小于 1024
      }).ok,
      false,
    );
    assert.equal(
      parseKbWorkspaceConfig({
        version: 1,
        kind: "knowledge_base",
        title: "测试",
        allowedCategories: ["资产"],
        maxFileBytes: 64 * 1024 * 1024, // 大于 32MB
      }).ok,
      false,
    );
    assert.equal(
      parseKbWorkspaceConfig({
        version: 1,
        kind: "knowledge_base",
        title: "测试",
        allowedCategories: ["资产"],
        allowedExts: [], // 空数组拒绝
      }).ok,
      false,
    );
    assert.equal(
      parseKbWorkspaceConfig({
        version: 1,
        kind: "knowledge_base",
        title: "测试",
        allowedCategories: ["资产"],
        allowedExts: [".sh"], // 脚本拒绝
      }).ok,
      false,
    );
    assert.equal(
      parseKbWorkspaceConfig({
        version: 1,
        kind: "knowledge_base",
        title: "测试",
        allowedCategories: ["资产"],
        allowedExts: [".bash"],
      }).ok,
      false,
    );
    assert.equal(
      parseKbWorkspaceConfig({
        version: 1,
        kind: "knowledge_base",
        title: "测试",
        allowedCategories: ["资产"],
        allowedExts: [".html"], // 严禁在上传扩展名中放行 .html
      }).ok,
      false,
    );
  });

  test("拒绝路径穿越、已存在符号链接、悬空符号链接、符号链接环与硬链接", () => {
    const root = makeTempRoot();
    const ws = join(root, "ws1");
    const outside = join(root, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const good = initKbWorkspaceConfig(ws, {
      title: "测试库",
      allowedCategories: ["资产", "牌照"],
    });
    assert.equal(good.ok, true);
    if (!good.ok) return;

    // 路径穿越拒绝
    assert.equal(ensureSafePathInWorkspace(ws, "../outside/secret.txt").ok, false);
    assert.equal(ensureSafePathInWorkspace(ws, "资产/../../outside/secret.txt").ok, false);
    assert.equal(ensureSafePathInWorkspace(ws, "/etc/passwd").ok, false);

    // 指向已存在区外目录的符号链接
    const linkDir = join(ws, "资产", "symlink-dir");
    symlinkSync(outside, linkDir);
    assert.equal(ensureSafePathInWorkspace(ws, "资产/symlink-dir/a.pdf").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, good.config, "资产/symlink-dir/a.pdf").ok, false);

    // 悬空文件符号链接（指向区外尚不存在的文件）
    const danglingTarget = join(outside, "dangling-created.pdf");
    const danglingFileLink = join(ws, "资产", "dangling.pdf");
    symlinkSync(danglingTarget, danglingFileLink);
    assert.equal(ensureSafePathInWorkspace(ws, "资产/dangling.pdf").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, good.config, "资产/dangling.pdf").ok, false);
    assert.equal(existsSync(danglingTarget), false);

    // 悬空目录符号链接
    const danglingDirLink = join(ws, "资产", "dangling-sub");
    symlinkSync(join(outside, "non-existent-dir"), danglingDirLink);
    assert.equal(ensureSafePathInWorkspace(ws, "资产/dangling-sub/a.pdf").ok, false);

    // 悬空 HTML 符号链接
    const danglingHtmlLink = join(ws, "资产", "资产.html");
    symlinkSync(join(outside, "hijack.html"), danglingHtmlLink);
    assert.equal(validateKbHtmlRelPath(ws, good.config, "资产/资产.html").ok, false);

    // 符号链接自环
    const loopLink = join(ws, "资产", "loop");
    symlinkSync(loopLink, loopLink);
    assert.equal(ensureSafePathInWorkspace(ws, "资产/loop/a.pdf").ok, false);

    // 硬链接文件拒绝（nlink > 1）
    const outsideSecret = join(outside, "secret.pdf");
    writeFileSync(outsideSecret, "secret");
    const hardLinkedFile = join(ws, "资产", "hardlinked.pdf");
    linkSync(outsideSecret, hardLinkedFile);
    assert.equal(ensureSafePathInWorkspace(ws, "资产/hardlinked.pdf").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, good.config, "资产/hardlinked.pdf").ok, false);

    // 工作区本身是符号链接时拒绝
    const wsLink = join(root, "ws-link");
    symlinkSync(ws, wsLink);
    assert.equal(loadKbWorkspaceConfig(wsLink, root).ok, false);
  });

  test("严格校验归档目标路径、多段危险后缀、保留文件名与控制字符", () => {
    const root = makeTempRoot();
    const ws = join(root, "ws2");
    mkdirSync(ws, { recursive: true });
    const res = initKbWorkspaceConfig(ws, {
      title: "Fintopia",
      allowedCategories: ["资金", "资产", "牌照"],
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    // 合法归档路径
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "资产/洋钱罐/202611风险预估.xlsx").ok, true);

    // 未授权分类目录拒绝
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "00_待归档/202611风险预估.xlsx").ok, false);

    // 禁止覆盖 归档说明.md（无论是根还是子目录）或 .jiebo/memory.md
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "归档说明.md").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "资产/归档说明.md").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "资产/AGENTS.md").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, res.config, ".jiebo/memory.md").ok, false);

    // 严禁归档覆盖同名 HTML
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "资产/资产.html").ok, false);
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "资产/子目录/子目录.html").ok, false);

    // 禁止单段或多段可执行/脚本后缀
    assert.equal(isAllowedUploadFileName("hack.sh", res.config).ok, false);
    assert.equal(isAllowedUploadFileName("年报.sh.pdf", res.config).ok, false);
    assert.equal(isAllowedUploadFileName("报表.exe.xlsx", res.config).ok, false);
    assert.equal(isAllowedUploadFileName("page.html", res.config).ok, false);
    assert.equal(isAllowedUploadFileName("report.xlsx", res.config).ok, true);

    // 控制字符拒绝
    assert.equal(validateArchiveTargetRelPath(ws, res.config, "资产/foo\nbar/a.pdf").ok, false);
    assert.equal(validateKbHtmlRelPath(ws, res.config, "资产/a\nb/a\nb.html").ok, false);

    // 合法同名 HTML
    assert.equal(validateKbHtmlRelPath(ws, res.config, "资产/资产.html").ok, true);
    assert.equal(validateKbHtmlRelPath(ws, res.config, "资产/黑龙江三农信融资担保/黑龙江三农信融资担保.html").ok, true);
    // 非同名 HTML 或越界 HTML 拒绝
    assert.equal(validateKbHtmlRelPath(ws, res.config, "资产/随便改名.html").ok, false);
    assert.equal(validateKbHtmlRelPath(ws, res.config, "未授权/未授权.html").ok, false);
  });

  test("校验真实 Fintopia集团 工作区的 .jiebo/kb.json", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const tenantWorkspaceRoot = resolve(testDir, "../../../..");
    const fintopiaDir = resolve(tenantWorkspaceRoot, "Fintopia集团");
    if (!existsSync(fintopiaDir)) return;
    const loaded = loadKbWorkspaceConfig(fintopiaDir, tenantWorkspaceRoot);
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.config.title, "Fintopia 集团知识库");
      assert.deepEqual(loaded.config.allowedCategories, ["资金", "资产", "牌照"]);
      assert.equal(loaded.config.maxFileBytes, 33554432);
      assert.deepEqual(loaded.config.allowedExts, [...DEFAULT_ALLOWED_EXTS]);
    }
  });
});
