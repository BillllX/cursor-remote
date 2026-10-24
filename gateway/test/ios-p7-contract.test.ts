import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("iOS P7 静态契约", () => {
  test("产物中心只登记主 App target，且没有增加第四主 Tab", () => {
    const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
    assert.equal((project.match(/P7000101 \/\* ArtifactCenterView\.swift \*\//g) || []).length, 3);
    assert.equal((project.match(/P7000201 \/\* ArtifactCenterView\.swift in Sources \*\//g) || []).length, 2);
    const shareSources = project.match(/A1B2C3D4E5F6071829000D11 \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/)?.[0] ?? "";
    assert.doesNotMatch(shareSources, /ArtifactCenterView/);

    const tabs = read("ios/Jiebo/Jiebo/Views/Phone/PhoneTabShell.swift");
    assert.equal((tabs.match(/\bTab\("/g) || []).length, 3);
    const menu = read("ios/Jiebo/Jiebo/Views/Phone/MenuDrawer.swift");
    assert.match(menu, /"产物中心"[\s\S]*router\.go\(\.artifacts\)/);
  });

  test("续作固定提交助理主会话、保留草稿，文件复用既有预览与分享", () => {
    const assistant = read("ios/Jiebo/Jiebo/Session/ChatStore+Assistant.swift");
    assert.match(assistant, /func continueArtifact\(_ artifact: Artifact\)/);
    assert.match(assistant, /submit\(chatId: assistantChatId, text: prompt\)/);
    assert.match(assistant, /saveDraft\(savedDraft, forChat: assistantChatId\)/);
    assert.doesNotMatch(assistant, /submit\(\s*\)/);

    const view = read("ios/Jiebo/Jiebo/Views/Phone/ArtifactCenterView.swift");
    assert.match(view, /store\.openTurnFile\(file, chatId: chatId\)/);
    assert.match(view, /store\.exportPreview\(path: file\.path/);
    assert.match(view, /artifact\.safeURL/);
    assert.match(view, /\.jieboGlass\(/);
  });

  test("设备写入确认只有 HomeShell 一处，且绝对 deadline 在确认后和 EventKit 保存前检查", () => {
    const home = read("ios/Jiebo/Jiebo/Views/HomeShell.swift");
    const phone = read("ios/Jiebo/Jiebo/Views/Phone/PhoneTabShell.swift");
    const coordinator = read("ios/Jiebo/Jiebo/Device/DeviceBridgeCoordinator.swift");
    assert.equal((home.match(/DeviceWriteConfirmationSheet/g) || []).length, 1);
    assert.doesNotMatch(phone, /DeviceWriteConfirmationSheet|setConfirmationPresenter/);
    assert.match(coordinator, /let deadline = ContinuousClock\.now\.advanced/);
    assert.match(
      coordinator,
      /let allowed = await withCheckedContinuation[\s\S]*try ensureBeforeDeadline\(deadline\)[\s\S]*DeviceWriteConfirmationPolicy\.outcome/,
    );
    assert.equal(
      (
        coordinator.match(/try ensureBeforeDeadline\(deadline\)\s*\n\s*let identifier = try await eventKit\.upsert/g) ||
        []
      ).length,
      2,
    );
    assert.match(coordinator, /case \.timeout: status = "timeout"/);
  });
});
